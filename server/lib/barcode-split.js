// @ts-check
/**
 * 拍摄流程第一段：从一堆拍摄原图里按「条码照片」切出产品分组。
 *
 * 现场约定：摄影师随手建一个文件夹，把当天所有照片都丢进去；每拍完一个产品，
 * 先拍一张黄色送货单（条码），再拍这个产品。因此：
 *   - 大片黄色的照片 = 条码照片；
 *   - 两张条码照片之间的照片 = 前一张条码对应的产品；
 *   - 条码照片本身不属于任何产品，不进入产品文件夹。
 *
 * 这里只做「读目录 + 判黄 + OCR + 分组 + 建议日期」，不落盘、不移动原图；
 * 真正复制由 routes/barcode.js 完成，方便单测与失败重试。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import zxing from '@zxing/library';
import { parseExif } from './exif.js';
import { ocrImage } from './ocr.js';

const { MultiFormatReader, RGBLuminanceSource, BinaryBitmap, HybridBinarizer, DecodeHintType, BarcodeFormat } =
  zxing;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif']);

/** 面单上常见一维码：Code128 为主，其余一并交给 zxing 尝试 */
const DECODE_HINTS = new Map();
DECODE_HINTS.set(DecodeHintType.TRY_HARDER, true);
DECODE_HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.ITF,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
]);

/** 自然排序：MG_2 排在 MG_10 前面，中文目录名也按拼音稳定比较 */
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function naturalCompare(a, b) {
  return collator.compare(String(a ?? ''), String(b ?? ''));
}

export function naturalSort(list) {
  return [...list].sort(naturalCompare);
}

