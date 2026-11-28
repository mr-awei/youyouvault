import React, { useEffect, useRef, useState } from 'react';
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
  type OmsProductUploadResult,
  type OmsStatus,
} from '../api';
import { IconArrowUpRight, IconBarcode, IconCopy, IconFolder, IconRefresh } from '../components/Icons';
import { getApiToken } from '../api/core';
import { useLicense } from '../app/LicenseGate';
import { buildWorkReportTable } from '../lib/work-report-table';
import { confirmDialog } from '../components/Dialogs';
import { subscribeEvents } from '../events';
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

/**
 * 上传结果 → 列表行状态。
 * 部分图片失败（后端 200 但 failed 非空）也要报出来，否则「已上传 N 张」会让人以为全传完了。
 */
function describeUpload(res: OmsProductUploadResult): { outcome: UploadOutcome; failedParts: number } {
  const failedList = Array.isArray(res.failed) ? res.failed : [];
  const failedParts = failedList.length;
  const parts = [
    res.uploaded > 0 ? `已上传 ${res.uploaded} 张到 OMS` : `后台已有这 ${res.skipped} 张，未重复上传`,
  ];
  if (res.uploaded > 0 && res.skipped) parts.push(`跳过 ${res.skipped} 张已存在`);
  if (failedParts) {
    parts.push(
      `${failedParts} 张失败：${failedList
        .slice(0, 2)
        .map((f) => `${f.file}：${f.error}`)
        .join('；')}`
    );
  }
  return {
    failedParts,
    outcome: {
      state: failedParts ? 'error' : res.uploaded > 0 ? 'uploaded' : 'skipped',
      uploaded: res.uploaded,
      skipped: res.skipped,
      shootCount: res.shootCount,
      message: parts.join('；'),
    },
  };
}

/** 本地日期（不用 toISOString，凌晨 0-8 点会被算成前一天） */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 完整编码形如 45661-Y01Y0001-QD08；只有主 SKU 时没有连字符段 */
const FULL_CODE_RE = /^\d{4,6}(?:-[A-Z0-9]{2,}){2,}$/i;

function isFullCode(code: string) {
  return FULL_CODE_RE.test(String(code || '').trim());
}

/**
 * 平台判定：只看第二段的第 2、3 位，不管开头字母是什么——
 * 02 / 05 是非 eBay，其余（01、10、06、07、99…）一律 eBay，都要做 1:1。
 * 没有第二段（只有主 SKU）也按 eBay 处理。
 */
function platformOf(code: string) {
  const seg = String(code || '').trim().split('-')[1] || '';
  const flag = seg.toUpperCase().slice(1, 3);
  return flag === '02' || flag === '05' ? '非eBay' : 'eBay';
}

/**
 * 编号前是否必须人工定顺序：只有 eBay 要挑 1~5 张主图。
 * 非 eBay 只是归档用，按拍摄顺序自动编号就行，不该被「没选够前五张」卡住整条流程。
 */
