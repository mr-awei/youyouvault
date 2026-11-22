import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import XLSX from 'xlsx-js-style';
import { buildWorkReport } from '../server/lib/work-report.js';

/** @param {Buffer} buf */
function readSheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
  return { ws, rows };
}

test('工作日报：日期与工作项纵向合并，重复列留空', () => {
  const buf = buildWorkReport({
    date: '2026-11-21',
    rows: [
      { sku: 'SKU-A', name: '产品 A', platform: 'eBay' },
      { sku: 'SKU-B', name: '产品 B', platform: '非eBay' },
    ],
  });
  const { rows } = readSheet(buf);

  assert.deepEqual(rows[0].slice(0, 3), ['日期', '今日完成工作', '运营']);
  // 第 2 行是合并区左上：日期 / 产品拍摄*2 / 待填 / 文件夹截图
  assert.equal(rows[1][0], '2026-11-21');
  assert.equal(rows[1][1], '产品拍摄*2');
  assert.equal(rows[1][7], '待填');
  assert.equal(rows[1][8], '待填');
  assert.equal(rows[1][9], '待填');
  assert.equal(rows[1][10], '100%');
  assert.equal(rows[1][11], '文件夹截图');
  // 第 3 行只保留 SKU / 品名 / 平台 / 类别 / 进度
  assert.equal(rows[2][0], '');
  assert.equal(rows[2][1], '');
  assert.equal(rows[2][3], 'SKU-B');
  assert.equal(rows[2][7], '');
  assert.equal(rows[2][11], '');
  assert.equal(rows[2][10], '100%');
});

test('工作日报：图片上传行写在 SKU 列，末尾保留空行', () => {
  const buf = buildWorkReport({ date: '2026-11-21', rows: [{ sku: 'SKU-A' }] });
  const { rows } = readSheet(buf);

  assert.equal(rows.length, 4); // 表头 + 1 产品 + 图片上传 + 空行
  const upload = rows[2];
  assert.equal(upload[3], '图片上传');
  assert.equal(upload[6], '其它');
  assert.equal(upload[10], '100%');
  assert.deepEqual(rows[3], ['', '', '', '', '', '', '', '', '', '', '', '', '']);
});

test('工作日报：合并区与模板一致', () => {
  const buf = buildWorkReport({
    date: '2026-11-21',
    rows: Array.from({ length: 11 }, (_, i) => ({ sku: `SKU-${i + 1}` })),
  });
  const { ws } = readSheet(buf);

  assert.deepEqual(ws['!merges'], [
    { s: { r: 1, c: 0 }, e: { r: 12, c: 0 } }, // A2:A13
    { s: { r: 1, c: 1 }, e: { r: 12, c: 1 } }, // B2:B13
    { s: { r: 1, c: 7 }, e: { r: 11, c: 7 } }, // H2:H12
    { s: { r: 1, c: 8 }, e: { r: 11, c: 8 } }, // I2:I12
    { s: { r: 1, c: 9 }, e: { r: 12, c: 9 } }, // J2:J13
    { s: { r: 1, c: 11 }, e: { r: 12, c: 11 } }, // L2:L13
  ]);
  assert.equal((ws['!rows'] || []).length, 14);
  assert.ok((ws['!rows'] || []).every((r) => r && r.hpt === 15));
  assert.equal((ws['!cols'] || []).length, 13);
});

test('工作日报：合并区左上单元格居中，表头不强制居中', async () => {
  const buf = buildWorkReport({ date: '2026-11-21', rows: [{ sku: 'SKU-A' }, { sku: 'SKU-B' }] });
  const zip = await JSZip.loadAsync(buf);
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const stylesXml = await zip.file('xl/styles.xml').async('string');

  // 模板要求合并区左上（A2）居中；D 列数据保持默认对齐（两者引用的样式号不同）
  assert.match(stylesXml, /<alignment horizontal="center" vertical="center"\/>/);
  const a2Style = sheetXml.match(/<c r="A2" s="(\d+)"/)?.[1];
  const d2Style = sheetXml.match(/<c r="D2" s="(\d+)"/)?.[1];
  assert.ok(a2Style);
  assert.ok(d2Style);
  assert.notEqual(a2Style, d2Style);
});
