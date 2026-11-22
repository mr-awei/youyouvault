/**
 * 前端请求层的地基：token、超时、错误封装、desktop 桥、下载/复制、体积/日期格式化。
 * 各域模块（api/*.ts）都从这里拿 request/BASE/quiet，不再各自造一套。
 */
import type { AppInfo, DesktopAPI } from './types';
import type { Filters, ImageItem } from '../types';
export const desktop = (window as unknown as { desktopAPI?: DesktopAPI }).desktopAPI;
export const isDesktop = !!desktop;
import i18n, { currentLocale } from '../i18n';

/** 桌面端信息（浏览器模式返回 null） */
export async function getAppInfo(): Promise<AppInfo | null> {
  try {
    return (await desktop?.appInfo?.()) || null;
  } catch {
    return null;
  }
}

/** 检查更新结果（桌面端） */
/** 把 Electron 加速键文本转成更好读的写法：CommandOrControl+Alt+Shift+W → Ctrl+Alt+Shift+W */
export function prettyHotkey(acc?: string) {
  if (!acc) return '';
  return acc
    .replace('CommandOrControl', 'Ctrl')
    .replace('Control', 'Ctrl')
    .split('+')
    .join('+');
}

/**
 * 复制纯文本到剪贴板。返回是否成功——调用方据此给「已复制 / 复制失败」，
 * 不再每个组件各写一份 try/catch 与各自的成功文案。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 下载文件。
 * 桌面端走 Electron 下载管理器（弹「另存为」），避免 window.open 拉出空白窗口；
 * 网页端退回 a[download] 点击。
 */
export function downloadFile(url: string) {
  if (desktop?.download) return desktop.download(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return Promise.resolve(true);
}

/**
 * 把图片复制到系统剪贴板（对标 Eagle 的 Ctrl+C），可直接粘到微信/PPT/聊天框。
 * 统一先转成 PNG 再写剪贴板：Chrome/Electron 只接受 image/png 的 ClipboardItem。
 */
export async function copyImageToClipboard(url: string) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error(i18n.t('ka4b82856'));
  }
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(i18n.t('kb3b83e12')));
    el.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(i18n.t('k2352bf26'));
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(i18n.t('k760db351')))), 'image/png');
  });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** 单张格式转换导出的下载地址（实际下载交给 downloadFile，桌面端会弹「另存为」） */
export function exportImageUrl(id: number, opts: { format: string; quality?: number; maxSide?: number }) {
  const q = new URLSearchParams({ format: opts.format });
  if (opts.quality) q.set('quality', String(opts.quality));
  if (opts.maxSide) q.set('maxSide', String(opts.maxSide));
  return `/api/images/${id}/export?${q.toString()}`;
}

/** HTML 网页画廊导出地址：单文件、缩略图内嵌，可离线打开或丢到静态服务器 */
export function galleryExportUrl(opts: {
  scope?: 'all' | 'folder';
  folderId?: number | null;
  ids?: number[];
  title?: string;
  columns?: number;
  theme?: 'auto' | 'light' | 'dark';
  maxItems?: number;
}) {
  const q = new URLSearchParams();
  if (opts.scope) q.set('scope', opts.scope);
  if (opts.folderId) q.set('folderId', String(opts.folderId));
  if (opts.ids?.length) q.set('ids', opts.ids.join(','));
  if (opts.title) q.set('title', opts.title);
  if (opts.columns) q.set('columns', String(opts.columns));
  if (opts.theme) q.set('theme', opts.theme);
  if (opts.maxItems) q.set('maxItems', String(opts.maxItems));
  return `/api/export/gallery?${q.toString()}`;
}

/**
 * 批量打包导出的下载地址。
 * 传 format 时服务端逐张重编码（等价 Eagle 的「导出为 JPEG/PNG…」），不传则原样打包。
 */
export function exportZipUrl(ids: number[], opts: { format?: string; quality?: number; maxSide?: number } = {}) {
  const q = new URLSearchParams({ ids: ids.join(',') });
  if (opts.format) q.set('format', opts.format);
  if (opts.quality) q.set('quality', String(opts.quality));
  if (opts.maxSide) q.set('maxSide', String(opts.maxSide));
  return `/api/download/zip?${q.toString()}`;
}

