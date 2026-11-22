#!/usr/bin/env node
/**
 * 授权管理工具（本地网页 / Electron 窗口共用）。
 *
 * 两种启动方式：
 * - 命令行：npm run license:admin（自动打开浏览器）
 * - Electron：tools/license-admin/main.mjs（双击 exe，内置窗口）
 *
 * 只监听 127.0.0.1，启动时生成访问令牌；私钥优先读 TUKU_LICENSE_PRIVATE_KEY，
 * 否则读仓库根 .license-private.pem。授权记录与停用清单写在 licenses/（已 gitignore）。
 *
 * 数据关系：
 * - 一次签发 = 一个手机号 + 一个新版设备码（TK2-...）；同一手机号可签多台设备。
 * - 同一台设备多人使用时，每个手机号各有独立授权码；取消其中一条不影响其他人。
 * - 停用手机号 = 该手机号下所有设备一起锁定；停用设备 = 只锁定这一台；
 *   取消某条授权 = 只停用「手机号 + 设备码」这一对。
 * - 新版授权码同时写 machine / machine2（都指向 v2 设备码），老客户端会安全拒绝，
 *   老授权码（只有 machine v1）继续按旧规则验证。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  daysLeft,
  formatCode,
  formatDeviceCode,
  isValidPhone,
  licensePairKey,
  normalizeCode,
  normalizeDeviceCode,
  normalizeMachineKey,
  normalizePhone,
  parseLicenseKey,
  signLicenseKey,
  signRevocationList,
  verifyLicenseKey,
  verifyRevocationList,
} from '../../server/lib/license-core.js';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOL_DIR, '..', '..');
const PUBLIC_DIR = path.join(TOOL_DIR, 'public');
const DEFAULT_PORT = Number(process.env.TUKU_LICENSE_ADMIN_PORT || 3199);
const HOST = '127.0.0.1';
const MAX_BODY = 1024 * 1024;
const PUBLISH_URL =
  'https://gitee.com/mr-awei/youyouvault/raw/main/docs/license/license-revoke.json';

/** @type {{ dataDir: string, storeFile: string, manifestFile: string, privateKey: string, publicKey: string, token: string, port: number }} */
let cfg = {
  dataDir: '',
  storeFile: '',
  manifestFile: '',
  privateKey: '',
  publicKey: '',
  token: '',
  port: DEFAULT_PORT,
};
let store = emptyStore();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const addDays = (days) => {
  const d = new Date();
  // 按「含今天」计算：30 天 = 今天 + 29 天，到期日 23:59，剩余天数显示 30
  d.setDate(d.getDate() + Math.max(0, days - 1));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function emptyStore() {
  return {
    version: 2,
    seq: 0,
    updatedAt: '',
    licenses: [],
    revokedPhones: [],
    revokedMachines: [],
    revokedPairs: [],
  };
}

/** @returns {any} */
function loadStore() {
  if (!fs.existsSync(cfg.storeFile)) return emptyStore();
  const raw = fs.readFileSync(cfg.storeFile, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error('admin.json 格式不正确');
  return {
    ...emptyStore(),
    ...data,
    licenses: Array.isArray(data.licenses) ? data.licenses : [],
    revokedPhones: Array.isArray(data.revokedPhones) ? data.revokedPhones.map(normalizePhone).filter(Boolean) : [],
    revokedMachines: Array.isArray(data.revokedMachines)
      ? data.revokedMachines
          .map((m) => {
            const v2 = normalizeDeviceCode(m);
            return v2.length === 24 ? v2 : normalizeCode(m);
          })
          .filter(Boolean)
      : [],
    revokedPairs: Array.isArray(data.revokedPairs)
      ? data.revokedPairs
          .map((pair) => {
            if (typeof pair === 'string') {
              const [p, ...rest] = pair.split('|');
              return licensePairKey(p, rest.join('|'));
            }
            if (pair && typeof pair === 'object') return licensePairKey(pair.phone, pair.machine);
            return '';
          })
          .filter(Boolean)
      : [],
  };
}

function saveStore() {
  store.updatedAt = new Date().toISOString();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const tmp = `${cfg.storeFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, cfg.storeFile);
}

function manifestToken() {
  if (!cfg.privateKey) return '';
  return signRevocationList(
    {
      seq: store.seq,
      issuedAt: store.updatedAt || new Date().toISOString(),
      revokedPhones: store.revokedPhones,
      revokedAccounts: store.revokedPhones, // 兼容旧客户端
      revokedMachines: store.revokedMachines,
      revokedPairs: store.revokedPairs,
    },
    cfg.privateKey
  );
}

function writeManifest() {
  const token = manifestToken();
  if (!token) return '';
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const tmp = `${cfg.manifestFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ token }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, cfg.manifestFile);
  return token;
}

function readManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.manifestFile, 'utf8'));
    const token = String(raw?.token || '').trim();
    if (!token) return '';
    if (!cfg.publicKey) return token;
    const checked = verifyRevocationList(token, { publicKeyPem: cfg.publicKey });
    return checked.ok ? token : '';
  } catch {
    return '';
  }
}

