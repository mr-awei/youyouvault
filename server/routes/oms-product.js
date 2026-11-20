// @ts-check
/**
 * 产品图上传（OMS「产品图库 → 摄影师拍摄图」）。
 *
 * 所有上传接口只在用户明确点击「上传文件夹」时调用，不做任何自动上传。
 * 这个模块只负责：核对后台名称、把本地 SKU 文件夹里的图片传到 OSS、写回产品图库记录。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import * as XLSX from 'xlsx';
import { omsClient } from '../lib/oms.js';
import { collectImages } from '../lib/barcode-split.js';

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff?|heic|heif)$/i;

function assertDir(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('请选择文件夹');
  if (!path.isAbsolute(raw)) throw new Error(`文件夹必须是绝对路径（收到：${raw}）`);
  const abs = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`文件夹不存在：${abs}`);
  }
  if (!st.isDirectory()) throw new Error(`不是文件夹：${abs}`);
  return abs;
}

function normalizeName(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 根目录下的 SKU 子文件夹；如果根目录本身就是 SKU 文件夹，返回单行 */
async function listSkuFolders(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const dirs = entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'
  );
  if (!dirs.length) {
    const files = await collectImages(root);
    const st = await fsp.stat(root);
    return [
      {
        name: path.basename(root),
        sku: path.basename(root),
        dir: root,
        imageCount: files.filter((f) => IMAGE_EXT.test(f.rel)).length,
        mtime: st.mtime.toISOString(),
      },
    ];
  }
  const rows = [];
  for (const d of dirs) {
    const abs = path.join(root, d.name);
    const files = await collectImages(abs);
    const st = await fsp.stat(abs).catch(() => null);
    rows.push({
      name: d.name,
      sku: d.name,
      dir: abs,
      imageCount: files.filter((f) => IMAGE_EXT.test(f.rel)).length,
      mtime: st ? st.mtime.toISOString() : '',
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  return rows;
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /* 扫描根目录，列出 SKU 子文件夹与图片数（只读） */
  app.post(
    '/api/oms/product/scan',
    asyncRoute(async (req, res) => {
      const root = assertDir(req.body?.dir);
      const rows = await listSkuFolders(root);
      res.json({ ok: true, root, rows });
    })
  );

  /* 按完整 SKU 查后台产品图库记录（只读，不写任何东西） */
  app.post(
    '/api/oms/product/lookup',
    asyncRoute(async (req, res) => {
      const sku = String(req.body?.sku || '').trim();
      if (!sku) return res.status(400).json({ error: '请填写完整 SKU' });
      const detail = await omsClient.getProductGallery(sku);
      if (!detail) return res.status(404).json({ error: 'OMS 产品图库没有这个 SKU 的记录' });
      const ids = String(detail.ossIds || '')
        .split(',')
        .filter(Boolean);
      res.json({
        ok: true,
        sku: detail.sku || sku,
        displayName: detail.displayName || '',
        platform: detail.platform || '',
        type: detail.type || '',
        shootCount: Array.isArray(detail.shootFiles) ? detail.shootFiles.length : 0,
        totalCount: ids.length,
      });
    })
  );

  /**
   * 上传一个 SKU 文件夹到「摄影师拍摄图」。
   * 前置条件：后台 displayName 必须与用户填写的记录名称一致；不一致返回 409，不上传。
   * 这是写接口，只允许由前端「上传文件夹」按钮点击触发。
   */
  app.post(
    '/api/oms/product/upload',
    asyncRoute(async (req, res) => {
      const sku = String(req.body?.sku || '').trim();
      const dir = assertDir(req.body?.dir);
      const expectedName = String(req.body?.expectedName || '').trim();
      if (!sku) return res.status(400).json({ error: '请填写完整 SKU' });
      if (!expectedName) return res.status(400).json({ error: '请填写记录名称后再核对' });

      const detail = await omsClient.getProductGallery(sku);
      if (!detail) return res.status(404).json({ error: 'OMS 产品图库没有这个 SKU 的记录' });
      if (normalizeName(detail.displayName) !== normalizeName(expectedName)) {
        return res.status(409).json({
          error: `后台名称「${detail.displayName || '—'}」与记录名称「${expectedName}」不一致，已停止上传，请先核对`,
          code: 'name_mismatch',
          sku,
          displayName: detail.displayName || '',
          expectedName,
        });
      }

      const files = (await collectImages(dir)).filter((f) => IMAGE_EXT.test(f.rel));
      if (!files.length) return res.status(400).json({ error: '这个文件夹里没有可上传的图片' });

      // 后台已有同名原图就跳过，避免重复点「上传文件夹」时把同一批图再传一遍
      const existingNames = new Set(
        (Array.isArray(detail.shootFiles) ? detail.shootFiles : [])
          .map((f) => String(f?.originalName || '').toLowerCase())
          .filter(Boolean)
      );
      const pending = files.filter(
        (f) => !existingNames.has(`${sku}/${path.basename(f.rel)}`.toLowerCase())
      );
      const skipped = files.length - pending.length;
      if (!pending.length) {
        return res.json({
          ok: true,
          sku,
          displayName: detail.displayName || '',
          uploaded: 0,
          skipped,
          failed: [],
          total: files.length,
          shootCount: Array.isArray(detail.shootFiles) ? detail.shootFiles.length : 0,
        });
      }

      const uploaded = [];
      const failed = [];
      for (const f of pending) {
        try {
          uploaded.push(await omsClient.uploadOssFile(f.abs, path.basename(f.rel)));
        } catch (err) {
          failed.push({
            file: f.rel,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!uploaded.length) {
        return res.status(502).json({ error: '所有图片都上传失败', failed });
      }
      let saved;
      try {
        saved = await omsClient.saveProductGalleryFiles(sku, uploaded);
      } catch (err) {
        return res.status(502).json({
          error: `图片已传到 OSS，但写回产品图库失败：${err instanceof Error ? err.message : String(err)}`,
          uploaded: uploaded.length,
          failed,
        });
      }
      res.json({
        ok: true,
        sku,
        displayName: saved?.displayName || detail.displayName || '',
        uploaded: uploaded.length,
        skipped,
        failed,
        total: files.length,
        shootCount: Array.isArray(saved?.shootFiles) ? saved.shootFiles.length : 0,
      });
    })
  );

  /* 生成可复制的工作日报 xlsx。时长留空给用户填。 */
  app.post(
    '/api/oms/product/report',
    asyncRoute(async (req, res) => {
      const date = String(req.body?.date || new Date().toISOString().slice(0, 10)).trim();
      const input = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const rows = input
        .map((r) => ({
          sku: String(r?.sku || '').trim(),
          name: String(r?.name || '').trim(),
          platform: String(r?.platform || '').trim(),
          category: String(r?.category || '产品/视频拍摄').trim(),
        }))
        .filter((r) => r.sku);
      if (!rows.length) return res.status(400).json({ error: '没有可导出的 SKU' });

      const header = [
        '日期',
        '今日完成工作',
        '运营',
        'SKU',
        '品名',
        '平台',
        '类别',
        '拍摄时长/h',
        '包装/安装/拆卸/h',
        '任务总工作时长/h',
        '进度',
        '工作成果',
        '主管/组长/带教',
      ];
      const aoa = [header];
      for (const r of rows) {
        aoa.push([
          date,
          `产品拍摄*${rows.length}`,
          '',
          r.sku,
          r.name,
          r.platform,
          r.category,
          '待填',
          '待填',
          '待填',
          '100%',
          '文件夹截图',
          '',
        ]);
      }
      // 和现有日报一致：末尾补一行「图片上传 / 其它」
      aoa.push([date, '图片上传', '', '', '', '', '其它', '', '', '待填', '100%', '文件夹截图', '']);

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [
        { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 28 }, { wch: 24 },
        { wch: 10 }, { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 18 },
        { wch: 10 }, { wch: 16 }, { wch: 16 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '工作日报');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="work-report-${date}.xlsx"; filename*=UTF-8''${encodeURIComponent(`工作日报-${date}.xlsx`)}`
      );
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(buf);
    })
  );

  /* 文件夹截图：给「工作成果」列用，列出 SKU 文件夹与修改时间 */
  app.get(
    '/api/oms/product/folder-shot',
    asyncRoute(async (req, res) => {
      const root = assertDir(String(req.query.dir || ''));
      const rows = await listSkuFolders(root);
      const lineH = 34;
      const top = 54;
      const width = 900;
      const height = top + Math.max(1, rows.length) * lineH + 28;
      const esc = (s) =>
        String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      const fmt = (iso) => {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      const lines = (rows.length ? rows : [{ sku: '（没有子文件夹）', mtime: '' }])
        .map(
          (r, i) =>
            `<text x="64" y="${top + i * lineH}" font-family="Consolas, 'Microsoft YaHei', sans-serif" font-size="15" fill="#1f2937">${esc(r.sku)}</text>` +
            `<text x="520" y="${top + i * lineH}" font-family="Consolas, 'Microsoft YaHei', sans-serif" font-size="14" fill="#4b5563">${esc(fmt(r.mtime))}</text>` +
            `<text x="760" y="${top + i * lineH}" font-family="Consolas, 'Microsoft YaHei', sans-serif" font-size="14" fill="#4b5563">文件夹</text>`
        )
        .join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="#ffffff"/>
        <text x="64" y="28" font-family="'Microsoft YaHei', sans-serif" font-size="16" font-weight="600" fill="#111827">文件夹</text>
        <text x="520" y="28" font-family="'Microsoft YaHei', sans-serif" font-size="15" font-weight="600" fill="#111827">修改日期</text>
        <text x="760" y="28" font-family="'Microsoft YaHei', sans-serif" font-size="15" font-weight="600" fill="#111827">类型</text>
        <line x1="52" y1="38" x2="${width - 32}" y2="38" stroke="#e5e7eb" stroke-width="1"/>
        ${lines}
      </svg>`;
      const buf = await sharp(Buffer.from(svg)).png().toBuffer();
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    })
  );
}
