// comp-fix-r3.test.mjs — 三修(终审三轮 #1c / #2c-a / #2c-b)的对抗回归。
//
//   #1c 「调 entry 里的非组件工具函数」被 r2 哨兵误判为真组件直渲:
//       审核人实证 entry 同时导出组件 Claimed() 与工具函数 utility(),bootstrap 只调
//       utility() + 手搓 UI → entryRenderProof='proved'、PR 块写「真组件直渲」。
//       r3:proved 只认 spec.component.export 声明的目标导出被调用;其余一律降级。
//   #2c-a 复算 oracle 是 demo 内可手改的 build.mjs:审核人把它换成「--check-inputs 时
//       原样打印现有 component.inputs.json」的脚本,缩清单后 verify/pr-block 全绿。
//       r3:复算跑 skill 仓自己的 component-build-core,且 demo 侧构建期文件 hash
//       必须等于 canonical,不等 → fail-closed「检测到自定义构建器」。
//
//   #2c-b tailwind content 命中的文件不入链:改样式源文件 hash 不变,旧 CSS+旧 report 照过。
//       r3:content 每个 glob 按 repoRoot 展开、逐文件进 buildInputs.product;零命中或
//       非标准 glob 一律 exit 2。
//
// 与 comp-fix-r2 同构:自造 mini「产品仓」(含 .git + 真组件源码)+ demo,真 esbuild。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputHashes, checkDemoBuilderIntegrity, hashFile, safeJsonForScript, stableJson } from '../lib/fs-utils.mjs';
import { validateReportIntegrity } from '../lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
const ASSETS_MANIFEST = join(ROOT, 'scripts/assets-manifest.mjs');
const CORE = join(ROOT, 'scripts/lib/component-build-core.mjs');
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
    timeout: opts.timeout ?? 150000,
  });
}
const buildDemo = (dir, extra = []) => run(join(dir, 'build.mjs'), extra, { cwd: dir, env: env() });
const verifyDemo = (dir) => run(VERIFY, ['--demo', dir], { env: env() });
const prBlock = (dir) => run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
const assetsGate = (dir) => run(ASSETS_MANIFEST, ['--demo', dir], { env: env() });
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const manifestOf = (dir) => readJson(join(dir, 'component.inputs.json'));
const readSpec = (dir) => readJson(join(dir, 'spec.json'));

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

/**
 * 审核人的 #1c 样本:entry 同时导出**组件** Claimed() 与**工具函数** utility()。
 * bootstrap 形态决定谁被调用 —— 这正是 r2 哨兵分不出的两种情况。
 */
const ENTRY_MIXED = [
  "import { helper } from './Helper';",
  'export function Claimed(){ return `CLAIMED-${helper()}`; }',
  "export function utility(){ return 'just-a-util'; }",
  '',
].join('\n');
const BOOT = {
  // 只调工具函数 + 手搓 UI(审核人的 exploit)
  utilityOnly: "import { utility } from '../../src/components/Claimed';\nglobalThis.__demo = 'FAKE-UI-' + utility();\n",
  // 真渲染目标组件
  renderTarget: "import { Claimed } from '../../src/components/Claimed';\nglobalThis.__demo = Claimed();\n",
};

