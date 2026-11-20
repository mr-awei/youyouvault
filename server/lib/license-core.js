// @ts-check
/**
 * 授权码的纯逻辑：签发、验签、机器码换算。
 *
 * 这里刻意不碰 fs / 网络 / 硬件探测，签发脚本、服务端与单测共用同一份代码。
 * 安全边界只有一条：**私钥只在作者本机，公钥随安装包发布**。
 * 授权码被改动一个字节就验不过；放在哪台机器、怎么传都不影响结论。
 *
 * 授权码格式：`TUKU1.<base64url(payloadJson)>.<base64url(signature)>`
 * 签名直接覆盖 payloadJson 的原始字节，所以不需要再做规范化序列化 ——
 * 中间任何一次重新编码都会让签名对不上。
 */
import crypto from 'node:crypto';

export const PRODUCT = 'tuku';
const PREFIX = 'TUKU1';
const REVOKE_PREFIX = 'TUKU-REVOKE1';

/**
 * 需要专业版的能力。key 与 requirePro('...') 一一对应，
 * 新增一项只需要在这里加一行，服务端闸门与设置页列表会同时生效。
 */
export const PRO_FEATURES = [
  { key: 'lan', label: '局域网投送与只读分享' },
  { key: 'plugins', label: '插件脚本执行' },
  { key: 'night-batch', label: 'AI 夜间批处理' },
  { key: 'barcode', label: '条码分文件夹与产品图上传' },
  { key: 'timeline', label: '时间线' },
  { key: 'canvas', label: '无限画布' },
  { key: 'edit', label: '调色 / 裁切 / 修图' },
  { key: 'batch', label: '批量编辑 / 导出 / 增强 / 动作' },
];

