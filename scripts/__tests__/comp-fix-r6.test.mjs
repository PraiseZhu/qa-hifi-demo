// comp-fix-r6.test.mjs — 六轮终审的对抗回归(条目 1/2/3/4/5)。
//
// r5 立了总原则:**凡是放行依据,必须由 skill 可信侧亲自执行/重算得到;demo 目录产出的
// 文件至多用于对账。** r6 的病根是 r5 自己没把这条执行彻底 —— 漏了两处:
//   条目 1 CRITICAL  assets/component.css 全仓**没有任何字节复算**。bundle 有
//                    (computeExpectedBundleSha),CSS 只被记进 assets 清单做「report 是否
//                    过期」检测,从不独立重编译比对。合法构建后手改 component.css,只要不动
//                    入链的输入文件,verify / pr-block 全流程零检测通过。
//   条目 2 CRITICAL  门 E(pixel)被排除在可信侧重跑之外。verify 的 GATE_LETTERS 不含 E,
//                    pr-block 的可信重跑门集合硬编码 A/B/C/D/F/X,validatePixelForPr 全是
//                    report-pixel.json 自身的算术自洽,从不重新对真实图片跑 odiff/pixelmatch。
//                    → 手写一份满足全部自洽约束的 report-pixel.json 即可伪造视觉回归 PASS。
//   条目 3/4/5       自研 glob 展开与 Tailwind 的 fast-glob 语义不一致(content.relative 基准、
//                    node_modules 非对称扫描、config 的 presets/plugins 依赖未入链)。
//                    安全性由条目 1 的字节复算兜住,准确性改为复用 fast-glob。
//
// 分层说明(诚实标注):端到端 PoC 需要真 esbuild + playwright(项目 canonical 测试命令
// 一直带 QA_HIFI_MODULE_ROOT,因此实跑);零依赖的源码契约/纯函数断言一律不 skip。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, safeJsonForScript, stableJson } from '../lib/fs-utils.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CORE = join(ROOT, 'scripts/lib/component-build-core.mjs');
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
const PIXEL = join(ROOT, 'scripts/pixel-compare.mjs');
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
const BOOT_REAL = "import { Claimed } from '../../src/components/Claimed';\nglobalThis.__demo = Claimed();\n";

function baseHtml(truth) {
  return `<!doctype html><html><head><link rel="stylesheet" href="assets/component.css"><style>
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

/** mini 产品仓 + 组件模式 demo(与 r5 同形)。repoDeps=true 把宿主 node_modules 挂到产品仓。 */
function makeFixture({ name, css, repoDeps = false, baselines, extraRepoFiles = {}, extraSpec = {} } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qa-r6-${name}-`));
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
  /* repoDeps:
       true      → 挂宿主产品仓 node_modules(有 esbuild/playwright,**没有** tailwindcss)
       'skill'   → 挂 skill 自己的 node_modules(有真 tailwindcss CLI + fast-glob);
                   esbuild/playwright 仍由 QA_HIFI_MODULE_ROOT 解析,不受影响。
                   ——r6 起 skill 把 tailwindcss 列为 devDependency,真 tailwind 分支
                   (CSS 编译 + content 扫描语义)因此能被真跑,不再只有源码契约。 */
  if (repoDeps === 'skill') symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'));
  else if (repoDeps) symlinkSync(join(MODULE_ROOT, 'node_modules'), join(repo, 'node_modules'));

  const dir = join(repo, 'qa-demo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  for (const [from, to] of BUILD_FILES) copyFileSync(join(ROOT, from), join(dir, to));
  writeFileSync(join(dir, 'src/bootstrap.ts'), BOOT_REAL);

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
    ...(baselines ? { baselines, baselineFrameSel: '#frame' } : {}),
    ...extraSpec,
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
  writeFileSync(join(dir, 'index.html'), baseHtml(truth));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  return { repo, dir, spec };
}

/** 出块前的三件事:build → verify → assets 闸门。全部要求 exit 0。 */
function buildVerifyAssets(dir) {
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0, 'build.mjs 失败');
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(v.status, 0, `verify 失败:${v.stdout}${v.stderr}`);
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0, 'assets 闸门失败');
}

// ==================== 条目 1 — CSS 产物零字节复算 ====================