function isExpired(expires) {
  if (!expires) return false;
  const end = Date.parse(String(expires).length <= 10 ? `${expires}T23:59:59` : String(expires));
  return Number.isFinite(end) && Date.now() > end;
}

/** 找到仓库里的发布文件 docs/license/license-revoke.json（开发态或 exe 附近） */
function findPublishFile() {
  const candidates = [path.join(ROOT, 'docs', 'license', 'license-revoke.json')];
  for (const root of [process.env.PORTABLE_EXECUTABLE_DIR, process.cwd(), path.dirname(process.execPath)]) {
    if (!root) continue;
    let dir = root;
    for (let i = 0; i < 5; i++) {
      candidates.push(path.join(dir, 'docs', 'license', 'license-revoke.json'));
      const next = path.dirname(dir);
      if (next === dir) break;
      dir = next;
    }
  }
  for (const file of [...new Set(candidates)]) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* 继续找 */
    }
  }
  return '';
}

/** 读仓库发布文件里的 seq；用来保证管理工具生成的 seq 一定大于线上版本 */
function readPublishedSeq() {
  const file = findPublishFile();
  if (!file) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const token = String(raw?.token || '').trim();
    if (!token || !cfg.publicKey) return 0;
    const checked = verifyRevocationList(token, { publicKeyPem: cfg.publicKey });
    return checked.ok ? Number(checked.payload?.seq) || 0 : 0;
  } catch {
    return 0;
  }
}

function decorate(record) {
  const machineKey = normalizeMachineKey(record.machine);
  const phoneKey = normalizePhone(record.phone);
  const pairKey = licensePairKey(phoneKey, machineKey);
  const phoneRevoked = store.revokedPhones.includes(phoneKey);
  const machineRevoked = !!machineKey && store.revokedMachines.includes(machineKey);
  const pairRevoked = !!pairKey && store.revokedPairs.includes(pairKey);
  const revoked = phoneRevoked || machineRevoked || pairRevoked;
  const expired = !revoked && isExpired(record.expires);
  return {
    ...record,
    phone: phoneKey || record.phone,
    machine: machineKey.length === 24 ? formatDeviceCode(machineKey) : record.machine,
    deviceVersion: machineKey.length === 24 ? 2 : 1,
    status: revoked ? 'revoked' : expired ? 'expired' : 'active',
    revokedBy: phoneRevoked ? 'phone' : machineRevoked ? 'machine' : pairRevoked ? 'pair' : '',
    daysLeft: daysLeft(record.expires),
  };
}

