// @ts-check
/**
 * 热更的 IPC 与后台静默检查。
 *
 * 交互原则：**下载与换入全程静默，不需要用户点任何按钮或确认**。
 * 后台检查到新版就自动下载（默认 next），下次启动时由 boot() 自动换入，
 * 换入成功后只在启动完成后提示一次（见 main.js）。
 * 只有设置里改成「下载完立刻生效」时才会当场重启本地服务，并给一次结果反馈 ——
 * 热更不该在用户剪图剪到一半时自己重启。
 */
import { app, dialog } from 'electron';
import { getSettingsSnapshot } from '../settings-cache.js';
import { hotfix } from './hotfix-runtime.js';
import { handleIpc } from './ipc-base.js';
import { applyHotfixNow } from './service.js';
import { showToastBanner } from './toast.js';

/** 首次检查延后：别和应用启动抢 IO/带宽 */
const FIRST_DELAY = 8000;
/** 一轮没结果（无更新 / 失败）后的复查间隔 */
const IDLE_DELAY = 4 * 60 * 60 * 1000;

let timer = /** @type {NodeJS.Timeout | null} */ (null);
let running = false;

function schedule(delay) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void tick();
  }, delay);
  timer.unref?.();
}

async function tick() {
  try {
    await runCheck({ manual: false });
  } finally {
    schedule(IDLE_DELAY);
  }
}

/**
 * 检查一次。manual=true 时不看「启动时自动检查」开关（手动点击必须有效）。
 * @returns {Promise<{updated: boolean, seq?: number, notes?: string, error?: string}>}
 */
async function runCheck({ manual }) {
  if (running) return { updated: false, error: '正在检查' };
  const st = hotfix().state();
  if (!st.enabled) return { updated: false, error: '未配置热更公钥' };
  const prefs = getSettingsSnapshot();
  if (!manual && prefs.autoUpdateCheck === false) return { updated: false, error: '已关闭自动检查' };
  if (!manual && prefs.hotfixApply === 'manual') return { updated: false, error: '按设置不自动下载' };
  running = true;
  try {
    const res = await hotfix().check();
    if (!res.updated) return res;
    const mode = prefs.hotfixApply || 'next';
    // 默认（next）下载完一声不响：换入发生在下次启动，成功后才提示一次（见 main.js）。
    // 只有选了「下载完立刻生效」才当场切版本，这时候给一次结果反馈。
    if (mode === 'now') {
      const applied = await applyHotfixNow();
      if (applied.applied) {
        showToastBanner(`已更新到 #${res.seq}`, res.notes || '界面与服务脚本已切换到新版本');
      } else {
        // 当场生效失败不打扰用户：包还在本地，下次启动会再试一次
        console.warn('[hotfix] 立即生效失败：', applied.error || '未知原因');
      }
    }
    return res;
  } catch (err) {
    // 网络抖动是常态：只记日志，绝不弹窗
    console.warn('[hotfix] 检查失败：', err?.message || err);
    return { updated: false, error: String(err?.message || err) };
  } finally {
    running = false;
  }
}

/** 启动后台检查（只挂一次）。开发模式跳过：别去下正式热更包，也别污染 userData */
export function startHotfixCheck() {
  if (!app.isPackaged) return;
  if (timer) return;
  schedule(FIRST_DELAY);
}

export function stopHotfixCheck() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export function registerHotfixIpc() {
  handleIpc('hotfix-state', () => ({
    ...hotfix().state(),
    apply: getSettingsSnapshot().hotfixApply || 'next',
  }));

  handleIpc('hotfix-check', async () => {
    const res = await runCheck({ manual: true });
    if (res.updated) return { ok: true, updated: true, seq: res.seq, notes: res.notes || '' };
    return { ok: false, updated: false, error: res.error || '已是最新' };
  });

  handleIpc('hotfix-apply', () => applyHotfixNow());

  /** 完全断网时的后路：用户从群文件/U 盘拿到 zip，导入同样要过验签 */
  handleIpc('hotfix-import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入热更包',
      filters: [{ name: '热更包', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    const file = filePaths?.[0];
    if (canceled || !file) return { ok: false, error: '已取消' };
    const res = await hotfix().importZip(file);
    if (!res.updated) return { ok: false, error: res.error };
    return { ok: true, seq: res.seq, notes: res.notes };
  });
}
