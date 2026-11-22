/**
 * 右上角账号菜单里的「登录 / 激活授权」对话框。
 *
 * 登录走 OMS 网站自己的接口（服务端 server/lib/oms.js 保存账号并拿 access_token）：
 * - 账号就是 OMS 账号（手机号），授权码也按这个手机号签发；
 * - 登录成功才算登录，失败原样显示 OMS 的错误（账号不存在 / 密码错误 …）；
 * - 会话过期后服务端会把 Pro 关掉，用户需要在这里重新登录。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useLicense } from '../app/LicenseGate';
import { maskPhone } from '../lib/phone-mask';
import { IconClose } from './Icons';

interface Props {
  onClose: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

export default function OmsLoginDialog({ onClose, onToast }: Props) {
  const { status, refresh } = useLicense();
  const [username, setUsername] = useState(status?.omsUsername || '');
  const [password, setPassword] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://sit.uyoyous.com');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .omsStatus()
      .then((s) => {
        // 未登录时不要把保存的真实账号回填到输入框，避免一眼看到手机号
        if (s.loggedIn && s.username) setUsername(s.username);
        if (s.baseUrl) setBaseUrl(s.baseUrl);
        if (s.error) setError(s.error);
      })
      .catch(() => undefined);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('请填写 OMS 账号和密码');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await api.omsSaveAccount({
        username: username.trim(),
        password,
        baseUrl: baseUrl.trim(),
      });
      if (!next.loggedIn) throw new Error(next.error || '登录未成功，请检查账号密码');
      // 关键：登录成功后立刻重算授权状态，命中「已登录 + 已授权」才升级 Pro
      await refresh(true);
      setPassword('');
      onToast(`登录成功：${next.username}`, 'info');
      onClose();
    } catch (err) {
      setError((err as Error).message || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await api.omsClearAccount();
      await refresh(true);
      onToast('已退出登录，专业版功能已关闭', 'info');
      onClose();
    } catch (err) {
      setError((err as Error).message || '退出失败');
    } finally {
      setBusy(false);
    }
  };

  const licensePhone = status?.phone || '';
  const mismatch =
    !!licensePhone && !!username.trim() && licensePhone.replace(/\D/g, '') !== username.replace(/\D/g, '');

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>登录 / 激活授权</b>
          <button className="btn ghost sm" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body lock-body">
            <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'var(--muted)', marginBottom: 10 }}>
              用 OMS 业务中台的账号登录。网站验证通过即登录成功；登录成功且本机有该手机号对应的授权码，才会开启专业版。
              会话过期后会自动退回免费版，需要在这里重新登录。
            </div>

            <div className="field">
              <label>OMS 账号（手机号）</label>
              <input
                className="input"
                autoComplete="username"
                placeholder="例如 13333333333"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="field">
              <label>密码</label>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                placeholder="OMS 登录密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="field">
              <label>OMS 地址</label>
              <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              <div className="hint">默认 sit 测试环境；服务器地址有变化时在这里改。</div>
            </div>

            {mismatch && (
              <div className="hint" style={{ color: 'var(--warn, #d99a2b)' }}>
                当前授权码绑定的手机号（{maskPhone(licensePhone)}）与填写的账号不一致；即使登录成功也不会升级专业版。
              </div>
            )}
            {!licensePhone && (
              <div className="hint">
                本机还没有授权码。登录后再到「设置 → 授权」粘贴管理员签发的激活码即可升级专业版。
              </div>
            )}
            {error && (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--danger, #d9534f)',
                  color: 'var(--danger, #d9534f)',
                  fontSize: 12.5,
                }}
              >
                {error}
              </div>
            )}
          </div>
          <div className="modal-foot">
            {status?.omsLoggedIn ? (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => void logout()}>
                退出登录
              </button>
            ) : (
              <span />
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn ghost" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? '登录中…' : '登录'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
