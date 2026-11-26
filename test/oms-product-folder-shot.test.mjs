/**
 * 文件夹截图（工作日报「工作成果」列）的目录清单：
 * 默认列日期下的 SKU 文件夹；开了「日期下一级分类」时要穿透分类目录，别把 eBay / 非eBay 当产品夹。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-folder-shot-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = path.join(tmp, 'storage');

const { listSkuFolders } = await import('../server/routes/oms-product.js');

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* sqlite 句柄未释放时删不掉，留给系统临时目录 */
  }
});

function touchJpg(dir, name = '1.JPG') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), '');
}

test('文件夹截图：日期/编码 两层只列 SKU 文件夹与图片数', async () => {
  const dateDir = path.join(tmp, 'flat', '20261127');
  touchJpg(path.join(dateDir, '46200-Y01Y0001-QD08'));
  touchJpg(path.join(dateDir, '46200-Y01Y0001-QD08'), '2.JPG');
  touchJpg(path.join(dateDir, '46201-Y01Y0001-QD08'));

  const rows = await listSkuFolders(dateDir);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['46200-Y01Y0001-QD08', '46201-Y01Y0001-QD08']
  );
  assert.equal(rows[0].imageCount, 2);
  assert.equal(rows[1].imageCount, 1);
  assert.ok(rows.every((r) => r.sku === r.name && r.dir.startsWith(dateDir)));
});

test('文件夹截图：日期/分类/编码 三层时 depth=2 穿透分类目录', async () => {
  const dateDir = path.join(tmp, 'classified', '20261127');
  touchJpg(path.join(dateDir, 'eBay', '46210-Y01Y0001-QD08'));
  touchJpg(path.join(dateDir, '非eBay', '46211-Y01Y0001-QD08'));

  const deep = await listSkuFolders(dateDir, 2);
  assert.deepEqual(
    deep.map((r) => r.name),
    ['46210-Y01Y0001-QD08', '46211-Y01Y0001-QD08']
  );
  assert.ok(!deep.some((r) => r.name === 'eBay' || r.name === '非eBay'), '分类目录不能出现在截图里');

  // 默认 depth=1 保持旧行为：列出分类目录（供调用方确认没有传错目录）
  const shallow = await listSkuFolders(dateDir);
  assert.deepEqual(
    shallow.map((r) => r.name),
    ['非eBay', 'eBay']
  );
});

test('文件夹截图：SKU 文件夹里还有机位子目录时不当成分类继续下钻', async () => {
  const dateDir = path.join(tmp, 'nested', '20261127');
  touchJpg(path.join(dateDir, '机位A', '46220-Y01Y0001-QD08'), '1.JPG');
  touchJpg(path.join(dateDir, '机位B', '46221-Y01Y0001-QD08'), '1.JPG');

  const rows = await listSkuFolders(dateDir, 2);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['46220-Y01Y0001-QD08', '46221-Y01Y0001-QD08']
  );
});

test('文件夹截图：选中编码文件夹本身（没有子目录）时返回单行', async () => {
  const codeDir = path.join(tmp, 'single', '46230-Y01Y0001-QD08');
  touchJpg(codeDir);
  touchJpg(codeDir, '2.JPG');

  const rows = await listSkuFolders(codeDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '46230-Y01Y0001-QD08');
  assert.equal(rows[0].imageCount, 2);
});

test('文件夹截图：空日期目录返回空清单（不伪造一行）', async () => {
  const empty = path.join(tmp, 'empty', '20261127');
  fs.mkdirSync(empty, { recursive: true });
  // 根目录没有子目录 → 当成「选中的就是编码夹」，返回它自己一行
  const rows = await listSkuFolders(empty);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].imageCount, 0);
});
