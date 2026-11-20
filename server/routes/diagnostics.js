// @ts-check
/**
 * 一键诊断包：系统环境 / 网络 / 最近操作 / 设置 / 授权状态 / 日志。
 *
 * 输出一个 zip，用户直接提交即可，不用再截图或手抄环境。
 * 绝不打包密码、API token、OMS 账号密码、授权私钥、授权码原文。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { APP_ROOT, API_TOKEN, DATA_DIR } from '../config.js';
import { db } from '../db.js';
import { getSettings } from '../db/settings.js';
import { licenseStatus } from '../lib/license.js';
import { omsClient } from '../lib/oms.js';

const SECRET_KEY_RE = /(password|passwd|secret|token|api[_-]?key|authorization|credential)/i;

function redactString(value) {
  let s = String(value ?? '');
  const secrets = [API_TOKEN].filter(Boolean);
  for (const secret of secrets) s = s.split(secret).join('***');
  return s
    .replace(/([?&]token=)[^&\s]+/gi, '$1***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/TUKU1\.[A-Za-z0-9._-]+/g, 'TUKU1.***')
    .replace(/("(?:password|passwd|token|secret|api[_-]?key|authorization|credential)"\s*:\s*")[^"]*(")/gi, '$1***$2');
}

function scrub(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => scrub(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) out[k] = '***';
      else out[k] = scrub(v, k);
    }
    return out;
  }
  if (typeof value === 'string') return redactString(value);
  return value;
}

async function readLogs() {
  const dirs = new Map([
    [path.resolve(APP_ROOT, 'logs'), 'app-logs'],
    [path.resolve(DATA_DIR, '..', 'logs'), 'user-logs'],
  ]);
  const out = [];
  for (const [dir, label] of dirs) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() || !/\.(log|err|txt)$/i.test(e.name)) continue;
      const p = path.join(dir, e.name);
      try {
        const st = await fsp.stat(p);
        if (st.size > 2 * 1024 * 1024) continue;
        const text = await fsp.readFile(p, 'utf8');
        out.push({ name: `${label}/${e.name}`, text: redactString(text.slice(-300_000)) });
      } catch {
        /* 单个日志读不到不影响整包 */
      }
    }
  }
  return out;
}

function recentActions() {
  try {
    return db.prepare('SELECT * FROM op_log ORDER BY id DESC LIMIT 200').all().map((r) => scrub(r));
  } catch {
    return [];
  }
}

function networkInfo() {
  const interfaces = {};
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    interfaces[name] = (list || []).map((x) => ({
      address: x.address,
      family: x.family,
      internal: x.internal,
      mac: x.mac,
    }));
  }
  return scrub({
    interfaces,
    proxyEnv: {
      HTTP_PROXY: process.env.HTTP_PROXY || '',
      HTTPS_PROXY: process.env.HTTPS_PROXY || '',
      NO_PROXY: process.env.NO_PROXY || '',
      ALL_PROXY: process.env.ALL_PROXY || '',
    },
    hostname: os.hostname(),
  });
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.post(
    '/api/diagnostics/bundle',
    asyncRoute(async (req, res) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let oms;
      try {
        oms = await omsClient.status();
      } catch (err) {
        oms = { error: err instanceof Error ? err.message : String(err) };
      }
      const logs = await readLogs();
      const meta = scrub({
        generatedAt: new Date().toISOString(),
        version: (() => {
          try {
            return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
          } catch {
            return '';
          }
        })(),
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        hostname: os.hostname(),
        user: (() => {
          try {
            return os.userInfo().username;
          } catch {
            return '';
          }
        })(),
        cwd: process.cwd(),
        appRoot: APP_ROOT,
        dataDir: DATA_DIR,
        execPath: process.execPath,
        uptimeSec: Math.round(process.uptime()),
        totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
        freeMemMB: Math.round(os.freemem() / 1024 / 1024),
        cpu: os.cpus().map((c) => c.model).slice(0, 2),
        versions: process.versions,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const settings = scrub(getSettings());
      const license = scrub(licenseStatus({ refresh: true }));
      const client = scrub(req.body?.client || {});
      const description = redactString(String(req.body?.description || '').slice(0, 20_000));

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="TuKu-diagnostics-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(
          `图库诊断包-${stamp}.zip`
        )}`
      );
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => {
        console.error('[diagnostics] zip error', err);
        res.destroy(err);
      });
      archive.pipe(res);

      const add = (name, value) => archive.append(`${JSON.stringify(value, null, 2)}\n`, { name });
      add('meta.json', meta);
      add('settings.json', settings);
      add('license.json', license);
      add('network.json', networkInfo());
      add('oms.json', scrub(oms || {}));
      add('actions.json', recentActions());
      add('client.json', client);
      archive.append(description || '（用户未填写问题描述）\n', { name: 'description.txt' });
      archive.append(
        [
          '图库诊断包',
          '',
          '包含：系统环境、网络接口/代理、设置（密钥已脱敏）、授权状态（无授权码原文）、最近 200 条操作日志、最近日志文件、问题描述。',
          '不包含：密码、API token、OMS 账号密码、授权私钥、图片原文件。',
          '日志里的 token=/Bearer 等敏感串已替换为 ***。',
          '',
          '请把这个 zip 直接提交给开发者。',
        ].join('\n'),
        { name: 'README.txt' }
      );
      for (const log of logs) archive.append(log.text, { name: `logs/${log.name}` });
      await archive.finalize();
    })
  );
}
