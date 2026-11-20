#!/usr/bin/env node
/**
 * 授权管理工具（本地网页）：签发 / 查看 / 停用手机号与设备。
 *
 * 启动：npm run license:admin
 * - 只监听 127.0.0.1，启动时生成一次性访问令牌并自动打开浏览器。
 * - 私钥优先读 TUKU_LICENSE_PRIVATE_KEY，否则读仓库根 .license-private.pem。
 * - 授权记录与停用清单写在 licenses/ 下（已在 .gitignore，绝不进安装包）。
 *
 * 数据关系：
 * - 一次签发 = 一个手机号 + 一个设备码；同一手机号可签多台设备，同一设备也可签多个手机号。
 * - 停用手机号 = 该手机号下所有设备一起锁定；停用设备 = 只锁定这一台。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  daysLeft,
  formatCode,
  isValidPhone,
  normalizeCode,
  normalizePhone,
  parseLicenseKey,
  signLicenseKey,
  signRevocationList,
  verifyLicenseKey,
  verifyRevocationList,
} from '../../server/lib/license-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const DATA_DIR = process.env.TUKU_LICENSE_ADMIN_DATA || path.join(ROOT, 'licenses');
const STORE_FILE = path.join(DATA_DIR, 'admin.json');
const MANIFEST_FILE = path.join(DATA_DIR, 'license-revoke.json');
const PORT = Number(process.env.TUKU_LICENSE_ADMIN_PORT || 3199);
const HOST = '127.0.0.1';
const ADMIN_TOKEN = crypto.randomBytes(18).toString('base64url');

const PRIVATE_KEY = (() => {
  if (process.env.TUKU_LICENSE_PRIVATE_KEY) return process.env.TUKU_LICENSE_PRIVATE_KEY;
  try {
    return fs.readFileSync(path.join(ROOT, '.license-private.pem'), 'utf8');
  } catch {
    return '';
  }
})();

const PUBLIC_KEY = (() => {
  if (process.env.TUKU_LICENSE_PUBLIC_KEY) return process.env.TUKU_LICENSE_PUBLIC_KEY;
  try {
    return fs.readFileSync(path.join(ROOT, 'server', 'license-public.pem'), 'utf8');
  } catch {
    return '';
  }
})();

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
    version: 1,
    seq: 0,
    updatedAt: '',
    licenses: [],
    revokedPhones: [],
    revokedMachines: [],
  };
}

/** @returns {any} */
function loadStore() {
  if (!fs.existsSync(STORE_FILE)) return emptyStore();
  const raw = fs.readFileSync(STORE_FILE, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error('admin.json 格式不正确');
  return {
    ...emptyStore(),
    ...data,
    licenses: Array.isArray(data.licenses) ? data.licenses : [],
    revokedPhones: Array.isArray(data.revokedPhones) ? data.revokedPhones.map(normalizePhone).filter(Boolean) : [],
    revokedMachines: Array.isArray(data.revokedMachines)
      ? data.revokedMachines.map((m) => formatCode(normalizeCode(m))).filter(Boolean)
      : [],
  };
}

let store;
try {
  store = loadStore();
} catch (err) {
  console.error('[license-admin] 读取失败，请先修好或备份后移走：', STORE_FILE);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

function saveStore() {
  store.updatedAt = new Date().toISOString();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

function manifestToken() {
  if (!PRIVATE_KEY) return '';
  return signRevocationList(
    {
      seq: store.seq,
      issuedAt: store.updatedAt || new Date().toISOString(),
      revokedPhones: store.revokedPhones,
      revokedAccounts: store.revokedPhones, // 兼容旧客户端
      revokedMachines: store.revokedMachines,
    },
    PRIVATE_KEY
  );
}

function writeManifest() {
  const token = manifestToken();
  if (!token) return '';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${MANIFEST_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ token }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, MANIFEST_FILE);
  return token;
}

function readManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    const token = String(raw?.token || '').trim();
    if (!token) return '';
    if (!PUBLIC_KEY) return token;
    const checked = verifyRevocationList(token, { publicKeyPem: PUBLIC_KEY });
    return checked.ok ? token : '';
  } catch {
    return '';
  }
}