/** 打开系统文件夹（桌面端走 Electron，网页端走服务端） */
export async function openFolder(path?: string) {
  if (desktop && !path) return desktop.openFolder('');
  return request<{ ok: boolean }>('/api/system/open-folder', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

/**
 * 打开某个文件夹对应的磁盘目录。
 * 只传 id，真实路径由服务端按 anchor_path 解析（前端拿不到 storageDir，也不该拿）。
 * 纯虚拟夹没有磁盘目录，服务端回 409，这里抛给调用方去提示。
 */
export async function openFolderById(folderId: number) {
  return request<{ ok: boolean; path: string }>('/api/system/open-folder', {
    method: 'POST',
    body: JSON.stringify({ folderId }),
  });
}

export async function revealFile(path: string) {
  if (desktop) return desktop.revealFile(path);
  return request<{ ok: boolean }>('/api/system/reveal', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

export async function pickFolder() {
  if (!desktop) return null;
  return desktop.pickFolder();
}

/**
 * 保存应用内编辑过的办公文档（xlsx / csv / docx / pptx / txt / md）。
 * 与普通 JSON 接口不同，这里直接 POST 原始字节；服务端会校验素材类型再原子写回。
 */
export async function saveOfficeFile(
  id: number,
  bytes: Uint8Array
): Promise<{ ok: boolean; item?: ImageItem }> {
  const token = await getApiToken();
  const res = await fetch(`${BASE}/api/images/${id}/office`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: bytes as unknown as BodyInit,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; item?: ImageItem };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { ok: true, item: data.item };
}

export const BASE = (import.meta.env.VITE_API_BASE as string) || '';

/**
 * 静默但可见的错误兜底：替代裸 `.catch(() => {})`。
 * 失败不能只写一行 console —— 那会让「请求挂了」在界面上表现为「没有数据」，
 * 用户以为图库空了。现在除了记日志，还会通知订阅者（App 全局错误条）。
 */
type ApiErrorListener = (err: Error) => void;
const apiErrorListeners = new Set<ApiErrorListener>();

/** 订阅后台请求失败（返回取消订阅函数） */
export function onApiError(cb: ApiErrorListener) {
  apiErrorListeners.add(cb);
  return () => {
    apiErrorListeners.delete(cb);
  };
}

export const quiet = (err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  console.warn('[quiet]', e.message);
  for (const cb of apiErrorListeners) {
    try {
      cb(e);
    } catch {
      /* 订阅者自己出错不该反噬请求链 */
    }
  }
};

/** 默认请求超时：本地服务正常毫秒级返回，20s 已远超正常波动 */
const DEFAULT_TIMEOUT_MS = 20000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 网络层错误翻译。fetch 在连不上服务时只会抛 `TypeError: Failed to fetch`，
 * 用户看到的英文关键字既不知道哪坏了、也不知道怎么办 —— 本地服务其实就两种可能：
 * 进程退出了，或者端口被别的程序抢了。
 */
function networkError(err: unknown, path: string): Error {
  if (err instanceof TypeError) {
    return new Error(i18n.t('kf87b09ba', { p0: path }));
  }
  return err as Error;
}

/**
 * 本地 API 鉴权令牌：桌面端经 preload 注入；纯浏览器模式从 ?token= 读取后
 * 存入 localStorage（服务端启动时打印带令牌的访问地址）。
 */
let tokenCache = '';
export async function getApiToken(): Promise<string> {
  if (tokenCache) return tokenCache;
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    tokenCache = fromUrl;
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    try {
      localStorage.setItem('tuku_api_token', fromUrl);
    } catch {
      /* 隐私模式等场景忽略 */
    }
    return tokenCache;
  }
  try {
    tokenCache = localStorage.getItem('tuku_api_token') || '';
  } catch {
    tokenCache = '';
  }
  if (tokenCache) return tokenCache;
  try {
    tokenCache = (await desktop?.getApiToken?.().catch(() => '')) || '';
  } catch {
    tokenCache = '';
  }
  if (tokenCache) {
    try {
      localStorage.setItem('tuku_api_token', tokenCache);
    } catch {
      /* ignore */
    }
  }
  return tokenCache;
}

/**
 * 带状态码与业务错误码的接口错误。
 * 有些失败不能只当一句文案：切到加密库时服务端回 423 + code=library_locked，
 * 意思是「这个库有密码、本次运行还没解锁」——界面该弹密码框，而不是丢一句 toast
 * 让用户去重启（v1.2.14 的库锁串台就是这个表现）。`.message` 与原先的 plain Error
 * 完全一致，现存的 catch 不需要改。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = RequestInit & { timeoutMs?: number; retries?: number };

export async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  const token = await getApiToken();
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {}),
  };
  headers['Accept-Language'] = currentLocale();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries, ...fetchInit } = init ?? {};
  // GET 默认重试 1 次（网络抖动 / 5xx）；写操作不自动重试，避免重复副作用
  const maxRetries = retries ?? (fetchInit.method && fetchInit.method !== 'GET' ? 0 : 1);
  const external = fetchInit.signal;

  let attempt = 0;
  for (;;) {
    const timedOut = { v: false };
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      timedOut.v = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort();
    if (external?.aborted) ctrl.abort();
    else external?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(BASE + path, { ...fetchInit, headers, signal: ctrl.signal });
      if (!res.ok) {
        // 401 单独说清楚：令牌存在 localStorage / preload 里，服务端重启换了令牌时
        // 后面每个请求都会 401，笼统的「请求失败 401」根本没法据此排查
        if (res.status === 401) throw new Error(i18n.t('kb54b9280'));
        if (res.status === 403) throw new Error(i18n.t('k61e3699e'));
        let message = i18n.t('k6b43688f', { p0: res.status });
        let code = '';
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
          if (typeof data?.code === 'string') code = data.code;
          // 423 只有两种情况：当前库锁着（activeLibraryLocked），或切到加密库缺密码。
          // 只有前者要把整页切到解锁界面，后者由切库对话框自己提示，别把用户踢出当前库
          if (res.status === 423 && data?.activeLibraryLocked) {
            window.dispatchEvent(new CustomEvent('tuku:library-locked'));
          }
        } catch {
          /* ignore */
        }
        if (attempt < maxRetries && res.status >= 500) {
          attempt++;
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new ApiError(message, res.status, code);
      }
      // 204 / 空 body 是合法的成功响应（DELETE 之类），无条件 res.json() 会抛
      // SyntaxError → 被下面翻译成「服务端返回了无效数据」，成功的操作反而报错
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!text.trim()) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(i18n.t('k56447f78'));
      }
    } catch (err) {
      // 调用方主动取消：原样抛出，绝不重试
      if (external?.aborted) throw err;
      // 超时 / 网络级失败（fetch 抛 TypeError）才重试；JSON 解析错误、HTTP 错误不重试
      const retryable = attempt < maxRetries && (timedOut.v || err instanceof TypeError);
      if (retryable) {
        attempt++;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (timedOut.v) throw new Error(i18n.t('ke88692c1', { p0: Math.round(timeoutMs / 1000), p1: path }));
      if (err instanceof SyntaxError) throw new Error(i18n.t('k56447f78'));
      throw networkError(err, path);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }
}

