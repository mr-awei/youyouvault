/**
 * OMS 拍摄系统：账号配置 + 按 5 位主 SKU 查「待拍摄」的完整编码。
 * 账号密码由服务端保管，这里只拿状态，不回读密码。
 */
import { request } from './core';

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
};
