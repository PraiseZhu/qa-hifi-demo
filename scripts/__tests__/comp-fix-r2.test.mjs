// comp-fix-r2.test.mjs — 二修(终审 #1c / #2c / #5c)的对抗回归。
//
//   #1c entry side-effect import 绕过:`import '<entry>'` 让 entry 进图、hash 入链,
//       界面却是 bootstrap 手搓的。build.mjs 给 entry 导出套运行期探针,verify 在门 B
//       挂载后断言「入口组件真被调用过」;探针套不上的形态由 pr-block 诚实降级。
//   #2c manifest 先缩后重跑 verify:component.inputs.json 是可手改 JSON,不能自己当
//       真相源。`node build.mjs --check-inputs` 用 esbuild 现算一遍,verify/pr-block 全等比对;
//       build.mjs 自身 / tailwind config / 读过的 package.json 进 manifest.buildInputs 并入链。
//   #5c 手写 ok:true 资产报告绕闸:pr-block 不再信 report 自报的体积与阀值,自己重算。
//
// 本文件不依赖产品仓的业务代码:自造 mini「产品仓」(含 .git + 真组件源码)+ demo,
// build 用真 esbuild(从 QA_HIFI_MODULE_ROOT / 本 skill 仓解析)。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputHashes, hashFile, safeJsonForScript, stableJson } from '../lib/fs-utils.mjs';
import { validateReportIntegrity } from '../lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
const ASSETS_MANIFEST = join(ROOT, 'scripts/assets-manifest.mjs');
const BUILD_TEMPLATE = join(ROOT, 'templates/component-build.mjs');
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;
const URL_ARG = ['--url', 'https://demo.workers.xd.team'];

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 150000,
  });
}
const env = () => (MODULE_ROOT ? { QA_HIFI_MODULE_ROOT: MODULE_ROOT } : {});
const buildDemo = (dir, extra = []) => run(join(dir, 'build.mjs'), extra, { cwd: dir, env: env() });
const verifyDemo = (dir) => run(VERIFY, ['--demo', dir], { env: env() });
const prBlock = (dir, extra = []) => run(PR_BLOCK, ['--demo', dir, ...URL_ARG, ...extra], { env: env() });
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const manifestOf = (dir) => readJson(join(dir, 'component.inputs.json'));
const readSpec = (dir) => readJson(join(dir, 'spec.json'));
function assetsGate(dir, extra = []) {
  const r = run(ASSETS_MANIFEST, ['--demo', dir, ...extra], { env: env() });
  return r;
}

