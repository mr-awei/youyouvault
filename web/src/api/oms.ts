/**
 * OMS 拍摄系统：账号配置 + 按 5 位主 SKU 查「待拍摄」的完整编码。
 * 账号密码由服务端保管，这里只拿状态，不回读密码。
 */
import { BASE, getApiToken, request } from './core';

export interface OmsStatus {
  configured: boolean;
  username: string;
  baseUrl: string;
  loggedIn: boolean;
  expiresAt: number;
  error: string;
}

export interface OmsDesignRow {
  /** 设计单 id，用于打开 OMS 后台详情 */
  id: string;
  /** 完整编码，如 45661-Y01Y0001-QD08 */
  salesSku: string;
  productName: string;
  billNo: string;
  shootStatus: string;
  status: string;
}

export interface OmsSkuResult {
  total: number;
  rows: OmsDesignRow[];
  error?: string;
}

export interface OmsProductLookup {
  ok: boolean;
  sku: string;
  displayName: string;
  platform: string;
  type: string;
  shootCount: number;
  totalCount: number;
}

export interface OmsProductScanRow {
  name: string;
  sku: string;
  dir: string;
  imageCount: number;
  mtime: string;
}

export interface OmsProductUploadResult {
  ok: boolean;
  sku: string;
  displayName: string;
  uploaded: number;
  skipped: number;
  failed: { file: string; error: string }[];
  total: number;
  shootCount: number;
}

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * SKU 文件夹截图（工作成果列用）。
 * depth=2：输出目录是「日期/分类/编码」时，穿透分类目录，截图里仍然是 SKU 文件夹。
 */
export function omsProductFolderShotUrl(dir: string, depth = 1) {
  const q = new URLSearchParams({ dir });
  if (depth > 1) q.set('depth', String(depth));
  return `/api/oms/product/folder-shot?${q.toString()}`;
}

export const omsAPI = {
  omsStatus: () => request<OmsStatus>('/api/oms/status'),

  omsSaveAccount: (payload: { username: string; password: string; baseUrl?: string }) =>
    request<OmsStatus>('/api/oms/account', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: 40000,
    }),

  omsLogin: () =>
    request<OmsStatus>('/api/oms/login', {
      method: 'POST',
      timeoutMs: 40000,
    }),

  omsClearAccount: () =>
    request<OmsStatus>('/api/oms/account', {
      method: 'DELETE',
    }),

  omsResolve: (skus: string[]) =>
    request<{ results: Record<string, OmsSkuResult> }>('/api/oms/resolve', {
      method: 'POST',
      body: JSON.stringify({ skus }),
      timeoutMs: 120000,
    }),

  /** 产品图上传：扫描根目录里的 SKU 子文件夹（只读） */
  omsProductScan: (dir: string) =>
    request<{ ok: boolean; root: string; rows: OmsProductScanRow[] }>('/api/oms/product/scan', {
      method: 'POST',
      body: JSON.stringify({ dir }),
    }),

  /** 按完整 SKU 查产品图库后台名称（只读） */
  omsProductLookup: (sku: string) =>
    request<OmsProductLookup>('/api/oms/product/lookup', {
      method: 'POST',
      body: JSON.stringify({ sku }),
      timeoutMs: 60000,
    }),

  /** 手动上传一个 SKU 文件夹；名称不一致服务端会 409，不上传 */
  omsProductUpload: (payload: { sku: string; dir: string; expectedName: string }) =>
    request<OmsProductUploadResult>('/api/oms/product/upload', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }),

  /**
   * 生成工作日报 xlsx（POST 返回二进制）。
   * 不走 request()：那里统一按 JSON 解析，这里要拿 Blob 交给下载。
   */
  omsProductReport: async (payload: {
    date: string;
    rows: { sku: string; name: string; platform: string; category?: string }[];
  }): Promise<Blob> => {
    const token = await getApiToken();
    const res = await fetch(`${BASE}/api/oms/product/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let message = `生成 Excel 失败（${res.status}）`;
      try {
        const data = await res.json();
        if (data?.error) message = String(data.error);
      } catch {
        /* 非 JSON 错误体，保留状态码文案 */
      }
      throw new Error(message);
    }
    return res.blob();
  },
};
