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
import { naturalCompare, naturalSort, safeCodeName, scanDir } from '../lib/barcode-split.js';
import { suggestDateFolder } from '../lib/barcode-naming.js';

const RASTER = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 原子替换文件：Windows 上资源管理器/预览窗格可能正占着原图，
 * rename 会报 EBUSY/EPERM。重试几次让「部分图片裁切没生效」不再悄悄发生；
 * 始终失败的会作为该文件的错误返回，前端会列出文件名。
 */
async function replaceImage(tmp, abs) {
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      await fsp.rename(tmp, abs);
      return;
    } catch (err) {
      last = err;
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(err?.code)) throw err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw last;
}

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

/** 输出侧文件夹校验：必须是绝对路径且真实存在的目录 */
function assertFolder(input, label = '编码文件夹') {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error(`${label}不能为空`);
  if (!path.isAbsolute(raw)) throw new Error(`${label}必须是绝对路径（收到：${raw}）`);
  const resolved = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new Error(`${label}不存在：${resolved}`);
  }
  if (!st.isDirectory()) throw new Error(`${label}不是文件夹：${resolved}`);
  return resolved;
}

/** 文件夹里直接包含的图片文件名（不含子目录），按自然顺序排 */
async function listImageFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return naturalSort(
    entries
      .filter((e) => e.isFile() && RASTER.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
  );
}

/**
 * 收集输出根目录附近的目录名，用来学习日期命名格式。
 * 现场常见的两种结构：
 *   D:\李伟\11月\20261103          （日期在根目录下一级）
 *   D:\李伟\2026\20261103          （根目录本身是月份/年份）
 * 所以同时看根目录名、直接子级、以及子级里的下一层；最多 600 个名字，避免大库卡住。
 */
