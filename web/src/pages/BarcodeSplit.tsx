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
  type BarcodeCropItemResult,
  type BarcodeGroup,
  type BarcodeImportResponse,
  type BarcodeNumberItemResult,
  type BarcodeRatioItemResult,
  type BarcodeScanResult,
  type OmsDesignRow,
  type OmsStatus,
} from '../api';
import { IconArrowUpRight, IconBarcode, IconCopy, IconFolder, IconRefresh } from '../components/Icons';
import { getApiToken } from '../api/core';
import { confirmDialog } from '../components/Dialogs';
import BatchCropStudio, { type CropItem } from '../components/BatchCropStudio';
import Select from '../components/Select';
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

/** 九个固定步骤：识别 → 查询 → 核对 → 建夹 → 构图 → 编号 → 入库 → 上传 → 报表 */
type StepKey =
  | 'scan'
  | 'resolve'
  | 'review'
  | 'copy'
  | 'ratio'
  | 'number'
  | 'import'
  | 'upload'
  | 'report';

const STEP_DEFS: { key: StepKey; title: string }[] = [
  { key: 'scan', title: '识别主 SKU' },
  { key: 'resolve', title: '查询完整编码' },
  { key: 'review', title: '核对编码' },
  { key: 'copy', title: '创建文件夹' },
  { key: 'ratio', title: 'eBay 构图' },
  { key: 'number', title: '图片编号' },
  { key: 'import', title: '入库' },
  { key: 'upload', title: '上传 OMS' },
  { key: 'report', title: '生成 Excel' },
];

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
  const [applyMode, setApplyMode] = useState<
    'copy' | 'import' | 'upload' | 'ratio' | 'crop' | 'number' | 'report' | null
  >(null);
  const applying = applyMode !== null;
  const [cleanStale, setCleanStale] = useState(true);
  const [applied, setApplied] = useState<BarcodeApplyResponse | null>(null);
  /** 1:1 检查结果（eBay 构图） */
  const [ratios, setRatios] = useState<BarcodeRatioItemResult[] | null>(null);
  /** 自动居中裁剪结果 */
  const [cropReport, setCropReport] = useState<BarcodeCropItemResult[] | null>(null);
  /** 编号结果：1.jpg、2.jpg… */
  const [numbered, setNumbered] = useState<BarcodeNumberItemResult[] | null>(null);
  /** 入库 / 上传允许跳过：跳过也视为完成，报表步骤照常可用 */
  const [importSkipped, setImportSkipped] = useState(false);
  const [uploadSkipped, setUploadSkipped] = useState(false);
  /** 编号前：每个产品的图片、用户自己挑的前 5 张（key = 产品文件夹） */
  const [numberFiles, setNumberFiles] = useState<Record<string, string[]>>({});
  const [numberPicks, setNumberPicks] = useState<Record<string, string[]>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 入库结果 */
  const [imported, setImported] = useState<BarcodeImportResponse | null>(null);
  const [uploadedOk, setUploadedOk] = useState(false);
  const [reported, setReported] = useState(false);
  const [uploads, setUploads] = useState<Record<string, UploadOutcome>>({});
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [oms, setOms] = useState<OmsStatus | null>(null);
  const [omsOpen, setOmsOpen] = useState(false);
  const [omsUser, setOmsUser] = useState('');
  const [omsPass, setOmsPass] = useState('');
  const [omsBase, setOmsBase] = useState('https://sit.uyoyous.com');
  const [omsBusy, setOmsBusy] = useState(false);
  const [omsQuerying, setOmsQuerying] = useState(false);
  /** 日期文件夹名：默认跟 date 一致，会从输出根目录的同级目录学习命名格式 */
  const [dateFolder, setDateFolder] = useState('');
  const [dateFolderHint, setDateFolderHint] = useState<{
    learned: boolean;
    label: string;
    count: number;
    samples: string[];
  } | null>(null);
  /** 日期文件夹下一级分类：默认不开，用户勾选后才插入这一层 */
  const [subEnabled, setSubEnabled] = useState(false);
  const [subMode, setSubMode] = useState<'platform' | 'custom'>('platform');
  const [subEbay, setSubEbay] = useState('eBay');
  const [subOther, setSubOther] = useState('非eBay');
  const [subCustom, setSubCustom] = useState('产品图');
  /** 用户手动跳到某一步；null = 自动跟随第一个未完成步骤 */
  const [stepOverride, setStepOverride] = useState<StepKey | null>(null);
  /** 手动分组：当前勾选的图片（相对源目录） */
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [moveTarget, setMoveTarget] = useState('ungrouped');
  /** 直接生成报表：用户选一个「包含若干产品文件夹」的目录 */
  const [manualDir, setManualDir] = useState('');
  const [manualFolders, setManualFolders] = useState<{ name: string; files: number }[]>([]);
  /** 第 5 步：复用图库里的批量裁切台，直接裁输出文件夹里还没入库的 eBay 图 */
  const [cropStudioOpen, setCropStudioOpen] = useState(false);
  const [cropStudioItems, setCropStudioItems] = useState<CropItem[]>([]);

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

  // 输出根目录 / 日期变化时，学习同级目录的日期命名（20261123 vs 2026-11-23）
  useEffect(() => {
    if (!rootDir.trim() || !date) return;
    const timer = setTimeout(() => {
      api
        .barcodeDateFolder(rootDir.trim(), date)
        .then((r) => {
          if (!r?.name) return;
          setDateFolder(r.name);
          setDateFolderHint({
            learned: !!r.learned,
            label: r.label || '',
            count: r.count || 0,
            samples: r.samples || [],
          });
        })
        .catch(() => {
          /* 学习失败不影响手填 */
        });
    }, 450);
    return () => clearTimeout(timer);
  }, [rootDir, date]);

  const chooseDir = async (apply: (v: string) => void) => {
    const dir = await pickFolder();
    if (dir) apply(dir);
  };

  /** 日期文件夹下一级分类名：没勾选时一律为空（日期/编码两层） */
  const subfolderFor = (code: string) => {
    if (!subEnabled) return '';
    if (subMode === 'custom') return subCustom.trim();
    return platformOf(code) === 'eBay' ? subEbay.trim() : subOther.trim();
  };

  const toggleSelectFile = (file: string) => {
    setSelectedFiles((prev) =>
      prev.includes(file) ? prev.filter((f) => f !== file) : [...prev, file]
    );
  };

  /** 手动分组：把勾选的图片移到未分组 / 指定组 / 新建组，保持原有拍摄顺序 */
  const moveSelectedFiles = (target: 'ungrouped' | 'new' | number) => {
    if (!scan || !selectedFiles.length) return;
    const moving = new Set(selectedFiles);
    const order = [...scan.groups.flatMap((g) => g.files), ...scan.ungrouped];
    const files = order.filter((f) => moving.has(f));
    if (!files.length) return;
    setScan((prev) => {
      if (!prev) return prev;
      const groups = prev.groups.map((g) => ({ ...g, files: g.files.filter((f) => !moving.has(f)) }));
      let ungrouped = prev.ungrouped.filter((f) => !moving.has(f));
      if (target === 'ungrouped') {
        ungrouped = [...ungrouped, ...files];
      } else if (target === 'new') {
        groups.push({
          code: '',
          candidates: [],
          rawText: '',
          barcodeText: '',
          barcodeFile: '',
          files,
          warnings: [{ code: 'manual', text: '手动新建的分组，请填写编码和产品名' }],
        });
      } else if (groups[target]) {
        groups[target] = { ...groups[target], files: [...groups[target].files, ...files] };
      }
      return { ...prev, groups, ungrouped };
    });
    if (target === 'new') setEdits((prev) => [...prev, { code: '', skip: false }]);
    setSelectedFiles([]);
  };

  /** 直接生成报表：选一个已经整理好的日期文件夹（里面是若干产品文件夹） */
  const pickManualReportDir = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    try {
      const res = await api.barcodeSubfolders(dir);
      if (!res.folders.length) {
        onToast('这个文件夹里没有子文件夹，请选择包含若干产品文件夹的目录', 'error');
        return;
      }
      setManualDir(res.dir);
      setManualFolders(res.folders);
      setStepOverride('report');
      onToast(`已载入 ${res.folders.length} 个产品文件夹，可直接生成报表`, 'info');
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
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
      // 已有完整编码时用前缀查，顺便补产品名
      return (edits[i]?.mainSku || code.match(/^(\d{4,6})/)?.[1] || '').trim();
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
    // 重新扫描后下游全部作废，避免拿旧文件夹/旧编号继续走
    setRatios(null);
    setCropReport(null);
    setNumbered(null);
    setNumberFiles({});
    setNumberPicks({});
    setPickerOpen(false);
    setImported(null);
    setImportSkipped(false);
    setUploadSkipped(false);
    setUploadedOk(false);
    setReported(false);
    setStepOverride(null);
    setSelectedFiles([]);
    setManualDir('');
    setManualFolders([]);
    try {
      const result = await api.barcodeScan(srcDir.trim());
      setScan(result);
      setEdits(
        result.groups.map((g) => ({
          code: g.code,
          skip: false,
          // 完整编码也能反推主 SKU 前缀，后续重新查询 OMS 不用再手填
          mainSku: g.code.trim().match(/^(\d{4,6})/)?.[1] || '',
        }))
      );
      setDate((prev) => prev || result.date);
      setDateFolder((prev) => prev || result.date);
      if (!result.groups.length) onToast(i18n.t('k07190065'));
      // 已配置 OMS 时顺手换成完整编码并补产品名（只取「待拍摄」）
      if (oms?.configured) {
        const skus = [...new Set(
          result.groups
            .map((g) => g.code.trim().match(/^(\d{4,6})/)?.[1] || '')
            .filter(Boolean)
        )];
        if (skus.length) {
          void runOmsQuery(skus, (i) => {
            const c = (result.groups[i]?.code || '').trim();
            return /^\d{4,6}$/.test(c) ? c : c.match(/^(\d{4,6})/)?.[1] || '';
          });
        }
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
            subfolder: subfolderFor(code),
          };
        })
      : [];

  /** 已复制出来的编码文件夹：后续检查 / 编号 / 入库 / 上传都围绕它们 */
  const outputFolders = (applied?.results || [])
    .filter((r) => r.folder)
    .map((r) => ({
      sourceIndex: r.sourceIndex,
      code: r.code,
      folder: r.folder,
      subfolder: r.subfolder || '',
    }));

  /** 第 4 步：创建本地文件夹（只复制，不移动原图） */
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
        dateFolder: dateFolder.trim() || date,
        groups,
        importToLibrary: false,
        cleanStale,
      });
      setApplied(result);
      setStepOverride(null);
      // 文件夹重建后，后面的检查结果全部作废
      setRatios(null);
      setCropReport(null);
      setNumbered(null);
      setNumberFiles({});
      setNumberPicks({});
      setPickerOpen(false);
      setImported(null);
      setImportSkipped(false);
      setUploadSkipped(false);
      setUploads({});
      setUploadedOk(false);
      setReported(false);
      onToast(i18n.t('k2827af98', { p0: result.totalCopied, p1: result.dateDir }));
      onToast('文件夹已创建：下一步检查 eBay 图片是否 1:1', 'info');
      // 输出目录大概率就是用户现有的素材库：检测到就刷新列表；是别的库先问要不要切过去。
      void (async () => {
        try {
          const probe = await api.probeLibrary(rootDir.trim());
          if (!probe.found) return;
          if (probe.library && !probe.library.active) {
            if (
              await confirmDialog(
                `检测到「${probe.library.name}」是已有素材库，是否切换到该库并刷新图片列表？`
              )
            ) {
              await api.activateLibrary(probe.library.id);
              onLibraryChanged();
              onToast('已切换并刷新素材库', 'info');
            }
          } else {
            onLibraryChanged();
            onToast('输出目录属于当前素材库，已刷新图片列表', 'info');
          }
        } catch {
          /* 探测 / 刷新失败不能影响条码主流程 */
        }
      })();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
    }
  };

  /** 第 5 步：检查 1:1。只有 eBay 组需要；只提示，不自动改图 */
  const ebayFolders = outputFolders.filter((f) => platformOf(f.code) === 'eBay');
  const checkRatios = async () => {
    const items = ebayFolders.map((f) => ({ code: f.code, dir: f.folder }));
    if (!items.length) {
      setRatios([]);
      return [];
    }
    const res = await api.barcodeRatio(items);
    setRatios(res.items);
    return res.items;
  };

  const runRatio = async () => {
    setApplyMode('ratio');
    try {
      const items = await checkRatios();
      if (!items) return;
      if (!items.length) {
        onToast('没有 eBay 组，不需要检查 1:1');
        return;
      }
      const bad = items.reduce((n, it) => n + it.notSquare.length, 0);
      if (bad) {
        const detail = items
          .filter((it) => it.notSquare.length)
          .slice(0, 3)
          .map((it) => `${it.code}（${it.notSquare.length} 张）`)
          .join('、');
        onToast(
          `有 ${bad} 张 eBay 图不是 1:1，必须是正方形：${detail}${items.filter((it) => it.notSquare.length).length > 3 ? ' 等' : ''}。已打开批量裁切台，可逐张调整；也可点「自动居中裁剪」一键处理。`,
          'error'
        );
        // 检查出不合格图片就自动打开裁切台；已经开着时不要重复弹
        if (!cropStudioOpen) openBatchCrop(items);
      } else {
        onToast('检查完成：eBay 图都是 1:1');
      }
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
    }
  };

  /**
   * 第 5 步：打开项目已有的批量裁切台。
   * 这里的图片还在输出文件夹里、没有图库 id，所以给裁切台传 dir + file，
   * 裁切台会走 /api/barcode/crop-rects 原地覆盖，而不是图库任务。
   */
  const openBatchCrop = (source: BarcodeRatioItemResult[] | null = null) => {
    // 自动打开时 ratios 的 setState 还没生效，直接传刚查到的结果，避免拿到旧值
    const bad = (source || ratios || []).filter((it) => it.notSquare.length);
    if (!bad.length) {
      onToast('没有需要裁剪的图片，请先点「检查 1:1」', 'error');
      return;
    }
    const items: CropItem[] = [];
    let syntheticId = -1;
    for (const r of bad) {
      for (const f of r.notSquare) {
        items.push({
          id: syntheticId--,
          title: `${r.code}/${f.file}`,
          thumb: barcodeThumbUrl(r.dir, f.file, 300),
          url: barcodeThumbUrl(r.dir, f.file, 800),
          width: f.width,
          height: f.height,
          group: r.code,
          source: { dir: r.dir, file: f.file, code: r.code },
        });
      }
    }
    setCropStudioItems(items);
    setCropStudioOpen(true);
  };

  /** 第 5 步补充：只裁不是 1:1 的图，居中裁成正方形并原地覆盖 */
  const runCrop = async () => {
    const bad = (ratios || []).filter((it) => it.notSquare.length);
    if (!bad.length) {
      onToast('没有需要裁剪的图片，请先点「检查 1:1」', 'error');
      return;
    }
    setApplyMode('crop');
    try {
      const res = await api.barcodeCrop(
        bad.map((it) => ({ code: it.code, dir: it.dir, files: it.notSquare.map((f) => f.file) }))
      );
      setCropReport(res.items);
      const cropped = res.items.reduce((n, it) => n + it.cropped.length, 0);
      const failed = res.items.reduce((n, it) => n + it.errors.length, 0);
      // 裁完再核一次，确认真的都是 1:1
      await checkRatios();
      onToast(
        failed ? `已裁剪 ${cropped} 张，${failed} 张失败（可在结果里查看）` : `已裁剪 ${cropped} 张，全部为 1:1`,
        failed ? 'error' : 'info'
      );
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
    }
  };

  /** 第 6 步：图片编号，编号直接作为最终文件名 */
  const openNumberPicker = async () => {
    if (!outputFolders.length) {
      onToast('还没有创建文件夹', 'error');
      return;
    }
    setApplyMode('number');
    try {
      const pairs = await Promise.all(
        outputFolders.map(async (f) => {
          const r = await api.barcodeFolderImages(f.folder);
          return [f.folder, r.files] as const;
        })
      );
      setNumberFiles(Object.fromEntries(pairs));
      setNumberPicks((prev) => {
        const next = { ...prev };
        for (const [dir, files] of pairs) if (!next[dir]?.length) next[dir] = files.slice(0, 5);
        return next;
      });
      setPickerOpen(true);
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
    }
  };

  const toggleNumberPick = (dir: string, name: string) => {
    const cur = numberPicks[dir] || [];
    if (!cur.includes(name) && cur.length >= 5) {
      onToast('每个产品最多选 5 张作为前五张', 'error');
      return;
    }
    setNumberPicks((prev) => {
      const list = prev[dir] || [];
      return {
        ...prev,
        [dir]: list.includes(name) ? list.filter((n) => n !== name) : [...list, name],
      };
    });
  };

  /** 第 6 步：图片编号，编号直接作为最终文件名 */
  const runNumber = async () => {
    const folders = outputFolders.map((f) => ({
      code: f.code,
      dir: f.folder,
      // 没挑过的产品不传 files，服务端按自然序（旧行为）
      files: numberPicks[f.folder]?.length ? numberPicks[f.folder] : undefined,
    }));
    if (!folders.length) {
      onToast('还没有创建文件夹', 'error');
      return;
    }
    setApplyMode('number');
    try {
      const res = await api.barcodeNumber(folders);
      setNumbered(res.results);
      setPickerOpen(false);
      setNumberFiles({});
      setImported(null);
      setImportSkipped(false);
      setUploadSkipped(false);
      setUploadedOk(false);
      setReported(false);
      const total = res.results.reduce((n, r) => n + r.files.length, 0);
      const failed = res.results.reduce((n, r) => n + r.errors.length, 0);
      onToast(
        failed
          ? `编号完成：${total} 张，${failed} 个文件夹出错`
          : `编号完成：${res.results.length} 个文件夹，共 ${total} 张（1.jpg、2.jpg…）`,
        failed ? 'error' : 'info'
      );
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
    }
  };

  /** 第 7 步：把已编号的文件夹登记进图库 */
  const runImport = async () => {
    if (!scan) return;
    setImportSkipped(false);
    if (!outputFolders.length) {
      onToast('还没有创建文件夹', 'error');
      return;
    }
    if (!numbered) {
      onToast('请先完成图片编号，再入库', 'error');
      return;
    }
    const groups = outputFolders.map((f) => {
      const edit = edits[f.sourceIndex];
      const code = String(edit?.code || f.code || '').trim();
      return {
        code,
        folder: f.folder,
        subfolder: f.subfolder,
        productName: edit?.productName || '',
        mainSku: edit?.mainSku || code.match(/^(\d{4,6})/)?.[1] || '',
      };
    });
    setApplyMode('import');
    try {
      const result = await api.barcodeImport({
        root: rootDir.trim(),
        date,
        dateFolder: dateFolder.trim() || date,
        parentFolderId: folderId,
        groups,
      });
      setImported(result);
      setStepOverride(null);
      setUploadedOk(false);
      setReported(false);
      onLibraryChanged();
      const failed = result.results.reduce((n, r) => n + r.importErrors.length, 0);
      onToast(
        failed
          ? `入库完成：新登记 ${result.importedTotal} 张，${failed} 个错误`
          : `入库完成：新登记 ${result.importedTotal} 张${
              result.importSkippedTotal ? `，已存在 ${result.importSkippedTotal} 张` : ''
            }`,
        failed ? 'error' : 'info'
      );
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
    }
  };

  /** 第 8 步：核对 OMS 名称并上传（本轮不测，保留完整实现） */
  const runUpload = async () => {
    if (!scan) return;
    setUploadSkipped(false);
    if (flowIssues.length) {
      onToast('页面还有报错/警告，先处理完再继续', 'error');
      return;
    }
    if (!imported && !importSkipped) {
      onToast('请先完成入库，再上传 OMS（或点「跳过入库」）', 'error');
      return;
    }
    if (!applied) {
      onToast('还没有可上传的文件夹', 'error');
      return;
    }
    setApplyMode('upload');
    try {
      const up = await uploadAppliedGroups(applied);
      setUploadedOk(up.mismatch === 0);
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

  /** 文件夹截图复制成剪贴板图片，可直接粘到 Excel「工作成果」列；不支持时退回下载 */
  const copyFolderShot = async () => {
    const shotDir = manualDir || outputDateDir;
    if (!shotDir) {
      onToast('请先选择输出根目录，或在报表步骤选择已整理好的文件夹', 'error');
      return;
    }
    const url = omsProductFolderShotUrl(shotDir);
    try {
      const token = await getApiToken();
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error('当前环境不支持复制图片');
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      onToast('文件夹截图已复制，可直接粘贴到 Excel', 'info');
    } catch (err) {
      onToast(`复制截图失败：${(err as Error).message}，已改为下载`, 'error');
      downloadFile(url);
    }
  };

  /** 第 9 步：生成工作日报 Excel（时长列留空，由用户手填） */
  const runReport = async () => {
    if (!reportRows.length) {
      onToast('没有可导出的 SKU', 'error');
      return;
    }
    setApplyMode('report');
    try {
      const blob = await api.omsProductReport({ date: shootDate, rows: reportRows });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `工作日报-${shootDate}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setReported(true);
      setStepOverride('report');
      onToast(`已生成工作日报：工作日报-${shootDate}.xlsx`);
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
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

  const scanReportRows = scan
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
  /** 直接选一个已整理好的文件夹时，用它下面的子文件夹名当 SKU 生成报表 */
  const manualReportRows = manualDir
    ? manualFolders.map((f) => ({
        sku: f.name,
        name: '',
        platform: platformOf(f.name),
        category: '产品/视频拍摄',
      }))
    : [];
  const reportRows = manualReportRows.length ? manualReportRows : scanReportRows;

  const shootDate = date || new Date().toISOString().slice(0, 10);
  const outputDateDir =
    applied?.dateDir ||
    (rootDir.trim()
      ? `${rootDir.trim().replace(/[\\/]+$/, '')}${rootDir.includes('\\') ? '\\' : '/'}${
          dateFolder.trim() || shootDate
        }`
      : '');

  /** 各步骤完成状态：当前步骤 = 第一个没完成的 */
  const stepDone: Record<StepKey, boolean> = {
    scan: !!scan && scan.groups.length > 0,
    resolve:
      !!scan &&
      scan.groups.length > 0 &&
      !omsQuerying &&
      scan.groups.every(
        (g, i) => !!edits[i]?.skip || !!edits[i]?.omsState || isFullCode(edits[i]?.code ?? g.code)
      ),
    review: !!scan && scan.groups.length > 0 && flowIssues.length === 0,
    copy: outputFolders.length > 0,
    // 有不是 1:1 的图就停在这一步：用户手动裁完再检查一次即可继续
    // 没有 eBay 组时这一步无事可做，直接算完成，别让用户卡在「检查 1:1」
    ratio: !ebayFolders.length || (!!ratios && ratios.every((it) => it.notSquare.length === 0)),
    number: !!numbered,
    import: !!imported || importSkipped,
    upload: uploadedOk || uploadSkipped,
    report: reported,
  };
  const autoCurrentKey: StepKey = STEP_DEFS.find((s) => !stepDone[s.key])?.key ?? 'report';
  const currentKey: StepKey = stepOverride ?? autoCurrentKey;
  const notSquareTotal = (ratios || []).reduce((n, it) => n + it.notSquare.length, 0);

  /** 复制成可直接粘贴进 Excel 的表格：日期/时长/进度/工作成果跨行合并（无表头，整体居中） */
  const copyReportTable = async () => {
    if (!reportRows.length) {
      onToast('没有可复制的 SKU', 'error');
      return;
    }
    const mainCount = reportRows.length;
    const aoa: string[][] = [];
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
    const cell = 'text-align:center;vertical-align:middle;';
    const rowsHtml: string[] = [];
    reportRows.forEach((r, i) => {
      let cells = '';
      if (i === 0) {
        cells += `<td rowspan="${mainCount}" style="${cell}">${esc(shootDate)}</td>`;
        cells += `<td rowspan="${mainCount}" style="${cell}">${esc(`产品拍摄*${mainCount}`)}</td>`;
      }
      cells += `<td style="${cell}"></td><td style="${cell}">${esc(r.sku)}</td><td style="${cell}">${esc(
        r.name
      )}</td><td style="${cell}">${esc(r.platform)}</td><td style="${cell}">${esc(r.category)}</td>`;
      if (i === 0) {
        cells += `<td rowspan="${mainCount}" style="${cell}">待填</td>`;
        cells += `<td rowspan="${mainCount}" style="${cell}">待填</td>`;
        cells += `<td rowspan="${mainCount}" style="${cell}">待填</td>`;
        cells += `<td rowspan="${mainCount}" style="${cell}">100%</td>`;
        cells += `<td rowspan="${mainCount}" style="${cell}">文件夹截图</td>`;
      }
      cells += `<td style="${cell}"></td>`;
      rowsHtml.push(`<tr>${cells}</tr>`);
    });
    rowsHtml.push(
      `<tr><td style="${cell}"></td><td style="${cell}">图片上传</td><td style="${cell}"></td><td style="${cell}"></td><td style="${cell}"></td><td style="${cell}"></td><td style="${cell}">其它</td><td style="${cell}"></td><td style="${cell}"></td><td style="${cell}">待填</td><td style="${cell}">100%</td><td style="${cell}">文件夹截图</td><td style="${cell}"></td></tr>`
    );
    const html = `<html><body><table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-family:'Microsoft YaHei',Arial,sans-serif;font-size:12px;text-align:center;vertical-align:middle">${rowsHtml.join(
      ''
    )}</table></body></html>`;
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
                placeholder="13333333333"
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

        {/* 日期文件夹名：自动学习同级目录格式，也允许用户直接改 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ width: 88, color: 'var(--muted)', fontSize: 12.5 }}>日期文件夹</span>
          <input
            className="input"
            style={{ width: 220 }}
            value={dateFolder}
            onChange={(e) => setDateFolder(e.target.value)}
            placeholder={shootDate}
          />
          {dateFolderHint?.learned && (
            <span className="hint">
              已按同级目录学习：{dateFolderHint.label}
              {dateFolderHint.samples.length
                ? `（现有 ${dateFolderHint.samples.slice(0, 4).join('、')}${
                    dateFolderHint.count > 4 ? ' 等' : ''
                  }）`
                : ''}
            </span>
          )}
          {!dateFolderHint?.learned && <span className="hint">可直接改成你习惯的写法，例如 20261123</span>}
        </div>

        {/* 日期文件夹下一级分类：可选，默认不勾选（日期/编码两层） */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <label
            className="hint"
            style={{ display: 'flex', alignItems: 'center', gap: 6, width: 88, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={subEnabled}
              onChange={(e) => setSubEnabled(e.target.checked)}
            />
            日期下一级
          </label>
          {subEnabled && (
            <>
              <Select
                style={{ width: 240 }}
                value={subMode}
                onChange={(v) => setSubMode(v as 'platform' | 'custom')}
                options={[
                  { value: 'platform', label: '按平台分（eBay / 非eBay）' },
                  { value: 'custom', label: '固定分类名' },
                ]}
              />
              {subMode === 'platform' && (
                <>
                  <input
                    className="input"
                    style={{ width: 130 }}
                    value={subEbay}
                    onChange={(e) => setSubEbay(e.target.value)}
                    placeholder="eBay"
                  />
                  <input
                    className="input"
                    style={{ width: 130 }}
                    value={subOther}
                    onChange={(e) => setSubOther(e.target.value)}
                    placeholder="非eBay"
                  />
                </>
              )}
              {subMode === 'custom' && (
                <input
                  className="input"
                  style={{ width: 180 }}
                  value={subCustom}
                  onChange={(e) => setSubCustom(e.target.value)}
                  placeholder="例如：白底图"
                />
              )}
            </>
          )}
          <span className="hint">
            将生成：{rootDir.trim() || '输出根目录'}/{dateFolder.trim() || shootDate}
            {subEnabled && subMode === 'platform' ? `/${subEbay || 'eBay'} 或 /${subOther || '非eBay'}` : ''}
            {subEnabled && subMode === 'custom' ? `/${subCustom || '分类'}` : ''}/编码
          </span>
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

      {/* 没有扫描结果，但用户选了「已整理好的文件夹」：直接给报表和文件夹截图 */}
      {!scan && !scanning && !manualDir && (
        <div className="empty">
          <div className="big">
            <IconBarcode size={42} />
          </div>
          <h3>{i18n.t('k0d14616d')}</h3>
          <div className="hint">{i18n.t('k6fb164de')}</div>
          <button
            className="btn"
            style={{ marginTop: 14 }}
            onClick={() => void pickManualReportDir()}
            disabled={!isDesktop}
          >
            <IconFolder /> 已有整理好的文件夹？直接生成 Excel + 文件夹截图
          </button>
        </div>
      )}

      {!scan && manualDir && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <b>直接生成报表</b>
            <span className="hint">
              {manualDir} · {manualFolders.length} 个产品文件夹
            </span>
            <button className="btn sm" onClick={() => void pickManualReportDir()} disabled={applying}>
              重新选择
            </button>
            <button
              className="btn ghost sm"
              onClick={() => {
                setManualDir('');
                setManualFolders([]);
              }}
            >
              清除
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {manualFolders.map((f) => (
              <span
                key={f.name}
                className="hint"
                style={{
                  padding: '2px 8px',
                  border: '1px solid var(--border)',
                  borderRadius: 999,
                  fontFamily: 'ui-monospace, Consolas, monospace',
                }}
              >
                {f.name} · {f.files} 张
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={() => void runReport()} disabled={applying}>
              {applyMode === 'report' ? '生成中…' : '生成 Excel'}
            </button>
            <button className="btn sm" onClick={copyReportTable}>
              复制表格
            </button>
            <button className="btn sm" onClick={() => void copyFolderShot()}>
              复制文件夹截图
            </button>
            <button className="btn sm" onClick={() => downloadFile(omsProductFolderShotUrl(manualDir))}>
              下载文件夹截图
            </button>
          </div>
          {reported && <div className="hint" style={{ marginTop: 8 }}>已生成工作日报-{shootDate}.xlsx</div>}
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

          {/* 手动分组：条码过明过暗识别失败、或自动分组切错时，用户自己勾选图片改归属 */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
              <b style={{ fontSize: 13 }}>手动调整分组</b>
              <span className="hint">
                点下面的产品缩略图勾选（可多选），再选择目标组移入；条码照片本身不参与移动。
              </span>
              <span className="hint" style={{ marginLeft: 'auto' }}>
                已选 {selectedFiles.length} 张
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Select
                style={{ width: 260 }}
                value={moveTarget}
                onChange={setMoveTarget}
                options={[
                  { value: 'ungrouped', label: '未分组（首个条码之前）' },
                  ...scan.groups.map((g, i) => ({
                    value: String(i),
                    label: `#${i + 1} ${edits[i]?.code || g.code || g.barcodeFile || '未命名'}`,
                  })),
                  { value: 'new', label: '＋ 新建分组' },
                ]}
              />
              <button
                className="btn primary sm"
                disabled={!selectedFiles.length}
                onClick={() => {
                  const target =
                    moveTarget === 'ungrouped' || moveTarget === 'new' ? moveTarget : Number(moveTarget);
                  moveSelectedFiles(target);
                }}
              >
                移入所选组
              </button>
              <button
                className="btn sm"
                disabled={!selectedFiles.length}
                onClick={() => moveSelectedFiles('new')}
              >
                新建分组并移入
              </button>
              <button
                className="btn ghost sm"
                disabled={!selectedFiles.length}
                onClick={() => setSelectedFiles([])}
              >
                清空选择
              </button>
              {scan.ungrouped.length > 0 && (
                <button
                  className="btn ghost sm"
                  onClick={() => setSelectedFiles((prev) => [...new Set([...prev, ...scan.ungrouped])])}
                >
                  选中全部未分组
                </button>
              )}
            </div>
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
              selectedFiles={selectedFiles}
              onToggleFile={toggleSelectFile}
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
                {scan.ungrouped.map((f) => {
                  const on = selectedFiles.includes(f);
                  return (
                    <button
                      key={f}
                      type="button"
                      title={on ? '点击取消选择' : '点击选中，再在上方选择目标组'}
                      onClick={() => toggleSelectFile(f)}
                      style={{
                        position: 'relative',
                        width: 64,
                        height: 64,
                        padding: 0,
                        border: on ? '2px solid var(--accent, #4f8cff)' : '1px solid var(--border)',
                        borderRadius: 6,
                        overflow: 'hidden',
                        cursor: 'pointer',
                        background: 'var(--bg2)',
                      }}
                    >
                      <img
                        src={barcodeThumbUrl(scan.dir, f)}
                        alt=""
                        loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                      />
                      {on && (
                        <span
                          style={{
                            position: 'absolute',
                            top: 3,
                            left: 3,
                            width: 18,
                            height: 18,
                            borderRadius: 9,
                            background: 'var(--accent, #4f8cff)',
                            color: '#fff',
                            fontSize: 11,
                            fontWeight: 700,
                            display: 'grid',
                            placeItems: 'center',
                          }}
                        >
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
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
            {/* 九步流程条：做完打勾，当前步骤高亮；点任意步骤可直接跳过去 */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {STEP_DEFS.map((s, i) => {
                const done = stepDone[s.key];
                const active = s.key === currentKey;
                return (
                  <button
                    key={s.key}
                    type="button"
                    title={`跳到「${s.title}」`}
                    onClick={() => setStepOverride(s.key)}
                    style={{
                      padding: '3px 10px',
                      borderRadius: 999,
                      fontSize: 12,
                      cursor: 'pointer',
                      border: `1px solid ${
                        active ? 'var(--accent, #4c8dff)' : done ? 'var(--ok, #3c9d5d)' : 'var(--line)'
                      }`,
                      color: active
                        ? 'var(--accent, #4c8dff)'
                        : done
                          ? 'var(--ok, #3c9d5d)'
                          : 'var(--muted)',
                      background: active ? 'rgba(76, 141, 255, 0.12)' : 'transparent',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {done ? '✓' : i + 1} {s.title}
                  </button>
                );
              })}
              {stepOverride && stepOverride !== autoCurrentKey && (
                <button
                  className="btn ghost sm"
                  onClick={() => setStepOverride(null)}
                  title={`自动步骤是「${STEP_DEFS.find((s) => s.key === autoCurrentKey)?.title || ''}」`}
                >
                  回到当前步骤
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {currentKey === 'scan' && (
                <button className="btn primary" onClick={runScan} disabled={scanning || !srcDir.trim()}>
                  <IconBarcode /> {scanning ? '识别中…' : '开始识别'}
                </button>
              )}

              {currentKey === 'resolve' && (
                <button className="btn primary" onClick={queryOms} disabled={omsQuerying}>
                  {omsQuerying ? '查询中…' : '查询完整编码'}
                </button>
              )}

              {currentKey === 'review' && (
                <span className="hint" style={{ fontWeight: 600, color: 'var(--text)' }}>
                  在上方列表核对 / 修改编码，处理完自动进入下一步
                </span>
              )}

              {currentKey === 'copy' && (
                <>
                  <button
                    className="btn primary"
                    onClick={runSave}
                    disabled={applying || flowIssues.length > 0 || !outputDateDir}
                  >
                    <IconFolder /> {applyMode === 'copy' ? '创建中…' : '创建文件夹'}
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
                </>
              )}

              {currentKey === 'ratio' && (
                <>
                  <button className="btn primary" onClick={runRatio} disabled={applying}>
                    {applyMode === 'ratio' ? '检查中…' : notSquareTotal ? '重新检查 1:1' : '检查 1:1'}
                  </button>
                  <button className="btn" onClick={() => openBatchCrop()} disabled={applying}>
                    打开批量裁切
                  </button>
                  {notSquareTotal > 0 && (
                    <button className="btn" onClick={runCrop} disabled={applying}>
                      {applyMode === 'crop' ? '裁剪中…' : '自动居中裁剪'}
                    </button>
                  )}
                  <span className="hint">
                    eBay 图必须 1:1；「打开批量裁切」可逐张调整裁切框，或一键自动居中裁剪，裁完点「重新检查 1:1」
                  </span>
                </>
              )}

              {currentKey === 'number' && (
                <>
                  <button className="btn" onClick={() => void openNumberPicker()} disabled={applying}>
                    {applyMode === 'number' ? '读取中…' : '选择前五张'}
                  </button>
                  <button className="btn primary" onClick={() => void runNumber()} disabled={applying}>
                    {applyMode === 'number' ? '编号中…' : numbered ? '重新编号' : '开始编号'}
                  </button>
                  <span className="hint">每个产品自己挑前 5 张；不挑就按文件名顺序。</span>
                </>
              )}

              {currentKey === 'import' && (
                <>
                  <button className="btn primary" onClick={runImport} disabled={applying}>
                    {applyMode === 'import' ? '入库中…' : '入库'}
                  </button>
                  <button
                    className="btn ghost"
                    disabled={applying}
                    onClick={() => {
                      setImportSkipped(true);
                      onToast('已跳过入库，可继续下一步', 'info');
                    }}
                  >
                    跳过入库
                  </button>
                </>
              )}

              {currentKey === 'upload' && (
                <>
                  <button className="btn primary" onClick={runUpload} disabled={applying}>
                    {applyMode === 'upload' ? '上传中…' : '上传 OMS'}
                  </button>
                  <button
                    className="btn ghost"
                    disabled={applying}
                    onClick={() => {
                      setUploadSkipped(true);
                      onToast('已跳过上传，可继续下一步', 'info');
                    }}
                  >
                    跳过上传
                  </button>
                </>
              )}

              {currentKey === 'report' && (
                <>
                  <button className="btn primary" onClick={runReport} disabled={applying}>
                    {applyMode === 'report' ? '生成中…' : '生成 Excel'}
                  </button>
                  <button className="btn sm" onClick={copyReportTable}>
                    复制表格
                  </button>
                  <button className="btn sm" onClick={() => void copyFolderShot()}>
                    复制文件夹截图
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => {
                      const shotDir = manualDir || outputDateDir;
                      if (!shotDir) {
                        onToast('请先选择输出根目录，或选择已整理好的文件夹', 'error');
                        return;
                      }
                      downloadFile(omsProductFolderShotUrl(shotDir));
                    }}
                  >
                    下载文件夹截图
                  </button>
                  <button className="btn ghost sm" onClick={() => void pickManualReportDir()} disabled={applying}>
                    选择已整理好的文件夹
                  </button>
                </>
              )}

              {applied && (
                <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => openFolder(applied.dateDir)}>
                  {i18n.t('kc49c4607')}
                </button>
              )}
            </div>

            {currentKey === 'report' && manualDir && (
              <div className="card" style={{ marginTop: 10, marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <b style={{ fontSize: 12.5 }}>已选文件夹</b>
                  <span className="hint">
                    {manualDir} · {manualFolders.length} 个产品文件夹
                  </span>
                  <button
                    className="btn ghost sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => {
                      setManualDir('');
                      setManualFolders([]);
                    }}
                  >
                    清除
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {manualFolders.map((f) => (
                    <span
                      key={f.name}
                      className="hint"
                      style={{
                        padding: '2px 8px',
                        border: '1px solid var(--border)',
                        borderRadius: 999,
                        fontFamily: 'ui-monospace, Consolas, monospace',
                      }}
                    >
                      {f.name} · {f.files} 张
                    </span>
                  ))}
                </div>
              </div>
            )}

            {currentKey === 'number' && pickerOpen && (
              <div
                className="card"
                style={{
                  marginBottom: 12,
                  maxHeight: '70vh',
                  overflowY: 'auto',
                  overscrollBehavior: 'contain',
                }}
                onWheel={(e) => e.stopPropagation()}
              >
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
                  <b>逐个产品选择前五张</b>
                  <span className="hint">按点击顺序编号：第 1 次点的是 1.jpg，第 5 次点的是 5.jpg。</span>
                  <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setPickerOpen(false)}>
                    收起
                  </button>
                </div>
                {outputFolders.map((f) => {
                  const picked = numberPicks[f.folder] || [];
                  return (
                    <div
                      key={f.folder}
                      style={{ borderTop: '1px solid var(--border)', padding: '10px 0 4px' }}
                    >
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
                        <b style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }}>
                          {f.code || '—'}
                        </b>
                        <span className="hint">已选 {picked.length}/5</span>
                        {picked.length > 0 && (
                          <button className="btn ghost sm" onClick={() => setNumberPicks((p) => ({ ...p, [f.folder]: [] }))}>
                            清空这个产品
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(numberFiles[f.folder] || []).map((name) => {
                          const order = picked.indexOf(name);
                          return (
                            <button
                              key={name}
                              type="button"
                              title={name}
                              onClick={() => toggleNumberPick(f.folder, name)}
                              style={{
                                position: 'relative',
                                width: 120,
                                height: 120,
                                padding: 0,
                                border: order >= 0 ? '2px solid var(--accent, #4f8cff)' : '1px solid var(--border)',
                                borderRadius: 10,
                                overflow: 'hidden',
                                cursor: 'pointer',
                                background: 'var(--panel-strong)',
                              }}
                            >
                              <img
                                src={barcodeThumbUrl(f.folder, name, 260)}
                                alt=""
                                loading="lazy"
                                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                              />
                              {order >= 0 && (
                                <span
                                  style={{
                                    position: 'absolute',
                                    top: 4,
                                    left: 4,
                                    minWidth: 22,
                                    height: 22,
                                    borderRadius: 11,
                                    background: 'var(--accent, #4f8cff)',
                                    color: '#fff',
                                    fontSize: 12,
                                    fontWeight: 700,
                                    display: 'grid',
                                    placeItems: 'center',
                                  }}
                                >
                                  {order + 1}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 当前步骤的结果反馈：数量、异常都摆在这里，不用去翻上面的卡片 */}
            <div className="hint" style={{ marginTop: 8 }}>
              {currentKey === 'scan' && '选择源目录后开始：标签照片开组，标签本身不进产品文件夹。'}
              {currentKey === 'resolve' && '用 5 位主 SKU 到中台查「待拍摄」的完整编码；查到会自动回填产品名。'}
              {currentKey === 'review' &&
                (flowIssues.length ? `还有 ${flowIssues.length} 个问题需要处理。` : '编码、产品名、产品图都齐了。')}
              {currentKey === 'copy' && `将复制到：${outputDateDir || '请先选择输出根目录'}`}
              {currentKey === 'ratio' &&
                (ratios
                  ? notSquareTotal
                    ? `有 ${notSquareTotal} 张 eBay 图不是 1:1，必须为正方形。`
                    : ebayFolders.length
                      ? 'eBay 图都是 1:1，可以继续编号。'
                      : '没有 eBay 组，跳过 1:1 检查。'
                  : '创建文件夹后，先检查 eBay 图是否 1:1。')}
              {currentKey === 'number' &&
                (numbered
                  ? `已编号 ${numbered.reduce((n, r) => n + r.files.length, 0)} 张（1.jpg、2.jpg…）`
                  : '逐个产品选前五张，按所选顺序重命名成 1.jpg…；不选则按文件名顺序。')}
              {currentKey === 'import' &&
                (imported
                  ? `已入库 ${imported.importedTotal} 张`
                  : `登记到图库：${activeFolder?.name || activeLibName || '图库根'}`)}
              {currentKey === 'upload' && '核对 OMS 名称后上传；名称不一致会停下等你确认。'}
              {currentKey === 'report' &&
                (manualDir
                  ? `按已选文件夹（${manualFolders.length} 个）生成 工作日报-${shootDate}.xlsx；文件夹截图来自 ${manualDir}。`
                  : `生成 工作日报-${shootDate}.xlsx，时长列留空。`)}
            </div>

            {cropReport && cropReport.some((it) => it.cropped.length) && (
              <div className="hint" style={{ marginTop: 4 }}>
                最近一次裁剪：
                {cropReport
                  .filter((it) => it.cropped.length)
                  .map((it) => `${it.code} ${it.cropped.length} 张`)
                  .join('；')}
              </div>
            )}

            <div className="hint" style={{ marginTop: 4 }}>
              {i18n.t('k168903f9')}：{activeFolder?.name || activeLibName || i18n.t('k1dae2087')} ·{' '}
              {i18n.t('k948019e4')}
            </div>
          </div>
        </>
      )}

      {cropStudioOpen && (
        <BatchCropStudio
          items={cropStudioItems}
          defaultRatio="1:1"
          grouped
          onToast={onToast}
          onClose={() => setCropStudioOpen(false)}
          onDone={() => {
            // 按文件夹保存时裁切台会保持打开：复查比例并刷新分组列表（已裁完的文件夹会消失）
            void checkRatios().then((items) => {
              if ((items || []).some((it) => it.notSquare.length)) openBatchCrop(items);
              else setCropStudioOpen(false);
            });
          }}
        />
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
  /** 手动分组：当前勾选的图片（相对源目录） */
  selectedFiles: string[];
  onToggleFile: (file: string) => void;
}

/** 一个条码组：条码缩略图 + 可编辑编码 + 候选 + 产品缩略图 */
function GroupRow({
  index,
  group,
  dir,
  edit,
  omsBaseUrl,
  onRetryOms,
  onToast,
  onChange,
  selectedFiles,
  onToggleFile,
}: GroupRowProps) {
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
          {group.barcodeFile ? (
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
          ) : (
            <div
              style={{
                ...thumbStyle,
                display: 'grid',
                placeItems: 'center',
                textAlign: 'center',
                fontSize: 12,
                color: 'var(--muted)',
                border: '1px dashed var(--border-strong)',
              }}
            >
              手动分组
              <br />
              无条码照片
            </div>
          )}
          <div className="hint" style={{ marginTop: 4 }}>
            {group.barcodeFile ? `${i18n.t('k48ccc6a5')} · ${i18n.t('kdf093f7d')}` : '手动新建的分组'}
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

          {/* 这一组的全部产品图都展示出来，不再截断 12 张；点图可勾选后手动改分组 */}
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {group.files.map((f) => {
              const on = selectedFiles.includes(f);
              return (
                <button
                  key={f}
                  type="button"
                  title={`${f}${on ? '（已选，点击取消）' : '（点击选中，再在上方选择目标组）'}`}
                  onClick={() => onToggleFile(f)}
                  style={{
                    position: 'relative',
                    width: 56,
                    height: 56,
                    padding: 0,
                    border: on ? '2px solid var(--accent, #4f8cff)' : '1px solid var(--border)',
                    borderRadius: 6,
                    overflow: 'hidden',
                    cursor: 'pointer',
                    background: 'var(--bg2)',
                  }}
                >
                  <img
                    src={barcodeThumbUrl(dir, f)}
                    alt=""
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                  {on && (
                    <span
                      style={{
                        position: 'absolute',
                        top: 2,
                        left: 2,
                        width: 16,
                        height: 16,
                        borderRadius: 8,
                        background: 'var(--accent, #4f8cff)',
                        color: '#fff',
                        fontSize: 10,
                        fontWeight: 700,
                        display: 'grid',
                        placeItems: 'center',
                      }}
                    >
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
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