// 启动时确保清单文件存在且不落后于管理数据（手工删过文件 / 换机器后也能恢复）
if (PRIVATE_KEY && (store.seq > 0 || store.revokedPhones.length || store.revokedMachines.length)) {
  try {
    writeManifest();
  } catch (err) {
    console.warn('[license-admin] 生成停用清单失败：', err instanceof Error ? err.message : err);
  }
}

function isExpired(expires) {
  if (!expires) return false;
  const end = Date.parse(String(expires).length <= 10 ? `${expires}T23:59:59` : String(expires));
  return Number.isFinite(end) && Date.now() > end;
}

function decorate(record) {
  const revoked =
    store.revokedPhones.includes(normalizePhone(record.phone)) ||
    store.revokedMachines.includes(formatCode(normalizeCode(record.machine)));
  const expired = !revoked && isExpired(record.expires);
  return {
    ...record,
    status: revoked ? 'revoked' : expired ? 'expired' : 'active',
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
    keyReady: !!PRIVATE_KEY,
    admin: {
      dataDir: DATA_DIR,
      storeFile: STORE_FILE,
      manifestFile: MANIFEST_FILE,
      manifestUrl: `http://${HOST}:${PORT}/license-revoke.json`,
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
    },
    licenses,
    revocations: { phones: store.revokedPhones, machines: store.revokedMachines },
    seq: store.seq,
    manifest: { token: readManifest() },
  };
}

function issueOne({ phone, machine, edition, issuedAt, expires, note }) {
  const now = new Date().toISOString();
  const key = signLicenseKey(
    { edition, machine, phone, account: phone, issuedAt, expires, note },
    PRIVATE_KEY
  );
  // 签完立即用公钥回验一次，避免私钥 / 公钥不配对却把坏码发给用户
  if (PUBLIC_KEY) {
    const checked = verifyLicenseKey(key, { publicKeyPem: PUBLIC_KEY, machineCode: machine });
    if (!checked.ok) throw new Error(`自检失败：${checked.reason}`);
  }
  const existing = store.licenses.find((x) => x.phone === phone && x.machine === machine);
  const record = {
    id: existing?.id || crypto.randomUUID(),
    phone,
    machine,
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

/** 管理接口的访问令牌：防止本机其它网页顺手调用签发接口 */
function requireAdmin(req, res, next) {
  const header = String(req.get('authorization') || '');
  const bearer = header.replace(/^Bearer\s+/i, '').trim();
  const supplied = bearer || String(req.get('x-admin-token') || req.query.token || '').trim();
  if (supplied !== ADMIN_TOKEN) {
    res.status(401).json({ error: '访问令牌不正确，请使用启动时打印的地址打开' });
    return;
  }
  next();
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

// 停用清单给客户端 / 用户下载；只在本机监听，不含管理权限
app.get('/license-revoke.json', (_req, res) => {
  if (!fs.existsSync(MANIFEST_FILE)) return res.status(404).json({ error: '还没有停用记录' });
  res.type('application/json').sendFile(MANIFEST_FILE);
});

app.get('/api/state', requireAdmin, (_req, res) => {
  res.json(state());
});

app.post('/api/issue', requireAdmin, (req, res) => {
  if (!PRIVATE_KEY) return res.status(503).json({ error: '读不到授权私钥，无法签发' });
  const phone = normalizePhone(req.body?.phone);
  if (!isValidPhone(phone)) return res.status(400).json({ error: '手机号格式不正确（5–20 位数字，可带 +）' });

  const raw = req.body?.machines ?? req.body?.machine;
  const list = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => String(v ?? '').split(/[\s,，;；]+/))
    .map((v) => normalizeCode(v))
    .filter(Boolean);
  const machines = [...new Set(list)];
  if (!machines.length) return res.status(400).json({ error: '至少填写一个设备码' });
  const bad = machines.find((m) => m.length !== 16);
  if (bad) return res.status(400).json({ error: `设备码应为 16 位十六进制：${bad}` });

  const edition = String(req.body?.edition || 'pro').trim() || 'pro';
  const note = String(req.body?.note || '').slice(0, 200);
  const issuedAt = today();
  const expiresArg = String(req.body?.expires || '').trim();
  const daysArg = req.body?.days;
  let expires = null;
  if (expiresArg) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresArg) || !Number.isFinite(Date.parse(expiresArg))) {
      return res.status(400).json({ error: '到期日格式应为 YYYY-MM-DD' });
    }
    expires = expiresArg;
  } else if (daysArg !== undefined && daysArg !== null && daysArg !== '' && Number(daysArg) !== 0) {
    const n = Number(daysArg);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: '有效天数应为 ≥1 的数字，0 表示永久' });
    expires = addDays(n);
  }

  const created = machines.map((m) =>
    issueOne({ phone, machine: formatCode(m), edition, issuedAt, expires, note })
  );
  saveStore();
  res.json({ ok: true, created, state: state() });
});

