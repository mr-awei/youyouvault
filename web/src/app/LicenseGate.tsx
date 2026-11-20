import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api';
import type { LicenseStatus } from '../types';

interface LicenseContextValue {
  status: LicenseStatus | null;
  /** force=true：重新探测硬件并强制拉取远程停用清单（用户手动点刷新时用） */
  refresh: (force?: boolean) => Promise<void>;
}

const LicenseContext = createContext<LicenseContextValue>({ status: null, refresh: async () => {} });

/** 授权状态：启动拉一次，之后每 30 分钟刷新（顺便拉远程停用清单）。 */
export function LicenseProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);

  const refresh = useCallback(async (force = false) => {
    try {
      const next = await api.license(force);
      setStatus(next);
    } catch {
      /* 服务端没起来时不阻断界面，Pro 闸会在接口层再拦一次 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30 * 60 * 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (status?.revoked) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: 'var(--overlay, rgba(6,6,12,.82))',
          backdropFilter: 'blur(10px)',
        }}
      >
        <div
          className="card"
          style={{ maxWidth: 560, width: '100%', borderColor: 'var(--danger, #d9534f)' }}
        >
          <h2 style={{ margin: '0 0 8px', color: 'var(--danger, #d9534f)' }}>软件已停用</h2>
          <div style={{ lineHeight: 1.8, fontSize: 13 }}>
            <div>{status.reason || '该账号已被远程停用，请联系管理员。'}</div>
            {status.account && <div className="hint">账号：{status.account}</div>}
            <div className="hint">设备码：{status.deviceCode || status.machineCode}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn primary" onClick={() => void refresh(true)}>
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <LicenseContext.Provider value={{ status, refresh }}>{children}</LicenseContext.Provider>;
}

export function useLicense() {
  return useContext(LicenseContext);
}

/** 页面级 Pro 闸：免费版直接显示升级说明，不渲染受限页面。 */
export function ProGate({
  feature,
  label,
  onOpenSettings,
  children,
}: {
  feature: string;
  label: string;
  onOpenSettings: () => void;
  children: React.ReactNode;
}) {
  const { status } = useLicense();
  if (!status) {
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );
  }
  if (status.licensed) return <>{children}</>;
  return (
    <div className="empty">
      <div className="big">🔒</div>
      <h3>「{label}」需要专业版授权</h3>
      <div className="hint" style={{ maxWidth: 520, lineHeight: 1.8 }}>
        当前是免费版。到「设置 → 授权」输入激活码，或把设备码 <code>{status.deviceCode || status.machineCode}</code>{' '}
        发给管理员购买授权。
        {status.reason ? ` ${status.reason}` : ''}
      </div>
      <button className="btn primary" style={{ marginTop: 12 }} onClick={onOpenSettings}>
        去设置 → 授权
      </button>
      <div className="hint" style={{ marginTop: 6 }}>
        能力标识：{feature}
      </div>
    </div>
  );
}
