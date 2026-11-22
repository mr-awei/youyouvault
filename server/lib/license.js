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
import { APP_ROOT, DATA_DIR, IS_PACKAGED } from '../config.js';
import {
  PRO_FEATURES,
  PRODUCT,
  daysLeft,
  deviceCodeFromParts,
  licensePairKey,
  machineCodeFromParts,
  normalizeCode,
  normalizeDeviceCode,
  normalizePhone,
  verifyLicenseKey,
  verifyRevocationList,
} from './license-core.js';
import { omsClient } from './oms.js';

// 预读本机 OMS 账号（只读本地文件），让 licenseStatus 的同步快照能拿到登录账号。
void omsClient.loadAccount();

const LICENSE_FILE = path.join(DATA_DIR, 'license.key');
const REVOKE_FILE = path.join(DATA_DIR, 'license-revoke.json');

/**
 * 默认停用清单：放在 Gitee 仓库深处的 docs/license/license-revoke.json。
 * 生产默认**必须**能拉到它；只在开发 / CI 用 TUKU_LICENSE_REVOKE_DISABLE=1 关闭检查。
 * 需要自建时用 TUKU_LICENSE_REVOKE_URL 覆盖。
 */
const DEFAULT_REVOKE_URL =
  'https://gitee.com/mr-awei/youyouvault/raw/main/docs/license/license-revoke.json';
/**
 * 打包后不再接受这些“测试开关”环境变量，避免用户通过改环境变量绕过授权。
 * 未打包的开发 / 冒烟测试仍可用；TUKU_STRICT_LICENSE=1 只用于让开发态按正式
 * 授权规则跑测试（它会关闭开发态自动 Pro，不会放宽校验）。
 */
const STRICT_LICENSE = !IS_PACKAGED && /^(1|true|on)$/i.test(String(process.env.TUKU_STRICT_LICENSE || ''));
const TRIAL_DISABLED = !IS_PACKAGED && /^(1|true|on)$/i.test(String(process.env.TUKU_TRIAL_DISABLE || ''));
const REVOKE_DISABLED =
  !IS_PACKAGED && /^(1|true|on)$/i.test(String(process.env.TUKU_LICENSE_REVOKE_DISABLE || ''));
/**
 * 仅用于未打包的开发 / 冒烟测试：跳过「OMS 登录 + 手机号一致」这道 Pro 条件。
 * 打包版永远忽略，正式渠道必须由用户登录 OMS 才能开 Pro。
 */
const OMS_BINDING_DISABLED =
  !IS_PACKAGED && /^(1|true|on)$/i.test(String(process.env.TUKU_OMS_LOGIN_DISABLE || ''));
const REVOKE_URL = REVOKE_DISABLED
  ? ''
  : String(process.env.TUKU_LICENSE_REVOKE_URL || DEFAULT_REVOKE_URL).trim();
/** 每 30 分钟检查一次；失败后不再拿本地缓存当“正常” */
const REVOKE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * 最近一次停用检查结果。
 * ok=true 表示这次真的连上了并验签通过；ok=false 表示网络 / 验签失败。
 * 初始 ok=true 只是为了让未启动 watcher 的测试环境不被误锁；正式启动时
 * standalone.js 会先 await startRevocationWatch()。
 */
const revokeCheck = {
  ok: true,
  at: 0,
  error: REVOKE_DISABLED ? '已关闭停用检查（开发 / 测试）' : '',
};
let revokeLastAttempt = 0;

/**
 * 授权公钥：优先环境变量（仅开发 / 冒烟测试），打包后只认随包文件。
 * 公钥不是秘密，进仓库没关系；私钥在作者本机与 CI secret 里，绝不入包。
 * 打包后忽略环境变量，防止用户替换成自己的公钥后伪造授权码。
 */
const PUBLIC_KEY = (() => {
  if (!IS_PACKAGED && process.env.TUKU_LICENSE_PUBLIC_KEY) return process.env.TUKU_LICENSE_PUBLIC_KEY;
  try {
    return fs.readFileSync(path.join(APP_ROOT, 'server', 'license-public.pem'), 'utf8');
  } catch (err) {
    console.warn('[license] 未找到 server/license-public.pem，专业版能力将保持关闭：', err?.message || err);
    return '';
  }
})();

/**
 * 验签器健康检查（防止把 verifyLicenseKey 改成「永远返回 true」这类低级破解）。
 * 用一段格式正确但签名错误的授权码做负向探针：正常实现必须返回 false。
 * 探针失败时整个授权模块按“不可信”处理，直接退回免费版。
 */
