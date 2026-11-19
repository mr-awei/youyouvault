import { DEFAULT_STORAGE_DIR } from '../config.js';
import { settingsBus } from '../lib/settings-bus.js';
import { db, globalDb } from '../db.js';

/**
 * 跨库共享的设置键：永远存 global.db，所有库共用一份。
 * - theme / onboarded / updateRepo / autoLaunch / autoUpdateCheck：应用级偏好
 * - network：网络代理，对下载、AI 生效
 * 其余键（并发 / AI 开关 / 删除策略 / 画质增强 / 存储位置…）
 * 都按资源库独立存储——切库即切配置，互不串扰。
 * 注意：ai 是拆分键——接入配置（密钥/模型/baseUrl）共享，enabled 开关按库，见 getSettings/saveSettings。
 *
 * 必须声明在模块最前面：db.js 在模块求值时就会调用 seedLibrarySettings()（建默认库 / 打开库），
 * 那时它只保证「依赖模块已整体求值完」，不保证下面这些后续声明的顺序 —— 草稿位置放在
 * seedLibrarySettings 之后会触发 TDZ（Cannot access before initialization），
 * 表现为每个新库的初始设置都播种失败、静默退回默认值。
 *
 * 本模块与 db.js 是循环依赖（要读 live binding 的 db / globalDb）：模块顶层**不得**
 * 访问 db / globalDb，只能出现在函数体里，否则会在 db.js 求值完成前读到未初始化绑定。
 */
const GLOBAL_SETTING_KEYS = new Set([
  'theme',
  'onboarded',
  'tourDone',
  'updateRepo',
  'autoLaunch',
  'autoUpdateCheck',
  // 热更生效时机是应用级偏好：不该每个资源库各配一遍
  'hotfixApply',
  'network',
  'closeToTray',
  // 局域网投送是应用级能力，不该每个资源库各配一遍
  'lanAccess',
]);

/**
 * 库的 settings 表为空时，从 global.db 复制一份非全局键作为起点。
 * 设置分库是一次结构迁移：老用户的现有配置都攒在 global.db 里，
 * 每个存量库首次打开时播种一份，之后各自独立演进；新建库同样以这份快照起步。
 * 幂等：只在空表时执行（用户主动改过的库不会被覆盖）。
 */
export function seedLibrarySettings(conn) {
  try {
    const count = conn.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
    if (count > 0) return;
    const rows = globalDb
      .prepare('SELECT key, value FROM settings')
      .all()
      .filter((r) => !GLOBAL_SETTING_KEYS.has(r.key));
    if (!rows.length) return;
    const ins = conn.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
    for (const r of rows) ins.run(r.key, r.value);
  } catch (err) {
    console.warn('[settings] 库设置初始化失败（以默认值继续）:', err?.message || err);
  }
}

