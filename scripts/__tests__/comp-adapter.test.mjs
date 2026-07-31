// comp-adapter.test.mjs — 组件模式 __qa 适配层(templates/qa-component-adapter.js)+ spec.states[].driver 校验。
// 新文件,不改其他测试(避免与并行分支合并冲突)。
//
// 浏览器组说明:适配层是**运行时**合约,只能在真浏览器里验(主题桥写 style/class、
// goto 分流、chrome DOM 合约、mount 只跑一次)。playwright 按 skill 的 resolve 规则解析宿主
// node_modules(本机:QA_HIFI_MODULE_ROOT=<装了 playwright 的项目>);解析不到时整组 skip
// 并如实标注——与门 B-F 在无 playwright 时降级的惯例一致。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateSpec } from '../lib/schema.mjs';
import { launchChromium } from '../lib/resolve-playwright.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ADAPTER = readFileSync(join(ROOT, 'templates/qa-component-adapter.js'), 'utf8');
const CHROME = readFileSync(join(ROOT, 'templates/qa-chrome.js'), 'utf8');

// ---------------------------------------------------------------- schema: driver 枚举

function baseSpec(states) {
  return {
    matrix: { platforms: ['desk'], regions: ['global'], systems: ['mac'], themes: ['light', 'dark'], langs: ['zh-CN'] },
    states,
    verify: { noClip: ['.frame'] },
  };
}
const viaStep = [{ click: '.go' }, { expect: 'entry' }];

test('schema: driver 缺省(复刻模式)照旧通过', () => {
  const problems = validateSpec(baseSpec([{ id: 'entry', via: viaStep }]));
  assert.deepEqual(problems.filter((p) => p.includes('driver')), []);
});

test('schema: driver 只允许 inject|via', () => {
  for (const d of ['inject', 'via']) {
    const problems = validateSpec(baseSpec([{ id: 'entry', driver: d, via: viaStep }]));
    assert.deepEqual(problems.filter((p) => p.includes('driver')), [], `driver:${d} 应合法`);
  }
  const bad = validateSpec(baseSpec([{ id: 'entry', driver: 'goto', via: viaStep }]));
  assert.ok(bad.some((p) => p.includes('driver 只允许')), `应拒绝 driver:"goto",实际:${JSON.stringify(bad)}`);
  const wrongType = validateSpec(baseSpec([{ id: 'entry', driver: true, via: viaStep }]));
  assert.ok(wrongType.some((p) => p.includes('driver 只允许')), 'driver 非 string 也应被拒');
});

test('schema: driver:"via" 的 tab-only 状态被拒(既不能注入也没到达路径)', () => {
  const problems = validateSpec(baseSpec([
    { id: 'entry', via: viaStep },
    { id: 'sso', driver: 'via', via: null, tab: '状态补齐', note: '局部 useState' },
  ]));
  assert.ok(problems.some((p) => p.includes('必须同时声明 via 链路')), JSON.stringify(problems));
});

test('schema: driver:"inject" 的 tab-only 状态合法(注入型可用状态补齐直达)', () => {
  const problems = validateSpec(baseSpec([
    { id: 'entry', via: viaStep },
    { id: 'error', driver: 'inject', via: null, tab: '状态补齐', note: 'reducer failed 注入' },
  ]));
  assert.deepEqual(problems.filter((p) => p.includes('driver')), [], JSON.stringify(problems));
});

// ---------------------------------------------------------------- fixture: 假「真组件」

/* 假组件 = 一个由 store 驱动、把 state 写进 DOM 的极小组件(替 React 树占位)。
 * 它的关键性质与真组件一致:① 自己持有渲染;② 局部状态('sso-org')只能由自身
 * 交互改,外部注入不到;③ inject() 推的是 store。 */
