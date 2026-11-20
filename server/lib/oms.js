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
 */
export function uniqueSalesSkus(rows) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const sku = String(row?.salesSku || '').trim();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push({
      /** 设计单 id：前端用它打开 OMS 后台详情，让用户自己核对/选择 */
      id: row?.id != null ? String(row.id) : '',
      salesSku: sku,
      productName: String(row?.productName || ''),
      billNo: String(row?.billNo || ''),
      shootStatus: String(row?.shootStatus || ''),
      status: String(row?.status || ''),
    });
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
    /** @type {{token:string,expiresAt:number}|null} */
    this.session = null;
    /** @type {Promise<any>|null} */
    this.loginPromise = null;
    this.lastError = '';
  }

  accountPath() {
    return ACCOUNT_FILE;
  }

  async loadAccount() {
    if (this.accountLoaded) return this.account;
    this.accountLoaded = true;
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
    } catch {
      /* 没配置过是正常状态 */
    }
    return this.account;
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
    this.session = probe.session;
    this.lastError = '';
    return this.status();
  }

  async clearAccount() {
    this.account = null;
    this.accountLoaded = true;
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
    const account = await this.loadAccount();
    return {
      configured: !!account,
      username: account?.username || '',
      baseUrl: account?.baseUrl || DEFAULT_BASE_URL,
      loggedIn: !!this.session && this.session.expiresAt > Date.now(),
      expiresAt: this.session?.expiresAt || 0,
      error: this.lastError,
    };
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

    let { res, json } = await send((await this.login()).token);
    if (res.status === 401 || json?.code === 401) {
      this.session = null;
      ({ res, json } = await send((await this.login(true)).token));
    }
    if (res.status === 401 || json?.code === 401) {
      this.lastError = 'OMS 登录已失效';
      throw new Error('OMS 登录已失效，请重新配置账号');
    }
    if (!res.ok || json?.code !== 200) {
      throw new Error(json?.msg || `OMS 接口异常（HTTP ${res.status}）`);
    }
    return json;
  }

  /** 按 5 位主 SKU 查待拍摄需求，返回去重后的完整编码 */
  async findPendingByMainSku(mainSku) {
    const sku = String(mainSku || '').trim();
    if (!sku) return { total: 0, rows: [] };
    const json = await this.request('/oms-admin/visual/designProcess/list', {
      method: 'POST',
      data: {
        pageNum: 1,
        pageSize: 50,
        mainSkuId: sku,
        shootStatus: SHOOT_STATUS_PENDING,
      },
    });
    const rows = uniqueSalesSkus(json?.rows);
    return { total: rows.length, rows };
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
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
    return results;
  }
}

export const omsClient = new OmsClient();
