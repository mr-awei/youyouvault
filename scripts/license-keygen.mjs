#!/usr/bin/env node
/**
 * 生成授权签名用的 Ed25519 密钥对。
 *
 * 公钥 → server/license-public.pem（随安装包发布，可提交）
 * 私钥 → .license-private.pem（已在 .gitignore，只留本机与 CI secret）
 *
 * 与热更密钥是两套独立密钥：换授权密钥不会影响已发出的热更包，反之亦然。
 * 一旦发布过带某把公钥的安装包，就不能再换公钥 —— 老壳只认旧钥匙。
 *
 * 用法：node scripts/license-keygen.mjs [--force]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pubPath = path.join(root, 'server', 'license-public.pem');
const privPath = path.join(root, '.license-private.pem');

if (fs.existsSync(pubPath) && !process.argv.includes('--force')) {
  console.log('[license] 已存在公钥，未覆盖：', pubPath);
  console.log('[license] 确需重来加 --force —— 已发布安装包里写死的是旧公钥，新钥匙签的授权码它们不认');
  process.exit(0);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(pubPath), { recursive: true });
fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

console.log('[license] 公钥 →', pubPath, '（随安装包发布，可提交）');
console.log('[license] 私钥 →', privPath, '（绝不入库；备份到密码管理器 / U 盘）');
console.log('[license] 下一步：');
console.log('  1. 用户打开「设置 → 授权」，把机器码发给你');
console.log('  2. node scripts/license-issue.mjs --machine <机器码> --days 365 --note <买家邮箱>');
console.log('  3. 把生成的激活码发给用户，在「设置 → 授权」里粘贴激活');
