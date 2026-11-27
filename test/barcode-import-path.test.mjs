/**
 * 条码入库的落位规则：
 * - 输出根目录在当前库内（D:\李伟\11月）→ 图库层级按磁盘层级走（11月/20261127/编码），
 *   忽略侧栏选中的父文件夹，避免同一张图在库里出现两条文件夹链；
 * - 输出根目录在库外 → 仍然挂在选中的父文件夹下。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-barcode-import-path-'));
const storage = path.join(tmp, 'storage');
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = storage;

const { register } = await import('../server/routes/barcode.js');
const { db, getActiveLibrary } = await import('../server/db.js');
const { ensureFolderUnderParent, listFolderTree } = await import('../server/folders.js');

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

async function callImport(payload) {
  const handler = handlers.get('/api/barcode/import');
  assert.ok(handler, 'import handler 必须注册');
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
  await handler({ body: payload }, res);
  return { status, body };
}

async function makeJpg(file, color = '#f2f2f0') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 600, height: 600, channels: 3, background: color } })
    .jpeg()
    .toFile(file);
}

test('入库：输出目录在当前库内时按磁盘层级落位（11月/日期/编码），忽略选中的父文件夹', async () => {
  const libRoot = String(getActiveLibrary()?.root_path || '');
  assert.equal(path.resolve(libRoot), path.resolve(storage), '测试环境的活动库根目录应是 storage');

  // 侧栏选中的父文件夹（错误落位就是挂到它下面）
  const wrongParent = ensureFolderUnderParent(null, '李伟');

  const root = path.join(storage, '11月');
  const dateFolder = '20261127';
  const code = '46200-Y01Y0001-QD08';
  const codeDir = path.join(root, dateFolder, code);
  await makeJpg(path.join(codeDir, '1.jpg'));

  const r = await callImport({
    root,
    date: '2026-11-27',
    dateFolder,
    parentFolderId: wrongParent,
    groups: [{ code, folder: codeDir, productName: '产品甲', mainSku: '46200' }],
  });

  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.insideLibrary, true);
  assert.deepEqual(r.body.importPath, ['11月', '20261127']);
  assert.equal(r.body.importedTotal, 1);

  const tree = listFolderTree();
  const month = tree.find((f) => f.name === '11月' && f.parent_id == null);
  const date = tree.find((f) => f.name === dateFolder && f.parent_id === month?.id);
  const codeNode = tree.find((f) => f.name === code && f.parent_id === date?.id);
  assert.ok(month && date && codeNode, '库根下应出现 11月 / 20261127 / 编码');
  assert.equal(codeNode.parent_id, date.id);
  assert.notEqual(codeNode.parent_id, wrongParent, '不能挂到侧栏选中的父文件夹下');

  const img = db.prepare('SELECT id FROM images WHERE abs_path = ?').get(path.join(codeDir, '1.jpg'));
  assert.ok(img, '图片应已登记进当前库');
  const link = db
    .prepare('SELECT 1 AS ok FROM image_folders WHERE image_id = ? AND folder_id = ?')
    .get(img.id, codeNode.id);
  assert.ok(link, '图片要挂到磁盘层级对应的编码文件夹');
});

test('入库：输出目录在库外时仍挂在选中的父文件夹下', async () => {
  const parent = ensureFolderUnderParent(null, '外部父');
  const root = path.join(tmp, 'outside-root');
  const dateFolder = '20261128';
  const code = '46201-Y01Y0001-QD08';
  const codeDir = path.join(root, dateFolder, code);
  await makeJpg(path.join(codeDir, '1.jpg'), '#e8e8e4');

  const r = await callImport({
    root,
    date: '2026-11-28',
    dateFolder,
    parentFolderId: parent,
    groups: [{ code, folder: codeDir }],
  });

  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.insideLibrary, false);
  assert.deepEqual(r.body.importPath, [dateFolder]);

  const tree = listFolderTree();
  const date = tree.find((f) => f.name === dateFolder && f.parent_id === parent);
  const codeNode = tree.find((f) => f.name === code && f.parent_id === date?.id);
  assert.ok(date && codeNode, '库外目录应挂在选中的父文件夹下');
});
