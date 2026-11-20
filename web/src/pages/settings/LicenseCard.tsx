import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { LicenseStatus } from '../../types';
import { confirmDialog } from '../../components/Dialogs';
import { useLicense } from '../../app/LicenseGate';
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
 * 设置 → 授权：手机号 + 设备码、激活码与专业版能力。
 *
 * 全部校验在服务端本地完成（Ed25519 验签 + 硬件指纹），不联网；
 * 这里只负责展示与提交，失败原因原样给用户看，不做二次解释。
 */
export default function LicenseCard({ onToast }: Props) {
  const { status: ctxStatus, refresh: refreshLicense } = useLicense();
  const [status, setStatus] = useState<LicenseStatus | null>(ctxStatus ?? null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .license()
      .then(setStatus)
      .catch((err) => onToast(i18n.t('k0ce5ad65', { p0: (err as Error).message }), 'error'));
  }, [onToast]);

  // 全局授权状态变化（激活 / 取消 / 停用清单刷新）时同步这张卡片
  useEffect(() => {
    if (ctxStatus) setStatus(ctxStatus);
  }, [ctxStatus]);

  const copyMachine = async () => {
    try {
      await navigator.clipboard.writeText(status?.deviceCode || status?.machineCode || '');
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
      void refreshLicense(true);
      onToast(i18n.t('k8db01fee'));
    } catch (err) {
      onToast(i18n.t('k826b1700', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    if (busy) return;
    // 开发模式的 Pro 来自 TUKU_DEV_PRO=1，删授权文件也不会掉，直接解释清楚
    if (status?.devPro && !status.licensedByKey) {
      onToast(
        '当前专业版来自开发环境变量 TUKU_DEV_PRO=1，取消授权不会改变状态；请去掉该环境变量后重启再试。',
        'error'
      );
      return;
    }
    if (!(await confirmDialog(i18n.t('kae46e821')))) return;
    setBusy(true);
    try {
      const next = await api.deactivateLicense();
      setStatus(next);
      void refreshLicense(true);
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

  const realLicensed = status.licensedByKey === true && !status.revoked;
  const phone = status.phone || status.account || '';
  const deviceCode = status.deviceCode || status.machineCode;
  const badge = realLicensed
    ? i18n.t('k3f086416')
    : status.licensed
      ? '开发模式 Pro'
      : i18n.t('k0357cdb4');

  return (
    <Card title={i18n.t('ke3c2d3c8')} desc={i18n.t('k97ac2c53')} badge={<span className="settings-badge">{badge}</span>}>
      <div className="field">
        <label>设备码</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}
            readOnly
            value={deviceCode}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button className="btn sm ghost" onClick={() => void copyMachine()}>
            {i18n.t('k79d3abe9')}
          </button>
        </div>
        <div className="hint">购买 / 续期时，请把「手机号 + 这个设备码」一起发给管理员；只发其中一个无法签发。</div>

        <details className="hint" style={{ marginTop: 8, lineHeight: 1.9 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>设备码是怎么算出来的？什么情况会变？</summary>
          <div style={{ marginTop: 6 }}>
            设备码由 6 组本机特征各取 SHA-256 的前 4 位拼成，格式为 <code>TK2-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX</code>：
            <ol style={{ margin: '4px 0 6px', paddingLeft: 20 }}>
              <li>SMBIOS UUID（整机唯一标识）</li>
              <li>主板序列号 + BIOS 序列号</li>
              <li>启动盘（系统盘）物理序列号</li>
              <li>TPM 背书密钥（有 TPM 且可读取时；否则跳过）</li>
              <li>Windows MachineGuid</li>
              <li>CPU ProcessorId / 型号 + 物理网卡 MAC</li>
            </ol>
            <div>
              <strong>会变化的情况：</strong>更换主板、启动盘或网卡；重装 / 克隆系统（MachineGuid 变化）；虚拟机迁移；批量刷写硬件序列号。
            </div>
            <div style={{ marginTop: 4 }}>
              <strong>容错规则：</strong>6 组里允许变 2 组，并且必须至少命中 1 个强特征（UUID / 主板 / 启动盘 / TPM）。重装系统、换单块硬盘或网卡通常仍可用；换主板等主要硬件需要重新签发。设备码只在本机计算，不上传原始序列号。
            </div>
          </div>
        </details>
      </div>

      {phone && (
        <div className="field">
          <label>授权手机号</label>
          <div style={{ fontFamily: 'ui-monospace, monospace' }}>{phone}</div>
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
          该手机号或设备已被远程停用，数据接口已锁定。请联系管理员解除。
        </div>
      )}

      {realLicensed ? (
        <>
          <div className="field">
            <label>{i18n.t('kbb114ab9')}</label>
            <div>
              {status.expires ? i18n.t('k6b5781d7', { p0: status.expires }) : i18n.t('k9eb15d21')}
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
          {status.devPro && (
            <div className="hint" style={{ color: 'var(--warn)', marginBottom: 8 }}>
              当前是开发模式临时专业版（TUKU_DEV_PRO=1），不是真实授权；取消授权不会改变它。下面仍可激活正式授权码。
            </div>
          )}
          <div className="hint" style={{ color: 'var(--warn)' }}>
            {status.revoked ? '该手机号或设备已被停用，激活新码也无法解除。' : status.reason || i18n.t('k4e185caa')}
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
