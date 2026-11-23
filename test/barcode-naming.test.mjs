import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectDateNaming,
  formatDateFolder,
  suggestDateFolder,
} from '../server/lib/barcode-naming.js';

test('日期命名：从同级目录学习 20261123 紧凑格式', () => {
  const hit = detectDateNaming(['20261103', '20261104', '10月', '20261105', '20261113']);
  assert.equal(hit?.key, 'ymd');
  assert.equal(hit?.count, 4);
  assert.deepEqual(hit?.samples, ['20261103', '20261104', '20261105', '20261113']);
});

test('日期命名：支持短横线 / 下划线 / 点 / 中文格式', () => {
  assert.equal(formatDateFolder('2026-11-23', 'ymd'), '20261123');
  assert.equal(formatDateFolder('2026-11-23', 'ymd-dash'), '2026-11-23');
  assert.equal(formatDateFolder('2026-11-23', 'ymd-underscore'), '2026_11_23');
  assert.equal(formatDateFolder('2026-11-23', 'ymd-dot'), '2026.11.23');
  assert.equal(formatDateFolder('2026-11-23', 'ymd-cn'), '2026年11月23日');
  assert.equal(formatDateFolder('2026-11-23', ''), '2026-11-23');
});

test('日期命名：非法日期不参与学习', () => {
  assert.equal(detectDateNaming(['20261340', '2026-99-99', 'abc']), null);
});

test('日期命名：没有样例时回退标准日期，不假装学过', () => {
  const s = suggestDateFolder(['10月', '11月', '李伟'], '2026-11-23');
  assert.equal(s.name, '2026-11-23');
  assert.equal(s.learned, false);
  assert.equal(s.count, 0);
});

test('日期命名：样例冲突时按固定优先级取第一种', () => {
  const hit = detectDateNaming(['20261103', '2026-11-04']);
  assert.equal(hit?.key, 'ymd');
  assert.equal(hit?.count, 1);
});
