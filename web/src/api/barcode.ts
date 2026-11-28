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
  /** 日期文件夹下的分类子目录（如 eBay / 非eBay）；空 = 直接放日期文件夹 */
  subfolder?: string;
}

export interface BarcodeApplyResult {
  /** 对应请求里的第几组（跳过的不占位） */
  sourceIndex: number;
  /** 实际使用的文件夹名（重复编码会带 -2） */
  code: string;
  /** 实际使用的分类子目录（空 = 日期文件夹直属） */
  subfolder?: string;
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

/** 一个输出文件夹的 1:1 检查结果 */
export interface BarcodeRatioItemResult {
  code: string;
  dir: string;
  total: number;
  /** 不是 1:1 的图片；eBay 必须为 1:1。unknown=true 表示读不到尺寸（如 HEIC 解码失败） */
  notSquare: { file: string; width: number; height: number; unknown?: boolean }[];
  errors: { file: string; error: string }[];
}

export interface BarcodeCropItemResult {
  code: string;
  dir: string;
  /** 本次被居中裁成 1:1 的文件 */
  cropped: string[];
  errors: { file: string; error: string }[];
}

export interface BarcodeNumberItemResult {
  code: string;
  dir: string;
  /** 编号后的最终文件名：1.jpg、2.jpg… */
  files: string[];
  errors: { file: string; error: string }[];
}

export interface BarcodeImportGroupResult {
  code: string;
  folder: string;
  imported: number;
  importSkipped: number;
  importErrors: { file: string; error: string }[];
  libraryFolderId: number | null;
}

export interface BarcodeImportResponse {
  ok: boolean;
  dateDir: string;
  importedTotal: number;
  importSkippedTotal: number;
  results: BarcodeImportGroupResult[];
  /** 输出目录是否已经在当前库内（是则图库层级按磁盘层级走，忽略侧栏选中的父文件夹） */
  insideLibrary?: boolean;
  /** 实际落位的图库层级名（如 ['11月', '20261127']） */
  importPath?: string[];
}

const LONG_TIMEOUT_MS = 10 * 60 * 1000;

/** 源目录里的图片预览地址；同源 GET 可直接给 <img src>。max 用于双击看大图 */
export function barcodeThumbUrl(dir: string, name: string, max = 240) {
  const q = new URLSearchParams({ dir, name });
  if (max !== 240) q.set('max', String(max));
  return `/api/barcode/thumb?${q.toString()}`;
}

export const barcodeAPI = {
  /** scanId 用于接收 SSE 进度和「停止扫描」 */
  barcodeScan: (dir: string, lang = '', scanId = '') =>
    request<BarcodeScanResult>('/api/barcode/scan', {
      method: 'POST',
      body: JSON.stringify({ dir, lang, scanId }),
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  /** 中途停止扫描（OCR 会在下一张前退出） */
  barcodeScanCancel: (scanId: string) =>
    request<{ ok: boolean; cancelled: boolean }>('/api/barcode/scan/cancel', {
      method: 'POST',
      body: JSON.stringify({ scanId }),
    }),

  barcodeApply: (payload: {
    dir: string;
    root: string;
    date: string;
    /** 日期文件夹名；不传 = 用 date。支持用户自定义 / 从同级目录学习（20261123） */
    dateFolder?: string;
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

  /** 检查输出文件夹里的图片是否 1:1（eBay 构图要求） */
  barcodeRatio: (items: { code: string; dir: string; files?: string[] }[]) =>
    request<{ items: BarcodeRatioItemResult[] }>('/api/barcode/ratio', {
      method: 'POST',
      body: JSON.stringify({ items }),
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  /** 居中裁成 1:1，原地覆盖 */
  barcodeCrop: (items: { code: string; dir: string; files?: string[] }[]) =>
    request<{ items: BarcodeCropItemResult[] }>('/api/barcode/crop', {
      method: 'POST',
      body: JSON.stringify({ items }),
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  /** 批量裁切台：按每张图各自的裁切框原地覆盖（条码流程里的文件夹图片尚未入库） */
  barcodeCropRects: (
    items: { code: string; dir: string; file: string; rect: { x: number; y: number; w: number; h: number } }[]
  ) =>
    request<{ items: { code: string; file: string; cropped: boolean; error?: string }[] }>('/api/barcode/crop-rects', {
      method: 'POST',
      body: JSON.stringify({ items }),
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  /** 列出某个产品文件夹里的图片（编号前让用户自己挑前五张） */
  barcodeFolderImages: (dir: string) =>
    request<{ files: string[] }>(`/api/barcode/folder-images?${new URLSearchParams({ dir })}`),

  /** 按用户选定的顺序（或默认拍摄顺序）把图片重命名成 1.jpg、2.jpg… */
  barcodeNumber: (folders: { code: string; dir: string; files?: string[] }[]) =>
    request<{ results: BarcodeNumberItemResult[] }>('/api/barcode/number', {
      method: 'POST',
      body: JSON.stringify({ folders }),
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  /** 把已编号的文件夹登记进图库（写产品名 / 完整编码 / 主 SKU 标签） */
  barcodeImport: (payload: {
    root: string;
    date: string;
    dateFolder?: string;
    parentFolderId?: number | null;
    groups: { code: string; folder: string; productName?: string; mainSku?: string; subfolder?: string }[];
  }) =>
    request<BarcodeImportResponse>('/api/barcode/import', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  /** 学习输出根目录已有的日期命名格式（20261123 / 2026-11-23 …） */
  barcodeDateFolder: (root: string, date: string) =>
    request<{
      ok: boolean;
      date: string;
      name: string;
      learned: boolean;
      key: string;
      label: string;
      count: number;
      samples: string[];
    }>(`/api/barcode/date-folder?${new URLSearchParams({ root, date })}`),

  /** 调整图片归属：把图片从一个产品文件夹移到另一个（入库前调整） */
  barcodeMoveImages: (payload: { from: string; to: string; files: string[] }) =>
    request<{ ok: boolean; moved: string[]; errors: { file: string; error: string }[] }>(
      '/api/barcode/move-image',
      { method: 'POST', body: JSON.stringify(payload) }
    ),

  /** 列出一级子文件夹与图片数：直接选一个已整理好的文件夹生成报表 */
  barcodeSubfolders: (dir: string) =>
    request<{ ok: boolean; dir: string; folders: { name: string; files: number }[] }>(
      `/api/barcode/subfolders?${new URLSearchParams({ dir })}`
    ),
};
