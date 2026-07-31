// comp-metafile.test.mjs — 审核 P0 #1/#2 的对抗回归:
//   #1 声明的 entry 没被 bundle import(bootstrap 手搓假 UI)→ build 必须 exit 2;
//   #2 作者自报窄 sources、bundle 真实输入更宽 → 改「未声明但真被 bundle 读到」的源文件,
//      旧 report 必须被 pr-block 拒(真相源 = component.inputs.json,不是自报清单)。
// 另外覆盖:篡改 manifest 自身 → 拒;缺 manifest → 拒;阳性对照不误伤。
//
// 本文件不依赖产品仓:用一个自造的 mini「产品仓」(含 .git + 真组件源码)+ demo,
// build 用真 esbuild(从 QA_HIFI_MODULE_ROOT / 本 skill 仓解析)。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputHashes, checkDeclaredComponentSources, hashFile, safeJsonForScript, stableJson } from '../lib/fs-utils.mjs';
import { validateReportIntegrity } from '../lib/report.mjs';
import { templateExtractor } from './_extractor-template.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
const ASSETS_MANIFEST = join(ROOT, 'scripts/assets-manifest.mjs');
// 合并调和:审核 P1#5 后 pr-block 强制资产闸门报告(组件 demo 的 bundle 落在 assets/),
// 集成用例在 verify 后补跑,否则被资产门拦下而非本用例想测的门。
function assetsGate(dir, env) {
  const r = run(ASSETS_MANIFEST, ['--demo', dir], { env });
  assert.equal(r.status, 0, `资产闸门应通过:${r.stdout}${r.stderr}`);
}
const BUILD_TEMPLATE = join(ROOT, 'templates/component-build.mjs');
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 150000,
  });
}

function baseHtml(truth) {
  return `<!doctype html><html><head><style>
    .box{width:16px;color:#ff0000;white-space:nowrap}
    #frame{width:16px;height:16px;background:#f00}
  </style></head><body>
  <script id="qa-truth" type="application/json">${safeJsonForScript(truth)}</script>
  <!-- 组件 bundle 必须真被页面加载:运行期哨兵(__QA_ENTRY_RENDERED__)只在 bundle 执行时才存在,
       页面不加载 bundle 就谈不上「真组件直渲」——门 B 会当场判否。 -->
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

/**
 * 造 mini 产品仓 + demo。产品侧有 3 个真源文件(Claimed 是「声明的 entry」,
 * Helper/Deep 是 entry 的传递依赖 —— 作者的窄 sources 里故意不写它们)。
 * bootstrap 决定真实 import 谁:'real' → import Claimed;'fake' → 手搓 UI 不 import。
 */
function makeFixture({ name, bootstrap = 'real', sources = [] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qa-metafile-${name}-`));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  writeFileSync(join(repo, 'src/components/Deep.ts'), 'export const DEEP = "deep-v1";\n');
  writeFileSync(join(repo, 'src/components/Helper.ts'), "import { DEEP } from './Deep';\nexport const helper = () => `helper-${DEEP}`;\n");
  writeFileSync(
    join(repo, 'src/components/Claimed.ts'),
    "import { helper } from './Helper';\nexport const claimed = () => `CLAIMED-${helper()}`;\n",
  );

  const dir = join(repo, 'qa-demo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  copyFileSync(BUILD_TEMPLATE, join(dir, 'build.mjs'));
  copyFileSync(join(ROOT, 'scripts/lib/extract-helpers.mjs'), join(dir, 'extract-helpers.mjs'));
  copyFileSync(join(ROOT, "scripts/lib/component-build-core.mjs"), join(dir, "component-build-core.mjs"));
  copyFileSync(join(ROOT, "scripts/lib/repo-glob.mjs"), join(dir, "repo-glob.mjs"));
  writeFileSync(
    join(dir, 'src/bootstrap.ts'),
    bootstrap === 'real'
      ? "import { claimed } from '../../src/components/Claimed';\nglobalThis.__demo = claimed();\n"
      : "globalThis.__demo = 'fake-hand-written-ui';\n",
  );

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
      // 目标组件导出名:r3 起「真组件直渲」结论只认这个导出被调用(见 pr-block/verify 哨兵)
      export: 'claimed',
      sources,
      bundle: 'assets/component.bundle.js',
      bootstrap: 'src/bootstrap.ts',
      assetsDir: 'assets',
    },
  };
  writeFileSync(join(dir, 'truth.json'), stableJson(truth));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'index.html'), baseHtml(truth));
    /* r10 fixture 忠实化:与 init.mjs 生成的官方模板**同形**(import 兄弟
       ./extract-helpers.mjs)。此前是自包含单文件,于是「可信副本搬走脚本后相对 import 断」
       这类真实使用路径缺陷在全绿下测不出来。 */
  writeFileSync(join(dir, 'extract.mjs'), templateExtractor(truth));
  copyFileSync(join(ROOT, 'scripts/lib/extract-helpers.mjs'), join(dir, 'extract-helpers.mjs'));
  return { repo, dir };
}

