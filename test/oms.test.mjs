/**
 * OMS 客户端的纯逻辑：地址规范化与 salesSku 去重。
 * 不触网 —— 登录与查询在真实环境里验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseUrl, uniqueSalesSkus } from '../server/lib/oms.js';

test('normalizeBaseUrl：去掉尾部斜杠并保留协议', () => {
  assert.equal(normalizeBaseUrl('https://sit.uyoyous.com/'), 'https://sit.uyoyous.com');
  assert.equal(normalizeBaseUrl('https://sit.uyoyous.com/oms-test-api/'), 'https://sit.uyoyous.com/oms-test-api');
  assert.equal(normalizeBaseUrl(''), 'https://sit.uyoyous.com');
});

test('normalizeBaseUrl：拒绝非 http/https 地址', () => {
  assert.throws(() => normalizeBaseUrl('ftp://example.com'), /http/);
  assert.throws(() => normalizeBaseUrl('not a url'), /不合法/);
});

test('uniqueSalesSkus：同一完整编码只保留一条，并保留产品名', () => {
  const rows = uniqueSalesSkus([
    { salesSku: '45739-Y01M0002-A02', productName: 'A' },
    { salesSku: ' 45739-Y01M0002-A02 ', productName: 'B' },
    { salesSku: '45739-Y01D0001-C03', productName: 'C' },
    { salesSku: '' },
  ]);
  assert.deepEqual(
    rows.map((r) => r.salesSku),
    ['45739-Y01M0002-A02', '45739-Y01D0001-C03']
  );
  assert.equal(rows[0].productName, 'A');
});

test('uniqueSalesSkus：空输入返回空数组', () => {
  assert.deepEqual(uniqueSalesSkus(null), []);
  assert.deepEqual(uniqueSalesSkus([]), []);
});
