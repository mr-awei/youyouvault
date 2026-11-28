// @ts-check
/**
 * 多端同步 API：同步文件夹 + 带 revision 的库快照。
 *
 * 不做在线账号 / 实时行级合并。发布走 backupLibrary（VACUUM INTO 干净快照），
 * 拉取走 restoreLibrary（登记为新资源库 + 路径重映射），两者都是已有且验证过的链路。
 * 原图不进快照：原图由用户自己的同步盘 / 素材目录负责，README 里说清楚。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { db } from '../db.js';
import { getActiveLibrary } from '../libraries.js';
import { backupLibrary, restoreLibrary } from '../lib/transfer.js';
import { assertWritableDir } from '../lib/safe-path.js';
import {
  SYNC_FORMAT,
  SYNC_VERSION,
  SNAPSHOT_FILES,
  sha256,
  validateManifest,
  fingerprintOf,
  syncDecision,
  canPublish,
  hasLocalBaseline,
} from '../lib/sync.js';

const STATE_FILE = path.join(DATA_DIR, 'sync-state.json');

function defaultState() {
  return {
    syncDir: '',
    deviceId: crypto.randomUUID(),
    lastPublishedRevision: 0,
    lastPulledRevision: 0,
    lastPublishedFingerprint: '',
  };
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...defaultState(), ...raw };
  } catch {
    const fresh = defaultState();
    writeState(fresh);
    return fresh;
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 不能被写成半截：readState 解析失败会退回默认状态，deviceId 换新会让同步盘把本机
  // 当成「另一台设备」，基线指纹也一起丢，之后每次发布都被判成有冲突
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}

function localFingerprint() {
  const a = db.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(id),0) AS m FROM images').get() || {};
  let ops = 0;
  let folders = 0;
  try {
    ops = Number(db.prepare('SELECT COALESCE(MAX(id),0) AS o FROM op_log').get()?.o || 0);
  } catch {
    /* 旧库可能还没有撤销栈 */
  }
  try {
    folders = Number(db.prepare('SELECT COUNT(*) AS c FROM image_folders').get()?.c || 0);
  } catch {
    /* 旧库可能还没有文件夹表 */
  }
  // 内容摘要：备注/标签/收藏、清单、文件夹名这些改动都不会写 op_log，
  // 只看行数与前缀会判成「未变化」，发布直接返回 0 字节。
  let content;
  try {
    const img = db
      .prepare(
        'SELECT COALESCE(SUM(LENGTH(title) + LENGTH(tags) + LENGTH(keyword) + favorite), 0) AS s FROM images'
      )
      .get();
    const pl = db
      .prepare("SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), '') AS m FROM playlists")
      .get();
    const fd = db
      .prepare("SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), '') AS m FROM folders")
      .get();
    content = [Number(img?.s || 0), Number(pl?.c || 0), String(pl?.m || ''), Number(fd?.c || 0), String(fd?.m || '')].join('/');
  } catch {
    /* 旧库缺表：退回旧口径，至少不会因为读不到而发布失败 */
    content = 'legacy';
  }
  return fingerprintOf({
    images: Number(a.c || 0),
    maxImage: Number(a.m || 0),
    maxOp: ops,
    folders,
    content,
  });
}

/**
 * 先写同目录临时文件再改名：同步盘随时可能扫目录，直接覆盖会让人读到半截 JSON。
 * 改名在同一分区上是原子的，读到的要么是旧版、要么是新版。
 */
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return { manifest: null, error: '' };
  try {
    const parsed = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.error ? { manifest: null, error: parsed.error } : { manifest: parsed.manifest, error: '' };
  } catch (err) {
    return { manifest: null, error: `同步清单读取失败：${err?.message || err}` };
  }
}