/** demo 壳:真加载组件 bundle(哨兵只在 bundle 执行时才存在)。 */
function baseHtml(truth) {
  return `<!doctype html><html><head><style>
    .box{width:16px;color:#ff0000;white-space:nowrap}
    #frame{width:16px;height:16px;background:#f00}
  </style></head><body>
  <script id="qa-truth" type="application/json">${safeJsonForScript(truth)}</script>
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

/** entry 的几种形态:决定运行期探针能不能套上。 */
const ENTRY_SRC = {
  // 常规函数组件(带传递依赖):探针可套
  fn: "import { helper } from './Helper';\nexport function Claimed(){ return `CLAIMED-${helper()}`; }\nexport default Claimed;\n",
  // 导出全是常量/纯数据:探针套不上 → 不许判造假,改由 pr-block 降级
  data: "import { helper } from './Helper';\nexport const CLAIMED = { label: 'x', dep: helper };\n",
  // 只有类型导出:编译后无任何运行时内容 → 可被整体 tree-shake
  typeOnly: 'export type Claimed = string;\n',
};
/** 各 entry 形态对应的「目标组件导出名」(r3 起 proved 只认它)。typeOnly 没有运行时导出,
    声明了会被 build 判为「声明的导出不存在」而 exit 2 —— 那不是本用例要测的 tree-shake 语义,故留空。 */
const ENTRY_EXPORT = { fn: 'Claimed', data: 'CLAIMED', typeOnly: null };
/** bootstrap 的几种形态:决定 entry 是「真被渲染」还是只被副作用导入。 */
const BOOT_SRC = {
  render: "import { Claimed } from '../../src/components/Claimed';\nglobalThis.__demo = Claimed();\n",
  sideEffect: "import '../../src/components/Claimed';\nglobalThis.__demo = 'fake-hand-written-ui';\n",
  dataUse: "import { CLAIMED } from '../../src/components/Claimed';\nglobalThis.__demo = CLAIMED.label;\n",
  bareImport: "import '../../src/components/Claimed';\nglobalThis.__demo = 1;\n",
};

function makeFixture({ name, entry = 'fn', boot = 'render', extraAssetBytes = 0, exportName = undefined } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qa-r2-${name}-`));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  writeFileSync(join(repo, 'src/components/Helper.ts'), 'export const helper = () => "helper-v1";\n');
  writeFileSync(join(repo, 'src/components/Claimed.ts'), ENTRY_SRC[entry]);
  writeFileSync(join(repo, 'tailwind.config.js'), 'module.exports = { theme: { colors: { brand: "#ff0000" } } };\n');

  const dir = join(repo, 'qa-demo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  copyFileSync(BUILD_TEMPLATE, join(dir, 'build.mjs'));
  copyFileSync(join(ROOT, 'scripts/lib/extract-helpers.mjs'), join(dir, 'extract-helpers.mjs'));
  copyFileSync(join(ROOT, "scripts/lib/component-build-core.mjs"), join(dir, "component-build-core.mjs"));
  copyFileSync(join(ROOT, "scripts/lib/repo-glob.mjs"), join(dir, "repo-glob.mjs"));
  writeFileSync(join(dir, 'src/bootstrap.ts'), BOOT_SRC[boot]);
  if (extraAssetBytes > 0) writeFileSync(join(dir, 'assets/hero.bin'), Buffer.alloc(extraAssetBytes, 7));

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
      // r3:声明目标组件导出名才可能拿到「真组件直渲」;不声明一律降级(见 comp-fix-r3.test.mjs)
      ...((exportName === undefined ? ENTRY_EXPORT[entry] : exportName) ? { export: exportName === undefined ? ENTRY_EXPORT[entry] : exportName } : {}),
      sources: [],
      bundle: 'assets/component.bundle.js',
      bootstrap: 'src/bootstrap.ts',
      assetsDir: 'assets',
    },
  };
  writeFileSync(join(dir, 'truth.json'), stableJson(truth));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'index.html'), baseHtml(truth));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  return { repo, dir };
}

/** build → verify → 资产闸门,全绿返回;任一步失败当场断言。 */
function greenDemo(dir) {
  assert.equal(buildDemo(dir).status, 0, 'build 应成功');
  const v = verifyDemo(dir);
  assert.equal(v.status, 0, `verify 应先绿:${v.stdout}${v.stderr}`);
  assert.equal(assetsGate(dir).status, 0, '资产闸门应通过');
  return v;
}

// ==================== #1c 运行期哨兵 ====================

test('#1c 复现样本: bootstrap 只做 side-effect import → 门 B 首项 fail 并点名', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置(需要宿主 esbuild)');
  const { dir } = makeFixture({ name: 'side-effect', boot: 'sideEffect' });
  // 审核实证:build 照旧 exit 0(entry 确实在 bundle 里),声明层抓不到
  assert.equal(buildDemo(dir).status, 0, 'side-effect import 下 build 仍应成功(这正是原漏洞)');
  // r3:fixture 声明了 component.export → 哨兵状态是 targeted(比 r2 的 active 更强:只认目标导出)
  assert.equal(manifestOf(dir).entrySentinel, 'targeted', '常规函数组件导出必须能挂上目标哨兵');
  const v = verifyDemo(dir);
  assert.notEqual(v.status, 0, 'side-effect import 居然通过了 verify');
  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.gateB.pass, false);
  assert.equal(report.gateB.entryRenderProof, 'unavailable');
  assert.equal(report.gateB.failures.length, 1, '哨兵只报一次(门 B 首项),不要 N 条重复失败');
  // r3 起报的是「声明的目标导出从未被渲染」(声明了 component.export;未声明的路径见 comp-fix-r3.test.mjs)
  assert.match(report.gateB.failures[0].error, /声明的目标导出从未被渲染/);
  assert.match(report.gateB.failures[0].error, /side-effect import/);
  // 手搓的 UI 字节确实在 bundle 里、真组件也在——两者共存正是这条漏洞的形状
  const bundle = readFileSync(join(dir, 'assets/component.bundle.js'), 'utf8');
  assert.ok(bundle.includes('fake-hand-written-ui') && bundle.includes('CLAIMED'));
});