const VERIFIER_HEALTHY = (() => {
  if (!PUBLIC_KEY) return false;
  const bogus = `TUKU1.${Buffer.from('{"v":1,"product":"tuku","edition":"pro"}').toString('base64url')}.${'A'.repeat(86)}`;
  const result = verifyLicenseKey(bogus, {
    publicKeyPem: PUBLIC_KEY,
    deviceCode: 'TK2-0000-0000-0000-0000-0000-0000',
  });
  return result.ok === false;
})();

/** Windows 一次 PowerShell 取齐硬件特征：比多次 wmic 快，也不必处理 wmic 被移除的问题 */
const PS_SCRIPT = [
  '$ErrorActionPreference="SilentlyContinue";',
  '$o=@{};',
  "$o.guid=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid;",
  '$o.cpu=(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty ProcessorId);',
  '$o.cpuName=(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name);',
  '$o.board=(Get-CimInstance Win32_BaseBoard | Select-Object -First 1 -ExpandProperty SerialNumber);',
  '$o.bios=(Get-CimInstance Win32_BIOS | Select-Object -First 1 -ExpandProperty SerialNumber);',
  '$o.uuid=(Get-CimInstance Win32_ComputerSystemProduct | Select-Object -First 1 -ExpandProperty UUID);',
  "$o.vol=(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\" | Select-Object -First 1 -ExpandProperty VolumeSerialNumber);",
  '$o.disk=(Get-Disk | Where-Object {$_.IsBoot} | Select-Object -First 1 -ExpandProperty SerialNumber);',
  'if(-not $o.disk){$o.disk=(Get-CimInstance Win32_DiskDrive | Select-Object -First 1 -ExpandProperty SerialNumber)};',
  '$o.mac=((Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=True AND NetEnabled=True").MACAddress | Sort-Object) -join ",";',
  '$tpm=Get-TpmEndorsementKeyInfo -HashAlgorithm Sha256 -ErrorAction SilentlyContinue;',
  'if($tpm){$h=$tpm.PublicKeyHash;if($h -is [byte[]]){$o.tpm=($h | ForEach-Object {$_.ToString("x2")}) -join ""}else{$o.tpm=[string]$h}};',
  '$o | ConvertTo-Json -Compress',
].join(' ');

/**
 * @typedef {{
 *   legacy: string[],
 *   v2: { uuid: string, board: string, bios: string, disk: string, tpm: string, guid: string, cpu: string, cpuName: string, mac: string }
 * }} HardwareParts
 */

/** @type {HardwareParts | null} */
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
      const p = JSON.parse(String(out).trim() || '{}');
      const s = (v) => String(v ?? '').trim();
      const legacy = [p.guid, p.cpu, p.board, p.vol].map(s);
      const v2 = {
        uuid: s(p.uuid),
        board: s(p.board),
        bios: s(p.bios),
        disk: s(p.disk),
        tpm: s(p.tpm),
        guid: s(p.guid),
        cpu: s(p.cpu),
        cpuName: s(p.cpuName),
        mac: s(p.mac),
      };
      // 至少两项可用才算探测成功；只剩一项（或全空）时退回系统信息，免得设备码过于随机
      if (legacy.filter(Boolean).length >= 2 || [v2.uuid, v2.board, v2.disk, v2.guid].filter(Boolean).length >= 2) {
        return { legacy, v2 };
      }
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
  const cpu = os.cpus()[0]?.model || '';
  return {
    legacy: [os.hostname(), cpu, `${os.platform()}-${os.arch()}`, user],
    v2: {
      uuid: os.hostname(),
      board: '',
      bios: '',
      disk: `${os.platform()}-${os.arch()}`,
      tpm: '',
      guid: `${os.hostname()}|${user}`,
      cpu,
      cpuName: cpu,
      mac: '',
    },
  };
}

