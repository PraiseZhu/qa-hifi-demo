// comp-theme.test.mjs — 组件模式主题桥(extractThemeVars)测试。
//
// 新文件,不改已有测试(避免与并行分支合并冲突)。
// 用合成 fixture 锁语义:registerColor 解析鲁棒性、dark 回退、非字面量拒转、
// locatorPattern 唯一命中自检、prefix 过滤、truth 叶子结构。
// 真实 cindy colors.ts 的集成验证结果写在汇报里,不入测试(测试不依赖产品仓)。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractThemeVars, makeLeaf } from '../lib/extract-helpers.mjs';
import { validateTruth } from '../lib/schema.mjs';

function fixture(source, name = 'colors.ts') {
  const dir = mkdtempSync(join(tmpdir(), 'qa-hifi-comp-theme-'));
  const file = join(dir, name);
  writeFileSync(file, source);
  return { dir, file };
}

/** 收集 skipped 而不打 stderr(测试里要断言跳过项,也不想污染输出)。 */
function extract(file, dir, opts = {}) {
  const skipped = [];
  const themeVars = extractThemeVars(file, { demoDir: dir, onSkip: (s) => skipped.push(...s), ...opts });
  return { themeVars, skipped };
}

const BASIC = `
import { registerColor } from './color-registry';
registerColor('surface', {
  light: '#f8f8f6',
  dark: '#1f1f1e',
}, 'Surface 页面背景');
registerColor('surface-hsl', {
  light: '60 12.5% 97%',
  dark: '60 2% 12%',
}, 'HSL 形式');
`;

test('基础提取:token 名 / light / dark 值 + provenance 结构', () => {
  const { dir, file } = fixture(BASIC);
  const { themeVars, skipped } = extract(file, dir);
  assert.deepEqual(Object.keys(themeVars), ['surface', 'surface-hsl']);
  assert.equal(skipped.length, 0);
  assert.equal(themeVars.surface.light.value, '#f8f8f6');
  assert.equal(themeVars.surface.dark.value, '#1f1f1e');
  assert.equal(themeVars['surface-hsl'].light.value, '60 12.5% 97%');
  assert.equal(themeVars['surface-hsl'].dark.value, '60 2% 12%');
  const prov = themeVars.surface.light.provenance;
  assert.equal(prov.source, 'colors.ts', 'source 应是相对 demoDir 的路径');
  assert.match(prov.locator, /surface.*light/);
  assert.match(prov.hash, /^[0-9a-f]{64}$/);
});

test('提取结果直接挂 truth 能过 validateTruth(叶子 + provenance 全合规)', () => {
  const { dir, file } = fixture(BASIC);
  const { themeVars } = extract(file, dir);
  assert.deepEqual(validateTruth({ themeVars }, { demoDir: dir }), []);
});

test('dark 为 null → 按 theme-service 语义回退 light,且不带写回锚', () => {
  const { dir, file } = fixture(`
registerColor('radius', {
  light: '0.5rem',
  dark: null,
}, 'light only');
`);
  const { themeVars, skipped } = extract(file, dir);
  assert.equal(skipped.length, 0);
  assert.equal(themeVars.radius.dark.value, '0.5rem', 'dark 应回退 light 值');
  assert.match(themeVars.radius.dark.provenance.locator, /回退 light/);
  assert.equal(
    themeVars.radius.dark.provenance.locatorPattern,
    undefined,
    '回退叶子在源码里没有对应字面量,给锚会写错位置',
  );
  assert.ok(themeVars.radius.light.provenance.locatorPattern, 'light 仍应有写回锚');
});

test('dark 键完全缺失 → 同样回退 light', () => {
  const { dir, file } = fixture(`registerColor('only-light', { light: '#fff' }, 'x');`);
  const { themeVars } = extract(file, dir);
  assert.equal(themeVars['only-light'].dark.value, '#fff');
  assert.equal(themeVars['only-light'].dark.provenance.locatorPattern, undefined);
});

test('light 是函数调用 → 跳过整个 token,不猜值', () => {
  const { dir, file } = fixture(`
function mk(s) { return \`url(\${s})\`; }
registerColor('cursor-not-allowed', {
  light: mk('#373737'),
  dark: mk('#d4d4d4'),
}, '函数产出');
registerColor('surface', { light: '#fff', dark: '#000' }, 'ok');
`);
  const { themeVars, skipped } = extract(file, dir);
  assert.deepEqual(Object.keys(themeVars), ['surface']);
  assert.deepEqual(skipped.map((s) => [s.id, s.mode]), [['cursor-not-allowed', 'light']]);
  assert.match(skipped[0].reason, /非字面量/);
});