export const DEFAULT_SETTINGS = {
  minResolution: 800, // 长边最小像素
  minFileSize: 30, // 最小 KB
  phashThreshold: 8, // 汉明距离阈值
  importMaxDepth: 4, // 导入时目录遍历深度上限（层），超过的目录会跳过并在导入结束时提示
  // 导入命名模板：空 = 沿用内置「关键词_来源_尺寸_时间戳_随机」。
  // 拖拽 / 粘贴 / 手机投送 / 批量入库都按它落盘，原图不会被改名
  importNameTemplate: '',
  // 本地扫描默认原地登记；开启后才复制一份到保存文件夹并按模板命名，原文件始终不动
  importNameTemplateForLocal: false,
  // 调色台历史记录保留步数：调色是「反复试」的过程，默认留 100 步够回退一整轮试色
  historySteps: 100,
  maxFileSize: 25, // 单张最大 MB
  concurrency: 5,
  // 更新源（GitHub owner/repo）：设置页「检查更新」用，留空则提示未配置
  updateRepo: '',
  // 开机自启（桌面端）：应用启动时写入系统登录项
  autoLaunch: false,
  // 启动时自动检查更新（桌面安装版）：关掉后只在「设置 → 关于」手动检查
  autoUpdateCheck: true,
  // 热更（只换 web/ 与 server/，不含安装包）的生效时机：
  //   next = 下载好等下次启动 / now = 下载完立刻重启本地服务 / manual = 只在我点检查时下载
  hotfixApply: 'next',
  // 关窗行为（桌面端）：true = 收到托盘继续后台跑；false = 关窗即退出
  closeToTray: true,
  // 桌面端素材文件夹；当前激活库的素材根目录
  storageDir: DEFAULT_STORAGE_DIR,
  // 文件夹监控：往素材文件夹里丢文件即自动入库（fs.watch 递归监听，2s 防抖）
  watchEnabled: true,
  // 收件箱：上传 / 粘贴 / 手机投送的新素材先标记为「待整理」。
  // 文件夹扫描与本地批量导入不受影响；关掉后新素材直接进普通图库。
  inboxOnCapture: true,
  // 是否已完成首次引导（首次启动让用户选择图片文件夹）；完成后置 true 不再弹出
  onboarded: false,
  // 是否已看过教程（分步导览）；跳过也算看过，可在设置里重新播放
  tourDone: false,
  // 删除策略：trash 回收站 / permanent 彻底删除 / unlink 仅移出图库
  deletePolicy: 'trash',
  // 局域网 / 手机扫码投送：默认关闭。开启时另起独立端口 + 独立小权限令牌，主服务仍只绑 127.0.0.1
  lanAccess: false,
  // 智能评分：低于该分数的图片在导入时提示
  scoreThreshold: 40,
  // AI 打标后自动按智能文件夹规则归类（打标 → 自动分类 的联动）
  autoSmartFolder: true,
  // 网络代理（走 Chromium 网络栈，AI / 下载统一生效）
  network: {
    mode: 'off', // off | system | http | https | socks5 | socks4
    host: '127.0.0.1',
    port: 7890,
    username: '',
    password: '',
    bypass: '<local>',
  },
  // 界面主题：light 明亮（默认）/ dark 暗色
  theme: 'light',
  // 画质增强：低于标准的图片自动收录，可一键增强至标准以上
  enhance: {
    standard: '1080p', // 目标标准（低于该分辨率的图片视为待增强）：480p|720p|1080p|2k|4k|custom
    customWidth: 1920, // standard='custom' 时生效
    customHeight: 1080,
    model: 'sharp-standard', // 默认增强模型（见 server/enhance.js 内置模型）
    remoteServices: [], // 用户配置的线上免费增强服务（可选，软件负责上传/下载/覆盖原文件）
  },
  // 非破坏性编辑：开着时裁切/旋转/调色只记操作链，原图保持字节不变，
  // 浏览与下载套用渲染结果；「应用到底片」或关闭模式时才真正写回。默认关（沿用原有行为）。
  nonDestructiveEdit: false,
  // AI 接入（OpenAI 兼容）
  ai: {
    enabled: false,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    visionModel: '',
  },
};

// 默认不预置任何关键词——软件是通用图库，文件名里的关键词由用户自己填。

let settingsCache = null;

/** 切库后调用：storageDir 随库变化，缓存必须失效 */
export function resetSettingsCache() {
  settingsCache = null;
}