/** @param {boolean} [force] */
function components(force = false) {
  if (force || !partsCache) partsCache = probeParts();
  return /** @type {HardwareParts} */ (partsCache);
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
/** @type {NodeJS.Timeout | null} */
let revokeTimer = null;

function setRevokeCheck(ok, error = '') {
  revokeCheck.ok = ok;
  revokeCheck.at = Date.now();
  revokeCheck.error = error;
  statusCache = null;
}

/**
 * 拉取并验签远程停用清单。
 * 失败会把 revokeCheck.ok 置 false；已安装授权的客户端随后会被禁用，
 * 直到下一次成功连上且清单里没有命中它。
 */
export async function refreshRevocation({ force = false } = {}) {
  if (REVOKE_DISABLED || !REVOKE_URL) {
    setRevokeCheck(true, REVOKE_DISABLED ? '已关闭停用检查（开发 / 测试）' : '未配置远程停用地址');
    return { ok: true, skipped: true, reason: revokeCheck.error };
  }
  const cached = readRevokeCache();
  if (!force && cached && Date.now() - cached.fetchedAt < REVOKE_MAX_AGE_MS && revokeCheck.ok) {
    return { ok: true, cached: true, payload: cached.payload };
  }
  if (revokeRefreshing) return { ok: false, busy: true, reason: '正在刷新停用清单' };
  revokeRefreshing = true;
  revokeLastAttempt = Date.now();
  try {
    const target = `${REVOKE_URL}${REVOKE_URL.includes('?') ? '&' : '?'}_t=${Date.now()}`;
    const res = await fetch(target, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const verified = verifyRevocationList(text, { publicKeyPem: PUBLIC_KEY });
    if (!verified.ok || !verified.payload) throw new Error(verified.reason || '停用清单验签失败');
    setRevokeCheck(true);
    if (cached && Number(verified.payload.seq || 0) < Number(cached.payload.seq || 0)) {
      // 远程清单比本地缓存旧：网络已恢复，但不允许用旧清单“洗掉”已有停用记录
      return { ok: true, ignored: true, reason: '远程清单版本更旧，保留本地缓存', payload: cached.payload };
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      REVOKE_FILE,
      JSON.stringify({ token: text.trim(), fetchedAt: Date.now() }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
    return { ok: true, payload: verified.payload };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    setRevokeCheck(false, reason);
    return { ok: false, reason };
  } finally {
    revokeRefreshing = false;
  }
}

function maybeRefreshRevocation() {
  if (REVOKE_DISABLED || !REVOKE_URL || revokeRefreshing) return;
  // 失败后最多每分钟重试一次，网络恢复就能尽快解锁
  if (!revokeCheck.ok) {
    if (Date.now() - revokeLastAttempt > 60_000) void refreshRevocation({ force: true });
    return;
  }
  const cached = readRevokeCache();
  if (!cached || Date.now() - cached.fetchedAt >= REVOKE_MAX_AGE_MS) {
    void refreshRevocation({ force: true });
  }
}

/**
 * 启动时先做一次阻塞检查，然后每 30 分钟检查一次。
 * 由 standalone.js 在 listen 之前调用；测试 / CI 用 TUKU_LICENSE_REVOKE_DISABLE=1 跳过。
 */
export async function startRevocationWatch() {
  if (REVOKE_DISABLED || !REVOKE_URL) {
    setRevokeCheck(true, REVOKE_DISABLED ? '已关闭停用检查（开发 / 测试）' : '未配置远程停用地址');
  } else {
    await refreshRevocation({ force: true });
  }
  if (!revokeTimer) {
    revokeTimer = setInterval(() => void refreshRevocation({ force: true }), REVOKE_MAX_AGE_MS);
    revokeTimer.unref?.();
  }
  return { ...revokeCheck };
}

export function stopRevocationWatch() {
  if (revokeTimer) clearInterval(revokeTimer);
  revokeTimer = null;
}

/** 新设备试用天数：首次安装起算 */
const TRIAL_DAYS = 7;
const INSTALL_FILE = path.join(DATA_DIR, 'install.json');

/**
 * 首次安装时间（用于 7 天试用）。
 * 只写一次；文件损坏或写不进去时按本次启动时间算，至少不会阻断使用。
 */
function readTrialInfo() {
  if (TRIAL_DISABLED) return { createdAt: '', endsAt: '', active: false, daysLeft: 0 };
  let createdAt = '';
  try {
    const data = JSON.parse(fs.readFileSync(INSTALL_FILE, 'utf8'));
    createdAt = String(data?.createdAt || '');
  } catch {
    /* 首次启动或文件损坏：下面补写 */
  }
  if (!createdAt) {
    createdAt = new Date().toISOString();
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(INSTALL_FILE, JSON.stringify({ createdAt }, null, 2), 'utf8');
    } catch {
      /* 数据目录只读时退化为按本次启动计时 */
    }
  }
  const start = Date.parse(createdAt);
  const valid = Number.isFinite(start);
  const trialMs = TRIAL_DAYS * 24 * 60 * 60 * 1000;
  const leftMs = valid ? trialMs - (Date.now() - start) : 0;
  return {
    createdAt,
    endsAt: valid ? new Date(start + trialMs).toISOString() : '',
    active: leftMs > 0,
    daysLeft: Math.max(0, Math.ceil(leftMs / (24 * 60 * 60 * 1000))),
  };
}

/**
 * OMS 会话是否绑定了这张授权：
 * - 必须已登录 OMS（token 未过期），网站要求重新登录时自动退回免费版；
 * - 授权码里的手机号必须与 OMS 账号一致（签发时管理员用的就是这个账号）。
 * 试用 / 开发模式不走这条判断，保持原来的体验。
 * @param {{loggedIn?: boolean, username?: string}} oms
 * @param {string} licensePhone
 */
export function omsSessionMatchesLicense(oms, licensePhone) {
  const omsPhone = normalizePhone(oms?.username);
  const keyPhone = normalizePhone(licensePhone);
  return !!(oms?.loggedIn && omsPhone && keyPhone && omsPhone === keyPhone);
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
  const oms = omsClient.sessionSnapshot();
  const stamp = `${fileStamp()}|${revokeStamp()}|${revokeCheck.ok ? '1' : '0'}|${revokeCheck.at}|${oms.loggedIn ? '1' : '0'}|${oms.username}|${oms.expiresAt}`;
  if (!refresh && statusCache && statusCache.stamp === stamp) return statusCache.value;

  const parts = components(refresh);
  const machineCode = machineCodeFromParts(parts.legacy);
  const deviceCode = deviceCodeFromParts(parts.v2);
  const raw = readKeyFile();
  /** @type {any} */
  let payload = null;
  let reason = '';
  if (!VERIFIER_HEALTHY) {
    reason = '授权校验模块异常，已退回免费版';
  } else if (raw) {
    const result = verifyLicenseKey(raw, { publicKeyPem: PUBLIC_KEY, machineCode, deviceCode });
    if (result.ok) payload = result.payload;
    else reason = result.reason;
  } else {
    reason = '尚未激活';
  }

  const phone = payload
    ? String(payload.phone || payload.account || payload.email || payload.note || '').trim()
    : '';
  const account = phone; // 兼容旧字段：新授权码的账号就是手机号
  const omsBound = OMS_BINDING_DISABLED || omsSessionMatchesLicense(oms, phone);
  const revoke = readRevokeCache();
  const revokedPhones = Array.isArray(revoke?.payload?.revokedPhones)
    ? revoke.payload.revokedPhones.map((p) => normalizePhone(p)).filter(Boolean)
    : [];
  const revokedAccounts = Array.isArray(revoke?.payload?.revokedAccounts)
    ? revoke.payload.revokedAccounts.map((a) => normalizePhone(a)).filter(Boolean)
    : [];
  const revokedMachines = Array.isArray(revoke?.payload?.revokedMachines)
    ? revoke.payload.revokedMachines
        .map((m) => {
          const v2 = normalizeDeviceCode(m);
          return v2.length === 24 ? v2 : normalizeCode(m);
        })
        .filter(Boolean)
    : [];
  // 按「手机号 + 设备码」精确停用：同一台设备上的其他手机号不受影响。
  // 同时兼容字符串 `手机号|设备码` 与 { phone, machine } 两种写法。
  const revokedPairs = Array.isArray(revoke?.payload?.revokedPairs)
    ? revoke.payload.revokedPairs
        .map((pair) => {
          if (typeof pair === 'string') {
            const [p, ...rest] = pair.split('|');
            return licensePairKey(p, rest.join('|'));
          }
          if (pair && typeof pair === 'object') return licensePairKey(pair.phone, pair.machine);
          return '';
        })
        .filter(Boolean)
    : [];
  const phoneKey = normalizePhone(phone);
  const pairRevoked =
    !!payload &&
    !!phoneKey &&
    (revokedPairs.includes(licensePairKey(phoneKey, deviceCode)) ||
      revokedPairs.includes(licensePairKey(phoneKey, machineCode)));
  const revoked =
    !!payload &&
    ((phoneKey && (revokedPhones.includes(phoneKey) || revokedAccounts.includes(phoneKey))) ||
      pairRevoked ||
      revokedMachines.includes(normalizeCode(machineCode)) ||
      revokedMachines.includes(normalizeDeviceCode(deviceCode)));
  // 开发环境（源码运行 / npm run dev / Electron 未打包）默认拥有全部专业版能力；
  // 打包后的安装包必须靠真实授权。任何环境变量都不能在打包版打开 Pro。
  const devPro = !IS_PACKAGED && !STRICT_LICENSE;

  // 每台设备首次安装给 7 天完整专业版试用
  const trial = readTrialInfo();

  // 联网校验失败不再整体禁用软件：退回免费版，网络恢复后自动回到专业版。
  // 只有「明确被远程停用」才整体禁用。
  const failClosed = !!payload && !REVOKE_DISABLED;
  const checkFailed = failClosed && !revokeCheck.ok;
  const blocked = revoked;
  const proActive =
    VERIFIER_HEALTHY && (devPro || trial.active || (!blocked && !checkFailed && !!payload && omsBound));
  if (revoked) reason = '该手机号或设备已被远程停用，请联系管理员';
  else if (checkFailed) {
    reason = `无法连接授权服务器，已暂时退回免费版${revokeCheck.error ? `（${revokeCheck.error}）` : ''}；网络恢复后会自动恢复专业版。`;
  } else if (!OMS_BINDING_DISABLED && payload && !oms.loggedIn) {
    reason = 'OMS 登录已过期或未登录，请重新登录以继续使用专业版';
  } else if (payload && !omsBound) {
    reason = `授权手机号（${phone || '无'}）与 OMS 账号（${oms.username || '未登录'}）不一致，请用一个手机号登录并激活对应授权`;
  } else if (!payload && VERIFIER_HEALTHY) {
    if (devPro) reason = '开发环境：专业版功能已开启';
    else if (trial.active) reason = `试用中，还剩 ${trial.daysLeft} 天`;
    else reason = `${TRIAL_DAYS} 天试用已结束，输入激活码继续使用专业版`;
  }

  const value = {
    product: PRODUCT,
    edition: proActive ? String(payload?.edition || 'pro') : 'free',
    licensed: proActive,
    /** 本机是否真的有验签通过的授权文件（区别于开发模式的临时专业版） */
    licensedByKey: VERIFIER_HEALTHY && !revoked && !!payload,
    verifierHealthy: VERIFIER_HEALTHY,
    devPro,
    /** 新设备 7 天试用：试用期内与专业版能力一致 */
    trial: !devPro && trial.active && !payload,
    trialDaysLeft: trial.active ? trial.daysLeft : 0,
    trialEndsAt: trial.endsAt,
    trialExpired: !devPro && !trial.active && !payload,
    machineCode,
    /** v2 设备码：新授权与新签发都按它绑定 */
    deviceCode,
    deviceCodeVersion: 2,
    phone,
    account,
    /** OMS 登录会话：必须由这个账号登录且授权手机号一致，才会真正启用 Pro */
    omsLoggedIn: oms.loggedIn,
    omsUsername: oms.username,
    omsExpiresAt: oms.expiresAt,
    omsError: oms.error,
    omsBound,
    revoked,
    /** 连不上停用清单：当前按免费版运行，但软件功能不禁用 */
    checkFailed,
    /** 只有明确被远程停用时才整体锁定数据接口 */
    blocked,
    revokeRequired: failClosed,
    revokeUrl: REVOKE_URL || '',
    revokedAt: revoked ? String(revoke?.payload?.issuedAt || '') : '',
    revokeCheckedAt: revokeCheck.at
      ? new Date(revokeCheck.at).toISOString()
      : revoke?.fetchedAt
        ? new Date(revoke.fetchedAt).toISOString()
        : '',
    revokeError: REVOKE_DISABLED
      ? '已关闭停用检查（开发 / 测试）'
      : !revokeCheck.ok
        ? revokeCheck.error
        : '',
    issuedAt: payload?.issuedAt ? String(payload.issuedAt) : '',
    expires: payload?.expires ? String(payload.expires) : null,
    daysLeft: payload ? daysLeft(payload.expires) : null,
    note: payload?.note ? String(payload.note) : '',
    reason,
    // 购买页地址由构建方注入；留空时设置页只显示「把设备码发给作者」
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

/** 数据接口是否应整体锁定：只有明确被远程停用才锁；联网失败/到期都退回免费版 */
export function isBlocked() {
  return licenseStatus().blocked;
}

/**
 * 激活：验签通过才落盘。写入用 临时文件 + rename，避免中途断电留下半个授权文件。
 * @param {string} key
 */
export function activateLicense(key) {
  if (!VERIFIER_HEALTHY) return { ok: false, reason: '授权校验模块异常，无法激活' };
  const raw = String(key ?? '').trim();
  if (!raw) return { ok: false, reason: '请填写激活码' };
  if (raw.length > 8192) return { ok: false, reason: '激活码长度不正确' };
  const parts = components();
  const result = verifyLicenseKey(raw, {
    publicKeyPem: PUBLIC_KEY,
    machineCode: machineCodeFromParts(parts.legacy),
    deviceCode: deviceCodeFromParts(parts.v2),
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${LICENSE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, raw, { mode: 0o600 });
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
