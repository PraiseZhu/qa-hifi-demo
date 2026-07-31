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
import { restrictedGlobProblem } from '../lib/repo-glob.mjs';

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
/* r7 条目 14:宿主没有产品仓依赖(esbuild / playwright)时,这些用例**跑不了**,
   必须显式 skip 并说明缺什么 —— 原先它们直接 fail,把「宿主缺依赖」伪装成「实现有 bug」。
   skill 自身故意不 vendor esbuild/playwright(重依赖 + 浏览器二进制),它们由产品仓提供;
   canonical 测试命令一直带 QA_HIFI_MODULE_ROOT,两个真实产品仓下这些用例全部实跑。 */
const NEEDS_PRODUCT_REPO = '需要产品仓提供 esbuild/playwright:设 QA_HIFI_MODULE_ROOT 指向装了依赖的仓(skill 自身不 vendor 这两个重依赖)';
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

// ==================== 条目 1 — P0-1:report.json 整份可手写 ====================

test('P0-1 源码契约(不 skip): pr-block 必须自己重跑 canonical verify,并且不再拿 demo 自报当放行依据', () => {
  const src = readFileSync(join(ROOT, 'scripts/pr-block.mjs'), 'utf8');
  assert.match(src, /CANONICAL_VERIFY\s*=\s*join\(SCRIPT_DIR, 'verify\.mjs'\)/, 'pr-block 必须指向 skill 仓自己的 verify.mjs');
  assert.match(src, /spawnSync\(process\.execPath, \[CANONICAL_VERIFY, '--demo', demoDir, '--report-out'/, 'pr-block 必须真的重跑全门');
  assert.match(src, /trusted-verify:/, '重跑未通过必须落成 problem');
  assert.match(src, /report = trusted;/, '出块数据必须换成可信侧重跑结果');
  // verify 必须支持把报告写到 demo 之外(否则重跑会覆盖被审方的自报材料,对账就没了)
  assert.match(readFileSync(VERIFY, 'utf8'), /--report-out/);
});

test('P0-1 根因固定(不 skip): 手写的全绿 report 能通过全部静态完整性校验——所以静态层本身不构成证明', (t) => {
  if (!MODULE_ROOT) return t.skip('component 防伪链复算需要真 esbuild');
  const { dir, spec } = makeFixture({ name: 'forged-static', boot: 'hold', repoDeps: true });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  writeForgedReport(dir, spec);
  const problems = validateReportIntegrity(dir, spec, readJson(join(dir, 'report.json')));
  assert.deepEqual(problems, [], `静态层如果能拦住手写 report,这条 P0 就不成立了;实际:${JSON.stringify(problems)}`);
});

test('P0-1 复现样本: 真 build + 只持引用不调用 + 手搓 UI + 完全不跑 verify + 手写全绿 report → pr-block 必须拒', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir, spec } = makeFixture({ name: 'forged-report', boot: 'hold', repoDeps: true });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  // bundle 是真的(entry 真进图),UI 是手搓的
  assert.ok(readFileSync(join(dir, 'assets/component.bundle.js'), 'utf8').includes('HAND_WRITTEN_ONLY'));
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0, '资产闸门是真跑的');
  writeForgedReport(dir, spec);

  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 2, `手写全绿 report 居然出了块(P0-1 未修):${pr.stdout}${pr.stderr}`);
  assert.ok(!pr.stdout.includes('真组件直渲'), '绝不能打出「真组件直渲」');
  assert.match(pr.stdout, /trusted-verify/, '必须点名是可信侧重跑没过,而不是别的偶然原因');
  assert.match(pr.stdout, /声明的目标导出从未被渲染|门/, '可信侧重跑的失败详情要带出来');
});

test('P0-1 对账: report 自报与可信侧重跑结论不一致(自报 proved,实际 nontarget)→ 阻断', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir, spec } = makeFixture({ name: 'reconcile', boot: 'real', repoDeps: true });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  // 真报告已存在且为 proved;把它改成 nontarget(自报与实际不一致的最小扰动,hash 不变)
  const real = readJson(join(dir, 'report.json'));
  real.gateB.entryRenderProof = 'nontarget';
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(real, null, 2)}\n`);
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 2, `自报与可信侧不一致必须阻断:${pr.stdout}`);
  assert.match(pr.stdout, /trusted-report: demo 的 report\.json 与可信侧重跑结论不一致/);
});

test('P0-1 阳性对照: 真跑 verify + 真调用目标导出 → pr-block 仍 exit 0 且写「真组件直渲」', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({ name: 'p01-ok', boot: 'real', repoDeps: true });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  assert.equal(run(VERIFY, ['--demo', dir], { env: env() }).status, 0);
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 0, `可信侧重跑误伤了正常路径:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /真组件直渲/);
});

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

// ==================== 条目 4 — #1c:封印可精确仿造 ====================