function requireDir(state, res) {
  if (!state.syncDir) {
    res.status(400).json({ error: '还没有设置同步文件夹' });
    return false;
  }
  if (!fs.existsSync(state.syncDir)) {
    res.status(400).json({ error: `同步文件夹不存在：${state.syncDir}` });
    return false;
  }
  return true;
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get(
    '/api/sync/status',
    asyncRoute(async (_req, res) => {
      const st = readState();
      const { manifest, error } = st.syncDir ? readManifest(st.syncDir) : { manifest: null, error: '' };
      const fp = localFingerprint();
      res.json({
        ok: true,
        enabled: !!st.syncDir,
        syncDir: st.syncDir,
        deviceId: st.deviceId,
        localRevision: Math.max(st.lastPulledRevision, st.lastPublishedRevision),
        remoteRevision: manifest?.revision || 0,
        remoteDevice: manifest?.deviceId || '',
        publishedAt: manifest?.publishedAt || '',
        libraryName: manifest?.libraryName || '',
        dirty: hasLocalBaseline(st) && fp !== st.lastPublishedFingerprint,
        manifestError: error,
        note: '传输层是同步文件夹；快照只含元数据，原图由素材目录自行同步；拉取会登记为一个新资源库',
      });
    })
  );

  app.post(
    '/api/sync/configure',
    asyncRoute(async (req, res) => {
      const raw = String(req.body?.syncDir || '').trim();
      const st = readState();
      if (!raw) {
        writeState({ ...st, syncDir: '' });
        return res.json({ ok: true, enabled: false, note: '已关闭同步（同步文件夹里的快照保留）' });
      }
      // 和导入/备份走同一道闸：光判「绝对路径 + 不含 ..」不足以挡住
      // C:\Windows\System32、启动目录这类地方 —— 发布时我们要往里写 gallery.db
      let dir;
      try {
        dir = assertWritableDir(raw, '同步文件夹');
      } catch (err) {
        return res.status(400).json({ error: err?.message || String(err) });
      }
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
      } catch (err) {
        return res.status(400).json({ error: `同步文件夹不可写：${err?.message || err}` });
      }
      writeState({ ...st, syncDir: dir });
      res.json({ ok: true, enabled: true, syncDir: dir });
    })
  );

  app.post(
    '/api/sync/publish',
    asyncRoute(async (req, res) => {
      const st = readState();
      if (!requireDir(st, res)) return;
      const { manifest, error } = readManifest(st.syncDir);
      if (error) return res.status(400).json({ error });
      const gate = canPublish({
        deviceId: st.deviceId,
        lastPulledRevision: st.lastPulledRevision,
        remote: manifest,
      });
      if (!gate.ok) return res.status(409).json({ error: gate.reason });

      // 用「数据指纹」而不是文件字节判断是否变化：library.json 里带导出时间，
      // 每次备份的字节必然不同，按文件 hash 比会永远判成「有变化」。
      // 指纹没变时连 VACUUM INTO 都不跑，真正 0 字节传输。
      const fp = localFingerprint();
      const unchanged =
        !!manifest && manifest.deviceId === st.deviceId && manifest.fingerprint === fp;
      if (unchanged && !req.body?.force) {
        return res.json({
          ok: true,
          unchanged: true,
          revision: manifest.revision,
          note: '本机数据与上一版相同，未写同步盘（增量跳过，0 字节传输）',
        });
      }

      // 临时目录放在本机数据目录，不能放同步盘：否则网盘会把半成品也同步走
      const tmpRoot = path.join(DATA_DIR, 'sync-tmp');
      let backup;
      let files;
      let revision;
      try {
        fs.mkdirSync(tmpRoot, { recursive: true });
        try {
          backup = backupLibrary({ targetDir: tmpRoot, includeThumbs: false });
        } catch (err) {
          return res.status(500).json({ error: `生成快照失败：${err?.message || err}` });
        }
        files = SNAPSHOT_FILES.map((name) => {
          const buffer = fs.readFileSync(path.join(backup.dir, name));
          return { name, buffer, sha256: sha256(buffer), size: buffer.length };
        });

        const snapDir = path.join(st.syncDir, 'snapshot');
        fs.mkdirSync(snapDir, { recursive: true });
        // 每个文件也走「临时名 + 改名」：网盘扫到 .part 会跳过，不会把半截 DB 校验成坏文件
        for (const f of files) {
          writeAtomic(path.join(snapDir, f.name), f.buffer);
        }
        // 同步盘清单可能被网盘还原 / 手工删掉，这时不能从 1 重新开始，
        // 否则对端会按 revision 判定「本机已是最新」而永远拉不到新快照。
        revision = Math.max(Number(manifest?.revision) || 0, Number(st.lastPublishedRevision) || 0) + 1;
        const active = getActiveLibrary();
        const next = {
          format: SYNC_FORMAT,
          version: SYNC_VERSION,
          revision,
          publishedAt: new Date().toISOString(),
          deviceId: st.deviceId,
          libraryId: active?.id || '',
          libraryName: active?.name || '图库',
          rootPath: active?.root_path || '',
          counts: backup.counts,
          fingerprint: fp,
          files: files.map((f) => ({ name: f.name, sha256: f.sha256, size: f.size })),
        };
        // manifest 是提交点，必须最后写且原子写
        writeAtomic(path.join(st.syncDir, 'manifest.json'), JSON.stringify(next, null, 2));
        writeState({
          ...st,
          lastPublishedRevision: revision,
          lastPulledRevision: revision,
          lastPublishedFingerprint: fp,
        });
      } catch (err) {
        return res.status(500).json({ error: `写入同步盘失败：${err?.message || err}` });
      } finally {
        // 成功或失败都要清掉，否则临时快照会一直堆在本机数据目录里
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
      res.json({
        ok: true,
        unchanged: false,
        revision,
        bytes: files.reduce((n, f) => n + f.size, 0),
        counts: backup.counts,
        note: '已发布元数据快照；原图不会进同步盘，请让素材目录自行同步',
      });
    })
  );

  app.post(
    '/api/sync/pull',
    asyncRoute(async (req, res) => {
      const st = readState();
      if (!requireDir(st, res)) return;
      const { manifest, error } = readManifest(st.syncDir);
      if (error) return res.status(400).json({ error });
      if (!manifest) return res.status(404).json({ error: '同步文件夹里还没有任何设备发布过快照' });

      // 逐个校验 sha256：网盘经常只同步了一半文件，不能拿半截 DB 去建库
      for (const f of manifest.files) {
        const p = path.join(st.syncDir, 'snapshot', f.name);
        if (!fs.existsSync(p)) {
          return res.status(409).json({ error: `快照文件 ${f.name} 还没同步到本机，请等网盘传完再拉取` });
        }
        if (sha256(fs.readFileSync(p)) !== f.sha256) {
          return res.status(409).json({ error: `快照文件 ${f.name} 校验和不匹配，可能只传了一半，请重新同步` });
        }
      }
      const fp = localFingerprint();
      const dirty = hasLocalBaseline(st) && fp !== st.lastPublishedFingerprint;
      const force = req.body?.force === true;
      const decision = syncDecision({
        localRevision: st.lastPulledRevision,
        remoteRevision: manifest.revision,
        dirty,
        force,
      });
      if (decision.action === 'up-to-date') {
        return res.json({ ok: true, skipped: true, reason: decision.reason, revision: manifest.revision });
      }
      if (decision.action === 'conflict') {
        return res.status(409).json({ error: decision.reason, revision: manifest.revision });
      }

      const tmp = path.join(DATA_DIR, `sync-pull-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      try {
        for (const f of manifest.files) {
          fs.copyFileSync(path.join(st.syncDir, 'snapshot', f.name), path.join(tmp, f.name));
        }
        const active = getActiveLibrary();
        const restored = restoreLibrary({
          sourceDir: tmp,
          name: String(req.body?.name || `${manifest.libraryName}（同步 r${manifest.revision}）`).slice(0, 80),
          rootPath: String(req.body?.rootPath || active?.root_path || '').trim(),
        });
        writeState({
          ...st,
          lastPulledRevision: manifest.revision,
          lastPublishedRevision: manifest.revision,
          lastPublishedFingerprint: fp,
        });
        res.json({
          ok: true,
          skipped: false,
          revision: manifest.revision,
          reason: decision.reason,
          forced: force,
          libraryId: restored.id,
          libraryName: restored.name,
          remapped: restored.remapped,
          missing: restored.missing,
          note: restored.note,
        });
      } catch (err) {
        return res.status(500).json({ error: `拉取失败：${err?.message || err}` });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    })
  );
}
