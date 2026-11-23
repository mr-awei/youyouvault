// @ts-check
/**
 * OMS（sit.uyoyous.com）客户端：登录、按 5 位主 SKU 查「待拍摄」需求。
 *
 * 现场流程：摄影师拍完条码后，系统 OCR 只能拿到 5 位主 SKU（如 45661），
 * 完整编码（45661-Y01Y0001-QD08）在 OMS 的 salesSku 字段里。所以这里负责：
 *   1. 每个摄影师配置自己的 OMS 账号（账号密码存在本机 data 目录，不回传前端）；
 *   2. 登录拿 access_token 并缓存，过期或 401 时自动重登；
 *   3. 按 mainSkuId + shootStatus=1（待拍摄）查询，返回完整 salesSku。
 *
 * 后续「上传后台」也复用同一个 token，不要再各写一套登录。
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const DEFAULT_BASE_URL = 'https://sit.uyoyous.com';
const API_PREFIX = '/oms-test-api';
/** OMS 前端写死的客户端 id，不是密钥，登录时必须带 */
const CLIENT_ID = 'e5cd7e4891bf95d1d19206ce24a7b32e';
const ACCOUNT_FILE = path.join(DATA_DIR, 'oms-account.json');
/** visual_design_shoot_status：1 = 待拍摄 */
const SHOOT_STATUS_PENDING = '1';

/** 规范化 base URL：只允许 http/https，去掉尾部斜杠 */
export function normalizeBaseUrl(input) {
  const raw = String(input || '').trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OMS 地址不合法：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OMS 地址必须以 http:// 或 https:// 开头');
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * 从 OMS 返回的多行里挑出可用于建文件夹的完整编码。
 * 同一条 salesSku 可能重复出现（同 SKU 多道工序），先按编码去重。
 * 偶尔一个单元格塞了多个编码（换行 / 空格 / 逗号分隔），要拆开——否则会拼成一个
 * 不存在的文件夹名。
 */
export function uniqueSalesSkus(rows) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const parts = String(row?.salesSku || '')
      .split(/[\s,，;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sku of parts) {
      if (seen.has(sku)) continue;
      seen.add(sku);
      out.push({
        /** 行 id（视觉拍摄列表的质检/送拍行） */
        id: row?.id != null ? String(row.id) : row?.shootingItemId != null ? String(row.shootingItemId) : '',
        salesSku: sku,
        productName: String(row?.productName || ''),
        // 视觉拍摄页把采购单/送拍单放在 poNo / documentNo
        billNo: String(row?.documentNo || row?.poNo || row?.billNo || ''),
        shootStatus: String(row?.shootingType || row?.shootStatus || ''),
        status: String(row?.status || ''),
      });
    }
  }
  return out;
}

/**
 * 带一次重试的 fetch。
 * SIT 环境偶尔会出现 10 秒连接超时（同一地址 curl 正常），重试一次基本能过；
 * 每次都用新的 AbortSignal，避免第一次超时后信号已中止。
 */
