import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import XLSX from 'xlsx-js-style';
import type { ImageItem } from '../types';
import { saveOfficeFile } from '../api/core';
import i18n from '../i18n';

interface Props {
  item: ImageItem;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
  onSaved?: (item: ImageItem) => void;
}

/** 表格预览上限：超过后提示用系统应用打开，避免一次渲染上万行把灯箱卡死 */
const MAX_ROWS = 2000;
const MAX_COLS = 60;
const MIN_ROWS = 24;
const MIN_COLS = 12;

const ALLOWED = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'EM', 'U', 'S', 'UL', 'OL', 'LI',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BR', 'HR', 'BLOCKQUOTE', 'A', 'SPAN', 'DIV',
  'IMG', 'SUP', 'SUB', 'CODE', 'PRE',
]);

function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (let guard = 0; guard < 200; guard++) {
    const bad = Array.from(doc.body.querySelectorAll('*')).find((el) => !ALLOWED.has(el.tagName));
    if (!bad) break;
    bad.replaceWith(...Array.from(bad.childNodes));
  }
  doc.body.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || (attr.name === 'href' && /^javascript:/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noreferrer');
    }
  });
  return doc.body.innerHTML;
}

const extOf = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

const xmlDecode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

interface Merge {
  s: { r: number; c: number };
  e: { r: number; c: number };
}
interface SheetModel {
  name: string;
  rows: string[][];
  merges: Merge[];
  widths: number[];
  truncated: boolean;
}
interface CellPos {
  r: number;
  c: number;
}
interface Selection {
  anchor: CellPos;
  focus: CellPos;
}

const colName = (c: number) => XLSX.utils.encode_col(c);
const cellKey = (r: number, c: number) => XLSX.utils.encode_cell({ r, c });
const inRect = (r: number, c: number, sel: Selection) => {
  const r1 = Math.min(sel.anchor.r, sel.focus.r);
  const r2 = Math.max(sel.anchor.r, sel.focus.r);
  const c1 = Math.min(sel.anchor.c, sel.focus.c);
  const c2 = Math.max(sel.anchor.c, sel.focus.c);
  return r >= r1 && r <= r2 && c >= c1 && c <= c2;
};

/**
 * Office 内嵌预览 / 编辑（纯前端、离线可跑）：
 * - .xlsx/.csv → 可编辑表格：单元格选择、Ctrl+C / Ctrl+V、双击编辑、保存写回原文件
 * - .docx → mammoth 转 HTML，正文可直接选中复制
 * - .pptx → 解压 ppt/slides/*.xml 抽文本，按页给大纲
 * - 老格式 .doc/.xls/.ppt 没有纯前端解析器，明确引导用系统应用打开
 */
