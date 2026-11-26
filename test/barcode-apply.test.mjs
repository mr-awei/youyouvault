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

test('同批重复编码合并到同一个文件夹：不加 -2 后缀，清理也不误伤另一组', async () => {
  const source = path.join(tmp, 'source2');
  const output = path.join(tmp, 'output2');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  for (const name of ['A1.JPG', 'A2.JPG', 'B1.JPG']) {
    await sharp({ create: { width: 200, height: 200, channels: 3, background: '#cccccc' } })
      .jpeg()
      .toFile(path.join(source, name));
  }

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
        date: '2026-11-21',
        importToLibrary: false,
        parentFolderId: null,
        // 合并后清理按文件夹做一次，不能把另一组刚复制进来的图当旧文件挪走
        cleanStale: true,
        groups: [
          { code: '46119-Y01A0001-B02', files: ['A1.JPG', 'A2.JPG'] },
          { code: '46119-Y01A0001-B02', files: ['B1.JPG'] },
        ],
      },
    },
    res
  );

  assert.equal(status, 200, JSON.stringify(body));
  const dateDir = path.join(output, '2026-11-21');
  const folders = fs.readdirSync(dateDir).filter((n) => !n.startsWith('.'));
  assert.deepEqual(folders, ['46119-Y01A0001-B02'], '同编码必须落在同一个文件夹');
  assert.ok(!folders.some((n) => n.endsWith('-2')), '不允许再出现 -2 后缀文件夹');

  const files = fs.readdirSync(path.join(dateDir, '46119-Y01A0001-B02')).sort();
  assert.deepEqual(files, ['A1.JPG', 'A2.JPG', 'B1.JPG'], '两组照片都要并进同一个文件夹');
  assert.equal(body.totalCopied, 3);
  assert.equal(body.cleanedTotal, 0, '合并清理不能把另一组的图判成旧文件');
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].folder, body.results[1].folder, '两组结果指向同一个文件夹');
});

test('源目录多级嵌套：复制保留相对子目录，不同机位的同名文件不互相覆盖', async () => {
  const source = path.join(tmp, 'source-nest');
  const output = path.join(tmp, 'output-nest');
  fs.mkdirSync(path.join(source, '机位A'), { recursive: true });
  fs.mkdirSync(path.join(source, '机位B'), { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  for (const rel of ['机位A/1.JPG', '机位B/1.JPG', '2.JPG']) {
    await sharp({ create: { width: 120, height: 120, channels: 3, background: '#dddddd' } })
      .jpeg()
      .toFile(path.join(source, rel));
  }

  const handler = handlers.get('/api/barcode/apply');
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
        date: '2026-11-22',
        importToLibrary: false,
        parentFolderId: null,
        cleanStale: false,
        groups: [
          {
            code: '46000-Y01Y0001-QD08',
            files: ['机位A/1.JPG', '机位B/1.JPG', '2.JPG'],
          },
        ],
      },
    },
    res
  );

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.totalCopied, 3);
  const codeDir = path.join(output, '2026-11-22', '46000-Y01Y0001-QD08');
  assert.ok(fs.existsSync(path.join(codeDir, '机位A', '1.JPG')), '子目录结构要保留');
  assert.ok(fs.existsSync(path.join(codeDir, '机位B', '1.JPG')), '同名文件不能互相覆盖');
  assert.ok(fs.existsSync(path.join(codeDir, '2.JPG')), '根目录的图仍然落在根目录');
});

test('调整归属：子目录里的图片也能挪到另一个编码夹，重名不覆盖', async () => {
  const from = path.join(tmp, 'move-from', '46240-Y01Y0001-QD08');
  const to = path.join(tmp, 'move-to', '46241-Y01Y0001-QD08');
  fs.mkdirSync(path.join(from, '机位A'), { recursive: true });
  fs.mkdirSync(to, { recursive: true });
  await sharp({ create: { width: 200, height: 200, channels: 3, background: '#111111' } })
    .jpeg()
    .toFile(path.join(from, '机位A', '1.JPG'));
  await sharp({ create: { width: 320, height: 320, channels: 3, background: '#222222' } })
    .jpeg()
    .toFile(path.join(to, '1.JPG'));

  const handler = handlers.get('/api/barcode/move-image');
  assert.ok(handler, 'move-image handler 必须注册');
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
  await handler({ body: { from, to, files: ['机位A/1.JPG'] } }, res);

  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.errors, [], '子目录相对路径不能按 basename 去找');
  assert.deepEqual(body.moved, ['1 (2).JPG'], '目标已有同名图时要加序号，不能覆盖');
  assert.ok(!fs.existsSync(path.join(from, '机位A', '1.JPG')), '源文件应被移走');
  assert.ok(fs.existsSync(path.join(to, '1 (2).JPG')));
});

test('编号对嵌套目录：图文全部提到编码夹根，按 1.jpg… 顺序命名并清掉空子目录', async () => {
  const dir = path.join(tmp, 'number-nest', '46001-Y01Y0001-QD08');
  fs.mkdirSync(path.join(dir, '机位A'), { recursive: true });
  fs.mkdirSync(path.join(dir, '机位B'), { recursive: true });
  // 同名文件分处两个子目录：必须都能编号，而不是互相覆盖成一张
  for (const rel of ['机位A/1.JPG', '机位B/1.JPG', '3.JPG']) {
    await sharp({ create: { width: 150, height: 150, channels: 3, background: '#eeeeee' } })
      .jpeg()
      .toFile(path.join(dir, rel));
  }

  const handler = handlers.get('/api/barcode/number');
  assert.ok(handler, 'number handler 必须注册');
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
  await handler({ body: { folders: [{ code: '46001-Y01Y0001-QD08', dir }] } }, res);

  assert.equal(status, 200, JSON.stringify(body));
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['1.jpg', '2.jpg', '3.jpg'], '嵌套图片要摊平并连续编号');
  assert.ok(!fs.existsSync(path.join(dir, '机位A')), '空子目录要清掉');
  assert.ok(!fs.existsSync(path.join(dir, '机位B')), '空子目录要清掉');
});
