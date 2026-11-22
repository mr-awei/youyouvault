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
    // 正常 30 分钟一次；被停用 / 联网校验失败 / OMS 已登录时 1 分钟一次。
    // OMS 会话可能随时过期，必须及时发现并退回免费版。
    const fast =
      status?.blocked || status?.checkFailed || status?.omsLoggedIn || status?.licensed === true;
    const every = fast ? 60 * 1000 : 30 * 60 * 1000;
    const timer = setInterval(() => void refresh(Boolean(status?.blocked)), every);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, status?.blocked, status?.checkFailed, status?.omsLoggedIn, status?.licensed]);

  // 只有明确被远程停用才整屏禁用；联网校验失败 / 授权到期都只是退回免费版
  if (status?.blocked) {
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
            <div>{status.reason || '该手机号或设备已被远程停用，请联系管理员。'}</div>
            {status.phone && <div className="hint">手机号：{status.phone}</div>}
            <div className="hint">设备码：{status.deviceCode || status.machineCode}</div>
            {status.revokeCheckedAt && (
              <div className="hint">最近检查：{new Date(status.revokeCheckedAt).toLocaleString()}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn primary" onClick={() => void refresh(true)}>
              立即重试
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
        当前是免费版。先在右上角「登录 / 激活授权」用 OMS 账号登录，并激活该手机号对应的授权码；
        或把设备码 <code>{status.deviceCode || status.machineCode}</code> 发给管理员购买授权。
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
