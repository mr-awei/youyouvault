/**
 * 条码「保存并入库」端到端：复制 → 清理同名夹旧文件 → 按层级入库 → 写标签。
 * 直接调用 route handler，不启动 HTTP 服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-barcode-apply-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = path.join(tmp, 'storage');

const { register } = await import('../server/routes/barcode.js');
const { db } = await import('../server/db.js');

const handlers = new Map();
register(
  {
    post: (route, fn) => handlers.set(route, fn),
    get: (route, fn) => handlers.set(route, fn),
  },
  { asyncRoute: (fn) => fn }
);

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows：sqlite 句柄未释放时删不掉，留给系统临时目录 */
  }
});

test('保存并入库：复制、清理旧文件、建 日期/编码 层级并写产品名+SKU 标签', async () => {
  const source = path.join(tmp, 'source');
  const output = path.join(tmp, 'output');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(output, { recursive: true });

  await sharp({ create: { width: 900, height: 900, channels: 3, background: '#f2f2f0' } })
    .jpeg()
    .toFile(path.join(source, '_MG_0001.JPG'));
  await sharp({ create: { width: 900, height: 900, channels: 3, background: '#e8e8e4' } })
    .jpeg()
    .toFile(path.join(source, '_MG_0002.JPG'));

  // 上一次误分留下的文件：本次不在分组里，应该被移到 .stale
  const codeDir = path.join(output, '2026-11-20', '45661-Y01Y0001-QD08');
  fs.mkdirSync(codeDir, { recursive: true });
  const stale = path.join(codeDir, '_MG_9999.JPG');
  await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000000' } })
    .jpeg()
    .toFile(stale);

  const handler = handlers.get('/api/barcode/apply');
  assert.ok(handler, 'apply handler 必须注册');
  let status = 200;
  let body = null;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };
  await handler(
    {
      body: {
        dir: source,
        root: output,
        date: '2026-11-20',
        importToLibrary: true,
        parentFolderId: null,
        cleanStale: true,
        groups: [
          {
            code: '45661-Y01Y0001-QD08',
            productName: '测试产品',
            mainSku: '45661',
            files: ['_MG_0001.JPG', '_MG_0002.JPG'],
          },
        ],
      },
    },
    res
  );

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.totalCopied, 2);
  assert.equal(body.importedTotal, 2);
  assert.equal(body.cleanedTotal, 1);
  assert.ok(!fs.existsSync(stale), '旧文件不应留在编码文件夹');
  const staleRoot = path.join(output, '2026-11-20', '.stale');
  assert.ok(fs.existsSync(staleRoot), '旧文件应移到 .stale');

  const images = db.prepare('SELECT id, abs_path, tags FROM images ORDER BY id').all();
  assert.equal(images.length, 2);
  for (const img of images) {
    assert.ok(img.abs_path.startsWith(codeDir), '入库登记的是复制后的文件路径');
    const tags = img.tags.split(',');
    assert.ok(tags.includes('测试产品'), `缺少产品名标签：${img.tags}`);
    assert.ok(tags.includes('45661-Y01Y0001-QD08'), `缺少完整编码标签：${img.tags}`);
    assert.ok(tags.includes('45661'), `缺少主 SKU 标签：${img.tags}`);
  }

  const folder = db
    .prepare("SELECT id, parent_id FROM folders WHERE name = '45661-Y01Y0001-QD08'")
    .get();
  assert.ok(folder, '应创建编码文件夹');
  const dateFolder = db.prepare("SELECT id FROM folders WHERE name = '2026-11-20'").get();
  assert.equal(folder.parent_id, dateFolder.id);
  const links = db
    .prepare('SELECT COUNT(*) AS c FROM image_folders WHERE folder_id = ?')
    .get(folder.id);
  assert.equal(links.c, 2, '两张图都应挂到编码文件夹');
});
