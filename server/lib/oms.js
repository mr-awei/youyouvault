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
import OSS from 'ali-oss';
import { DATA_DIR } from '../config.js';

const DEFAULT_BASE_URL = 'https://sit.uyoyous.com';
const API_PREFIX = '/oms-test-api';
/** 网页端「上传文件夹」固定把产品图放在这个前缀下，跟它保持一致便于后台核对 */
const OSS_IMAGE_PREFIX = 'visualDesignProcess/images';
/** OMS 前端写死的客户端 id，不是密钥，登录时必须带 */
const CLIENT_ID = 'e5cd7e4891bf95d1d19206ce24a7b32e';
const ACCOUNT_FILE = path.join(DATA_DIR, 'oms-account.json');
/** visual_design_shoot_status：1 = 待拍摄 */
const SHOOT_STATUS_PENDING = '1';
/** 查询结果缓存时长：摄影师常连着点几次「查询完整编码」，2 分钟内直接复用 */
const PENDING_TTL_MS = 120 * 1000;
/** 产品名基本不会变，缓存久一点，减少上传时的核对请求 */
const NAME_TTL_MS = 10 * 60 * 1000;

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
 * OSS 对象 key：与 OMS 网页端「上传文件夹」完全一致。
 * 形如 visualDesignProcess/images/2026_11_23/37641-Y10R0002-A03/<md5>.jpg。
 * @param {string} dir 签名里的日期目录，原始格式 2026/11/23
 * @param {string} sku 完整 SKU
 * @param {string} hash 文件 MD5
 * @param {string} ext 扩展名（可带点）
 */
