import React from 'react';
import { api, isDesktop, openFolder, pickFolder } from '../api';
import type { Settings as SettingsType } from '../types';
import {
  IconBrain,
  IconDownload,
  IconFolder,
  IconGear,
  IconGlobe,
  IconGrid,
  IconImages,
  IconInfo,
  IconKey,
  IconLayers,
  IconRotateCcw,
  IconTrash,
  IconWand,
  } from '../components/Icons';
import Card from './settings/Card';
import Select from '../components/Select';
import AliasCard from './settings/AliasCard';
import ShortcutSection from './settings/ShortcutSection';
import WatchCard from './settings/WatchCard';
import EnhanceSection from './settings/EnhanceSection';
import RecycleBinCard from './settings/RecycleBinCard';
import MaintenanceCard from './settings/MaintenanceCard';
import DataTransferCard from './settings/DataTransferCard';
import JobsSection from './settings/JobsSection';
import PluginSection from './settings/PluginSection';
import LanSection from './settings/LanSection';
import NetworkSection from './settings/NetworkSection';
import DebouncedInput from './settings/DebouncedInput';
import SyncCard from './settings/SyncCard';
import AiSection from './settings/AiSection';
import NightBatchCard from './settings/NightBatchCard';
import { useSettingsForm, type SectionKey } from './settings/useSettingsForm';
import ImportNameTemplateCard from './settings/ImportNameTemplateCard';
import AboutSection from './settings/AboutSection';
import LicenseCard from './settings/LicenseCard';
import DownloadSection from './settings/DownloadSection';
import i18n, { changeLocale, currentLocale } from '../i18n';

type SectionMeta = {
  key: SectionKey;
  label: string;
  desc: string;
  icon: React.ReactNode;
};

/**
 * 侧栏按「使用顺序」分组，不再 14 项平铺：先搞清楚存哪里，再管素材，
 * 然后才是智能、桌面、外部连接，最后是运行状态。
 */
const NAV_GROUPS: { label: string; items: SectionMeta[] }[] = [
  {
    label: i18n.t('k85d22db7'),
    items: [
      {
        key: 'general',
        label: i18n.t('kaa05fd09'),
        desc: i18n.t('kd4c5d721'),
        icon: <IconFolder />,
      },
      {
        key: 'guide',
        label: i18n.t('kb7824d5c'),
        desc: i18n.t('ke88cceea'),
        icon: <IconGrid />,
      },
    ],
  },
  {
    label: i18n.t('k42f4f97b'),
    items: [
      {
        key: 'tags',
        label: i18n.t('ke00706fa'),
        desc: i18n.t('kfa0c8173'),
        icon: <IconLayers />,
      },
      {
        key: 'data',
        label: i18n.t('k18e2e886'),
        desc: i18n.t('kf7fa5c99'),
        icon: <IconImages />,
      },
    ],
  },
  {
    label: i18n.t('k73b7418c'),
    items: [
      {
        key: 'ai',
        label: i18n.t('k70ba6cfb'),
        desc: i18n.t('ke68146ea'),
        icon: <IconBrain />,
      },
      {
        key: 'enhance',
        label: i18n.t('kfd5e4c21'),
        desc: i18n.t('k1862ae14'),
        icon: <IconWand />,
      },
    ],
  },
  {
    label: i18n.t('k2e4b22db'),
    items: [
      {
        key: 'shortcut',
        label: i18n.t('kf7d29966'),
        desc: i18n.t('k538fd2e8'),
        icon: <IconGear />,
      },
    ],
  },
  {
    label: i18n.t('kbaa6276d'),
    items: [
      {
        key: 'network',
        label: i18n.t('k7ddbe15c'),
        desc: i18n.t('k88159aee'),
        icon: <IconGlobe />,
      },
      {
        key: 'plugins',
        label: i18n.t('k236b0cdd'),
        desc: i18n.t('k3df95d8b'),
        icon: <IconWand />,
      },
      {
        key: 'lan',
        label: i18n.t('k102f36ba'),
        desc: i18n.t('k09212153'),
        icon: <IconGlobe />,
      },
    ],
  },
  {
    label: i18n.t('ke4b51d5c'),
    items: [
      {
        key: 'tasks',
        label: i18n.t('k64e00eaa'),
        desc: i18n.t('k09da8aa9'),
        icon: <IconRotateCcw />,
      },
      {
        key: 'models',
        label: i18n.t('k937902e1'),
        desc: i18n.t('kf00ebbac'),
        icon: <IconDownload />,
      },
      {
        key: 'license',
        label: i18n.t('k98a315c0'),
        desc: i18n.t('kbbef9f85'),
        icon: <IconKey />,
      },
      {
        key: 'about',
        label: i18n.t('k7716a5ac'),
        desc: i18n.t('k7e54fdc2'),
        icon: <IconInfo />,
      },
    ],
  },
];