test('#1c 阳性对照: bootstrap 真调用入口组件 → 哨兵置位、门 B 绿、附贴块声明直渲', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'render-ok' });
  const v = greenDemo(dir);
  assert.equal(readJson(join(dir, 'report.json')).gateB.entryRenderProof, 'proved');
  assert.match(v.stdout, /"ok": true/);
  const pr = prBlock(dir);
  assert.equal(pr.status, 0, `阳性对照被误伤:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /真组件直渲/);
  assert.match(pr.stdout, /运行期哨兵实测声明的目标组件导出被渲染/);
});

test('#1c 探针套不上的形态(导出全是纯数据)→ 不误判造假,附贴块降级为需人工审查', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'unwrappable', entry: 'data', boot: 'dataUse' });
  assert.equal(buildDemo(dir).status, 0);
  const v = verifyDemo(dir);
  assert.equal(v.status, 0, `纯数据导出不该被判造假:${v.stdout}${v.stderr}`);
  assert.equal(readJson(join(dir, 'report.json')).gateB.entryRenderProof, 'unavailable');
  assert.equal(assetsGate(dir).status, 0);
  const pr = prBlock(dir);
  assert.equal(pr.status, 0, `降级不等于阻断:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /产品模块已打包/);
  assert.match(pr.stdout, /需人工审查/);
  assert.ok(!pr.stdout.includes('真组件直渲'), '哨兵没证明就不许宣称真组件直渲');
});