export function buildOssImageKey(dir, sku, hash, ext) {
  const day = String(dir || '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\//g, '_');
  const skuDir = String(sku || '').trim();
  const suffix = String(ext || 'jpg')
    .replace(/^\./, '')
    .toLowerCase();
  return [OSS_IMAGE_PREFIX, day, skuDir, `${hash}.${suffix}`].filter(Boolean).join('/');
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
    /** 主 SKU → 待拍摄查询结果；同一批 SKU 反复查询时不必每次都打 OMS */
    this.pendingCache = new Map();
    /** 完整 SKU → 后台产品名 */
    this.nameCache = new Map();
  }

  /** 缓存条目太多时丢掉最旧的一半，避免长跑进程里无限增长 */
  trimCache(cache) {
    if (cache.size <= 300) return;
    const keys = [...cache.keys()].slice(0, Math.floor(cache.size / 2));
    for (const k of keys) cache.delete(k);
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
   * 取产品的后台名称。
   * 已有「产品图库」记录时直接用记录名；第一次上传的新 SKU 还没有 designOss 记录，
   * 退回「视觉拍摄 / 设计单」里的产品名。
   * 调用方已经查过图库时可以把 detail 传进来，省掉一次重复请求。
   */
  async resolveProductName(sku, detail) {
    const s = String(sku || '').trim();
    if (!s) return '';
    const cached = this.nameCache.get(s);
    if (cached && Date.now() - cached.at < NAME_TTL_MS) return cached.value;
    const info = detail === undefined ? await this.getProductGallery(s).catch(() => null) : detail;
    let name = String(info?.displayName || '').trim();
    if (!name) {
      const mainSku = s.split('-')[0];
      try {
        name = await this.findDesignProductName(mainSku);
      } catch {
        name = '';
      }
    }
    this.nameCache.set(s, { at: Date.now(), value: name });
    this.trimCache(this.nameCache);
    return name;
  }

  /**
   * 上传一张图到 OSS。
   *
   * 和 OMS 网站「上传文件夹」走同一条链路：拿 STS 签名 → ali-oss SDK 单次 PUT。
   * 之前用 POST policy 手写表单，OMS 返回的 credential 是 `oss-cn-guangzhou`（OSS V4
   * 实际要求 `cn-guangzhou`），改完 region 又对不上服务端算的 signature，
   * 先后报 NoSuchBucket / signing region invalid / SignatureDoesNotMatch。
   * SDK 自己处理 region 归一化与签名，最稳。
   *
   * key 必须与网页端一致：visualDesignProcess/images/2026_11_23/完整SKU/文件MD5.jpg。
   * 返回 { key, url, originalName, ext }；写库由 saveProductGalleryFiles 完成。
   * @param {string} filePath
   * @param {string} originalName
   * @param {string} sku 完整 SKU，网页端会把它作为 OSS 目录的一级
   */
  async uploadOssFile(filePath, originalName, sku) {
    const buf = await fsp.readFile(filePath);
    if (buf.length > 10 * 1024 * 1024) {
      throw new Error(`图片超过 OSS 10MB 限制：${path.basename(filePath)}`);
    }
    const sig = await this.rawRequest('/oms-admin/get_post_signature_for_oss_upload', { method: 'GET' });
    if (!sig?.bucket || !sig?.accessKeyId || !sig?.accessKeySecret || !sig?.region || !sig?.token) {
      throw new Error('获取 OSS 上传签名失败');
    }
    const name = String(originalName || path.basename(filePath));
    const ext = (path.extname(name).slice(1) || 'jpg').toLowerCase();
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    const key = buildOssImageKey(sig.dir, sku, hash, ext);
    const store = new OSS({
      accessKeyId: sig.accessKeyId,
      accessKeySecret: sig.accessKeySecret,
      stsToken: sig.token,
      bucket: sig.bucket,
      region: sig.region,
      secure: true,
      // 每张图上传前都会重新取签名，这个回调实际不会被调用；
      // 传一个空实现只是为了不让 ali-oss 每张图都打一条“建议设置 refreshSTSToken”的警告
      refreshSTSToken: async () => ({
        accessKeyId: sig.accessKeyId,
        accessKeySecret: sig.accessKeySecret,
        stsToken: sig.token,
      }),
    });
    // 网页端用单次 PUT（不是分片上传）；图片都在 10MB 内，PUT 更少请求也更贴近后台记录
    const result = await store.put(key, buf);
    const url = result?.url || `https://${sig.bucket}.${sig.region}.aliyuncs.com/${key}`;
    return { key, url, originalName: name, ext };
  }

  /**
   * 把刚上传的 OSS 文件写进「产品图库 → 摄影师拍摄图」。
   *
   * 与网页端「上传文件夹」完全一致的两步：
   *   1) addOssRecordBatch 登记 OSS 记录，换回 ossId；
   *   2) POST /visual/designOss 只提交 { sku, ossIds: '逗号分隔', type: '1', displayName }。
   *      type 1=拍摄图 2=设计图 3=需求图。
   * 之前把整个 detail 连同 shootFiles 一起 PUT 是错的，服务端按 ossIds 处理。
   */
  async saveProductGalleryFiles(sku, files, displayName = '') {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return this.getProductGallery(sku);
    // 新 SKU 第一次上传时后台还没有 designOss 记录，不能直接报错：
    // 先传 OSS / 登记，再用 designOss POST 从零创建这条记录。
    const detail = await this.getProductGallery(sku);

    const registered = await this.request('/oms-admin/resource/oss/addOssRecordBatch', {
      method: 'POST',
      data: list.map((f) => ({
        fileName: f.key,
        originalName: `${sku}/${f.originalName}`,
        url: f.url,
        // 网页端登记的是小写后缀与 bucket 名，照抄避免后台列表显示不一致
        fileSuffix: f.ext || '',
        service: 'youyou-prod',
      })),
    });
    const records = Array.isArray(registered?.data) ? registered.data : [];
    const ossIds = records.map((r) => String(r.ossId || '')).filter(Boolean);
    if (!ossIds.length) throw new Error('登记 OSS 记录失败，没有拿到 ossId');

    // 网页端会把当前该栏已有的 ossId 一起提交；这里保留原有关联，避免覆盖之前上传的图。
    // 优先用 detail.ossIds（网页端提交的就是它），没有再退回 shootFiles。
    const existing = String(detail?.ossIds || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (!existing.length) {
      for (const x of detail?.shootFiles || []) {
        const id = String(x?.ossId || '');
        if (id) existing.push(id);
      }
    }
    const allIds = [...new Set([...existing, ...ossIds])];
    let name = String(detail?.displayName || displayName || '').trim();
    if (!name) name = await this.resolveProductName(sku).catch(() => '');
    await this.request('/oms-admin/visual/designOss', {
      method: 'POST',
      data: {
        sku,
        ossIds: allIds.join(','),
        type: '1',
        displayName: name,
      },
    });
    const saved = await this.getProductGallery(sku);
    if (saved) return saved;
    // 后台刚写完偶尔还查不到：返回与详情兼容的结构，避免前端把这次上传标成失败
    return {
      sku,
      displayName: name,
      ossIds: allIds.join(','),
      shootFiles: [
        ...existing.map((ossId) => ({ ossId })),
        ...records.map((r) => ({ ossId: r.ossId, url: r.url })),
      ],
    };
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
    const cached = this.pendingCache.get(sku);
    if (cached && Date.now() - cached.at < PENDING_TTL_MS) return cached.value;

    const visual = await this.findVisualShootingByMainSku(sku);
    let value = visual;
    if (visual.total) {
      // 视觉拍摄页常常已经带产品名，只有真的缺名字才多打一次设计单接口
      const needName = visual.rows.some((r) => !r.productName);
      const productName = needName ? await this.findDesignProductName(sku) : '';
      value = {
        total: visual.total,
        rows: visual.rows.map((r) => ({ ...r, productName: r.productName || productName })),
      };
    }
    this.pendingCache.set(sku, { at: Date.now(), value });
    this.trimCache(this.pendingCache);
    return value;
  }

  /** 批量查询：并发 6，单个失败不影响其它 SKU */
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
    // 并发从 2 提到 6：10 个 SKU 的等待时间大致从 5 轮降到 2 轮；
    // OMS 是普通 REST 接口，6 路并发对它没有压力。
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
    return results;
  }
}

export const omsClient = new OmsClient();
