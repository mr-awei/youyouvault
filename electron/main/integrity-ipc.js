// @ts-check
/**
 * 软件完整性自检的 IPC 与定时任务。
 *
 * 触发时机：
 * - 启动后 30 秒（不抢首屏 IO）
 * - 之后每 6 小时一次
 * - 设置页手动「立即校验」
 *
 * 发现缺失/损坏时：先提示一次（24 小时内不重复打扰），再自动走热更通道补文件。
 * 补包是已签名、只含 web/server 的增量包，**不会**后台下载或执行任何 exe ——
 * 后者恰恰是安全软件最敏感、最容易二次误报的行为。
 */
import path from 'node:path';
import { app } from 'electron';
import { hotfix } from './hotfix-runtime.js';
import { handleIpc } from './ipc-base.js';
import { showToastBanner } from './toast.js';
import { createIntegrity } from './integrity.js';

const FIRST_DELAY = 30_000;
const REPEAT_DELAY = 6 * 60 * 60 * 1000;
/** 同样的故障 24 小时内只弹一次，避免每次开机都提醒 */
const NOTIFY_GAP = 24 * 60 * 60 * 1000;

/** @type {ReturnType<typeof createIntegrity> | null} */
let instance = null;
let timer = /** @type {NodeJS.Timeout | null} */ (null);
let running = false;
let lastNotified = 0;

/** 热更生效时，实际运行的文件在 overlay 里；校验必须看「真正被加载的那份」 */
function activeServerRoot() {
  const st = hotfix().state();
  const root = hotfix().dir?.root;
  return st.activeSeq && root ? path.join(root, 'current', 'server') : path.join(app.getAppPath(), 'server');
}

function activeWebRoot() {
  const st = hotfix().state();
  const root = hotfix().dir?.root;
  return st.activeSeq && root ? path.join(root, 'current', 'web') : path.join(app.getAppPath(), 'dist', 'web');
}

function getIntegrity() {
  if (!instance) {
    instance = createIntegrity({
      appRoot: app.getAppPath(),
      serverRoot: activeServerRoot,
      webRoot: activeWebRoot,
      shellVersion: app.getVersion(),
      hotfix: hotfix(),
    });
  }
  return instance;
}

function describe(list) {
  return list
    .slice(0, 3)
    .map((x) => path.basename(String(x.path || '')))
    .join('、');
}

/**
 * 校验一次；manual=false 时发现问题的处理更主动（提示 + 自动补包）。
 * @param {{manual?: boolean}} [opts]
 */
async function verifyNow({ manual = false } = {}) {
  if (running) return getIntegrity().snapshot();
  running = true;
  try {
    const r = await getIntegrity().verify();
    const bad = r.missing.length + r.corrupted.length;
    if (bad > 0 && (manual || Date.now() - lastNotified > NOTIFY_GAP)) {
      lastNotified = Date.now();
      showToastBanner(
        `检测到 ${bad} 个文件缺失或被改动`,
        `${describe([...r.missing, ...r.corrupted])}… 正在尝试自动补回（多半是被安全软件隔离了）`
      );
      // 自动修复：只下载已签名的增量包，下次启动生效
      const fix = await getIntegrity().repair();
      if (!fix.ok) {
        showToastBanner('自动修复没成功', fix.note);
      }
    }
    return r;
  } catch (err) {
    return { ok: false, checked: 0, missing: [], corrupted: [], at: new Date().toISOString(), reason: `校验失败：${err?.message || err}` };
  } finally {
    running = false;
  }
}

function schedule(delay) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void verifyNow({ manual: false }).finally(() => schedule(REPEAT_DELAY));
  }, delay);
  timer.unref?.();
}

export function registerIntegrityIpc() {
  handleIpc('integrity-state', () => ({ ok: true, state: getIntegrity().snapshot() }));
  handleIpc('integrity-verify', async () => ({ ok: true, state: await verifyNow({ manual: true }) }));
  handleIpc('integrity-repair', async () => {
    const fix = await getIntegrity().repair();
    const state = await getIntegrity().verify();
    return { ok: true, fix, state };
  });
}

export function startIntegrityCheck() {
  // 开发模式下 dist/web 是上一次构建的产物，与清单天然对不上，定时自检只会制造噪音；
  // 设置页的「立即校验」仍然可用，方便验证这条链路。
  if (!app.isPackaged) return;
  schedule(FIRST_DELAY);
}

export function stopIntegrityCheck() {
  if (timer) clearTimeout(timer);
  timer = null;
}