test('light 是 null → 跳过(该 token 在 light 下无值,不该进 themeVars)', () => {
  const { dir, file } = fixture(`
registerColor('dark-only', { light: null, dark: '#000' }, 'x');
registerColor('surface', { light: '#fff', dark: '#000' }, 'ok');
`);
  const { themeVars, skipped } = extract(file, dir);
  assert.deepEqual(Object.keys(themeVars), ['surface']);
  assert.equal(skipped[0].id, 'dark-only');
  assert.match(skipped[0].reason, /null\/未写/);
});

test('dark 是非字面量表达式 → 跳过整个 token,不回退 light(回退会注入假值)', () => {
  const { dir, file } = fixture(`
const D = '#000';
registerColor('half-dynamic', { light: '#fff', dark: D }, 'x');
registerColor('surface', { light: '#fff', dark: '#000' }, 'ok');
`);
  const { themeVars, skipped } = extract(file, dir);
  assert.deepEqual(Object.keys(themeVars), ['surface']);
  assert.deepEqual(skipped.map((s) => [s.id, s.mode]), [['half-dynamic', 'dark']]);
  assert.match(skipped[0].reason, /不敢回退 light/);
});

test('格式鲁棒性:light/dark 之间夹注释、单行写法、双引号、尾随逗号都能解析', () => {
  const { dir, file } = fixture(`
registerColor('with-comment', {
  light: '#e8e8e6',
  // dark 不能用 transparent —— 这行注释里出现 dark 字样,不应干扰解析
  /* 块注释同理 */
  dark: 'rgba(255, 255, 255, 0.08)',
}, 'Hairline');
registerColor("double-quoted", { light: "#111", dark: "#222" }, "单行 + 双引号");
registerColor('trailing', {
  light: '#333',
  dark: '#444',
  }, 'x');
`);
  const { themeVars, skipped } = extract(file, dir);
  assert.equal(skipped.length, 0);
  assert.equal(themeVars['with-comment'].light.value, '#e8e8e6');
  assert.equal(themeVars['with-comment'].dark.value, 'rgba(255, 255, 255, 0.08)');
  assert.equal(themeVars['double-quoted'].light.value, '#111');
  assert.equal(themeVars['double-quoted'].dark.value, '#222');
  assert.equal(themeVars.trailing.dark.value, '#444');
});

test('值里含 CSS 逗号/括号/百分号/转义引号都不截断', () => {
  const { dir, file } = fixture(String.raw`
registerColor('easing', { light: 'cubic-bezier(0.4, 0, 1, 1)', dark: null }, 'x');
registerColor('quoted', { light: 'url("a,b.svg") 16 16, not-allowed', dark: 'none' }, 'x');
registerColor('escaped', { light: 'a\'b', dark: '#000' }, 'x');
`);
  const { themeVars } = extract(file, dir);
  assert.equal(themeVars.easing.light.value, 'cubic-bezier(0.4, 0, 1, 1)');
  assert.equal(themeVars.quoted.light.value, 'url("a,b.svg") 16 16, not-allowed');
  assert.equal(themeVars.escaped.light.value, "a'b");
});

test('无插值的模板字面量按字符串取;带 ${} 的模板判为非字面量', () => {
  const { dir, file } = fixture(
    'const x = 1;\n' +
      'registerColor(\'plain-tpl\', { light: `#abcdef`, dark: `#123456` }, \'x\');\n' +
      'registerColor(\'interp-tpl\', { light: `#${x}`, dark: \'#000\' }, \'x\');\n' +
      "registerColor('surface', { light: '#fff', dark: '#000' }, 'ok');\n",
  );
  const { themeVars, skipped } = extract(file, dir);
  assert.equal(themeVars['plain-tpl'].light.value, '#abcdef');
  assert.equal(themeVars['plain-tpl'].dark.value, '#123456');
  assert.equal(themeVars['interp-tpl'], undefined);
  assert.deepEqual(skipped.map((s) => s.id), ['interp-tpl']);
  // 模板字面量没有 '/" 引号,makeModePattern 自检不过 → 退化成无锚而不是给个错锚
  assert.equal(themeVars['plain-tpl'].light.provenance.locatorPattern, undefined);
});

