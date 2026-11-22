import { useEffect, useRef, useState } from 'react';
import type { ImageItem } from '../types';

/**
 * 列表页 / 仪表盘的表格内容缩略：解析 xlsx / csv 的前几行，直接画出「表格里有什么」，
 * 而不是只显示一个文件图标。
 *
 * 结果按 item.url（带版本号）缓存；解析失败同样缓存 null，避免同一张卡反复拉文件。
 */
const cache = new Map<string, string[][] | null>();

/** 预览行数 / 列数：卡片只有一百多像素宽，列多了每格只剩一个省略号，反而看不出是什么表 */
const PREVIEW_ROWS = 8;
const PREVIEW_COLS = 4;

export function sheetPreviewExt(item: ImageItem): string {
  const m = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(item.path || item.title || '');
  return m ? m[1].toLowerCase() : '';
}

/** 目前只有 xlsx / csv 能低成本画出内容；docx / pptx 点开再看 */
export function canPreviewSheet(item: ImageItem): boolean {
  const ext = sheetPreviewExt(item);
  return ext === 'xlsx' || ext === 'csv';
}

export function useSheetPreview<T extends HTMLElement = HTMLDivElement>(item: ImageItem) {
  const hostRef = useRef<T | null>(null);
  const supported = canPreviewSheet(item);
  const [rows, setRows] = useState<string[][] | null>(() => cache.get(item.url) || null);

  useEffect(() => {
    if (!supported) return;
    if (cache.has(item.url)) {
      setRows(cache.get(item.url) || null);
      return;
    }
    const host = hostRef.current;
    let cancelled = false;
    let started = false;
    const load = async () => {
      if (started || cancelled) return;
      started = true;
      try {
        const res = await fetch(item.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const mod = (await import('xlsx-js-style')) as unknown as { default?: typeof import('xlsx-js-style') };
        const XLSX = mod.default || (mod as unknown as typeof import('xlsx-js-style'));
        const wb = XLSX.read(buf, { type: 'array' }) as {
          SheetNames: string[];
          Sheets: Record<string, Record<string, unknown>>;
        };
        const ws = wb.Sheets[wb.SheetNames[0]] || {};
        const out: string[][] = [];
        for (let r = 0; r < PREVIEW_ROWS; r++) {
          const line: string[] = [];
          for (let c = 0; c < PREVIEW_COLS; c++) {
            const cell = ws[XLSX.utils.encode_cell({ r, c })] as { w?: string; v?: unknown } | undefined;
            line.push(cell ? String(cell.w ?? cell.v ?? '') : '');
          }
          out.push(line);
        }
        cache.set(item.url, out);
        if (!cancelled) setRows(out);
      } catch (err) {
        // 解析失败就退回图标卡；不缓存失败，换一页 / 重挂载时还能再试一次
        console.warn('[office-preview] 表格预览解析失败', item.title, err);
        cache.delete(item.url);
        if (!cancelled) setRows(null);
      }
    };
    let timer = 0;
    let io: IntersectionObserver | null = null;
    if (host) {
      io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io?.disconnect();
          io = null;
          window.clearTimeout(timer);
          void load();
        },
        { rootMargin: '240px' }
      );
      io.observe(host);
    }
    // 虚拟网格 / 后台标签页 / 无宿主节点时 IntersectionObserver 可能不触发；
    // 1.2s 后仍没开始时兜底加载。表格文件通常只有几十 KB，比一直停在文件占位更符合预期。
    timer = window.setTimeout(() => {
      io?.disconnect();
      io = null;
      void load();
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      io?.disconnect();
      io = null;
    };
  }, [item.url, item.title, supported]);

  return { hostRef, rows, supported };
}