function makeFixture({ name, boot = 'utilityOnly', exportName = null, css = null, styleFiles = {} } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qa-r3-${name}-`));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  writeFileSync(join(repo, 'src/components/Helper.ts'), 'export const helper = () => "helper-v1";\n');
  writeFileSync(join(repo, 'src/components/Claimed.ts'), ENTRY_MIXED);
  writeFileSync(join(repo, 'tailwind.config.js'), 'module.exports = { theme: {} };\n');
  for (const [rel, body] of Object.entries(styleFiles)) {
    mkdirSync(join(repo, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }

  const dir = join(repo, 'qa-demo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  for (const [from, to] of BUILD_FILES) copyFileSync(join(ROOT, from), join(dir, to));
  writeFileSync(join(dir, 'src/bootstrap.ts'), BOOT[boot]);

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
      ...(exportName ? { export: exportName } : {}),
      sources: [],
      bundle: 'assets/component.bundle.js',
      bootstrap: 'src/bootstrap.ts',
      assetsDir: 'assets',
      ...(css ? { css } : {}),
    },
  };
  writeFileSync(join(dir, 'truth.json'), stableJson(truth));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'index.html'), baseHtml(truth));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  return { repo, dir };
}

/** skill 侧构建核心直算(不落产物):#2c-b 的清单断言不需要 tailwind CLI。 */
const coreCheck = (dir) => run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });

// ==================== #1c 目标导出哨兵 ====================

test('#1c 复现样本: 只调 entry 的工具函数 + 未声明 export → 绝不出现「真组件直渲」', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置(需要宿主 esbuild)');
  const { dir } = makeFixture({ name: 'util-nodecl', boot: 'utilityOnly' });
  assert.equal(buildDemo(dir).status, 0, 'build 应成功(entry 确实在 bundle 里——这正是漏洞形状)');
  assert.equal(manifestOf(dir).entrySentinel, 'active', '未声明 export 时哨兵只做「一个都没调」的硬失败');
  assert.equal(manifestOf(dir).entryExport, null);
  const v = verifyDemo(dir);
  assert.equal(v.status, 0, `调了工具函数不构成造假,不该拦 verify:${v.stdout}${v.stderr}`);
  // r2 在这里给的是 'proved' —— 那是假话;r3 只到 nontarget
  assert.equal(readJson(join(dir, 'report.json')).gateB.entryRenderProof, 'nontarget');
  assert.equal(assetsGate(dir).status, 0);
  const pr = prBlock(dir);
  assert.equal(pr.status, 0, `降级不等于阻断:${pr.stdout}${pr.stderr}`);
  assert.ok(!pr.stdout.includes('真组件直渲'), '只调工具函数居然还宣称真组件直渲(#1c 未修)');
  assert.match(pr.stdout, /产品模块已打包/);
  assert.match(pr.stdout, /需人工审查/);
  // 手搓 UI 与真组件共存 = 这条漏洞的形状,固定住它
  const bundle = readFileSync(join(dir, 'assets/component.bundle.js'), 'utf8');
  assert.ok(bundle.includes('FAKE-UI-') && bundle.includes('CLAIMED-'));
});

test('#1c 声明了 export 但只调工具函数 → 门 B 硬失败并点名目标导出', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'util-decl', boot: 'utilityOnly', exportName: 'Claimed' });
  assert.equal(buildDemo(dir).status, 0);
  assert.equal(manifestOf(dir).entrySentinel, 'targeted');
  const v = verifyDemo(dir);
  assert.notEqual(v.status, 0, '声明的目标组件从未渲染居然通过了 verify');
  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.gateB.pass, false);
  assert.equal(report.gateB.failures.length, 1, '哨兵只报一次(门 B 首项)');
  assert.match(report.gateB.failures[0].error, /声明的目标导出从未被渲染/);
  assert.match(report.gateB.failures[0].error, /component\.export="Claimed"/);
  assert.match(report.gateB.failures[0].error, /调工具函数不等于渲染组件/);
  assert.notEqual(prBlock(dir).status, 0, 'report 未过居然还能出块');
});

test('#1c 声明了不存在的导出 → build exit 2(错误声明不许静默降级)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'bad-export', boot: 'renderTarget', exportName: 'NotThere' });
  const r = buildDemo(dir);
  assert.equal(r.status, 2, `声明了不存在的导出居然构建成功:${r.stdout}${r.stderr}`);
  // build 的输出是 JSON,双引号被转义 —— 断言绕开引号只匹配语义部分
  assert.match(r.stdout + r.stderr, /component\.export.*NotThere.* 在 component\.entry/);
  assert.match(r.stdout + r.stderr, /Claimed, utility/, '未列出真实导出名供作者改正');
});

test('#1c 阳性对照: 声明 export 且真渲染它 → proved + 附贴块写真组件直渲', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'target-ok', boot: 'renderTarget', exportName: 'Claimed' });
  assert.equal(buildDemo(dir).status, 0);
  const v = verifyDemo(dir);
  assert.equal(v.status, 0, `阳性对照被误伤:${v.stdout}${v.stderr}`);
  assert.equal(readJson(join(dir, 'report.json')).gateB.entryRenderProof, 'proved');
  assert.equal(assetsGate(dir).status, 0);
  const pr = prBlock(dir);
  assert.equal(pr.status, 0, `${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /真组件直渲/);
  assert.match(pr.stdout, /运行期哨兵实测声明的目标组件导出被渲染/);
});

// ==================== #2c-a 复算 oracle 归 skill 侧 ====================

