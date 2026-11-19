/**
 * 授权码：签发 / 验签 / 机器绑定容错。
 *
 * 这是「没有服务器」时的安全边界：授权码被改一个字节就验不过，
 * 换机器则要么需要重新签发，要么落在「4 项硬件里变 1 项」的容错范围内。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  formatCode,
  machineCodeFromParts,
  machineMatches,
  normalizeCode,
  signLicenseKey,
  verifyLicenseKey,
} from '../server/lib/license-core.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });

const parts = ['guid-1', 'cpu-2', 'board-3', 'disk-4'];
const machine = machineCodeFromParts(parts);

const issue = (extra = {}) =>
  signLicenseKey({ machine, expires: null, issuedAt: '2026-11-20', note: 'buyer@example.com', ...extra }, PRIV);

const verify = (key, extra = {}) =>
  verifyLicenseKey(key, { publicKeyPem: PUB, machineCode: machine, ...extra });

test('机器码固定为 4 组、共 16 位十六进制', () => {
  assert.match(machine, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  assert.equal(normalizeCode(machine).length, 16);
  // 带空格 / 小写 / 缺横线都能归一化
  assert.equal(normalizeCode('a1b2 c3d4 e5f6 7890'), 'A1B2C3D4E5F67890');
  assert.equal(formatCode('a1b2c3d4e5f67890'), 'A1B2-C3D4-E5F6-7890');
});

test('正确授权码验签通过', () => {
  const r = verify(issue());
  assert.equal(r.ok, true);
  assert.equal(r.reason, '');
  assert.equal(r.payload.machine, machine);
  assert.equal(r.payload.note, 'buyer@example.com');
});

test('改动 payload 任意字段都会验签失败', () => {
  const raw = issue();
  const seg = raw.split('.');
  const payload = JSON.parse(Buffer.from(seg[1], 'base64url').toString('utf8'));
  payload.edition = 'team';
  const tampered = `TUKU1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${seg[2]}`;
  const r = verify(tampered);
  assert.equal(r.ok, false);
  assert.match(r.reason, /签名/);
});

test('换到别的机器验不过', () => {
  const other = machineCodeFromParts(['guid-A', 'cpu-B', 'board-C', 'disk-D']);
  const r = verify(issue(), { machineCode: other });
  assert.equal(r.ok, false);
  assert.match(r.reason, /机器不符/);
});

test('4 项硬件里变 1 项仍然可用（容错）', () => {
  const drifted = machineCodeFromParts(['guid-1', 'cpu-CHANGED', 'board-3', 'disk-4']);
  const r = verify(issue(), { machineCode: drifted });
  assert.equal(r.ok, true);
});

test('变 2 项就要重新签发', () => {
  const drifted = machineCodeFromParts(['guid-1', 'cpu-X', 'board-Y', 'disk-4']);
  assert.equal(verify(issue(), { machineCode: drifted }).ok, false);
});

test('单项读不到时不计为漂移', () => {
  // 当前机器主板序列号读不到（0000），其余 3 项一致
  const missing = machineCodeFromParts(['guid-1', 'cpu-2', '', 'disk-4']);
  assert.equal(verify(issue(), { machineCode: missing }).ok, true);
  // 只剩 1 项可读：无法证明是同一台机器
  const broken = machineCodeFromParts(['guid-1', '', '', '']);
  assert.equal(verify(issue(), { machineCode: broken }).ok, false);
});

test('machineMatches 的匹配数与可比较项数', () => {
  const drifted = machineCodeFromParts(['guid-1', 'cpu-X', 'board-3', 'disk-4']);
  const r = machineMatches(machine, drifted);
  assert.equal(r.matches, 3);
  assert.equal(r.comparable, 4);
  assert.equal(r.ok, true);
});

test('过期授权被拒绝', () => {
  const expired = issue({ expires: '2020-01-01' });
  const r = verify(expired);
  assert.equal(r.ok, false);
  assert.match(r.reason, /过期/);
});

test('到期日当天仍然有效', () => {
  const key = issue({ expires: '2026-11-20' });
  const r = verifyLicenseKey(key, {
    publicKeyPem: PUB,
    machineCode: machine,
    now: Date.parse('2026-11-20T23:00:00'),
  });
  assert.equal(r.ok, true);
});

test('不绑定机器的授权可在任意机器使用', () => {
  const anyKey = issue({ machine: '' });
  assert.equal(verify(anyKey, { machineCode: machineCodeFromParts(['x', 'y', 'z', 'w']) }).ok, true);
});

test('别的产品 / 版本 / 坏格式一律拒绝', () => {
  assert.equal(verify(issue({ product: 'other' })).ok, false);
  assert.equal(verify(issue({ v: 2 })).ok, false);
  for (const bad of ['', 'abc', 'TUKU1.abc', 'TUKU2.abc.def', 'TUKU1.bad.bad']) {
    assert.equal(verify(bad).ok, false, `应拒绝：${bad}`);
  }
});

test('支持 JSON 包装的激活码（邮件里常见的存法）', () => {
  assert.equal(verify(JSON.stringify({ key: issue() })).ok, true);
});

test('没有公钥时一律不通过', () => {
  assert.equal(verify(issue(), { publicKeyPem: '' }).ok, false);
});