function state() {
  const licenses = store.licenses.map(decorate).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const phones = [...new Set(licenses.map((l) => l.phone))];
  const active = licenses.filter((l) => l.status === 'active');
  const expiring = active.filter((l) => l.daysLeft != null && l.daysLeft <= 7);
  return {
    ok: true,
    keyReady: !!cfg.privateKey,
    admin: {
      dataDir: cfg.dataDir,
      storeFile: cfg.storeFile,
      manifestFile: cfg.manifestFile,
      manifestUrl: `http://${HOST}:${cfg.port}/license-revoke.json`,
      publishFile: findPublishFile(),
      publishUrl: PUBLISH_URL,
    },
    summary: {
      records: licenses.length,
      phones: phones.length,
      active: active.length,
      expiring7: expiring.length,
      expired: licenses.filter((l) => l.status === 'expired').length,
      revoked: licenses.filter((l) => l.status === 'revoked').length,
      revokedPhones: store.revokedPhones.length,
      revokedMachines: store.revokedMachines.length,
      revokedPairs: store.revokedPairs.length,
    },
    licenses,
    revocations: {
      phones: store.revokedPhones,
      machines: store.revokedMachines,
      pairs: store.revokedPairs,
    },
    seq: store.seq,
    manifest: { token: readManifest() },
  };
}

function issueOne({ phone, machine, edition, issuedAt, expires, note }) {
  const now = new Date().toISOString();
  const deviceCode = formatDeviceCode(machine);
  const key = signLicenseKey(
    {
      edition,
      machine: deviceCode,
      machine2: deviceCode,
      phone,
      account: phone,
      issuedAt,
      expires,
      note,
    },
    cfg.privateKey
  );
  // 签完立即用公钥回验一次，避免私钥 / 公钥不配对却把坏码发给用户
  if (cfg.publicKey) {
    const checked = verifyLicenseKey(key, { publicKeyPem: cfg.publicKey, deviceCode });
    if (!checked.ok) throw new Error(`自检失败：${checked.reason}`);
  }
  const existing = store.licenses.find(
    (x) => normalizePhone(x.phone) === phone && normalizeMachineKey(x.machine) === normalizeDeviceCode(deviceCode)
  );
  const record = {
    id: existing?.id || crypto.randomUUID(),
    phone,
    machine: deviceCode,
    edition,
    issuedAt,
    expires: expires || null,
    note: note || '',
    key,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (existing) Object.assign(existing, record);
  else store.licenses.push(record);
  return record;
}

function readValidity(body) {
  const expiresArg = String(body.expires || '').trim();
  const daysArg = body.days;
  if (expiresArg) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresArg) || !Number.isFinite(Date.parse(expiresArg))) {
      return { error: '到期日格式应为 YYYY-MM-DD' };
    }
    return { expires: expiresArg };
  }
  if (daysArg !== undefined && daysArg !== null && daysArg !== '' && Number(daysArg) !== 0) {
    const n = Number(daysArg);
    if (!Number.isFinite(n) || n < 1) return { error: '有效天数应为 ≥1 的数字，0 表示永久' };
    return { expires: addDays(n) };
  }
  return { expires: null };
}

/** 从「手机号 + 设备码」一行里拆出两段；设备码可带 TK2- 或直接 24 位 */
function parsePairLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return null;
  const match = raw.match(/(?:TK2[-\s]?)?(?:[0-9A-Fa-f]{4}[-\s]?){5}[0-9A-Fa-f]{4}/);
  if (!match) return null;
  return {
    phone: normalizePhone(raw.replace(match[0], ' ')),
    machine: normalizeDeviceCode(match[0]),
  };
}