export default function OfficeViewer({ item, onToast, onSaved }: Props) {
  const ext = extOf(item.title);
  const [html, setHtml] = useState('');
  const [sheets, setSheets] = useState<SheetModel[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [slides, setSlides] = useState<string[][]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Selection>({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);

  const wbRef = useRef<Record<string, unknown> | null>(null);
  const initialRef = useRef<string[][][]>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const sheet = sheets[activeSheet];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setHtml('');
    setSheets([]);
    setSlides([]);
    setText('');
    setActiveSheet(0);
    setDirty(false);
    setEditing(null);
    wbRef.current = null;
    initialRef.current = [];
    (async () => {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(i18n.t('kdd489792', { p0: res.status }));
      const buf = await res.arrayBuffer();
      if (ext === 'docx') {
        const out = await mammoth.convertToHtml({ arrayBuffer: buf });
        if (!cancelled) setHtml(sanitize(out.value || i18n.t('kd1ac4225')));
      } else if (ext === 'xlsx' || ext === 'csv') {
        const wb = XLSX.read(buf, { type: 'array', cellStyles: true }) as Record<string, unknown>;
        const names = (wb.SheetNames as string[]) || [];
        const list = names.map((name) => {
          const ws = (wb.Sheets as Record<string, Record<string, unknown>>)[name] || {};
          const ref = ws['!ref'] ? XLSX.utils.decode_range(String(ws['!ref'])) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
          const merges = ((ws['!merges'] as Merge[]) || []).map((m) => ({ s: { ...m.s }, e: { ...m.e } }));
          const rawRows = Math.max(ref.e.r + 1, MIN_ROWS);
          const rawCols = Math.max(ref.e.c + 1, MIN_COLS);
          const rowCount = Math.min(rawRows, MAX_ROWS);
          const colCount = Math.min(rawCols, MAX_COLS);
          const rows: string[][] = [];
          for (let r = 0; r < rowCount; r++) {
            const line: string[] = [];
            for (let c = 0; c < colCount; c++) {
              const cell = ws[cellKey(r, c)] as { w?: string; v?: unknown } | undefined;
              line.push(cell ? String(cell.w ?? cell.v ?? '') : '');
            }
            rows.push(line);
          }
          const colsMeta = (ws['!cols'] as { wpx?: number; wch?: number }[]) || [];
          const widths = Array.from({ length: colCount }, (_, c) => {
            const meta = colsMeta[c];
            if (!meta) return 96;
            if (meta.wpx) return Math.max(48, Math.min(420, meta.wpx));
            if (meta.wch) return Math.max(48, Math.min(420, Math.round(meta.wch * 8 + 12)));
            return 96;
          });
          return {
            name,
            rows,
            merges,
            widths,
            truncated: rawRows > rowCount || rawCols > colCount,
          };
        });
        if (!cancelled) {
          wbRef.current = wb;
          initialRef.current = list.map((s) => s.rows.map((r) => r.slice()));
          setSheets(list);
        }
      } else if (ext === 'pptx') {
        const zip = await JSZip.loadAsync(buf);
        const names = Object.keys(zip.files)
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] || 0) - Number(b.match(/(\d+)\.xml$/)?.[1] || 0));
        const pages: string[][] = [];
        for (const n of names) {
          const xml = await zip.file(n)?.async('string');
          if (!xml) continue;
          const texts = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map((m) => xmlDecode(m[1]).trim()).filter(Boolean);
          pages.push(texts);
        }
        if (!cancelled) setSlides(pages);
      } else if (ext === 'txt' || ext === 'md') {
        if (!cancelled) setText(new TextDecoder('utf-8').decode(buf).slice(0, 200000));
      } else {
        throw new Error(i18n.t('k7ecfdf20'));
      }
    })()
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message);
        onToast?.(i18n.t('kb6327eeb', { p0: (err as Error).message }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.url, ext, onToast]);

  const coverInfo = useMemo(() => {
    const covered = new Set<string>();
    const span = new Map<string, { rs: number; cs: number }>();
    if (!sheet) return { covered, span };
    for (const m of sheet.merges) {
      if (m.s.r >= sheet.rows.length || m.s.c >= (sheet.rows[0]?.length || 0)) continue;
      const rs = Math.min(m.e.r, sheet.rows.length - 1) - m.s.r + 1;
      const cs = Math.min(m.e.c, (sheet.rows[0]?.length || 0) - 1) - m.s.c + 1;
      if (rs <= 1 && cs <= 1) continue;
      span.set(cellKey(m.s.r, m.s.c), { rs, cs });
      for (let r = m.s.r; r < m.s.r + rs; r++) {
        for (let c = m.s.c; c < m.s.c + cs; c++) {
          if (r !== m.s.r || c !== m.s.c) covered.add(cellKey(r, c));
        }
      }
    }
    return { covered, span };
  }, [sheet]);

  const setCell = useCallback(
    (r: number, c: number, value: string) => {
      setSheets((prev) =>
        prev.map((s, i) => {
          if (i !== activeSheet) return s;
          const rows = s.rows.map((row) => row.slice());
          rows[r][c] = value;
          return { ...s, rows };
        })
      );
      setDirty(true);
    },
    [activeSheet]
  );

  const selectionText = useCallback(() => {
    if (!sheet) return '';
    const r1 = Math.min(sel.anchor.r, sel.focus.r);
    const r2 = Math.max(sel.anchor.r, sel.focus.r);
    const c1 = Math.min(sel.anchor.c, sel.focus.c);
    const c2 = Math.max(sel.anchor.c, sel.focus.c);
    const lines: string[] = [];
    for (let r = r1; r <= r2; r++) lines.push(sheet.rows[r].slice(c1, c2 + 1).join('\t'));
    return lines.join('\n');
  }, [sheet, sel]);

  const copySelection = useCallback(async () => {
    const content = selectionText();
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    onToast?.(i18n.t('k34368424'));
  }, [selectionText, onToast]);

  const pasteText = useCallback(
    (raw: string) => {
      if (!sheet) return;
      const matrix = raw.replace(/\r/g, '').split('\n');
      if (matrix.length && matrix[matrix.length - 1] === '') matrix.pop();
      const start = sel.anchor;
      setSheets((prev) =>
        prev.map((s, i) => {
          if (i !== activeSheet) return s;
          const rows = s.rows.map((row) => row.slice());
          matrix.forEach((line, dr) => {
            const r = start.r + dr;
            if (r >= rows.length) return;
            line.split('\t').forEach((value, dc) => {
              const c = start.c + dc;
              if (c < rows[r].length) rows[r][c] = value;
            });
          });
          return { ...s, rows };
        })
      );
      setDirty(true);
    },
    [sheet, sel, activeSheet]
  );

  const saveSheet = useCallback(async () => {
    if (!sheet || saving) return;
    if (!dirty) {
      onToast?.(i18n.t('k2fb8e178'));
      return;
    }
    setSaving(true);
    try {
      let bytes: Uint8Array;
      if (ext === 'csv') {
        const content = sheet.rows.map((row) => row.map((v) => (/[\t",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n');
        bytes = new TextEncoder().encode(`\uFEFF${content}`);
      } else {
        const wb = wbRef.current as {
          Sheets: Record<string, Record<string, unknown>>;
          SheetNames?: string[];
          BookType?: string;
        } | null;
        if (!wb) throw new Error(i18n.t('k6de920b4'));
        sheets.forEach((model, i) => {
          const ws = wb.Sheets[model.name];
          const base = initialRef.current[i] || [];
          if (!ws) return;
          for (let r = 0; r < model.rows.length; r++) {
            for (let c = 0; c < model.rows[r].length; c++) {
              const before = base[r]?.[c] ?? '';
              const after = model.rows[r][c];
              if (before === after) continue;
              const addr = cellKey(r, c);
              const old = ws[addr] as { s?: unknown } | undefined;
              if (after === '') {
                delete ws[addr];
              } else {
                ws[addr] = { ...(old?.s ? { s: old.s } : {}), t: 's', v: after };
              }
            }
          }
          ws['!merges'] = model.merges;
        });
        const out = XLSX.write(wb as never, { type: 'array', bookType: 'xlsx', cellStyles: true });
        bytes = out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
      }
      const data = await saveOfficeFile(item.id, bytes);
      initialRef.current = sheets.map((s) => s.rows.map((r) => r.slice()));
      setDirty(false);
      if (data.item) onSaved?.(data.item);
      onToast?.(i18n.t('kf8dfedcd'));
    } catch (err) {
      onToast?.(i18n.t('k837dd027', { p0: (err as Error).message }), 'error');
    } finally {
      setSaving(false);
    }
  }, [sheet, sheets, dirty, saving, ext, item.id, activeSheet, onToast, onSaved]);

  const onGridKeyDown = (e: ReactKeyboardEvent) => {
    if (!sheet || editing) return;
    const step = (dr: number, dc: number, extend: boolean) => {
      e.preventDefault();
      setSel((s) => {
        const next = {
          r: Math.max(0, Math.min(sheet.rows.length - 1, s.focus.r + dr)),
          c: Math.max(0, Math.min((sheet.rows[0]?.length || 1) - 1, s.focus.c + dc)),
        };
        return extend ? { anchor: s.anchor, focus: next } : { anchor: next, focus: next };
      });
    };
    if (e.key === 'ArrowUp') return step(-1, 0, e.shiftKey);
    if (e.key === 'ArrowDown') return step(1, 0, e.shiftKey);
    if (e.key === 'ArrowLeft') return step(0, -1, e.shiftKey);
    if (e.key === 'ArrowRight') return step(0, 1, e.shiftKey);
    if (e.key === 'Tab') return step(0, e.shiftKey ? -1 : 1, false);
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      return setEditing({ r: sel.anchor.r, c: sel.anchor.c, value: sheet.rows[sel.anchor.r][sel.anchor.c] });
    }
    if (e.key === 'Escape') {
      setSel({ anchor: sel.anchor, focus: sel.anchor });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      void copySelection();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveSheet();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const r1 = Math.min(sel.anchor.r, sel.focus.r);
      const r2 = Math.max(sel.anchor.r, sel.focus.r);
      const c1 = Math.min(sel.anchor.c, sel.focus.c);
      const c2 = Math.max(sel.anchor.c, sel.focus.c);
      setSheets((prev) =>
        prev.map((s, i) => {
          if (i !== activeSheet) return s;
          const rows = s.rows.map((row) => row.slice());
          for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) rows[r][c] = '';
          return { ...s, rows };
        })
      );
      setDirty(true);
      return;
    }
    // 直接打字进入编辑，并把按键作为首个字符
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setEditing({ r: sel.anchor.r, c: sel.anchor.c, value: e.key });
    }
  };

  if (loading) {
    return (
      <div className="ov-stage">
        <div className="ov-loading">正在解析 {ext.toUpperCase()} …</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ov-stage">
        <div className="ov-empty">
          <b>{i18n.t('kffb30712')}</b>
          <span>{error}</span>
          <span className="ov-empty-hint">{i18n.t('k0bd1d318')}</span>
        </div>
      </div>
    );
  }

  if (ext === 'docx') {
    return (
      <div className="ov-stage">
        <div className="ov-page ov-doc" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    );
  }

  if (ext === 'txt' || ext === 'md') {
    return (
      <div className="ov-stage">
        <div className="ov-page ov-doc">
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 13,
              lineHeight: 1.75,
            }}
          >
            {text || i18n.t('kace80573')}
          </pre>
        </div>
      </div>
    );
  }

  if (ext === 'xlsx' || ext === 'csv') {
    const cols = sheet?.rows[0]?.length || 0;
    return (
      <div className="ov-stage ov-stage-sheet">
        <div className="ov-sheet-bar">
          {sheets.length > 1 && (
            <div className="ov-sheets">
              {sheets.map((s, i) => (
                <button
                  key={s.name}
                  className={`ov-sheet-tab${i === activeSheet ? ' on' : ''}`}
                  onClick={() => {
                    setActiveSheet(i);
                    setSel({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
                    setEditing(null);
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <div className="ov-sheet-actions">
            <span className="ov-sheet-dirty">{dirty ? i18n.t('k9ac39816') : ''}</span>
            <button className="btn sm ghost" onClick={() => void copySelection()}>
              {i18n.t('k3fa81288')}
            </button>
            <button className="btn sm primary" disabled={saving || !dirty} onClick={() => void saveSheet()}>
              {saving ? i18n.t('k9b5d32d1') : i18n.t('kbe5fbbe3')}
            </button>
          </div>
        </div>
        <div className="ov-sheet-tip">{i18n.t('kc1e16813')}</div>
        <div
          className="ov-page ov-sheet ov-grid"
          ref={gridRef}
          tabIndex={0}
          onKeyDown={onGridKeyDown}
          onPaste={(e) => {
            const raw = e.clipboardData.getData('text/plain');
            if (!raw) return;
            e.preventDefault();
            pasteText(raw);
          }}
        >
          {sheet && sheet.rows.length ? (
            <table>
              <thead>
                <tr>
                  <th className="ov-corner" />
                  {Array.from({ length: cols }, (_, c) => (
                    <th key={c} style={{ minWidth: sheet.widths[c], width: sheet.widths[c] }}>
                      {colName(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((row, r) => (
                  <tr key={r}>
                    <th className="ov-rownum">{r + 1}</th>
                    {row.map((value, c) => {
                      if (coverInfo.covered.has(cellKey(r, c))) return null;
                      const span = coverInfo.span.get(cellKey(r, c));
                      const edit = editing && editing.r === r && editing.c === c ? editing : null;
                      const selected = inRect(r, c, sel);
                      return (
                        <td
                          key={c}
                          rowSpan={span?.rs ?? 1}
                          colSpan={span?.cs ?? 1}
                          className={selected ? 'on' : ''}
                          style={{ minWidth: sheet.widths[c] }}
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            e.preventDefault();
                            gridRef.current?.focus();
                            setEditing(null);
                            setSel({ anchor: { r, c }, focus: { r, c } });
                          }}
                          onMouseEnter={(e) => {
                            if (e.buttons !== 1) return;
                            setSel((s) => ({ anchor: s.anchor, focus: { r, c } }));
                          }}
                          onDoubleClick={() => setEditing({ r, c, value })}
                        >
                          {edit ? (
                            <input
                              className="ov-cell-input"
                              autoFocus
                              value={edit.value}
                              onChange={(e) => setEditing({ ...edit, value: e.target.value })}
                              onBlur={() => {
                                setCell(r, c, edit.value);
                                setEditing(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  setCell(r, c, edit.value);
                                  setEditing(null);
                                  setSel((s) => ({
                                    anchor: { r: Math.min(sheet.rows.length - 1, r + 1), c },
                                    focus: { r: Math.min(sheet.rows.length - 1, r + 1), c },
                                  }));
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setEditing(null);
                                } else if (e.key === 'Tab') {
                                  e.preventDefault();
                                  setCell(r, c, edit.value);
                                  const nc = Math.min(cols - 1, c + 1);
                                  setEditing({ r, c: nc, value: sheet.rows[r][nc] });
                                  setSel({ anchor: { r, c: nc }, focus: { r, c: nc } });
                                }
                              }}
                            />
                          ) : (
                            value
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="ov-empty">{i18n.t('k1d7c1831')}</div>
          )}
        </div>
        {sheet?.truncated && (
          <div className="ov-more">{i18n.t('k7b6697f4', { p0: MAX_ROWS, p1: MAX_COLS })}</div>
        )}
      </div>
    );
  }

  return (
    <div className="ov-stage ov-stage-slides">
      {slides.map((texts, i) => (
        <div className="ov-page ov-slide" key={i}>
          <div className="ov-slide-no">第 {i + 1} 页</div>
          {texts.length ? (
            texts.map((t, ti) => (
              <p key={ti} className={ti === 0 ? 'ov-slide-title' : ''}>
                {t}
              </p>
            ))
          ) : (
            <p className="ov-empty">{i18n.t('k0e5507e5')}</p>
          )}
        </div>
      ))}
    </div>
  );
}
