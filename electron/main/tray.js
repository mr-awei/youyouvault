// @ts-check
/**
 * 托盘图标：不打开主窗口也能截图、重启本地服务。
 * 托盘菜单的结果统一走 trayNotify（提示窗 + 菜单里的「上次操作」）。
 */
import { Menu, Tray, app } from 'electron';
import { getSettingsSnapshot, setSettingsCache } from '../settings-cache.js';
import { APP_ICON, APP_NAME } from './constants.js';
import { ctx } from './context.js';
import { tf } from './i18n-main.cjs';
import { fetchJson } from './ipc-base.js';
import { restartLocalServer } from './service.js';
import { requestRegionShot } from './shot.js';
import { trayNotify } from './toast.js';
import { showMainWindow } from './windows.js';

const getSettings = getSettingsSnapshot;

/** 供主进程其它模块调用：界面语言变了，重建托盘菜单（菜单文字在构建时取 i18n 值） */
export function refreshTray() {
  const fn = ctx.trayMenuRefresher;
  if (fn) fn();
}

export function createTray() {
  if (ctx.tray) return;
  try {
    ctx.tray = new Tray(APP_ICON);
  } catch (err) {
    console.error('[tray] 托盘创建失败：', err?.message || err);
    return;
  }
  ctx.tray.setToolTip(tf('tray.tooltip', { app: APP_NAME }));

  const refreshMenu = () => {
    if (!ctx.tray || ctx.tray.isDestroyed()) return;
    // 显式标注：否则数组里混着 {label} 与 {type:'separator'} 时 type 会被推成 string，
    // 不满足 MenuItemConstructorOptions 的字面量联合类型
    /** @type {import('electron').MenuItemConstructorOptions[]} */
    const template = [
      // 条件展开必须显式断言：TS 无法把条件表达式的数组字面量上下文推断为
      // MenuItemConstructorOptions，会让整条模板的 type 退化成 string
      .../** @type {import('electron').MenuItemConstructorOptions[]} */ (
        ctx.lastTrayNotice
          ? [{ label: tf('tray.lastAction', { msg: ctx.lastTrayNotice }), enabled: false }, { type: 'separator' }]
          : []
      ),
      { label: tf('tray.openMain'), click: showMainWindow },
      {
        label: tf('tray.regionShot'),
        click: () => {
          // 窗口隐藏 / 屏幕抓取被拦时这里会抛，不能静默吞掉
          void Promise.resolve(requestRegionShot())
            .catch((err) => trayNotify(tf('tray.shotFailed'), err?.message || tf('tray.shotFailedDetail')))
            .finally(() => refreshMenu());
        },
      },
      {
        label: ctx.restartingServer ? tf('tray.restarting') : tf('tray.restartService'),
        enabled: !ctx.restartingServer,
        click: () => {
          void restartLocalServer().then((ok) => {
            if (ok) trayNotify(tf('tray.serviceRestarted'), tf('tray.serviceRestartedDetail'));
            refreshMenu();
          });
        },
      },
      {
        label: tf('tray.closeToTray'),
        type: 'checkbox',
        checked: getSettings().closeToTray !== false,
        click: async (item) => {
          const next = !!item.checked;
          // 先落本地快照：close 事件可能在这个请求返回前就触发，否则会「点一次不生效」
          setSettingsCache({ ...getSettingsSnapshot(), closeToTray: next });
          try {
            await fetchJson(
              `http://127.0.0.1:${ctx.serverPort}/api/settings`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ closeToTray: next }),
              },
              5000
            );
          } catch (err) {
            console.error('[tray] 保存托盘常驻设置失败：', err?.message || err);
            // 保存失败就回滚开关，别让界面显示的和实际行为不一致
            setSettingsCache({ ...getSettingsSnapshot(), closeToTray: !next });
            trayNotify(tf('tray.saveFailed'), err?.message || tf('tray.serviceNoResponse'));
            refreshMenu();
          }
        },
      },
      { type: 'separator' },
      {
        label: tf('tray.quit'),
        click: () => {
          ctx.forceQuit = true;
          app.quit();
        },
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    ctx.tray.setContextMenu(menu);
  };

  ctx.trayMenuRefresher = refreshMenu;
  ctx.tray.on('click', showMainWindow);
  refreshMenu();
  console.info('[tray] 托盘已就绪（左键打开窗口 / 右键菜单）');
}
