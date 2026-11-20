/**
 * 条码分文件夹：扫描 / 复制 / 缩略图。
 * 扫描含 OCR，一屏 200 张照片可能要几十秒，所以这两个 POST 单独放宽超时。
 */
import { request } from './core';

export interface BarcodeWarning {
  code: string;
  text: string;
}

export interface BarcodeGroup {
  /** OCR 解析出的编码；可能为空，等用户补 */
  code: string;
  /** 完整编码 / 主 SKU / PO 号，界面上做快速填入 */
  candidates: string[];
  /** OCR 原文，折叠展示 */
  rawText: string;
  /** 面单上一维码解码出的内容（可能是 PO 号，不是产品编码） */
  barcodeText: string;
  /** 这一组的条码照片（相对源目录） */
  barcodeFile: string;
  /** 条码之后、下一条码之前的产品图（相对源目录） */
  files: string[];
  warnings: BarcodeWarning[];
}

export interface BarcodeScanResult {
  dir: string;
  total: number;
  barcodeCount: number;
  /** 建议日期 YYYY-MM-DD（第一张条码的 EXIF，退回文件修改时间） */
  date: string;
  dateSource: 'exif' | 'mtime';
  groups: BarcodeGroup[];
  /** 第一张条码之前的照片 */
  ungrouped: string[];
  warnings: BarcodeWarning[];
  /** 无法读取、未参与判黄的文件 */
  skipped: { file: string; reason: string }[];
}

export interface BarcodeApplyGroup {
  code: string;
  files: string[];
  skip?: boolean;
  /** 产品名：入库时作为标签写到该组每一张图片 */
  productName?: string;
  /** 5 位主 SKU：入库时作为标签写到该组每一张图片 */
  mainSku?: string;
}

export interface BarcodeApplyResult {
  /** 实际使用的文件夹名（重复编码会带 -2） */
  code: string;
  folder: string;
  copied: number;
  skipped: number;
  errors: { file: string; error: string }[];
  /** 本次新登记进图库的张数 */
  imported?: number;
  /** 已经在库里、只补标签/文件夹的张数 */
  importSkipped?: number;
  importErrors?: { file: string; error: string }[];
  /** 图库里的编码文件夹 id */
  libraryFolderId?: number | null;
  /** 同名编码文件夹里被移到 .stale 的旧文件数 */
  cleaned?: number;
  cleanErrors?: { file: string; error: string }[];
}

export interface BarcodeApplyResponse {
  ok: boolean;
  dateDir: string;
  totalCopied: number;
  results: BarcodeApplyResult[];
  importedTotal?: number;
  importSkippedTotal?: number;
  cleanedTotal?: number;
  importedToLibrary?: boolean;
}

const LONG_TIMEOUT_MS = 10 * 60 * 1000;

/** 源目录里的图片预览地址；同源 GET 可直接给 <img src>。max 用于双击看大图 */
export function barcodeThumbUrl(dir: string, name: string, max = 240) {
  const q = new URLSearchParams({ dir, name });
  if (max !== 240) q.set('max', String(max));
  return `/api/barcode/thumb?${q.toString()}`;
}

export const barcodeAPI = {
  barcodeScan: (dir: string, lang = '') =>
    request<BarcodeScanResult>('/api/barcode/scan', {
      method: 'POST',
      body: JSON.stringify({ dir, lang }),
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  barcodeApply: (payload: {
    dir: string;
    root: string;
    date: string;
    groups: BarcodeApplyGroup[];
    /** 复制完成后是否登记进当前图库 */
    importToLibrary?: boolean;
    /** 入库父文件夹（当前侧栏选中的文件夹；null = 图库根） */
    parentFolderId?: number | null;
    /** 重跑时把同名编码文件夹里不属于本次分组的旧文件移到 .stale */
    cleanStale?: boolean;
  }) =>
    request<BarcodeApplyResponse>('/api/barcode/apply', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: LONG_TIMEOUT_MS,
    }),
};
