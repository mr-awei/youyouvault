import { request } from './core';
import type { LicenseStatus } from '../types';

/**
 * 授权接口：状态 / 激活 / 取消本机授权。
 * 验签在服务端本地完成，不经过任何远程服务。
 */
export const licenseAPI = {
  license: (refresh = false) => request<LicenseStatus>(`/api/license${refresh ? '?refresh=1' : ''}`),
  activateLicense: (key: string) =>
    request<LicenseStatus>('/api/license/activate', {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),
  deactivateLicense: () =>
    request<LicenseStatus>('/api/license/deactivate', {
      method: 'POST',
      body: '{}',
    }),
};