test('#1c tree-shake 样本: entry 只有类型导出、整段没进产物 → build exit 2', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'treeshake', entry: 'typeOnly', boot: 'bareImport' });
  const r = buildDemo(dir);
  assert.equal(r.status, 2, `被整体摇掉的 entry 居然构建成功:${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /被整体 tree-shake/);
  assert.match(r.stdout + r.stderr, /字节数是 0/);
});

test('#1c 手改 bundle 抹掉哨兵 → 门 B 报「bundle 不是当前 build.mjs 产出的」', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'strip-sentinel' });
  assert.equal(buildDemo(dir).status, 0);
  writeFileSync(join(dir, 'assets/component.bundle.js'), 'globalThis.__demo = "hand-written";\n');
  const v = verifyDemo(dir);
  assert.notEqual(v.status, 0, '抹掉哨兵的 bundle 居然过了');
  assert.match(readJson(join(dir, 'report.json')).gateB.failures[0].error, /运行期哨兵未在页面里出现/);
});

// ==================== #2c 输入图独立复算 ====================

test('#2c 复现样本: 缩 manifest 再重跑 verify → 门 A fail 并给出 diff 摘要', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'shrink' });
  greenDemo(dir);
  // 攻击手法:把 Helper.ts 从清单里摘掉,让「改 Helper.ts」不再让 hash 变,然后重跑 verify
  const m = manifestOf(dir);
  assert.ok(m.productInputs.includes('src/components/Helper.ts'));
  m.productInputs = m.productInputs.filter((p) => !p.endsWith('Helper.ts'));
  writeFileSync(join(dir, 'component.inputs.json'), `${JSON.stringify(m, null, 2)}\n`);
  const v = verifyDemo(dir);
  assert.notEqual(v.status, 0, '缩完清单重跑 verify 居然还绿(#2c 未修)');
  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.gateA.pass, false);
  assert.equal(report.gateA.inputsRecheck, 'mismatch');
  assert.match(report.gateA.detail, /独立复算|不一致/);
  assert.match(report.gateA.detail, /Helper\.ts/, '未点名被摘掉的文件');
});

test('#2c 缩 manifest 后直接手写 report 绕 verify → pr-block 同样拒(双保险)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'shrink-pr' });
  greenDemo(dir);
  const report = readJson(join(dir, 'report.json'));
  const m = manifestOf(dir);
  m.productInputs = m.productInputs.filter((p) => !p.endsWith('Helper.ts'));
  writeFileSync(join(dir, 'component.inputs.json'), `${JSON.stringify(m, null, 2)}\n`);
  // 连 report 的 hash 段一起改成「缩链之后」的值,把 hash 一致性这道门也绕掉
  report.inputHashes = buildInputHashes(dir, readSpec(dir));
  writeFileSync(join(dir, 'report.json'), stableJson(report));
  const problems = validateReportIntegrity(dir, readSpec(dir), report);
  assert.ok(problems.some((p) => /独立复算|不一致/.test(p)), `hash 全部对得上却仍应被复算抓住:${JSON.stringify(problems)}`);
  assert.notEqual(prBlock(dir).status, 0, 'pr-block 居然放行了缩链 demo');
});

test('#2c --check-inputs 与落盘 manifest 逐字节一致(同一份规范化实现)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'recheck-eq' });
  assert.equal(buildDemo(dir).status, 0);
  const check = buildDemo(dir, ['--check-inputs']);
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
  assert.equal(check.stdout.trim(), readFileSync(join(dir, 'component.inputs.json'), 'utf8').trim());
  // --check-inputs 不许落任何产物:清单本身不被重写(mtime 之外用内容判等已足够)
  assert.deepEqual(readJson(join(dir, 'component.inputs.json')), JSON.parse(check.stdout));
});

test('#2c 改 build.mjs → 旧 report 被拒(构建器自身入链)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'builder-chain' });
  greenDemo(dir);
  const m = manifestOf(dir);
  assert.ok(m.buildInputs.demo.includes('build.mjs'), 'build.mjs 必须进 buildInputs.demo');
  assert.equal(prBlock(dir).status, 0, '未改动时应放行');
  const before = stableJson(buildInputHashes(dir, readSpec(dir)));
  appendFileSync(join(dir, 'build.mjs'), '// 换一份更宽松的构建器\n');
  assert.notEqual(stableJson(buildInputHashes(dir, readSpec(dir))), before, '改构建器居然没让 hash 变');
  const pr = prBlock(dir);
  assert.notEqual(pr.status, 0, '改了构建器旧 report 居然还能出块');
  assert.match(pr.stdout + pr.stderr, /hash|不一致|重跑/);
});

test('#2c 改 tailwind config → 旧 report 被拒(CSS 输入入链)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { repo, dir } = makeFixture({ name: 'tailwind-chain' });
  assert.equal(buildDemo(dir).status, 0);
  // 产品仓没装 tailwindcss CLI 时不能真编 CSS,但「config 进链」这条不变量可以直接验:
  // 把 build.mjs 现算出的清单加上 css 输入声明,hash 链必须跟着锁住那份 config。
  const m = manifestOf(dir);
  m.buildInputs.product = [...new Set([...m.buildInputs.product, 'tailwind.config.js'])].sort();
  writeFileSync(join(dir, 'component.inputs.json'), `${JSON.stringify(m, null, 2)}\n`);
  const spec = readSpec(dir);
  const before = buildInputHashes(dir, spec);
  assert.match(before.componentSources.buildInputs.product['tailwind.config.js'], /^[0-9a-f]{64}$/, 'tailwind config 必须被真 hash');
  writeFileSync(join(repo, 'tailwind.config.js'), 'module.exports = { theme: { colors: { brand: "#00ff00" } } };\n');
  const after = buildInputHashes(dir, spec);
  assert.notEqual(stableJson(after), stableJson(before), '改 tailwind config 居然没让 hash 变');
  const report = { toolVersion: 'x', inputHashes: before };
  assert.ok(
    validateReportIntegrity(dir, spec, report).some((p) => /输入 hash 与当前/.test(p)),
    '改 config 后旧 report 应被拒',
  );
});

test('#2c 组件 demo 缺 build.mjs → fail-closed(清单无法独立复算)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'no-builder' });
  greenDemo(dir);
  execFileSync('rm', [join(dir, 'build.mjs')]);
  const problems = validateReportIntegrity(dir, readSpec(dir), readJson(join(dir, 'report.json')));
  assert.ok(problems.some((p) => /缺 build\.mjs/.test(p)), `缺构建器未 fail-closed:${JSON.stringify(problems)}`);
});

// ==================== #5c 资产闸门独立重算 ====================

/** 拿一份真实通过的资产报告当基底,再按对抗场景改字段。 */
function assetsReportOf(dir) {
  return readJson(join(dir, 'report-assets.json'));
}
function writeAssetsReport(dir, patch) {
  writeFileSync(join(dir, 'report-assets.json'), stableJson({ ...assetsReportOf(dir), ...patch }));
}

test('#5c 复现样本: 9MB 资产 + 手写 ok:true/totalBytes:0 的报告 → pr-block 拒', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'fake-ok', extraAssetBytes: 9 * 1024 * 1024 });
  assert.equal(buildDemo(dir).status, 0);
  assert.equal(verifyDemo(dir).status, 0);
  // 真闸门会拒(超 8MB 未抬闸),但它照样落盘 ok:false —— 攻击者把它改成 ok:true
  assert.notEqual(assetsGate(dir).status, 0, '9MB 资产应被真闸门拒');
  const real = assetsReportOf(dir);
  assert.equal(real.ok, false);
  writeAssetsReport(dir, { ok: true, totalBytes: 0, problems: undefined });
  const pr = prBlock(dir);
  assert.notEqual(pr.status, 0, '手写 ok:true 居然出块了(#5c 未修)');
  const out = pr.stdout + pr.stderr;
  assert.match(out, /自报 totalBytes=0 与现算/);
  assert.match(out, /超过生效阀/);
});

test('#5c 伪造 effectiveLimit 999 且无抬闸理由 → pr-block 拒', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'fake-limit', extraAssetBytes: 9 * 1024 * 1024 });
  assert.equal(buildDemo(dir).status, 0);
  assert.equal(verifyDemo(dir).status, 0);
  assetsGate(dir);
  const cur = assetsReportOf(dir);
  writeAssetsReport(dir, {
    ok: true,
    problems: undefined,
    effectiveLimitMb: 999,
    effectiveLimitBytes: 999 * 1024 * 1024,
    maxTotalMb: 999,
    totalBytes: cur.totalBytes, // 体积自报如实,只把阀值吹上去
    overrideReason: null,
  });
  const pr = prBlock(dir);
  assert.notEqual(pr.status, 0, '无理由抬闸居然出块了');
  assert.match(pr.stdout + pr.stderr, /抬到 999MB 却没有非空 overrideReason/);
});

test('#5c 真实抬闸(带理由)→ 过闸且附贴块印出理由', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'real-raise', extraAssetBytes: 9 * 1024 * 1024 });
  assert.equal(buildDemo(dir).status, 0);
  assert.equal(verifyDemo(dir).status, 0);
  assert.notEqual(assetsGate(dir).status, 0, '默认阀下 9MB 应先被拒');
  const g = assetsGate(dir, ['--max-total', '12', '--override-reason', '登录页品牌视频首帧必须原分辨率']);
  assert.equal(g.status, 0, `真实抬闸应通过:${g.stdout}${g.stderr}`);
  const pr = prBlock(dir);
  assert.equal(pr.status, 0, `带理由的抬闸被误伤:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /抬闸理由：登录页品牌视频首帧必须原分辨率/);
});

test('#5c 默认阀常量被改 / 未抬闸却挂理由 → pr-block 拒', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'const-drift' });
  greenDemo(dir);
  assert.equal(prBlock(dir).status, 0, '基线应放行');
  writeAssetsReport(dir, { defaultLimitMb: 64 });
  assert.match(prBlock(dir).stdout + prBlock(dir).stderr, /defaultLimitMb=64 与本工具默认闸门 8MB 不一致/);
  writeAssetsReport(dir, { overrideReason: '看起来像有理由' });
  assert.match(prBlock(dir).stdout + prBlock(dir).stderr, /未抬闸.*却带了 overrideReason/s);
});

test('#5c 阳性对照: 小体积资产 + 真跑闸门 → 照常出块(不误伤)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'assets-ok', extraAssetBytes: 1024 });
  greenDemo(dir);
  const pr = prBlock(dir);
  assert.equal(pr.status, 0, `阳性对照被误伤:${pr.stdout}${pr.stderr}`);
  assert.ok(!/assets:/.test(pr.stdout + pr.stderr), '不该报任何资产问题');
});
