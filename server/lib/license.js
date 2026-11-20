// @ts-check
/**
 * 授权状态：读取本机授权文件、验签、机器码探测与专业版能力闸。
 *
 * 为什么没有服务器也能做：
 * - 授权码由作者用私钥签发，公钥随安装包发布；验签是纯本地计算，断网照样可用；
 * - 机器码由本机硬件特征算出，同一个授权码换到别的机器上验不过；
 * - 授权文件放在用户数据目录（DATA_DIR），跨资源库共享，卸载 / 清理数据后需要重新激活。
 *
 * 这不能阻止「改代码把校验跳过」，但能把「一份 key 全网用」压到需要改二进制，
 * 把盗卖从「拷个文件」变成「得会逆向」。真正的护城河仍是持续更新与正版体验。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_ROOT, DATA_DIR } from '../config.js';
import {
  PRO_FEATURES,
  PRODUCT,
  daysLeft,
  machineCodeFromParts,
  normalizeCode,
  normalizePhone,
  verifyLicenseKey,
  verifyRevocationList,
} from './license-core.js';

const LICENSE_FILE = path.join(DATA_DIR, 'license.key');
const REVOKE_FILE = path.join(DATA_DIR, 'license-revoke.json');
const REVOKE_URL = String(process.env.TUKU_LICENSE_REVOKE_URL || '').trim();
const REVOKE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * 授权公钥：优先环境变量（CI / 内部构建），否则读随包文件。
 * 公钥不是秘密，进仓库没关系；私钥在作者本机与 CI secret 里，绝不入包。
 */
const PUBLIC_KEY = (() => {
  if (process.env.TUKU_LICENSE_PUBLIC_KEY) return process.env.TUKU_LICENSE_PUBLIC_KEY;
  try {
    return fs.readFileSync(path.join(APP_ROOT, 'server', 'license-public.pem'), 'utf8');
  } catch (err) {
    console.warn('[license] 未找到 server/license-public.pem，专业版能力将保持关闭：', err?.message || err);
    return '';
  }
})();

/** Windows 一次 PowerShell 取齐 4 项硬件特征：比 4 次 wmic 快，也不必处理 wmic 被移除的问题 */
const PS_SCRIPT = [
  '$ErrorActionPreference="SilentlyContinue";',
  '$o=@{};',
  "$o.guid=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid;",
  '$o.cpu=(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty ProcessorId);',
  '$o.board=(Get-CimInstance Win32_BaseBoard | Select-Object -First 1 -ExpandProperty SerialNumber);',
  "$o.disk=(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\" | Select-Object -First 1 -ExpandProperty VolumeSerialNumber);",
  '$o | ConvertTo-Json -Compress',
].join(' ');

/** @type {string[] | null} */
let partsCache = null;

/** 探测硬件特征；任何一项失败都留空，不影响其余项 */
function probeParts() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
        { timeout: 20_000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const parsed = JSON.parse(String(out).trim() || '{}');
      const parts = [parsed.guid, parsed.cpu, parsed.board, parsed.disk].map((v) => String(v ?? '').trim());
      // 至少两项可用才算探测成功；只剩一项（或全空）时退回系统信息，免得机器码过于随机
      if (parts.filter(Boolean).length >= 2) return parts;
    } catch (err) {
      console.warn('[license] 硬件特征探测失败，改用系统信息：', err?.message || err);
    }
  }
  // 非 Windows / 探测失败：用系统信息兜底。区分度不如硬件序列号，但依然能挡住「拷 key 到别的机器」
  let user;
  try {
    user = os.userInfo().username;
  } catch {
    user = '';
  }
  return [os.hostname(), os.cpus()[0]?.model || '', `${os.platform()}-${os.arch()}`, user];
}

/** @param {boolean} [force] */
function components(force = false) {
  if (force || !partsCache) partsCache = probeParts();
  return partsCache;
}

/** @type {{ stamp: string, value: any } | null} */
let statusCache = null;

