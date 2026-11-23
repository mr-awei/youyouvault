/**
 * 启动恢复登录的前置条件：loadAccount 必须共享同一次文件读取。
 *
 * 之前 license.js 在模块加载时 `void omsClient.loadAccount()`，
 * 旧实现同步就把 accountLoaded 置成 true，随后 restoreSession 再调用时会直接
 * 拿到「已加载但还没读到」的空账号，导致重开软件后 OMS 会话恢复失败，
 * 右上角出现「手机号 + 登录按钮」同时存在的怪状态。
 *
 * 这里用临时 TUKU_USER_DATA 造账号文件，不触网、不碰真实账号。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tuku-oms-race-'));
process.env.TUKU_USER_DATA = tmp;
await fsp.mkdir(path.join(tmp, 'data'), { recursive: true });
await fsp.writeFile(
  path.join(tmp, 'data', 'oms-account.json'),
  JSON.stringify({ username: '13800000000', password: 'fake', baseUrl: 'https://sit.uyoyous.com' })
);

const { omsClient } = await import('../server/lib/oms.js');

after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('并发 loadAccount 共享读取 Promise，不会返回半加载的空账号', async () => {
  const first = omsClient.loadAccount();
  const second = omsClient.loadAccount();
  // 关键回归点：两次调用必须是同一个 Promise，而不是第二次直接拿到 null
  assert.strictEqual(first, second);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a?.username, '13800000000');
  assert.equal(b?.username, '13800000000');
  assert.equal(a?.baseUrl, 'https://sit.uyoyous.com');
});

test('sessionSnapshot：账号已保存但会话为空时，不能算登录', () => {
  const snap = omsClient.sessionSnapshot();
  assert.equal(snap.configured, true);
  assert.equal(snap.username, '13800000000');
  assert.equal(snap.loggedIn, false);
});
