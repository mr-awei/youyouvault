/**
 * 条码分组「保存并入库」的核心：按层级建文件夹、登记外部文件、写产品名/SKU 标签。
 * 不启动 HTTP 服务，直接验证 route 里用的同一组库函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-barcode-import-'));
const storage = path.join(tmp, 'storage');
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = storage;

const { db } = await import('../server/db.js');
const { ingest } = await import('../server/library.js');
const { ensureFolderUnderParent, linkImageToFolder, listFolderTree } = await import('../server/folders.js');

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows：sqlite 句柄未释放时删不掉，留给系统临时目录 */
  }
});

test('保存入库：按「日期 / 编码」建层级，外部图片登记并写入产品名 + SKU 标签', async () => {
  const outputDir = path.join(tmp, '输出', '2026-11-20', '45661-Y01Y0001-QD08');
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, '_MG_0001.JPG');
  await sharp({ create: { width: 900, height: 900, channels: 3, background: '#f2f2f0' } })
    .jpeg()
    .toFile(file);

  const dateFolder = ensureFolderUnderParent(null, '2026-11-20');
  const codeFolder = ensureFolderUnderParent(dateFolder, '45661-Y01Y0001-QD08');
  assert.ok(dateFolder && codeFolder);

  const tags = ['产品名 测试', '45661-Y01Y0001-QD08', '45661'];
  const r = await ingest({
    absPath: file,
    source: 'barcode',
    tags: tags.join(','),
    skipPhashDupe: true,
    skipQuality: true,
    skipAiFilter: true,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  linkImageToFolder(r.id, codeFolder);

  const row = db.prepare('SELECT id, abs_path, tags FROM images WHERE id = ?').get(r.id);
  assert.equal(row.abs_path, file, '外部文件只登记，不复制/移动');
  assert.deepEqual(row.tags.split(',').sort(), [...tags].sort());

  const link = db
    .prepare('SELECT 1 AS ok FROM image_folders WHERE image_id = ? AND folder_id = ?')
    .get(r.id, codeFolder);
  assert.ok(link, '图片必须挂到编码文件夹');

  const tree = listFolderTree();
  const dateNode = tree.find((f) => f.name === '2026-11-20');
  const codeNode = tree.find((f) => f.name === '45661-Y01Y0001-QD08');
  assert.ok(dateNode && codeNode, '文件夹树里要出现日期/编码层级');
  assert.equal(codeNode.parent_id, dateNode.id);
  assert.ok(codeNode.count >= 1 || codeNode.total >= 1, '编码文件夹要有图片计数');
});
