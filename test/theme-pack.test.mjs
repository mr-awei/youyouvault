import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_VARS,
  PACK_KIND,
  PACK_VERSION,
  buildThemePack,
  parseThemePack,
  safeCssValue,
} from '../server/lib/theme-pack.js';
import { ALLOWED_VARS as WEB_VARS } from '../web/src/lib/theme-pack-vars.ts';

test('前后端主题变量白名单必须一致', () => {
  assert.deepEqual([...WEB_VARS], ALLOWED_VARS);
});

test('CSS 值：只收颜色 / 长度 / 渐变，注入写法一律拒绝', () => {
  assert.equal(safeCssValue('--accent', '#a1b2c3'), '#a1b2c3');
  assert.equal(safeCssValue('--radius', '12px'), '12px');
  assert.equal(safeCssValue('--gradient', 'linear-gradient(90deg, #fff, #000)'), 'linear-gradient(90deg, #fff, #000)');
  for (const v of [
    'url(https://evil/x)', 'var(--accent)', 'red; background: url(x)',
    '#fff;} body{display:none', 'expression(alert(1))', '<script>', 'a'.repeat(500),
  ]) {
    assert.equal(safeCssValue('--accent', v), null, `本该拒绝：${v.slice(0, 40)}`);
  }
  assert.equal(safeCssValue('--not-allowed', '#fff'), null);
});

test('构建：剔掉不合规字段并在 skipped 里说明', () => {
  const { pack, skipped } = buildThemePack({
    name: '午夜霓虹',
    theme: { base: 'dark', variables: { '--accent': '#ff00aa', '--bg': 'url(x)', '--bogus': '#fff' } },
    assets: [
      { name: 'a.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      { name: 'b.js', dataUrl: 'data:text/javascript;base64,YWxlcnQoMSk=' },
      { name: '../evil.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
  });
  assert.equal(pack.kind, PACK_KIND);
  assert.equal(pack.version, PACK_VERSION);
  assert.equal(pack.theme.base, 'dark');
  assert.deepEqual(pack.theme.variables, { '--accent': '#ff00aa' });
  assert.equal(JSON.stringify(pack).includes('apiKey'), false, '凭据绝不能进包');
  assert.equal(pack.assets.length, 1);
  assert.ok(skipped.length >= 4);
});

test('往返：A 机导出的包，B 机导入后配色与图片都能还原', () => {
  const { pack } = buildThemePack({
    name: '跨机主题',
    theme: { base: 'light', variables: { '--accent': '#123456' }, fontFamily: 'Segoe UI' },
    assets: [{ name: 'cover.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
  });
  const text = JSON.stringify(pack);
  const parsed = parseThemePack(text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.pack.theme.variables['--accent'], '#123456');
  assert.equal(parsed.pack.assets[0].name, 'cover.png');
});

test('作者 / 字体：注入写法必须被剔掉，不能进 --ui-font', () => {
  const bad = buildThemePack({
    author: '<img src=x onerror=alert(1)>',
    theme: { base: 'light', variables: {}, fontFamily: 'Segoe UI; } body{display:none' },
  }).pack;
  assert.equal(bad.author, '');
  assert.equal(bad.theme.fontFamily, '');
  const good = buildThemePack({
    author: '设计师小王',
    theme: { base: 'dark', variables: {}, fontFamily: "'Microsoft YaHei', sans-serif" },
  }).pack;
  assert.equal(good.author, '设计师小王');
  assert.match(good.theme.fontFamily, /Microsoft YaHei/);
});

test('导入：拒绝非主题包、未来版本与坏 JSON', () => {
  assert.match(parseThemePack('{oops').error, /不是合法的 JSON/);
  assert.match(parseThemePack({ kind: 'other', version: 1 }).error, /不是图库主题包/);
  assert.match(parseThemePack({ kind: PACK_KIND, version: PACK_VERSION + 1 }).error, /高于当前支持/);
  assert.match(parseThemePack(null).error, /内容为空/);
});