export function buildQuery(filters: Filters, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.source.length) params.set('source', filters.source.join(','));
  if (filters.favorite !== 'all') params.set('favorite', filters.favorite);
  if (filters.orientation !== 'all') params.set('orientation', filters.orientation);
  if (filters.bucket.length) params.set('bucket', filters.bucket.join(','));
  if (filters.tag) params.set('tag', filters.tag);
  if (filters.seen && filters.seen !== 'all') params.set('seen', filters.seen);
  if (filters.minRating) params.set('minRating', String(filters.minRating));
  if (filters.hue) params.set('hue', filters.hue);
  if (filters.colorHex) {
    params.set('colorHex', filters.colorHex);
    params.set('colorTol', String(filters.colorTol ?? 48));
  }
  if (filters.kind && filters.kind !== 'all') params.set('kind', filters.kind);
  if (filters.pending) params.set(filters.pending, '1');
  if (filters.colorLabel) params.set('colorLabel', filters.colorLabel);
  params.set('sort', filters.sort || 'newest');
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return params.toString();
}

/** 给直链追加令牌（<img src>、下载链接等无法自定义 header 的场景） */
export async function withToken(url: string) {
  const token = await getApiToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/**
 * 体积格式化：全站唯一实现（以前有 5 份各自四舍五入，同一个文件在不同页面显示不同数字）。
 * 0 → '0 B'；10 以下保留一位小数（1.5 MB），10 以上取整（128 MB）。
 */
export function formatSize(bytes: number) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export const SOURCE_LABELS: Record<string, string> = {
  local: i18n.t('ke2d96131'),
  lan: i18n.t('k102f36ba'),
};

export const BUCKET_LABELS: Record<string, string> = {
  sd: '< 1080p',
  fhd: '1080p - 2K',
  '2k': '2K - 4K',
  '4k': '4K+',
};

export const ORIENTATION_LABELS: Record<string, string> = {
  portrait: i18n.t('kf02ee187'),
  landscape: i18n.t('k2cfab0df'),
  square: i18n.t('k5c036336'),
};