const buildDemo = (dir) => run(join(dir, 'build.mjs'), [], { cwd: dir, env: MODULE_ROOT ? { QA_HIFI_MODULE_ROOT: MODULE_ROOT } : {} });
const readSpec = (dir) => JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'component.inputs.json'), 'utf8'));

// ============ ① 审核实证一:entry 没被 import → build exit 2 ============

test('build: bootstrap 不 import 声明的 entry → exit 2 并点名「未被 bundle」', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置(需要产品仓的 esbuild)');
  const { dir } = makeFixture({ name: 'fake-boot', bootstrap: 'fake' });
  const r = buildDemo(dir);
  assert.equal(r.status, 2, `手搓 bootstrap 居然构建成功:${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /未被 bundle/);
  assert.match(r.stdout + r.stderr, /Claimed\.ts/);
  // bundle 里确实没有真组件字节(审核原实证:含 fake、不含 CLAIMED)
  const bundle = readFileSync(join(dir, 'assets/component.bundle.js'), 'utf8');
  assert.ok(bundle.includes('fake-hand-written-ui'));
  assert.ok(!bundle.includes('CLAIMED'));
});

test('build: bootstrap 真 import entry → 成功,manifest 含 entry 与传递依赖', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'real-boot' });
  const r = buildDemo(dir);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = manifestOf(dir);
  assert.deepEqual(m.productInputs, ['src/components/Claimed.ts', 'src/components/Deep.ts', 'src/components/Helper.ts']);
  assert.deepEqual(m.demoInputs, ['src/bootstrap.ts']);
  assert.equal(m.entry, 'src/components/Claimed.ts');
});

// ============ ② 审核实证二:自报窄集不再决定链的范围 ============

test('hash 真相源是 manifest:改「未声明但真被 bundle 读到」的源文件 → hash 变', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  // 作者只声明 entry 一个文件(审核里的 14 vs 42 场景的最小复现)
  const { repo, dir } = makeFixture({ name: 'narrow', sources: ['src/components/Claimed.ts'] });
  assert.equal(buildDemo(dir).status, 0);
  const spec = readSpec(dir);
  const before = JSON.stringify(buildInputHashes(dir, spec));
  writeFileSync(join(repo, 'src/components/Deep.ts'), 'export const DEEP = "deep-v2";\n');
  assert.notEqual(JSON.stringify(buildInputHashes(dir, spec)), before, '改未声明的真实输入居然没让 hash 变(#2 未修)');
});

test('pr-block: 改未声明但真被 bundle 读到的源文件 → 旧 report 被拒', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { repo, dir } = makeFixture({ name: 'narrow-e2e', sources: ['src/components/Claimed.ts'] });
  assert.equal(buildDemo(dir).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env });
  assert.equal(v.status, 0, `verify 必须先绿:${v.stdout}${v.stderr}`);
  assetsGate(dir, env);
  const ok = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(ok.status, 0, `未篡改时应放行:${ok.stdout}${ok.stderr}`);
  // 附贴块的 N 来自 manifest 真实输入(3 个),不是自报的 1 个
  assert.match(ok.stdout, /真组件直渲（3 个源文件 hash 入链，运行期哨兵实测声明的目标组件导出被渲染）/);
  writeFileSync(join(repo, 'src/components/Helper.ts'), "import { DEEP } from './Deep';\nexport const helper = () => `tampered-${DEEP}`;\n");
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(pr.status, 2, `改未声明的真实输入居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /hash|不一致|重跑/);
});

