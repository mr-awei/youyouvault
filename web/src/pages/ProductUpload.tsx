import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  BASE,
  downloadFile,
  getApiToken,
  isDesktop,
  omsProductFolderShotUrl,
  pickFolder,
  type OmsProductScanRow,
} from '../api';
import { IconFolder, IconRefresh } from '../components/Icons';

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

type Status = 'unchecked' | 'checking' | 'match' | 'mismatch' | 'uploading' | 'uploaded';

interface Row extends OmsProductScanRow {
  expectedName: string;
  displayName: string;
  platform: string;
  status: Status;
  message: string;
  uploaded: number;
  shootCount: number;
}

function normalizeName(value: string) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function today() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 产品图上传：按 SKU 文件夹核对 OMS 后台名称，手动上传到「摄影师拍摄图」。
 * 这里不会自动上传；每个 SKU 都必须用户点「上传文件夹」并二次确认。
 */
export default function ProductUpload({ onToast }: Props) {
  const [root, setRoot] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [scanning, setScanning] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [date, setDate] = useState(today());
  const [showShot, setShowShot] = useState(false);

  const chooseRoot = async () => {
    const dir = await pickFolder();
    if (dir) setRoot(dir);
  };

  const scan = async () => {
    if (!root.trim()) {
      onToast('请先选择 SKU 根目录', 'error');
      return;
    }
    setScanning(true);
    try {
      const res = await api.omsProductScan(root.trim());
      setRows(
        res.rows.map((r) => ({
          ...r,
          expectedName: '',
          displayName: '',
          platform: '',
          status: 'unchecked',
          message: '',
          uploaded: 0,
          shootCount: 0,
        }))
      );
      setShowShot(true);
      if (!res.rows.length) onToast('没有找到 SKU 子文件夹');
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setScanning(false);
    }
  };

  const patch = (idx: number, next: Partial<Row>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...next } : r)));
  };

  const checkOne = async (idx: number) => {
    const row = rows[idx];
    if (!row) return;
    if (!row.expectedName.trim()) {
      patch(idx, { status: 'unchecked', message: '先填写记录名称' });
      onToast('请先填写记录名称', 'error');
      return;
    }
    patch(idx, { status: 'checking', message: '正在查后台…' });
    try {
      const hit = await api.omsProductLookup(row.sku.trim());
      const match = normalizeName(hit.displayName) === normalizeName(row.expectedName);
      patch(idx, {
        displayName: hit.displayName,
        platform: hit.platform || '',
        shootCount: hit.shootCount,
        status: match ? 'match' : 'mismatch',
        message: match ? '名称一致，可以上传' : '名称不一致，已停止，请核对',
      });
    } catch (err) {
      patch(idx, { status: 'mismatch', message: (err as Error).message });
    }
  };

  const checkAll = async () => {
    if (!rows.length) return;
    setCheckingAll(true);
    try {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].expectedName.trim()) await checkOne(i);
      }
    } finally {
      setCheckingAll(false);
    }
  };

  const uploadOne = async (idx: number) => {
    const row = rows[idx];
    if (!row) return;
    if (row.status !== 'match') {
      onToast('名称没有核对一致，不能上传', 'error');
      return;
    }
    const ok = window.confirm(
      `确认上传到 OMS 正式服？\n\nSKU：${row.sku}\n后台名称：${row.displayName || row.expectedName}\n图片：${row.imageCount} 张\n\n这一步会产生真实上传，确认后才继续。`
    );
    if (!ok) return;
    patch(idx, { status: 'uploading', message: '正在上传…' });
    try {
      const res = await api.omsProductUpload({
        sku: row.sku.trim(),
        dir: row.dir,
        expectedName: row.expectedName.trim(),
      });
      patch(idx, {
        status: 'uploaded',
        uploaded: res.uploaded,
        shootCount: res.shootCount,
        message: `已上传 ${res.uploaded} 张${res.skipped ? `，跳过 ${res.skipped} 张已存在` : ''}${res.failed.length ? `，失败 ${res.failed.length} 张` : ''}`,
      });
      onToast(`已上传 ${res.uploaded} 张到 ${row.sku}${res.skipped ? `（跳过 ${res.skipped} 张已存在）` : ''}`);
    } catch (err) {
      patch(idx, { status: 'mismatch', message: (err as Error).message });
      onToast((err as Error).message, 'error');
    }
  };

  const reportRows = useMemo(
    () =>
      rows.map((r) => ({
        sku: r.sku,
        name: r.displayName || r.expectedName,
        platform: r.platform,
        category: '产品/视频拍摄',
      })),
    [rows]
  );

  const downloadReport = async () => {
    if (!reportRows.length) {
      onToast('没有可导出的 SKU', 'error');
      return;
    }
    try {
      const token = await getApiToken();
      const res = await fetch(`${BASE}/api/oms/product/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ date, rows: reportRows }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 300) || `导出失败（HTTP ${res.status}）`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `工作日报-${date}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onToast('Excel 已生成，工作时长留了「待填」等你补');
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  useEffect(() => {
    // 页面初次进入不自动扫描，避免误触发任何后台请求
    setShowShot(false);
  }, []);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">产品图上传</h1>
          <div className="page-sub">按 SKU 文件夹核对 OMS 后台名称，确认后手动上传到「摄影师拍摄图」</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={scan} disabled={scanning}>
            {scanning ? <IconRefresh /> : <IconFolder />} {scanning ? '扫描中…' : '扫描文件夹'}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="hint" style={{ width: 96 }}>SKU 根目录</span>
          <input
            className="input"
            style={{ flex: '1 1 420px' }}
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="例如 D:\\产品图测试\\2026-11-20"
          />
          <button className="btn sm" onClick={chooseRoot} disabled={!isDesktop}>选择</button>
          <span className="hint" style={{ width: 60 }}>日期</span>
          <input className="input" type="date" style={{ width: 160 }} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          根目录下每个子文件夹名就是完整 SKU。核对只读取后台名称；上传必须点每行的「上传文件夹」并二次确认，不会自动上传。
        </div>
      </div>

      {rows.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="toolbar" style={{ marginBottom: 8 }}>
            <span className="hint">共 {rows.length} 个 SKU · {rows.reduce((n, r) => n + r.imageCount, 0)} 张图片</span>
            <button className="btn sm" onClick={checkAll} disabled={checkingAll || rows.length === 0}>
              {checkingAll ? '核对中…' : '核对全部'}
            </button>
            <button className="btn sm" onClick={downloadReport} style={{ marginLeft: 'auto' }}>
              生成 Excel
            </button>
            <button className="btn sm" onClick={() => setShowShot((v) => !v)}>
              {showShot ? '收起文件夹截图' : '查看文件夹截图'}
            </button>
            {root && (
              <button className="btn sm" onClick={() => downloadFile(omsProductFolderShotUrl(root))}>
                下载文件夹截图
              </button>
            )}
          </div>

          {showShot && root && (
            <div style={{ marginBottom: 10 }}>
              <img
                src={omsProductFolderShotUrl(root)}
                alt="文件夹截图"
                style={{ maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 8 }}
              />
              <div className="hint" style={{ marginTop: 4 }}>
                工作成果列可以放这张文件夹截图；Excel 里已写好「文件夹截图」占位。
              </div>
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>SKU</th>
                  <th style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>图片</th>
                  <th style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>记录名称</th>
                  <th style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>后台名称</th>
                  <th style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>状态</th>
                  <th style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.dir}>
                    <td style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>
                      <input
                        className="input"
                        style={{ width: 280, fontFamily: 'ui-monospace, Consolas, monospace' }}
                        value={r.sku}
                        onChange={(e) =>
                          patch(i, {
                            sku: e.target.value,
                            status: 'unchecked',
                            displayName: '',
                            message: '',
                          })
                        }
                        placeholder="完整 SKU"
                      />
                    </td>
                    <td style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>{r.imageCount}</td>
                    <td style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>
                      <input
                        className="input"
                        style={{ width: 220 }}
                        value={r.expectedName}
                        onChange={(e) => patch(i, { expectedName: e.target.value, status: 'unchecked', message: '' })}
                        placeholder="从拍摄记录/Excel 里填"
                      />
                    </td>
                    <td style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>
                      {r.displayName || <span className="hint">—</span>}
                    </td>
                    <td style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)' }}>
                      <div
                        style={{
                          color:
                            r.status === 'match' || r.status === 'uploaded'
                              ? 'var(--ok, #3c9d5d)'
                              : r.status === 'mismatch'
                                ? 'var(--danger, #d9534f)'
                                : 'var(--muted)',
                          fontWeight: r.status === 'mismatch' ? 600 : 400,
                        }}
                      >
                        {r.status === 'unchecked' && '未核对'}
                        {r.status === 'checking' && '核对中…'}
                        {r.status === 'match' && '名称一致'}
                        {r.status === 'mismatch' && '名称不一致，已停止'}
                        {r.status === 'uploading' && '上传中…'}
                        {r.status === 'uploaded' && '已上传'}
                      </div>
                      {r.message && <div className="hint" style={{ marginTop: 2 }}>{r.message}</div>}
                      {r.shootCount > 0 && <div className="hint">后台已有 {r.shootCount} 张</div>}
                    </td>
                    <td style={{ padding: '8px 6px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                      <button className="btn sm" onClick={() => checkOne(i)} disabled={r.status === 'uploading'}>
                        核对
                      </button>{' '}
                      <button
                        className="btn sm primary"
                        onClick={() => uploadOne(i)}
                        disabled={r.status !== 'match'}
                        title={r.status === 'match' ? '确认后才会真正上传' : '名称核对一致后才能上传'}
                      >
                        上传文件夹
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!rows.length && !scanning && (
        <div className="empty">
          <div className="big"><IconFolder size={42} /></div>
          <h3>还没有扫描文件夹</h3>
          <div className="hint">选择一个包含 SKU 子文件夹的目录，每个子文件夹名就是完整 SKU。</div>
        </div>
      )}
    </div>
  );
}