/** 审核人的 exploit:build.mjs 换成「--check-inputs 就回显现有清单」的自证脚本。 */
const ECHO_BUILDER = [
  "import { readFileSync } from 'node:fs';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'const d = dirname(fileURLToPath(import.meta.url));',
  "if (process.argv.includes('--check-inputs')) process.stdout.write(readFileSync(join(d, 'component.inputs.json'), 'utf8'));",
  '',
].join('\n');

test('#2c-a 复现样本: 伪 build.mjs 回显旧清单 + 缩清单 → 门 A fail-closed「自定义构建器」', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'echo-builder', boot: 'renderTarget', exportName: 'Claimed' });
  assert.equal(buildDemo(dir).status, 0);
  assert.equal(verifyDemo(dir).status, 0, '基线应先绿');
  // 攻击:先缩清单(把 Helper.ts 摘掉,改它不再让 hash 变),再把 oracle 换成回显脚本
  const m = manifestOf(dir);
  assert.ok(m.productInputs.some((p) => p.endsWith('Helper.ts')));
  m.productInputs = m.productInputs.filter((p) => !p.endsWith('Helper.ts'));
  writeFileSync(join(dir, 'component.inputs.json'), `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(join(dir, 'build.mjs'), ECHO_BUILDER);
  // r2 到这里就全绿了(oracle 自己就在被审对象里)。r3:两道都拦得住。
  const v = verifyDemo(dir);
  assert.notEqual(v.status, 0, '伪 oracle + 缩清单居然通过了 verify(#2c-a 未修)');
  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.gateA.pass, false);
  assert.equal(report.gateA.inputsRecheck, 'bad-builder');
  assert.match(report.gateA.detail, /检测到自定义构建器,需人工审查/);
  assert.match(report.gateA.detail, /build\.mjs/);
  // pr-block 侧同样拒(report 层 fail-closed,不靠 verify 的退出码)
  const problems = validateReportIntegrity(dir, readSpec(dir), report);
  assert.ok(problems.some((p) => /自定义构建器/.test(p)), JSON.stringify(problems));
  assert.notEqual(prBlock(dir).status, 0);
});

test('#2c-a 换掉 demo 侧构建核心(build.mjs 保持原样)→ 同样 fail-closed', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'swap-core', boot: 'renderTarget', exportName: 'Claimed' });
  assert.equal(buildDemo(dir).status, 0);
  assert.deepEqual(checkDemoBuilderIntegrity(dir), [], '原版拷贝不该报问题');
  writeFileSync(
    join(dir, 'component-build-core.mjs'),
    `${readFileSync(join(dir, 'component-build-core.mjs'), 'utf8')}\n// 偷偷放宽一点\n`,
  );
  const problems = checkDemoBuilderIntegrity(dir);
  assert.ok(problems.some((p) => /component-build-core\.mjs/.test(p) && /自定义构建器/.test(p)), JSON.stringify(problems));
  const v = verifyDemo(dir);
  assert.notEqual(v.status, 0, '改了构建核心居然还能过 verify');
  assert.equal(readJson(join(dir, 'report.json')).gateA.inputsRecheck, 'bad-builder');
});

test('#2c-a 复算路径不执行 demo 目录里的代码(伪 build.mjs 的副作用不发生)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({ name: 'no-exec', boot: 'renderTarget', exportName: 'Claimed' });
  assert.equal(buildDemo(dir).status, 0);
  // 把 build.mjs 换成「一旦被执行就落一个标记文件」的脚本:复算过程绝不能碰它
  writeFileSync(join(dir, 'build.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./EXECUTED', import.meta.url), 'x');\n");
  verifyDemo(dir);
  assert.equal(existsSync(join(dir, 'EXECUTED')), false, 'verify 的复算居然执行了 demo 目录里的 build.mjs');
});

// ==================== #2c-b tailwind content 入链 ====================

/* r7 条目 2:content 从 glob 降级为**显式文件路径列表**(破坏性接口变更)。
   下面三条 #2c-b 回归的意图不变(content 命中的文件必须逐个入链、非法声明必须 exit 2),
   只是声明形态从 glob 改成显式清单;拒收范围只扩大不缩小(glob 现在也在拒收之列)。 */
const CSS_SPEC = { tailwindConfig: 'tailwind.config.js', content: ['src/styles/extra.css', 'src/styles/theme.css'] };