/** 批量授权必须显式成对：一行 / 一个对象只能有一个手机号和一个设备码 */
function normalizeIssuePairs(body) {
  const source = Array.isArray(body.pairs) ? body.pairs : [];
  if (source.length > 500) return { error: '一次最多批量授权 500 条' };
  const pairs = [];
  for (let i = 0; i < source.length; i++) {
    const item = source[i];
    const parsed =
      typeof item === 'string'
        ? parsePairLine(item)
        : item && typeof item === 'object'
          ? { phone: normalizePhone(item.phone), machine: normalizeDeviceCode(item.machine) }
          : null;
    if (!parsed) return { error: `第 ${i + 1} 行格式不正确，应为「手机号 + 设备码」` };
    if (!isValidPhone(parsed.phone)) return { error: `第 ${i + 1} 行手机号格式不正确` };
    if (parsed.machine.length !== 24) {
      return {
        error:
          parsed.machine.length === 16
            ? `第 ${i + 1} 行是旧版设备码，已不能用于新签发`
            : `第 ${i + 1} 行设备码应为 TK2-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX（24 位十六进制）`,
      };
    }
    pairs.push({ phone: parsed.phone, machine: parsed.machine });
  }
  // 完全相同的「手机号 + 设备码」在本次请求里只签一次
  const unique = [...new Map(pairs.map((p) => [licensePairKey(p.phone, p.machine), p])).values()];
  return { pairs: unique };
}

function selectedRecords(body) {
  const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
  return store.licenses.filter((x) => ids.has(x.id));
}

/* ------------------------------ HTTP 工具 ------------------------------ */

