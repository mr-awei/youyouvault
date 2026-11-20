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
  deviceCodeFromParts,
  deviceMatches,
  formatCode,
  formatDeviceCode,
  isValidPhone,
  machineCodeFromParts,
  machineMatches,
  normalizeCode,
  normalizeDeviceCode,
  normalizePhone,
  signLicenseKey,
  signRevocationList,
  verifyLicenseKey,
  verifyRevocationList,
} from '../server/lib/license-core.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });

const parts = ['guid-1', 'cpu-2', 'board-3', 'disk-4'];
const machine = machineCodeFromParts(parts);

const issue = (extra = {}) =>
  signLicenseKey(
    {
      machine,
      phone: '13800000000',
      account: '13800000000',
      expires: null,
      issuedAt: '2026-11-20',
      note: 'buyer@example.com',
      ...extra,
    },
    PRIV
  );

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

test('授权手机号写入 payload，供远程停用匹配', () => {
  const r = verify(issue({ phone: '139 0000 1111', account: '13900001111' }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.phone, '139 0000 1111');
  assert.equal(normalizePhone(r.payload.phone), '13900001111');
});

test('手机号规范化与校验：允许带 + / 空格 / 横线', () => {
  assert.equal(normalizePhone('+86 138-0000-0000'), '+8613800000000');
  assert.equal(normalizePhone('（138）0000 0000'), '13800000000');
  assert.equal(isValidPhone('13800000000'), true);
  assert.equal(isValidPhone('+8613800000000'), true);
  assert.equal(isValidPhone('123'), false);
  assert.equal(isValidPhone('abc'), false);
});

test('远程停用清单：验签通过，篡改拒绝', () => {
  const token = signRevocationList(
    {
      seq: 3,
      issuedAt: '2026-11-21',
      revokedPhones: ['13800000000'],
      revokedAccounts: ['13800000000'],
      revokedMachines: [machine],
    },
    PRIV
  );
  const r = verifyRevocationList(token, { publicKeyPem: PUB });
  assert.equal(r.ok, true);
  assert.equal(r.payload.seq, 3);
  assert.deepEqual(r.payload.revokedPhones, ['13800000000']);
  assert.deepEqual(r.payload.revokedMachines, [machine]);

  const seg = token.split('.');
  const payload = JSON.parse(Buffer.from(seg[1], 'base64url').toString('utf8'));
  payload.seq = 99;
  const tampered = `TUKU-REVOKE1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${seg[2]}`;
  const bad = verifyRevocationList(tampered, { publicKeyPem: PUB });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /签名/);
  assert.equal(verifyRevocationList(token, { publicKeyPem: '' }).ok, false);
});

/* ------------------------------ v2 设备码 ------------------------------ */

const hw = {
  uuid: 'F1FEF541-32DD-7BD4-6F66-08BFB86CE53F',
  board: 'BOARD-230520659400109',
  bios: 'BIOS-SERIAL-01',
  disk: 'E823_8FA6_BF53_0001',
  tpm: 'TPM-EK-PUBLIC-KEY-HASH',
  guid: 'f6f68d52-f5f7-4f70-98b6-1401a91ec12a',
  cpu: 'BFEBFBFF000B0671',
  cpuName: '13th Gen Intel Core i9',
  mac: '64:49:7D:70:A6:7F',
};

test('v2 设备码：TK2 前缀、6 组、可格式化 / 归一化', () => {
  const code = deviceCodeFromParts(hw);
  assert.match(code, /^TK2(-[0-9A-F]{4}){6}$/);
  assert.equal(normalizeDeviceCode(code).length, 24);
  assert.equal(formatDeviceCode(normalizeDeviceCode(code)), code);
  assert.equal(formatDeviceCode(normalizeDeviceCode(code).toLowerCase()), code);
});

test('v2 设备码：OEM 占位值与全零不参与计算', () => {
  const a = deviceCodeFromParts({ ...hw, board: 'To be filled by O.E.M.', bios: 'System Serial Number' });
  const b = deviceCodeFromParts({ ...hw, board: '', bios: '' });
  assert.equal(a, b, '占位值应与缺省值算出同一结果');
});

test('v2 设备码：允许 2 组漂移，但必须命中强特征', () => {
  const code = deviceCodeFromParts(hw);
  // 换网卡 + 重装系统（MachineGuid 变化）：2 组漂移，强特征仍命中
  const drift2 = deviceCodeFromParts({
    ...hw,
    guid: 'new-machine-guid-after-reinstall',
    mac: 'AA:BB:CC:DD:EE:FF',
  });
  const r = deviceMatches(code, drift2);
  assert.equal(r.ok, true);
  assert.equal(r.matches, 4);
  assert.equal(r.comparable, 6);

  // 换主板 + 启动盘 + MachineGuid：3 组漂移
  const drift3 = deviceCodeFromParts({
    ...hw,
    uuid: '99999999-8888-7777-6666-555555555555',
    board: 'NEW-BOARD',
    bios: 'NEW-BIOS',
    disk: 'NEW-DISK',
    guid: 'new-guid',
  });
  assert.equal(deviceMatches(code, drift3).ok, false);
});

test('v2 设备码：整机克隆 / 换一台电脑必须拒绝', () => {
  const code = deviceCodeFromParts(hw);
  const cloned = deviceCodeFromParts({
    uuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    board: 'OTHER-BOARD',
    bios: 'OTHER-BIOS',
    disk: 'OTHER-DISK',
    tpm: 'OTHER-TPM',
    guid: 'other-guid',
    cpu: 'OTHER-CPU',
    cpuName: 'Other CPU',
    mac: '11:22:33:44:55:66',
  });
  const r = deviceMatches(code, cloned);
  assert.equal(r.ok, false);
  assert.equal(r.strongMatches, 0);
});

test('新授权码按 machine2（v2）校验；老授权码仍按 machine（v1）校验', () => {
  const deviceCode = deviceCodeFromParts(hw);
  const newKey = signLicenseKey(
    { machine: deviceCode, machine2: deviceCode, phone: '13800000000', issuedAt: '2026-11-21' },
    PRIV
  );
  assert.equal(verifyLicenseKey(newKey, { publicKeyPem: PUB, deviceCode }).ok, true);
  const other = deviceCodeFromParts({
    ...hw,
    uuid: '11111111-2222-3333-4444-555555555555',
    board: 'OTHER-BOARD',
    disk: 'OTHER-DISK',
    guid: 'other-guid',
  });
  const bad = verifyLicenseKey(newKey, { publicKeyPem: PUB, deviceCode: other });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /设备码/);

  // 老授权：没有 machine2 时继续走 v1 容错
  assert.equal(verify(issue()).ok, true);
});