test('#2c-b content 命中的文件逐个进 buildInputs.product,改它 → 旧 report 被拒', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { repo, dir } = makeFixture({
    name: 'content-chain',
    boot: 'renderTarget',
    exportName: 'Claimed',
    css: CSS_SPEC,
    styleFiles: { 'src/styles/theme.css': '.a{color:red}\n', 'src/styles/extra.css': '.b{color:blue}\n' },
  });
  // 产品仓没装 tailwindcss CLI,不能跑完整 build(CSS 步会报缺 CLI);清单本身用 skill 侧
  // 构建核心直算(与 build.mjs 走的是同一份实现),再落盘 —— 与 build.mjs 的行为等价。
  const check = coreCheck(dir);
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
  const manifest = JSON.parse(check.stdout);
  assert.deepEqual(
    manifest.buildInputs.product,
    ['src/styles/extra.css', 'src/styles/theme.css', 'tailwind.config.js'],
    'content 命中的每个文件都必须入链(#2c-b:漏了它们改样式源文件 hash 不变)',
  );
  writeFileSync(join(dir, 'component.inputs.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const spec = readSpec(dir);
  const before = buildInputHashes(dir, spec);
  assert.match(before.componentSources.buildInputs.product['src/styles/theme.css'], /^[0-9a-f]{64}$/);
  // 攻击:只改样式源文件(旧 CSS 产物与旧 report 都不动)
  writeFileSync(join(repo, 'src/styles/theme.css'), '.a{color:lime}\n');
  const after = buildInputHashes(dir, spec);
  assert.notEqual(stableJson(after), stableJson(before), '改 content 命中的文件居然没让 hash 变');
  assert.ok(
    validateReportIntegrity(dir, spec, { toolVersion: 'x', inputHashes: before }).some((p) => /输入 hash 与当前/.test(p)),
    '改样式源文件后旧 report 应被拒',
  );
});

test('#2c-b content 声明了不存在的文件 → exit 2(r7 变形:等价于旧「glob 零命中」)', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  const { dir } = makeFixture({
    name: 'content-nomatch',
    boot: 'renderTarget',
    exportName: 'Claimed',
    // 声明了不存在的文件:r6 的等价情形是「glob 零命中」,r7 直接就是「文件不存在」——
    // 两者同一个危害(CSS 按更小的集合编译却不被发现),都必须 exit 2。
    css: { tailwindConfig: 'tailwind.config.js', content: ['src/styles/theme.css'] },
  });
  const r = buildDemo(dir);
  assert.equal(r.status, 2, `声明了不存在的 content 文件居然构建成功:${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /文件不存在/);
  assert.match(r.stdout + r.stderr, /src\/styles\/theme\.css/);
});

test('#2c-b content 非显式文件形态(glob / brace / 否定 / 绝对路径 / 目录 / 越狱 / node_modules)→ exit 2', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置');
  // r7 起 glob 本身也在拒收之列,清单里因此新增 '*' / '?' / 字符类 / 目录 形态
  for (const pattern of ['src/**/*.{ts,tsx}', '!src/skip.css', '/abs/path/*.css', 'src/styles/*.css',
    'src/styles/[ab].css', 'src/styles/?.css', 'src/styles', 'node_modules/pkg/a.css', '../outside.css']) {
    const { dir } = makeFixture({
      name: `content-badglob-${Buffer.from(pattern).toString('hex').slice(0, 8)}`,
      boot: 'renderTarget',
      exportName: 'Claimed',
      css: { tailwindConfig: 'tailwind.config.js', content: [pattern] },
      styleFiles: { 'src/styles/theme.css': '.a{color:red}\n' },
    });
    const r = buildDemo(dir);
    assert.equal(r.status, 2, `${JSON.stringify(pattern)} 居然被接受:${r.stdout}${r.stderr}`);
    // r5 #2c-b:黑名单改成白名单式字符扫描,报文措辞随之改为「受限 glob」
    // (拒收范围只扩大不缩小:brace/否定/绝对路径依旧拒,另新增字符类等元字符)
    /* r7 条目 2/5:报文按**真实原因**分流 —— glob 形态说「会被 Tailwind 当 glob 解释」,
       路径不安全说对应政策,而 `!src/skip.css` 这类既不是 glob 形态、路径也安全的写法
       会走到 fs 层落成「文件不存在」(条目 5 要的就是「用真实信息报错,不要用字符规则猜」)。
       无论走哪条,exit 2 这一点不变。 */
    assert.match(
      r.stdout + r.stderr,
      /会被 Tailwind 当 glob 解释|不允许绝对路径|不是普通文件|越狱|默认拒绝 node_modules|含逗号|文件不存在|意图信号/,
    );
  }
});