test('#1c 源码契约(不 skip): 封印之外必须叠加 bundle 字节全等 + pageerror + challenge 三层', () => {
  const core = readFileSync(CORE, 'utf8');
  const verify = readFileSync(VERIFY, 'utf8');
  // (c) challenge:回应必须绑定 verify 传入的不可预测 nonce
  assert.match(core, /Object\.defineProperty\(__qaSeal, "prove"/, '哨兵必须提供 challenge 回应方法');
  assert.match(core, /nonce: String\(__n\)/, 'prove 必须回显调用方给的 nonce');
  assert.match(verify, /randomBytes|randomUUID/, 'verify 必须生成不可预测 challenge');
  assert.match(verify, /哨兵未按 challenge 回应/);
  // (b) pageerror fail-closed
  assert.match(verify, /pageerror/);
  assert.match(verify, /bundle 初始化期页面抛错/);
  // (a) 可信侧重算 bundle 字节
  assert.match(verify, /recheckComponentOutputs|recheckComponentBundle/);
  assert.match(readFileSync(join(ROOT, 'scripts/lib/fs-utils.mjs'), 'utf8'), /--check-outputs|--check-bundle/);
});

test('#1c bundle 字节全等(不 skip 逻辑层): 手改 bundle 一个字节 → 可信侧复算不等,门 A 红', (t) => {
  if (!MODULE_ROOT) return t.skip('复算需要真 esbuild');
  const { dir } = makeFixture({ name: 'bundle-bytes', boot: 'real', repoDeps: true });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const bundle = join(dir, 'assets/component.bundle.js');
  writeFileSync(bundle, `${readFileSync(bundle, 'utf8')}\n/* tampered */\n`);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, '手改 bundle 居然还能过 verify');
  assert.match(`${v.stdout}${v.stderr}`, /字节与可信侧复算结果不一致/);
});

test('#1c 复现样本: index.html 预占精确同形假封印(含 prove)+ 目标不调用 → verify 必红、非 proved、无「真组件直渲」', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({ name: 'preseal', boot: 'hold', repoDeps: true, preSeal: true });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, `预占同形封印居然通过了 verify(#1c 未修):${v.stdout}`);
  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.gateB.pass, false);
  assert.notEqual(report.gateB.entryRenderProof, 'proved', '伪造的封印仍被采信');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 2);
  assert.ok(!pr.stdout.includes('真组件直渲'));
});

test('#1c 阳性对照: 真调用目标导出 → 仍 proved(封印 + challenge + 字节复算三层都不误伤)', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({ name: 'seal-ok', boot: 'real', repoDeps: true });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  assert.equal(readJson(join(dir, 'report.json')).gateB.entryRenderProof, 'proved');
});

// ==================== 条目 5 — #2c-b:字符类 glob ====================

test('#2c-b 纯函数层(不 skip): 字符类/brace/否定/extglob 一律拒,标准 glob 放行', () => {
  const rejected = [
    '[ab].tsx', 'src/[ab]/*.tsx', 'src/x].tsx', '{a,b}/*.tsx', 'src/{a,b}.tsx',
    '!src/skip.tsx', 'src/!(a).tsx', '+(a|b).tsx', '@(a|b).tsx', '(a|b).tsx',
    '/abs/path.tsx', '../escape.tsx', 'src\\win.tsx', 'a,b.tsx',
  ];
  for (const p of rejected) assert.ok(restrictedGlobProblem(p), `未拒绝危险 pattern:${p}`);
  const accepted = ['src/**/*.tsx', 'src/*.ts', 'src/a?c.ts', 'src/components/Button.tsx', 'src/中文目录/*.ts', 'a-b_c.1/*.js'];
  for (const p of accepted) assert.equal(restrictedGlobProblem(p), null, `误杀合法 pattern:${p}`);
});

test('#2c-b 复现样本(不 skip): 字面 [ab].tsx 入链零命中 / Tailwind 实扫 a·b → 构建核心 fail-closed', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  // 攻击形状:仓里放字面文件名 `[ab].tsx`(入链零命中即放行),而 Tailwind 的
  // fast-glob/micromatch 把它当字符类 → 实扫 a.tsx / b.tsx,改 a/b 不改 hash、旧 CSS 照过。
  const { dir } = makeFixture({
    name: 'charclass',
    css: { tailwindConfig: 'tailwind.config.js', content: ['src/[ab].tsx'] },
    extraRepoFiles: {
      'src/[ab].tsx': 'export const literal = "literal";\n',
      'src/a.tsx': 'export const a = "bg-blue-500";\n',
      'src/b.tsx': 'export const b = "bg-green-500";\n',
    },
  });
  const r = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 2, `字符类 glob 被放行了(#2c-b 未修):${out}`);
  assert.match(out, /会被 Tailwind 当 glob 解释|字符类/);
  assert.match(out, /\[/, '报文应点出触发的元字符');
});

test('#2c-b verify/schema 层也拦得住(不 skip)', () => {
  const { dir } = makeFixture({ name: 'charclass-verify', css: { tailwindConfig: 'tailwind.config.js', content: ['src/[ab].tsx'] } });
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0);
  assert.match(`${v.stdout}${v.stderr}`, /component\.css\.content/);
});

test('#2c-b 阳性对照(不 skip): 标准 glob 仍能展开并逐一入 buildInputs.product', () => {
  const { dir } = makeFixture({ name: 'charclass-ok', css: { tailwindConfig: 'tailwind.config.js', content: ['src/StyleOnly.tsx'] } });
  const r = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });
  if (r.status !== 0) {
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /受限 glob/, '合法 glob 被误杀');
    return;
  }
  assert.ok(JSON.parse(r.stdout).buildInputs.product.includes('src/StyleOnly.tsx'));
});
