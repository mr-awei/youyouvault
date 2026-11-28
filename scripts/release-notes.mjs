#!/usr/bin/env node
/**
 * 生成 Release 说明（release-build/release-body.md）。
 *
 * 内容固定包含：版本与构建信息、安装包 SHA256、安装步骤、未签名说明、本次更新摘要。
 * 交给 CI 的 action-gh-release 用 body_path 读取 —— 说明不再在 workflow 里手拼，
 * 本地发版和 CI 发版用的是同一份模板，不会一边写了哈希一边忘了写。
 *
 * 用法：node scripts/release-notes.mjs
 * 依赖：release-build/SHA256SUMS.txt（先跑 scripts/gen-checksums.mjs）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, 'release-build');
const SUMS = path.join(BUILD_DIR, 'SHA256SUMS.txt');
const OUT = path.join(BUILD_DIR, 'release-body.md');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version || '');

if (!fs.existsSync(SUMS)) {
  console.error('[notes] 缺少 release-build/SHA256SUMS.txt，请先运行 node scripts/gen-checksums.mjs');
  process.exit(1);
}

const sums = fs
  .readFileSync(SUMS, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const m = /^([a-f0-9]{64})\s{2}(.+)$/i.exec(line.trim());
    return m ? { hash: m[1].toLowerCase(), name: m[2] } : null;
  })
  .filter(Boolean);

if (!sums.length) {
  console.error('[notes] SHA256SUMS.txt 里没有可解析的行');
  process.exit(1);
}

const sizeOf = (name) => {
  try {
    const bytes = fs.statSync(path.join(BUILD_DIR, name)).size;
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
  } catch {
    return '—';
  }
};

const sha = (process.env.GITHUB_SHA || '').slice(0, 7);
const refName = process.env.GITHUB_REF_NAME || `v${version}`;
const builtAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

/** 上次发版以来的提交摘要；浅克隆 / 没有上一个 tag 时安静跳过 */
function changelog() {
  try {
    const prev = execFileSync('git', ['describe', '--tags', '--abbrev=0', 'HEAD^'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const log = execFileSync(
      'git',
      ['log', '--no-merges', '--pretty=format:%s%x01%b%x02', `${prev}..HEAD`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    ).trim();
    if (!log) return '';
    // 标题一行，提交正文里的「- 条目」缩进成子项：发版说明比一串 commit 标题好读得多
    // %x01 分隔标题与正文、%x02 分隔提交 —— 少一个分隔符，正文第一段就会被当成下一条标题
    const lines = [];
    for (const block of log.split('\u0002')) {
      const [subjectRaw, bodyRaw = ''] = block.split('\u0001');
      const subject = (subjectRaw || '').trim();
      if (!subject) continue;
      lines.push(`- ${subject}`);
      for (const line of bodyRaw.split(/\r?\n/)) {
        const text = line.trim();
        if (text.startsWith('- ')) lines.push(`  ${text}`);
      }
    }
    const clipped = lines.slice(0, 40);
    return `\n### 本次更新（${prev} → ${refName}）\n\n${clipped.join('\n')}${lines.length > 40 ? `\n- … 另有 ${lines.length - 40} 条变动，见 commit 记录` : ''}\n`;
  } catch {
    return '';
  }
}

const rows = sums
  .map((s) => `| \`${s.name}\` | ${sizeOf(s.name)} | \`${s.hash}\` |`)
  .join('\n');

const installer = sums.find((s) => /\.exe$/i.test(s.name))?.name || `TuKu-Setup-${version}.exe`;

const body = `## 图库 TuKu v${version}

本地优先的图片 / 素材管理器：原图留在自己硬盘，索引、标签、评分、笔记都在本地，不注册账号、不上传云端。

- **构建提交**：${sha || '（本地构建）'}
- **构建时间**：${builtAt}（UTC+8）
- **系统要求**：Windows 10 / 11（x64）；运行时随包内置，无需另装 Node

### 下载与校验

| 文件 | 大小 | SHA256 |
| --- | --- | --- |
${rows}

下载后用系统自带命令核对安装包（PowerShell）：

\`\`\`powershell
certutil -hashfile .\\${installer} SHA256
\`\`\`

输出必须与上表一致。**不一致说明文件被篡改或下载不完整，请勿安装，重新从本页面下载。**

### 安装

1. 双击 \`${installer}\`，按向导选择安装目录（默认装在当前用户目录，不需要管理员权限）；
2. 首次启动选择一个素材文件夹建库，原文件不会被移动或改名；
3. 库数据写在素材目录的 \`.tuku\` 下，换机器时连同素材一起拷走就能带走整个库。

### 未签名说明

本版本**没有购买 Windows 代码签名证书**，exe 属性里看不到可信发布者，360 / 火绒 / Defender 可能提示「未知发布者 / 可疑程序」。这是未签名程序的常见情况，不代表文件有问题：

- 以上表的 SHA256 作为唯一凭据，核对一致即可放心安装；
- 被安全软件拦截时选择「仍要运行 / 允许本次操作」，并把安装目录加入信任列表；
- 若某个功能报错、或设置页提示「文件缺失」，去 **设置 → 维护 → 软件完整性** 点「立即校验」：会列出被隔离的文件，并可用已签名的增量补丁补回；
- 欢迎把误报提交给安全软件厂商，后续版本能更快脱离拦截名单。
${changelog()}
### 更新方式

- 安装版在后台静默检查更新，下载完成后才提示「立即安装并重启 / 下次打开时安装」；
- 只改了前端或服务端的补丁会走热更通道，不必重新下载安装包；
- 更新不会改动素材目录里的原图与 \`.tuku\` 库数据。
`;

fs.writeFileSync(OUT, body, 'utf8');
console.log(`[notes] 已生成 ${path.relative(ROOT, OUT)}（${sums.length} 个产物）`);
