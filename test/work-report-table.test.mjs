/**
 * 工作日报「复制表格」的列结构：必须与后端 xlsx（server/lib/work-report.js）一致。
 * C 列「运营」是模板里就有的空列；少一列，粘到 Excel 就会整体左移、合并区错位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORK_REPORT_COLUMNS,
  buildWorkReportTable,
} from '../web/src/lib/work-report-table.ts';

const rows = [
  { sku: 'SKU-A', name: '产品 A', platform: 'eBay', category: '产品/视频拍摄' },
  { sku: 'SKU-B', name: '产品 B', platform: '非eBay', category: '产品/视频拍摄' },
];

test('复制表格：每行都是 13 列，C 运营列为空、SKU 在 D 列', () => {
  const { aoa, totalRows } = buildWorkReportTable('2026-11-27', rows);

  assert.equal(WORK_REPORT_COLUMNS, 13);
  assert.equal(aoa.length, totalRows, 'SKU 行 + 图片上传行（复制表格不带末尾空行）');
  for (const [i, line] of aoa.entries()) {
    assert.equal(line.length, WORK_REPORT_COLUMNS, `第 ${i + 1} 行不是 ${WORK_REPORT_COLUMNS} 列`);
  }
  assert.deepEqual(aoa[0].slice(0, 7), [
    '2026-11-27',
    '产品拍摄*2',
    '',
    'SKU-A',
    '产品 A',
    'eBay',
    '产品/视频拍摄',
  ]);
  assert.equal(aoa[0][10], '100%');
  assert.equal(aoa[0][11], '文件夹截图');
  assert.equal(aoa[0][12], '');
  assert.equal(aoa[1][2], '');
  assert.equal(aoa[1][3], 'SKU-B');
});

test('复制表格：图片上传行写在 SKU 列、类别是「其它」，C/M 为空', () => {
  const { aoa } = buildWorkReportTable('2026-11-27', rows);
  const upload = aoa[aoa.length - 1];

  assert.equal(upload.length, WORK_REPORT_COLUMNS);
  assert.equal(upload[2], '');
  assert.equal(upload[3], '图片上传');
  assert.equal(upload[6], '其它');
  assert.equal(upload[12], '');
  assert.deepEqual(upload.filter(Boolean), ['图片上传', '其它']);
});

test('复制表格：HTML 的列数与通栏行数对得上（SKU 不会挤到 C 列）', () => {
  const { html, totalRows } = buildWorkReportTable('2026-11-27', rows);

  // 日期 + 产品拍摄 + 右侧五列 = 7 个 rowspan，每个都通到最后一行
  const spans = [...html.matchAll(/rowspan="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(spans.length, 7);
  assert.ok(spans.every((n) => n === totalRows));

  const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
  const trs = table.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  assert.equal(trs.length, rows.length + 1);

  const countTds = (tr) => (tr.match(/<td[\s>]/g) || []).length;
  // 第一行：2 个通栏 + 运营/4 个普通单元格/主管 + 5 个通栏 = 13
  assert.equal(countTds(trs[0]), 13);
  // 中间行：运营 + SKU/品名/平台/类别 + 主管 = 6（其余被 rowspan 占住）
  assert.equal(countTds(trs[1]), 6);
  // 图片上传行：运营/SKU/品名/平台/类别/主管
  assert.equal(countTds(trs[trs.length - 1]), 6);
  assert.match(trs[trs.length - 1], /<td[^>]*>图片上传<\/td>/);
});

test('复制表格：没有 SKU 时只产生图片上传行，不抛错', () => {
  const { aoa, html } = buildWorkReportTable('2026-11-27', []);
  assert.equal(aoa.length, 1);
  assert.equal(aoa[0].length, 13);
  assert.equal(aoa[0][3], '图片上传');
  assert.equal(aoa[0][6], '其它');
  assert.match(html, /图片上传/);
});
