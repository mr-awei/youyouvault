#!/usr/bin/env node
/**
 * 签发授权码：完全离线，不需要服务器，也不需要用户注册账号。
 *
 * 用法：
 *   node scripts/license-issue.mjs --machine A1B2-C3D4-E5F6-7890 --days 365 --note buyer@example.com
 *   node scripts/license-issue.mjs --machine A1B2-C3D4-E5F6-7890 --expires 2027-11-20
 *   node scripts/license-issue.mjs --any --days 30          # 不绑定机器（试用 / 内部测试）
 *   node scripts/license-issue.mjs --machine ... --account zhangsan --out licenses/buyer.key
 *
 * --machine 就是用户在「设置 → 授权」里看到的机器码（带不带横线都可以）。
 * 私钥优先读环境变量 TUKU_LICENSE_PRIVATE_KEY（CI），否则读仓库根 .license-private.pem。
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatCode, normalizeCode, signLicenseKey } from '../server/lib/license-core.js';

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
const account = arg('account');
const edition = arg('edition', 'pro');
const out = arg('out');

let machine = '';
if (!anyMachine) {
  if (!input) {
    console.error('[license] 缺少 --machine <机器码>（用户可在「设置 → 授权」里复制），或加 --any 表示不绑定机器');
    process.exit(1);
  }
  if (normalizeCode(input).length !== 16) {
    console.error('[license] 机器码应为 16 位十六进制（形如 A1B2-C3D4-E5F6-7890），实际收到：', input);
    process.exit(1);
  }
  machine = formatCode(input);
}

const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
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
  { edition, machine, account, issuedAt: today(), expires, note },
  privateKey
);

console.log('[license] 账号：', account || '（未绑定账号）');
console.log('[license] 机器码：', machine || '（不绑定机器）');
console.log('[license] 有效期：', expires || '永久');
console.log('[license] 激活码：');
console.log(key);

if (out) {
  const target = path.resolve(root, out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${key}\n`, 'utf8');
  console.log('[license] 已写入：', target);
}
