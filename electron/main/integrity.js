// @ts-check
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 软件完整性自检。
 *
 * 为什么需要：Windows 上的安全软件（360 / 火绒 / Defender）有时会把某个 .js
 * 当成可疑文件隔离掉，或者磁盘错误写坏文件。表现是「软件能打开，但某个功能
 * 莫名其妙报错」，用户完全不知道是文件没了 —— 这种问题看日志也未必看得出来。
 *
 * 做法：构建时把 server/** 与 dist/web/** 的 sha256 写进 electron/integrity-manifest.json，
 * 启动后（延迟）+ 每 6 小时按清单核对一次。缺文件时优先用「已签名」的热更包静默补齐，
 * 补不上的才提示重新运行安装包（绝不后台静默执行 exe —— 那才是安全软件最敏感的行为）。
 */

const CHECK_CONCURRENCY = 8;
/** 详情最多列这么多，避免一屏几百条把界面撑爆 */
const MAX_DETAIL = 20;

/** @param {Buffer} buf */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * @param {{
 *   appRoot: string,
 *   serverRoot: () => string,
 *   webRoot: () => string,
 *   shellVersion: string,
 *   hotfix?: { repair: () => Promise<any>, state: () => any } | null,
 * }} opts
 */
export function createIntegrity({ appRoot, serverRoot, webRoot, shellVersion, hotfix = null }) {
  const manifestPath = path.join(appRoot, 'electron', 'integrity-manifest.json');

  /** @type {any} */
  let last = null;

  function readManifest() {
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(raw?.files) || !raw.files.length) return null;
      return raw;
    } catch {
      // 开发模式（没有构建清单）或清单被删：不把它当成「软件损坏」
      return null;
    }
  }

  /** manifest 里的相对路径 → 磁盘上的实际路径（热更 overlay 优先） */
  function resolve(rel) {
    if (rel.startsWith('server/')) return path.join(serverRoot(), rel.slice('server/'.length));
    if (rel.startsWith('web/')) return path.join(webRoot(), rel.slice('web/'.length));
    return path.join(appRoot, rel);
  }

  /**
   * 核对全部文件。
   * @returns {Promise<{ok:boolean, version:string, checked:number, missing:any[], corrupted:any[], at:string, reason?:string}>}
   */
  async function verify() {
    const manifest = readManifest();
    const at = new Date().toISOString();
    if (!manifest) {
      last = { ok: true, version: shellVersion, checked: 0, missing: [], corrupted: [], at, reason: '开发模式或没有清单，跳过自检' };
      return last;
    }
    /** @type {any[]} */
    const missing = [];
    /** @type {any[]} */
    const corrupted = [];
    let cursor = 0;
    const files = manifest.files;

    const worker = async () => {
      while (cursor < files.length) {
        const f = files[cursor++];
        const abs = resolve(String(f.path));
        let buf;
        try {
          buf = await fsp.readFile(abs);
        } catch {
          if (missing.length < MAX_DETAIL) missing.push({ path: f.path });
          continue;
        }
        // 大小先比：不一致就不必算哈希（哈希只用来确认「同大小但内容坏了」）
        if (Number(f.size) && buf.length !== Number(f.size)) {
          if (corrupted.length < MAX_DETAIL) corrupted.push({ path: f.path, reason: '大小不符' });
          continue;
        }
        if (sha256(buf) !== String(f.sha256)) {
          if (corrupted.length < MAX_DETAIL) corrupted.push({ path: f.path, reason: '内容校验失败' });
        }
      }
    };
    await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));

    last = {
      ok: missing.length === 0 && corrupted.length === 0,
      version: String(manifest.version || shellVersion),
      checked: files.length,
      missing,
      corrupted,
      at,
    };
    return last;
  }

  /** 上次结果（不重新扫盘），界面首屏用它 */
  function snapshot() {
    return last;
  }

  /**
   * 尝试自动修复：只走「已签名的热更包」，不下载、不执行任何 exe。
   * @returns {Promise<{ok:boolean, mode:'hotfix'|'installer'|'none', seq?:number, note:string}>}
   */
  async function repair() {
    if (!last || last.ok) return { ok: true, mode: 'none', note: '文件完整，无需修复' };
    if (!hotfix) {
      return {
        ok: false,
        mode: 'installer',
        note: '当前版本没有可用的热更通道，请重新运行安装包覆盖安装（不会动图库数据）',
      };
    }
    try {
      const r = await hotfix.repair();
      if (r?.updated) {
        return {
          ok: true,
          mode: 'hotfix',
          seq: Number(r.seq) || 0,
          note: '缺失文件已随补丁包下载，下次启动自动生效（无需重装）',
        };
      }
      return {
        ok: false,
        mode: 'installer',
        note: `自动修复没成功：${r?.error || '没有可用的修复包'}。请重新运行安装包覆盖安装，图库数据不受影响`,
      };
    } catch (err) {
      return {
        ok: false,
        mode: 'installer',
        note: `自动修复失败：${err?.message || err}。请重新运行安装包覆盖安装`,
      };
    }
  }

  return { verify, snapshot, repair, manifestPath };
}
