// @ts-check
/**
 * 全局快捷键：别的窗口聚焦时也能打开窗口或截图。
 * 默认键可能被其它软件占用，这里按候选顺序回退，并把实际生效的键回传给界面。
 */
import { globalShortcut } from 'electron';
import { getSettingsSnapshot as getSettings } from '../settings-cache.js';
import { ctx } from './context.js';
import { requestRegionShot } from './shot.js';
import { showToastBanner } from './toast.js';
import { showMainWindow } from './windows.js';

export function registerGlobalShortcuts() {
  if (getSettings().globalShortcuts === false) {
    console.info('[shortcut] 已按设置关闭全局快捷键');
    return;
  }
  for (const k of Object.keys(ctx.failedHotkeys)) delete ctx.failedHotkeys[k];
  const handlers = {
    window: showMainWindow,
    screenshot: () => requestRegionShot(),
  };
  const candidates = {
    window: ['CommandOrControl+Alt+G', 'CommandOrControl+Alt+Shift+G', 'CommandOrControl+Shift+F12'],
    screenshot: ['CommandOrControl+Shift+S', 'CommandOrControl+Alt+S', 'CommandOrControl+Shift+F8'],
  };
  for (const [action, list] of Object.entries(candidates)) {
    for (const acc of list) {
      try {
        if (globalShortcut.register(acc, handlers[action])) {
          ctx.registeredHotkeys[action] = acc;
          break;
        }
      } catch (err) {
        console.warn('[shortcut] 注册异常：', acc, err?.message || err);
      }
    }
    if (!ctx.registeredHotkeys[action]) {
      // 以前只写一行 console：用户在设置里看到「已启用」，按下去毫无反应
      ctx.failedHotkeys[action] = list.join(' / ');
    }
  }
  const failedActions = Object.keys(ctx.failedHotkeys);
  if (failedActions.length) {
    const names = { window: '打开窗口', screenshot: '截图' };
    const detail = failedActions.map((a) => `${names[a] || a}（${ctx.failedHotkeys[a]}）`).join('、');
    console.warn('[shortcut] 以下快捷键候选键全部被占用：', detail);
    showToastBanner('部分快捷键没能注册', `${detail} 已被其他程序占用，可在设置里看到具体冲突键。`);
  }
  console.info('[shortcut] 已注册：', JSON.stringify(ctx.registeredHotkeys));
}

/**
 * 重新注册全部全局快捷键。
 * 以前只在启动时注册一次：用户在设置里关掉「全局快捷键」后照样被拦按键，
 * 打开后又要重启应用才生效。现在设置变更时直接走这里，注销 → 清空 → 重注册。
 */
export function refreshGlobalShortcuts() {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    console.warn('[shortcut] 注销旧快捷键失败：', err?.message || err);
  }
  for (const k of Object.keys(ctx.registeredHotkeys)) delete ctx.registeredHotkeys[k];
  for (const k of Object.keys(ctx.failedHotkeys)) delete ctx.failedHotkeys[k];
  registerGlobalShortcuts();
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    // 让设置页显示的「实际生效键位 / 冲突键位」立刻跟上
    ctx.mainWindow.webContents.send('hotkeys-changed', {
      hotkeys: ctx.registeredHotkeys,
      failed: ctx.failedHotkeys,
    });
  }
}

/** 退出前注销全部全局快捷键 */
export function unregisterGlobalShortcuts() {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    console.warn('[shortcut] 退出前注销失败：', err?.message || err);
  }
}
