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

/**
 * 标签上一定有的字样；黄色产品包装不会有这些词。
 * 两种现场标签：
 *   - 白底送货单：拍照送货 / 送货单 / 主 SKU / PO 号
 *   - 黄色贴纸：SKU / PO / 中文名称 / 平台 / 座位（SKU 直接印完整编码，没有条码）
 */
const LABEL_TEXT_RE = /拍照送货|送货单|主\s*SKU|主SKU|中文名称|座位|PO\s*\d{8,}/i;

/** 完整编码（45661-Y01Y0001-QD08）本身就是强标签特征：条码可能拍不到，但编码会印在贴纸上 */
const FULL_CODE_RE = /\d{4,6}(?:-[A-Z0-9]{2,}){2,}/;

/** 4 位年份不是主 SKU：黄色贴纸上的日期会被 OCR 读成独立数字 */
function isYear(value) {
  return /^(19|20)\d{2}$/.test(String(value || ''));
}

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
  // 年份（2026）不能当成主 SKU，否则会拿日期去后台查
  const numerics = [...text.matchAll(numericRe)].map((m) => m[1]).filter((n) => !isYear(n));

  /**
   * 主 SKU 现场统一是 5 位。OCR 偶尔把 5 位读成 4 位（44124 → 4404），
   * 所以同一段文本里若另有 5 位数字，优先信 5 位，而不是标签后面紧跟的那个。
   */
  // 标签后面可能跟一串 PO 号或价格（77778666 这种 8 位数）：主 SKU 只可能是 4~6 位
  const rawLabeled = skuMatch?.[1] || '';
  const labeledSku = /^\d{4,6}$/.test(rawLabeled) || /^\d{4,6}-/.test(rawLabeled) ? rawLabeled : '';
  const fiveDigit = numerics.find((n) => n.length === 5);
  const primarySku =
    fiveDigit && labeledSku && labeledSku.length !== 5 ? fiveDigit : labeledSku || fiveDigit || numerics[0] || '';

  const candidates = [];
  const add = (v) => {
    const s = String(v || '').replace(/\s+/g, '').trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  // PO 条码不是产品编码，只做展示，不进候选
  if (barcode && !barcodeIsPo) add(barcode);
  add(codeMatch?.[0]);
  add(labeledSku);
  add(primarySku);
  for (const n of numerics.slice(0, 3)) add(n);
  add(poMatch?.[0]);

  const code = (barcode && !barcodeIsPo ? barcode : '') || codeMatch?.[0] || primarySku || '';
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
 * 多轮 OCR（常规 + 增强）结果里选最可信的一次。
 * 一维码 / 完整编码最可靠；否则优先 5 位主 SKU（44124 比 4 位的 4404 更可信），
 * 同长度时取后加入的增强轮。
 * @param {Array<ReturnType<typeof parseBarcodeText>>} list
 */
export function pickBestOcrParsed(list) {
  const all = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!all.length) return null;
  const strong = all.find((p) => p.codeSource === 'barcode' || p.codeSource === 'full');
  if (strong) return strong;
  const withCode = all.filter((p) => p.code);
  if (!withCode.length) return null;
  const five = withCode.filter((p) => p.code.length === 5);
  return five.length ? five[five.length - 1] : withCode[withCode.length - 1];
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

/** 同批重复编码提示（复制阶段会直接并进同一个文件夹，不再加后缀） */
export function markDuplicates(groups) {
  const seen = new Map();
  groups.forEach((g, i) => {
    const key = String(g.code || '').trim().toLowerCase();
    if (!key) return;
    if (seen.has(key)) {
      g.warnings.push({
        code: 'duplicate',
        text: `与第 ${seen.get(key) + 1} 组编码相同，照片会合并到同一个文件夹`,
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
 * 现场面单经常是浅黄 / 过曝的黄，也可能因为曝光不足偏暗；旧阈值要求 b < 100，
 * 结果一张占画面 30% 的黄色面单只算出 1.3%，被判成产品图（整组多分/漏分）。
 * 这里用两档：
 *   - 严格档：正常曝光下的浅黄；
 *   - 宽松档：偏暗 / 偏灰的黄色（r、g 仍明显高于 b）；
 * 白底产品图的黄色占比实测都 < 8%，所以阈值保持 8%，避免把暖白背景误判成面单。
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
    const strict = r > 160 && g > 140 && b < 200 && r - b > 40 && g - b > 25 && r >= g - 15;
    const relaxed = r > 110 && g > 95 && b < 210 && r - b > 28 && g - b > 16 && r >= g - 22;
    if (strict || relaxed) yellow++;
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
 * 条码只占画面一部分，直接扫整图经常找不到起点，所以先灰度再二值化再交给 zxing。
 * 现场照片曝光差异很大：
 *   - 过暗：整体亮度低，固定阈值会把条码和背景一起压黑；
 *   - 过亮：黄色面单接近纯白，固定阈值会把条码吃掉。
 * 因此每个方向先试「原始灰度」「对比度拉伸」，再试 7 档阈值（90~210）。
 * 图像预处理只在每个方向做一次，后面的变体在内存里生成，避免 30 多次 sharp 调用。
 */
export async function decodeBarcodeImage(abs) {
  for (const angle of [0, 90, 180, 270]) {
    let raw;
    try {
      raw = await sharp(abs, { failOn: 'none' })
        .rotate(angle)
        .greyscale()
        .resize(1800, 1800, { fit: 'inside', withoutEnlargement: false })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch {
      continue;
    }
    const variants = [
      { kind: 'normal' },
      { kind: 'stretch' },
      { kind: 'threshold', threshold: 130 },
      { kind: 'threshold', threshold: 150 },
      { kind: 'threshold', threshold: 110 },
      { kind: 'threshold', threshold: 170 },
      { kind: 'threshold', threshold: 90 },
      { kind: 'threshold', threshold: 190 },
      { kind: 'threshold', threshold: 210 },
    ];
    for (const v of variants) {
      const pixels = makeVariant(raw.data, v);
      const source = new RGBLuminanceSource(pixels, raw.info.width, raw.info.height);
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
 * 生成一个解码变体。data 是 sharp 输出的 RGBA 灰度图（R=G=B）。
 * @param {Buffer} data
 * @param {{ kind: string, threshold?: number }} v
 */
function makeVariant(data, v) {
  const out = new Uint8ClampedArray(data.length);
  if (v.kind === 'normal') {
    out.set(data);
    return out;
  }
  if (v.kind === 'stretch') {
    // 找 1%~99% 的亮度范围做拉伸，避免个别高光/阴影把对比度吃掉
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) hist[data[i]]++;
    const total = Math.floor(data.length / 4);
    const lowCut = total * 0.01;
    const highCut = total * 0.99;
    let acc = 0;
    let lo = 0;
    let hi = 255;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= lowCut) {
        lo = i;
        break;
      }
    }
    acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= highCut) {
        hi = i;
        break;
      }
    }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < data.length; i += 4) {
      const value = Math.max(0, Math.min(255, Math.round(((data[i] - lo) * 255) / span)));
      out[i] = out[i + 1] = out[i + 2] = value;
      out[i + 3] = 255;
    }
    return out;
  }
  const threshold = Number(v.threshold) || 128;
  for (let i = 0; i < data.length; i += 4) {
    const value = data[i] >= threshold ? 255 : 0;
    out[i] = out[i + 1] = out[i + 2] = value;
    out[i + 3] = 255;
  }
  return out;
}

/**
 * OCR 预处理三档：
 *   - base：常规彩色，2200px，速度快，适合字大、对焦准的面单；
 *   - sharp：灰度 + 自动对比 + 锐化，2800px。黄色贴纸上的主 SKU 字号很小，
 *     常规档经常把 44124 读成 404 / 4404；这一档在实测里能稳定读回 44124。
 *   - sharp2：3000px + 略强锐化，作为兜底；只有前两档都没拿到 5 位主 SKU 时才跑。
 * 结果统一交给 pickBestOcrParsed 择优，避免只靠某一档的偶然结果。
 */
const OCR_VARIANTS = [
  { tag: 'base', size: 2200, quality: 92, enhance: 'none' },
  { tag: 'sharp', size: 2800, quality: 95, enhance: 'default' },
  { tag: 'sharp2', size: 3000, quality: 95, enhance: 'sigma12', rescue: true },
];

/** 已经拿到 5 位主 SKU 时，不用再跑兜底档 */
function hasFiveDigitCode(list) {
  return list.some((p) => p?.code && p.code.length === 5);
}

/**
 * 读一张面单：一维码解码 + OCR 文字，两者互相补位。
 * Windows OCR 不认 EXIF 方向、小图识别率也差，所以先放大重编码；
 * 每个方向跑常规 + 增强两档（必要时再跑兜底档），拿到强结果就停。
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
  /** @type {Array<ReturnType<typeof parseBarcodeText>>} */
  const parsedList = [];
  try {
    for (const angle of [0, 90, 180, 270]) {
      for (const v of OCR_VARIANTS) {
        // 兜底档只在还没拿到 5 位主 SKU 时才跑，正常面单少一次 OCR
        if (v.rescue && hasFiveDigitCode(parsedList)) continue;
        const file = `${base}-${angle}-${v.tag}.jpg`;
        try {
          let pipe = sharp(abs, { failOn: 'none' })
            .rotate(angle)
            .resize(v.size, v.size, { fit: 'inside', withoutEnlargement: false });
          if (v.enhance === 'default') pipe = pipe.greyscale().normalise().sharpen();
          else if (v.enhance === 'sigma12') pipe = pipe.greyscale().normalise().sharpen({ sigma: 1.2 });
          await pipe.jpeg({ quality: v.quality }).toFile(file);
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
        parsedList.push(parsed);
        // 一维码 / 完整编码不需要再比，直接返回
        if (parsed.codeSource === 'barcode' || parsed.codeSource === 'full') return parsed;
      }
      const best = pickBestOcrParsed(parsedList);
      if (best) return best;
      // 这一方向已经读到像样的文字（只是没有编码）就不必再转方向
      if (bestText.trim().length > 8) break;
    }
    return pickBestOcrParsed(parsedList) || parseBarcodeText(bestText, barcodeText);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

/** 用户中途点了「停止扫描」 */
export class ScanCancelledError extends Error {
  constructor() {
    super('扫描已取消');
    this.name = 'ScanCancelledError';
  }
}

/**
 * 扫描一个拍摄目录。
 * @param {string} dir 绝对路径
 * @param {{lang?: string, onProgress?: (p: {phase: string, done: number, total: number}) => void, isCancelled?: () => boolean}} [opts]
 */
export async function scanDir(dir, { lang = '', onProgress, isCancelled } = {}) {
  const throwIfCancelled = () => {
    if (isCancelled?.()) throw new ScanCancelledError();
  };
  const files = await collectImages(dir);
  const skipped = [];
  const entries = new Array(files.length);
  let filtered = 0;
  onProgress?.({ phase: 'filter', done: 0, total: files.length });

  await mapLimit(files, 6, async (f, i) => {
    throwIfCancelled();
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
    filtered += 1;
    // 每 5 张报一次进度，避免几百张图刷屏
    if (filtered % 5 === 0 || filtered === files.length) {
      onProgress?.({ phase: 'filter', done: filtered, total: files.length });
    }
  });

  // 只对黄色候选跑解码 + OCR：其余照片不需要，省下大量时间。
  // 并发 3：OCR 是这条流程的主要耗时，2 路时 10 张面单要排好几轮。
  const candidates = entries.filter((e) => e.isBarcode);
  let ocrDone = 0;
  onProgress?.({ phase: 'ocr', done: 0, total: candidates.length });
  await mapLimit(candidates, 3, async (e) => {
    throwIfCancelled();
    try {
      const parsed = await readLabelPhoto(e.abs, lang);
      // OCR 常把空格/全角读乱，先归一化再判标签特征
      const normalized = toHalfWidth(parsed.rawText).toUpperCase().replace(/\s+/g, ' ');
      const compactText = normalized.replace(/\s+/g, '');
      const labelHint = LABEL_TEXT_RE.test(normalized) || FULL_CODE_RE.test(compactText);
      const decoded = !!parsed.barcodeText;
      /**
       * 必须有「明确的主 SKU」才算条码照片：5 位/4~6 位独立数字，或完整编码。
       * 黄色木雕、黄色包装盒这类照片也会过黄筛，OCR 常把包装上的长串数字
       * （77778666）读出来，之前会被当成编码开新组；这里只认 4~6 位。
       */
      const skuCode = String(parsed.code || '').trim();
      const hasSku =
        /^\d{4,6}(?:-|$)/.test(skuCode) ||
        (Array.isArray(parsed.candidates) && parsed.candidates.some((c) => /^\d{4,6}(?:-|$)/.test(String(c).trim())));
      // 黄色包装盒 / 黄色产品：既没有送货单字样，也没有 4~6 位主 SKU，退回产品图
      if (!hasSku || (!decoded && !labelHint)) {
        e.isBarcode = false;
        e.code = '';
        e.codeSource = '';
        e.candidates = [];
        e.rawText = '';
        e.barcodeText = '';
        return;
      }
      e.code = parsed.code;
      e.codeSource = parsed.codeSource;
      e.candidates = parsed.candidates;
      e.rawText = parsed.rawText;
      e.barcodeText = parsed.barcodeText;
    } catch (err) {
      e.ocrError = String(err instanceof Error ? err.message : err);
    } finally {
      ocrDone += 1;
      onProgress?.({ phase: 'ocr', done: ocrDone, total: candidates.length });
    }
  });

  const barcodes = entries.filter((e) => e.isBarcode);
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