async function fetchRetry(url, init, timeoutMs = 20000, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

class OmsClient {
  constructor() {
    /** @type {{username:string,password:string,baseUrl:string}|null} */
    this.account = null;
    this.accountLoaded = false;
    /** 正在读账号文件的 Promise：license.js 在模块加载时就调用 loadAccount()，
     *  恢复登录若在这期间进来，必须等同一次读取完成，不能看到「已加载但还没读到」的空账号。 */
    this.accountLoading = null;
    /** @type {{token:string,expiresAt:number}|null} */
    this.session = null;
    /** @type {Promise<any>|null} */
    this.loginPromise = null;
    this.lastError = '';
    /** 启动时的「记住登录」只尝试一次，避免每次状态查询都去打 OMS */
    this.restored = false;
  }

  accountPath() {
    return ACCOUNT_FILE;
  }

  loadAccount() {
    if (this.accountLoaded) return Promise.resolve(this.account);
    if (this.accountLoading) return this.accountLoading;
    this.accountLoading = (async () => {
      try {
        const raw = await fsp.readFile(ACCOUNT_FILE, 'utf8');
        const obj = JSON.parse(raw);
        if (obj?.username && obj?.password) {
          this.account = {
            username: String(obj.username).trim(),
            password: String(obj.password),
            baseUrl: normalizeBaseUrl(obj.baseUrl),
          };
        }
      } catch (err) {
        // 没配置过账号是正常状态，别在启动日志里刷 ENOENT；其它错误才值得记
        if (err?.code !== 'ENOENT') {
          console.warn('[oms] 读取账号文件失败', err instanceof Error ? err.message : String(err));
        }
      }
      // 读完了才置位：启动恢复登录会在 await 这里等到真正的账号
      this.accountLoaded = true;
      this.accountLoading = null;
      return this.account;
    })();
    return this.accountLoading;
  }

  async saveAccount({ username, password, baseUrl }) {
    const user = String(username || '').trim();
    const pass = String(password || '');
    if (!user) throw new Error('请填写 OMS 账号');
    if (!pass) throw new Error('请填写 OMS 密码');
    const base = normalizeBaseUrl(baseUrl);

    // 先登录验证，成功后才落盘，避免把原来能用的账号覆盖成错密码
    const probe = new OmsClient();
    probe.account = { username: user, password: pass, baseUrl: base };
    probe.accountLoaded = true;
    probe.accountLoading = Promise.resolve(probe.account);
    await probe.login(true);

    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(ACCOUNT_FILE, JSON.stringify({ username: user, password: pass, baseUrl: base }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      await fsp.chmod(ACCOUNT_FILE, 0o600);
    } catch {
      /* Windows 下 chmod 基本无效，忽略 */
    }

    this.account = { username: user, password: pass, baseUrl: base };
    this.accountLoaded = true;
    this.accountLoading = null;
    this.session = probe.session;
    this.lastError = '';
    return this.status();
  }

  async clearAccount() {
    this.account = null;
    this.accountLoaded = true;
    this.accountLoading = null;
    this.session = null;
    this.lastError = '';
    try {
      await fsp.rm(ACCOUNT_FILE, { force: true });
    } catch {
      /* ignore */
    }
    return this.status();
  }

  async status() {
    await this.loadAccount();
    return { ...this.sessionSnapshot(), baseUrl: this.account?.baseUrl || DEFAULT_BASE_URL };
  }

  /**
   * 同步会话快照（不触网、不读盘），给授权状态实时判断用。
   * token 过期后 loggedIn 立刻变 false，专业版随之关闭，直到用户重新登录。
   */
  sessionSnapshot() {
    const s = this.session;
    return {
      configured: !!this.account,
      username: this.account?.username || '',
      loggedIn: !!s && s.expiresAt > Date.now(),
      expiresAt: s?.expiresAt || 0,
      error: this.lastError,
    };
  }

  /** 会话失效：清掉 token，授权层会立刻退回免费版 */
  invalidateSession(reason = 'OMS 登录已失效') {
    this.session = null;
    this.lastError = reason;
  }

  /**
   * 启动时恢复登录：token 只存在内存里，程序一退出就没了；而账号密码本来就已经
   * 保存在本机 data 目录。所以用保存的账号重新登录一次，就是「记住登录」。
   *
   * 注意与运行中 401 的区别：运行中会话失效必须立刻退回免费版、不静默重登；
   * 只有「刚启动、内存里还没有任何会话」时才走这里。失败也只记录错误，
   * 不清账号、不阻塞启动，用户仍可手动登录。
   */
  async restoreSession() {
    if (this.restored) return this.session || null;
    this.restored = true;
    const account = await this.loadAccount();
    if (!account) return null;
    if (this.session && this.session.expiresAt > Date.now()) return this.session;
    try {
      return await this.login(true);
    } catch (err) {
      this.lastError = `自动恢复登录失败：${err instanceof Error ? err.message : String(err)}`;
      console.warn('[oms] 自动恢复登录失败', this.lastError);
      return null;
    }
  }

  /** 登录并缓存 token；并发调用共享同一个 Promise，避免连续扫码时重复登录 */
  async login(force = false) {
    const account = await this.loadAccount();
    if (!account) throw new Error('尚未配置 OMS 账号');
    if (!force && this.session && this.session.expiresAt > Date.now()) return this.session;
    if (!force && this.loginPromise) return this.loginPromise;

    const run = (async () => {
      const body = JSON.stringify({
        username: account.username,
        password: account.password,
        clientId: CLIENT_ID,
        grantType: 'password',
      });
      let res;
      try {
        res = await fetchRetry(
          `${account.baseUrl}${API_PREFIX}/oms-admin/auth/login`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=utf-8', clientid: CLIENT_ID },
            body,
          },
          20000
        );
      } catch (err) {
        throw new Error(`连接 OMS 失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.code !== 200 || !json?.data?.access_token) {
        throw new Error(json?.msg || `OMS 登录失败（HTTP ${res.status}）`);
      }
      const expireIn = Number(json.data.expire_in) || 600;
      this.session = {
        token: String(json.data.access_token),
        // 提前 2 分钟过期，避免边界上刚好失效
        expiresAt: Date.now() + Math.max(60, expireIn - 120) * 1000,
      };
      this.lastError = '';
      return this.session;
    })();

    this.loginPromise = run;
    try {
      return await run;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.loginPromise = null;
    }
  }

  /**
   * 调 OMS 接口。RuoYi 的失败一般也是 HTTP 200 + code!==200，
   * 所以这里同时看 HTTP 状态和业务 code；401 自动重登一次。
   * @param {string} pathname
   * @param {{method?: string, params?: Record<string, string>, data?: any}} [options]
   */
  async request(pathname, { method = 'GET', params, data } = {}) {
    const account = await this.loadAccount();
    if (!account) throw new Error('尚未配置 OMS 账号');

    /** @param {string} token */
    const send = async (token) => {
      const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
      const res = await fetchRetry(
        `${account.baseUrl}${API_PREFIX}${pathname}${qs}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json;charset=utf-8',
            clientid: CLIENT_ID,
            Authorization: `Bearer ${token}`,
          },
          body: data === undefined ? undefined : JSON.stringify(data),
        },
        30000
      );
      const json = await res.json().catch(() => null);
      return { res, json };
    };

    const { res, json } = await send((await this.login()).token);
    if (res.status === 401 || json?.code === 401) {
      // 网站要求重新登录 → 清掉本地 token，退回免费版。
      // 不再静默重登：否则用户不知道会话已经失效，Pro 会在后台悄悄续上。
      this.invalidateSession('OMS 登录已失效');
      throw new Error('OMS 登录已失效，请重新登录');
    }
    if (!res.ok || json?.code !== 200) {
      throw new Error(json?.msg || `OMS 接口异常（HTTP ${res.status}）`);
    }
    return json;
  }

  /**
   * 有些接口（如 OSS 签名）不包 code/data，直接返回根对象。
   * @param {string} pathname
   * @param {{method?: string, params?: Record<string, string>}} [options]
   */
  async rawRequest(pathname, { method = 'GET', params } = {}) {
    const account = await this.loadAccount();
    if (!account) throw new Error('尚未配置 OMS 账号');
    const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
    const res = await fetchRetry(
      `${account.baseUrl}${API_PREFIX}${pathname}${qs}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          clientid: CLIENT_ID,
          Authorization: `Bearer ${(await this.login()).token}`,
        },
      },
      30000
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.msg || `OMS 接口异常（HTTP ${res.status}）`);
    return json;
  }

  /** 产品图库：按完整 SKU 读后台记录（displayName / 已上传图片） */
  async getProductGallery(sku) {
    const s = String(sku || '').trim();
    if (!s) return null;
    const json = await this.request(`/oms-admin/visual/designOss/busi/${encodeURIComponent(s)}`, {
      method: 'GET',
    });
    return json?.data || null;
  }

  /**
   * 直接上传一张图到 OSS（POST policy）。
   * 返回 { key, url, originalName, ext }；不写库，写库由 saveProductGalleryFiles 完成。
   */
  async uploadOssFile(filePath, originalName) {
    const buf = await fsp.readFile(filePath);
    // 后台签名 policy 的 content-length-range 上限是 10MB
    if (buf.length > 10 * 1024 * 1024) {
      throw new Error(`图片超过 OSS 10MB 限制：${path.basename(filePath)}`);
    }
    const sig = await this.rawRequest('/oms-admin/get_post_signature_for_oss_upload', { method: 'GET' });
    if (!sig?.host || !sig?.policy || !sig?.signature) throw new Error('获取 OSS 上传签名失败');
    const name = String(originalName || path.basename(filePath));
    const ext = (path.extname(name).slice(1) || 'jpg').toLowerCase();
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    const dir = String(sig.dir || '').replace(/^\/+|\/+$/g, '');
    const key = dir ? `${dir}/${hash}.${ext}` : `${hash}.${ext}`;
    const form = new FormData();
    form.append('key', key);
    form.append('policy', sig.policy);
    form.append('x-oss-signature-version', sig.version);
    form.append('x-oss-credential', sig.credential);
    form.append('x-oss-date', sig.ossdate);
    form.append('x-oss-security-token', sig.token);
    form.append('x-oss-signature', sig.signature);
    form.append('success_action_status', '200');
    form.append('file', new Blob([buf]), name);
    const res = await fetch(sig.host, { method: 'POST', body: form });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OSS 上传失败（HTTP ${res.status}）${text.slice(0, 200)}`);
    }
    return {
      key,
      url: `https://image.uyoyous.com/youyou-prod/${key}`,
      originalName: name,
      ext,
    };
  }

  /** 把刚上传的 OSS 文件写进「产品图库 → 摄影师拍摄图」 */
  async saveProductGalleryFiles(sku, files) {
    const detail = await this.getProductGallery(sku);
    if (!detail) throw new Error('OMS 产品图库没有这个 SKU 的记录');
    const existing = Array.isArray(detail.shootFiles) ? detail.shootFiles : [];
    const added = (Array.isArray(files) ? files : []).map((f) => ({
      fileName: f.key,
      originalName: `${sku}/${f.originalName}`,
      fileSuffix: f.ext ? f.ext.toUpperCase() : '',
      url: f.url,
      service: 'aliyun',
    }));
    if (!added.length) return detail;
    const body = { ...detail, shootFiles: [...existing, ...added] };
    try {
      await this.request('/oms-admin/visual/designOss', { method: 'PUT', data: body });
    } catch {
      // 部分环境用 POST 新增；PUT 失败后再试一次
      await this.request('/oms-admin/visual/designOss', { method: 'POST', data: body });
    }
    return await this.getProductGallery(sku);
  }

  /**
   * 按 5 位主 SKU 查完整编码。
   * 数据源改为「WMS → 视觉拍摄」页：/wms/qc/qcBillDetail/printList。
   * 这页表格里的「系统SKU」列才是当前要用的完整编码；旧 designProcess 页只用来补产品名。
   */
  async findVisualShootingByMainSku(mainSku) {
    const sku = String(mainSku || '').trim();
    if (!sku) return { total: 0, rows: [] };
    const json = await this.request('/wms/qc/qcBillDetail/printList', {
      method: 'GET',
      params: { pageNum: '1', pageSize: '50', mainSkuId: sku },
    });
    const rows = uniqueSalesSkus(json?.rows);
    return { total: rows.length, rows };
  }

  /** 旧设计流程接口只补产品名；编码一律以视觉拍摄页为准 */
  async findDesignProductName(mainSku) {
    const sku = String(mainSku || '').trim();
    if (!sku) return '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const json = await this.request('/oms-admin/visual/designProcess/list', {
          method: 'POST',
          data: { pageNum: 1, pageSize: 50, mainSkuId: sku, shootStatus: SHOOT_STATUS_PENDING },
        });
        const row = (Array.isArray(json?.rows) ? json.rows : []).find((r) => r?.productName);
        if (row?.productName) return String(row.productName);
      } catch {
        /* 产品名只是补充，失败重试一次后放弃 */
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
    }
    return '';
  }

  /** 按 5 位主 SKU 查完整编码；产品名从旧接口尽力补，失败不影响编码 */
  async findPendingByMainSku(mainSku) {
    const sku = String(mainSku || '').trim();
    if (!sku) return { total: 0, rows: [] };
    const visual = await this.findVisualShootingByMainSku(sku);
    if (!visual.total) return visual;
    const productName = await this.findDesignProductName(sku);
    return {
      total: visual.total,
      rows: visual.rows.map((r) => ({ ...r, productName: r.productName || productName })),
    };
  }

  /** 批量查询：并发 4，单个失败不影响其它 SKU */
  async resolveMany(mainSkus) {
    const list = [...new Set((Array.isArray(mainSkus) ? mainSkus : []).map((s) => String(s || '').trim()).filter(Boolean))];
    /** @type {Record<string, {total:number,rows:any[],error?:string}>} */
    const results = {};
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= list.length) return;
        const sku = list[i];
        try {
          results[sku] = await this.findPendingByMainSku(sku);
        } catch (err) {
          results[sku] = { total: 0, rows: [], error: err instanceof Error ? err.message : String(err) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, list.length) }, worker));
    return results;
  }
}

export const omsClient = new OmsClient();
