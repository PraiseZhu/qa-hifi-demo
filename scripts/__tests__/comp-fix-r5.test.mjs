// comp-fix-r5.test.mjs — 五轮终审「连根收口」的对抗回归。
//
// 统一病根:**安全证据由不可信的 demo 侧产生,验证方直接信**。r1-r4 逐点补丁一直被绕
// (哨兵 → 全局量可写 → 闭包封印 → 封印协议可精确仿造;解析链 → 只清了 esbuild/ts 漏了
// playwright;report → 整份可手写)。r5 立总原则:
//   **凡是放行依据,必须由 skill 可信侧亲自执行/重算得到;demo 目录产出的文件至多用于对账。**
//
// 本文件五组:
//   P0-1  report.json 整份可手写 → pr-block 可信侧重跑全门,自报只用于对账
//   P0-2  playwright 解析链 RCE(demo/node_modules/playwright 顶层代码在 verify 进程内执行)
//         + demo node_modules 检查前移成无条件 fail-fast(不限组件模式)
//   #2c-a findDemoNodeModules 的 depth>8 静默停止(声明「任意子目录即拒」名不副实)
//   #1c   封印可精确仿造 → bundle 字节全等复算 + pageerror fail-closed + 不可预测 challenge
//   #2c-b 字符类 glob(`[ab].tsx` 入链零命中、Tailwind 实扫 a/b)→ 白名单式受限 glob
//
// 分层说明(诚实标注):端到端 PoC 需要真 esbuild + playwright(项目 canonical 测试命令
// 一直带 QA_HIFI_MODULE_ROOT,因此实跑);零依赖的源码契约/纯函数断言一律不 skip。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputHashes, checkDemoNoNodeModules, hashFile, safeJsonForScript, stableJson, TOOL_VERSION } from '../lib/fs-utils.mjs';
import { validateReportIntegrity } from '../lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CORE = join(ROOT, 'scripts/lib/component-build-core.mjs');
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
const ASSETS_MANIFEST = join(ROOT, 'scripts/assets-manifest.mjs');
const BUILD_FILES = [
  ['templates/component-build.mjs', 'build.mjs'],
  ['scripts/lib/component-build-core.mjs', 'component-build-core.mjs'],
  ['scripts/lib/extract-helpers.mjs', 'extract-helpers.mjs'],
  ['scripts/lib/repo-glob.mjs', 'repo-glob.mjs'],
];
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;
const env = () => (MODULE_ROOT ? { QA_HIFI_MODULE_ROOT: MODULE_ROOT } : {});
function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 300000,
  });
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

const ENTRY = [
  "import { helper } from './Helper';",
  'export function Claimed(){ return `CLAIMED-${helper()}`; }',
  '',
].join('\n');

/** 只持引用(绕过 tree-shake 护栏)但**从不调用**+ 手搓 UI —— P0-1 / #1c 的攻击载荷。 */
const BOOT_HOLD_ONLY = [
  "import { Claimed } from '../../src/components/Claimed';",
  'globalThis.keep = Claimed;',
  "globalThis.__demo = 'HAND_WRITTEN_ONLY';",
  '',
].join('\n');
const BOOT_REAL = "import { Claimed } from '../../src/components/Claimed';\nglobalThis.__demo = Claimed();\n";

function baseHtml(truth, { preSeal = false } = {}) {
  /* #1c 的精确仿造:bundle 加载**之前**抢先挂一个同形封印——不可写/不可配置的全局,
     其上 snapshot 是不可配置的 get-only 访问器,返回冻结对象且形状与真哨兵逐字段一致。
     真 bundle 随后的 defineProperty 会抛错(属性已不可配置),r4 的 verify 不听
     pageerror,于是读到的是这份假 getter → proved + 「真组件直渲」。 */
  const fake = preSeal
    ? `<script>
      var seal = {};
      Object.defineProperty(seal, 'snapshot', { enumerable: false, configurable: false, get: function () {
        return Object.freeze({ rendered: true, targetRendered: true,
          shape: Object.freeze({ total: 1, wrappable: 1, targetWrappable: 1, target: 'Claimed', sentinel: true }) });
      } });
      seal.prove = function (n) {
        return Object.freeze({ nonce: String(n), rendered: true, targetRendered: true,
          shape: Object.freeze({ total: 1, wrappable: 1, targetWrappable: 1, target: 'Claimed', sentinel: true }) });
      };
      Object.freeze(seal);
      Object.defineProperty(globalThis, '__QA_ENTRY_SENTINEL__', { value: seal, writable: false, configurable: false, enumerable: false });
      </script>`
    : '';
  return `<!doctype html><html><head><style>
    .box{width:16px;color:#ff0000;white-space:nowrap}
    #frame{width:16px;height:16px;background:#f00}
  </style></head><body>
  <script id="qa-truth" type="application/json">${safeJsonForScript(truth)}</script>
  ${fake}
  <script src="assets/component.bundle.js"></script>
  <button data-qa-pref="plat:desk">desk</button><button data-qa-pref="region:cn">cn</button>
  <button data-qa-pref="os:ios">ios</button><button data-qa-pref="mode:light">light</button><button data-qa-pref="lang:zh-CN">zh</button>
  <button id="noop">noop</button><div class="box">x</div><div id="tick">0</div><input id="code">
  <div id="frame" class="frame"></div>
  <script>
  const S={step:'id',prefs:{plat:'desk',region:'cn',os:'ios',mode:'light',lang:'zh-CN'},tick:0};
  window.__qa={
    current:()=>S.step,
    goto:(id)=>{ if(id!=='id') throw new Error('unknown'); S.step=id; },
    prefs:()=>({...S.prefs}),
    scale:()=>1,
    resize:(w,h)=>{ document.querySelector('#frame').style.width=w+'px'; document.querySelector('#frame').style.height=h+'px'; },
    metrics:()=>{ const r=document.querySelector('#frame').getBoundingClientRect(); return {frame:{w:r.width,h:r.height},probes:{}}; }
  };
  </script></body></html>`;
}