/** 取 sha256 的前 16 个十六进制字符：64 位指纹，足够区分机器，也不会长到没法抄 */
export function sha16(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/** 展示用机器码：XXXX-XXXX-XXXX-XXXX */
export function formatCode(value) {
  const hex = String(value ?? '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase()
    .slice(0, 16);
  return (hex.match(/.{1,4}/g) || []).join('-');
}

/** 比较用：去掉分隔符并统一大小写（用户可能只抄了字母，或带空格） */
export function normalizeCode(value) {
  return String(value ?? '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase();
}

/**
 * 手机号规范化：去掉空格 / 横线 / 括号，保留开头的 +。
 * 授权与停用都按这个结果匹配，避免「138 0000 0000」和「13800000000」被当成两个账号。
 */
export function normalizePhone(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return `${raw.startsWith('+') ? '+' : ''}${raw.replace(/\D/g, '')}`;
}

/** 5–20 位数字（可带 + 前缀）：够覆盖国内手机号与常见国际号码 */
export function isValidPhone(value) {
  return /^\+?\d{5,20}$/.test(normalizePhone(value));
}

/**
 * 由硬件特征算出机器码：每项取 sha256 的前 4 位，共 4 组（XXXX-XXXX-XXXX-XXXX）。
 *
 * 分项而不是把 4 项混成一个哈希，是为了能「按项」容错：换硬盘只会让其中一组变，
 * 其余三组仍能对上。读不到的项用 0000 占位。
 * 这是 v1 设备码：老授权码继续用它验证，新签发请用 deviceCodeFromParts（v2）。
 * @param {Array<string | undefined | null>} parts
 */
export function machineCodeFromParts(parts) {
  return parts
    .map((p) => {
      const raw = String(p ?? '').trim().toLowerCase();
      return raw ? sha16(raw).slice(0, 4).toUpperCase() : '0000';
    })
    .join('-');
}

/**
 * v2 设备码：用更强的硬件特征、6 组，允许 2 组漂移。
 *
 * 相比 v1（MachineGuid / CPU ProcessorId / 主板序列 / C: 卷序列）：
 * - SMBIOS UUID、主板 + BIOS 序列、启动盘物理序列号更难伪造，也不会因重装系统而全变；
 * - TPM EK 在可用时作为高权重项（需要管理员权限；取不到就跳过）；
 * - 6 组里最多变 2 组，且必须至少命中 1 个强特征（UUID / 主板 / 启动盘 / TPM）。
 *
 * 局限：纯离线方案无法彻底杜绝「整机克隆」或改代码绕过。真正的防白嫖仍需
 * 在线激活 / 席位管理 / 定期校验；这里做的是把「拷一份 key 到别的电脑」挡住。
 * @param {{
 *   uuid?: string, board?: string, bios?: string, disk?: string,
 *   tpm?: string, guid?: string, cpu?: string, cpuName?: string, mac?: string
 * }} parts
 */
export function deviceCodeFromParts(parts = {}) {
  const uuid = uuidPart(parts.uuid);
  const boardBios = [serialPart(parts.board), serialPart(parts.bios)].filter(Boolean).join('|');
  const disk = serialPart(parts.disk);
  const tpm = usablePart(parts.tpm);
  const guid = serialPart(parts.guid);
  const cpuMac = [serialPart(parts.cpu), usablePart(parts.cpuName), macPart(parts.mac)]
    .filter(Boolean)
    .join('|');
  return `TK2-${[group(uuid), group(boardBios), group(disk), group(tpm), group(guid), group(cpuMac)].join('-')}`;
}

const PLACEHOLDER_PARTS = new Set([
  '',
  'none',
  'null',
  'n/a',
  'na',
  'unknown',
  'default string',
  'system serial number',
  'to be filled by o.e.m.',
  'to be filled by oem',
  'to be filled by o.e.m',
  'not specified',
  'not applicable',
  'o.e.m.',
  'oem',
  '123456789',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '03000200-0400-0500-0006-000700080009',
]);

/** 过滤 OEM 占位值 / 全零；这些值当硬件序列号会导致大量机器撞码 */
function usablePart(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (PLACEHOLDER_PARTS.has(s.toLowerCase())) return '';
  if (/^0+$/.test(s.replace(/[-:.\s]/g, ''))) return '';
  return s;
}

function uuidPart(value) {
  const s = usablePart(value).replace(/^\{|\}$/g, '').toLowerCase();
  return s.replace(/[^0-9a-f-]/g, '') === s ? s : '';
}

function serialPart(value) {
  return usablePart(value).replace(/[.\s]+$/g, '');
}

function macPart(value) {
  const list = String(value ?? '')
    .split(',')
    .map((v) => v.replace(/[^0-9a-f]/gi, '').toUpperCase())
    .filter((v) => v.length >= 12 && v !== '000000000000');
  return [...new Set(list)].sort().join(',');
}

function group(value) {
  return value ? sha16(value).slice(0, 4).toUpperCase() : '0000';
}

/** 只保留 TK2 后面的 24 位十六进制；v1 的 16 位输入会原样返回 */
export function normalizeDeviceCode(value) {
  let raw = String(value ?? '').trim();
  if (/^TK2[-\s]?/i.test(raw)) raw = raw.replace(/^TK2[-\s]?/i, '');
  return raw.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

export function formatDeviceCode(value) {
  const hex = normalizeDeviceCode(value).slice(0, 24);
  if (hex.length !== 24) return String(value ?? '').trim();
  return `TK2-${hex.match(/.{1,4}/g).join('-')}`;
}

/**
 * v2 设备码比对：6 组里允许漂移，且强特征至少命中 1 组。
 * 当前读不到的组（0000）不参与计分。
 * @param {string} licensed
 * @param {string} current
 */
export function deviceMatches(licensed, current) {
  const a = normalizeDeviceCode(licensed);
  const b = normalizeDeviceCode(current);
  if (a.length !== 24 || b.length !== 24) {
    return { ok: false, matches: 0, comparable: 0, strongMatches: 0, strongComparable: 0, allowed: 0 };
  }
  const ga = a.match(/.{4}/g) || [];
  const gb = b.match(/.{4}/g) || [];
  let matches = 0;
  let comparable = 0;
  let strongMatches = 0;
  let strongComparable = 0;
  for (let i = 0; i < 6; i++) {
    if (!gb[i] || gb[i] === '0000') continue;
    comparable++;
    const hit = ga[i] === gb[i];
    if (hit) matches++;
    if (i < 4) {
      strongComparable++;
      if (hit) strongMatches++;
    }
  }
  if (comparable < 3) {
    return { ok: false, matches, comparable, strongMatches, strongComparable, allowed: 0 };
  }
  const allowed = comparable >= 5 ? 2 : 1;
  const ok = matches >= comparable - allowed && (strongComparable === 0 || strongMatches >= 1);
  return { ok, matches, comparable, strongMatches, strongComparable, allowed };
}

/**
 * 授权码里的机器码与当前机器码比对：4 项里允许变 1 项。
 *
 * 当前机器读不到的项（0000）不参与计分 —— 主板序列号偶尔读不到不该让授权失效；
 * 但如果只剩不到 2 项可读，就无法证明是同一台机器，直接拒绝。
 * @param {string} licensed 授权码里签下的机器码
 * @param {string} current 当前机器算出的机器码
 */
export function machineMatches(licensed, current) {
  const a = String(licensed || '').toUpperCase().split('-');
  const b = String(current || '').toUpperCase().split('-');
  if (a.length !== 4 || b.length !== 4) return { ok: false, matches: 0, comparable: 0 };
  let matches = 0;
  let comparable = 0;
  for (let i = 0; i < 4; i++) {
    if (!b[i] || b[i] === '0000') continue;
    comparable++;
    if (a[i] === b[i]) matches++;
  }
  if (comparable < 2) return { ok: false, matches, comparable };
  return { ok: matches >= comparable - 1, matches, comparable };
}

/**
 * 签发授权码（只在作者本机 / CI 里调用）。
 * @param {Record<string, any>} payload
 * @param {string} privateKeyPem
 */
export function signLicenseKey(payload, privateKeyPem) {
  const body = {
    v: 1,
    product: PRODUCT,
    edition: 'pro',
    machine: '',
    machine2: '',
    account: '',
    phone: '',
    issuedAt: '',
    expires: null,
    note: '',
    seats: 1,
    ...payload,
  };
  const json = JSON.stringify(body);
  const sig = crypto.sign(null, Buffer.from(json, 'utf8'), privateKeyPem);
  return `${PREFIX}.${Buffer.from(json, 'utf8').toString('base64url')}.${Buffer.from(sig).toString('base64url')}`;
}

/**
 * 拆出授权码里的原文与签名；格式不对返回 null。
 * 同时容忍 `{"key":"TUKU1..."}` 这种被存成 JSON 的写法 —— 用户从邮件里复制时很常见。
 * @param {string} input
 * @returns {{ json: string, sig: Buffer, payload: any } | null}
 */
export function parseLicenseKey(input) {
  let raw = String(input ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      raw = String(JSON.parse(raw)?.key || '').trim();
    } catch {
      return null;
    }
  }
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const sig = Buffer.from(parts[2], 'base64url');
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return { json, sig, payload };
  } catch {
    return null;
  }
}

/**
 * 验签 + 产品 / 版本 / 有效期 / 设备绑定校验。
 * - 新授权码带 machine2：按 v2 设备码（6 组、允许漂移、强特征约束）校验。
 * - 老授权码只有 machine：继续按 v1 机器码校验，保证已售授权不受影响。
 * @param {string} key
 * @param {{ publicKeyPem?: string, machineCode?: string, deviceCode?: string, now?: number, product?: string }} [opts]
 * @returns {{ ok: boolean, reason: string, payload?: any }}
 */
export function verifyLicenseKey(key, opts = {}) {
  const {
    publicKeyPem = '',
    machineCode = '',
    deviceCode = '',
    now = Date.now(),
    product = PRODUCT,
  } = opts;
  if (!publicKeyPem) return { ok: false, reason: '未内置授权公钥' };
  const parsed = parseLicenseKey(key);
  if (!parsed) return { ok: false, reason: '激活码格式不正确' };

  const valid = (() => {
    try {
      return crypto.verify(null, Buffer.from(parsed.json, 'utf8'), publicKeyPem, parsed.sig);
    } catch {
      return false;
    }
  })();
  if (!valid) return { ok: false, reason: '激活码签名无效（可能被修改过）' };

  const p = parsed.payload;
  if (String(p.product || '') !== product) return { ok: false, reason: '激活码不属于这个产品' };
  if (Number(p.v) !== 1) return { ok: false, reason: '激活码版本不受支持' };

  if (p.expires) {
    // 只写日期时按当天结束算，避免「买到 11-20，当天上午就说已过期」
    const end = Date.parse(String(p.expires).length <= 10 ? `${p.expires}T23:59:59` : String(p.expires));
    if (!Number.isFinite(end)) return { ok: false, reason: '激活码有效期格式不正确' };
    if (now > end) return { ok: false, reason: `授权已于 ${p.expires} 过期` };
  }

  // 新版设备码：6 组 + 强特征约束
  if (p.machine2) {
    if (!deviceCode) return { ok: false, reason: '无法读取当前设备码' };
    const r = deviceMatches(String(p.machine2), deviceCode);
    if (!r.ok) {
      return {
        ok: false,
        reason: `设备码与当前设备不符（匹配 ${r.matches}/${r.comparable} 组，换过主要硬件需要重新签发）`,
      };
    }
    return { ok: true, reason: '', payload: p };
  }

  // 兼容老授权：machine 为空 = 不绑定机器（内部 / 团队授权）
  if (p.machine) {
    if (!machineMatches(String(p.machine), machineCode).ok) {
      return { ok: false, reason: '激活码与当前机器不符（换过硬件的话需要重新签发）' };
    }
  }

  return { ok: true, reason: '', payload: p };
}

/**
 * 远程停用清单：作者私钥签名，客户端用同一把公钥验签。
 * payload: { v:1, product:'tuku', seq, issuedAt, revokedAccounts:[], revokedMachines:[] }
 */
export function signRevocationList(payload, privateKeyPem) {
  const body = {
    v: 1,
    product: PRODUCT,
    seq: 1,
    issuedAt: '',
    revokedPhones: [],
    revokedAccounts: [],
    revokedMachines: [],
    ...payload,
  };
  const json = JSON.stringify(body);
  const sig = crypto.sign(null, Buffer.from(json, 'utf8'), privateKeyPem);
  return `${REVOKE_PREFIX}.${Buffer.from(json, 'utf8').toString('base64url')}.${Buffer.from(sig).toString('base64url')}`;
}

/** 接受原始 token 或 {token:'...'} */
export function parseRevocationList(input) {
  let raw = String(input ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      raw = String(JSON.parse(raw)?.token || '').trim();
    } catch {
      return null;
    }
  }
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== REVOKE_PREFIX) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const sig = Buffer.from(parts[2], 'base64url');
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return { json, sig, payload };
  } catch {
    return null;
  }
}

export function verifyRevocationList(token, { publicKeyPem = '' } = {}) {
  if (!publicKeyPem) return { ok: false, reason: '未内置授权公钥' };
  const parsed = parseRevocationList(token);
  if (!parsed) return { ok: false, reason: '停用清单格式不正确' };
  const valid = (() => {
    try {
      return crypto.verify(null, Buffer.from(parsed.json, 'utf8'), publicKeyPem, parsed.sig);
    } catch {
      return false;
    }
  })();
  if (!valid) return { ok: false, reason: '停用清单签名无效' };
  const p = parsed.payload;
  if (String(p.product || '') !== PRODUCT) return { ok: false, reason: '停用清单不属于这个产品' };
  if (Number(p.v) !== 1) return { ok: false, reason: '停用清单版本不受支持' };
  return { ok: true, reason: '', payload: p };
}

/**
 * 剩余天数（向上取整）；未设置到期时间返回 null。
 * @param {string | null | undefined} expires
 * @param {number} [now]
 */
export function daysLeft(expires, now = Date.now()) {
  if (!expires) return null;
  const end = Date.parse(String(expires).length <= 10 ? `${expires}T23:59:59` : String(expires));
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - now) / 86_400_000));
}