export function getSettings() {
  // 热路径缓存：getSettings 在服务端被高频调用（请求、调度、AI 流程内部都有），
  // 每次全表 SELECT + JSON.parse + 解密纯属浪费。写路径统一走 saveSettings，会同步失效缓存。
  if (settingsCache) return structuredClone(settingsCache);
  const stored = {};
  const readRows = (rows) => {
    for (const row of rows) {
      try {
        stored[row.key] = JSON.parse(row.value);
      } catch {
        stored[row.key] = row.value;
      }
    }
  };
  // 当前库的设置（AI 开关 / 存储位置…按库独立）
  readRows(db.prepare('SELECT key, value FROM settings').all());
  // 共享键以 global.db 为准（主题 / 引导 / 自启 / 更新源 / 网络代理）
  readRows(
    globalDb
      .prepare('SELECT key, value FROM settings')
      .all()
      .filter((r) => GLOBAL_SETTING_KEYS.has(r.key))
  );
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // ai 拆分键：接入配置（provider/baseUrl/apiKey/model/visionModel）跨库共享存 global.db；
  // enabled（智能评分开关）按库独立存各库。两侧行都可能是旧的全量格式，显式合并。
  const libAi = stored.ai && typeof stored.ai === 'object' ? stored.ai : {};
  delete stored.ai;
  let sharedAi = {};
  try {
    sharedAi = JSON.parse(globalDb.prepare("SELECT value FROM settings WHERE key='ai'").get()?.value || '{}');
  } catch {
    /* 忽略坏行，走默认值 */
  }
  if (typeof sharedAi !== 'object' || !sharedAi) sharedAi = {};
  merged.ai = {
    ...DEFAULT_SETTINGS.ai,
    ...sharedAi,
    // enabled 权威在库行；库行没有（新库/旧数据）时退回共享行的快照，最后到默认值
    enabled: libAi.enabled ?? sharedAi.enabled ?? DEFAULT_SETTINGS.ai.enabled,
  };
  settingsCache = merged;
  return structuredClone(settingsCache);
}

export function saveSettings(patch) {
  const current = getSettings();
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // 脱敏辅助字段（服务端生成，不入库）
    if (k === 'hasAiApiKey') continue;
    // 数组整体替换，别按对象合并——展开数组会变成 {"0":…} 的怪东西
    if (Array.isArray(v)) {
      next[k] = v;
    } else if (typeof DEFAULT_SETTINGS[k] === 'object' && v && typeof v === 'object') {
      next[k] = { ...DEFAULT_SETTINGS[k], ...current[k], ...v };
    } else {
      next[k] = v;
    }
  }
  // AI API Key 保护规则：空串 = 未修改，不能清掉真实凭据
  if (patch.aiApiKeyClear) {
    next.ai = { ...(next.ai || {}), apiKey: '' };
  } else if (next.ai && !String(next.ai.apiKey || '').trim()) {
    next.ai = { ...next.ai, apiKey: current.ai?.apiKey || '' };
  }
  const upsertLib = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const upsertGlobal = globalDb.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(next)) {
    // 指令键只用于本次保存，不落库
    if (k === 'aiApiKeyClear') continue;
    // ai 拆分写入：接入配置（密钥/模型/baseUrl）写 global.db 供所有库共享，
    // enabled（智能评分开关）写当前库——每库自己决定开不开 AI 评分。
    // global 行附带 enabled 快照，供新库播种时继承「最近一次的开关状态」。
    if (k === 'ai') {
      const { enabled, ...sharedAi } = v && typeof v === 'object' ? v : {};
      upsertGlobal.run('ai', JSON.stringify({ ...sharedAi, enabled: !!enabled }));
      upsertLib.run('ai', JSON.stringify({ enabled: !!enabled }));
      continue;
    }
    // 共享键写回 global.db（跨库共用一份），其余写入当前库的 settings 表
    if (GLOBAL_SETTING_KEYS.has(k)) upsertGlobal.run(k, JSON.stringify(v));
    else upsertLib.run(k, JSON.stringify(v));
  }
  settingsCache = null; // 下次读取重建缓存
  // 通知订阅方（Electron 主进程：storageDir / 代理 / 开机自启这些本地能力要跟着改）
  try {
    settingsBus.emit('changed', getSettings());
  } catch (err) {
    console.error('[settings] 广播设置变更失败', err.message);
  }
  return next;
}