/** mini 产品仓 + 组件模式 demo。repoDeps=true 时把宿主 node_modules 挂到**产品仓**(真 build 需要)。 */
function makeFixture({ name, boot = 'hold', css, repoDeps = false, preSeal = false, extraRepoFiles = {} } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qa-r5-${name}-`));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  writeFileSync(join(repo, 'src/components/Helper.ts'), 'export const helper = () => "helper-v1";\n');
  writeFileSync(join(repo, 'src/components/Claimed.ts'), ENTRY);
  writeFileSync(join(repo, 'src/StyleOnly.tsx'), 'export const cls = "bg-red-500";\n');
  writeFileSync(join(repo, 'tailwind.config.js'), "module.exports = { content: ['./src/StyleOnly.tsx'], theme: {} };\n");
  for (const [rel, body] of Object.entries(extraRepoFiles)) {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  if (repoDeps) symlinkSync(join(MODULE_ROOT, 'node_modules'), join(repo, 'node_modules'));

  const dir = join(repo, 'qa-demo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  for (const [from, to] of BUILD_FILES) copyFileSync(join(ROOT, from), join(dir, to));
  writeFileSync(join(dir, 'src/bootstrap.ts'), boot === 'hold' ? BOOT_HOLD_ONLY : BOOT_REAL);

  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
  const leaf = (value, locator) => ({ value, provenance: { source: 'source.txt', locator, hash: hashFile(source) } });
  const truth = { geometry: { width: leaf(16, 'width constant') }, colors: { text: leaf('#ff0000', 'text color') } };
  const spec = {
    meta: { name, summary: { what: 'what', how: 'how', accept: 'accept' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: { cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [{ expect: 'id' }] }], noClip: ['.box'] },
    bindings: [],
    component: {
      mode: 'component',
      entry: 'src/components/Claimed.ts',
      export: 'Claimed',
      sources: [],
      bundle: 'assets/component.bundle.js',
      bootstrap: 'src/bootstrap.ts',
      assetsDir: 'assets',
      ...(css !== undefined ? { css } : {}),
    },
  };
  writeFileSync(join(dir, 'truth.json'), stableJson(truth));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'index.html'), baseHtml(truth, { preSeal }));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  return { repo, dir, spec };
}

/**
 * 攻击者手写的「全绿」report.json:inputHashes 用**可导出的** buildInputHashes()
 * 对自己控制的文件现算(天然自洽),各门统计自洽,gateB.entryRenderProof='proved'。
 * 机器上完全没跑 verify——这正是 P0-1 的形状。
 */
function writeForgedReport(demoDir, spec) {
  const report = {
    ok: true,
    partial: false,
    toolVersion: TOOL_VERSION,
    demo: spec.meta.name,
    inputHashes: buildInputHashes(demoDir, spec),
    statesResult: { total: 1, viaReachable: 1, tabOnly: 0 },
    coverage: { cases: [{ id: 'desk-cn-light', prefs: spec.verify.cases[0].prefs, source: 'spec' }] },
    gateA: { name: '真值一致', pass: true, detail: '', provenance: 'required', extractorDrift: 'none', inputsRecheck: 'ok' },
    gateB: { name: '状态覆盖', pass: true, total: 1, passed: 1, failures: [], cases: [], entryRenderProof: 'proved' },
    gateC: { name: '交互鲁棒', pass: true, checks: [{ id: 'no-clip', pass: true, failures: [] }], cases: [] },
    gateD: { name: '渲染绑定', pass: true, total: 0, passed: 0, failures: [], cases: [], detail: '组件模式' },
    gateF: { name: '适配还原', pass: true, total: 0, passed: 0, failures: [], cases: [] },
    gateX: { name: '自定义门', pass: true, total: 0, passed: 0, failures: [], gates: [], detail: '未声明 customGates' },
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(demoDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// ==================== 条目 2 — P0-2:playwright 解析链 RCE + fail-fast ====================

test('P0-2 源码契约(不 skip): playwright 解析候选不含 startDir/cwd 等 demo 派生路径', () => {
  const src = readFileSync(join(ROOT, 'scripts/lib/resolve-playwright.mjs'), 'utf8');
  const block = src.slice(src.indexOf('function candidateDirs'), src.indexOf('export function resolveModule'));
  for (const bad of ['startDir,', 'process.cwd()', 'process.env.INIT_CWD']) {
    assert.ok(!block.includes(bad), `解析候选里仍有不可信路径 ${bad}(P0-2 未修)`);
  }
  assert.match(block, /QA_HIFI_MODULE_ROOT/);
  assert.match(block, /PLAYWRIGHT_MODULE_ROOT/);
  // 兜底:解析到 demo 子树里的模块一律拒
  assert.match(src, /解析到了 demo 目录内的模块/);
});

test('P0-2 复现样本(经典模式,无条件生效): demo/node_modules/playwright 顶层落 PWNED → verify 在启动浏览器前 fail-fast', () => {
  // 经典模式(非组件模式)——r4 的 fail-closed 只挂在组件模式的 recheck 上,这里覆盖全部 demo
  const repo = mkdtempSync(join(tmpdir(), 'qa-r5-rce-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const dir = join(repo, 'qa-demo');
  mkdirSync(dir, { recursive: true });
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
  const leaf = (value, locator) => ({ value, provenance: { source: 'source.txt', locator, hash: hashFile(source) } });
  const truth = { geometry: { width: leaf(16, 'w') }, colors: { text: leaf('#ff0000', 'c') } };
  const spec = {
    meta: { name: 'rce', summary: { what: 'w', how: 'h', accept: 'a' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: { cases: [{ id: 'c1', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [{ expect: 'id' }] }], noClip: ['.box'] },
    bindings: [],
  };
  writeFileSync(join(dir, 'truth.json'), stableJson(truth));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'index.html'), baseHtml(truth).replace('<script src="assets/component.bundle.js"></script>', ''));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  // 恶意依赖:顶层 execSync + 落盘。CJS 顶层代码在 import 时同步执行。
  const pkgDir = join(dir, 'node_modules/playwright');
  mkdirSync(pkgDir, { recursive: true });
  const pwned = join(repo, 'PWNED.txt');
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'playwright', version: '9.9.9', main: 'index.js' }));
  writeFileSync(
    join(pkgDir, 'index.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(pwned)}, 'pwned');\n`
    + `require('node:child_process').execSync('id > ${pwned}.id');\n`
    + 'module.exports = { chromium: { launch: async () => { throw new Error("nope"); } } };\n',
  );

  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, `demo 自带 node_modules 必须 fail-fast:${v.stdout}${v.stderr}`);
  assert.match(`${v.stdout}${v.stderr}`, /node_modules/);
  assert.ok(!existsSync(pwned), 'PWNED.txt 落盘了 —— demo 侧代码在 verify 进程内被执行(P0-2 未修)');
  assert.ok(!existsSync(`${pwned}.id`), 'execSync 真跑了 —— RCE 未修');
});

