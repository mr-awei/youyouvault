/**
 * OMS 登录 + 授权绑定的纯逻辑测试（不触网、不碰真实账号文件）。
 *
 * 规则：登录成功且授权手机号 == OMS 账号才算 Pro；会话过期 / 未登录 / 账号不一致
 * 都必须退回免费版。试用与开发模式不走这条判断，由 licenseStatus 自己处理。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { omsSessionMatchesLicense } from '../server/lib/license.js';

test('OMS 已登录且手机号一致 → 可以升级 Pro', () => {
  assert.equal(omsSessionMatchesLicense({ loggedIn: true, username: '13800000000' }, '13800000000'), true);
  assert.equal(omsSessionMatchesLicense({ loggedIn: true, username: '138 0000 0000' }, '13800000000'), true);
});

test('会话过期 / 未登录 → 立即退回免费版', () => {
  assert.equal(omsSessionMatchesLicense({ loggedIn: false, username: '13800000000' }, '13800000000'), false);
  assert.equal(omsSessionMatchesLicense({}, '13800000000'), false);
  assert.equal(omsSessionMatchesLicense(null, '13800000000'), false);
});

test('OMS 账号与授权手机号不一致 → 不开 Pro', () => {
  assert.equal(omsSessionMatchesLicense({ loggedIn: true, username: '13900000000' }, '13800000000'), false);
  assert.equal(omsSessionMatchesLicense({ loggedIn: true, username: '' }, '13800000000'), false);
  assert.equal(omsSessionMatchesLicense({ loggedIn: true, username: '13800000000' }, ''), false);
});