test('条目 1 源码契约(不 skip): 构建核心提供 --check-css / fs-utils 走 canonical 复算 / gate A 计入结果', () => {
  const core = readFileSync(CORE, 'utf8');
  assert.match(core, /export async function computeExpectedCssSha/, '构建核心必须有 CSS 字节复算入口');
  assert.match(core, /--check-css/, 'CLI 必须支持 --check-css');
  assert.match(core, /export const CSS_PLACEHOLDER/, '占位字节必须是共享常量(两侧写死会漂移 → 误杀)');

  const fs_ = readFileSync(join(ROOT, 'scripts/lib/fs-utils.mjs'), 'utf8');
  assert.match(fs_, /export function recheckComponentCss/);
  assert.match(
    fs_,
    /CANONICAL_BUILD_FILES\['component-build-core\.mjs'\], '--check-css'/,
    'CSS 复算必须跑 **skill 仓自己那份** core,不能执行 demo 目录里的拷贝',
  );

  const v = readFileSync(VERIFY, 'utf8');
  assert.match(v, /recheckComponentCss\(demoDir, spec\.component\)/, 'gate A 必须调用 CSS 复算');
  assert.match(v, /gateA\.cssRecheck = cssCheck\.status/);
  assert.match(v, /cssCheck\.problems\.length[\s\S]{0,80}gateA\.pass = false/, 'CSS 复算不一致必须让 gate A 红');

  // 薄壳模板不许再写死占位字面量(否则与可信侧常量漂移)
  const tpl = readFileSync(join(ROOT, 'templates/component-build.mjs'), 'utf8');
  assert.match(tpl, /writeFileSync\(cssOut, CSS_PLACEHOLDER\)/);
  assert.ok(
    !/writeFileSync\(cssOut, '\/\* 组件模式/.test(tpl),
    '模板仍在写死占位字面量 → 与 CSS_PLACEHOLDER 漂移时会把合法 demo 误杀',
  );
});

test('条目 1 边界次序(不 skip,源码契约): demo node_modules 前置门必须排在「执行产品 tailwind」之前', () => {
  const core = readFileSync(CORE, 'utf8');
  const fn = core.slice(core.indexOf('export async function computeExpectedCssSha'), core.indexOf('/** 单次 tailwind 编译'));
  const guard = fn.indexOf('findDemoNodeModules(demoDir)');
  const compile = fn.indexOf('compileTailwindOnce(');
  assert.ok(guard > 0, 'CSS 复算里必须有 demo node_modules 前置门');
  assert.ok(compile > 0, 'CSS 复算里必须真的编译 tailwind');
  assert.ok(guard < compile, '前置门必须排在执行产品 tailwind config 之前(审核裁定的边界)');
  // 产品仓必须是 demo 的严格祖先:demo 自己就是 git 仓时,repoRoot===demoDir,
  // 那等于把不可信目录当「可信产品仓」执行它的 config/CLI。
  assert.match(fn, /严格祖先/);
  // 不确定性不许静默容忍:同输入编译两遍,字节不等就 fail
  assert.match(core, /for \(let i = 0; i < 2; i \+= 1\) runs\.push\(compileTailwindOnce/);
  assert.match(core, /两次编译的字节不一致/);
});

test('条目 1 复现样本: 合法构建后手改 assets/component.css(仅追加一行注释)→ 门 A 红 + pr-block exit 2', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({ name: 'css-tamper', repoDeps: true });
  buildVerifyAssets(dir);

  // 攻击:只改 CSS 产物,不动任何入链的输入文件。
  // r5 之前:assets 清单里的 sha 只保证「report 与当前字节一致」——重跑一次 verify/闸门
  // 就把新字节记进去,没有任何环节回答「这批字节是不是 tailwind 按当前源码编出来的」。
  appendFileSync(join(dir, 'assets/component.css'), '\n/* injected by attacker */\nbody{display:none}\n');
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, `手改 CSS 产物居然过了 verify(条目 1 未修):${v.stdout}${v.stderr}`);
  const out = `${v.stdout}${v.stderr}`;
  assert.match(out, /CSS 字节与可信侧复算结果不一致/, '必须点名是 CSS 字节复算不符');
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.cssRecheck, 'mismatch');
  assert.equal(rep.gateA.pass, false);

  // 攻击者退一步:把 verify 产物换回之前那份全绿 report,再跑 assets 闸门把新字节记进去。
  // pr-block 的可信侧重跑仍会自己算 CSS → 必须拒。
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 2, `手改 CSS 后居然出了块:${pr.stdout}${pr.stderr}`);
});