test('P0-2 fail-fast 必须早于浏览器/动态 import(不 skip,源码契约)', () => {
  const src = readFileSync(VERIFY, 'utf8');
  const guard = src.indexOf('checkDemoNoNodeModules');
  assert.ok(guard > 0, 'verify 必须无条件调用 checkDemoNoNodeModules');
  assert.ok(guard < src.indexOf('launchChromium('), 'node_modules 检查必须在启动浏览器之前');
  assert.ok(guard < src.indexOf('const schemaProblems'), 'node_modules 检查必须在任何 demo 输入解析/执行之前');
  // 命中即退出,不是标红后继续
  assert.match(src.slice(guard, guard + 500), /failProblems|process\.exit/);
});

test('#2c-a 深度纵深(不 skip): demo/d0/../d8/node_modules(9 层)必须被检出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-r5-depth-'));
  let cur = dir;
  for (let i = 0; i < 9; i += 1) {
    cur = join(cur, `d${i}`);
    mkdirSync(cur);
  }
  mkdirSync(join(cur, 'node_modules'));
  const problems = checkDemoNoNodeModules(dir);
  assert.equal(problems.length, 1, '深度上限让 9 层深的 node_modules 逃过检查(#2c-a 未修)');
  assert.match(problems[0], /d0\/d1\/d2\/d3\/d4\/d5\/d6\/d7\/d8\/node_modules/);
});

test('#2c-a 源码契约(不 skip): 不再有硬编码深度上限', () => {
  const src = readFileSync(join(ROOT, 'scripts/lib/fs-utils.mjs'), 'utf8');
  const fn = src.slice(src.indexOf('function findDemoNodeModules'), src.indexOf('export function checkDemoBuilderIntegrity'));
  assert.ok(!/depth\s*>\s*\d+/.test(fn), '仍有 depth > N 的静默停止(#2c-a 未修)');
});

test('#2c-a 阳性对照(不 skip): 干净 demo 不误杀,node_modules 内部不下钻', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-r5-clean-'));
  mkdirSync(join(dir, 'src/deep/deeper'), { recursive: true });
  writeFileSync(join(dir, 'src/deep/deeper/a.ts'), 'export const a = 1;\n');
  assert.deepEqual(checkDemoNoNodeModules(dir), []);
});

