#!/usr/bin/env node
/**
 * 如果安全打包被中断，源码停在混淆状态，用这个脚本从 .obfuscate-backup 还原。
 * 用法：npm run obfuscate:restore
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_ROOT = path.join(ROOT, '.obfuscate-backup');
const targets = ['electron', 'server'];

const dirs = fs.existsSync(BACKUP_ROOT)
  ? fs
      .readdirSync(BACKUP_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];
if (!dirs.length) {
  console.error('[restore] 没有找到 .obfuscate-backup/*');
  process.exit(1);
}
const latest = path.join(BACKUP_ROOT, dirs[dirs.length - 1]);
for (const target of targets) {
  const src = path.join(latest, target);
  const dst = path.join(ROOT, target);
  if (!fs.existsSync(src)) continue;
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`[restore] ${target} ← ${src}`);
}
console.log('[restore] 完成');
