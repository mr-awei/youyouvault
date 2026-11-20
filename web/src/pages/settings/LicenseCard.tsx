import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { LicenseStatus } from '../../types';
import { confirmDialog } from '../../components/Dialogs';
import Card from './Card';
import i18n from '../../i18n';

/** 能力名按当前语言显示；服务端下发的中文标签只作兜底 */
const FEATURE_LABELS: Record<string, string> = {
  lan: i18n.t('kacd2de59'),
  plugins: i18n.t('k309f5454'),
  'night-batch': i18n.t('k41284d5b'),
  barcode: '条码分文件夹与产品图上传',
  timeline: '时间线',
  canvas: '无限画布',
  edit: '调色 / 裁切 / 修图',
  batch: '批量编辑 / 导出 / 增强 / 动作',
};

interface Props {
  onToast: (m: string, kind?: 'info' | 'error') => void;
}

/**
 * 设置 → 授权：机器码、激活码与专业版能力。
 *
 * 全部校验在服务端本地完成（Ed25519 验签 + 硬件指纹），不联网；
 * 这里只负责展示与提交，失败原因原样给用户看，不做二次解释。
 */
export default function LicenseCard({ onToast }: Props) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .license()
      .then(setStatus)
      .catch((err) => onToast(i18n.t('k0ce5ad65', { p0: (err as Error).message }), 'error'));
  }, [onToast]);

  const copyMachine = async () => {
    try {
      await navigator.clipboard.writeText(status?.machineCode || '');
      onToast(i18n.t('k7176f299'));
    } catch {
      onToast(i18n.t('k3987c43b'), 'error');
    }
  };

  const activate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await api.activateLicense(draft.trim());
      setStatus(next);
      setDraft('');
      onToast(i18n.t('k8db01fee'));
    } catch (err) {
      onToast(i18n.t('k826b1700', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    if (busy) return;
    if (!(await confirmDialog(i18n.t('kae46e821')))) return;
    setBusy(true);
    try {
      setStatus(await api.deactivateLicense());
      onToast(i18n.t('kc2ab31ba'));
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <Card title={i18n.t('ke3c2d3c8')} desc={i18n.t('k97ac2c53')}>
        <div className="empty">
          <span className="spinner" />
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={i18n.t('ke3c2d3c8')}
      desc={i18n.t('k97ac2c53')}
      badge={
        <span className="settings-badge">
          {status.licensed ? i18n.t('k3f086416') : i18n.t('k0357cdb4')}
        </span>
      }
    >
      <div className="field">
        <label>{i18n.t('k91c2c3fb')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}
            readOnly
            value={status.machineCode}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button className="btn sm ghost" onClick={() => void copyMachine()}>
            {i18n.t('k79d3abe9')}
          </button>
        </div>
        <div className="hint">{i18n.t('ka8a841d1')}</div>
      </div>

      {status.account && (
        <div className="field">
          <label>授权账号</label>
          <div style={{ fontFamily: 'ui-monospace, monospace' }}>{status.account}</div>
          <div className="hint">
            {status.revokeCheckedAt
              ? `最近检查停用状态：${new Date(status.revokeCheckedAt).toLocaleString()}`
              : status.revokeError || '尚未拉取远程停用清单'}
          </div>
        </div>
      )}

      {status.revoked && (
        <div
          style={{
            margin: '8px 0',
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--danger, #d9534f)',
            background: 'rgba(217, 83, 79, 0.12)',
            color: 'var(--danger, #d9534f)',
            fontWeight: 600,
          }}
        >
          该账号已被远程停用，软件数据接口已锁定。请联系管理员。
        </div>
      )}

      {status.licensed ? (
        <>
          <div className="field">
            <label>{i18n.t('kbb114ab9')}</label>
            <div>
              {status.expires
                ? i18n.t('k6b5781d7', { p0: status.expires })
                : i18n.t('k9eb15d21')}
              {status.daysLeft != null && status.daysLeft <= 60 && (
                <span className="hint" style={{ marginLeft: 8 }}>
                  {i18n.t('k3788268c', { p0: status.daysLeft })}
                </span>
              )}
            </div>
            {status.note && <div className="hint">{status.note}</div>}
          </div>
          <button className="btn danger" disabled={busy} onClick={() => void deactivate()}>
            {i18n.t('k5642a3a4')}
          </button>
        </>
      ) : (
        <>
          <div className="hint" style={{ color: 'var(--warn)' }}>
            {status.reason || i18n.t('k4e185caa')}
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label>{i18n.t('kc84aad94')}</label>
            <textarea
              className="input"
              rows={3}
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              placeholder={i18n.t('kcd1abdca')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={busy || !draft.trim()} onClick={() => void activate()}>
                {i18n.t('k83a991d7')}
              </button>
            </div>
          </div>
        </>
      )}

      <div className="settings-subhead">{i18n.t('k4eb7d0ec')}</div>
      <div className="hint">{i18n.t('k1432c796')}</div>
      <ul className="hint" style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.9 }}>
        {status.features.map((f) => (
          <li key={f.key}>{FEATURE_LABELS[f.key] || f.label}</li>
        ))}
      </ul>
      <div className="hint" style={{ marginTop: 10 }}>
        {i18n.t('kcc59e386')}
      </div>
      {status.buyUrl && (
        <a
          className="btn primary"
          href={status.buyUrl}
          target="_blank"
          rel="noreferrer"
          style={{ display: 'inline-block', marginTop: 10, textDecoration: 'none' }}
        >
          {i18n.t('k7f5b465e')}
        </a>
      )}
    </Card>
  );
}
