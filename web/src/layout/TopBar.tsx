/**
 * 顶栏：品牌 + 工具箱下拉 + 设置 + 明暗切换。
 * 纯展示组件（状态由 App 管），从 App.tsx 拆出以缩小主组件体积。
 */
import { useEffect, useRef, useState, type Ref } from 'react';
import type { View } from '../types';
import {
  IconBook,
  IconChevronDown,
  IconDownload,
  IconGear,
  IconGlobe,
  IconInfo,
  IconKey,
  IconMoon,
  IconSun,
  IconWand,
} from '../components/Icons';
import { useLicense } from '../app/LicenseGate';
import OmsLoginDialog from '../components/OmsLoginDialog';
import { TOOLS, navLabel } from './nav';
import i18n from '../i18n';

interface Props {
  activeLibName: string;
  view: View;
  onView: (v: View) => void;
  /** 右上角头像菜单：直接打开设置页的指定小节 */
  onOpenSettings: (section: 'general' | 'about' | 'license') => void;
  toolsOpen: boolean;
  onToolsOpen: (next: boolean) => void;
  toolsRef: Ref<HTMLDivElement>;
  toolsActive: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  /** 导出为 HTML 网页画廊 */
  onExportGallery: () => void;
  /** 生成只读分享链接（手机扫码浏览） */
  onShareLink: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

export default function TopBar({
  activeLibName,
  view,
  onView,
  onOpenSettings,
  toolsOpen,
  onToolsOpen,
  toolsRef,
  toolsActive,
  theme,
  onToggleTheme,
  onExportGallery,
  onShareLink,
  onToast,
}: Props) {
  // 账号常驻在右上角：头像 + 套餐状态，点开是设置 / 授权 / 关于软件
  const { status } = useLicense();
  const [accountOpen, setAccountOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!accountOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) setAccountOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccountOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [accountOpen]);

  const editionLabel = status?.trial
    ? `试用中 · 剩 ${status.trialDaysLeft} 天`
    : status?.licensed
      ? i18n.t('k3f086416')
      : i18n.t('k0357cdb4');
  // 只有 OMS 会话有效才算「登录」；token 过期会自动退回未登录 / 免费版。
  const signedIn = status?.omsLoggedIn === true;
  // 没登录 OMS 时一律显示「未登录」——授权文件里的手机号不代表用户已登录
  const accountName = status?.omsUsername || (status?.devPro ? '开发模式' : i18n.t('k63e85df1'));
  const avatarText = status?.omsUsername ? status.omsUsername.slice(-2) : '优';

  return (
    <header className="topbar" data-tour="topbar">
      <div className="topbar-brand">
        {/* 与安装包/任务栏/托盘同一枚标：橙底白字「优」 */}
        <div className="logo-mark" aria-hidden="true">
          优
        </div>
        <div className="topbar-title">
          <b>{i18n.t('k6084bc4b')}</b>
          <span>{activeLibName}</span>
        </div>
      </div>
      <div className="topbar-actions" ref={toolsRef} data-tour="topbar-actions">
        <div className="tools-wrap">
          <button
            className={`btn ghost sm tools-btn${toolsActive ? ' tools-btn-active' : ''}`}
            onClick={() => onToolsOpen(!toolsOpen)}
            title={i18n.t('k3f625409')}
          >
            <IconWand />
            <span>{i18n.t('k59ddf3cc')}</span>
            <span className="tools-chev">
              <IconChevronDown size={13} />
            </span>
          </button>
          {toolsOpen && (
            <div className="tools-menu">
              {TOOLS.map((t) => (
                <button
                  key={t.key}
                  className={`tools-item${view === t.key ? ' active' : ''}`}
                  onClick={() => {
                    onView(t.key);
                    onToolsOpen(false);
                  }}
                >
                  {t.icon}
                  <span>{navLabel(t)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="icon-btn" onClick={onShareLink} title={i18n.t('kb03671ff')}>
          <IconGlobe />
        </button>
        <button className="icon-btn" onClick={onExportGallery} title={i18n.t('kf2d11f17')}>
          <IconDownload />
        </button>
        <button
          className={`icon-btn${view === 'tutorial' ? ' icon-btn-active' : ''}`}
          onClick={() => onView('tutorial')}
          title={i18n.t('k86e19b14')}
          data-tour="tutorial-btn"
        >
          <IconBook />
        </button>
        <button
          className="icon-btn"
          onClick={onToggleTheme}
          title={theme === 'dark' ? i18n.t('kecffeb15') : i18n.t('k3abec43f')}
        >
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
        {/* 账号：常驻右上角，设置 / 授权 / 关于软件都在这个下拉里 */}
        <div className="account-wrap" ref={accountRef}>
          <button
            className={`avatar-btn${accountOpen ? ' avatar-btn-active' : ''}${!signedIn ? ' avatar-btn-pending' : ''}`}
            onClick={() => setAccountOpen((v) => !v)}
            title={i18n.t('ke366ccf1')}
            data-tour="settings-btn"
            aria-haspopup="menu"
            aria-expanded={accountOpen}
          >
            <span className="avatar-dot" aria-hidden="true">
              {avatarText}
            </span>
            <span className="avatar-meta">
              <b>{accountName}</b>
              <em>{editionLabel}</em>
            </span>
            <span className="avatar-chev">
              <IconChevronDown size={13} />
            </span>
          </button>
          {accountOpen && (
            <div className="account-menu" role="menu">
              <div className="account-head">
                <b>{accountName}</b>
                <span>{signedIn ? status?.reason || editionLabel : i18n.t('kb0154047')}</span>
              </div>
              {!signedIn && (
                <button
                  className="tools-item login-item"
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false);
                    setLoginOpen(true);
                  }}
                >
                  <IconKey />
                  <span>{i18n.t('k349884a1')}</span>
                </button>
              )}
              <button
                className="tools-item"
                role="menuitem"
                onClick={() => {
                  setAccountOpen(false);
                  onOpenSettings('general');
                }}
              >
                <IconGear />
                <span>{i18n.t('ke366ccf1')}</span>
              </button>
              {signedIn && (
                <>
                  <button
                    className="tools-item"
                    role="menuitem"
                    onClick={() => {
                      setAccountOpen(false);
                      setLoginOpen(true);
                    }}
                  >
                    <IconKey />
                    <span>退出登录 / 切换账号</span>
                  </button>
                  <button
                    className="tools-item"
                    role="menuitem"
                    onClick={() => {
                      setAccountOpen(false);
                      onOpenSettings('license');
                    }}
                  >
                    <IconKey />
                    <span>{i18n.t('k32abef73')}</span>
                  </button>
                </>
              )}
              <button
                className="tools-item"
                role="menuitem"
                onClick={() => {
                  setAccountOpen(false);
                  onOpenSettings('about');
                }}
              >
                <IconInfo />
                <span>{i18n.t('k7716a5ac')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {loginOpen && <OmsLoginDialog onClose={() => setLoginOpen(false)} onToast={onToast} />}
    </header>
  );
}