const FIXTURE_BUNDLE = `
window.__qaFixture = { mountCount: 0, injects: [], prefsCalls: [], local: null };
(() => {
  let store = 'entry';
  let host = null;
  const paint = () => {
    if (!host) return;
    host.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'cmp-state';
    label.dataset.qaProbe = 'label';
    label.textContent = window.__qaFixture.local ?? store;
    host.appendChild(label);
    const btn = document.createElement('button');
    btn.className = 'cmp-local-btn';
    btn.textContent = 'sso';
    // 局部状态:只能靠这个真实点击到达(外部无 setter)
    btn.addEventListener('click', () => { window.__qaFixture.local = 'sso-org'; paint(); });
    host.appendChild(btn);
  };
  window.__qaDemo = {
    mode: 'component',
    name: 'fixture-comp',
    pr: 7,
    summary: { what: 'w', how: 'h', accept: 'a' },
    matrix: {
      plat:   { label: '端',   options: [{ v: 'desk', label: '桌面' }] },
      region: { label: '区域', options: [{ v: 'global', label: '全球' }] },
      os:     { label: '系统', options: [{ v: 'mac', label: 'mac' }] },
      mode:   { label: '主题', options: [{ v: 'light', label: '亮' }, { v: 'dark', label: '暗' }] },
      lang:   { label: '语言', options: [{ v: 'zh-CN', label: '中文' }, { v: 'ja', label: '日本語' }] },
    },
    defaultPrefs: { plat: 'desk', region: 'global', os: 'mac', mode: 'light', lang: 'zh-CN' },
    initialState: 'entry',
    states: {
      entry: { driver: 'inject' },
      error: { driver: 'inject' },
      'sso-org': { driver: 'via' },
    },
    tabStates: [{ id: 'error', label: '错误态', note: 'reducer failed 注入' }],
    adaptive: { min: { w: 400, h: 300 }, initial: { w: 800, h: 600 } },
    scale: (prefs) => (prefs.plat === 'desk' ? 0.5 : 1),
    mount(ctx) {
      window.__qaFixture.mountCount += 1;
      host = document.createElement('div');
      host.className = 'cmp-host';
      ctx.root.appendChild(host);
      paint();
    },
    inject(id) {
      window.__qaFixture.injects.push(id);
      store = id;
      window.__qaFixture.local = null;
      paint();
    },
    onPrefs(prefs) { window.__qaFixture.prefsCalls.push(prefs); },
  };
})();
`;

const TRUTH = {
  themeVars: {
    'login-panel-bg': {
      light: { value: '#FBFBFB', provenance: { source: 'themes/colors.ts', locator: 'registerColor', hash: 'x' } },
      dark: { value: '#1B1E25', provenance: { source: 'themes/colors.ts', locator: 'registerColor', hash: 'x' } },
    },
    'login-title-text': {
      light: { value: '#252222', provenance: { source: 'themes/colors.ts', locator: 'registerColor', hash: 'x' } },
      dark: { value: '#E8EAED', provenance: { source: 'themes/colors.ts', locator: 'registerColor', hash: 'x' } },
    },
  },
};

// 内联进 <script> 的 JS 里若出现字面 "</script"(注释举例就会),HTML 解析器会提前闭合脚本。
const inlineSafe = (js) => js.replace(/<\/script/gi, '<\\/script');