const SECTIONS: SectionMeta[] = NAV_GROUPS.flatMap((g) => g.items);

export default function Settings({
  onToast,
  tourDone,
  onStartTour,
  onOpenTutorial,
  onLibraryChanged,
  initialSection,
}: {
  /** 第二个参数用于区分失败提示（红色、停留更久） */
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  tourDone: boolean;
  onStartTour: () => void;
  /** 打开「使用教程」页（按功能搜索） */
  onOpenTutorial: () => void;
  onLibraryChanged: () => void;
  /** 右上角头像菜单可直接打开「关于软件 / 授权」 */
  initialSection?: SectionKey;
}) {
  // 状态、加载与全部写操作都在 useSettingsForm 里；这里只解构渲染真正用到的字段。
  const form = useSettingsForm({ onToast, onLibraryChanged, initialSection });
  const {
    section, setSection, settings, dirty, save, patch,
    importing, setTourHint, runImport, clearAll,
  } = form;

  if (!settings) {
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );
  }

  const current = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{i18n.t('ke366ccf1')}</h1>
          <div className="page-sub">
            {i18n.t('k2b67ca80')}
          </div>
          <div className="settings-scope">
            <span>
              <b>{i18n.t('ka3d9a184')}</b>{' '}
              {i18n.t('kc692e163')}
            </span>
            <span>
              <b>{i18n.t('kbc9154a4')}</b> <span>{i18n.t('k36084a8b')}</span>
            </span>
          </div>
        </div>
        <button
          className="btn primary"
          onClick={save}
          title={dirty ? i18n.t('k9ac39816') : i18n.t('k2fb8e178')}
          style={dirty ? { boxShadow: '0 0 0 2px rgba(249,115,22,.35)' } : undefined}
        >
          {i18n.t('k4323be72')}
          {dirty ? ' ●' : ''}
        </button>
      </div>

      <div className="settings-shell">
        <nav className="settings-nav" aria-label={i18n.t('k2590095f')}>
          <div className="nav-label">{i18n.t('k2590095f')}</div>
          {NAV_GROUPS.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-group-title">{g.label}</div>
              {g.items.map((s) => (
                <button
                  key={s.key}
                  className={section === s.key ? 'active' : ''}
                  onClick={() => setSection(s.key)}
                  title={s.desc}
                >
                  {s.icon}
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="settings-panel">
          <div className="settings-panel-head">
            <span className="settings-panel-icon">{current.icon}</span>
            <div className="settings-panel-head-text">
              <h2>{current.label}</h2>
              <p>{current.desc}</p>
            </div>
            {dirty && <span className="settings-badge">{i18n.t('k9ac39816')}</span>}
          </div>

          {/* ------------------------------ 通用 ------------------------------ */}
          {section === 'general' && (
            <Card title={i18n.t('kaa05fd09')} desc={i18n.t('ke7741759')}>
              <div className="field" style={{ maxWidth: 260 }}>
                <label>{i18n.t('k7a0878a7')}</label>
                <select
                  className="input"
                  value={currentLocale().startsWith('en') ? 'en-US' : 'zh-CN'}
                  onChange={(e) => {
                    changeLocale(e.target.value === 'en-US' ? 'en-US' : 'zh-CN');
                    window.location.reload();
                  }}
                >
                  <option value="zh-CN">{i18n.t('ka7bac223')}</option>
                  <option value="en-US">English</option>
                </select>
                <div className="hint">{i18n.t('kd3336e90')}</div>
              </div>
              <div className="settings-subhead">{i18n.t('k24af4ac2')}</div>
              <div className="field">
                <label>{i18n.t('k5511f0a3')}</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={settings.storageDir}
                    onChange={(e) => patch({ storageDir: e.target.value })}
                  />
                  <button
                    className="btn"
                    disabled={!isDesktop}
                    title={isDesktop ? i18n.t('kaaa4b65e') : i18n.t('kb5eb86d0')}
                    onClick={async () => {
                      const dir = await pickFolder();
                      if (dir) {
                        patch({ storageDir: dir });
                        await api.saveSettings({ storageDir: dir });
                        onToast(i18n.t('k34a1ed4d', { p0: dir }));
                        onLibraryChanged(); // 立即刷新图库，不用手动点刷新
                      }
                    }}
                  >
                    {i18n.t('k4f05519a')}
                  </button>
                </div>
                <div className="hint">
                  {i18n.t('k6326c14a')}
                </div>
              </div>
              <div className="field">
                <label>{i18n.t('kd7a59201')}</label>
                <Select
                  className="select"
                  style={{ width: '100%' }}
                  value={settings.deletePolicy}
                  onChange={(v) => patch({ deletePolicy: v as SettingsType['deletePolicy'] })}
                >
                  <option value="trash">{i18n.t('k68d0d6e7')}</option>
                  <option value="permanent">{i18n.t('k73279665')}</option>
                  <option value="unlink">{i18n.t('k2e826605')}</option>
                </Select>
              </div>
              <div className="settings-subhead">{i18n.t('k7bf9f9f9')}</div>
              <div className="field">
                <label>{i18n.t('ka47a0407')}</label>
                <DebouncedInput
                  type="number"
                  min={0}
                  max={100}
                  value={settings.scoreThreshold}
                  onCommit={(v) => patch({ scoreThreshold: Number(v) || 0 })}
                />
              </div>
              <div className="field" style={{ maxWidth: 260 }}>
                <label>{i18n.t('ke8a5da7f')}</label>
                <DebouncedInput
                  type="number"
                  min={1}
                  max={500}
                  value={settings.historySteps ?? 100}
                  onCommit={(v) => patch({ historySteps: Math.min(500, Math.max(1, Number(v) || 100)) })}
                />
                <div className="hint">
                  {i18n.t('kac06a924')}
                </div>
              </div>
              <div className="field">
                <div className="switch-row">
                  <span>
                    {i18n.t('k0b40dd56')}
                    <span className="hint">
                      　{i18n.t('kb362146a')}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={!!settings.nonDestructiveEdit}
                    onChange={(e) => patch({ nonDestructiveEdit: e.target.checked })}
                  />
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  开着时编辑不会再改写原文件，磁盘占用与画质都更安全；代价是编辑多的图每次看图要现算一次成品（会缓存）。
                  想彻底落盘，在灯箱的「非破坏编辑」里点「应用到底片」。
                </div>
              </div>
              <div className="settings-subhead">{i18n.t('k9530e8e4')}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => openFolder(settings.storageDir)}>
                  <IconFolder /> {i18n.t('kb00f8cb9')}
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const res = await api.scanFolder();
                    onToast(res.ok ? i18n.t('k37161a2f', { p0: res.saved ?? 0 }) : res.message || i18n.t('k5ec14542'));
                    onLibraryChanged();
                  }}
                >
                  {i18n.t('k7beb581f')}
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const res = await api.purgeMissing();
                    onToast(i18n.t('ka3ca1c0f', { p0: res.removed }));
                    onLibraryChanged();
                  }}
                >
                  {i18n.t('ke87f0fc0')}
                </button>
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                {i18n.t('k177ffed9')}
              </div>
            </Card>
          )}

          {/* ---------------------------- AI 接入（已拆分至 settings/AiSection.tsx） ---------------------------- */}
          {section === 'ai' && (
            <>
              <AiSection form={form} />
              <NightBatchCard onToast={onToast} />
            </>
          )}

          {/* ------------------------------ 画质增强（已拆分至 settings/EnhanceSection.tsx） ------------------------------ */}
          {section === 'enhance' && <EnhanceSection settings={settings} patch={patch} onToast={onToast} />}

          {/* ---------------------- 任务与撤销（已拆分至 settings/JobsSection.tsx） ---------------------- */}
          {/* ------------------------------ 教程 ------------------------------ */}
          {section === 'guide' && (
            <>
              <Card
                title={i18n.t('kb7824d5c')}
                desc={i18n.t('k7e390984')}
                badge={
                  <span className="settings-badge">{tourDone ? i18n.t('k78eebac6') : i18n.t('k04a1e8f3')}</span>
                }
              >
                <div className="field">
                  <label>{i18n.t('k8550e5d0')}</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn primary" onClick={onStartTour}>
                      {i18n.t('k549a624e')}
                    </button>
                    <button className="btn" onClick={() => setTourHint(!tourDone)}>
                      {tourDone ? i18n.t('k45fefaad') : i18n.t('kd7257977')}
                    </button>
                  </div>
                  <div className="hint" style={{ marginTop: 6 }}>
                    {i18n.t('k8bc7c8f8')}
                  </div>
                </div>

                <div className="field">
                  <label>{i18n.t('k0b246795')}</label>
                  <ul className="hint" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
                    <li>{i18n.t('k70b4b681')}</li>
                    <li>{i18n.t('kc41ee12f')}</li>
                    <li>{i18n.t('k7c7118af')}</li>
                    <li>{i18n.t('k78d114f5')}</li>
                    <li>{i18n.t('k7b685539')}</li>
                    <li>{i18n.t('kb3ba8874')}</li>
                  </ul>
                </div>
              </Card>

              <Card
                title={i18n.t('k04f5cbe9')}
                desc={i18n.t('k0def9c59')}
                badge={<span className="settings-badge">{i18n.t('kc181ce48')}</span>}
              >
                <div className="field">
                  <label>{i18n.t('kf8cc5b85')}</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn primary" onClick={onOpenTutorial}>
                      {i18n.t('kedfa445b')}
                    </button>
                  </div>
                  <div className="hint" style={{ marginTop: 6 }}>
                    覆盖浏览搜索、文件夹标签、堆叠笔记、查重整理、编辑导出、AI、数据备份等全部功能；
                    在教程页顶部输入「堆叠」「时间点」这类词即可定位。
                  </div>
                </div>
              </Card>

              <Card title={i18n.t('ke17f3542')} desc={i18n.t('kfc933cf4')}>
                <div className="hint" style={{ lineHeight: 1.9 }}>
                  <div>{i18n.t('k3826fbf9')}</div>
                  <div>{i18n.t('k8746e406')}</div>
                  <div>{i18n.t('k91e8a4d6')}</div>
                  <div>{i18n.t('k47edd654')}</div>
                  <div>{i18n.t('k3608bdc0')}</div>
                  <div style={{ marginTop: 6 }}>{i18n.t('k6cfe96b2')}</div>
                </div>
              </Card>
            </>
          )}

          {section === 'tasks' && <JobsSection onToast={onToast} />}

          {/* ---------------------- 下载中心（已拆分至 settings/DownloadSection.tsx） ---------------------- */}
          {section === 'models' && <DownloadSection onToast={onToast} />}

          {/* ---------------------- 关于软件（已拆分至 settings/AboutSection.tsx） ---------------------- */}
          {section === 'about' && (
            <AboutSection settings={settings} patch={patch} onToast={onToast} onOpenTutorial={onOpenTutorial} />
          )}

          {/* ------------------------------ 授权 ------------------------------ */}
          {section === 'license' && <LicenseCard onToast={onToast} />}

          {/* ------------------------------ 网络（已拆分至 settings/NetworkSection.tsx） ------------------------------ */}
          {section === 'network' && <NetworkSection form={form} onToast={onToast} />}

          {/* ------------------------------ 插件 ------------------------------ */}
          {section === 'plugins' && <PluginSection onToast={onToast} />}
          {section === 'lan' && <LanSection onToast={onToast} />}

          {/* --------------------------- 数据与维护 --------------------------- */}
          {section === 'data' && (
            <>
              <div className="settings-subhead">{i18n.t('kbc23b34a')}</div>
              <ImportNameTemplateCard
                value={settings.importNameTemplate || ''}
                applyToLocal={!!settings.importNameTemplateForLocal}
                onChange={(p) => patch(p)}
                onToast={onToast}
              />
              <Card title={i18n.t('k4ed3eab4')} desc={i18n.t('k77a49796')}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button className="btn" onClick={runImport} disabled={importing}>
                    {importing ? i18n.t('k9b1a865c') : i18n.t('k6da268f3')}
                  </button>
                  {/* 「下载初始素材」已移除：SEED_URLS 是空数组，按钮点下去只会显示"已尝试下载" */}
                  <button className="btn danger" onClick={clearAll}>
                    <IconTrash /> {i18n.t('kf331ee8f')}
                  </button>
                </div>
                <div className="field" style={{ marginTop: 14, maxWidth: 260 }}>
                  <label>{i18n.t('k9ad1ad70')}</label>
                  <DebouncedInput
                    type="number"
                    min={1}
                    max={16}
                    value={settings.importMaxDepth ?? 4}
                    onCommit={(v) => patch({ importMaxDepth: Math.min(16, Math.max(1, Number(v) || 4)) })}
                  />
                  <div className="hint">
                    {i18n.t('k727001c9')}
                  </div>
                </div>
                <div className="hint" style={{ marginTop: 14, lineHeight: 1.9 }}>
                  {i18n.t('ke21b6c91')}
                  <br />{i18n.t('k1f20d809')}
                  <br />{i18n.t('k6f8a5a3b')}
                </div>
              </Card>

              <MaintenanceCard onLibraryChanged={onLibraryChanged} onToast={onToast} />

              <div className="settings-subhead">{i18n.t('kb4fbc92c')}</div>
              <DataTransferCard onLibraryChanged={onLibraryChanged} onToast={onToast} />
              <RecycleBinCard onLibraryChanged={onLibraryChanged} onToast={onToast} />
              <SyncCard onToast={onToast} onLibraryChanged={onLibraryChanged} />

              <div className="settings-subhead">目录监听</div>
              <WatchCard onToast={onToast} />
            </>
          )}

          {/* --------------------------- 标签与别名 --------------------------- */}
          {section === 'tags' && <AliasCard onToast={onToast} />}

          {/* --------------------------- 快捷键 --------------------------- */}
          {section === 'shortcut' && <ShortcutSection />}
        </div>
      </div>
    </div>
  );
}