function fileStamp() {
  try {
    const st = fs.statSync(LICENSE_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

function readKeyFile() {
  try {
    return fs.readFileSync(LICENSE_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function readRevokeCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(REVOKE_FILE, 'utf8'));
    const token = String(raw?.token || '').trim();
    if (!token) return null;
    const verified = verifyRevocationList(token, { publicKeyPem: PUBLIC_KEY });
    if (!verified.ok || !verified.payload) return null;
    return { token, fetchedAt: Number(raw?.fetchedAt) || 0, payload: verified.payload };
  } catch {
    return null;
  }
}

function revokeStamp() {
  try {
    const st = fs.statSync(REVOKE_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

let revokeRefreshing = false;

/** 拉取并验签远程停用清单；失败保留旧缓存 */
export async function refreshRevocation({ force = false } = {}) {
  if (!REVOKE_URL) return { ok: false, skipped: true, reason: '未配置远程停用地址' };
  const cached = readRevokeCache();
  if (!force && cached && Date.now() - cached.fetchedAt < REVOKE_MAX_AGE_MS) {
    return { ok: true, cached: true, payload: cached.payload };
  }
  if (revokeRefreshing) return { ok: false, busy: true, reason: '正在刷新停用清单' };
  revokeRefreshing = true;
  try {
    const res = await fetch(REVOKE_URL, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const verified = verifyRevocationList(text, { publicKeyPem: PUBLIC_KEY });
    if (!verified.ok || !verified.payload) throw new Error(verified.reason || '停用清单验签失败');
    if (cached && Number(verified.payload.seq || 0) < Number(cached.payload.seq || 0)) {
      return { ok: true, ignored: true, reason: '远程清单版本更旧，保留本地缓存' };
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      REVOKE_FILE,
      JSON.stringify({ token: text.trim(), fetchedAt: Date.now() }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
    statusCache = null;
    return { ok: true, payload: verified.payload };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    revokeRefreshing = false;
  }
}

function maybeRefreshRevocation() {
  if (!REVOKE_URL) return;
  const cached = readRevokeCache();
  if (cached && Date.now() - cached.fetchedAt < REVOKE_MAX_AGE_MS) return;
  void refreshRevocation({ force: true });
}

/**
 * 当前授权状态。refresh=true 时重新探测硬件（换过硬件后可手动刷新）。
 * @param {{ refresh?: boolean }} [opts]
 */
export function licenseStatus({ refresh = false } = {}) {
  maybeRefreshRevocation();
  if (refresh) {
    partsCache = null;
    statusCache = null;
  }
  const stamp = `${fileStamp()}|${revokeStamp()}`;
  if (!refresh && statusCache && statusCache.stamp === stamp) return statusCache.value;

  const parts = components(refresh);
  const machineCode = machineCodeFromParts(parts);
  const raw = readKeyFile();
  /** @type {any} */
  let payload = null;
  let reason = '';
  if (raw) {
    const result = verifyLicenseKey(raw, { publicKeyPem: PUBLIC_KEY, machineCode });
    if (result.ok) payload = result.payload;
    else reason = result.reason;
  } else {
    reason = '尚未激活';
  }

  const phone = payload
    ? String(payload.phone || payload.account || payload.email || payload.note || '').trim()
    : '';
  const account = phone; // 兼容旧字段：新授权码的账号就是手机号
  const revoke = readRevokeCache();
  const revokedPhones = Array.isArray(revoke?.payload?.revokedPhones)
    ? revoke.payload.revokedPhones.map((p) => normalizePhone(p)).filter(Boolean)
    : [];
  const revokedAccounts = Array.isArray(revoke?.payload?.revokedAccounts)
    ? revoke.payload.revokedAccounts.map((a) => normalizePhone(a)).filter(Boolean)
    : [];
  const revokedMachines = Array.isArray(revoke?.payload?.revokedMachines)
    ? revoke.payload.revokedMachines.map((m) => normalizeCode(m)).filter(Boolean)
    : [];
  const phoneKey = normalizePhone(phone);
  const revoked =
    !!payload &&
    ((phoneKey && (revokedPhones.includes(phoneKey) || revokedAccounts.includes(phoneKey))) ||
      revokedMachines.includes(normalizeCode(machineCode)));
  if (revoked) reason = '该手机号或设备已被远程停用，请联系管理员';
  // 仅开发环境：不写授权文件也能测 Pro 页面；安装包绝不能带这个环境变量
  const devPro = process.env.TUKU_DEV_PRO === '1';

  const value = {
    product: PRODUCT,
    edition: !revoked && (payload || devPro) ? String(payload?.edition || 'pro') : 'free',
    licensed: !revoked && (!!payload || devPro),
    /** 本机是否真的有验签通过的授权文件（区别于只是开发模式临时 Pro） */
    licensedByKey: !revoked && !!payload,
    devPro,
    machineCode,
    phone,
    account,
    revoked,
    revokedAt: revoked ? String(revoke?.payload?.issuedAt || '') : '',
    revokeCheckedAt: revoke?.fetchedAt ? new Date(revoke.fetchedAt).toISOString() : '',
    revokeError: REVOKE_URL ? '' : '未配置远程停用地址',
    issuedAt: payload?.issuedAt ? String(payload.issuedAt) : '',
    expires: payload?.expires ? String(payload.expires) : null,
    daysLeft: payload ? daysLeft(payload.expires) : null,
    note: payload?.note ? String(payload.note) : '',
    reason,
    // 购买页地址由构建方注入；留空时设置页只显示「把机器码发给作者」
    buyUrl: process.env.TUKU_BUY_URL || '',
    features: PRO_FEATURES,
  };
  statusCache = { stamp, value };
  return value;
}

/** 专业版能力是否可用（能力闸的唯一判断点） */
export function isPro() {
  return licenseStatus().licensed;
}

/** 账号/机器是否被远程停用 */
export function isRevoked() {
  return licenseStatus().revoked;
}

/**
 * 激活：验签通过才落盘。写入用 临时文件 + rename，避免中途断电留下半个授权文件。
 * @param {string} key
 */
export function activateLicense(key) {
  const result = verifyLicenseKey(key, {
    publicKeyPem: PUBLIC_KEY,
    machineCode: machineCodeFromParts(components()),
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${LICENSE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, String(key).trim(), { mode: 0o600 });
    fs.renameSync(tmp, LICENSE_FILE);
    statusCache = null;
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: `授权文件写入失败：${err?.message || err}` };
  }
}

/** 取消本机授权（只删本地文件，不影响已购买的授权码） */
export function deactivateLicense() {
  try {
    fs.rmSync(LICENSE_FILE, { force: true });
    statusCache = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `授权文件删除失败：${err?.message || err}` };
  }
}

/**
 * Express 中间件：免费版下直接 402。
 * 放在路由注册之前，新增受控能力只要多挂一行。
 * @param {string} feature PRO_FEATURES 里的 key
 */
export function requirePro(feature) {
  const meta = PRO_FEATURES.find((f) => f.key === feature);
  const label = meta?.label || feature;
  return (/** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ next) => {
    if (isPro()) return next();
    res.status(402).json({
      error: `「${label}」需要专业版授权，请在「设置 → 授权」中激活`,
      code: 'license_required',
      feature,
    });
  };
}
