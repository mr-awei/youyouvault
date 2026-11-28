#!/usr/bin/env node
/**
 * electron-builder 的薄封装。
 *
 * 存在的理由只有一个：`npm run dist -- <参数>` 会把参数追加到整个脚本链末尾，
 * 而 dist 里 electron-builder 后面还要跑「算 SHA256」「写 Release 说明」，
 * 参数就落到了最后一条命令上 —— electron-builder 收不到 `--publish never`，
 * CI 里会拿着 GH_TOKEN 自己去发布，然后整包构建失败。
 *
 * 所以 publish 与输出目录都从这里读：publish 固定 never，
 * 输出目录由 TUKU_BUILD_DIR 注入（dist:secure 在 win-unpacked 被占用时换目录用）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');

const args = [CLI, '--publish', 'never'];
const outDir = String(process.env.TUKU_BUILD_DIR || '').trim();
if (outDir) args.push(`--config.directories.output=${outDir.replace(/\\/g, '/')}`);

const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`[builder] 启动失败：${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`[builder] 被信号 ${signal} 终止`);
  process.exit(code ?? 1);
});
