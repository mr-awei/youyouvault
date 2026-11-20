#!/usr/bin/env node
/**
 * 安全打包：先把 electron/ 与 server/ 的 JS 混淆压缩，再跑 electron-builder，
 * 最后无论成功失败都从 .obfuscate-backup 还原源码。
 *
 * 用法：
 *   npm run dist:secure                 # 混淆 + 打包，结束后自动还原
 *   TUKU_SKIP_OBFUSCATE=1 npm run dist  # 调试包：不混淆
 *
 * 说明：客户端代码不可能做到“绝对不可逆”。这里做的是标识符压缩/语法压缩，
 * 逆向看到的是压缩后的代码；真正的调试用源码在 .obfuscate-backup 里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['electron', 'server'];
const BACKUP_ROOT = path.join(ROOT, '.obfuscate-backup');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = path.join(BACKUP_ROOT, stamp);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.(js|mjs|cjs)$/i.test(e.name)) out.push(p);
  }
  return out;
}

async function obfuscate() {
  fs.mkdirSync(backupDir, { recursive: true });
  let count = 0;
  for (const target of TARGETS) {
    const src = path.join(ROOT, target);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(backupDir, target), { recursive: true });
    for (const file of walk(src)) {
      const code = fs.readFileSync(file, 'utf8');
      const result = await transform(code, {
        loader: 'js',
        format: 'esm',
        target: 'node22',
        minify: true,
        legalComments: 'none',
        sourcefile: path.relative(ROOT, file),
      });
      fs.writeFileSync(file, result.code, 'utf8');
      count++;
    }
  }
  console.log(`[secure] 已混淆 ${count} 个文件；源码备份：${backupDir}`);
}

function restore() {
  for (const target of TARGETS) {
    const src = path.join(backupDir, target);
    const dst = path.join(ROOT, target);
    if (!fs.existsSync(src)) continue;
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
  }
  console.log('[secure] 已还原源码');
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['run', 'dist', '--', '--publish', 'never'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`打包失败，退出码 ${code}`))));
    child.on('error', reject);
  });
}

const skip = /^(1|true|on)$/i.test(String(process.env.TUKU_SKIP_OBFUSCATE || '')) || process.argv.includes('--debug');
if (skip) {
  console.log('[secure] TUKU_SKIP_OBFUSCATE=1：本次为调试包，不做混淆');
  runBuild().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else {
  await obfuscate();
  try {
    await runBuild();
  } finally {
    restore();
  }
}