test('locatorPattern 在源文件里恰命中一次,且捕获组就是该 token 该模式的值', () => {
  const { dir, file } = fixture(`
registerColor('a', { light: '#111', dark: '#222' }, 'x');
registerColor('a-long', { light: '#333', dark: '#444' }, 'id 前缀相同,锚不能串');
registerColor('b', { light: '#111', dark: '#222' }, '值与 a 相同,锚也不能串');
`);
  const { themeVars } = extract(file, dir);
  const src = readFileSync(file, 'utf8');
  for (const [id, modes] of Object.entries(themeVars)) {
    for (const [mode, leaf] of Object.entries(modes)) {
      const pattern = leaf.provenance.locatorPattern;
      assert.ok(pattern, `${id}.${mode} 应有锚`);
      const hits = [...src.matchAll(new RegExp(pattern, 'g'))];
      assert.equal(hits.length, 1, `${id}.${mode} 锚必须恰命中一次(实际 ${hits.length})`);
      assert.equal(hits[0][1], leaf.value, `${id}.${mode} 锚捕获组必须 == 叶子值`);
    }
  }
});

test('prefix 过滤只留匹配前缀的 token', () => {
  const { dir, file } = fixture(`
registerColor('login-panel-bg', { light: '#fff', dark: '#000' }, 'x');
registerColor('login-cta', { light: '#111', dark: '#222' }, 'x');
registerColor('surface', { light: '#333', dark: '#444' }, 'x');
`);
  const { themeVars } = extract(file, dir, { prefix: 'login-' });
  assert.deepEqual(Object.keys(themeVars), ['login-panel-bg', 'login-cta']);
});

test('token 顺序 = 源码注册顺序(门 A extractor-drift 要求可复现)', () => {
  const { dir, file } = fixture(`
registerColor('z', { light: '#1', dark: '#2' }, 'x');
registerColor('a', { light: '#3', dark: '#4' }, 'x');
registerColor('m', { light: '#5', dark: '#6' }, 'x');
`);
  assert.deepEqual(Object.keys(extract(file, dir).themeVars), ['z', 'a', 'm']);
  assert.deepEqual(Object.keys(extract(file, dir).themeVars), ['z', 'a', 'm']);
});

test('一个 registerColor 都没有 → 抛错(解析器失效必须炸,不能静默返回空)', () => {
  const { dir, file } = fixture('export const x = 1;\n');
  assert.throws(() => extract(file, dir), /一个 registerColor\(\.\.\.\) 都没匹配到/);
});

test('prefix 过滤后无可用 token → 抛错并说明是 prefix 过滤掉的', () => {
  const { dir, file } = fixture(BASIC);
  assert.throws(() => extract(file, dir, { prefix: 'nope-' }), /prefix='nope-' 过滤后/);
});

test('全部 token 都不可提取 → 抛错(不返回空 themeVars 假装成功)', () => {
  const { dir, file } = fixture(`
const D = '#000';
registerColor('a', { light: D, dark: D }, 'x');
`);
  assert.throws(() => extract(file, dir), /一个可用 token 都没有/);
});

test('重复注册同一 token → 抛错(产品侧 ColorRegistry 也会抛)', () => {
  const { dir, file } = fixture(`
registerColor('dup', { light: '#1', dark: '#2' }, 'x');
registerColor('dup', { light: '#3', dark: '#4' }, 'x');
`);
  assert.throws(() => extract(file, dir), /注册了两次/);
});

test('源文件不存在 → 明确报错', () => {
  const { dir } = fixture(BASIC);
  assert.throws(() => extract(join(dir, 'nope.ts'), dir), /源文件不存在/);
});

test('未给 onSkip 时跳过项走 stderr 汇总,不静默', () => {
  const { dir, file } = fixture(`
const D = '#000';
registerColor('dyn', { light: D, dark: D }, 'x');
registerColor('surface', { light: '#fff', dark: '#000' }, 'ok');
`);
  const orig = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    extractThemeVars(file, { demoDir: dir });
  } finally {
    console.warn = orig;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /extractThemeVars.*跳过 1 个 token.*dyn/);
});

test('相对路径 colorsFile 按 demoDir 解析', () => {
  const { dir, file } = fixture(BASIC);
  const { themeVars } = extract('colors.ts', dir);
  assert.equal(themeVars.surface.light.value, '#f8f8f6');
  assert.equal(themeVars.surface.light.provenance.hash, makeLeaf('x', file, { locator: 'x', demoDir: dir }).provenance.hash);
});
