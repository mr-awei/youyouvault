import React, { useEffect, useState } from 'react';
import {
  api,
  barcodeThumbUrl,
  copyText,
  downloadFile,
  isDesktop,
  omsProductFolderShotUrl,
  openFolder,
  pickFolder,
  type BarcodeApplyResponse,
  type BarcodeGroup,
  type BarcodeScanResult,
  type OmsDesignRow,
  type OmsStatus,
} from '../api';
import { IconArrowUpRight, IconBarcode, IconCopy, IconFolder, IconRefresh } from '../components/Icons';
import i18n from '../i18n';
import type { FolderNode } from '../types';

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  /** 当前侧栏选中的文件夹：入库时在它下面建「日期 / 编码」层级 */
  folderId: number | null;
  activeFolder: FolderNode | null;
  activeLibName: string;
  onLibraryChanged: () => void;
}

interface GroupEdit {
  code: string;
  skip: boolean;
  /** 条码识别出的 5 位主 SKU，完整编码回填后仍保留，便于重新查询 OMS */
  mainSku?: string;
  /** OMS 查询结果提示（找到 / 未找到 / 多条） */
  omsNote?: string;
  /** OMS 返回的待拍摄完整编码候选 */
  omsRows?: OmsDesignRow[];
  /** OMS 查询状态：找到唯一完整编码 / 多条候选 / 没有记录 / 查询失败 */
  omsState?: 'found' | 'multiple' | 'empty' | 'error';
  /** 产品名：单独一行，入库时作为标签写到该组每一张图片 */
  productName?: string;
}

interface UploadOutcome {
  state: 'uploading' | 'uploaded' | 'skipped' | 'mismatch' | 'error';
  uploaded: number;
  skipped: number;
  shootCount: number;
  message: string;
}

/** 完整编码形如 45661-Y01Y0001-QD08；只有主 SKU 时没有连字符段 */
const FULL_CODE_RE = /^\d{4,6}(?:-[A-Z0-9]{2,}){2,}$/i;

function isFullCode(code: string) {
  return FULL_CODE_RE.test(String(code || '').trim());
}

/** 三段式 SKU：第二段以 Y01 开头算 eBay，其余非 eBay；非三段式留空 */
function platformOf(code: string) {
  const m = String(code || '').trim().match(/^\d{4,6}-([A-Z0-9]+)-[A-Z0-9]+$/i);
  if (!m) return '';
  return /^Y01/i.test(m[1]) ? 'eBay' : '非eBay';
}

/**
 * OMS 后台地址。
 * 多个候选时点开对应设计单详情，用户可以在后台核对/选择；
 * 没有具体 id 时落到「视觉设计」列表页。
 */
function omsPageUrl(baseUrl: string, mainSku?: string) {
  const base = String(baseUrl || 'https://sit.uyoyous.com').replace(/\/+$/, '');
  try {
    // 完整编码以「WMS → 视觉拍摄」页为准
    const url = new URL('/oms-test-ui/wms_shouhuo/visualShooting', `${base}/`);
    // 把主 SKU 带进 URL；同时调用处会复制到剪贴板，兼容后台暂时不读这个参数的版本
    if (mainSku) url.searchParams.set('mainSkuId', mainSku);
    return url.toString();
  } catch {
    return base;
  }
}

/**
 * 条码分文件夹：拍摄流程的起点。
 * 选源目录 → 扫描（判黄 + OCR）→ 核对编码 → 按「日期 / 编码」复制产品图。
 */