// ============ ③ 篡改 manifest 自身 / 缺 manifest → 拒 ============

test('篡改 manifest(删掉真实输入)→ manifest 自身 hash 变,旧 report 被拒', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeFixture({ name: 'tamper-manifest' });
  assert.equal(buildDemo(dir).status, 0);
  assert.equal(run(VERIFY, ['--demo', dir], { env }).status, 0);
  assetsGate(dir, env);
  const m = manifestOf(dir);
  m.productInputs = ['src/components/Claimed.ts']; // 缩小链范围,想让改 Deep.ts 不被发现
  writeFileSync(join(dir, 'component.inputs.json'), `${JSON.stringify(m, null, 2)}\n`);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(pr.status, 2, `篡改清单居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /hash|不一致|重跑/);
});

test('缺 manifest → NO_MANIFEST fail-closed(report 层直接拒并给修法)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeFixture({ name: 'no-manifest' });
  assert.equal(buildDemo(dir).status, 0);
  assert.equal(run(VERIFY, ['--demo', dir], { env }).status, 0);
  assetsGate(dir, env);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  rmSync(join(dir, 'component.inputs.json'));
  const problems = validateReportIntegrity(dir, readSpec(dir), report);
  assert.ok(problems.some((p) => /NO_MANIFEST/.test(p)), `缺清单未 fail-closed:${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => /build\.mjs/.test(p)), '未给出修法');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(pr.status, 2, `缺清单居然出块:${pr.stdout}${pr.stderr}`);
});

test('manifest 结构非法(productInputs 空)→ 同样 NO_MANIFEST', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'empty-manifest' });
  assert.equal(buildDemo(dir).status, 0);
  writeFileSync(join(dir, 'component.inputs.json'), JSON.stringify({ productInputs: [] }));
  const h = buildInputHashes(dir, readSpec(dir));
  assert.equal(h.componentSources.manifest, 'NO_MANIFEST');
});

// ============ ④ 声明层校验:sources 必须 ⊆ 真实输入 ============

test('checkDeclaredComponentSources: 声明了未被 bundle 读到的源文件 → problem', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { repo, dir } = makeFixture({ name: 'stray-decl' });
  writeFileSync(join(repo, 'src/components/Unused.ts'), 'export const UNUSED = 1;\n');
  assert.equal(buildDemo(dir).status, 0);
  const spec = readSpec(dir);
  spec.component.sources = ['src/components/Unused.ts'];
  const problems = checkDeclaredComponentSources(dir, spec.component);
  assert.ok(problems.some((p) => /Unused\.ts/.test(p)), `未被 bundle 读到的声明居然放行:${JSON.stringify(problems)}`);
});

test('checkDeclaredComponentSources: 合法窄声明(⊆ 真实输入)不报 + entry 缺失时报', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'ok-decl', sources: ['src/components/*.ts'] });
  assert.equal(buildDemo(dir).status, 0);
  const spec = readSpec(dir);
  assert.deepEqual(checkDeclaredComponentSources(dir, spec.component), []);
  // entry 换成一个没进 bundle 的文件 → 必须报(与 build 侧同一条不变量的 report 侧兜底)
  const m = manifestOf(dir);
  m.productInputs = m.productInputs.filter((p) => !p.endsWith('Claimed.ts'));
  writeFileSync(join(dir, 'component.inputs.json'), `${JSON.stringify(m, null, 2)}\n`);
  assert.ok(checkDeclaredComponentSources(dir, spec.component).some((p) => /不在 bundle 真实输入里/.test(p)));
});

// ============ ⑤ 阳性对照:健康组件 demo 照常放行 ============

test('阳性对照: manifest 齐全 + 未篡改 → verify 绿、pr-block 出块(不误伤)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeFixture({ name: 'healthy', sources: ['src/components/*.ts'] });
  assert.equal(buildDemo(dir).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env });
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  assetsGate(dir, env);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(pr.status, 0, `健康 demo 被误伤:${pr.stdout}${pr.stderr}`);
  assert.ok(!/防伪链未锁住/.test(pr.stdout + pr.stderr));
  assert.match(pr.stdout, /真组件直渲/);
});