function sendJson(res, status, data) {
  const body = `${JSON.stringify(data)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(req, url) {
  const header = String(req.headers.authorization || '');
  const bearer = header.replace(/^Bearer\s+/i, '').trim();
  const supplied = bearer || String(req.headers['x-admin-token'] || url.searchParams.get('token') || '').trim();
  return supplied === cfg.token;
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return false;
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ 路由处理 ------------------------------ */

async function handleApi(req, res, url) {
  if (!authorized(req, url)) {
    return sendJson(res, 401, { error: '访问令牌不正确，请使用启动时打印的地址打开' });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(res, 200, state());
  }

  if (req.method === 'POST' && url.pathname === '/api/issue') {
    if (!cfg.privateKey) return sendJson(res, 503, { error: '读不到授权私钥，无法签发' });
    const body = await readJson(req);
    const phone = normalizePhone(body.phone);
    if (!isValidPhone(phone)) return sendJson(res, 400, { error: '手机号格式不正确（5–20 位数字，可带 +）' });
    const machine = normalizeDeviceCode(body.machine ?? body.machines);
    if (machine.length !== 24) {
      return sendJson(res, 400, {
        error:
          machine.length === 16
            ? '这是旧版设备码，已不能用于新签发。请用户升级客户端后复制 TK2- 开头的新版设备码。'
            : `设备码应为 TK2-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX（24 位十六进制）：${machine}`,
      });
    }
    const validity = readValidity(body);
    if (validity.error) return sendJson(res, 400, { error: validity.error });

    const edition = String(body.edition || 'pro').trim() || 'pro';
    const note = String(body.note || '').slice(0, 200);
    const created = [issueOne({ phone, machine, edition, issuedAt: today(), expires: validity.expires, note })];
    saveStore();
    return sendJson(res, 200, { ok: true, created, state: state() });
  }

  if (req.method === 'POST' && url.pathname === '/api/issue-batch') {
    if (!cfg.privateKey) return sendJson(res, 503, { error: '读不到授权私钥，无法签发' });
    const body = await readJson(req);
    const normalized = normalizeIssuePairs(body);
    if (normalized.error) return sendJson(res, 400, { error: normalized.error });
    if (!normalized.pairs.length) return sendJson(res, 400, { error: '至少填写一条「手机号 + 设备码」' });
    const validity = readValidity(body);
    if (validity.error) return sendJson(res, 400, { error: validity.error });

    const edition = String(body.edition || 'pro').trim() || 'pro';
    const note = String(body.note || '').slice(0, 200);
    const issuedAt = today();
    const created = normalized.pairs.map((pair) =>
      issueOne({ phone: pair.phone, machine: pair.machine, edition, issuedAt, expires: validity.expires, note })
    );
    saveStore();
    return sendJson(res, 200, { ok: true, created, state: state() });
  }

  if (req.method === 'POST' && url.pathname === '/api/cancel') {
    if (!cfg.privateKey) return sendJson(res, 503, { error: '读不到授权私钥，无法更新停用清单' });
    const body = await readJson(req);
    const records = selectedRecords(body);
    if (!records.length) return sendJson(res, 400, { error: '没有选中要取消的授权' });
    const pairs = new Set(store.revokedPairs);
    let changed = false;
    for (const record of records) {
      const key = licensePairKey(record.phone, record.machine);
      if (key && !pairs.has(key)) {
        pairs.add(key);
        changed = true;
      }
    }
    if (changed) {
      store.revokedPairs = [...pairs];
      store.seq += 1;
      saveStore();
      writeManifest();
    }
    return sendJson(res, 200, { ok: true, changed, count: records.length, state: state() });
  }

  if (req.method === 'POST' && url.pathname === '/api/restore') {
    if (!cfg.privateKey) return sendJson(res, 503, { error: '读不到授权私钥，无法更新停用清单' });
    const body = await readJson(req);
    const records = selectedRecords(body);
    if (!records.length) return sendJson(res, 400, { error: '没有选中要恢复的授权' });
    const pairs = new Set(store.revokedPairs);
    const phones = new Set(store.revokedPhones);
    const machines = new Set(store.revokedMachines);
    let changed = false;
    for (const record of records) {
      const pairKey = licensePairKey(record.phone, record.machine);
      if (pairKey && pairs.delete(pairKey)) changed = true;
      const phone = normalizePhone(record.phone);
      if (phone && phones.delete(phone)) changed = true;
      const machine = normalizeMachineKey(record.machine);
      if (machine && machines.delete(machine)) changed = true;
    }
    if (changed) {
      store.revokedPairs = [...pairs];
      store.revokedPhones = [...phones];
      store.revokedMachines = [...machines];
      store.seq += 1;
      saveStore();
      writeManifest();
    }
    return sendJson(res, 200, { ok: true, changed, count: records.length, state: state() });
  }

  if (req.method === 'POST' && url.pathname === '/api/revoke') {
    if (!cfg.privateKey) return sendJson(res, 503, { error: '读不到授权私钥，无法更新停用清单' });
    const body = await readJson(req);
    const scope = String(body.scope || '');
    const revoked = body.revoked !== false;
    if (scope !== 'phone' && scope !== 'machine') {
      return sendJson(res, 400, { error: 'scope 只能是 phone 或 machine' });
    }
    let changed;
    if (scope === 'phone') {
      const phone = normalizePhone(body.value);
      if (!isValidPhone(phone)) return sendJson(res, 400, { error: '手机号格式不正确' });
      const set = new Set(store.revokedPhones);
      if (revoked) set.add(phone);
      else set.delete(phone);
      changed = set.size !== store.revokedPhones.length;
      store.revokedPhones = [...set];
    } else {
      const v2 = normalizeDeviceCode(body.value);
      const v1 = normalizeCode(body.value);
      const machine = v2.length === 24 ? v2 : v1.length === 16 ? v1 : '';
      if (!machine) return sendJson(res, 400, { error: '设备码格式不正确（新版 TK2-... 或旧版 16 位）' });
      const set = new Set(store.revokedMachines);
      if (revoked) set.add(machine);
      else set.delete(machine);
      changed = set.size !== store.revokedMachines.length;
      store.revokedMachines = [...set];
    }
    if (changed) {
      store.seq += 1;
      saveStore();
      writeManifest();
    }
    return sendJson(res, 200, { ok: true, changed, state: state() });
  }

  if (req.method === 'POST' && url.pathname === '/api/delete') {
    const body = await readJson(req);
    const id = String(body.id || '');
    const before = store.licenses.length;
    store.licenses = store.licenses.filter((x) => x.id !== id);
    if (store.licenses.length !== before) saveStore();
    return sendJson(res, 200, { ok: true, deleted: store.licenses.length !== before, state: state() });
  }

  if (req.method === 'POST' && url.pathname === '/api/import-legacy') {
    const files = new Set();
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && /\.(key|txt)$/i.test(entry.name)) files.add(full);
      }
    };
    // 除了当前数据目录，也找 exe / 工作目录附近的 licenses/，方便把以前命令行导出的 key 导进来
    const scanDirs = new Set([cfg.dataDir]);
    for (const root of [process.env.PORTABLE_EXECUTABLE_DIR, process.cwd(), path.dirname(process.execPath)]) {
      if (!root) continue;
      let dir = root;
      for (let i = 0; i < 4; i++) {
        scanDirs.add(path.join(dir, 'licenses'));
        const next = path.dirname(dir);
        if (next === dir) break;
        dir = next;
      }
    }
    for (const dir of scanDirs) walk(dir, 0);

    let added = 0;
    let skipped = 0;
    for (const file of files) {
      let content;
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_BODY) {
          skipped++;
          continue;
        }
        content = fs.readFileSync(file, 'utf8');
      } catch {
        skipped++;
        continue;
      }
      const token = /TUKU1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(content)?.[0];
      const parsed = token ? parseLicenseKey(token) : null;
      const payload = parsed?.payload;
      const phone = normalizePhone(payload?.phone || payload?.account);
      const v2 = normalizeDeviceCode(payload?.machine2 || '');
      const machine = v2.length === 24 ? formatDeviceCode(v2) : formatCode(normalizeCode(payload?.machine));
      const deviceOk = normalizeDeviceCode(machine).length === 24 || normalizeCode(machine).length === 16;
      if (!payload || String(payload.product || '') !== 'tuku' || !isValidPhone(phone) || !deviceOk) {
        skipped++;
        continue;
      }
      if (store.licenses.some((x) => x.phone === phone && x.machine === machine)) {
        skipped++;
        continue;
      }
      const now = new Date().toISOString();
      store.licenses.push({
        id: crypto.randomUUID(),
        phone,
        machine,
        edition: String(payload.edition || 'pro'),
        issuedAt: String(payload.issuedAt || ''),
        expires: payload.expires ? String(payload.expires) : null,
        note: String(payload.note || path.basename(file)).slice(0, 200),
        key: token,
        createdAt: now,
        updatedAt: now,
      });
      added++;
    }
    if (added) saveStore();
    return sendJson(res, 200, { ok: true, added, skipped, files: files.size, state: state() });
  }

  if (req.method === 'POST' && url.pathname === '/api/publish') {
    if (!cfg.privateKey) return sendJson(res, 503, { error: '读不到授权私钥，无法生成停用清单' });
    const file = findPublishFile();
    if (!file) return sendJson(res, 404, { error: '没找到 docs/license/license-revoke.json，请从仓库目录启动工具或手动复制清单内容' });
    const publishedSeq = readPublishedSeq();
    if (publishedSeq >= store.seq) {
      store.seq = publishedSeq + 1;
      saveStore();
    }
    const token = writeManifest();
    if (!token) return sendJson(res, 500, { error: '生成停用清单失败' });
    try {
      fs.writeFileSync(file, `${JSON.stringify({ token }, null, 2)}\n`, 'utf8');
    } catch (err) {
      return sendJson(res, 500, { error: `写入失败：${err instanceof Error ? err.message : err}` });
    }
    return sendJson(res, 200, { ok: true, file, url: PUBLISH_URL, token });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}:${cfg.port}`);

  if (req.method === 'GET' && url.pathname === '/license-revoke.json') {
    if (!fs.existsSync(cfg.manifestFile)) return sendJson(res, 404, { error: '还没有停用记录' });
    const data = await fsp.readFile(cfg.manifestFile);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
    return;
  }

  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  if (req.method === 'GET' && (await serveStatic(url.pathname, res))) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