export default function BarcodeSplit({ onToast, folderId, activeFolder, activeLibName, onLibraryChanged }: Props) {
  const [srcDir, setSrcDir] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [date, setDate] = useState('');
  const [scan, setScan] = useState<BarcodeScanResult | null>(null);
  const [edits, setEdits] = useState<GroupEdit[]>([]);
  const [scanning, setScanning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [applyMode, setApplyMode] = useState<'copy' | 'import' | 'upload' | null>(null);
  const applying = applyMode !== null;
  const [cleanStale, setCleanStale] = useState(true);
  const [applied, setApplied] = useState<BarcodeApplyResponse | null>(null);
  const [uploads, setUploads] = useState<Record<string, UploadOutcome>>({});
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [oms, setOms] = useState<OmsStatus | null>(null);
  const [omsOpen, setOmsOpen] = useState(false);
  const [omsUser, setOmsUser] = useState('');
  const [omsPass, setOmsPass] = useState('');
  const [omsBase, setOmsBase] = useState('https://sit.uyoyous.com');
  const [omsBusy, setOmsBusy] = useState(false);
  const [omsQuerying, setOmsQuerying] = useState(false);

  // 每个摄影师用自己的 OMS 账号：进页面先读一次配置状态
  useEffect(() => {
    let alive = true;
    api
      .omsStatus()
      .then((s) => {
        if (!alive) return;
        setOms(s);
        setOmsUser(s.username || '');
        setOmsBase(s.baseUrl || 'https://sit.uyoyous.com');
        if (!s.configured) setOmsOpen(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 扫描可能持续几十秒（每张条码都要跑一次系统 OCR），给个已耗时让用户知道没卡死
  useEffect(() => {
    if (!scanning) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [scanning]);

  const chooseDir = async (apply: (v: string) => void) => {
    const dir = await pickFolder();
    if (dir) apply(dir);
  };

  /** 用 5 位主 SKU 查 OMS 待拍摄完整编码，并合并进编码框 */
  const runOmsQuery = async (skus: string[], skuOf: (i: number) => string) => {
    if (!skus.length) return;
    setOmsQuerying(true);
    try {
      const { results } = await api.omsResolve(skus);
      setEdits((prev) =>
        prev.map((edit, i) => {
          const sku = skuOf(i);
          const hit = sku ? results[sku] : undefined;
          if (!hit) return edit;
          if (hit.error) {
            return {
              ...edit,
              omsRows: [],
              omsState: 'error',
              omsNote: i18n.t('k8280f081', { p0: hit.error }),
            };
          }
          if (hit.total === 0) {
            return { ...edit, omsRows: [], omsState: 'empty', omsNote: i18n.t('kb70797bc') };
          }
          if (hit.total === 1) {
            const row = hit.rows[0];
            return {
              ...edit,
              code: row.salesSku,
              omsRows: hit.rows,
              omsState: 'found',
              productName: row.productName || edit.productName,
              omsNote: `${row.productName || '—'} · ${i18n.t('ka6335ea4')}`,
            };
          }
          return {
            ...edit,
            omsRows: hit.rows,
            omsState: 'multiple',
            productName: hit.rows[0]?.productName || edit.productName,
            omsNote: i18n.t('kfe15109b', { p0: hit.total }),
          };
        })
      );
    } catch (err) {
      onToast(i18n.t('k8280f081', { p0: (err as Error).message }), 'error');
    } finally {
      setOmsQuerying(false);
    }
  };

  const queryOms = async () => {
    if (!scan) return;
    if (!oms?.configured) {
      setOmsOpen(true);
      onToast(i18n.t('kd2e4d938'), 'error');
      return;
    }
    const skuOf = (i: number) => {
      const code = (edits[i]?.code ?? scan.groups[i]?.code ?? '').trim();
      if (/^\d{4,6}$/.test(code)) return code;
      return (edits[i]?.mainSku || '').trim();
    };
    const skus = [...new Set(scan.groups.map((_, i) => skuOf(i)).filter((c) => /^\d{4,6}$/.test(c)))];
    if (!skus.length) {
      onToast(i18n.t('kf8b2b505'), 'error');
      return;
    }
    await runOmsQuery(skus, skuOf);
  };

  const saveOmsAccount = async () => {
    if (!omsUser.trim() || !omsPass) {
      onToast(i18n.t('k67a944b8'), 'error');
      return;
    }
    setOmsBusy(true);
    try {
      const next = await api.omsSaveAccount({
        username: omsUser.trim(),
        password: omsPass,
        baseUrl: omsBase.trim() || undefined,
      });
      setOms(next);
      setOmsPass('');
      setOmsOpen(false);
      onToast(i18n.t('kdee9ac33', { p0: next.username }));
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setOmsBusy(false);
    }
  };

  const testOms = async () => {
    setOmsBusy(true);
    try {
      const next = await api.omsLogin();
      setOms(next);
      onToast(i18n.t('kdee9ac33', { p0: next.username }));
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setOmsBusy(false);
    }
  };

  const clearOms = async () => {
    setOmsBusy(true);
    try {
      const next = await api.omsClearAccount();
      setOms(next);
      setOmsPass('');
      setOmsOpen(true);
      onToast(i18n.t('k5ba0cd3b'));
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setOmsBusy(false);
    }
  };

  const runScan = async () => {
    if (!srcDir.trim()) {
      onToast(i18n.t('k9dca789e'), 'error');
      return;
    }
    setScanning(true);
    setApplied(null);
    setUploads({});
    setUploadProgress(null);
    try {
      const result = await api.barcodeScan(srcDir.trim());
      setScan(result);
      setEdits(
        result.groups.map((g) => ({
          code: g.code,
          skip: false,
          mainSku: /^\d{4,6}$/.test(g.code.trim()) ? g.code.trim() : '',
        }))
      );
      setDate((prev) => prev || result.date);
      if (!result.groups.length) onToast(i18n.t('k07190065'));
      // 已配置 OMS 时顺手把 5 位主 SKU 换成完整编码（只取「待拍摄」）
      if (oms?.configured) {
        const skus = [...new Set(result.groups.map((g) => g.code.trim()).filter((c) => /^\d{4,6}$/.test(c)))];
        if (skus.length) void runOmsQuery(skus, (i) => (result.groups[i]?.code || '').trim());
      }
    } catch (err) {
      onToast(`${i18n.t('k5ec14542')}：${(err as Error).message}`, 'error');
    } finally {
      setScanning(false);
    }
  };

  /**
   * 保存后自动核对 OMS 名称并上传：名称一致才传，不一致写红色状态并停止该 SKU。
   * 不弹二次确认；用户点主按钮「保存 / 入库 / 上传」即视为同意这一步。
   */
  const uploadAppliedGroups = async (result: BarcodeApplyResponse) => {
    const pending = result.results.filter((r) => r.folder);
    setUploads({});
    setUploadProgress({ done: 0, total: pending.length });
    let uploadedTotal = 0;
    let mismatch = 0;
    let done = 0;
    for (const r of result.results) {
      if (!r.folder) continue;
      const idx = r.sourceIndex;
      const edit = edits[idx];
      const group = scan?.groups[idx];
      const code = String(edit?.code || group?.code || '').trim();
      const expectedName = String(edit?.productName || '').trim();
      const base: UploadOutcome = {
        state: 'uploading',
        uploaded: 0,
        skipped: 0,
        shootCount: 0,
        message: '正在上传…',
      };
      setUploads((prev) => ({ ...prev, [r.folder]: base }));
      try {
        if (!isFullCode(code)) {
          throw Object.assign(new Error('缺少完整编码，未上传到 OMS'), { code: 'no_full_code' });
        }
        if (!expectedName) {
          throw Object.assign(new Error('缺少产品名，未上传到 OMS（请先填写产品名）'), {
            code: 'no_product_name',
          });
        }
        const res = await api.omsProductUpload({
          sku: code,
          dir: r.folder,
          expectedName,
        });
        uploadedTotal += res.uploaded;
        const outcome: UploadOutcome = {
          state: res.uploaded > 0 ? 'uploaded' : 'skipped',
          uploaded: res.uploaded,
          skipped: res.skipped,
          shootCount: res.shootCount,
          message:
            res.uploaded > 0
              ? `已上传 ${res.uploaded} 张到 OMS${res.skipped ? `，跳过 ${res.skipped} 张已存在` : ''}`
              : `后台已有这 ${res.skipped} 张，未重复上传`,
        };
        setUploads((prev) => ({ ...prev, [r.folder]: outcome }));
      } catch (err) {
        const e = err as Error & { code?: string };
        const isMismatch = e.code === 'name_mismatch';
        if (isMismatch) mismatch += 1;
        setUploads((prev) => ({
          ...prev,
          [r.folder]: {
            state: isMismatch ? 'mismatch' : 'error',
            uploaded: 0,
            skipped: 0,
            shootCount: 0,
            message: e.message,
          },
        }));
      } finally {
        done += 1;
        setUploadProgress({ done, total: pending.length });
      }
    }
    return { uploadedTotal, mismatch };
  };

  /** 页面必须处理完的报错/警告；为空才允许点保存/入库/上传 */
  const flowIssues: string[] = [];
  if (scan) {
    scan.groups.forEach((g, i) => {
      const edit = edits[i];
      if (edit?.skip) return;
      const code = (edit?.code ?? g.code ?? '').trim();
      const full = isFullCode(code);
      if (!code) flowIssues.push(`#${i + 1} 没有编码`);
      else if (!full) flowIssues.push(`#${i + 1} 未选完整编码（当前 ${code}）`);
      if (!String(edit?.productName || '').trim()) flowIssues.push(`#${i + 1} 产品名为空`);
      if (!g.files.length) flowIssues.push(`#${i + 1} 没有产品图`);
      for (const w of g.warnings) {
        if (w.code === 'empty' || w.code === 'consecutive') {
          flowIssues.push(`#${i + 1} ${w.text}`);
        }
      }
      if (!full && (edit?.omsState === 'empty' || edit?.omsState === 'error')) {
        flowIssues.push(`#${i + 1} OMS 没查到完整编码 / 查询失败`);
      }
      if (!full && edit?.omsState === 'multiple') {
        flowIssues.push(`#${i + 1} 有多个候选未选择完整编码`);
      }
    });
  }

  const buildGroups = () =>
    scan
      ? scan.groups.map((g, i) => {
          const code = (edits[i]?.code ?? g.code).trim();
          return {
            code,
            files: g.files,
            skip: !!edits[i]?.skip,
            productName: edits[i]?.productName || '',
            mainSku: edits[i]?.mainSku || code.match(/^(\d{4,6})/)?.[1] || '',
          };
        })
      : [];

  /** 第 1 步：只保存/复制到文件夹，完成后停下等人工确认 */
  const runSave = async () => {
    if (!scan) return;
    if (flowIssues.length) {
      onToast('页面还有报错/警告，先处理完再继续', 'error');
      return;
    }
    if (!rootDir.trim()) {
      onToast(i18n.t('k9b498a6d'), 'error');
      return;
    }
    const groups = buildGroups();
    if (!groups.filter((g) => !g.skip && g.code.trim()).length) {
      onToast(i18n.t('k27d4b20c'), 'error');
      return;
    }
    setApplyMode('copy');
    try {
      const result = await api.barcodeApply({
        dir: scan.dir,
        root: rootDir.trim(),
        date,
        groups,
        importToLibrary: false,
        cleanStale,
      });
      setApplied(result);
      setUploads({});
      onToast(i18n.t('k2827af98', { p0: result.totalCopied, p1: result.dateDir }));
      onToast('保存完成：请确认文件夹内容，再点「入库」', 'info');
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
    }
  };

  /** 第 2 步：把文件夹登记进图库；测试阶段允许跳过保存，直接补前置 */
  const runImport = async () => {
    if (!scan) return;
    if (flowIssues.length) {
      onToast('页面还有报错/警告，先处理完再继续', 'error');
      return;
    }
    if (!rootDir.trim()) {
      onToast(i18n.t('k9b498a6d'), 'error');
      return;
    }
    const groups = buildGroups();
    setApplyMode('import');
    try {
      const result = await api.barcodeApply({
        dir: scan.dir,
        root: rootDir.trim(),
        date,
        groups,
        importToLibrary: true,
        parentFolderId: folderId,
        // 已保存过就不再动磁盘；直接跳过保存时按当前勾选执行清理
        cleanStale: applied ? false : cleanStale,
      });
      setApplied(result);
      setUploads({});
      onLibraryChanged();
      onToast(`入库完成：${result.importedTotal ?? 0} 张；请确认图库内容，再点「上传」`, 'info');
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
    }
  };

  /** 第 3 步：核对 OMS 名称并自动上传；测试阶段允许跳过前两步自动补前置 */
  const runUpload = async () => {
    if (!scan) return;
    if (flowIssues.length) {
      onToast('页面还有报错/警告，先处理完再继续', 'error');
      return;
    }
    if (!rootDir.trim()) {
      onToast(i18n.t('k9b498a6d'), 'error');
      return;
    }
    setApplyMode('upload');
    try {
      let base = applied;
      if (!base?.importedToLibrary) {
        base = await api.barcodeApply({
          dir: scan.dir,
          root: rootDir.trim(),
          date,
          groups: buildGroups(),
          importToLibrary: true,
          parentFolderId: folderId,
          cleanStale: applied ? false : cleanStale,
        });
        setApplied(base);
        setUploads({});
        onLibraryChanged();
      }
      const up = await uploadAppliedGroups(base);
      onToast(
        up.mismatch
          ? `上传 ${up.uploadedTotal} 张；有 ${up.mismatch} 个 SKU 名称不一致，已停止等待核对`
          : `已上传 ${up.uploadedTotal} 张到 OMS`,
        up.mismatch ? 'error' : 'info'
      );
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
      setUploadProgress(null);
    }
  };

  /** 首个条码之前的图片：用户确认属于第 1 组时，手动并进去，避免漏拷 */
  const assignUngroupedToFirst = () => {
    setScan((prev) => {
      if (!prev || !prev.groups.length || !prev.ungrouped.length) return prev;
      const groups = prev.groups.map((g, i) =>
        i === 0 ? { ...g, files: [...prev.ungrouped, ...g.files] } : g
      );
      return { ...prev, groups, ungrouped: [] };
    });
  };

  const reportRows = scan
    ? scan.groups
        .map((g, i) => {
          const edit = edits[i];
          if (edit?.skip) return null;
          const code = (edit?.code || g.code || '').trim();
          if (!code) return null;
          return {
            sku: code,
            name: edit?.productName || '',
            platform: platformOf(code),
            category: '产品/视频拍摄',
          };
        })
        .filter((r): r is { sku: string; name: string; platform: string; category: string } => !!r)
    : [];

  const shootDate = date || new Date().toISOString().slice(0, 10);
  const outputDateDir =
    applied?.dateDir ||
    (rootDir.trim()
      ? `${rootDir.trim().replace(/[\\/]+$/, '')}${rootDir.includes('\\') ? '\\' : '/'}${shootDate}`
      : '');

  /** 复制成可直接粘贴进 Excel 的表格：日期/时长/进度/工作成果跨行合并 */
  const copyReportTable = async () => {
    if (!reportRows.length) {
      onToast('没有可复制的 SKU', 'error');
      return;
    }
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
    const mainCount = reportRows.length;
    const aoa: string[][] = [header];
    reportRows.forEach((r, i) => {
      aoa.push([
        i === 0 ? shootDate : '',
        i === 0 ? `产品拍摄*${mainCount}` : '',
        '',
        r.sku,
        r.name,
        r.platform,
        r.category,
        i === 0 ? '待填' : '',
        i === 0 ? '待填' : '',
        i === 0 ? '待填' : '',
        i === 0 ? '100%' : '',
        i === 0 ? '文件夹截图' : '',
        '',
      ]);
    });
    aoa.push(['', '图片上传', '', '', '', '', '其它', '', '', '待填', '100%', '文件夹截图', '']);

    const esc = (s: string) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const rowsHtml: string[] = [
      `<tr>${header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`,
    ];
    reportRows.forEach((r, i) => {
      let cells = '';
      if (i === 0) {
        cells += `<td rowspan="${mainCount}">${esc(shootDate)}</td>`;
        cells += `<td rowspan="${mainCount}">${esc(`产品拍摄*${mainCount}`)}</td>`;
      }
      cells += `<td></td><td>${esc(r.sku)}</td><td>${esc(r.name)}</td><td>${esc(r.platform)}</td><td>${esc(r.category)}</td>`;
      if (i === 0) {
        cells += `<td rowspan="${mainCount}">待填</td>`;
        cells += `<td rowspan="${mainCount}">待填</td>`;
        cells += `<td rowspan="${mainCount}">待填</td>`;
        cells += `<td rowspan="${mainCount}">100%</td>`;
        cells += `<td rowspan="${mainCount}">文件夹截图</td>`;
      }
      cells += '<td></td>';
      rowsHtml.push(`<tr>${cells}</tr>`);
    });
    rowsHtml.push(
      '<tr><td></td><td>图片上传</td><td></td><td></td><td></td><td></td><td>其它</td><td></td><td></td><td>待填</td><td>100%</td><td>文件夹截图</td><td></td></tr>'
    );
    const html = `<html><body><table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-family:'Microsoft YaHei',Arial,sans-serif;font-size:12px">${rowsHtml.join('')}</table></body></html>`;
    const tsv = aoa.map((r) => r.join('\t')).join('\n');
    try {
      const CI = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (navigator.clipboard?.write && typeof CI === 'function') {
        await navigator.clipboard.write([
          new CI({
            'text/plain': new Blob([tsv], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          }),
        ]);
        onToast('表格已复制，直接粘贴到 Excel（日期/时长/进度已合并）');
        return;
      }
    } catch {
      /* 富文本剪贴板不可用，退回纯文本 */
    }
    const ok = await copyText(tsv);
    onToast(
      ok ? '已复制为纯文本；粘贴后手动合并日期/时长/进度列' : '复制失败，请重试',
      ok ? 'info' : 'error'
    );
  };

  const scanLabel = scanning
    ? `${i18n.t('k06155bfc')} ${elapsed}s`
    : scan
      ? i18n.t('k75e1781b')
      : i18n.t('k56525d62');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{i18n.t('kc01889de')}</h1>
          <div className="page-sub">{i18n.t('k176cacf3')}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={runScan} disabled={scanning}>
            {scanning ? <IconRefresh /> : <IconBarcode />} {scanLabel}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{i18n.t('kf15335db')}</span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 12,
              border: '1px solid var(--line)',
              color: oms?.configured ? 'var(--text)' : 'var(--muted)',
            }}
          >
            {oms?.configured ? oms.username : i18n.t('k71dc8feb')}
          </span>
          {oms?.configured && (
            <span className="hint" style={{ color: oms.loggedIn ? 'var(--ok, #3c9d5d)' : 'var(--muted)' }}>
              {oms.loggedIn ? i18n.t('k0b5961c7') : i18n.t('kda208e9c')}
            </span>
          )}
          <button className="btn sm" onClick={() => setOmsOpen((v) => !v)}>
            {omsOpen ? i18n.t('kdef9e98b') : oms?.configured ? i18n.t('k733314cf') : i18n.t('k6e3e8be2')}
          </button>
          {oms?.configured && (
            <button className="btn sm" onClick={testOms} disabled={omsBusy}>
              {i18n.t('k69e74756')}
            </button>
          )}
          {oms?.configured && (
            <button className="btn sm" onClick={clearOms} disabled={omsBusy}>
              {i18n.t('k79a14307')}
            </button>
          )}
          <span className="hint" style={{ marginLeft: 'auto' }}>
            {i18n.t('k9b98f1a1')}
          </span>
        </div>

        {omsOpen && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span style={{ width: 72, color: 'var(--muted)', fontSize: 12.5 }}>{i18n.t('k7035c62f')}</span>
              <input
                className="input"
                style={{ flex: 1 }}
                value={omsUser}
                onChange={(e) => setOmsUser(e.target.value)}
                placeholder="18228263717"
              />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span style={{ width: 72, color: 'var(--muted)', fontSize: 12.5 }}>{i18n.t('ka8105204')}</span>
              <input
                className="input"
                type="password"
                style={{ flex: 1 }}
                value={omsPass}
                onChange={(e) => setOmsPass(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 72, color: 'var(--muted)', fontSize: 12.5 }}>{i18n.t('k76167587')}</span>
              <input className="input" style={{ flex: 1 }} value={omsBase} onChange={(e) => setOmsBase(e.target.value)} />
              <button className="btn primary sm" onClick={saveOmsAccount} disabled={omsBusy}>
                {i18n.t('kdb20c338')}
              </button>
            </div>
            <div className="hint" style={{ marginTop: 6, marginLeft: 80 }}>
              {i18n.t('k622bd299')}
            </div>
          </div>
        )}

        {oms?.error && !omsOpen && (
          <div className="hint" style={{ marginTop: 8, color: 'var(--danger, #d9534f)' }}>
            {oms.error}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span style={{ width: 88, color: 'var(--muted)', fontSize: 12.5 }}>{i18n.t('k87dc3326')}</span>
          <input
            className="input"
            style={{ flex: 1 }}
            value={srcDir}
            onChange={(e) => setSrcDir(e.target.value)}
            placeholder="D:\\拍摄\\2026-10-28"
          />
          <button className="btn sm" onClick={() => chooseDir(setSrcDir)} disabled={!isDesktop}>
            {i18n.t('k153fa67a')}
          </button>
        </div>
        <div className="hint" style={{ marginLeft: 96, marginBottom: 12 }}>
          {i18n.t('ka93760cd')}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span style={{ width: 88, color: 'var(--muted)', fontSize: 12.5 }}>{i18n.t('k2936542f')}</span>
          <input
            className="input"
            style={{ flex: 1 }}
            value={rootDir}
            onChange={(e) => setRootDir(e.target.value)}
            placeholder="D:\\产品图"
          />
          <button className="btn sm" onClick={() => chooseDir(setRootDir)} disabled={!isDesktop}>
            {i18n.t('k153fa67a')}
          </button>
        </div>
        <div className="hint" style={{ marginLeft: 96, marginBottom: 12 }}>
          {i18n.t('k8bb3dcf7')}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ width: 88, color: 'var(--muted)', fontSize: 12.5 }}>{i18n.t('k5b72d6b4')}</span>
          <input
            className="input"
            type="date"
            style={{ width: 180 }}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <span className="hint">{i18n.t('k0600844a')}</span>
        </div>

        {!isDesktop && (
          <div className="hint" style={{ marginTop: 10 }}>
            {i18n.t('k3589bd0e')}
          </div>
        )}
        {scanning && (
          <div className="hint" style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="spin" /> {i18n.t('k84b58f99')}
          </div>
        )}
      </div>

      {!scan && !scanning && (
        <div className="empty">
          <div className="big">
            <IconBarcode size={42} />
          </div>
          <h3>{i18n.t('k0d14616d')}</h3>
          <div className="hint">{i18n.t('k6fb164de')}</div>
        </div>
      )}

      {scan && (
        <>
          <div className="toolbar">
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>{i18n.t('k59115b55')}</span>
            <span className="hint">
              {i18n.t('kfda2afc6', {
                p0: scan.total,
                p1: scan.groups.length,
                p2: scan.ungrouped.length,
              })}
            </span>
            <button className="btn sm" onClick={queryOms} disabled={omsQuerying || scanning}>
              {omsQuerying ? i18n.t('ka9119608') : i18n.t('k78d29635')}
            </button>
            <span className="hint" style={{ marginLeft: 'auto' }}>
              {i18n.t('k0600844a')}
            </span>
          </div>

          {scan.groups.map((g, i) => (
            <GroupRow
              key={`${g.barcodeFile}-${i}`}
              index={i}
              group={g}
              dir={scan.dir}
              edit={edits[i] || { code: g.code, skip: false }}
              omsBaseUrl={oms?.baseUrl || ''}
              onRetryOms={queryOms}
              onToast={onToast}
              onChange={(next) => setEdits((prev) => prev.map((e, j) => (j === i ? next : e)))}
            />
          ))}

          {scan.ungrouped.length > 0 && (
            <div className="card" style={{ marginBottom: 12, borderColor: 'var(--warn, #d08b2c)' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={{ color: 'var(--warn, #d08b2c)', fontWeight: 600, fontSize: 12.5 }}>
                  {i18n.t('k5061484d', { p0: scan.ungrouped.length })}
                </span>
                {scan.groups.length > 0 && (
                  <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={assignUngroupedToFirst}>
                    {i18n.t('k686234c9')}
                  </button>
                )}
              </div>
              <div className="hint" style={{ marginBottom: 8 }}>
                {i18n.t('kbf5fa0a4')}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {scan.ungrouped.map((f) => (
                  <img
                    key={f}
                    src={barcodeThumbUrl(scan.dir, f)}
                    alt=""
                    loading="lazy"
                    style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, background: 'var(--bg2)' }}
                  />
                ))}
              </div>
            </div>
          )}

          {scan.skipped.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="hint">{i18n.t('k7e9128b4', { p0: scan.skipped.length })}</div>
            </div>
          )}

          {applied && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{i18n.t('kcde0ad30')}</span>
                <span className="hint">
                  {i18n.t('k2827af98', { p0: applied.totalCopied, p1: applied.dateDir })}
                  {applied.importedToLibrary
                    ? ` · ${i18n.t('k3a58cce9', { p0: applied.importedTotal ?? 0 })}`
                    : ''}
                  {(applied.cleanedTotal ?? 0) > 0
                    ? ` · ${i18n.t('k6b18e06e', { p0: applied.cleanedTotal })}`
                    : ''}
                  {uploadProgress ? ` · 正在上传 OMS ${uploadProgress.done}/${uploadProgress.total}` : ''}
                </span>
                <button className="btn sm" onClick={() => openFolder(applied.dateDir)}>
                  {i18n.t('kc49c4607')}
                </button>
              </div>
              <div
                style={{
                  maxHeight: 260,
                  overflow: 'auto',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--panel-strong)',
                }}
              >
                {applied.results.map((r, i) => (
                  <div
                    key={`${r.folder}-${i}`}
                    style={{
                      display: 'flex',
                      gap: 10,
                      flexWrap: 'wrap',
                      alignItems: 'baseline',
                      padding: '7px 10px',
                      borderTop: i ? '1px solid var(--border)' : undefined,
                      fontSize: 12.5,
                      lineHeight: 1.6,
                    }}
                  >
                    <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontWeight: 600, minWidth: 210 }}>
                      {r.code || '—'}
                    </span>
                    <span className="hint">{i18n.t('kb4637267', { p0: r.copied, p1: r.skipped })}</span>
                    {applied.importedToLibrary && (
                      <span className="hint">{i18n.t('k3a58cce9', { p0: r.imported ?? 0 })}</span>
                    )}
                    {applied.importedToLibrary && (r.importSkipped ?? 0) > 0 && (
                      <span className="hint">{i18n.t('k21daf9b0', { p0: r.importSkipped ?? 0 })}</span>
                    )}
                    {(r.cleaned ?? 0) > 0 && (
                      <span className="hint">{i18n.t('k6b18e06e', { p0: r.cleaned ?? 0 })}</span>
                    )}
                    {r.errors.length > 0 && (
                      <span style={{ color: 'var(--danger, #d9534f)' }}>
                        {i18n.t('k3cbd8ca0', { p0: r.errors.map((e) => e.error).join('；') })}
                      </span>
                    )}
                    {(r.importErrors?.length ?? 0) > 0 && (
                      <span style={{ color: 'var(--danger, #d9534f)' }}>
                        {i18n.t('k3cbd8ca0', { p0: r.importErrors!.map((e) => e.error).join('；') })}
                      </span>
                    )}
                    {(r.cleanErrors?.length ?? 0) > 0 && (
                      <span style={{ color: 'var(--danger, #d9534f)' }}>
                        {i18n.t('k3cbd8ca0', { p0: r.cleanErrors!.map((e) => e.error).join('；') })}
                      </span>
                    )}
                    {uploads[r.folder] && (
                      <span
                        style={{
                          color:
                            uploads[r.folder].state === 'mismatch' || uploads[r.folder].state === 'error'
                              ? 'var(--danger, #d9534f)'
                              : uploads[r.folder].state === 'uploaded' ||
                                  uploads[r.folder].state === 'skipped'
                                ? 'var(--ok, #3c9d5d)'
                                : 'var(--muted)',
                          fontWeight:
                            uploads[r.folder].state === 'mismatch' ? 600 : 400,
                        }}
                      >
                        {uploads[r.folder].message}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div
            className="card"
            style={{
              position: 'sticky',
              bottom: 12,
              zIndex: 20,
              // 吸底卡片必须是实底：半透明的 .card 会让下面的分组内容透上来，字叠字看不清
              background: 'var(--solid-panel)',
              borderColor: 'var(--border-strong)',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
              backdropFilter: 'blur(12px)',
            }}
          >
            {flowIssues.length > 0 && (
              <div
                style={{
                  marginBottom: 8,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--danger, #d9534f)',
                  background: 'rgba(217, 83, 79, 0.12)',
                  color: 'var(--danger, #d9534f)',
                  fontSize: 12.5,
                  fontWeight: 600,
                  lineHeight: 1.7,
                }}
              >
                有 {flowIssues.length} 个问题必须先处理，处理完才能继续：
                {flowIssues.slice(0, 4).join('；')}
                {flowIssues.length > 4 ? ` 等 ${flowIssues.length} 项` : ''}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn primary"
                onClick={runSave}
                disabled={applying || flowIssues.length > 0 || !scan.groups.length}
              >
                <IconFolder /> {applyMode === 'copy' ? '保存中…' : '1. 保存'}
              </button>
              <button
                className="btn sm"
                onClick={runImport}
                disabled={applying || flowIssues.length > 0 || !scan.groups.length}
              >
                {applyMode === 'import' ? '入库中…' : '2. 入库'}
              </button>
              <button
                className="btn sm"
                onClick={runUpload}
                disabled={applying || flowIssues.length > 0 || !scan.groups.length}
              >
                {applyMode === 'upload' ? '上传中…' : '3. 上传'}
              </button>
              <label
                className="hint"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                title={`${i18n.t('k21048b99')}。${i18n.t('k58179dae')}`}
              >
                <input
                  type="checkbox"
                  checked={cleanStale}
                  onChange={(e) => setCleanStale(e.target.checked)}
                />
                {i18n.t('k23b26af3')}
              </label>
              <button className="btn sm" onClick={copyReportTable}>
                复制表格
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  if (!outputDateDir) {
                    onToast('请先选择输出根目录', 'error');
                    return;
                  }
                  downloadFile(omsProductFolderShotUrl(outputDateDir));
                }}
              >
                下载文件夹截图
              </button>
              {applied && (
                <>
                  <span className="hint" style={{ marginLeft: 'auto' }}>
                    {i18n.t('k2827af98', { p0: applied.totalCopied, p1: applied.dateDir })}
                    {applied.importedToLibrary
                      ? ` · ${i18n.t('k3a58cce9', { p0: applied.importedTotal ?? 0 })}`
                      : ''}
                    {(applied.cleanedTotal ?? 0) > 0
                      ? ` · ${i18n.t('k6b18e06e', { p0: applied.cleanedTotal })}`
                      : ''}
                    {applied.importedToLibrary
                      ? ` · 上传 ${Object.values(uploads).reduce((n, u) => n + u.uploaded, 0)} 张`
                      : ''}
                  </span>
                  <button className="btn sm" onClick={() => openFolder(applied.dateDir)}>
                    {i18n.t('kc49c4607')}
                  </button>
                </>
              )}
            </div>
            <div className="hint" style={{ marginTop: 6 }} title={i18n.t('k58179dae')}>
              {i18n.t('k168903f9')}：{activeFolder?.name || activeLibName || i18n.t('k1dae2087')} ·{' '}
              {i18n.t('k948019e4')}
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              {flowIssues.length > 0
                ? '先处理上面的报错/警告，处理完才能点保存/入库/上传。'
                : !applied
                  ? '1 保存 → 2 入库 → 3 上传。测试阶段无报错时可点任意一步，缺的前置会自动补上。'
                  : !applied.importedToLibrary
                    ? '保存完成。确认文件夹内容后，点「2. 入库」；也可以直接点「3. 上传」自动补入库。'
                    : '入库完成。确认图库内容后，点「3. 上传」；名称一致自动上传，不一致停下等你核对。'}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface GroupRowProps {
  index: number;
  group: BarcodeGroup;
  dir: string;
  edit: GroupEdit;
  omsBaseUrl: string;
  onRetryOms: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onChange: (next: GroupEdit) => void;
}

/** 一个条码组：条码缩略图 + 可编辑编码 + 候选 + 产品缩略图 */
function GroupRow({ index, group, dir, edit, omsBaseUrl, onRetryOms, onToast, onChange }: GroupRowProps) {
  const [preview, setPreview] = useState(false);
  // 每次双击都换一个 v：服务端换新后，浏览器不会继续用旧的 240px 缓存
  const [previewNonce, setPreviewNonce] = useState(0);
  const thumbStyle: React.CSSProperties = {
    width: 120,
    height: 90,
    objectFit: 'cover',
    borderRadius: 8,
    background: 'var(--bg2)',
  };

  // 大图预览：Esc 关闭，避免双击打开后还要找关闭按钮
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  const openOms = () => {
    // 主 SKU 优先取 OCR 保留的 5 位；已有完整编码时从完整编码前缀补
    const mainSku = (edit.mainSku || group.code.trim().match(/^(\d{4,6})/)?.[1] || '').trim();
    // 打开视觉拍摄页时顺手把主 SKU 放进剪贴板：后台 URL 暂不读 mainSkuId 时也能直接粘贴搜索。
    // 不 await：复制是异步的，先同步 window.open，避免浏览器把新窗口当弹窗拦掉。
    if (mainSku) {
      void copyText(mainSku).then((ok) =>
        onToast(ok ? i18n.t('k6f6d997e', { p0: mainSku }) : i18n.t('kba7e6692'), ok ? 'info' : 'error')
      );
    }
    // Electron 的 setWindowOpenHandler 会把 http(s) 外链交给系统浏览器
    window.open(omsPageUrl(omsBaseUrl, mainSku), '_blank', 'noopener,noreferrer');
  };

  const copyCode = async () => {
    const code = edit.code.trim();
    const ok = await copyText(code);
    onToast(ok ? i18n.t('k5f0a2b31', { p0: code }) : i18n.t('k3987c43b'), ok ? 'info' : 'error');
  };

  const fullCode = isFullCode(edit.code);
  const omsRows = edit.omsRows || [];
  const omsState = edit.omsState;
  // 已经有完整编码就不再提示补全；只有「OCR 只给到主 SKU」且 OMS 没给出结果时才提示
  const showPartial = !fullCode && (!omsState || omsState === 'found');
  const showNotFound = !fullCode && omsState === 'empty';
  const showError = !fullCode && omsState === 'error';
  const showChoices = omsRows.length > 1;
  const otherWarnings = group.warnings.filter((w) => w.code !== 'partial');

  const alertStyle: React.CSSProperties = {
    marginTop: 8,
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid var(--danger, #d9534f)',
    background: 'rgba(217, 83, 79, 0.12)',
    color: 'var(--danger, #d9534f)',
    fontSize: 12.5,
    fontWeight: 600,
    lineHeight: 1.7,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  };

  return (
    <div className="card" style={{ marginBottom: 12, opacity: edit.skip ? 0.55 : 1 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 120px' }}>
          <img
            src={barcodeThumbUrl(dir, group.barcodeFile)}
            alt=""
            loading="lazy"
            title={i18n.t('kdf093f7d')}
            onDoubleClick={() => {
              setPreviewNonce(Date.now());
              setPreview(true);
            }}
            style={{ ...thumbStyle, cursor: 'zoom-in' }}
          />
          <div className="hint" style={{ marginTop: 4 }}>
            {i18n.t('k48ccc6a5')} · {i18n.t('kdf093f7d')}
          </div>
          {group.barcodeText ? (
            <div className="hint" style={{ marginTop: 2, wordBreak: 'break-all', color: 'var(--text)' }}>
              {i18n.t('kac371bde', { p0: group.barcodeText })}
            </div>
          ) : (
            <div className="hint" style={{ marginTop: 2 }}>
              {i18n.t('k3b43a1cd')}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="hint">
              #{index + 1} · {i18n.t('kcc6c35a3')}
            </span>
            <input
              className="input"
              style={{ flex: '1 1 260px', fontFamily: 'ui-monospace, Consolas, monospace' }}
              value={edit.code}
              onChange={(e) => onChange({ ...edit, code: e.target.value })}
              placeholder={i18n.t('k0efcf5ce')}
            />
            <button
              className="btn sm"
              onClick={copyCode}
              disabled={!edit.code.trim()}
              title={i18n.t('k79d3abe9')}
            >
              <IconCopy /> {i18n.t('k79d3abe9')}
            </button>
            <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={edit.skip}
                onChange={(e) => onChange({ ...edit, skip: e.target.checked })}
              />
              {i18n.t('k8796fd50')}
            </label>
          </div>

          {/* 产品名单独一行：保存入库时会作为独立标签写到该组每一张图 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <span className="hint" style={{ width: 44 }}>
              {i18n.t('kc6afa029')}
            </span>
            <input
              className="input"
              style={{ flex: '1 1 260px' }}
              value={edit.productName || ''}
              onChange={(e) => onChange({ ...edit, productName: e.target.value })}
              placeholder={i18n.t('kc7b5bb11')}
            />
            {!String(edit.productName || '').trim() && (
              <span className="hint" style={{ color: 'var(--danger, #d9534f)', fontWeight: 600 }}>
                产品名为空，保存/上传会停止
              </span>
            )}
          </div>

          {group.candidates.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
              <span className="hint">{i18n.t('kf21434be')}</span>
              {group.candidates.map((c) => (
                <button key={c} className="btn sm" onClick={() => onChange({ ...edit, code: c })}>
                  {c}
                </button>
              ))}
            </div>
          )}

          {otherWarnings.length > 0 && (
            <div style={{ marginTop: 8, color: 'var(--warn, #d08b2c)', fontSize: 12.5, lineHeight: 1.7 }}>
              {otherWarnings.map((w, i) => (
                <div key={`${w.code}-${i}`}>· {w.text}</div>
              ))}
            </div>
          )}

          {showPartial && (
            <div style={{ marginTop: 8, color: 'var(--warn, #d08b2c)', fontSize: 12.5, lineHeight: 1.7 }}>
              · {i18n.t('k5469cfcc')}
            </div>
          )}

          {edit.omsNote && omsState === 'found' && (
            <div className="hint" style={{ marginTop: 8, color: 'var(--text)' }}>
              {edit.omsNote}
            </div>
          )}

          {showChoices && (
            <div
              style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                marginTop: 8,
                alignItems: 'center',
                padding: fullCode ? 0 : '8px 10px',
                borderRadius: 8,
                border: fullCode ? 'none' : '1px solid rgba(249, 115, 22, 0.5)',
                background: fullCode ? 'transparent' : 'rgba(249, 115, 22, 0.08)',
              }}
            >
              <span
                className="hint"
                style={{ fontWeight: fullCode ? undefined : 600, color: fullCode ? undefined : 'var(--text)' }}
              >
                {fullCode ? i18n.t('kf21434be') : i18n.t('kfe15109b', { p0: omsRows.length })}
              </span>
              {omsRows.map((r) => (
                <span key={r.salesSku} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  <button
                    className="btn sm"
                    title={r.productName || undefined}
                    onClick={() =>
                      onChange({
                        ...edit,
                        code: r.salesSku,
                        productName: r.productName || edit.productName,
                      })
                    }
                  >
                    {r.salesSku}
                  </button>
                  {r.id && (
                    <button
                      className="btn sm"
                      style={{ padding: '2px 6px' }}
                      title={i18n.t('k952f0e4e')}
                      onClick={() => openOms()}
                    >
                      <IconArrowUpRight />
                    </button>
                  )}
                </span>
              ))}
              <button className="btn sm" onClick={() => openOms()} title={i18n.t('k52a0f368')}>
                <IconArrowUpRight /> {i18n.t('k52a0f368')}
              </button>
            </div>
          )}

          {showNotFound && (
            <div style={alertStyle}>
              <span>{i18n.t('k17b2784d')}</span>
              <button className="btn sm" onClick={() => openOms()}>
                {i18n.t('k52a0f368')}
              </button>
              <button className="btn sm" onClick={onRetryOms}>
                {i18n.t('k132c5cdc')}
              </button>
            </div>
          )}

          {showError && (
            <div style={alertStyle}>
              <span>{edit.omsNote || i18n.t('k8280f081', { p0: '—' })}</span>
              <button className="btn sm" onClick={onRetryOms}>
                {i18n.t('k132c5cdc')}
              </button>
              <button className="btn sm" onClick={() => openOms()}>
                {i18n.t('k52a0f368')}
              </button>
            </div>
          )}

          {/* 这一组的全部产品图都展示出来，不再截断 12 张 */}
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {group.files.map((f) => (
              <img
                key={f}
                src={barcodeThumbUrl(dir, f)}
                alt=""
                loading="lazy"
                style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, background: 'var(--bg2)' }}
              />
            ))}
          </div>

          <div className="hint" style={{ marginTop: 6 }}>
            {i18n.t('k8b4a55fe', { p0: group.files.length })}
            {group.files.length > 0 ? ` · ${group.files[0]} … ${group.files[group.files.length - 1]}` : ''}
          </div>

          {group.rawText && (
            <details style={{ marginTop: 8 }}>
              <summary className="hint" style={{ cursor: 'pointer' }}>
                {i18n.t('kb6b95e34')}
              </summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  margin: '6px 0 0',
                  maxHeight: 140,
                  overflow: 'auto',
                }}
              >
                {group.rawText}
              </pre>
            </details>
          )}
        </div>
      </div>

      {preview && (
        <div
          className="modal-backdrop"
          style={{ zIndex: 200, cursor: 'zoom-out' }}
          onClick={() => setPreview(false)}
        >
          <div
            style={{ maxWidth: '94vw', maxHeight: '94vh', display: 'flex', flexDirection: 'column', gap: 10 }}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={`${barcodeThumbUrl(dir, group.barcodeFile, 2400)}&v=${previewNonce}`}
              alt=""
              style={{
                maxWidth: '94vw',
                maxHeight: '86vh',
                objectFit: 'contain',
                borderRadius: 10,
                background: '#000',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="hint" style={{ color: '#fff', wordBreak: 'break-all' }}>
                {group.barcodeFile}
              </span>
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setPreview(false)}>
                {i18n.t('kb15d9127')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
