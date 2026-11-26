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

test('工作日报：没有表头，第一行就是产品数据', () => {
  const buf = buildWorkReport({
    date: '2026-11-21',
    rows: [
      { sku: 'SKU-A', name: '产品 A', platform: 'eBay' },
      { sku: 'SKU-B', name: '产品 B', platform: '非eBay' },
    ],
  });
  const { rows } = readSheet(buf);

  // C 列是「运营」，模板里就是空的：SKU 必须在 D 列
  assert.deepEqual(rows[0].slice(0, 4), ['2026-11-21', '产品拍摄*2', '', 'SKU-A']);
  assert.equal(rows[0][4], '产品 A');
  assert.equal(rows[0][5], 'eBay');
  assert.equal(rows[0][7], '待填');
  assert.equal(rows[0][8], '待填');
  assert.equal(rows[0][9], '待填');
  assert.equal(rows[0][10], '100%');
  assert.equal(rows[0][11], '文件夹截图');
  assert.equal(rows[0][12], '', 'M 主管/组长/带教留空');
  assert.equal(rows[0].length, 13);
  // 第二行只保留 SKU / 品名 / 平台 / 类别；进度等通栏列不再重复
  assert.equal(rows[1][0], '');
  assert.equal(rows[1][1], '');
  assert.equal(rows[1][2], '');
  assert.equal(rows[1][3], 'SKU-B');
  assert.equal(rows[1][4], '产品 B');
  assert.equal(rows[1][5], '非eBay');
  assert.equal(rows[1][7], '');
  assert.equal(rows[1][10], '');
  assert.equal(rows[1][11], '');
});

test('工作日报：图片上传行写在 SKU 列，末尾保留空行', () => {
  const buf = buildWorkReport({ date: '2026-11-21', rows: [{ sku: 'SKU-A' }] });
  const { rows } = readSheet(buf);

  assert.equal(rows.length, 3); // 1 产品 + 图片上传 + 空行
  const upload = rows[1];
  assert.equal(upload.length, 13);
  assert.equal(upload[2], '', 'C 运营列保持为空');
  assert.equal(upload[3], '图片上传');
  assert.equal(upload[6], '其它');
  assert.equal(upload[10], ''); // 100% 在 K1，合并后不再重复
  assert.deepEqual(rows[2], ['', '', '', '', '', '', '', '', '', '', '', '', '']);
});

test('工作日报：日期/产品拍摄/右侧五列全部通到图片上传行', () => {
  const buf = buildWorkReport({
    date: '2026-11-21',
    rows: Array.from({ length: 11 }, (_, i) => ({ sku: `SKU-${i + 1}` })),
  });
  const { ws } = readSheet(buf);

  assert.deepEqual(ws['!merges'], [
    { s: { r: 0, c: 0 }, e: { r: 11, c: 0 } }, // A1:A12 日期（含图片上传）
    { s: { r: 0, c: 1 }, e: { r: 11, c: 1 } }, // B1:B12 今日完成工作（含图片上传）
    { s: { r: 0, c: 7 }, e: { r: 11, c: 7 } }, // H1:H12 拍摄时长
    { s: { r: 0, c: 8 }, e: { r: 11, c: 8 } }, // I1:I12 包装/安装/拆卸
    { s: { r: 0, c: 9 }, e: { r: 11, c: 9 } }, // J1:J12 总工作时长
    { s: { r: 0, c: 10 }, e: { r: 11, c: 10 } }, // K1:K12 百分比
    { s: { r: 0, c: 11 }, e: { r: 11, c: 11 } }, // L1:L12 文件夹截图
  ]);
  // C 运营 + M 主管列不参与合并
  assert.ok(!ws['!merges'].some((m) => [2, 12].includes(m.s.c)));
  assert.equal((ws['!rows'] || []).length, 13);
  assert.ok((ws['!rows'] || []).every((r) => r && r.hpt === 15));
  assert.equal((ws['!cols'] || []).length, 13);
});

test('工作日报：单条 SKU 时合并区只到「图片上传」行', () => {
  const buf = buildWorkReport({ date: '2026-11-21', rows: [{ sku: 'SKU-A' }] });
  const { ws, rows } = readSheet(buf);

  assert.equal(rows.length, 3);
  assert.deepEqual(ws['!merges'], [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } },
    { s: { r: 0, c: 7 }, e: { r: 1, c: 7 } },
    { s: { r: 0, c: 8 }, e: { r: 1, c: 8 } },
    { s: { r: 0, c: 9 }, e: { r: 1, c: 9 } },
    { s: { r: 0, c: 10 }, e: { r: 1, c: 10 } },
    { s: { r: 0, c: 11 }, e: { r: 1, c: 11 } },
  ]);
});

test('工作日报：缺品名/平台留空，类别回落默认值', () => {
  const buf = buildWorkReport({ date: '2026-11-21', rows: [{ sku: 'SKU-A' }, { sku: 'SKU-B', category: '包装' }] });
  const { rows } = readSheet(buf);

  assert.equal(rows[0][4], '');
  assert.equal(rows[0][5], '');
  assert.equal(rows[0][6], '产品/视频拍摄');
  assert.equal(rows[1][6], '包装');
});

test('工作日报：所有单元格水平垂直居中', async () => {
  const buf = buildWorkReport({ date: '2026-11-21', rows: [{ sku: 'SKU-A' }, { sku: 'SKU-B' }] });
  const zip = await JSZip.loadAsync(buf);
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const stylesXml = await zip.file('xl/styles.xml').async('string');

  assert.match(stylesXml, /<alignment horizontal="center" vertical="center"\/>/);
  const a1Style = sheetXml.match(/<c r="A1" s="(\d+)"/)?.[1];
  const c1Style = sheetXml.match(/<c r="C1" s="(\d+)"/)?.[1];
  const l3Style = sheetXml.match(/<c r="L3" s="(\d+)"/)?.[1];
  assert.ok(a1Style);
  assert.ok(c1Style);
  assert.ok(l3Style);
  assert.equal(a1Style, c1Style);
  assert.equal(a1Style, l3Style);
});