test('条目 1 阳性对照: 正常 demo 的 CSS 字节复算相等,verify/pr-block 照常放行', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({ name: 'css-ok', repoDeps: true });
  buildVerifyAssets(dir);
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.cssRecheck, 'ok', 'CSS 复算误杀了正常 demo');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 0, `CSS 复算误伤了正常出块路径:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /真组件直渲/);
});

test('条目 1 复算确定性: 同一 demo 连跑两次 --check-css,sha256 必须一致', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild(spec 解析路径共用构建核心)');
  const { dir } = makeFixture({ name: 'css-deterministic', repoDeps: true });
  const a = run(CORE, ['--check-css', '--demo', dir], { cwd: dir, env: env() });
  const b = run(CORE, ['--check-css', '--demo', dir], { cwd: dir, env: env() });
  assert.equal(a.status, 0, `${a.stdout}${a.stderr}`);
  assert.equal(b.status, 0, `${b.stdout}${b.stderr}`);
  const A = JSON.parse(a.stdout);
  const B = JSON.parse(b.stdout);
  assert.equal(A.sha256, B.sha256, 'CSS 期望字节不确定 → 字节复算这条锚不成立');
  assert.equal(A.deterministic, true);
  assert.match(A.sha256, /^[0-9a-f]{64}$/);
});

test('条目 1 fail-closed: 配了 tailwind 但产品仓没有 tailwindcss CLI → 复算拒绝放行(不是静默跳过)', (t) => {
  if (!MODULE_ROOT) return t.skip('需要宿主 node_modules 挂到产品仓才能构成「装了依赖但没 tailwind」');
  const { dir } = makeFixture({
    name: 'css-no-cli',
    repoDeps: true,
    css: { tailwindConfig: 'tailwind.config.js', content: ['src/StyleOnly.tsx'] },
  });
  const r = run(CORE, ['--check-css', '--demo', dir], { cwd: dir, env: env() });
  assert.notEqual(r.status, 0, '没有 tailwindcss CLI 却宣称复算成功 = 宣称了做不到的事');
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /没有 tailwindcss CLI/);
  assert.match(out, /fail-closed|不得放行/);
  // verify 侧同样不许放行(门 A 必须红,而不是把 cssRecheck 记成 n/a 混过去)
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0);
  assert.match(`${v.stdout}${v.stderr}`, /CSS 字节|tailwindcss CLI/);
});

test('条目 1 真 tailwind 分支(实跑): 编译确定 + 手改样式源文件不重建 → CSS 字节复算立刻不符', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild 走完 build');
  const css = { tailwindConfig: 'tailwind.config.js', content: ['src/StyleOnly.tsx'] };
  const { repo, dir } = makeFixture({ name: 'css-real-tw', repoDeps: 'skill', css });
  // ① 真 build:走 templates/component-build.mjs 的 tailwind CLI 分支,产出真 CSS
  const b = run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() });
  assert.equal(b.status, 0, `真 tailwind build 失败:${b.stdout}${b.stderr}`);
  const cssText = readFileSync(join(dir, 'assets/component.css'), 'utf8');
  assert.ok(cssText.length > 500, '真 tailwind 产物应包含 preflight,不该是占位');
  assert.match(cssText, /bg-red-500/, 'content 命中的 class 应被编进产物');

  // ② 确定性实证:同输入两次复算字节一致(computeExpectedCssSha 内部也跑了双编译比对)
  const a1 = run(CORE, ['--check-css', '--demo', dir], { cwd: dir, env: env() });
  assert.equal(a1.status, 0, `${a1.stdout}${a1.stderr}`);
  const exp = JSON.parse(a1.stdout);
  assert.equal(exp.mode, 'tailwind');
  assert.equal(exp.deterministic, true);
  assert.equal(exp.sha256, hashFile(join(dir, 'assets/component.css')), '真 build 产物应与可信侧复算字节全等');
  const a2 = run(CORE, ['--check-css', '--demo', dir], { cwd: dir, env: env() });
  assert.equal(JSON.parse(a2.stdout).sha256, exp.sha256, 'tailwind 输出不确定 → 字节锚不成立');

  // ③ 改样式源文件但不重建:入链 hash 会变(那条已有的门),CSS 字节复算也必须变
  writeFileSync(join(repo, 'src/StyleOnly.tsx'), 'export const cls = "bg-lime-500";\n');
  const a3 = run(CORE, ['--check-css', '--demo', dir], { cwd: dir, env: env() });
  assert.equal(a3.status, 0, `${a3.stdout}${a3.stderr}`);
  assert.notEqual(JSON.parse(a3.stdout).sha256, exp.sha256, '改了 Tailwind 实扫文件却算出同样的 CSS = 复算没真跑');
});

test('条目 1 占位模式也入锚: 未配 tailwind 时手改占位 CSS 同样被抓', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild');
  const { dir } = makeFixture({ name: 'css-placeholder', repoDeps: true });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  writeFileSync(join(dir, 'assets/component.css'), '/* 我自己写的样式 */\nbody{color:red}\n');
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, '占位模式下手写 CSS 居然放行');
  assert.match(`${v.stdout}${v.stderr}`, /CSS 字节与可信侧复算结果不一致/);
});