/* ------------------------------ 启动 ------------------------------ */

function resolvePrivateKey(explicit) {
  if (explicit) return explicit;
  if (process.env.TUKU_LICENSE_PRIVATE_KEY) return process.env.TUKU_LICENSE_PRIVATE_KEY;
  const candidates = [
    path.join(ROOT, '.license-private.pem'),
    path.join(TOOL_DIR, '.license-private.pem'),
    path.join(path.dirname(process.execPath), '.license-private.pem'),
  ];
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      /* 继续找 */
    }
  }
  return '';
}

function resolvePublicKey(explicit) {
  if (explicit) return explicit;
  if (process.env.TUKU_LICENSE_PUBLIC_KEY) return process.env.TUKU_LICENSE_PUBLIC_KEY;
  for (const file of [path.join(TOOL_DIR, 'license-public.pem'), path.join(ROOT, 'server', 'license-public.pem')]) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      /* 继续找 */
    }
  }
  return '';
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开浏览器时用户可手动复制地址 */
  }
}

/**
 * 启动管理服务。Electron 主进程会传 port=0（随机端口）与自己的私钥路径。
 * @param {{
 *   port?: number, host?: string, dataDir?: string, token?: string,
 *   privateKey?: string, publicKey?: string, autoOpen?: boolean, quiet?: boolean
 * }} [options]
 */
