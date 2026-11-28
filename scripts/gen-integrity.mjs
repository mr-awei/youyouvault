/**
 * 生成软件完整性清单：server/** 与 dist/web/** 的 sha256。
 *
 * 为什么要它：用户机器上的 360 / 火绒 / Defender 有时会把某个 .js 当成威胁隔离掉，
 * 或者磁盘/断电把文件写坏。表现是「软件能启动但某个功能莫名其妙报错」，
 * 用户完全不知道是文件没了。启动时按这份清单自检，就能明确说出「哪几个文件缺失」，
 * 并且优先用已签名的热更包静默补齐（补不上的才提示重新运行安装包）。
 *
 * 用法：node scripts/gen-integrity.mjs
 * 时机：vite build 之后、electron-builder 之前（在 dist / dist:secure 里串上）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'electron', 'integrity-manifest.json');

/** 只收运行时会读的文件：源码目录里的 md / 测试 / 日志不算（也不该因为它们报错） */
const SKIP_EXT = new Set(['.md', '.map', '.log', '.ts', '.tsbuildinfo']);

function walk(dir, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(abs, base, out);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (SKIP_EXT.has(ext)) continue;
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    out.push({ abs, rel });
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const files = [];
walk(path.join(ROOT, 'server'), ROOT, files);
walk(path.join(ROOT, 'dist', 'web'), path.join(ROOT, 'dist'), files); // dist/web/x → web/x

const entries = [];
let total = 0;
for (const f of files) {
  let st;
  try {
    st = fs.statSync(f.abs);
  } catch {
    continue;
  }
  if (!st.isFile() || st.size === 0) continue;
  const buf = fs.readFileSync(f.abs);
  entries.push({ path: f.rel, size: st.size, sha256: sha256(buf) });
  total += st.size;
}
entries.sort((a, b) => (a.path < b.path ? -1 : 1));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = {
  version: String(pkg.version || ''),
  generatedAt: new Date().toISOString(),
  note: 'server/** 与 dist/web/**（映射为 web/**）的 sha256；由 scripts/gen-integrity.mjs 生成',
  files: entries,
};
fs.writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[integrity] ${entries.length} 个文件 · ${(total / 1024 / 1024).toFixed(1)} MB → ${path.relative(ROOT, OUT)}`);
