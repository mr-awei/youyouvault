/**
 * 拍摄流程第一段的纯逻辑回归：编码解析、自然排序、条码切组、文件夹名清洗。
 * 这里不碰 sharp / OCR（那些依赖真实图片与 Windows 系统组件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  groupFiles,
  isBarcodeImage,
  markDuplicates,
  naturalSort,
  parseBarcodeText,
  pickBestOcrParsed,
  safeCodeName,
} from '../server/lib/barcode-split.js';

test('parseBarcodeText：提取完整编码', () => {
  const r = parseBarcodeText('拍照送货单\n条形码\n45661-Y01Y0001-QD08\n主SKU 45661');
  assert.equal(r.code, '45661-Y01Y0001-QD08');
  assert.ok(r.candidates.includes('45661-Y01Y0001-QD08'));
  assert.ok(r.candidates.includes('45661'));
});

test('parseBarcodeText：全角字符与连字符附近空白也能识别', () => {
  assert.equal(parseBarcodeText('４５６６１－Ｙ０１Ｙ０００１－ＱＤ０８').code, '45661-Y01Y0001-QD08');
  assert.equal(parseBarcodeText('45661 - Y01Y0001 - QD08').code, '45661-Y01Y0001-QD08');
});

test('parseBarcodeText：只有主 SKU 时用 SKU 作默认编码', () => {
  const r = parseBarcodeText('主SKU：45661\nEbay 套');
  assert.equal(r.code, '45661');
  assert.deepEqual(r.candidates, ['45661']);
});

test('parseBarcodeText：只有 PO 号时不当作产品编码', () => {
  const r = parseBarcodeText('PO2610202464\n主SKU');
  assert.equal(r.code, '');
  assert.deepEqual(r.candidates, ['PO2610202464']);
});

test('parseBarcodeText：空文本返回空编码', () => {
  const r = parseBarcodeText('');
  assert.equal(r.code, '');
  assert.deepEqual(r.candidates, []);
});

test('parseBarcodeText：一维码内容优先作为编码', () => {
  const r = parseBarcodeText('拍照送货 26 年 10 28 日 P02610202464 45661 Ebay 套', '45661-Y01Y0001-QD08');
  assert.equal(r.code, '45661-Y01Y0001-QD08');
  assert.equal(r.codeSource, 'barcode');
  assert.equal(r.barcodeText, '45661-Y01Y0001-QD08');
});

test('parseBarcodeText：送货单只有 PO 条码时退回主 SKU', () => {
  const r = parseBarcodeText('拍照送货 26 年 10 28 日 P02610202464 45661 Ebay 套', 'PO2610202464');
  assert.equal(r.code, '45661');
  assert.equal(r.codeSource, 'sku');
  assert.ok(r.candidates.includes('45661'));
  assert.ok(!r.candidates.includes('PO2610202464'));
});

test('parseBarcodeText：OCR 把主 SKU 认成 =SKIJ / ±SKIJ 时仍能取到数字', () => {
  assert.equal(
    parseBarcodeText('拍照送货兰 =SKIJ 26 年 10 28 日 0 P02610130723 33922 Ebay 套配').code,
    '33922'
  );
  assert.equal(parseBarcodeText('拍照送货 26 年 10 扁 28 日 P02610202464 ±SKIJ 45661 Ebay 套').code, '45661');
});

test('parseBarcodeText：只有 PO 号 / 日期时不给编码', () => {
  assert.equal(parseBarcodeText('26 年 10 28 日 P02610202464').code, '');
  assert.equal(parseBarcodeText('', 'PO2610202464').code, '');
});

test('parseBarcodeText：同一段里同时出现 4 位和 5 位时优先 5 位主 SKU', () => {
  // 现场案例：44124 被 OCR 读成 4404，增强档能读回 44124
  assert.equal(parseBarcodeText('主SKU：4404 44124 Ebay 套').code, '44124');
  assert.equal(parseBarcodeText('26 年 11 21H P02610260230 44124 Ebay 套').code, '44124');
});

test('pickBestOcrParsed：常规档 4404 + 增强档 44124 时选 5 位', () => {
  const base = parseBarcodeText('26 年 11 21H P02610260230 4404 Ebay 套');
  const sharp = parseBarcodeText('26 年 11 21H P02610260230 44124 Ebay 套');
  assert.equal(base.code, '4404');
  assert.equal(pickBestOcrParsed([base, sharp]).code, '44124');
});

test('pickBestOcrParsed：一维码 / 完整编码优先于主 SKU', () => {
  const sku = parseBarcodeText('主SKU 44124');
  const full = parseBarcodeText('主SKU 44124\n45661-Y01Y0001-QD08');
  const bc = parseBarcodeText('主SKU 44124', '45661-Y01Y0001-QD08');
  assert.equal(pickBestOcrParsed([sku, full]).code, '45661-Y01Y0001-QD08');
  assert.equal(pickBestOcrParsed([sku, bc]).codeSource, 'barcode');
  assert.equal(pickBestOcrParsed([]), null);
});

test('naturalSort：数字按大小而不是字典序', () => {
  assert.deepEqual(naturalSort(['MG_10.jpg', 'MG_2.jpg', 'MG_1.jpg']), ['MG_1.jpg', 'MG_2.jpg', 'MG_10.jpg']);
  assert.deepEqual(
    naturalSort(['10/2.jpg', '2/10.jpg', '2/9.jpg']),
    ['2/9.jpg', '2/10.jpg', '10/2.jpg']
  );
});

test('groupFiles：条码开组，条码照片不进入产品图，开头图片进未分组', () => {
  const { groups, ungrouped } = groupFiles([
    { name: 'a.jpg', isBarcode: false },
    { name: 'b.jpg', isBarcode: true, code: 'C1' },
    { name: 'c.jpg', isBarcode: false },
    { name: 'd.jpg', isBarcode: false },
    { name: 'e.jpg', isBarcode: true, code: 'C2' },
    { name: 'f.jpg', isBarcode: false },
  ]);
  assert.deepEqual(ungrouped, ['a.jpg']);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].barcodeFile, 'b.jpg');
  assert.deepEqual(groups[0].files, ['c.jpg', 'd.jpg']);
  assert.equal(groups[1].barcodeFile, 'e.jpg');
  assert.deepEqual(groups[1].files, ['f.jpg']);
  for (const g of groups) assert.ok(!g.files.includes(g.barcodeFile));
});

test('groupFiles：连续两张条码给前一组空组警告', () => {
  const { groups } = groupFiles([
    { name: 'b1.jpg', isBarcode: true, code: 'C1' },
    { name: 'b2.jpg', isBarcode: true, code: 'C2' },
    { name: 'p.jpg', isBarcode: false },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].files, []);
  assert.ok(groups[0].warnings.some((w) => w.code === 'consecutive'));
  assert.deepEqual(groups[1].files, ['p.jpg']);
});

test('groupFiles：末尾只有条码也算空组，并提示没有编码时需手填', () => {
  const { groups } = groupFiles([
    { name: 'b1.jpg', isBarcode: true, code: '' },
  ]);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].warnings.some((w) => w.code === 'empty'));
  assert.ok(groups[0].warnings.some((w) => w.code === 'noCode'));
});

test('markDuplicates：同批重复编码会提示，不改写编码本身', () => {
  const groups = [
    { code: 'A-1', warnings: [] },
    { code: 'a-1', warnings: [] },
  ];
  markDuplicates(groups);
  assert.equal(groups[0].warnings.length, 0);
  assert.ok(groups[1].warnings.some((w) => w.code === 'duplicate'));
  assert.equal(groups[1].code, 'a-1');
});

test('safeCodeName：过滤非法字符、首尾点空格与空值', () => {
  assert.equal(safeCodeName('A/B:C*D?'), 'A-B-C-D-');
  assert.equal(safeCodeName('  .45661-Y01Y0001-QD08.  '), '45661-Y01Y0001-QD08');
  assert.equal(safeCodeName('   '), '');
  assert.equal(safeCodeName(''), '');
});

test('isBarcodeImage：浅黄面单（蓝色通道 > 100）也能识别', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tuku-barcode-'));
  const file = path.join(dir, 'label.jpg');
  // 蓝底 + 约 27% 的浅黄面单：旧阈值要求 b < 100，会把这张判成产品图
  const svg =
    '<svg width="400" height="400"><rect width="400" height="400" fill="#2f3b52"/>' +
    '<rect x="80" y="100" width="240" height="180" fill="#f5eb7a"/></svg>';
  try {
    await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(file);
    assert.equal(await isBarcodeImage(file), true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('isBarcodeImage：白底产品图不会被误判成面单', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tuku-product-'));
  const file = path.join(dir, 'product.jpg');
  const svg =
    '<svg width="400" height="400"><rect width="400" height="400" fill="#f4f4f2"/>' +
    '<rect x="150" y="120" width="100" height="180" fill="#9aa1aa"/></svg>';
  try {
    await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(file);
    assert.equal(await isBarcodeImage(file), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