function writeFixture({ bundle = FIXTURE_BUNDLE, truth = TRUTH } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-hifi-comp-adapter-'));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
<script id="qa-truth" type="application/json">${JSON.stringify(truth).replace(/<\/script>/gi, '<\\/script>')}</script>
</head><body>
<script>${inlineSafe(bundle)}</script>
<script>${inlineSafe(ADAPTER)}</script>
<script>${inlineSafe(CHROME)}</script>
</body></html>`;
  writeFileSync(join(dir, 'index.html'), html);
  return pathToFileURL(join(dir, 'index.html')).href;
}

// ---------------------------------------------------------------- 浏览器组

let browser = null;
let launchError = null;
try {
  ({ browser } = await launchChromium(ROOT));
} catch (err) {
  launchError = err.message.split('\n')[0];
}
const browserOnly = browser ? {} : { skip: `playwright/chromium 不可用:${launchError}(可设 QA_HIFI_MODULE_ROOT=<装了 playwright 的项目>)` };

test.after(async () => { if (browser) await browser.close(); });

async function openFixture(opts) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(writeFixture(opts), { waitUntil: 'load' });
  return { page, errors };
}

test('组件模式:chrome DOM 合约与复刻模式一致 + 组件挂在 .frame 内', browserOnly, async () => {
  const { page, errors } = await openFixture();
  assert.deepEqual(errors, [], '加载不应有 pageerror');
  assert.equal(await page.locator('.frame').count(), 1);
  assert.equal(await page.locator('[data-qa-pref="mode:dark"]').count(), 1, '偏好入口 data-qa-pref 必须存在');
  assert.equal(await page.locator('[data-qa-state-tab]').count(), 1, '状态补齐 tab 必须存在');
  await page.click('[data-qa-state-tab]');
  assert.equal(await page.locator('[data-qa-goto="error"]').count(), 1, '状态入口 data-qa-goto 必须存在');
  // 组件根在 .frame 内部(容器 .qa-component-root),不是替换 .frame
  assert.equal(await page.locator('.frame .qa-component-root .cmp-host').count(), 1);
  assert.equal(await page.evaluate(() => window.__qaFixture.mountCount), 1, 'mount 只应跑一次');
  await page.close();
});

test('主题桥:themeVars 复刻为 CSS 变量 + html.dark + colorScheme,随 mode 偏好切换', browserOnly, async () => {
  const { page } = await openFixture();
  const light = await page.evaluate(() => ({
    css: document.getElementById('theme-vars')?.textContent ?? '',
    dark: document.documentElement.classList.contains('dark'),
    scheme: document.documentElement.style.colorScheme,
    resolved: getComputedStyle(document.documentElement).getPropertyValue('--login-panel-bg').trim(),
    tokens: window.__qaComponentAdapter.themeTokenCount(),
    mode: window.__qaComponentAdapter.themeMode(),
  }));
  assert.match(light.css, /--login-panel-bg:#FBFBFB;/);
  assert.equal(light.resolved, '#FBFBFB', 'CSS 变量必须真的落到 :root 上');
  assert.equal(light.dark, false);
  assert.equal(light.scheme, 'light');
  assert.equal(light.tokens, 2);
  assert.equal(light.mode, 'light');

  await page.click('[data-qa-pref="mode:dark"]');
  const dark = await page.evaluate(() => ({
    resolved: getComputedStyle(document.documentElement).getPropertyValue('--login-panel-bg').trim(),
    dark: document.documentElement.classList.contains('dark'),
    scheme: document.documentElement.style.colorScheme,
    mode: window.__qaComponentAdapter.themeMode(),
  }));
  assert.equal(dark.resolved, '#1B1E25', '切暗色后变量必须换成 dark 值');
  assert.equal(dark.dark, true);
  assert.equal(dark.scheme, 'dark');
  assert.equal(dark.mode, 'dark');
  await page.close();
});

test('主题桥:mode-优先形状(themeVars.light.<token>)同样支持', browserOnly, async () => {
  const truth = {
    themeVars: {
      light: { 'x-bg': { value: '#FFFFFF', provenance: { source: 'a.ts', locator: 'l', hash: 'h' } } },
      dark: { 'x-bg': { value: '#000000', provenance: { source: 'a.ts', locator: 'l', hash: 'h' } } },
    },
  };
  const { page } = await openFixture({ truth });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--x-bg').trim()), '#FFFFFF');
  await page.click('[data-qa-pref="mode:dark"]');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--x-bg').trim()), '#000000');
  await page.close();
});

test('主题桥:缺 themeVars 时如实降级(不写 style#theme-vars,仍切 dark class)', browserOnly, async () => {
  const { page, errors } = await openFixture({ truth: { other: { value: 1, provenance: { source: 'a.ts', locator: 'l', hash: 'h' } } } });
  assert.deepEqual(errors, []);
  const st = await page.evaluate(() => ({
    hasStyle: Boolean(document.getElementById('theme-vars')),
    tokens: window.__qaComponentAdapter.themeTokenCount(),
    scheme: document.documentElement.style.colorScheme,
  }));
  assert.equal(st.hasStyle, false, '没有色值就不该造一个空的 theme-vars 假装应用了主题');
  assert.equal(st.tokens, 0);
  assert.equal(st.scheme, 'light');
  await page.close();
});

test('__qa:current/prefs/scale/resize 语义与 qa-chrome 一致', browserOnly, async () => {
  const { page } = await openFixture();
  assert.equal(await page.evaluate(() => window.__qa.current()), 'entry');
  assert.deepEqual(await page.evaluate(() => window.__qa.prefs()), { plat: 'desk', region: 'global', os: 'mac', mode: 'light', lang: 'zh-CN' });
  assert.equal(await page.evaluate(() => window.__qa.scale()), 0.5);
  // resize 走 setFrameSize(含 adaptive.min clamp);量 clientWidth 而非 boundingRect
  //(.frame 有 1px 边框,boundingRect 会多 2px——这里验的是帧内容尺寸)
  const frameBox = () => page.evaluate(() => { const f = document.querySelector('.frame'); return { w: f.clientWidth, h: f.clientHeight }; });
  await page.evaluate(() => window.__qa.resize(1000, 700));
  assert.deepEqual(await frameBox(), { w: 1000, h: 700 });
  await page.evaluate(() => window.__qa.resize(100, 100));
  assert.deepEqual(await frameBox(), { w: 400, h: 300 }, 'resize 必须被 adaptive.min 钳制');
  // metrics 探针仍可用(probe 在组件内部)
  assert.equal(await page.evaluate(() => window.__qa.metrics(['label']).probes.label !== null), true);
  await page.close();
});

test('__qa.goto:inject 型状态经 __qaDemo.inject 推真组件', browserOnly, async () => {
  const { page } = await openFixture();
  const before = await page.evaluate(() => window.__qaFixture.injects.slice());
  assert.deepEqual(before, ['entry'], '首帧 initialState 也应真注入');
  await page.evaluate(() => window.__qa.goto('error'));
  assert.equal(await page.evaluate(() => window.__qa.current()), 'error');
  assert.deepEqual(await page.evaluate(() => window.__qaFixture.injects.slice()), ['entry', 'error']);
  assert.equal(await page.locator('.cmp-state').textContent(), 'error', '组件必须真的渲染到该状态');
  assert.equal(await page.evaluate(() => window.__qaFixture.mountCount), 1, 'goto 不得重挂组件(会丢局部 useState)');
  await page.close();
});

test('__qa.goto:via 型状态显式拒绝(只能 via 链路到达)', browserOnly, async () => {
  const { page } = await openFixture();
  const err = await page.evaluate(() => { try { window.__qa.goto('sso-org'); return null; } catch (e) { return String(e.message); } });
  assert.match(err ?? '', /只能 via 链路到达/);
  assert.equal(await page.evaluate(() => window.__qa.current()), 'entry', '被拒的 goto 不得改变状态');
  assert.deepEqual(await page.evaluate(() => window.__qaFixture.injects.slice()), ['entry'], '被拒的 goto 不得调 inject');
  // 真实交互链路仍能到达该局部状态
  await page.click('.cmp-local-btn');
  assert.equal(await page.locator('.cmp-state').textContent(), 'sso-org');
  await page.close();
});

test('__qa.goto:未声明状态必须 throw', browserOnly, async () => {
  const { page } = await openFixture();
  const err = await page.evaluate(() => { try { window.__qa.goto('nope'); return null; } catch (e) { return String(e.message); } });
  assert.match(err ?? '', /unknown state "nope"/);
  assert.deepEqual(await page.evaluate(() => window.__qaFixture.injects.slice()), ['entry']);
  await page.close();
});

test('状态补齐 tab 点击也走真注入(不只 goto 路径)', browserOnly, async () => {
  const { page } = await openFixture();
  await page.click('[data-qa-state-tab]');
  await page.click('[data-qa-goto="error"]');
  assert.equal(await page.evaluate(() => window.__qa.current()), 'error');
  assert.deepEqual(await page.evaluate(() => window.__qaFixture.injects.slice()), ['entry', 'error'], 'tab 直达也必须把真组件推到该状态');
  assert.equal(await page.locator('.cmp-state').textContent(), 'error');
  await page.close();
});

test('偏好变化经 onPrefs 下发给组件(主题由适配层接管)', browserOnly, async () => {
  const { page } = await openFixture();
  await page.click('[data-qa-pref="lang:ja"]');
  const calls = await page.evaluate(() => window.__qaFixture.prefsCalls.map((p) => p.lang));
  assert.ok(calls.includes('ja'), `onPrefs 应收到 lang=ja,实际:${JSON.stringify(calls)}`);
  await page.close();
});

test('配置错误 fail-closed:mode 非 component / 缺 mount / 自带 renderApp / driver 非法 / via 进 tab', browserOnly, async () => {
  const cases = [
    ['mode 非 component', `window.__qaDemo = { mode: 'replica', mount(){}, states: {} };`, /mode 必须是 "component"/],
    ['缺 mount', `window.__qaDemo = { mode: 'component', states: {} };`, /mount\(ctx\) 必填/],
    ['自带 renderApp', `window.__qaDemo = { mode: 'component', mount(){}, renderApp(){}, states: {} };`, /不接受自带 renderApp/],
    ['driver 非法', `window.__qaDemo = { mode: 'component', mount(){}, states: { a: { driver: 'goto' } } };`, /driver 只允许/],
    ['inject 型缺 inject()', `window.__qaDemo = { mode: 'component', mount(){}, states: { a: {} } };`, /但未提供 __qaDemo.inject/],
    ['via 型进 tabStates', `window.__qaDemo = { mode: 'component', mount(){}, inject(){}, states: { a: { driver: 'via' } }, tabStates: [{ id: 'a' }] };`, /tabStates 含 driver:"via"/],
  ];
  for (const [label, bundle, re] of cases) {
    const { page, errors } = await openFixture({ bundle });
    assert.ok(errors.some((e) => re.test(e)), `${label}:应抛错匹配 ${re},实际:${JSON.stringify(errors)}`);
    await page.close();
  }
});
