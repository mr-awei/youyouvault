// @ts-check
/**
 * 条码分文件夹：拍摄流程的第一步。
 *
 * 扫描（只读）→ 前端确认/改编码 → 复制（只复制，不移动原图）。
 * 输出结构：<输出根目录>/<拍摄日期>/<编码>/<原文件名>
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { db, getLibraryGeneration } from '../db.js';
import { ensureFolderUnderParent, linkImageToFolder } from '../folders.js';
import { ingest, setTags } from '../library.js';
import { assertWritableDir } from '../lib/safe-path.js';
import { safeCodeName, scanDir } from '../lib/barcode-split.js';

const RASTER = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 源目录只读校验：必须绝对路径且真实存在 */
function assertSourceDir(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('请选择源目录');
  if (!path.isAbsolute(raw)) throw new Error(`源目录必须是绝对路径（收到：${raw}）`);
  const resolved = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new Error(`源目录不存在：${resolved}`);
  }
  if (!st.isDirectory()) throw new Error(`源目录不是文件夹：${resolved}`);
  return resolved;
}

/** child 是否等于 parent 或位于其下 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 同批编码重复时依次加 -2 / -3；Windows 文件夹名大小写不敏感，统一按小写判重 */
function uniqueFolderName(base, used) {
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base}-${n}`;
    n++;
  }
  used.add(name.toLowerCase());
  return name;
}

/**
 * 找一个不覆盖已有文件的落点。
 * 同名同大小视为「之前已经复制过」，直接跳过；同名不同大小则加 (2)。
 */
async function resolveDest(folder, src, size) {
  const base = path.parse(src).name;
  const ext = path.extname(src);
  for (let n = 1; n < 200; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    const dest = path.join(folder, name);
    try {
      const st = await fsp.stat(dest);
      if (st.isFile() && st.size === size) return { dest, same: true };
    } catch {
      return { dest, same: false };
    }
  }
  return { dest: path.join(folder, `${base}-${Date.now()}${ext}`), same: false };
}

/** 标签里不能带逗号（库内标签用逗号分隔），换行也压成空格 */
function cleanTag(value) {
  return String(value || '')
    .replace(/[,，\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function splitTags(value) {
  return String(value || '')
    .split(',')
    .map((t) => cleanTag(t))
    .filter(Boolean);
}

function mergeTags(existing, extra) {
  const out = [];
  for (const t of [...splitTags(existing), ...extra.map(cleanTag)]) {
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 重跑同一编码时，把目标文件夹里不属于本次分组的旧文件移到 .stale 子目录。
 * 只移动、不删除：上一次误分进来的条码/下一组产品图都能找回。
 * destFiles 为空时不动，避免把整个文件夹清空。
 */
async function moveStaleFiles(folder, destFiles, dateDir, folderName) {
  if (!destFiles.length) return { moved: 0, errors: [] };
  let entries;
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    return { moved: 0, errors: [] };
  }
  const keep = new Set(destFiles.map((p) => path.basename(p).toLowerCase()));
  const stale = entries.filter((e) => e.isFile() && !keep.has(e.name.toLowerCase()));
  if (!stale.length) return { moved: 0, errors: [] };

  const staleDir = path.join(dateDir, '.stale', `${folderName}-${Date.now()}`);
  await fsp.mkdir(staleDir, { recursive: true });
  const errors = [];
  let moved = 0;
  for (const e of stale) {
    const oldAbs = path.join(folder, e.name);
    const newAbs = path.join(staleDir, e.name);
    try {
      await fsp.rename(oldAbs, newAbs);
      // 如果这张图之前已经入过库，把 abs_path 跟着改到 .stale，避免库内记录变成「文件缺失」
      try {
        db.prepare('UPDATE images SET abs_path = ? WHERE abs_path = ?').run(newAbs, oldAbs);
      } catch {
        /* 老库结构/唯一索引冲突时忽略：文件已移动，库记录最多显示缺失 */
      }
      moved++;
    } catch (err) {
      errors.push({ file: e.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { moved, errors };
}

/**
 * 把复制出来的图片登记进当前图库，并挂到指定文件夹。
 * 只登记、不移动文件：abs_path 仍指向输出目录，图库文件夹是虚拟层级。
 * 已经登记过的路径（重复保存）只补标签/文件夹，不重复入库。
 */
async function importImageToFolder(absPath, folderId, tags, generation) {
  let result;
  try {
    result = await ingest({
      absPath,
      source: 'barcode',
      tags: tags.join(','),
      // 产品图之间常常非常相似，pHash / CLIP 查重会把同组图误杀；这里按路径去重即可
      skipPhashDupe: true,
      // 用户明确选择的拍摄图不该被「小于 30KB / 短边 800」门槛拦掉
      skipQuality: true,
      // 也不该因为智能评分低被丢掉：条码分组已经是人工确认过的产品图
      skipAiFilter: true,
      libGeneration: generation,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (result?.ok && result.id) {
    linkImageToFolder(result.id, folderId);
    return { ok: true, id: result.id, duplicate: false };
  }
  // 路径已经在库里（重复保存）：找到原记录，合并标签并重新挂文件夹
  const row = db.prepare('SELECT id, tags FROM images WHERE abs_path = ?').get(absPath);
  if (row?.id) {
    const merged = mergeTags(row.tags, tags);
    setTags(row.id, merged);
    linkImageToFolder(row.id, folderId);
    return { ok: true, id: row.id, duplicate: true };
  }
  return { ok: false, error: result?.reason || '入库失败' };
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /* 扫描源目录：判黄 + OCR + 分组，不写任何文件 */
  app.post(
    '/api/barcode/scan',
    asyncRoute(async (req, res) => {
      const dir = assertSourceDir(req.body?.dir);
      const lang = typeof req.body?.lang === 'string' ? req.body.lang : '';
      const result = await scanDir(dir, { lang });
      res.json(result);
    })
  );

  /* 按确认后的编码复制产品图 */
  app.post(
    '/api/barcode/apply',
    asyncRoute(async (req, res) => {
      const dir = assertSourceDir(req.body?.dir);
      const root = assertWritableDir(req.body?.root, '输出根目录');
      const date = String(req.body?.date ?? '').trim();
      if (!DATE_RE.test(date)) return res.status(400).json({ error: '日期格式必须是 YYYY-MM-DD' });
      // 输出目录若在源目录里（或反过来），下次递归扫描会把自己的产物再扫进来
      if (isInside(dir, root) || isInside(root, dir)) {
        return res.status(400).json({ error: '输出根目录不能与源目录相同或互相包含' });
      }

      const input = Array.isArray(req.body?.groups) ? req.body.groups : [];
      if (!input.length) return res.status(400).json({ error: '没有可复制的分组' });

      const importToLibrary = req.body?.importToLibrary === true;
      const cleanStale = req.body?.cleanStale === true;
      let parentFolderId = null;
      if (importToLibrary && req.body?.parentFolderId != null) {
        const pid = Number(req.body.parentFolderId);
        if (!Number.isInteger(pid) || pid <= 0) {
          return res.status(400).json({ error: '入库父文件夹不合法' });
        }
        const exists = db.prepare('SELECT id FROM folders WHERE id = ?').get(pid);
        if (!exists) return res.status(400).json({ error: '入库父文件夹不存在，请重新选择' });
        parentFolderId = pid;
      }

      const dateDir = path.join(root, date);
      await fsp.mkdir(dateDir, { recursive: true });
      // 入库层级：当前选中的文件夹 / 拍摄日期 / 编码；只建虚拟夹，不移动已复制的文件
      const dateFolderId = importToLibrary ? ensureFolderUnderParent(parentFolderId, date) : null;

      const used = new Set();
      const results = [];
      let totalCopied = 0;
      let importedTotal = 0;
      let importSkippedTotal = 0;
      let cleanedTotal = 0;

      for (const g of input) {
        if (g?.skip) continue;
        const code = safeCodeName(g?.code);
        if (!code) {
          results.push({
            code: '',
            folder: '',
            copied: 0,
            skipped: 0,
            errors: [{ file: '', error: '编码为空，已跳过该组' }],
            imported: 0,
            importSkipped: 0,
            importErrors: [],
            libraryFolderId: null,
            cleaned: 0,
            cleanErrors: [],
          });
          continue;
        }
        const folderName = uniqueFolderName(code, used);
        const folder = path.join(dateDir, folderName);
        await fsp.mkdir(folder, { recursive: true });

        let copied = 0;
        let skipped = 0;
        const errors = [];
        /** 复制到输出目录的最终路径；同名同大小跳过的也算，重复保存时仍要补标签 */
        const destFiles = [];
        const list = Array.isArray(g.files) ? g.files : [];
        for (const rel of list) {
          const src = path.resolve(dir, String(rel));
          if (!isInside(dir, src) || src === dir) {
            errors.push({ file: String(rel), error: '文件不在源目录内' });
            continue;
          }
          try {
            const st = await fsp.stat(src);
            if (!st.isFile()) {
              errors.push({ file: String(rel), error: '不是文件' });
              continue;
            }
            const { dest, same } = await resolveDest(folder, src, st.size);
            if (same) {
              skipped++;
              destFiles.push(dest);
              continue;
            }
            await fsp.copyFile(src, dest);
            copied++;
            destFiles.push(dest);
          } catch (err) {
            errors.push({ file: String(rel), error: err instanceof Error ? err.message : String(err) });
          }
        }
        totalCopied += copied;

        let cleaned = 0;
        const cleanErrors = [];
        if (cleanStale) {
          const r = await moveStaleFiles(folder, destFiles, dateDir, folderName);
          cleaned = r.moved;
          cleanErrors.push(...r.errors);
          cleanedTotal += cleaned;
        }

        let imported = 0;
        let importSkipped = 0;
        const importErrors = [];
        let libraryFolderId = null;
        if (importToLibrary && dateFolderId) {
          try {
            libraryFolderId = ensureFolderUnderParent(dateFolderId, folderName);
            const mainSku =
              cleanTag(g.mainSku) || (String(g.code || '').match(/^(\d{4,6})/)?.[1] || '');
            const tags = [
              ...new Set(
                [cleanTag(g.productName), cleanTag(g.code), cleanTag(mainSku)].filter(Boolean)
              ),
            ];
            const generation = getLibraryGeneration();
            for (const dest of destFiles) {
              const r = await importImageToFolder(dest, libraryFolderId, tags, generation);
              if (r.ok) {
                if (r.duplicate) importSkipped++;
                else imported++;
              } else {
                importErrors.push({ file: path.basename(dest), error: r.error || '入库失败' });
              }
            }
          } catch (err) {
            importErrors.push({ file: '', error: err instanceof Error ? err.message : String(err) });
          }
        }
        importedTotal += imported;
        importSkippedTotal += importSkipped;

        results.push({
          code: folderName,
          folder,
          copied,
          skipped,
          errors,
          imported,
          importSkipped,
          importErrors,
          libraryFolderId,
          cleaned,
          cleanErrors,
        });
      }

      res.json({
        ok: true,
        dateDir,
        totalCopied,
        results,
        importedTotal,
        importSkippedTotal,
        cleanedTotal,
        importedToLibrary: importToLibrary,
      });
    })
  );

  /* 缩略图：源目录不在图库里，按绝对路径 + 相对文件名即时生成 */
  app.get(
    '/api/barcode/thumb',
    asyncRoute(async (req, res) => {
      const dir = String(req.query.dir || '').trim();
      const name = String(req.query.name || '').trim();
      if (!dir || !name) return res.status(400).json({ error: '缺少 dir 或 name 参数' });
      if (!path.isAbsolute(dir)) return res.status(400).json({ error: 'dir 必须是绝对路径' });

      let root;
      try {
        root = fs.realpathSync(dir);
      } catch {
        return res.status(404).json({ error: '目录不存在' });
      }
      if (name.includes('..') || path.isAbsolute(name)) {
        return res.status(400).json({ error: '文件名不合法' });
      }
      const abs = path.resolve(root, name);
      if (!isInside(root, abs)) return res.status(400).json({ error: '文件名不合法' });
      if (!RASTER.has(path.extname(abs).toLowerCase())) {
        return res.status(415).json({ error: '不支持的图片格式' });
      }

      // 双击看大图时前端会传 max（如 2400）；普通缩略图保持 240，避免浪费带宽
      const maxRaw = Number.parseInt(String(req.query.max || ''), 10);
      const max = Number.isFinite(maxRaw) ? Math.min(3000, Math.max(64, maxRaw)) : 240;

      try {
        const buf = await sharp(abs, { failOn: 'none' })
          .rotate()
          .resize(max, max, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: max > 480 ? 86 : 72 })
          .toBuffer();
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'private, max-age=3600');
        res.send(buf);
      } catch {
        res.status(404).json({ error: '无法生成预览' });
      }
    })
  );
}