/** 全角 → 半角；OCR 对数字/字母常输出全角字符 */
function toHalfWidth(text) {
  return String(text || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/**
 * 从 OCR 文本里解析编码。
 * 优先级：完整编码（45661-Y01Y0001-QD08）> 主 SKU > 送货单上的独立 5 位数字 > PO 号（仅候选）。
 *
 * 现场送货单上通常只印 PO 号和主 SKU，完整编码不在单子上；而且系统 OCR 很容易把
 * 「主 SKU」认成 `=SKIJ` / `±SKIJ`，把 PO 的 O 认成 0。所以这里不能只认字面量：
 * 先按标签找，再退回「4–6 位独立数字」——送货单上那一串就是主 SKU。
 */
export function parseBarcodeText(raw, barcodeText = '') {
  const rawText = String(raw || '');
  const text = toHalfWidth(rawText).toUpperCase();
  // OCR 常在连字符两侧断词（45661 - Y01Y0001 - QD08），压缩空白后再匹配
  const compact = text.replace(/\s+/g, '');
  // 一维码解码结果才是「面单上没直接展示的 SKU」最可靠的来源
  const barcode = toHalfWidth(barcodeText).replace(/\s+/g, '').toUpperCase();
  const barcodeIsPo = /^P[0O]\d{8,}$/.test(barcode);

  const codeRe = /\b\d{4,6}(?:-[A-Z0-9]{2,}){2,}\b/;
  // 主 SKU 标签：主/MAIN 可选；SKU 常被认成 SKIJ / 5KU / SK1J
  const skuRe = /(?:主|MAIN)?\s*S\s*K\s*[UIJ1|]\s*[:：]?\s*([0-9][0-9A-Z-]{3,})/;
  // PO 号：字母 O 与数字 0 常混
  const poRe = /\bP\s*[0O]\s*\d{8,}\b/;
  // 独立数字（前后都不是字母/数字）：排除 PO 的长数字串与日期里的两位数字
  const numericRe = /(?<![0-9A-Z])(\d{4,6})(?![0-9A-Z])/g;

  const codeMatch = text.match(codeRe) || compact.match(codeRe);
  const skuMatch = text.match(skuRe) || compact.match(skuRe);
  const poMatch = text.match(poRe) || compact.match(poRe);
  const numerics = [...text.matchAll(numericRe)].map((m) => m[1]);

  const candidates = [];
  const add = (v) => {
    const s = String(v || '').replace(/\s+/g, '').trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  // PO 条码不是产品编码，只做展示，不进候选
  if (barcode && !barcodeIsPo) add(barcode);
  add(codeMatch?.[0]);
  add(skuMatch?.[1]);
  for (const n of numerics.slice(0, 3)) add(n);
  add(poMatch?.[0]);

  const code =
    (barcode && !barcodeIsPo ? barcode : '') || codeMatch?.[0] || skuMatch?.[1] || numerics[0] || '';
  return {
    code,
    candidates,
    rawText,
    barcodeText: barcode,
    /** barcode = 一维码内容；full = 完整编码；sku/number = 只有主 SKU，完整编码还需人工补 */
    codeSource: barcode && !barcodeIsPo ? 'barcode' : codeMatch?.[0] ? 'full' : code ? 'sku' : '',
  };
}

/**
 * 按条码照片切组。entries 必须已按拍摄顺序排好：
 * [{ name, isBarcode, code?, candidates?, rawText?, ocrError? }]
 */
export function groupFiles(entries) {
  const groups = [];
  const ungrouped = [];
  const warnings = [];
  let current = null;

  for (const e of entries) {
    const name = String(e?.name || '');
    if (e?.isBarcode) {
      if (current && current.files.length === 0) {
        current.warnings.push({ code: 'consecutive', text: '连续出现两张条码，这一组没有产品图' });
        warnings.push({ code: 'consecutive', text: `「${current.barcodeFile}」与下一张条码连续，中间没有产品图` });
      }
      current = {
        code: String(e.code || ''),
        candidates: Array.isArray(e.candidates) ? [...e.candidates] : [],
        rawText: String(e.rawText || ''),
        barcodeText: String(e.barcodeText || ''),
        barcodeFile: name,
        files: [],
        warnings: [],
      };
      if (e.ocrError) current.warnings.push({ code: 'ocr', text: `条码识别失败：${e.ocrError}` });
      if (!current.code) current.warnings.push({ code: 'noCode', text: '没有识别到编码，请手动填写或跳过' });
      // 「只识别到主 SKU」不再在这里提示：前端会先查 OMS，拿到完整编码就不提示；
      // 真查不到时再由前端给出更显眼的补全提示。
      groups.push(current);
    } else if (current) {
      current.files.push(name);
    } else {
      // 第一张条码之前的照片：不知道属于谁，单独列出来让用户处理
      ungrouped.push(name);
    }
  }

  for (const g of groups) {
    if (!g.files.length && !g.warnings.some((w) => w.code === 'consecutive')) {
      g.warnings.push({ code: 'empty', text: '这一组没有产品图' });
    }
  }
  return { groups, ungrouped, warnings };
}

/** 同批重复编码提示（实际加后缀发生在复制阶段，因为用户可能中途改编码） */
export function markDuplicates(groups) {
  const seen = new Map();
  groups.forEach((g, i) => {
    const key = String(g.code || '').trim().toLowerCase();
    if (!key) return;
    if (seen.has(key)) {
      g.warnings.push({
        code: 'duplicate',
        text: `与第 ${seen.get(key) + 1} 组编码相同，复制时会自动加后缀`,
      });
    } else {
      seen.set(key, i);
    }
  });
}

/** 编码 → 可安全用作文件夹名的字符串；非法字符换成 -，空串表示不能建文件夹 */
export function safeCodeName(code) {
  return String(code ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim()
    .replace(/[.\s]+$/g, '');
}

/** 递归列图：只认位图后缀，跳过隐藏目录与 node_modules；按相对路径自然排序 */
export async function collectImages(dir) {
  const out = [];
  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = e.name;
      if (name.startsWith('.')) continue;
      const abs = path.join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      if (e.isDirectory()) {
        if (name === 'node_modules') continue;
        await walk(abs, rel);
      } else if (e.isFile() && IMAGE_EXTS.has(path.extname(name).toLowerCase())) {
        out.push({ abs, rel });
      }
    }
  }
  await walk(dir, '');
  out.sort((a, b) => naturalCompare(a.rel, b.rel));
  return out;
}

/**
 * 黄色送货单 = 条码照片。缩到 64px 只统计比例，避免整图解码。
 *
 * 现场面单经常是浅黄 / 过曝的黄，蓝色通道会跑到 120~150；旧阈值要求 b < 100，
 * 结果一张占画面 30% 的黄色面单只算出 1.3%，被判成产品图（整组多分/漏分）。
 * 这里放宽到「浅黄」：r/g 明显高于 b，且 r、g 都足够亮；比例阈值取 8%，
 * 实测产品图（白底、蓝盒、金属件）都接近 0%，不会误判。
 */
export async function isBarcodeImage(abs) {
  const { data, info } = await sharp(abs, { failOn: 'none' })
    .rotate()
    .resize(64, 64, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let yellow = 0;
  let total = 0;
  for (let i = 0; i + channels <= data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    total++;
    if (r > 160 && g > 140 && b < 200 && r - b > 40 && g - b > 25 && r >= g - 15) yellow++;
  }
  return total > 0 && yellow / total >= 0.08;
}

function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 第一张条码的 EXIF 拍摄日期；读不到退回文件修改时间 */
async function suggestDate(abs, fallbackAbs) {
  for (const target of [abs, fallbackAbs]) {
    if (!target) continue;
    try {
      const meta = await sharp(target, { failOn: 'none' }).metadata();
      const exif = meta?.exif ? parseExif(meta.exif) : null;
      const raw = String(exif?.takenAt || exif?.modified || '');
      const m = raw.match(/^(\d{4})[:/-](\d{2})[:/-](\d{2})/);
      if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, source: 'exif' };
    } catch {
      /* 读不到 EXIF 不是错误 */
    }
    try {
      const st = await fsp.stat(target);
      return { date: localDate(st.mtime), source: 'mtime' };
    } catch {
      /* 试下一个 */
    }
  }
  return { date: localDate(new Date()), source: 'mtime' };
}

/** 并发限流：判黄可以快，OCR 要控住进程数 */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    })
  );
}

let quietDepth = 0;
let originalWarn = console.warn;

