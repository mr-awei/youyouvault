/**
 * 智能文件夹与其余零散接口
 * 由 api.ts 组合成单一的 `api` 对象对外暴露（调用点不需要改 import）。
 */
import { request } from './core';
import type { SmartFolder, VersionInfo, ActionStep, ActionConditions, ActionDef, ActionPreviewStep } from './types';
import type { ImageItem } from '../types';

/** AI 夜间批处理：配置 + 时段判断 + 待办 + 当前进度（服务端一次给全） */
export interface NightBatchState {
  enabled: boolean;
  /** 当天分钟数（后端口径），前端展示用 startText/endText */
  start: number;
  end: number;
  startText: string;
  endText: string;
  tasks: string[];
  nowMin: number;
  inWindow: boolean;
  pending: { semantic: number; total: number };
  running: boolean;
  task: '' | 'semantic';
  jobId: number;
  done: number;
  total: number;
  startedAt: string;
  lastAt: string;
  lastSummary: string;
  lastError: string;
  skipped: string;
  stopRequested: boolean;
}

export const smartAPI = {
  // 智能文件夹
  smartFolders: () => request<SmartFolder[]>('/api/smart-folders'),
  createSmartFolder: (payload: { name: string; rules?: Record<string, unknown>; autoTags?: string[] }) =>
    request<{ ok: boolean; folders: SmartFolder[] }>('/api/smart-folders', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateSmartFolder: (
    id: number,
    patch: { name?: string; rules?: Record<string, unknown>; autoTags?: string[] }
  ) =>
    request<{ ok: boolean; folders: SmartFolder[] }>(`/api/smart-folders/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteSmartFolder: (id: number) =>
    request<{ ok: boolean; folders: SmartFolder[] }>(`/api/smart-folders/${id}`, { method: 'DELETE' }),
  // AI 夜间批处理：低峰时段补语义索引
  nightBatch: () => request<NightBatchState>('/api/night-batch'),
  saveNightBatch: (patch: { enabled?: boolean; start?: string; end?: string; tasks?: string[] }) =>
    request<NightBatchState>('/api/night-batch', { method: 'POST', body: JSON.stringify(patch) }),
  runNightBatch: () =>
    request<{ ok: boolean; summary?: string; status: NightBatchState }>('/api/night-batch/run', { method: 'POST' }),
  stopNightBatch: () =>
    request<{ ok: boolean; message?: string; status: NightBatchState }>('/api/night-batch/stop', {
      method: 'POST',
    }),
  previewSmartFolder: (id: number, opts: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.offset) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return request<{ folder: SmartFolder; total: number; items: ImageItem[]; limit: number; offset: number }>(
      `/api/smart-folders/${id}/images${qs ? `?${qs}` : ''}`
    );
  },
  applySmartFolderTags: (id: number) =>
    request<{ ok: boolean; changed: number; tags: { tag: string; count: number }[] }>(
      `/api/smart-folders/${id}/apply-tags`,
      { method: 'POST' }
    ),

  /* ------------------------- 图内文字（OCR） ------------------------- */
  ocrStatus: () =>
    request<{ platform: string; available: boolean; engine: string; note: string }>('/api/ocr/status'),
  ocrGet: (id: number) =>
    request<{ ok: boolean; id: number; text: string; lang: string; engine: string; createdAt: string }>(
      `/api/images/${id}/ocr`
    ),
  ocrRun: (id: number, force = false) =>
    request<{ ok: boolean; id: number; text: string; lang: string; engine: string; cached: boolean; chars?: number }>(
      `/api/images/${id}/ocr`,
      { method: 'POST', body: JSON.stringify({ force }) }
    ),
  ocrClear: (id: number) => request<{ ok: boolean; id: number }>(`/api/images/${id}/ocr`, { method: 'DELETE' }),
  ocrBatch: (ids: number[], force = false) =>
    request<{
      ok: boolean;
      total: number;
      okCount: number;
      truncated: boolean;
      results: { id: number; ok: boolean; error?: string; text?: string; chars?: number; cached?: boolean }[];
    }>('/api/images/ocr-batch', { method: 'POST', body: JSON.stringify({ ids, force }) }),

  /* ------------------------ 检查器：EXIF / PDF / 版本 ------------------------ */
  exif: (id: number) =>
    request<{
      ok: boolean;
      width: number;
      height: number;
      format: string;
      space?: string;
      density?: number;
      hasAlpha?: boolean;
      pages?: number;
      exif: Record<string, string | number>;
      error?: string;
    }>(`/api/images/${id}/exif`),
  pdfInfo: (id: number) =>
    request<{ ok: boolean; pages: number; exact: boolean; size: number }>(`/api/images/${id}/pdf-info`),
  /** EPUB：目录与封面（打开阅读器时一次） */
  epubOutline: (id: number) =>
    request<{
      ok: boolean;
      title: string;
      author: string;
      language: string;
      cover: string;
      chapters: { index: number; label: string }[];
    }>(`/api/images/${id}/epub`),
  /** EPUB：单章正文（服务端已把 HTML 转成纯文本块 + data URL 插图） */
  epubChapter: (id: number, index: number) =>
    request<{
      ok: boolean;
      index: number;
      label: string;
      total: number;
      blocks: ({ type: 'text'; text: string } | { type: 'image'; src: string })[];
    }>(`/api/images/${id}/epub/${index}`),
  versions: (id: number) =>
    request<{
      ok: boolean;
      id: number;
      title: string;
      current: VersionInfo;
      versions: (VersionInfo & { id: number; label: string })[];
    }>(`/api/images/${id}/versions`),
  restoreVersion: (id: number, versionId: number) =>
    request<{ ok: boolean; id: number; restored: number; item: ImageItem }>(
      `/api/images/${id}/versions/${versionId}/restore`,
      { method: 'POST' }
    ),
  /* 一图多区域裁切：每个框另存一份副本（saveMode 固定 copy，原图不动） */
  cropRegions: (
    id: number,
    regions: { x: number; y: number; w: number; h: number }[],
    opts: { targetDir: string; addToLibrary?: boolean }
  ) =>
    request<{
      ok: boolean;
      count: number;
      results: { ok: boolean; rect: { x: number; y: number; w: number; h: number }; error?: string }[];
    }>(`/api/images/${id}/crop-regions`, {
      method: 'POST',
      body: JSON.stringify({ regions, targetDir: opts.targetDir, addToLibrary: opts.addToLibrary !== false }),
    }),

  /* ------------------------------ 动作 Actions ------------------------------ */
  actions: () =>
    request<{
      ok: boolean;
      types: Record<string, { label: string; desc: string }>;
      actions: ActionDef[];
    }>('/api/actions'),
  saveAction: (action: {
    id?: number;
    name: string;
    icon?: string;
    steps: ActionStep[];
    conditions?: ActionConditions;
  }) =>
    request<{ ok: boolean; id: number }>(action.id ? `/api/actions/${action.id}` : '/api/actions', {
      method: action.id ? 'PUT' : 'POST',
      body: JSON.stringify(action),
    }),
  deleteAction: (id: number) => request<{ ok: boolean }>(`/api/actions/${id}`, { method: 'DELETE' }),
  /** dryRun=true 只预演不写库（不调模型、不改数据） */
  runAction: (id: number, ids: number[], opts: { dryRun?: boolean } = {}) =>
    request<{
      ok: boolean;
      dryRun?: boolean;
      action: { id: number; name: string };
      total: number;
      okCount: number;
      skipped: number;
      failed: number;
      items: {
        id: number;
        ok: boolean;
        skipped?: string;
        error?: string;
        logs: string[];
        preview?: ActionPreviewStep[];
      }[];
    }>(`/api/actions/${id}/run`, { method: 'POST', body: JSON.stringify({ ids, dryRun: !!opts.dryRun }) }),
  actionCount: (ids: number[]) =>
    request<{ ok: boolean; count: number }>('/api/actions/count', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  /* --------------------------- 数据出口（备份/迁移） --------------------------- */
  /** 批量元数据 CSV 导回（id 或文件路径匹配） */
  importMetadataCsv: (csv: string) =>
    request<{ ok: boolean; updated: number; skipped: number; errors: string[] }>(
      '/api/transfer/metadata/import',
      { method: 'POST', body: JSON.stringify({ csv }) }
    ),

  transferPreview: () =>
    request<{
      ok: boolean;
      library: { id?: number; name?: string; rootPath: string; dbPath: string };
      counts: { images: number; folders: number; tags: number; playlists: number; actions: number; ocr: number };
      thumbsBytes: number;
      storageDir: string;
    }>('/api/transfer/preview'),
  transferBackup: (targetDir: string, includeThumbs = true) =>
    request<{
      ok: boolean;
      dir: string;
      bytes: number;
      thumbsBytes: number;
      counts: Record<string, number>;
      note: string;
    }>('/api/transfer/backup', { method: 'POST', body: JSON.stringify({ targetDir, includeThumbs }) }),
  /* 恢复前预检：按 manifest 报「缺哪个文件 / 哪个校验和不符」 */
  /** 自动备份排程配置（每个资源库一份：可以备到不同盘） */
  transferAuto: () =>
    request<{
      enabled: boolean;
      dir: string;
      everyDays: number;
      keep: number;
      lastAt: string;
      lastPath: string;
      lastError: string;
    }>('/api/transfer/auto'),
  transferAutoSave: (patch: { enabled?: boolean; dir?: string; everyDays?: number; keep?: number }) =>
    request<{ enabled: boolean; dir: string; everyDays: number; keep: number; lastAt: string; lastPath: string; lastError: string }>(
      '/api/transfer/auto',
      { method: 'POST', body: JSON.stringify(patch) }
    ),
  transferAutoRun: () =>
    request<{ ok: boolean; skipped?: boolean; reason?: string; dir?: string; removed?: number; error?: string }>(
      '/api/transfer/auto/run',
      { method: 'POST' }
    ),
  transferVerify: (sourceDir: string) =>
    request<{
      ok: boolean;
      problems: string[];
      warnings: string[];
      counts: Record<string, number> | null;
    }>('/api/transfer/verify', { method: 'POST', body: JSON.stringify({ sourceDir }) }),
  transferRestore: (sourceDir: string, name?: string, rootPath?: string) =>
    request<{
      ok: boolean;
      id: number;
      name: string;
      rootPath: string;
      dbPath: string;
      thumbsBytes: number;
      counts: Record<string, number> | null;
      remapped: number;
      missing: number;
      note: string;
    }>('/api/transfer/restore', { method: 'POST', body: JSON.stringify({ sourceDir, name, rootPath }) }),
  /* 迁库是长任务：单轮上限 limit 个素材，返回 remaining 供前端提示「再点一次继续」 */
  transferImportEagle: (srcDir: string, name?: string, rootPath?: string, limit?: number) =>
    request<{
      ok: boolean;
      total: number;
      processed: number;
      imported: number;
      skipped: number;
      existing: number;
      failed: number;
      folders: number;
      remaining: number;
      items: { id: number; title: string; folder?: boolean }[];
      errors: string[];
      error?: string;
    }>('/api/transfer/import-eagle', {
      method: 'POST',
      body: JSON.stringify({ srcDir, name, rootPath, limit }),
      timeoutMs: 15 * 60 * 1000,
    }),

  /* 导出前的预览：当前库会被写成 Eagle 库的内容规模（不写任何文件） */
  eagleExportPreview: () =>
    request<{ images: number; bytes: number; folders: number; storageDir: string; name: string }>(
      '/api/export/eagle/preview'
    ),
  /* 导出面板可用的格式 / 质量 / 尺寸候选（服务端单一来源，避免前端硬编码） */
  exportOptions: () =>
    request<{
      formats: { key: string; label: string; ext: string; note: string }[];
      qualities: number[];
      maxSides: number[];
    }>('/api/export/options'),
  /* 后台任务版：立即返回 jobId，进度用 api.jobs('eagle-export', 1) 轮询；可取消 */
  exportEagleStart: (destDir: string, name?: string) =>
    request<{ ok: boolean; jobId: number }>('/api/export/eagle/job', {
      method: 'POST',
      body: JSON.stringify({ destDir, name }),
    }),

};
