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
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['electron', 'server'];
const BACKUP_ROOT = path.join(ROOT, '.obfuscate-backup');
/** 授权验签相关的文件额外做字符串加密、控制流混淆，抬高静态分析成本 */
const SENSITIVE = new Set(['server/lib/license.js', 'server/lib/license-core.js']);

const OBFUSCATOR_OPTIONS = {
  target: 'node',
  sourceType: 'module',
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  stringArray: true,
  stringArrayThreshold: 0.9,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  selfDefending: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.35,
  deadCodeInjection: false,
  debugProtection: false,
  unicodeEscapeSequence: false,
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = path.join(BACKUP_ROOT, stamp);
const RELEASE_DIR = path.join(ROOT, 'release-build');
const UNPACKED_DIR = path.join(RELEASE_DIR, 'win-unpacked');

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
      // .cjs 必须原样保留，不能过 esbuild 的 format:'esm'：
      // 1) 它会把 `module.exports = {...}` 包成只有 default 导出的 ESM，主进程
      //    `import { tf } from './i18n-main.cjs'` 在安装后直接抛
      //    "does not provide an export named 'tf'"（开发时不混淆所以看不出来）。
      // 2) Electron 的 preload 脚本也必须是真正的 CommonJS，转成 ESM 后加载失败。
      // 这两个文件都是小字典/桥接层，混淆收益几乎为零，跳过最稳。
      if (file.endsWith('.cjs')) continue;
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = fs.readFileSync(file, 'utf8');
      const result = await transform(code, {
        loader: 'js',
        format: 'esm',
        target: 'node22',
        minify: true,
        legalComments: 'none',
        sourcefile: rel,
      });
      let output = result.code;
      if (SENSITIVE.has(rel)) {
        output = JavaScriptObfuscator.obfuscate(output, OBFUSCATOR_OPTIONS).getObfuscatedCode();
      }
      fs.writeFileSync(file, output, 'utf8');
      count++;
    }
  }
  console.log(`[secure] 已混淆 ${count} 个文件；源码备份：${backupDir}`);
  verifyCjsUntouched();
}

/**
 * CJS 自检：esbuild 的 format:'esm' 会把 `module.exports = {...}` 改成只有 default
 * 导出的包装模块，主进程的具名 import / Electron preload 都会在启动瞬间失败。
 * 这里逐一比对混淆前后的 .cjs 字节，确保它们永远原样进包。
 */
function verifyCjsUntouched() {
  for (const target of TARGETS) {
    const backupTarget = path.join(backupDir, target);
    if (!fs.existsSync(backupTarget)) continue;
    const liveDir = path.join(ROOT, target);
    for (const file of walk(liveDir).filter((f) => f.endsWith('.cjs'))) {
      const rel = path.relative(liveDir, file);
      const before = fs.readFileSync(path.join(backupTarget, rel), 'utf8');
      const after = fs.readFileSync(file, 'utf8');
      if (before !== after) {
        throw new Error(`[secure] CommonJS 文件被改写：${rel}；CJS→ESM 会丢掉具名导出，安装后会无法启动`);
      }
    }
  }
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

/**
 * 清理 electron-builder 的中间目录 win-unpacked。
 *
 * Windows 上这个目录里的 app.asar 经常被别的进程短暂占用（杀毒扫描、刚装过的
 * 应用在跑、甚至编辑器把它当文本打开）。electron-builder 自己只会 unlink 一次，
 * 撞上就 EBUSY 整个打包失败（见用户报的 "unlink ... app.asar"）。
 * 这里先带退避重试；实在删不掉就换一个全新的输出目录，不打断打包。
 *
 * @returns {Promise<string|null>} 备用输出目录（相对 ROOT），null = 用默认 release-build
 */
async function prepareOutput() {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.rmSync(UNPACKED_DIR, { recursive: true, force: true });
      return null;
    } catch (err) {
      // 不存在也算清理成功；EBUSY/EPERM 才重试
      if (err?.code === 'ENOENT') return null;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(err?.code)) throw err;
      await delay(500);
    }
  }
  // 注意不能只在仓库里换个目录名：占用者往往是编辑器/索引器，
  // 它会继续盯着 E:\youyouvault 下新建的 app.asar，照样 EPERM。
  // 放到系统临时目录（工作区之外）才真正绕开。
  const fallback = path.join(os.tmpdir(), `tuku-build-${stamp}`);
  console.warn(`[secure] win-unpacked 仍被占用，改用系统临时目录：${fallback}`);
  return fallback;
}

/** 备用目录打出来的安装包 copy 回 release-build，发布脚本/文档里的路径不用改 */
function collectArtifacts(outputDir) {
  const from = path.isAbsolute(outputDir) ? outputDir : path.join(ROOT, outputDir);
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (!/\.(exe|blockmap|yml|yaml|dll)$/i.test(name)) continue;
    const src = path.join(from, name);
    // 旧文件可能同样被占用；copy 失败只警告，安装包本身已经成功产出
    try {
      fs.copyFileSync(src, path.join(RELEASE_DIR, name));
      console.log(`[secure] 已归集安装包：${name}`);
    } catch (err) {
      console.warn(`[secure] 复制 ${name} 失败（可手动从 ${outputDir} 取）：${err.message}`);
    }
  }
  try {
    fs.rmSync(from, { recursive: true, force: true });
  } catch {
    /* 临时目录没删掉不影响安装包 */
  }
}

function runBuild(outputDir) {
  return new Promise((resolve, reject) => {
    const args = ['run', 'dist', '--', '--publish', 'never'];
    if (outputDir) args.push(`--config.directories.output=${outputDir.replace(/\\/g, '/')}`);
    // Windows 下 npm 是 .cmd，Node 18.20+ 禁止无 shell 直接 spawn（EINVAL）。
    // 优先用 node 直接执行 npm-cli.js，找不到再退回 shell。
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const useCli = fs.existsSync(npmCli);
    const cmd = useCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(cmd, useCli ? [npmCli, ...args] : args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
      shell: useCli ? false : true,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`打包失败，退出码 ${code}`))));
    child.on('error', reject);
  });
}

const skip = /^(1|true|on)$/i.test(String(process.env.TUKU_SKIP_OBFUSCATE || '')) || process.argv.includes('--debug');
if (skip) {
  console.log('[secure] TUKU_SKIP_OBFUSCATE=1：本次为调试包，不做混淆');
  const outputDir = await prepareOutput();
  try {
    await runBuild(outputDir);
    if (outputDir) collectArtifacts(outputDir);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else {
  await obfuscate();
  let outputDir;
  try {
    outputDir = await prepareOutput();
    await runBuild(outputDir);
    if (outputDir) collectArtifacts(outputDir);
  } finally {
    restore();
  }
}