async function collectNamingSamples(root) {
  /** @type {string[]} */
  const out = [path.basename(root)];
  let visited = 0;
  const walk = async (dir, depth) => {
    if (visited > 600) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let dirs = 0;
    for (const e of entries) {
      if (visited++ > 600) return;
      if (e.name.startsWith('.')) continue;
      out.push(e.name);
      if (e.isDirectory() && depth < 1 && dirs < 40) {
        dirs++;
        await walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  await walk(root, 0);
  return out;
}

/** 列出目录下的一级子文件夹及图片数（直接选择「已整理好的日期文件夹」生成报表用） */
async function listSubfolders(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const out = [];
  for (const e of dirs) {
    let files = 0;
    try {
      files = (await listImageFiles(path.join(dir, e.name))).length;
    } catch {
      /* 无权限/读失败按 0 张处理 */
    }
    out.push({ name: e.name, files });
  }
  out.sort((a, b) => naturalCompare(a.name, b.name));
  return out;
}

/**
 * 读取图片「显示方向」的宽高。
 * 手机竖拍常见 EXIF 方向 5–8，元数据里的宽高是反的，必须交换后再判断 1:1。
 */
async function imageSize(abs) {
  const meta = await sharp(abs, { failOn: 'none' }).metadata();
  let width = Number(meta.width || 0);
  let height = Number(meta.height || 0);
  const orientation = Number(meta.orientation || 1);
  if (orientation >= 5 && orientation <= 8) [width, height] = [height, width];
  return { width, height };
}

/** 请求里的文件名是否安全且确实位于 dir 内 */
function safeChildName(dir, name) {
  const raw = String(name ?? '').trim();
  if (!raw || raw.includes('..') || path.isAbsolute(raw) || raw.includes('/') || raw.includes('\\')) {
    return '';
  }
  if (!RASTER.has(path.extname(raw).toLowerCase())) return '';
  const abs = path.resolve(dir, raw);
  return isInside(dir, abs) ? abs : '';
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

  /* 学习输出根目录已有的日期命名格式（20261114 / 2026-11-14 …） */
  app.get(
    '/api/barcode/date-folder',
    asyncRoute(async (req, res) => {
      const date = String(req.query?.date || '').trim();
      if (!DATE_RE.test(date)) return res.status(400).json({ error: '日期格式必须是 YYYY-MM-DD' });
      const raw = String(req.query?.root || '').trim();
      if (!raw) return res.status(400).json({ error: '缺少输出根目录' });
      let root;
      try {
        root = assertFolder(raw, '输出根目录');
      } catch {
        // 目录还没建也能给默认值，不阻塞用户
        return res.json({ ok: true, date, name: date, learned: false, key: '', label: '', count: 0, samples: [] });
      }
      const names = await collectNamingSamples(root);
      res.json({ ok: true, date, ...suggestDateFolder(names, date) });
    })
  );

  /* 列出一级子文件夹与图片数：用户选一个「已整理好的日期文件夹」直接生成报表 */
  app.get(
    '/api/barcode/subfolders',
    asyncRoute(async (req, res) => {
      let dir;
      try {
        dir = assertFolder(req.query?.dir, '文件夹');
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
      res.json({ ok: true, dir, folders: await listSubfolders(dir) });
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

      const dateFolderName = safeCodeName(req.body?.dateFolder) || date;
      const dateDir = path.join(root, dateFolderName);
      await fsp.mkdir(dateDir, { recursive: true });
      // 入库层级：当前选中的文件夹 / 日期文件夹 /（可选分类）/ 编码；只建虚拟夹，不移动已复制的文件
      const dateFolderId = importToLibrary ? ensureFolderUnderParent(parentFolderId, dateFolderName) : null;

      /** 每个分类子目录单独判重：eBay / 非eBay 下可以出现同名编码 */
      const usedBySub = new Map();
      const results = [];
      let totalCopied = 0;
      let importedTotal = 0;
      let importSkippedTotal = 0;
      let cleanedTotal = 0;

      for (let sourceIndex = 0; sourceIndex < input.length; sourceIndex++) {
        const g = input[sourceIndex];
        if (g?.skip) continue;
        const code = safeCodeName(g?.code);
        if (!code) {
          results.push({
            sourceIndex,
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
        const sub = safeCodeName(g.subfolder);
        const subKey = sub.toLowerCase();
        let used = usedBySub.get(subKey);
        if (!used) {
          used = new Set();
          usedBySub.set(subKey, used);
        }
        const folderName = uniqueFolderName(code, used);
        const folderBase = sub ? path.join(dateDir, sub) : dateDir;
        const folder = path.join(folderBase, folderName);
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
          const r = await moveStaleFiles(folder, destFiles, folderBase, folderName);
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
            const subFolderId = sub ? ensureFolderUnderParent(dateFolderId, sub) : dateFolderId;
            libraryFolderId = ensureFolderUnderParent(subFolderId, folderName);
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
          sourceIndex,
          code: folderName,
          subfolder: sub,
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

  /* 检查 eBay 图片是否为 1:1（只读，不修改文件） */
  app.post(
    '/api/barcode/ratio',
    asyncRoute(async (req, res) => {
      const input = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!input.length) return res.status(400).json({ error: '没有要检查的文件夹' });

      const items = [];
      for (const it of input) {
        const code = String(it?.code || '').trim();
        let dir;
        try {
          dir = assertFolder(it?.dir);
        } catch (err) {
          items.push({
            code,
            dir: String(it?.dir || ''),
            total: 0,
            notSquare: [],
            errors: [{ file: '', error: err instanceof Error ? err.message : String(err) }],
          });
          continue;
        }

        const names =
          Array.isArray(it?.files) && it.files.length ? it.files.map(String) : await listImageFiles(dir);
        const notSquare = [];
        const errors = [];
        for (const name of names) {
          const abs = safeChildName(dir, name);
          if (!abs) {
            errors.push({ file: String(name), error: '文件名不合法或不是图片' });
            continue;
          }
          try {
            const { width, height } = await imageSize(abs);
            if (!width || !height) errors.push({ file: String(name), error: '读不到图片尺寸' });
            else if (width !== height) notSquare.push({ file: String(name), width, height });
          } catch (err) {
            errors.push({ file: String(name), error: err instanceof Error ? err.message : String(err) });
          }
        }
        items.push({ code, dir, total: names.length, notSquare, errors });
      }
      res.json({ items });
    })
  );

  /* 居中裁成 1:1：原地覆盖，先写临时文件再 rename，避免裁一半留下坏图 */
  app.post(
    '/api/barcode/crop',
    asyncRoute(async (req, res) => {
      const input = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!input.length) return res.status(400).json({ error: '没有要裁剪的文件夹' });

      const items = [];
      for (const it of input) {
        const code = String(it?.code || '').trim();
        let dir;
        try {
          dir = assertFolder(it?.dir);
        } catch (err) {
          items.push({
            code,
            dir: String(it?.dir || ''),
            cropped: [],
            errors: [{ file: '', error: err instanceof Error ? err.message : String(err) }],
          });
          continue;
        }

        const names =
          Array.isArray(it?.files) && it.files.length ? it.files.map(String) : await listImageFiles(dir);
        const cropped = [];
        const errors = [];
        for (const name of names) {
          const abs = safeChildName(dir, name);
          if (!abs) {
            errors.push({ file: String(name), error: '文件名不合法或不是图片' });
            continue;
          }
          try {
            const { width, height } = await imageSize(abs);
            if (!width || !height) {
              errors.push({ file: String(name), error: '读不到图片尺寸' });
              continue;
            }
            const side = Math.min(width, height);
            if (width === side && height === side) continue;
            const left = Math.floor((width - side) / 2);
            const top = Math.floor((height - side) / 2);
            const ext = path.extname(abs).toLowerCase();
            const tmp = path.join(dir, `.crop-${Date.now()}-${cropped.length}${ext}`);
            await sharp(abs, { failOn: 'none' })
              .rotate()
              .extract({ left, top, width: side, height: side })
              .toFile(tmp);
            await replaceImage(tmp, abs);
            cropped.push(String(name));
          } catch (err) {
            errors.push({ file: String(name), error: err instanceof Error ? err.message : String(err) });
          }
        }
        items.push({ code, dir, cropped, errors });
      }
      res.json({ items });
    })
  );

  /* 批量裁切台：按每张图各自的裁切框原地覆盖（文件夹图片还没入库、没有图库 id） */
  app.post(
    '/api/barcode/crop-rects',
    asyncRoute(async (req, res) => {
      const input = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!input.length) return res.status(400).json({ error: '没有要裁剪的图片' });

      const items = [];
      for (const it of input) {
        const code = String(it?.code || '').trim();
        const file = String(it?.file || '').trim();
        let dir;
        try {
          dir = assertFolder(it?.dir);
        } catch (err) {
          items.push({ code, file, cropped: false, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        const abs = safeChildName(dir, file);
        if (!abs) {
          items.push({ code, file, cropped: false, error: '文件名不合法或不是图片' });
          continue;
        }
        try {
          const r = it?.rect || {};
          const x = Math.min(1, Math.max(0, Number(r.x) || 0));
          const y = Math.min(1, Math.max(0, Number(r.y) || 0));
          const w = Math.min(1 - x, Math.max(0.01, Number(r.w) || 1));
          const h = Math.min(1 - y, Math.max(0.01, Number(r.h) || 1));
          const { width, height } = await imageSize(abs);
          if (!width || !height) throw new Error('读不到图片尺寸');
          const left = Math.round(x * width);
          const top = Math.round(y * height);
          const cw = Math.max(1, Math.min(width - left, Math.round(w * width)));
          const ch = Math.max(1, Math.min(height - top, Math.round(h * height)));
          const ext = path.extname(abs).toLowerCase();
          const tmp = path.join(dir, `.crop-${Date.now()}-${items.length}${ext}`);
          await sharp(abs, { failOn: 'none' })
            .rotate()
            .extract({ left, top, width: cw, height: ch })
            .toFile(tmp);
          await replaceImage(tmp, abs);
          items.push({ code, file, cropped: true, width: cw, height: ch });
        } catch (err) {
          items.push({ code, file, cropped: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      res.json({ items });
    })
  );

  /* 编号前列出产品文件夹里的图片，让用户自己选哪五张排最前 */
  app.get(
    '/api/barcode/folder-images',
    asyncRoute(async (req, res) => {
      let dir;
      try {
        dir = assertFolder(req.query?.dir);
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
      res.json({ files: await listImageFiles(dir) });
    })
  );

  /* 图片编号：按用户选定顺序（默认拍摄顺序）重命名成 1.jpg / 2.jpg… */
  app.post(
    '/api/barcode/number',
    asyncRoute(async (req, res) => {
      const input = Array.isArray(req.body?.folders) ? req.body.folders : [];
      if (!input.length) return res.status(400).json({ error: '没有要编号的文件夹' });

      const results = [];
      for (const it of input) {
        const code = String(it?.code || '').trim();
        let dir;
        try {
          dir = assertFolder(it?.dir);
        } catch (err) {
          results.push({
            code,
            dir: String(it?.dir || ''),
            files: [],
            errors: [{ file: '', error: err instanceof Error ? err.message : String(err) }],
          });
          continue;
        }

        const onDisk = await listImageFiles(dir);
        // 用户选定顺序优先：选中的前 5 张排最前，其余按自然序跟随；没传 files 时维持旧行为。
        const requested = Array.isArray(it?.files)
          ? it.files.map((n) => String(n || '').trim()).filter(Boolean)
          : [];
        let names = onDisk;
        if (requested.length) {
          const seen = new Set();
          const picked = [];
          for (const name of requested) {
            if (!safeChildName(dir, name) || !onDisk.includes(name) || seen.has(name)) continue;
            seen.add(name);
            picked.push(name);
          }
          if (picked.length) names = [...picked, ...onDisk.filter((n) => !seen.has(n))];
        }
        const errors = [];
        const temps = [];
        const stamp = Date.now();
        // 两段式改名：先全部改成临时名，避免 1.jpg 已存在时互相覆盖
        try {
          for (let i = 0; i < names.length; i++) {
            const name = names[i];
            const tmp = path.join(dir, `.num-${stamp}-${i}${path.extname(name).toLowerCase()}`);
            await fsp.rename(path.join(dir, name), tmp);
            temps.push({ tmp, name });
          }
          for (let i = 0; i < temps.length; i++) {
            const target = `${i + 1}${path.extname(temps[i].name).toLowerCase()}`;
            await fsp.rename(temps[i].tmp, path.join(dir, target));
            temps[i].tmp = '';
          }
        } catch (err) {
          errors.push({ file: '', error: err instanceof Error ? err.message : String(err) });
          // 尽力恢复：还没落到最终名的临时文件改回原名
          for (const t of temps) {
            if (!t.tmp) continue;
            try {
              await fsp.rename(t.tmp, path.join(dir, t.name));
            } catch {
              /* 恢复失败时保留临时名，至少文件还在 */
            }
          }
        }
        results.push({ code, dir, files: await listImageFiles(dir), errors });
      }
      res.json({ results });
    })
  );

  /* 入库：把已编号的文件夹登记进图库，并写产品名 / 完整编码 / 主 SKU 标签 */
  app.post(
    '/api/barcode/import',
    asyncRoute(async (req, res) => {
      const root = assertWritableDir(req.body?.root, '输出根目录');
      const date = String(req.body?.date ?? '').trim();
      if (!DATE_RE.test(date)) return res.status(400).json({ error: '日期格式必须是 YYYY-MM-DD' });
      const input = Array.isArray(req.body?.groups) ? req.body.groups : [];
      if (!input.length) return res.status(400).json({ error: '没有可入库的分组' });

      let parentFolderId = null;
      if (req.body?.parentFolderId != null) {
        const pid = Number(req.body.parentFolderId);
        if (!Number.isInteger(pid) || pid <= 0) {
          return res.status(400).json({ error: '入库父文件夹不合法' });
        }
        const exists = db.prepare('SELECT id FROM folders WHERE id = ?').get(pid);
        if (!exists) return res.status(400).json({ error: '入库父文件夹不存在，请重新选择' });
        parentFolderId = pid;
      }

      const dateFolderName = safeCodeName(req.body?.dateFolder) || date;
      const dateDir = path.join(root, dateFolderName);
      await fsp.mkdir(dateDir, { recursive: true });
      // 图库层级：当前选中的文件夹 / 日期文件夹 /（可选分类）/ 编码
      const dateFolderId = ensureFolderUnderParent(parentFolderId, dateFolderName);

      const results = [];
      let importedTotal = 0;
      let importSkippedTotal = 0;

      for (const g of input) {
        const code = safeCodeName(g?.code);
        const folderInput = String(g?.folder || '');
        if (!code) {
          results.push({
            code: '',
            folder: folderInput,
            imported: 0,
            importSkipped: 0,
            importErrors: [{ file: '', error: '编码为空，已跳过该组' }],
            libraryFolderId: null,
          });
          continue;
        }

        let folder;
        try {
          folder = assertFolder(folderInput);
        } catch (err) {
          results.push({
            code,
            folder: folderInput,
            imported: 0,
            importSkipped: 0,
            importErrors: [{ file: '', error: err instanceof Error ? err.message : String(err) }],
            libraryFolderId: null,
          });
          continue;
        }
        // 只允许入库「输出根目录/日期」下面的文件夹，避免误把源图登记进库
        if (!isInside(dateDir, folder) || folder === dateDir) {
          results.push({
            code,
            folder,
            imported: 0,
            importSkipped: 0,
            importErrors: [{ file: '', error: '文件夹不在「输出根目录/日期」下' }],
            libraryFolderId: null,
          });
          continue;
        }

        let imported = 0;
        let importSkipped = 0;
        const importErrors = [];
        let libraryFolderId = null;
        try {
          const names = await listImageFiles(folder);
          if (!names.length) {
            importErrors.push({ file: '', error: '文件夹里没有图片' });
          } else {
            const folderName = path.basename(folder);
            const sub = safeCodeName(g.subfolder);
            const subFolderId = sub ? ensureFolderUnderParent(dateFolderId, sub) : dateFolderId;
            libraryFolderId = ensureFolderUnderParent(subFolderId, folderName);
            const mainSku = cleanTag(g.mainSku) || (String(g.code || '').match(/^(\d{4,6})/)?.[1] || '');
            const tags = [
              ...new Set(
                [cleanTag(g.productName), cleanTag(g.code), cleanTag(mainSku)].filter(Boolean)
              ),
            ];
            const generation = getLibraryGeneration();
            for (const name of names) {
              const r = await importImageToFolder(path.join(folder, name), libraryFolderId, tags, generation);
              if (r.ok) {
                if (r.duplicate) importSkipped++;
                else imported++;
              } else {
                importErrors.push({ file: name, error: r.error || '入库失败' });
              }
            }
          }
        } catch (err) {
          importErrors.push({ file: '', error: err instanceof Error ? err.message : String(err) });
        }
        importedTotal += imported;
        importSkippedTotal += importSkipped;
        results.push({ code, folder, imported, importSkipped, importErrors, libraryFolderId });
      }

      res.json({ ok: true, dateDir, importedTotal, importSkippedTotal, results });
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
        // 大图预览不缓存：服务端升级后不能继续拿旧的 240px 缓存
        res.set('Cache-Control', max > 480 ? 'private, no-store' : 'private, max-age=3600');
        res.send(buf);
      } catch {
        res.status(404).json({ error: '无法生成预览' });
      }
    })
  );
}