/** zxing 每次未命中都会 console.warn 整段堆栈，扫码时临时静音（并发用计数避免互相踩） */
function quietly(fn) {
  if (quietDepth++ === 0) {
    originalWarn = console.warn;
    console.warn = () => {};
  }
  try {
    return fn();
  } finally {
    if (--quietDepth === 0) console.warn = originalWarn;
  }
}

/**
 * 解码面单一维码（Code128 为主）。
 * 条码只占画面一部分，直接扫整图经常找不到起点，所以先灰度 + 二值化再交给 zxing；
 * 阈值 130/150/170 覆盖偏暗 / 正常 / 偏亮；仍失败再换 90° 方向（竖拍的照片）。
 */
export async function decodeBarcodeImage(abs) {
  for (const angle of [0, 90, 180, 270]) {
    for (const threshold of [130, 150, 170]) {
      let raw;
      try {
        raw = await sharp(abs, { failOn: 'none' })
          .rotate(angle)
          .greyscale()
          .threshold(threshold)
          .resize(1800, 1800, { fit: 'inside', withoutEnlargement: false })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
      } catch {
        continue;
      }
      const source = new RGBLuminanceSource(new Uint8ClampedArray(raw.data), raw.info.width, raw.info.height);
      const bitmap = new BinaryBitmap(new HybridBinarizer(source));
      try {
        const result = quietly(() => new MultiFormatReader().decode(bitmap, DECODE_HINTS));
        const text = String(result.getText() || '').trim();
        if (text) return { text, format: String(result.getBarcodeFormat()) };
      } catch {
        /* 换阈值 / 方向继续 */
      }
    }
  }
  return null;
}

/**
 * 读一张面单：一维码解码 + OCR 文字，两者互相补位。
 * Windows OCR 不认 EXIF 方向、小图识别率也差，所以先放大重编码；
 * 第一轮拿到编码就停，只有完全没编码时才继续换方向。
 */
async function readLabelPhoto(abs, lang) {
  let barcodeText = '';
  try {
    const bc = await decodeBarcodeImage(abs);
    if (bc) barcodeText = bc.text;
  } catch {
    /* 解码失败不阻塞 OCR */
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tuku-barcode-'));
  const base = path.join(tmpDir, 'shot');
  let bestText = '';
  try {
    for (const angle of [0, 90, 180, 270]) {
      const file = `${base}-${angle}.jpg`;
      try {
        await sharp(abs, { failOn: 'none' })
          .rotate(angle)
          .resize(2200, 2200, { fit: 'inside', withoutEnlargement: false })
          .jpeg({ quality: 92 })
          .toFile(file);
      } catch {
        continue;
      }
      let r;
      try {
        r = await ocrImage(file, { lang });
      } catch {
        r = { ok: false, text: '' };
      }
      await fsp.rm(file, { force: true });
      if (!r.ok) continue;
      const text = String(r.text || '');
      if (text.length > bestText.length) bestText = text;
      const parsed = parseBarcodeText(text, barcodeText);
      if (parsed.code) return parsed;
      // 第一轮已经读到像样的文字（只是没有编码）就不必再转方向
      if (text.trim().length > 8) break;
    }
    return parseBarcodeText(bestText, barcodeText);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 扫描一个拍摄目录。
 * @param {string} dir 绝对路径
 * @param {{lang?: string}} [opts]
 */
export async function scanDir(dir, { lang = '' } = {}) {
  const files = await collectImages(dir);
  const skipped = [];
  const entries = new Array(files.length);

  await mapLimit(files, 6, async (f, i) => {
    let barcode = false;
    let reason = '';
    try {
      barcode = await isBarcodeImage(f.abs);
    } catch (err) {
      reason = String(err instanceof Error ? err.message : err).slice(0, 160);
    }
    entries[i] = {
      name: f.rel,
      abs: f.abs,
      isBarcode: barcode,
      code: '',
      codeSource: '',
      candidates: [],
      rawText: '',
      barcodeText: '',
      ocrError: '',
    };
    if (reason) skipped.push({ file: f.rel, reason });
  });

  // 只对条码照片跑解码 + OCR：其余照片不需要，省下大量时间
  const barcodes = entries.filter((e) => e.isBarcode);
  await mapLimit(barcodes, 2, async (e) => {
    try {
      const parsed = await readLabelPhoto(e.abs, lang);
      e.code = parsed.code;
      e.codeSource = parsed.codeSource;
      e.candidates = parsed.candidates;
      e.rawText = parsed.rawText;
      e.barcodeText = parsed.barcodeText;
    } catch (err) {
      e.ocrError = String(err instanceof Error ? err.message : err);
    }
  });

  const grouped = groupFiles(entries);
  markDuplicates(grouped.groups);

  const { date, source } = await suggestDate(barcodes[0]?.abs, files[0]?.abs);
  return {
    dir,
    total: files.length,
    barcodeCount: barcodes.length,
    date,
    dateSource: source,
    groups: grouped.groups,
    ungrouped: grouped.ungrouped,
    warnings: grouped.warnings,
    skipped,
  };
}