export async function startAdminServer(options = {}) {
  const port = Number.isFinite(options.port) ? Number(options.port) : DEFAULT_PORT;
  const host = options.host || HOST;
  const dataDir = options.dataDir || process.env.TUKU_LICENSE_ADMIN_DATA || path.join(ROOT, 'licenses');
  const token = options.token || crypto.randomBytes(18).toString('base64url');
  cfg = {
    dataDir,
    storeFile: path.join(dataDir, 'admin.json'),
    manifestFile: path.join(dataDir, 'license-revoke.json'),
    privateKey: resolvePrivateKey(options.privateKey),
    publicKey: resolvePublicKey(options.publicKey),
    token,
    port,
  };

  try {
    store = loadStore();
  } catch (err) {
    throw new Error(
      `读取失败，请先修好或备份后移走：${cfg.storeFile}\n${err instanceof Error ? err.message : err}`,
      { cause: err }
    );
  }

  // 线上发布文件可能已经被 CLI / 上一次发布推到更高 seq；管理工具必须从这里起步，
  // 否则新生成的清单会被客户端当成“旧版本”忽略。
  try {
    const publishedSeq = readPublishedSeq();
    if (publishedSeq > store.seq) {
      store.seq = publishedSeq;
      saveStore();
    }
  } catch {
    /* 发布文件读不到不影响本机管理 */
  }

  // 启动时确保清单文件存在且不落后于管理数据（手工删过文件 / 换机器后也能恢复）
  if (
    cfg.privateKey &&
    (store.seq > 0 || store.revokedPhones.length || store.revokedMachines.length || store.revokedPairs.length)
  ) {
    try {
      writeManifest();
    } catch (err) {
      console.warn('[license-admin] 生成停用清单失败：', err instanceof Error ? err.message : err);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[license-admin]', err);
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  cfg.port = actualPort;
  const url = `http://${host}:${actualPort}/?token=${token}`;

  if (!options.quiet) {
    console.log('');
    console.log('  授权管理工具已启动：');
    console.log(`  ${url}`);
    console.log('');
    console.log(`  授权记录：${cfg.storeFile}`);
    console.log(`  停用清单：${cfg.manifestFile}`);
    console.log(`  私钥：${cfg.privateKey ? '已加载' : '未找到（只能查看，不能签发 / 停用）'}`);
    console.log('  关闭窗口或按 Ctrl+C 结束；记录只保存在本机，不会上传。');
    console.log('');
  }
  if (options.autoOpen) openBrowser(url);

  return {
    url,
    token,
    port: actualPort,
    dataDir: cfg.dataDir,
    keyReady: !!cfg.privateKey,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
      }),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const autoOpen = process.env.TUKU_NO_OPEN !== '1';
  startAdminServer({ autoOpen }).catch((err) => {
    console.error('[license-admin] 启动失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
