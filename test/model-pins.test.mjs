import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KNOWN_SHA256, pinnedSha, isPinned } from '../server/model-fetch.js';

const pins = JSON.parse(fs.readFileSync(new URL('../server/model-pins.json', import.meta.url), 'utf8'));

test('随包可信哈希清单不再是空的，且条目格式合法', () => {
  assert.ok(Object.keys(pins.models).length > 0, '清单仍为空，等于没有外部校验参照');
  for (const [key, hex] of Object.entries(pins.models)) {
    assert.match(hex, /^[0-9a-f]{64}$/i, `${key} 不是合法 sha256`);
    assert.equal(KNOWN_SHA256[key], hex.toLowerCase());
    assert.ok(isPinned(key));
  }
});

test('查哈希必须带仓库名：裸相对路径不许借别的仓库的哈希', () => {
  const [key, hex] = Object.entries(pins.models)[0];
  const short = key.split('/').slice(-2).join('/');
  assert.equal(pinnedSha(key), hex.toLowerCase());
  // 裸相对路径与短路径都查不到：避免不同仓库同名的 repoPath 串号
  assert.equal(pinnedSha(short), '');
  assert.equal(pinnedSha('onnx/model.onnx'), '');
  assert.equal(isPinned(short), false);
  assert.equal(pinnedSha('onnx/unknown-model.onnx'), '');
});

test('isPinned 与 pinnedSha 口径一致（同一路径不能「取得到哈希却声称未固定」）', () => {
  for (const key of Object.keys(pins.models)) {
    assert.equal(isPinned(key), true, key);
    const short = key.split('/').slice(-2).join('/');
    assert.equal(isPinned(short), !!pinnedSha(short), `${short} 两个接口口径不一致`);
  }
  assert.equal(isPinned('nope/model.onnx'), false);
});

test('超分权重与运行库都在清单里（运行前必须能强校验）', () => {
  const zips = Object.keys(pins.zips);
  assert.ok(
    zips.some((u) => /realesrgan-ncnn-vulkan/i.test(u)),
    '超分运行库（Real-ESRGAN）未固化哈希'
  );
  assert.ok(
    zips.some((u) => /realcugan-ncnn-vulkan/i.test(u)),
    '超分运行库（Real-CUGAN）未固化哈希'
  );
  for (const [url, hex] of Object.entries(pins.zips)) assert.match(hex, /^[0-9a-f]{64}$/i, `${url} 不是合法 sha256`);
});

test('downloadModelFile：前缀 + repoPath 只拼一次（误传完整 URL 不再产生重复路径）', async () => {
  const http = await import('node:http');
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { downloadModelFile } = await import('../server/model-fetch.js');

  const seen = [];
  const body = 'fake-onnx-weights-'.repeat(64);
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  /**
   * 不要用 0 让系统随机分配：临时端口偶尔会落到 undici 的禁用端口表里
   * （6000/6667/10080…），fetch 会直接抛 `bad port`，测试就成了偶发红灯。
   * 从固定段里挨个试，既避开禁用表也避开并行测试的占用。
   */
  let port = 0;
  for (const p of [18231, 18232, 18233, 18234, 18235]) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (err) => reject(err);
        srv.once('error', onErr);
        srv.listen(p, '127.0.0.1', () => {
          srv.off('error', onErr);
          resolve();
        });
      });
      port = p;
      break;
    } catch {
      /* 端口被占，换下一个 */
    }
  }
  assert.ok(port, '找不到可用端口');
  assert.equal(srv.address().port, port);
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tuku-dl-'));
  try {
    // 正常契约：镜像前缀 + repoPath
    const r1 = await downloadModelFile({
      mirrors: [base],
      repoPath: 'models/a.onnx',
      dest: path.join(dir, 'a.onnx'),
      minBytes: 16,
      allowPrivate: true,
    });
    assert.equal(r1.size, Buffer.byteLength(body));

    // 历史 bug 回归：曾把整条文件 URL 当前缀传入，
    // 路径被拼成 models/a.onnxmodels/a.onnx，镜像永远 404
    const r2 = await downloadModelFile({
      mirrors: [`${base}models/a.onnx`],
      repoPath: 'models/a.onnx',
      dest: path.join(dir, 'b.onnx'),
      minBytes: 16,
      allowPrivate: true,
    });
    assert.equal(r2.size, Buffer.byteLength(body));

    // 串号回归：裸路径不再借用清单里别的仓库的哈希，能正常落盘且如实标未比对清单
    const r3 = await downloadModelFile({
      mirrors: [base],
      repoPath: 'onnx/model.onnx',
      dest: path.join(dir, 'c.onnx'),
      minBytes: 16,
      allowPrivate: true,
    });
    assert.equal(r3.size, Buffer.byteLength(body));
    assert.equal(r3.verified, false);

    // pinKey 指向清单里真实存在的哈希时，字节对不上必须失败，且不留 .part / 半成品
    await assert.rejects(
      downloadModelFile({
        mirrors: [base],
        repoPath: 'onnx/model.onnx',
        pinKey: 'Xenova/clip-vit-base-patch32/onnx/vision_model_quantized.onnx',
        dest: path.join(dir, 'd.onnx'),
        minBytes: 16,
        allowPrivate: true,
      }),
      /可信清单不一致/
    );
    assert.equal(fs.existsSync(path.join(dir, 'd.onnx')), false, '校验失败不许留下正式文件');
    assert.equal(fs.existsSync(path.join(dir, 'd.onnx.part')), false, '校验失败要清掉 .part');
    assert.deepEqual(seen, ['/models/a.onnx', '/models/a.onnx', '/onnx/model.onnx', '/onnx/model.onnx']);
  } finally {
    srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