app.post('/api/revoke', requireAdmin, (req, res) => {
  if (!PRIVATE_KEY) return res.status(503).json({ error: '读不到授权私钥，无法更新停用清单' });
  const scope = String(req.body?.scope || '');
  const revoked = req.body?.revoked !== false;
  if (scope !== 'phone' && scope !== 'machine') {
    return res.status(400).json({ error: 'scope 只能是 phone 或 machine' });
  }
  let changed;
  if (scope === 'phone') {
    const phone = normalizePhone(req.body?.value);
    if (!isValidPhone(phone)) return res.status(400).json({ error: '手机号格式不正确' });
    const set = new Set(store.revokedPhones);
    if (revoked) set.add(phone);
    else set.delete(phone);
    changed = set.size !== store.revokedPhones.length;
    store.revokedPhones = [...set];
  } else {
    const norm = normalizeCode(req.body?.value);
    if (norm.length !== 16) return res.status(400).json({ error: '设备码格式不正确' });
    const machine = formatCode(norm);
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
  res.json({ ok: true, changed, state: state() });
});

app.post('/api/delete', requireAdmin, (req, res) => {
  const id = String(req.body?.id || '');
  const before = store.licenses.length;
  store.licenses = store.licenses.filter((x) => x.id !== id);
  if (store.licenses.length !== before) saveStore();
  res.json({ ok: true, deleted: store.licenses.length !== before, state: state() });
});

/**
 * 把以前命令行 `--out licenses/xxx.key` 留下的激活码导入台账。
 * 只登记已带手机号 + 设备码的新授权；旧的无手机号授权会跳过并计数。
 */
app.post('/api/import-legacy', requireAdmin, (_req, res) => {
  const files = [];
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
      else if (entry.isFile() && /\.(key|txt)$/i.test(entry.name)) files.push(full);
    }
  };
  walk(DATA_DIR, 0);

  let added = 0;
  let skipped = 0;
  for (const file of files) {
    let content;
    try {
      const stat = fs.statSync(file);
      if (stat.size > 1024 * 1024) {
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
    const machine = formatCode(normalizeCode(payload?.machine));
    if (!payload || String(payload.product || '') !== 'tuku' || !isValidPhone(phone) || machine.length !== 19) {
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
  res.json({ ok: true, added, skipped, files: files.length, state: state() });
});

app.use((err, _req, res, _next) => {
  console.error('[license-admin]', err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
});

app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?token=${ADMIN_TOKEN}`;
  console.log('');
  console.log('  授权管理工具已启动：');
  console.log(`  ${url}`);
  console.log('');
  console.log(`  授权记录：${STORE_FILE}`);
  console.log(`  停用清单：${MANIFEST_FILE}`);
  console.log(`  私钥：${PRIVATE_KEY ? '已加载' : '未找到（只能查看，不能签发 / 停用）'}`);
  console.log('  关闭窗口或按 Ctrl+C 结束；记录只保存在本机，不会上传。');
  console.log('');
  if (process.env.TUKU_NO_OPEN !== '1') {
    try {
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      /* 打不开浏览器时用户可手动复制上面的地址 */
    }
  }
});
