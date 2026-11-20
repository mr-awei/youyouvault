#!/usr/bin/env node
/**
 * 签发授权码：完全离线，不需要服务器，也不需要用户注册账号。
 *
 * 用法：
 *   node scripts/license-issue.mjs --phone 13800000000 --machine A1B2-C3D4-E5F6-7890 --days 365
 *   node scripts/license-issue.mjs --phone 13800000000 --expires 2027-11-20
 *   node scripts/license-issue.mjs --phone 13800000000 --any --days 30   # 不绑定设备（内部测试）
 *
 * 规则：
 * - 手机号必填：远程停用按手机号匹配，一个手机号可以签多台设备。
 * - 设备码必填（除非显式 --any）：同一台设备也可以签给多个手机号（不同授权码）。
 * - 设备码就是用户在「设置 → 授权」里看到的机器码，带不带横线都可以。
 *
 * 私钥优先读环境变量 TUKU_LICENSE_PRIVATE_KEY（CI），否则读仓库根 .license-private.pem。
 * 日常签发建议用图形工具：npm run license:admin
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  formatDeviceCode,
  isValidPhone,
  normalizeCode,
  normalizeDeviceCode,
  normalizePhone,
  signLicenseKey,
} from '../server/lib/license-core.js';

const root = path.resolve(import.meta.dirname, '..');

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] || '') : fallback;
};

const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const anyMachine = process.argv.includes('--any');
const input = arg('machine');
const daysArg = arg('days');
const note = arg('note');
const phoneRaw = arg('phone') || arg('account');
const edition = arg('edition', 'pro');
const out = arg('out');

const phone = normalizePhone(phoneRaw);
if (!phone || !isValidPhone(phone)) {
  console.error('[license] 缺少或格式不正确的 --phone <手机号>（5–20 位数字，可带 + 前缀）');
  console.error('[license] 手机号和设备码是签发的必填项：一个手机号可以绑定多台设备。');
  process.exit(1);
}

let machine = '';
if (!anyMachine) {
  if (!input) {
    console.error('[license] 缺少 --machine <设备码>（用户可在「设置 → 授权」里复制 TK2- 开头的新版设备码），或加 --any 表示不绑定设备');
    process.exit(1);
  }
  if (normalizeDeviceCode(input).length !== 24) {
    if (normalizeCode(input).length === 16) {
      console.error('[license] 这是旧版设备码。请让用户升级客户端后复制 TK2- 开头的新版设备码；旧授权码本身仍可继续使用。');
    } else {
      console.error('[license] 设备码应为 TK2-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX（24 位十六进制），实际收到：', input);
    }
    process.exit(1);
  }
  machine = formatDeviceCode(input);
}

const addDays = (n) => {
  const d = new Date();
  // 按「含今天」计算：30 天 = 今天 + 29 天，到期日 23:59，剩余天数显示 30
  d.setDate(d.getDate() + Math.max(0, n - 1));
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// 有效期优先级：--expires 日期 > --days N（0 = 永久） > 默认 365 天
const expiresArg = arg('expires');
let expires;
if (expiresArg) {
  expires = expiresArg;
} else if (daysArg !== '') {
  const n = Number(daysArg);
  if (!Number.isFinite(n) || n < 0) {
    console.error('[license] --days 应为 ≥0 的数字（0 表示永久）');
    process.exit(1);
  }
  expires = n > 0 ? addDays(n) : null;
} else {
  expires = addDays(365);
}

let privateKey = process.env.TUKU_LICENSE_PRIVATE_KEY || '';
if (!privateKey) {
  try {
    privateKey = fs.readFileSync(path.join(root, '.license-private.pem'), 'utf8');
  } catch {
    console.error('[license] 读不到私钥：先运行 node scripts/license-keygen.mjs 生成密钥对');
    process.exit(1);
  }
}

const key = signLicenseKey(
  {
    edition,
    machine,
    machine2: machine,
    phone,
    account: phone,
    issuedAt: today(),
    expires,
    note,
  },
  privateKey
);

console.log('[license] 手机号：', phone);
console.log('[license] 设备码：', machine || '（不绑定设备）');
console.log('[license] 有效期：', expires || '永久');
console.log('[license] 激活码：');
console.log(key);

if (out) {
  const target = path.resolve(root, out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${key}\n`, 'utf8');
  console.log('[license] 已写入：', target);
}
