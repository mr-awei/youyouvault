#!/usr/bin/env node
/**
 * 生成远程停用清单（离职 / 违约 / 丢失授权时使用）。
 *
 * 用法：
 *   node scripts/license-revoke.mjs --phone 13800000000 --seq 1
 *   node scripts/license-revoke.mjs --machine A1B2-C3D4-E5F6-7890 --seq 2
 *   node scripts/license-revoke.mjs --phone 13800000000 --machine A1B2-C3D4-E5F6-7890
 *
 * 说明：
 * - --phone 会停用该手机号下的所有设备；--machine 只停用单台设备。
 * - 一个手机号可以对应多台设备，一个设备也可以对应多个手机号；
 *   手机号停用优先，即使同一台设备上还有别的手机号授权，也会被这条记录锁定。
 * - --seq 必须递增；客户端拒绝比本地缓存更旧的清单。
 *
 * 输出 JSON：{ "token": "TUKU-REVOKE1..." }
 * 把该文件放到任意静态 HTTP(S) 地址，并在软件构建/启动时设置：
 *   TUKU_LICENSE_REVOKE_URL=https://.../license-revoke.json
 * 客户端启动与手动刷新授权时拉取并用内置公钥验签；离线时使用上次缓存。
 *
 * 日常管理建议用图形工具：npm run license:admin
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  formatCode,
  isValidPhone,
  normalizeCode,
  normalizePhone,
  signRevocationList,
} from '../server/lib/license-core.js';

const root = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const values = (name) => {
  const out = [];
  argv.forEach((v, i) => {
    if (v === `--${name}`) out.push(String(argv[i + 1] || '').trim());
  });
  return out.filter(Boolean);
};
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1] || '') : fallback;
};

// --account 是旧参数，等同 --phone；授权码里的 account 现在就是手机号
const phones = [...new Set([...values('phone'), ...values('account')].map(normalizePhone).filter(Boolean))];
for (const p of phones) {
  if (!isValidPhone(p)) {
    console.error('[revoke] 手机号格式不正确：', p);
    process.exit(1);
  }
}
const machines = values('machine').map((m) => {
  if (normalizeCode(m).length !== 16) {
    console.error('[revoke] 设备码应为 16 位十六进制：', m);
    process.exit(1);
  }
  return formatCode(m);
});

if (!phones.length && !machines.length) {
  console.error('[revoke] 至少提供一个 --phone 或 --machine');
  process.exit(1);
}

let privateKey = process.env.TUKU_LICENSE_PRIVATE_KEY || '';
if (!privateKey) {
  try {
    privateKey = fs.readFileSync(path.join(root, '.license-private.pem'), 'utf8');
  } catch {
    console.error('[revoke] 读不到私钥：先运行 node scripts/license-keygen.mjs');
    process.exit(1);
  }
}

const seq = Number(arg('seq', '1')) || 1;
const token = signRevocationList(
  {
    seq,
    issuedAt: new Date().toISOString(),
    revokedPhones: phones,
    revokedAccounts: phones, // 兼容只认 account 的旧客户端
    revokedMachines: machines,
  },
  privateKey
);
const out = arg('out');
const json = `${JSON.stringify({ token }, null, 2)}\n`;
if (out) {
  const target = path.resolve(root, out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, json, 'utf8');
  console.log('[revoke] 已写入：', target);
} else {
  console.log(json);
}
console.log('[revoke] 手机号：', phones.join(', ') || '（无）');
console.log('[revoke] 设备码：', machines.join(', ') || '（无）');
console.log('[revoke] seq：', seq);
