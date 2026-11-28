#!/usr/bin/env node
/**
 * 计算发布产物的 SHA256 → release-build/SHA256SUMS.txt
 *
 * 为什么要单独一步：没有代码签名证书时，「下载到的东西是不是你发布的那份」只能靠哈希核对。
 * CI 会把这个文件的内容原样贴进 Release 说明，用户下载后 certutil / sha256sum 一比就知道。
 *
 * 只算用户真正下载的文件：安装包、增量更新清单、blockmap；
 * 目录里没有产物时直接失败 —— 空清单贴进 Release 比没有更糟。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'release-build');
const OUT = path.join(OUT_DIR, 'SHA256SUMS.txt');

/** 本机可能残留上一个版本的安装包，只对当前版本出清单 */
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/** 更新清单由 electron-builder 每次覆盖，不参与版本过滤 */
const LATEST = /^latest\.ya?ml$/i;
/** 需要核对哈希的产物（顺序即输出顺序） */
const WANTED = [/\.exe$/i, /\.blockmap$/i, LATEST];
/** 中间目录里的同名文件不是发布物 */
const SKIP_DIRS = new Set(['win-unpacked', 'mac', 'linux-unpacked', 'license-admin', 'hotfix']);

/** @param {string} file */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const files = [];
for (const entry of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (SKIP_DIRS.has(entry.name)) continue;
  if (!WANTED.some((re) => re.test(entry.name))) continue;
  // 安装包与 blockmap 必须带当前版本号；latest.yml 由本次构建覆盖，直接收
  if (!LATEST.test(entry.name) && !entry.name.includes(VERSION)) continue;
  files.push(entry.name);
}
files.sort();

if (!files.length) {
  console.error(`[checksums] ${path.relative(ROOT, OUT_DIR)} 下没有找到安装包（*.exe），无法生成校验清单`);
  process.exit(1);
}

const rows = [];
for (const name of files) {
  const abs = path.join(OUT_DIR, name);
  const size = fs.statSync(abs).size;
  const hash = await sha256File(abs);
  rows.push({ name, size, hash });
}

// 采用 sha256sum 的格式（hash + 两个空格 + 文件名），Linux/macOS 可直接 -c 校验
fs.writeFileSync(OUT, rows.map((r) => `${r.hash}  ${r.name}`).join('\n') + '\n', 'utf8');

for (const r of rows) {
  console.log(`[checksums] ${r.name}  ${fmtSize(r.size)}  ${r.hash}`);
}
console.log(`[checksums] 已写入 ${path.relative(ROOT, OUT)}`);