function needManualPicks(code: string) {
  return platformOf(code) === 'eBay';
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
  { key: 'ratio', title: '1:1 构图' },
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
  // OMS 登录只有右上角一个入口：这里只读共享状态，登录/退出后自动跟着刷新
  const { status: license } = useLicense();
  const omsLoggedIn = license?.omsLoggedIn === true;
  const [srcDir, setSrcDir] = useState('');
  const [rootDir, setRootDir] = useState('');
  // 默认今天：拍摄日期是必填项，留空会在创建文件夹 / 入库时被后端拒绝
  const [date, setDate] = useState(() => localToday());
  const [scan, setScan] = useState<BarcodeScanResult | null>(null);
  const [edits, setEdits] = useState<GroupEdit[]>([]);
  const [scanning, setScanning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  /** 扫描进度（SSE 推送）：phase = start | filter | ocr | done | cancelled */
  const [scanProgress, setScanProgress] = useState<{
    phase: string;
    done: number;
    total: number;
    elapsedMs: number;
  } | null>(null);
  const scanIdRef = useRef('');
  /** 用户是否手动改过拍摄日期：改过就不再被扫描结果的建议日期覆盖 */
  const dateTouchedRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const [applyMode, setApplyMode] = useState<
    | 'copy'
    | 'import'
    | 'upload'
    | 'manual-upload'
    | 'ratio'
    | 'crop'
    | 'number'
    | 'number-read'
    | 'report'
    | null
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
  /** 上一轮编号 / 入库的失败个数：>0 时该步骤不算完成，别让「一半成功」被当成整批做完 */
  const [numberFailed, setNumberFailed] = useState(0);
  const [importFailed, setImportFailed] = useState(0);
  /** 编号串行锁：state 更新是异步的，连点时只有 ref 拦得住 */
  const numberBusyRef = useRef(false);
  /** 正在读图片清单：读的过程中别急着报「读不到图片」 */
  const [numberReading, setNumberReading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 入库结果 */
  const [imported, setImported] = useState<BarcodeImportResponse | null>(null);
  const [uploadedOk, setUploadedOk] = useState(false);
  const [reported, setReported] = useState(false);
  const [uploads, setUploads] = useState<Record<string, UploadOutcome>>({});
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [oms, setOms] = useState<OmsStatus | null>(null);
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
  /** 直接生成报表 / 上传：用户选一个「包含若干产品文件夹」的目录 */
  const [manualDir, setManualDir] = useState('');
  const [manualFolders, setManualFolders] = useState<{ name: string; files: number }[]>([]);
  /** 手动目录里各 SKU 的 OMS 产品名（生成 Excel / 上传核对用） */
  const [manualNames, setManualNames] = useState<Record<string, string>>({});
  /** 调整图片归属：来源文件夹 / 目标文件夹 / 已选图片 */
  const [moveSrc, setMoveSrc] = useState('');
  const [moveDst, setMoveDst] = useState('');
  const [moveSel, setMoveSel] = useState<string[]>([]);
  const [moving, setMoving] = useState(false);
  /** 第 5 步：复用图库里的批量裁切台，直接裁输出文件夹里还没入库的图 */
  const [cropStudioOpen, setCropStudioOpen] = useState(false);
  const [cropStudioItems, setCropStudioItems] = useState<CropItem[]>([]);
  /** 参与 1:1 检查/裁切的文件夹；默认全选（eBay 必须 1:1），用户可取消勾选跳过 */
  const [ratioInclude, setRatioInclude] = useState<Record<string, boolean>>({});
  /** 输出根目录落在哪个库内部（决定「已在库内就别重复入库」以及入库落位层级） */
  const [rootLib, setRootLib] = useState<{
    inside: { id: number; name: string; active: boolean; relPath: string[] } | null;
  } | null>(null);

  // OMS 后台地址进页面读一次；右上角登录/退出后重读，状态跟着变。
  // 退出登录时直接清空：本地不留上一个账号的任何信息，页面也不会残留「已登录」的痕迹
  useEffect(() => {
    if (!omsLoggedIn) {
      setOms(null);
      return;
    }
    let alive = true;
    api
      .omsStatus()
      .then((s) => {
        if (alive) setOms(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [omsLoggedIn]);

  // 扫描可能持续几十秒（每张条码都要跑一次系统 OCR），给个已耗时让用户知道没卡死
  useEffect(() => {
    if (!scanning) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [scanning]);

  // 扫描进度：后端每处理一批就推一次，界面才有「正在干什么」的反馈
  useEffect(() => {
    const off = subscribeEvents('barcode-scan', (d) => {
      const p = d as { scanId?: string; phase?: string; done?: number; total?: number; elapsedMs?: number };
      if (!p?.scanId || p.scanId !== scanIdRef.current) return;
      setScanProgress({
        phase: String(p.phase || ''),
        done: Number(p.done) || 0,
        total: Number(p.total) || 0,
        elapsedMs: Number(p.elapsedMs) || 0,
      });
    });
    return off;
  }, []);

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

  // 输出根目录是不是某个库（尤其当前库）的内部目录：
  // 是的话图片会被库监听按磁盘层级自动登记，再点「入库」只会多出一条平行文件夹链。
  useEffect(() => {
    const dir = rootDir.trim();
    if (!dir) {
      setRootLib(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api
        .probeLibrary(dir)
        .then((r) => {
          if (alive) setRootLib({ inside: r.inside || null });
        })
        .catch(() => {
          if (alive) setRootLib(null);
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [rootDir]);

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

  /** 取手动目录里各 SKU 的 OMS 产品名；查不到就留空，不阻塞 Excel/上传 */
  const fetchManualNames = async (folders: { name: string }[]) => {
    // 并发 4：几十个文件夹时一次性打满 OMS 既慢又容易被限流
    const out: Record<string, string> = {};
    const queue = [...folders];
    const worker = async () => {
      for (;;) {
        const f = queue.shift();
        if (!f) return;
        try {
          const r = await api.omsProductLookup(f.name);
          if (r.displayName) out[f.name] = r.displayName;
        } catch {
          /* 查不到就留空，不阻塞其它 SKU */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return out;
  };

  // 分隔符跟随用户选的目录：macOS/Linux 上用「\」拼出来的路径在服务端 stat 不到
  const manualFolderPath = (name: string) => {
    const base = manualDir.replace(/[\\/]+$/, '');
    return `${base}${manualDir.includes('\\') ? '\\' : '/'}${name}`;
  };

  /** 重新读已选文件夹：用户在资源管理器里增删/改名后同步列表，别拿旧名字去上传 */
  const refreshManualFolders = async () => {
    if (!manualDir) return;
    try {
      const res = await api.barcodeSubfolders(manualDir);
      setManualFolders(res.folders);
    } catch {
      /* 目录被删 / 无权限：保留旧列表，下一步操作会给明确报错 */
    }
  };

  /** 把选中的图片挪到另一个产品文件夹（放错文件夹时用，入库前调整最稳） */
  const moveImagesTo = async () => {
    if (!moveSrc || !moveDst || !moveSel.length || moving) return;
    setMoving(true);
    try {
      const res = await api.barcodeMoveImages({
        from: manualFolderPath(moveSrc),
        to: manualFolderPath(moveDst),
        files: moveSel,
      });
      setMoveSel([]);
      await refreshManualFolders();
      await ensureNumberFiles().catch(() => {});
      onToast(
        res.errors.length
          ? `已移动 ${res.moved.length} 张到 ${moveDst}，${res.errors.length} 张失败`
          : `已移动 ${res.moved.length} 张到 ${moveDst}`,
        res.errors.length ? 'error' : 'info'
      );
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setMoving(false);
    }
  };

  /** 路径的父目录 / 末级目录名：现成文件夹要当「输出根目录 + 日期文件夹」传给后端入库 */
  const pathParent = (p: string) => {
    const s = p.replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : s;
  };
  const pathBase = (p: string) => {
    const s = p.replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  };

  /**
   * 换了源（重扫 / 重建文件夹 / 换已选文件夹）：后面步骤的结果全部作废。
   * 不清的话步骤条会把上一批文件夹的结果当成这一批的（显示绿勾、自动跳步、数字对不上）。
   */
  const resetDownstream = () => {
    setRatios(null);
    setCropReport(null);
    setNumbered(null);
    setNumberFiles({});
    setNumberPicks({});
    setNumberReading(false);
    setPickerOpen(false);
    setNumberFailed(0);
    setImported(null);
    setImportFailed(0);
    setImportSkipped(false);
    setUploadSkipped(false);
    setUploads({});
    setUploadProgress(null);
    setUploadedOk(false);
    setReported(false);
    // 裁切台是独立弹层，不关掉的话它还挂着上一批的路径，保存会写回已经不存在的目录
    setCropStudioOpen(false);
    setCropStudioItems([]);
  };

  /**
   * 选一个已经整理好的父文件夹（里面是若干 SKU 子文件夹），编号/入库/上传/报表共用。
   * target 传 null 表示不锁步骤：落在第一条还没做的步骤（通常是 1:1 检查），由步骤条自己决定。
   */
  const pickManualReportDir = async (target: StepKey | null = 'report') => {
    const dir = await pickFolder();
    if (!dir) return;
    try {
      const res = await api.barcodeSubfolders(dir);
      if (!res.folders.length) {
        onToast('这个文件夹里没有子文件夹，请选择包含若干产品文件夹的目录', 'error');
        return;
      }
      // 换成另一批文件夹时，编号/入库/上传/报表的旧结果不能带过来
      // （已扫描并建好文件夹时，现成文件夹只用于报表，别动扫描那条线的结果）
      if (!applied && res.dir !== manualDir) resetDownstream();
      setManualDir(res.dir);
      setManualFolders(res.folders);
      setManualNames({});
      setStepOverride(target);
      onToast(`已载入 ${res.folders.length} 个产品文件夹`, 'info');
      // 产品名只用于 Excel/核对，后台慢慢补，失败也不影响主流程
      void fetchManualNames(res.folders)
        .then(setManualNames)
        .catch(() => {});
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
    if (!omsLoggedIn) {
      onToast('还没有登录 OMS：请点右上角头像 →「登录 / 激活授权」，登录后本页自动同步', 'error');
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

  const runScan = async () => {
    if (!srcDir.trim()) {
      onToast(i18n.t('k9dca789e'), 'error');
      return;
    }
    const scanId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    scanIdRef.current = scanId;
    setScanning(true);
    setScanProgress({ phase: 'start', done: 0, total: 0, elapsedMs: 0 });
    setCancelling(false);
    // 上一轮结果先清掉，避免重扫时还显示旧分组
    setScan(null);
    setEdits([]);
    setApplied(null);
    // 重新扫描后下游全部作废，避免拿旧文件夹/旧编号继续走
    resetDownstream();
    setStepOverride(null);
    setSelectedFiles([]);
    setManualDir('');
    setManualFolders([]);
    setManualNames({});
    try {
      const result = await api.barcodeScan(srcDir.trim(), '', scanId);
      setScan(result);
      setEdits(
        result.groups.map((g) => ({
          code: g.code,
          skip: false,
          // 完整编码也能反推主 SKU 前缀，后续重新查询 OMS 不用再手填
          mainSku: g.code.trim().match(/^(\d{4,6})/)?.[1] || '',
        }))
      );
      // 日期默认是「今天」，但扫描结果带的是照片 EXIF 拍摄日期：隔天早上处理昨晚的素材时，
      // 不跟着改就会把文件夹和日报放进错误的日期。用户手动改过日期就尊重用户的选择。
      if (!dateTouchedRef.current && result.date) setDate(result.date);
      setDateFolder((prev) => prev || result.date);
      if (!result.groups.length) onToast(i18n.t('k07190065'));
      // 已配置 OMS 时顺手换成完整编码并补产品名（只取「待拍摄」）
      if (omsLoggedIn) {
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
      const msg = (err as Error).message || '';
      // 用户点了「停止扫描」：后端返回 499，不是错误
      if (/已取消|cancel/i.test(msg) || /499/.test(msg)) onToast('已停止扫描', 'info');
      else onToast(`${i18n.t('k5ec14542')}：${msg}`, 'error');
    } finally {
      setScanning(false);
      setScanProgress(null);
      scanIdRef.current = '';
    }
  };

  /** 停止扫描：通知后端在下一张图前退出 */
  const cancelScan = async () => {
    const id = scanIdRef.current;
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await api.barcodeScanCancel(id);
    } catch {
      onToast('停止请求没发出去，稍等一下再试', 'error');
    } finally {
      setCancelling(false);
    }
  };

  /** 未扫描时：直接把「父文件夹 → 若干 SKU 子文件夹」上传到 OMS */
  const runManualUpload = async () => {
    if (!manualDir || !manualFolders.length) {
      onToast('请先选择一个包含若干 SKU 子文件夹的父文件夹', 'error');
      return;
    }
    // 上传前补齐 OMS 产品名：后端拿它做名称核对，传空名字会被直接拒掉
    let names = manualNames;
    const missingNames = manualFolders.filter((f) => !names[f.name]);
    if (missingNames.length) {
      try {
        names = { ...names, ...(await fetchManualNames(missingNames)) };
        setManualNames(names);
      } catch {
        /* 查不到名字就按空名字交给后端：跳过核对，仍然上传 */
      }
    }
    setApplyMode('manual-upload');
    setUploads({});
    setUploadProgress({ done: 0, total: manualFolders.length });
    let done = 0;
    let uploadedTotal = 0;
    let failed = 0;
    try {
      for (const f of manualFolders) {
        const folder = manualFolderPath(f.name);
        setUploads((prev) => ({
          ...prev,
          [folder]: { state: 'uploading', uploaded: 0, skipped: 0, shootCount: 0, message: '正在上传…' },
        }));
        try {
          const res = await api.omsProductUpload({
            sku: f.name,
            dir: folder,
            expectedName: names[f.name] || '',
          });
          const { outcome, failedParts } = describeUpload(res);
          uploadedTotal += res.uploaded;
          // 部分图片没传上去也算这个 SKU 没完成：留着红行，再点一次会只补缺失的
          if (failedParts) failed += 1;
          if (res.displayName) {
            setManualNames((prev) => (prev[f.name] ? prev : { ...prev, [f.name]: res.displayName }));
          }
          setUploads((prev) => ({ ...prev, [folder]: outcome }));
        } catch (err) {
          failed += 1;
          const e = err as Error & { code?: string };
          setUploads((prev) => ({
            ...prev,
            [folder]: {
              state: e.code === 'name_mismatch' ? 'mismatch' : 'error',
              uploaded: 0,
              skipped: 0,
              shootCount: 0,
              message: e.message,
            },
          }));
        } finally {
          done += 1;
          setUploadProgress({ done, total: manualFolders.length });
        }
      }
      setUploadedOk(failed === 0);
      onToast(
        failed
          ? `已上传 ${uploadedTotal} 张；${failed} 个 SKU 没全部传上去，详情见列表`
          : `已上传 ${uploadedTotal} 张到 OMS`,
        failed ? 'error' : 'info'
      );
    } finally {
      setApplyMode(null);
      // 不收尾的话，下一次编号/入库会把上次的「18/18 · 100%」当成自己的进度
      setUploadProgress(null);
    }
  };

  /**
   * 保存后自动核对 OMS 名称并上传：名称一致才传，不一致写红色状态并停止该 SKU。
   * 不弹二次确认；用户点主按钮「保存 / 入库 / 上传」即视为同意这一步。
   */
  const uploadAppliedGroups = async (result: BarcodeApplyResponse) => {
    // 同编码的多个分组会落到同一个文件夹：只传一次，否则第二次会把第一次的上传结果覆盖成「后台已有」
    const byFolder = new Map<string, BarcodeApplyResponse['results'][number]>();
    for (const r of result.results) {
      if (!r.folder) continue;
      const key = r.folder.toLowerCase();
      const prev = byFolder.get(key);
      const name = String(edits[r.sourceIndex]?.productName || '').trim();
      const prevName = prev ? String(edits[prev.sourceIndex]?.productName || '').trim() : '';
      // 优先保留填了产品名的那一组（上传前要拿它核对后台名称）
      if (!prev || (!prevName && name)) byFolder.set(key, r);
    }
    const pending = [...byFolder.values()];
    setUploads({});
    setUploadProgress({ done: 0, total: pending.length });
    let uploadedTotal = 0;
    let mismatch = 0;
    let failed = 0;
    let done = 0;
    for (const r of pending) {
      const idx = r.sourceIndex;
      const edit = edits[idx];
      const group = scan?.groups[idx];
      // 兜底用文件夹名（复制时就按编码命名），别因为内存里的分组丢了就判「缺编码」
      const code = String(edit?.code || group?.code || r.code || '').trim();
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
        // 没填产品名也照传：后端会退回 OMS 后台名称，只在两边都能拿到名字时才核对
        const res = await api.omsProductUpload({
          sku: code,
          dir: r.folder,
          expectedName,
        });
        const { outcome, failedParts } = describeUpload(res);
        uploadedTotal += res.uploaded;
        if (failedParts) failed += 1;
        setUploads((prev) => ({ ...prev, [r.folder]: outcome }));
      } catch (err) {
        const e = err as Error & { code?: string };
        const isMismatch = e.code === 'name_mismatch';
        if (isMismatch) mismatch += 1;
        else failed += 1;
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
    return { uploadedTotal, mismatch, failed };
  };

  /**
   * 待补项：只是提示，不挡后续步骤（产品名可以到上传前再补）。
   * codeIssues 才是真缺资料——没编码 / 没产品图，创建文件夹这一步做不了。
   */
  const flowIssues: string[] = [];
  const codeIssues: string[] = [];
  if (scan) {
    scan.groups.forEach((g, i) => {
      const edit = edits[i];
      if (edit?.skip) return;
      const code = (edit?.code ?? g.code ?? '').trim();
      const full = isFullCode(code);
      if (!code) {
        flowIssues.push(`#${i + 1} 没有编码`);
        codeIssues.push(`#${i + 1} 没有编码`);
      } else if (!full) {
        flowIssues.push(`#${i + 1} 未选完整编码（当前 ${code}）`);
        codeIssues.push(`#${i + 1} 未选完整编码（当前 ${code}）`);
      }
      if (!String(edit?.productName || '').trim()) flowIssues.push(`#${i + 1} 产品名为空`);
      if (!g.files.length) {
        flowIssues.push(`#${i + 1} 没有产品图`);
        codeIssues.push(`#${i + 1} 没有产品图`);
      }
      if (!full && (edit?.omsState === 'empty' || edit?.omsState === 'error')) {
        flowIssues.push(`#${i + 1} OMS 没查到完整编码 / 查询失败`);
        codeIssues.push(`#${i + 1} OMS 没查到完整编码 / 查询失败`);
      }
      if (!full && edit?.omsState === 'multiple') {
        flowIssues.push(`#${i + 1} 有多个候选未选择完整编码`);
        codeIssues.push(`#${i + 1} 有多个候选未选择完整编码`);
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

  /** 已复制出来的编码文件夹：后续检查 / 编号 / 入库 / 上传都围绕它们；没扫描时用现成文件夹顶上 */
  const outputFolders = applied
    ? // 同编码会合并到同一个文件夹：按 folder 去重，优先保留填了产品名的那一组（入库要写标签）
      [
        ...applied.results
          .filter((r) => r.folder)
          .reduce(
            (map, r) => {
              const prev = map.get(r.folder);
              const name = String(edits[r.sourceIndex]?.productName || '').trim();
              const prevName = prev ? String(edits[prev.sourceIndex]?.productName || '').trim() : '';
              if (!prev || (!prevName && name)) {
                map.set(r.folder, {
                  sourceIndex: r.sourceIndex,
                  code: r.code,
                  folder: r.folder,
                  subfolder: r.subfolder || '',
                });
              }
              return map;
            },
            new Map<
              string,
              { sourceIndex: number; code: string; folder: string; subfolder: string }
            >()
          )
          .values(),
      ]
    : manualFolders.map((f, i) => ({
        sourceIndex: i,
        code: f.name,
        folder: manualFolderPath(f.name),
        subfolder: '',
      }));

  /**
   * 分组号 → 实际输出文件夹。同编码会合并到同一个文件夹，outputFolders 按文件夹去重后
   * 只剩最后一组的 sourceIndex，前面的组就找不到自己的文件夹（编号步骤会退化成普通分组行）。
   */
  const folderBySourceIndex = new Map(
    (applied?.results || []).filter((r) => r.folder).map((r) => [r.sourceIndex, r.folder])
  );

  /** 第 4 步：创建本地文件夹（只复制，不移动原图） */
  const runSave = async () => {
    if (!scan) return;
    // 只卡缺编码 / 没产品图；产品名留到上传前补，不挡建文件夹
    if (codeIssues.length) {
      onToast(`还有 ${codeIssues.length} 个组缺编码或产品图，补齐后才能创建文件夹`, 'error');
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
        // 日期没填就按今天：后端要求 YYYY-MM-DD，别让用户因为空日期卡在报错上
        date: date || localToday(),
        dateFolder: dateFolder.trim() || date || localToday(),
        groups,
        importToLibrary: false,
        cleanStale,
      });
      setApplied(result);
      setStepOverride(null);
      // 文件夹重建后，后面的检查结果全部作废
      resetDownstream();
      // 逐个文件的失败（被占用、权限、源文件被移走）必须说出来，否则「已创建」会让人以为都复制好了。
      // 提示条只有一个槽位：这里只能发一条，别让后一条把带明细的前一条顶掉。
      const copyErrors = result.results.flatMap((r) => r.errors);
      const cleanErrors = result.results.flatMap((r) => r.cleanErrors || []);
      const failedFiles = copyErrors.length + cleanErrors.length;
      const copiedMsg = i18n.t('k2827af98', { p0: result.totalCopied, p1: result.dateDir });
      if (failedFiles) {
        const sample = copyErrors
          .concat(cleanErrors)
          .slice(0, 3)
          .map((e) => `${e.file || '——'}：${e.error}`)
          .join('；');
        onToast(
          `${copiedMsg}；但有 ${failedFiles} 个文件没处理成功（${sample}${
            failedFiles > 3 ? ' 等' : ''
          }），先核对再继续`,
          'error'
        );
      } else {
        onToast(`${copiedMsg}；下一步检查图片是否 1:1`);
      }
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
            // 静默刷新：提示条已被「已复制 N 张…」占用，别把它顶掉
            onLibraryChanged();
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

  /** 文件夹变化后重置勾选：默认 eBay，用户手动改过的保留；现成文件夹没有平台信息，全部勾上 */
  useEffect(() => {
    setRatioInclude((prev) => {
      const next: Record<string, boolean> = {};
      for (const f of outputFolders) {
        next[f.folder] = prev[f.folder] ?? (applied ? platformOf(f.code) === 'eBay' : true);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, manualDir]);

  /**
   * 第 5 步：检查 1:1。默认只查 eBay 组，用户可勾选其它文件夹一起查；
   * 现成文件夹没有平台信息，默认全部参与。勾选框必须真的生效，否则就是个点了没反应的摆设。
   */
  const ebayFolders = outputFolders.filter(
    (f) => ratioInclude[f.folder] ?? (applied ? platformOf(f.code) === 'eBay' : true)
  );
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

  // 参与检查的文件夹一变，上一次的结果就不完整了：清掉重查，
  // 否则新勾选的文件夹没查过，步骤条却已经算「1:1 全部通过」。
  const ratioKey = ebayFolders
    .map((f) => f.folder.toLowerCase())
    .sort()
    .join('|');
  useEffect(() => {
    setRatios(null);
  }, [ratioKey]);

  const runRatio = async () => {
    setApplyMode('ratio');
    try {
      const items = await checkRatios();
      if (!items) return;
      if (!items.length) {
        onToast('还没有可检查的文件夹：先创建产品文件夹，或选一个已整理好的文件夹', 'error');
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
          `有 ${bad} 张图不是 1:1 或读不到尺寸：${detail}${items.filter((it) => it.notSquare.length).length > 3 ? ' 等' : ''}。已打开批量裁切台，可逐张调整；也可点「自动居中裁剪」一键处理（HEIC 会自动转成 jpg）。`,
          'error'
        );
        // 检查出不合格图片就自动打开裁切台；已经开着时不要重复弹
        if (!cropStudioOpen) void openBatchCrop(items);
      } else {
        onToast(
          applied
            ? `检查完成：所选 ${items.length} 个文件夹里都是 1:1；未勾选的文件夹不参与检查，可展开「参与检查的文件夹」勾选。`
            : `检查完成：所选 ${items.length} 个文件夹里都是 1:1。`
        );
      }
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
      // 用户可能是点了步骤条「回到构图」才停在这里的；检查完就交还给自动流程，
      // 否则即使已经全部 1:1，currentKey 仍被 override 钉在构图，看起来像卡死。
      setStepOverride(null);
    }
  };

  /**
   * 第 5 步：打开项目已有的批量裁切台。
   * 这里的图片还在输出文件夹里、没有图库 id，所以给裁切台传 dir + file，
   * 裁切台会走 /api/barcode/crop-rects 原地覆盖，而不是图库任务。
   */
  const openBatchCrop = async (source: BarcodeRatioItemResult[] | null = null) => {
    // 自动打开时 ratios 的 setState 还没生效，直接传刚查到的结果，避免拿到旧值
    let list = source || ratios;
    if (!list) {
      // 直接从别的步骤跳过来点「调整构图」：自动先查一遍，别让用户被提示挡回去
      try {
        list = await checkRatios();
      } catch (err) {
        onToast((err as Error).message, 'error');
        return;
      }
    }
    const bad = (list || []).filter((it) => it.notSquare.length);
    if (!bad.length) {
      onToast(list ? '没有需要裁剪的图片，全部已经是 1:1' : '还没有可检查的文件夹，请先创建产品文件夹', 'error');
      return;
    }
    const items: CropItem[] = [];
    let syntheticId = -1;
    for (const r of bad) {
      for (const f of r.notSquare) {
        // 读不到尺寸的图没有可用比例，扔进裁切台只会显示成 0×0 的坏框；
        // 这类图要在资源管理器里手动处理（HEIC 走「自动居中裁剪」可解码后裁）
        if (f.unknown || !f.width || !f.height) continue;
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
    // 直接从别的步骤跳过来时还没检查过：先自动查一遍，别用「请先点检查 1:1」挡住用户
    let list = ratios;
    if (!list) {
      try {
        list = await checkRatios();
      } catch (err) {
        onToast((err as Error).message, 'error');
        return;
      }
    }
    const bad = (list || []).filter((it) => it.notSquare.length);
    if (!bad.length) {
      onToast(list ? '没有需要裁剪的图片，全部已经是 1:1' : '还没有可检查的文件夹，请先创建产品文件夹', 'error');
      return;
    }
    setApplyMode('crop');
    try {
      const res = await api.barcodeCrop(
        bad.map((it) => ({ code: it.code, dir: it.dir, files: it.notSquare.map((f) => f.file) }))
      );
      setCropReport(res.items);
      const cropped = res.items.reduce((n, it) => n + it.cropped.length, 0);
      const failedItems = res.items.flatMap((it) => it.errors);
      // 裁完再核一次，确认真的都是 1:1
      const after = await checkRatios();
      const stillBad = (after || []).reduce((n, it) => n + it.notSquare.length, 0);
      onToast(
        failedItems.length || stillBad
          ? `已裁剪 ${cropped} 张；${failedItems.length} 张写入失败${stillBad ? `，复查仍有 ${stillBad} 张非 1:1` : ''}：${failedItems
              .slice(0, 3)
              .map((e) => `${e.file}：${e.error}`)
              .join('；')}`
          : `已裁剪 ${cropped} 张，全部为 1:1`,
        failedItems.length || stillBad ? 'error' : 'info'
      );
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
      setStepOverride(null);
    }
  };

  /** 只保留磁盘上仍然存在的选择：编号后文件名变成 1.jpg…，旧名字已经失效 */
  const sanitizePicks = (prev: Record<string, string[]>, files: Record<string, string[]>) => {
    const next: Record<string, string[]> = {};
    for (const [dir, list] of Object.entries(files)) {
      // 不自动预选：eBay 由用户自己点顺序；非 eBay 留空即按拍摄顺序自动编号
      next[dir] = (prev[dir] || []).filter((n) => list.includes(n)).slice(0, 5);
    }
    return next;
  };

  /**
   * 读取每个产品文件夹的图片并初始化前五张。
   * 编号步骤的产品图行和「选择前五张」面板共用这份数据与选择顺序。
   * 返回清单本身，方便调用方在同一次点击里拿到最新值（setState 还没生效）。
   * 单个文件夹读失败（被改名/删除）按空处理：别让一个坏文件夹卡住整步编号。
   */
  const ensureNumberFiles = async (): Promise<{
    files: Record<string, string[]>;
    failed: string[];
  }> => {
    if (!outputFolders.length) return { files: {}, failed: [] };
    setNumberReading(true);
    try {
      const settled = await Promise.all(
        outputFolders.map(async (f) => {
          try {
            const r = await api.barcodeFolderImages(f.folder);
            return { dir: f.folder, files: r.files, error: '' };
          } catch (err) {
            return { dir: f.folder, files: [] as string[], error: (err as Error).message };
          }
        })
      );
      const files = Object.fromEntries(settled.map((s) => [s.dir, s.files]));
      setNumberFiles(files);
      setNumberPicks((prev) => sanitizePicks(prev, files));
      return { files, failed: settled.filter((s) => s.error).map((s) => s.dir) };
    } finally {
      setNumberReading(false);
    }
  };

  /** 第 6 步：图片编号，编号直接作为最终文件名 */
  const openNumberPicker = async () => {
    if (!outputFolders.length) {
      onToast('还没有创建文件夹', 'error');
      return;
    }
    // 单独的读取态：否则「开始编号」按钮会跟着显示「编号中…」，看起来像已经在编号
    setApplyMode('number-read');
    try {
      const { failed } = await ensureNumberFiles();
      if (failed.length) {
        onToast(`${failed.length} 个文件夹读不到图片（可能被改名或删除），已跳过`, 'error');
      }
      setPickerOpen(true);
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
  const runNumberFlow = async () => {
    if (!outputFolders.length) {
      onToast('还没有创建文件夹', 'error');
      return;
    }
    // 每次编号前都重读一遍清单：用户可能刚在资源管理器里改名/删图，
    // 拿旧清单去编号会让选中的文件名对不上磁盘，最后按拍摄顺序乱编。
    // 读盘这几秒也要锁住按钮，否则连点两次会对同一批文件并发改名。
    setApplyMode('number-read');
    let read: Awaited<ReturnType<typeof ensureNumberFiles>>;
    try {
      read = await ensureNumberFiles();
    } catch (err) {
      onToast((err as Error).message, 'error');
      return;
    } finally {
      setApplyMode(null);
    }
    const { files, failed: unreadable } = read;
    // 空文件夹编号什么也不会发生：直接跳过，别让它混进「已编号」
    const targets = outputFolders.filter((f) => (files[f.folder] || []).length > 0);
    if (!targets.length) {
      onToast(
        unreadable.length
          ? `有 ${unreadable.length} 个文件夹读不到图片（可能被改名或删除），先在资源管理器里确认一下`
          : '产品文件夹里都没有图片，先在资源管理器里确认文件夹是否被改名或删除',
        'error'
      );
      return;
    }
    // 以刚读到的清单为准过滤选择：清空过清单时，state 里的旧选择已经对不上磁盘
    const picksMap = sanitizePicks(numberPicks, files);
    const folders = targets.map((f) => ({
      code: f.code,
      dir: f.folder,
      files: picksMap[f.folder]?.length ? picksMap[f.folder] : undefined,
    }));
    // eBay 的 1~5 张主图必须由用户自己定顺序，没选够就不编号，避免按拍摄顺序乱编；
    // 非 eBay 不强制：没手选就交给后端按拍摄顺序自动编号
    const unfilled = targets.filter((f) => {
      if (!needManualPicks(f.code)) return false;
      const list = files[f.folder] || [];
      return (picksMap[f.folder] || []).length < Math.min(5, list.length);
    });
    if (unfilled.length) {
      onToast(
        `还有 ${unfilled.length} 个 eBay 文件夹没选够前五张（${unfilled
          .slice(0, 3)
          .map((f) => f.code)
          .join('、')}${unfilled.length > 3 ? ' 等' : ''}），先点缩略图选好再编号；非 eBay 会自动编号`,
        'error'
      );
      return;
    }
    // 图库记录存的是绝对路径：已经入库再改名，旧记录就指向不存在的文件了
    if (imported) {
      const ok = await confirmDialog(
        '这批图片已经入库。重新编号会把文件名改成 1.jpg…，图库里的旧记录会指向不存在的文件，之后需要重新入库。确认继续？'
      );
      if (!ok) return;
    }
    setApplyMode('number');
    try {
      const res = await api.barcodeNumber(folders);
      setNumbered(res.results);
      setPickerOpen(false);
      // 编号后磁盘上已经是 1.jpg…：用后端返回的清单回填。直接清空会让缩略图全部空掉
      // （现成文件夹模式还会误报「读不到图片」），重新编号也只能拿着失效的旧文件名去选。
      const byDir = new Map(res.results.map((r) => [r.dir.toLowerCase(), r.files]));
      const byBase = new Map(res.results.map((r) => [pathBase(r.dir).toLowerCase(), r.files]));
      const nextFiles: Record<string, string[]> = {};
      const nextPicks: Record<string, string[]> = {};
      for (const f of outputFolders) {
        const list =
          byDir.get(f.folder.toLowerCase()) ?? byBase.get(pathBase(f.folder).toLowerCase()) ?? [];
        nextFiles[f.folder] = list;
        // 现在的 1.jpg…5.jpg 就是用户刚选的顺序，回填成「已选」：再点「重新编号」不会白跑
        nextPicks[f.folder] = list.slice(0, 5);
      }
      setNumberFiles(nextFiles);
      setNumberPicks(nextPicks);
      setImported(null);
      setImportSkipped(false);
      setUploadSkipped(false);
      setUploadedOk(false);
      setReported(false);
      const total = res.results.reduce((n, r) => n + r.files.length, 0);
      const failed = res.results.reduce((n, r) => n + r.errors.length, 0);
      // 有失败就不算「编号完成」：步骤条保持未完成，用户能看见并重试，
      // 否则一半目录还是原文件名，后面入库/上传会按错的顺序走
      setNumberFailed(failed);
      const skipped = outputFolders.length - targets.length;
      const skippedNote = skipped
        ? `；跳过 ${skipped} 个空文件夹${unreadable.length ? `（其中 ${unreadable.length} 个读不到）` : ''}`
        : '';
      onToast(
        failed
          ? `编号完成：${total} 张，${failed} 个文件夹出错${skippedNote}`
          : `编号完成：${res.results.length} 个文件夹，共 ${total} 张（1.jpg、2.jpg…）${skippedNote}`,
        failed ? 'error' : 'info'
      );
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setApplyMode(null);
    }
  };

  /**
   * 编号入口：整段串行化。applyMode 是 state，同一帧里连点两次照样都能进，
   * 一旦并发就是两轮 rename 交叉改同一批文件（顺序错乱甚至丢图）。
   */
  const runNumber = async () => {
    if (numberBusyRef.current) return;
    numberBusyRef.current = true;
    try {
      await runNumberFlow();
    } finally {
      numberBusyRef.current = false;
    }
  };

  /** 第 7 步：把已编号的文件夹登记进图库（扫描建的文件夹、现成文件夹都支持） */
  const runImport = async () => {
    if (!scan && !manualDir) return;
    setImportSkipped(false);
    if (!outputFolders.length) {
      onToast('还没有可入库的文件夹', 'error');
      return;
    }
    // 缺完整编码就停下：入库会把文件夹名当编码写进图库，带着错的编码进去很难改
    if (missingCodeSkus.length) {
      onToast(
        `有 ${missingCodeSkus.length} 个 SKU 缺完整编码（${missingCodeSkus.slice(0, 3).join('、')}${
          missingCodeSkus.length > 3 ? ' 等' : ''
        }），补齐后才能入库`,
        'error'
      );
      return;
    }
    // 不检查「是否已编号」：文件夹可能上一轮就编过号（甚至是在资源管理器里手工改的），
    // 入库只负责把现有文件登记进图库，随时可以直接跑
    const groups = outputFolders.map((f) => {
      const edit = edits[f.sourceIndex];
      const code = String(edit?.code || f.code || '').trim();
      return {
        code,
        folder: f.folder,
        subfolder: f.subfolder,
        productName: edit?.productName || manualNames[f.code] || '',
        mainSku: edit?.mainSku || code.match(/^(\d{4,6})/)?.[1] || '',
      };
    });
    // 现成文件夹没有「输出根目录/日期」这两层：把它的父目录当根、它本身当日期文件夹，
    // 后端只允许入库这两层下面的文件夹，传别的会被拒。
    const importRoot = scan ? rootDir.trim() : pathParent(manualDir);
    const importDateFolder = scan ? dateFolder.trim() || date : pathBase(manualDir);
    setApplyMode('import');
    try {
      const result = await api.barcodeImport({
        root: importRoot,
        date: date || localToday(),
        dateFolder: importDateFolder || date || localToday(),
        parentFolderId: folderId,
        groups,
      });
      setImported(result);
      // 现成文件夹模式没有「构图」这条自动路径，清掉 override 会被拉回构图；停在本步点「下一步」
      if (scan) setStepOverride(null);
      setUploadedOk(false);
      setReported(false);
      onLibraryChanged();
      const failed = result.results.reduce((n, r) => n + r.importErrors.length, 0);
      // 部分失败同样不算完成：缺的图后面没人会补，步骤条绿了就等于在骗人
      setImportFailed(failed);
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
    // 未登录就逐个 SKU 报同一句错：登录入口只保留右上角，这里只提示
    if (!omsLoggedIn) {
      onToast('还没有登录 OMS：请点右上角头像 →「登录 / 激活授权」，登录后本页自动同步', 'error');
      return;
    }
    // 缺完整编码就不开传：宁可停下，也别传一半留下脏数据（现成文件夹同样检查）
    if (missingCodeSkus.length) {
      onToast(
        `有 ${missingCodeSkus.length} 个 SKU 缺完整编码（${missingCodeSkus.slice(0, 3).join('、')}${
          missingCodeSkus.length > 3 ? ' 等' : ''
        }），补齐后才能上传`,
        'error'
      );
      return;
    }
    // 没扫描时只面对现成文件夹：直接按 SKU 文件夹名上传，没有产品名可比对
    if (!scan) {
      if (!manualDir || !manualFolders.length) {
        onToast('还没有可上传的文件夹', 'error');
        return;
      }
      await runManualUpload();
      return;
    }
    setUploadSkipped(false);
    // 上传只依赖「有文件夹 + 编码」：不要求先入库，也不因为别的步骤有警告就卡住
    if (!applied) {
      if (manualDir && manualFolders.length) {
        await runManualUpload();
        return;
      }
      onToast('还没有可上传的文件夹', 'error');
      return;
    }
    setApplyMode('upload');
    try {
      const up = await uploadAppliedGroups(applied);
      setUploadedOk(up.mismatch === 0 && up.failed === 0);
      const summary = [`已上传 ${up.uploadedTotal} 张到 OMS`];
      if (up.mismatch) summary.push(`${up.mismatch} 个 SKU 名称不一致`);
      if (up.failed) summary.push(`${up.failed} 个 SKU 没全部传上去，详情见列表`);
      onToast(summary.join('；'), up.mismatch || up.failed ? 'error' : 'info');
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
    const url = omsProductFolderShotUrl(shotDir, manualDir ? 1 : shotDepth);
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
      let rows = reportRows;
      // 手动选父文件夹时，报表里的品名来自 OMS；缺的现场补一次
      if (!scan && manualDir && manualFolders.length) {
        const missing = manualFolders.filter((f) => !manualNames[f.name]);
        let names = manualNames;
        if (missing.length) {
          const extra = await fetchManualNames(missing);
          names = { ...manualNames, ...extra };
          setManualNames(names);
        }
        rows = manualFolders.map((f) => ({
          sku: f.name,
          name: names[f.name] || '',
          platform: platformOf(f.name),
          category: '产品/视频拍摄',
        }));
      }
      const blob = await api.omsProductReport({ date: shootDate, rows });
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
        name: manualNames[f.name] || '',
        platform: platformOf(f.name),
        category: '产品/视频拍摄',
      }))
    : [];
  /** 既没扫描也没手动选文件夹时，用输出目录里已经建好的文件夹兜底：报表这一步随时能出 */
  const folderReportRows = outputFolders.map((f) => ({
    sku: f.code,
    name: manualNames[f.code] || '',
    platform: platformOf(f.code),
    category: '产品/视频拍摄',
  }));
  const reportRows = manualReportRows.length
    ? manualReportRows
    : scanReportRows.length
      ? scanReportRows
      : folderReportRows;
  // 两批并存：第 4 步已经建好一批（编号/入库/上传都走它），报表又选了另一批。
  // 这是有意保留的能力（报表可能报另一批的工时），但必须明确提示，否则两份成果对不上还没人知道。
  const reportMixedSources = !!applied && manualReportRows.length > 0;

  // 清空日期输入时别退回 UTC：本地 0~8 点在 toISOString 里还是前一天
  const shootDate = date || localToday();
  const outputDateDir =
    applied?.dateDir ||
    (rootDir.trim()
      ? `${rootDir.trim().replace(/[\\/]+$/, '')}${rootDir.includes('\\') ? '\\' : '/'}${
          dateFolder.trim() || shootDate
        }`
      : '');
  /** 文件夹截图要列到 SKU 层：开了「日期下一级分类」时 SKU 在日期下面第二层 */
  const shotDepth =
    applied && outputFolders.some((f) => f.folder.slice(applied.dateDir.length).split(/[\\/]/).filter(Boolean).length > 1)
      ? 2
      : 1;
  /** 输出目录就在当前库内：图片由库监听自动登记，再入库会多出一条平行文件夹链 */
  const insideActiveLib = !!rootLib?.inside?.active;
  /** 库内入库时实际会落到的层级（11月 / 20261127） */
  const importTargetPath = [...(rootLib?.inside?.relPath || []), dateFolder.trim() || shootDate];
  // 已经在当前库里就默认跳过入库（保留「仍要入库」给监听没跑起来的情况）
  useEffect(() => {
    if (applied && insideActiveLib) setImportSkipped(true);
  }, [applied, insideActiveLib]);

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
    // 核对只看「能不能建文件夹」：缺编码 / 没产品图才算没做完，产品名不挡
    review: !!scan && scan.groups.length > 0 && codeIssues.length === 0,
    copy: outputFolders.length > 0,
    // 有不是 1:1 的图就停在这一步：用户手动裁完再检查一次即可继续
    // 没有 eBay 组时这一步无事可做，直接算完成，别让用户卡在「检查 1:1」
    ratio: !ebayFolders.length || (!!ratios && ratios.every((it) => it.notSquare.length === 0)),
    // 有失败不算完成：编号/入库里任何一张出错，都要停在原步让用户处理
    number: !!numbered && numberFailed === 0,
    import: (!!imported && importFailed === 0) || importSkipped,
    upload: uploadedOk || uploadSkipped,
    report: reported,
  };
  // 没扫描、直接用现成文件夹时，前 4 步（识别/查询/核对/创建）本来就不用做，自动步骤从「构图」往后找，
  // 否则一旦清掉 stepOverride 就会被拉回「识别主 SKU」看空白。
  const SKIPPED_WHEN_MANUAL: StepKey[] = ['scan', 'resolve', 'review', 'copy'];
  const autoCurrentKey: StepKey =
    STEP_DEFS.find((s) => !stepDone[s.key] && (scan || !SKIPPED_WHEN_MANUAL.includes(s.key)))?.key ??
    'report';
  // 扫描中（或还没任何数据）一律停在第一步：否则会自动跳到「图片编号」，看起来像流程跑偏了
  const currentKey: StepKey =
    scanning || (!scan && !manualDir) ? 'scan' : (stepOverride ?? autoCurrentKey);
  const notSquareTotal = (ratios || []).reduce((n, it) => n + it.notSquare.length, 0);
  const scanPct =
    scanProgress && scanProgress.total > 0
      ? Math.min(100, Math.round((scanProgress.done / scanProgress.total) * 100))
      : 0;

  /** 每个批量操作的进度文案；上传有真实的 done/total，其余接口一次调用完，只能给滚动条 */
  const RUN_LABELS: Record<string, string> = {
    copy: '正在创建文件夹并复制图片…',
    ratio: '正在检查 1:1…',
    crop: '正在裁剪图片…',
    number: '正在按顺序编号…',
    'number-read': '正在读取文件夹图片…',
    import: '正在登记到图库…',
    upload: '正在核对名称并上传 OMS…',
    'manual-upload': '正在核对名称并上传 OMS…',
    report: '正在生成 Excel / 文件夹截图…',
  };
  const runText = omsQuerying
    ? '正在查询完整编码…'
    : moving
      ? '正在移动图片…'
      : applyMode
        ? RUN_LABELS[applyMode] || '处理中…'
        : '';
  // 只有上传才有真实进度；别的操作跑起来时别把上一次上传的 x/y 带出来
  const runPct =
    (applyMode === 'upload' || applyMode === 'manual-upload') &&
    uploadProgress &&
    uploadProgress.total > 0
      ? Math.min(100, Math.round((uploadProgress.done / uploadProgress.total) * 100))
      : null;
  /** 有子目录里的图时提示一下：编号会把它们统一提到编码夹根 */
  const numberHasNested = Object.values(numberFiles).some((list) =>
    list.some((n) => n.includes('/'))
  );

  /**
   * 硬缺口：缺完整编码的 SKU、或一个产品文件夹都没有。
   * 这两种不往下走——红条强提醒，并挡住「下一步」和跳转。
   */
  const missingCodeSkus: string[] = scan
    ? scan.groups
        .map((g, i) => {
          const edit = edits[i];
          if (edit?.skip) return '';
          const code = String(edit?.code ?? g.code ?? '').trim();
          return isFullCode(code) ? '' : code || `第 ${i + 1} 组`;
        })
        .filter((s) => !!s)
    : // 现成文件夹：只有「纯主 SKU」这种明显不是完整编码的才算缺
      manualFolders.filter((f) => !isFullCode(f.name) && !/^\d{4,6}-/.test(f.name)).map((f) => f.name);
  const hasFolders = outputFolders.length > 0;
  // 不同步骤只提醒跟自己有关的缺口：还没建文件夹时别在「创建文件夹」这一步报缺文件夹
  const showMissingCode =
    missingCodeSkus.length > 0 &&
    (currentKey === 'copy' ||
      currentKey === 'ratio' ||
      currentKey === 'number' ||
      currentKey === 'import' ||
      currentKey === 'upload' ||
      currentKey === 'report');
  const showMissingFolder =
    !hasFolders &&
    (currentKey === 'ratio' || currentKey === 'number' || currentKey === 'import' || currentKey === 'upload' || currentKey === 'report');
  const hasHardBlocker = missingCodeSkus.length > 0 || !hasFolders;

  /** 进入某一步前必须齐备的东西；返回空串表示可以进入 */
  const canEnterStep = (key: StepKey): string => {
    if (key === 'scan') {
      return manualDir && !scan
        ? '当前用的是已选文件夹，不需要识别主 SKU；要重新扫描请先清除已选文件夹'
        : '';
    }
    if (key === 'resolve' || key === 'review' || key === 'copy') {
      if (!(scan && scan.groups.length)) return '请先扫描原始照片，识别出产品分组';
      // 缺编码 / 没产品图就直接挡在「创建文件夹」门外
      if (key === 'copy' && codeIssues.length) {
        return `有 ${codeIssues.length} 处缺完整编码或产品图，补齐后才能创建文件夹`;
      }
      return '';
    }
    if (key === 'ratio' || key === 'number' || key === 'import') {
      if (!outputFolders.length) return '请先创建产品文件夹（输出目录里至少有一个 SKU 子文件夹）';
      // 入库要把文件夹名当编码写进图库，先补齐编码再进
      if (key === 'import' && missingCodeSkus.length) {
        return `有 ${missingCodeSkus.length} 个 SKU 缺完整编码（${missingCodeSkus.slice(0, 3).join('、')}${
          missingCodeSkus.length > 3 ? ' 等' : ''
        }），补齐后才能入库`;
      }
      return '';
    }
    if (key === 'upload') {
      if (!outputFolders.length && !(manualDir && manualFolders.length)) {
        return '请先选择一个包含若干 SKU 子文件夹的父文件夹，或先扫描并创建文件夹';
      }
      if (missingCodeSkus.length) {
        return `有 ${missingCodeSkus.length} 个 SKU 缺完整编码（${missingCodeSkus.slice(0, 3).join('、')}${
          missingCodeSkus.length > 3 ? ' 等' : ''
        }），补齐后才能上传`;
      }
      return '';
    }
    if (key === 'report') {
      // 报表要 folders 才能出编号/截图，缺文件夹一样停在这里
      if (!outputFolders.length && !(manualDir && manualFolders.length)) {
        return '还没有产品文件夹，先完成第 4 步「创建文件夹」再生成报表';
      }
      // 报表只认 SKU 清单：扫出来的分组、现成文件夹、已建好的文件夹，任意一种够用就能出
      return reportRows.length ? '' : '还没有可导出的 SKU：先扫描分组，或选一个已整理好的文件夹';
    }
    return '';
  };

  /** 步骤条跳转：材料不齐不切过去；缺编码 / 缺文件夹算硬缺口，用红色强提醒 */
  const goStep = (key: StepKey) => {
    const missing = canEnterStep(key);
    if (missing) {
      onToast(missing, hasHardBlocker ? 'error' : 'info');
      return;
    }
    setStepOverride(key);
  };

  // 进入「图片编号」步骤就把产品文件夹的图片读进来，产品图行直接显示 1..5 的数字角标
  useEffect(() => {
    if (currentKey !== 'number' || !outputFolders.length) return;
    void ensureNumberFiles()
      .then(({ failed }) => {
        if (failed.length) {
          onToast(`有 ${failed.length} 个文件夹读不到图片（可能被改名或删除）`, 'error');
        }
      })
      .catch((err) => onToast((err as Error).message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, applied]);

  // 服务端盯着输出目录：用户在资源管理器里改名/删图后重新读盘，避免后续步骤拿着过期路径报错
  useEffect(() => {
    const activeDir = applied?.dateDir || manualDir;
    if (!activeDir) return;
    const off = subscribeEvents('barcode', (d) => {
      const dir = String((d as { dir?: string })?.dir || '');
      // 只关心当前这一步的目录（历史监听可能还在另一天的目录上）
      if (dir && pathBase(dir).toLowerCase() !== pathBase(activeDir).toLowerCase()) return;
      if (!scan && manualDir) {
        // 目录里增删图后：既要新文件夹列表，也要新图片清单，否则编号面板还挂着旧文件名
        void refreshManualFolders();
        void ensureNumberFiles().catch(() => {});
      } else {
        void ensureNumberFiles()
          .then(({ failed }) => {
            if (failed.length) {
              onToast(
                '检测到输出文件夹被外部修改（改名或删除），请回到「创建文件夹」重新生成',
                'error'
              );
            }
          })
          .catch(() => {});
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied?.dateDir, manualDir, scan]);

  /**
   * 复制成可直接粘贴进 Excel 的表格（无表头，整体居中）。
   * 列结构与合并规则都在 lib/work-report-table.ts（与后端 xlsx 共用同一套 13 列约定，C 运营列留空）。
   */
  const copyReportTable = async () => {
    if (!reportRows.length) {
      onToast('没有可复制的 SKU', 'error');
      return;
    }
    const { aoa, html } = buildWorkReportTable(shootDate, reportRows);
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
        onToast('表格已复制，直接粘贴到 Excel（日期与右侧五列已按模板通栏）');
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

      {/* 登录入口只有右上角一处：这里不显示账号、也不提供退出/改账号，
          已登录时整块不出，避免看起来像第二套登录系统 */}
      {!omsLoggedIn && (
        <div className="card" style={{ marginBottom: 14 }}>
          <span className="hint" style={{ color: 'var(--warn, #d08b2c)' }}>
            未登录 OMS：点右上角头像 →「登录 / 激活授权」，登录后本页自动同步；查询完整编码与上传需要先登录。
          </span>
        </div>
      )}

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
            onChange={(e) => {
              dateTouchedRef.current = true;
              setDate(e.target.value);
              // 日报文件名带日期：改了日期，上一份「已完成」就不作数了
              setReported(false);
            }}
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
            {subEnabled && subMode === 'custom' ? `/${subCustom || '分类'}` : ''}/编码；源目录里的子文件夹会原样保留
          </span>
        </div>

        {!isDesktop && (
          <div className="hint" style={{ marginTop: 10 }}>
            {i18n.t('k3589bd0e')}
          </div>
        )}
        {scanning && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="spin" />
            <b style={{ fontSize: 12.5 }}>
              {scanProgress?.phase === 'ocr' && scanProgress.total
                ? `正在识别条码 ${scanProgress.done}/${scanProgress.total} 张`
                : scanProgress?.phase === 'filter'
                  ? `正在判断条码照片 ${scanProgress.done}/${scanProgress.total} 张`
                  : i18n.t('k84b58f99')}
            </b>
            <span className="hint">
              已用 {Math.max(elapsed, Math.round((scanProgress?.elapsedMs || 0) / 1000))}s
            </span>
            <button className="btn ghost sm" onClick={() => void cancelScan()} disabled={cancelling}>
              {cancelling ? '正在停止…' : '停止扫描'}
            </button>
            <div
              style={{
                flexBasis: '100%',
                height: 4,
                borderRadius: 999,
                background: 'var(--line)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${scanPct}%`,
                  background: 'var(--accent, #4c8dff)',
                  transition: 'width .3s ease',
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 九步流程条：未扫描也显示；材料不齐时点进去只提示缺什么，不切换 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {STEP_DEFS.map((s, i) => {
          // 还没扫描 / 没载入文件夹时，别把「什么都不用做」的步骤显示成绿色已完成；
          // 用现成文件夹时，前四步（识别/查询/核对/创建）本来就不走，也不打勾
          const skipped = !scan && !!manualDir && SKIPPED_WHEN_MANUAL.includes(s.key);
          const done = stepDone[s.key] && (!!scan || !!manualDir) && !skipped;
          const active = s.key === currentKey;
          const blocked = canEnterStep(s.key);
          return (
            <button
              key={s.key}
              type="button"
              title={blocked || `跳到「${s.title}」`}
              onClick={() => goStep(s.key)}
              style={{
                padding: '3px 10px',
                borderRadius: 999,
                fontSize: 12,
                cursor: blocked && !active ? 'not-allowed' : 'pointer',
                border: `1px solid ${
                  active ? 'var(--accent, #4c8dff)' : done ? 'var(--ok, #3c9d5d)' : 'var(--line)'
                }`,
                color: active ? 'var(--accent, #4c8dff)' : done ? 'var(--ok, #3c9d5d)' : 'var(--muted)',
                background: active ? 'rgba(76, 141, 255, 0.12)' : 'transparent',
                fontWeight: active ? 600 : 400,
                opacity: blocked && !active ? 0.6 : 1,
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
        {STEP_DEFS.findIndex((s) => s.key === currentKey) < STEP_DEFS.length - 1 && (
          <button
            className="btn sm"
            onClick={() => {
              const i = STEP_DEFS.findIndex((s) => s.key === currentKey);
              const next = STEP_DEFS[i + 1];
              if (next) goStep(next.key);
            }}
            title="跳到下一步（材料不齐会提示）"
          >
            下一步 →
          </button>
        )}
      </div>

      {/* 没有扫描结果：第 1 步的动作直接摆在这里，别只留一个报表入口 */}
      {!scan && !scanning && !manualDir && (
        <div className="empty">
          <div className="big">
            <IconBarcode size={42} />
          </div>
          <h3>{i18n.t('k0d14616d')}</h3>
          <div className="hint">{i18n.t('k6fb164de')}</div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'center',
              alignItems: 'center',
              flexWrap: 'wrap',
              marginTop: 14,
            }}
          >
            <button className="btn primary" onClick={() => void runScan()} disabled={!srcDir.trim()}>
              <IconBarcode /> 开始识别
            </button>
            <button className="btn" onClick={() => void pickManualReportDir(null)} disabled={!isDesktop}>
              <IconFolder /> 已有整理好的文件夹？选目录直接开始
            </button>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            {srcDir.trim()
              ? '识别后用条码把照片分好组，第 2~9 步点上面的步骤条进去做；也可以选一个已整理好的文件夹，从编号 / 入库 / 上传 / 报表任意一步开始。'
              : '先在上方「源目录」选好拍摄当天所有照片的文件夹，再点「开始识别」；也可以选一个已整理好的文件夹，从编号 / 入库 / 上传 / 报表任意一步开始。'}
          </div>
        </div>
      )}

      {!scan && manualDir && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <b style={{ fontSize: 13 }}>已选文件夹</b>
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
                setManualNames({});
                // 这批文件夹的结果跟着作废，否则步骤条还挂着上一批的绿勾
                resetDownstream();
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
          {/* 编号步骤：eBay 逐个点 1~5 张，非 eBay 直接按拍摄顺序自动编号 */}
          {currentKey === 'number' && (
            <div style={{ display: 'grid', gap: 10 }}>
              {manualFolders.map((f) => {
                const dir = manualFolderPath(f.name);
                const files = numberFiles[dir] || [];
                const picks = numberPicks[dir] || [];
                const required = needManualPicks(f.name);
                const need = Math.min(5, files.length);
                return (
                  <div key={dir} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'baseline',
                        marginBottom: 6,
                        flexWrap: 'wrap',
                      }}
                    >
                      <b style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }}>
                        {f.name}
                      </b>
                      <span className="hint">
                        {files.length} 张 ·{' '}
                        {required
                          ? `已选 ${picks.length}/${need}`
                          : picks.length
                            ? `自动编号（手选 ${picks.length} 张优先）`
                            : '自动按拍摄顺序编号'}
                      </span>
                      {!files.length && numberReading && <span className="hint">正在读取图片…</span>}
                      {!files.length && !numberReading && (
                        <span className="hint" style={{ color: 'var(--danger, #d9534f)' }}>
                          文件夹里没有图片，检查是否被改名或删除
                        </span>
                      )}
                      {files.length > need && (
                        <span className="hint">按点击顺序编号：第 1 次点的是 1.jpg</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {files.map((name) => {
                        const at = picks.indexOf(name);
                        return (
                          <button
                            key={name}
                            type="button"
                            onClick={() => toggleNumberPick(dir, name)}
                            title={name}
                            style={{
                              position: 'relative',
                              width: 78,
                              height: 78,
                              padding: 0,
                              borderRadius: 8,
                              overflow: 'hidden',
                              cursor: 'pointer',
                              background: 'transparent',
                              border: `2px solid ${at >= 0 ? 'var(--accent, #4c8dff)' : 'var(--border)'}`,
                            }}
                          >
                            <img
                              src={barcodeThumbUrl(dir, name, 160)}
                              alt={name}
                              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                            />
                            {at >= 0 && (
                              <span
                                style={{
                                  position: 'absolute',
                                  top: 2,
                                  right: 2,
                                  minWidth: 18,
                                  height: 18,
                                  borderRadius: 9,
                                  background: 'var(--accent, #4c8dff)',
                                  color: '#fff',
                                  fontSize: 11,
                                  fontWeight: 700,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                {at + 1}
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

          {/* 调整图片归属：放错文件夹的图直接挪过去，不用去资源管理器手动剪切 */}
          {currentKey === 'number' && manualFolders.length > 1 && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <b style={{ fontSize: 12.5 }}>调整图片归属</b>
                <span className="hint">先选来源文件夹，点图勾选，再选目标文件夹移过去</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Select
                  style={{ width: 210 }}
                  value={moveSrc}
                  placeholder="来源文件夹"
                  onChange={(v) => {
                    setMoveSrc(v);
                    setMoveSel([]);
                  }}
                  options={manualFolders.map((f) => ({ value: f.name, label: f.name }))}
                />
                <Select
                  style={{ width: 210 }}
                  value={moveDst}
                  placeholder="目标文件夹"
                  onChange={setMoveDst}
                  options={manualFolders
                    .filter((f) => f.name !== moveSrc)
                    .map((f) => ({ value: f.name, label: f.name }))}
                />
                <button
                  className="btn sm primary"
                  disabled={moving || !moveSel.length || !moveDst}
                  onClick={() => void moveImagesTo()}
                >
                  {moving ? '移动中…' : `移动 ${moveSel.length} 张`}
                </button>
                <span className="hint">已选 {moveSel.length} 张</span>
              </div>
              {moveSrc && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {/* 子目录里的图也列出来（title 带相对路径）；移动后落到目标夹根，后续编号统一摊平 */}
                  {(numberFiles[manualFolderPath(moveSrc)] || []).map((name) => {
                    const at = moveSel.includes(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        title={name}
                        onClick={() =>
                          setMoveSel((prev) =>
                            prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
                          )
                        }
                        style={{
                          position: 'relative',
                          width: 64,
                          height: 64,
                          padding: 0,
                          borderRadius: 8,
                          overflow: 'hidden',
                          cursor: 'pointer',
                          background: 'transparent',
                          border: `2px solid ${at ? 'var(--accent, #4c8dff)' : 'var(--border)'}`,
                        }}
                      >
                        <img
                          src={barcodeThumbUrl(manualFolderPath(moveSrc), name, 140)}
                          alt={name}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {Object.keys(uploads).length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              {Object.entries(uploads).map(([dir, u]) => (
                <div key={dir} className="hint" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{pathBase(dir)}</span>
                  <span
                    style={{
                      color:
                        u.state === 'mismatch' || u.state === 'error'
                          ? 'var(--danger, #d9534f)'
                          : u.state === 'uploaded' || u.state === 'skipped'
                            ? 'var(--ok, #3c9d5d)'
                            : 'var(--muted)',
                      fontWeight: u.state === 'mismatch' ? 600 : 400,
                    }}
                  >
                    {u.message}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="hint" style={{ marginTop: 4 }}>
            这几个文件夹已经够用了：底部操作条按当前步骤给操作（构图 / 编号 / 入库 / 上传 / 生成 Excel），不用重新扫描。
          </div>
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

          {/* 手动分组：条码过明过暗识别失败、或自动分组切错时，用户自己勾选图片改归属。
              编号步骤的缩略图被「选前五张」占用，这里再摆一套只会点错，先藏起来 */}
          {currentKey !== 'number' && (
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
              {applied && (
                <div className="hint" style={{ color: 'var(--warn, #d08b2c)', marginBottom: 8 }}>
                  文件夹已经创建：这里只改分组、不动已复制的文件；要让新分组落地，得回第 4 步重新创建文件夹。
                </div>
              )}
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
          )}

          {scan.groups.map((g, i) => {
            const out = outputFolders.find((f) => f.sourceIndex === i);
            const numberFolder = folderBySourceIndex.get(i) || out?.folder || '';
            return (
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
                numberMode={currentKey === 'number' && !!numberFolder}
                numberFolder={numberFolder}
                numberFiles={numberFolder ? numberFiles[numberFolder] || [] : []}
                numberPicks={numberFolder ? numberPicks[numberFolder] || [] : []}
                onToggleNumber={
                  numberFolder ? (name) => toggleNumberPick(numberFolder, name) : undefined
                }
              />
            );
          })}

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
        </>
      )}

      {/* 底部操作条：扫描流程和「现成文件夹」流程共用同一个，位置和样式才一致 */}
      {(scan || manualDir) && (
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
            {/* 进度条：批量操作一开始就出现在吸底条上，不用再往下翻找「正在上传 3/30」 */}
            {runText && (
              <div style={{ marginBottom: 10 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    marginBottom: 5,
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  <span>{runText}</span>
                  {runPct !== null && (
                    <span className="hint">
                      {uploadProgress?.done}/{uploadProgress?.total} · {runPct}%
                    </span>
                  )}
                </div>
                <div className={`run-progress${runPct === null ? ' indeterminate' : ''}`}>
                  <i style={runPct === null ? undefined : { width: `${runPct}%` }} />
                </div>
              </div>
            )}
            {(showMissingCode || showMissingFolder) && (
              <div
                style={{
                  marginBottom: 8,
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: '2px solid var(--danger, #d9534f)',
                  background: 'rgba(217, 83, 79, 0.2)',
                  color: 'var(--danger, #d9534f)',
                  fontSize: 13,
                  fontWeight: 700,
                  lineHeight: 1.7,
                }}
              >
                {showMissingCode && (
                  <div>
                    缺完整编码 {missingCodeSkus.length} 个：{missingCodeSkus.slice(0, 4).join('、')}
                    {missingCodeSkus.length > 4 ? ' 等' : ''} —— 补齐后才能继续下一步
                  </div>
                )}
                {showMissingFolder && <div>还没有产品文件夹：先回第 4 步「创建文件夹」</div>}
              </div>
            )}
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
                有 {flowIssues.length} 个待补项（缺编码 / 没产品图的会挡住创建文件夹）：
                {flowIssues.slice(0, 4).join('；')}
                {flowIssues.length > 4 ? ` 等 ${flowIssues.length} 项` : ''}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {currentKey === 'scan' && !manualDir && (
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
                    disabled={applying || codeIssues.length > 0 || !outputDateDir}
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
                    勾选的文件夹按 1:1 检查；「打开批量裁切」可逐张调整裁切框，或一键自动居中裁剪，裁完点「重新检查 1:1」
                  </span>
                  <details style={{ flexBasis: '100%' }}>
                    <summary className="hint" style={{ cursor: 'pointer' }}>
                      参与检查的文件夹（默认只查 eBay，可勾选其它平台跳过/一起查）：
                      {ebayFolders.length}/{outputFolders.length}
                    </summary>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      {outputFolders.map((f) => {
                        const platform = platformOf(f.code) || '未识别';
                        return (
                          <label
                            key={f.folder}
                            className="hint"
                            title={f.folder}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                              padding: '3px 8px',
                              border: '1px solid var(--border)',
                              borderRadius: 999,
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={!!ratioInclude[f.folder]}
                              onChange={(e) =>
                                setRatioInclude((prev) => ({ ...prev, [f.folder]: e.target.checked }))
                              }
                            />
                            {f.code} · {platform}
                          </label>
                        );
                      })}
                    </div>
                  </details>
                </>
              )}

              {currentKey === 'number' && (
                <>
                  {/* 现成文件夹模式在正文里已经逐文件夹列图，不需要再弹放大面板 */}
                  {!!scan && (
                    <button className="btn" onClick={() => void openNumberPicker()} disabled={applying}>
                      {applyMode === 'number-read' ? '读取中…' : '选择前五张'}
                    </button>
                  )}
                  <button className="btn primary" onClick={() => void runNumber()} disabled={applying}>
                    {applyMode === 'number' ? '编号中…' : numbered ? '重新编号' : '开始编号'}
                  </button>
                  <span className="hint">
                    {scan
                      ? 'eBay 要点缩略图按点击顺序定 1.jpg 起的前五张（最多 5 张，也可点「选择前五张」放大挑）；非 eBay 不用选，按拍摄顺序自动编号。'
                      : 'eBay 文件夹要自己点满 1~5 张；非 eBay 不用点，按拍摄顺序自动编号。'}
                  </span>
                  {numberHasNested && (
                    <span className="hint" style={{ color: 'var(--warn, #d08b2c)' }}>
                      有图片在子文件夹里：编号时会把它们统一提到编码文件夹根，再按顺序命名 1.jpg…
                    </span>
                  )}
                </>
              )}

              {currentKey === 'import' && (
                <>
                  <button className="btn primary" onClick={runImport} disabled={applying}>
                    {applyMode === 'import' ? '入库中…' : insideActiveLib ? '仍要入库' : '入库'}
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
                    {applyMode === 'upload' || applyMode === 'manual-upload' ? '上传中…' : '上传 OMS'}
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
                      downloadFile(omsProductFolderShotUrl(shotDir, manualDir ? 1 : shotDepth));
                    }}
                  >
                    下载文件夹截图
                  </button>
                  <button className="btn ghost sm" onClick={() => void pickManualReportDir()} disabled={applying}>
                    {manualDir ? '重新选择文件夹' : '选择已整理好的文件夹'}
                  </button>
                </>
              )}

              {applied && (
                <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => openFolder(applied.dateDir)}>
                  {i18n.t('kc49c4607')}
                </button>
              )}
            </div>

            {/* 纯现成文件夹模式正文里已经列过这些文件夹，这里只给「扫描 + 现成文件夹」同时存在时看 */}
            {currentKey === 'report' && manualDir && !!scan && (
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
                      setManualNames({});
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
                  <span className="hint">
                    按点击顺序编号：第 1 次点的是 1.jpg，第 5 次点的是 5.jpg；非 eBay 不点就按拍摄顺序自动编号。
                  </span>
                  <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setPickerOpen(false)}>
                    收起
                  </button>
                </div>
                {outputFolders.map((f) => {
                  const picked = numberPicks[f.folder] || [];
                  const required = needManualPicks(f.code);
                  return (
                    <div
                      key={f.folder}
                      style={{ borderTop: '1px solid var(--border)', padding: '10px 0 4px' }}
                    >
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
                        <b style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }}>
                          {f.code || '—'}
                        </b>
                        <span className="hint">
                          {required ? `已选 ${picked.length}/5` : '非 eBay · 可不选，自动编号'}
                        </span>
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
                              title={
                                order >= 0
                                  ? `${name}（第 ${order + 1} 张，点击取消）`
                                  : `${name}（点击选中，按点击顺序编号）`
                              }
                              aria-label={order >= 0 ? `${name}，第 ${order + 1} 张` : name}
                              aria-pressed={order >= 0}
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
                (codeIssues.length
                  ? `还有 ${codeIssues.length} 个组缺编码或产品图，补齐才能创建文件夹。`
                  : '编码和产品图都齐了（产品名可以到上传前再补）。')}
              {currentKey === 'copy' &&
                `将复制到：${outputDateDir || '请先选择输出根目录'}${
                  insideActiveLib ? '；目录在当前库内，入库会自动跳过（库监听会登记）' : ''
                }`}
              {currentKey === 'ratio' &&
                (ratios
                  ? notSquareTotal
                    ? `有 ${notSquareTotal} 张图不是 1:1 或读不到尺寸（HEIC 也在内），必须处理成正方形。`
                    : ebayFolders.length
                      ? '勾选的图都是 1:1，可以继续编号。'
                      : '没有勾选任何文件夹，跳过 1:1 检查。'
                  : '创建文件夹后，先检查图片是否 1:1。')}
              {currentKey === 'number' &&
                (numbered
                  ? `已编号 ${numbered.reduce((n, r) => n + r.files.length, 0)} 张（1.jpg、2.jpg…）`
                  : '产品图行上直接按点击顺序选前五张（数字角标 1~5），再开始编号。')}
              {currentKey === 'import' && (
                <>
                  {imported
                    ? `已入库 ${imported.importedTotal} 张${
                        imported.importPath?.length ? `（${imported.importPath.join(' / ')}）` : ''
                      }`
                    : insideActiveLib
                      ? `图片已经在当前库「${importTargetPath.join(' / ')}」下，库监听会自动登记，默认跳过入库。`
                      : `登记到图库：${activeFolder?.name || activeLibName || '图库根'}`}
                  {/* 图库按绝对路径登记：没编号就入库，之后编号改名会让记录指向不存在的文件 */}
                  {!imported && applied && !numbered && (
                    <span style={{ color: 'var(--warn, #d08b2c)' }}>
                      ；这一批还没编号，现在入库是按原文件名登记，之后编号改名会让图库记录失效——建议先回「图片编号」。
                    </span>
                  )}
                </>
              )}
              {currentKey === 'upload' && '核对 OMS 名称后上传；名称不一致会停下等你确认。'}
              {currentKey === 'report' &&
                (manualDir
                  ? `按已选文件夹（${manualFolders.length} 个）生成 工作日报-${shootDate}.xlsx；文件夹截图来自 ${manualDir}。`
                  : `生成 工作日报-${shootDate}.xlsx，时长列留空。`)}
              {currentKey === 'report' && reportMixedSources && (
                <span style={{ color: 'var(--warn, #d08b2c)' }}>
                  {' '}
                  注意：报表/截图用的是「已选文件夹」这一批，编号/入库/上传用的是第 4 步创建的
                  {outputFolders.length} 个文件夹，两者不是同一批，别把两批结果混在一起核对。
                </span>
              )}
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
              {i18n.t('k168903f9')}：
              {insideActiveLib
                ? `当前库 / ${importTargetPath.join(' / ')}（目录已在库内，默认跳过入库）`
                : `${activeFolder?.name || activeLibName || i18n.t('k1dae2087')} · ${i18n.t('k948019e4')}`}
            </div>
          </div>
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
              if ((items || []).some((it) => it.notSquare.length)) void openBatchCrop(items);
              else setCropStudioOpen(false);
              setStepOverride(null);
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
  /** 图片编号模式：产品图行改成按顺序选前五张（数字角标），不再是手动分组勾选 */
  numberMode?: boolean;
  /** 该组对应的输出文件夹（缩略图与编号面板保持一致，裁切后也能看到新图） */
  numberFolder?: string;
  /** 该组对应的输出文件夹里的图片（与编号面板同一份数据） */
  numberFiles?: string[];
  numberPicks?: string[];
  onToggleNumber?: (name: string) => void;
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
  numberMode = false,
  numberFolder = '',
  numberFiles = [],
  numberPicks = [],
  onToggleNumber,
}: GroupRowProps) {
  // 编号步骤优先展示输出文件夹里的图（可能已裁切），与编号面板完全一致
  const shownFiles = numberMode && numberFiles.length ? numberFiles : group.files;
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
              <span className="hint" style={{ color: 'var(--warn, #d08b2c)' }}>
                产品名为空：Excel 品名会缺失，上传也会跳过名称核对（不挡流程，能补就补）
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

          {/* 编号步骤：产品图行直接按点击顺序选前五张（数字角标）；其它步骤：勾选后手动改分组 */}
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {shownFiles.map((f) => {
              const order = numberMode ? numberPicks.indexOf(f) : -1;
              const on = numberMode ? order >= 0 : selectedFiles.includes(f);
              const thumbDir = numberMode && numberFolder ? numberFolder : dir;
              const title = numberMode
                ? order >= 0
                  ? `${f}（第 ${order + 1} 张，点击取消）`
                  : `${f}（点击选中，按点击顺序编号；最多 5 张）`
                : `${f}${on ? '（已选，点击取消）' : '（点击选中，再在上方选择目标组）'}`;
              return (
                <button
                  key={f}
                  type="button"
                  title={title}
                  aria-pressed={on}
                  onClick={() => (numberMode ? onToggleNumber?.(f) : onToggleFile(f))}
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
                    src={barcodeThumbUrl(thumbDir, f)}
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
                        minWidth: numberMode ? 18 : 16,
                        height: numberMode ? 18 : 16,
                        borderRadius: 9,
                        padding: numberMode ? '0 3px' : 0,
                        boxSizing: 'border-box',
                        background: 'var(--accent, #4f8cff)',
                        color: '#fff',
                        fontSize: numberMode ? 11 : 10,
                        fontWeight: 700,
                        lineHeight: 1,
                        display: 'grid',
                        placeItems: 'center',
                      }}
                    >
                      {numberMode ? order + 1 : '✓'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="hint" style={{ marginTop: 6 }}>
            {numberMode
              ? `已选前五张 ${numberPicks.length}/5，数字角标就是最终编号`
              : i18n.t('k8b4a55fe', { p0: group.files.length })}
            {shownFiles.length > 0 ? ` · ${shownFiles[0]} … ${shownFiles[shownFiles.length - 1]}` : ''}
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
