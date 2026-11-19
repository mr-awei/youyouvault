// @ts-check
/**
 * 生成应用图标（窗口/任务栏/托盘/安装包）。
 *
 * 设计约束（2026-11 重画，替换原来的粉紫相片标）：
 * - 橙底白字「优」：与界面主色一致，一眼能认出是同一个产品；
 * - 一个圆角方块 + 一个字，没有渐变叠层，16px 任务栏尺寸下也不会糊成色块；
 * - 字形用系统中文字体（微软雅黑 / 苹方 / Noto），保证 sharp 渲染时不出空字。
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');
fs.mkdirSync(OUT, { recursive: true });

const ICO_SIZES = [256, 128, 64, 48, 32, 16];

/** 品牌橙：与 base.css 的 --accent 同一取值 */
const ORANGE = '#f97316';

/** @param {number} s 输出尺寸（坐标始终在 512 视口里） */
function svg(s) {
  return `<svg width="${s}" height="${s}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="116" fill="${ORANGE}"/>
  <text x="256" y="358" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC','Noto Sans CJK SC',sans-serif" font-size="320" font-weight="700" fill="#ffffff" text-anchor="middle">优</text>
</svg>`;
}

/** @param {number} size */
async function pngBuffer(size) {
  return sharp(Buffer.from(svg(size)), { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// 窗口与网页用的大图
fs.writeFileSync(path.join(OUT, 'icon.png'), await pngBuffer(512));

// 多尺寸 ICO（直接内嵌 PNG，Windows Vista+ 支持）
/** @param {number[]} sizes */
async function buildIco(sizes) {
  const images = [];
  for (const s of sizes) images.push(await pngBuffer(s));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const dirEntries = [];
  for (let i = 0; i < images.length; i++) {
    const data = images[i];
    const size = sizes[i];
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // colors
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8); // bytes in res
    e.writeUInt32LE(offset, 12); // image offset
    offset += data.length;
    dirEntries.push(e);
  }
  return Buffer.concat([header, ...dirEntries, ...images]);
}

const ico = await buildIco(ICO_SIZES);
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);

// 网页图标（favicon 与界面左上角 logo 同源）
fs.mkdirSync(path.join(ROOT, 'web', 'public'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'web', 'public', 'icon.png'), await pngBuffer(512));

console.log('icon.png 512');
console.log('icon.ico', ico.length, 'bytes,', ICO_SIZES.length, 'sizes:', ICO_SIZES.join(','));
console.log('web/public/icon.png 512');
