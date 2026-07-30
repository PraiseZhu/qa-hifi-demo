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
//                    安全性由条目 1 的字节复算兜住;准确性 r6 改为复用 fast-glob,
//                    r7 条目 2 起进一步把 content 降级为显式文件列表(见本文件条目 3/4/5 段头注)。
//
// 分层说明(诚实标注):端到端 PoC 需要真 esbuild + playwright(项目 canonical 测试命令
// 一直带 QA_HIFI_MODULE_ROOT,因此实跑);零依赖的源码契约/纯函数断言一律不 skip。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildInputHashes, hashFile, safeJsonForScript, stableJson, TOOL_VERSION } from '../lib/fs-utils.mjs';
import { validatePixelForPr } from '../lib/report.mjs';
import { loadPngApi } from '../lib/png-compare.mjs';

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
/** 去掉注释后的可执行代码 —— 源码契约要断的是「代码里还有没有」,不是「注释提没提」。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
  else if (repoDeps === 'no-tailwind') makeNoTailwindNodeModules(repo);
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

/**
 * 造一个「装了依赖、但**确定没有** tailwindcss CLI」的产品仓 node_modules(r7 条目 14)。
 *
 * 为什么要自建:原实现用 `repoDeps: true`(整份宿主 node_modules symlink)+ 假设"宿主产品仓
 * 碰巧没装 tailwind"。这就是**环境依赖**:MivoCanvas 没装 → 绿;Project CINDY 装了 3.4.19
 * → `--check-css` 正常成功、断言失败(lead 实测 278/280)。测试不许依赖宿主碰巧装了什么。
 *
 * 构造方式(确定性,与宿主装了什么无关):node_modules 是**真目录**,逐项 symlink 宿主的包,
 * 但显式跳过 tailwindcss;`.bin` 也重建成真目录、逐项 symlink 但跳过 tailwindcss。
 * 宿主根本没有 node_modules(不设 QA_HIFI_MODULE_ROOT)时就留一个只有空 `.bin` 的目录 ——
 * 「没有 CLI」这个前提同样成立。
 */
function makeNoTailwindNodeModules(repo) {
  const dst = join(repo, 'node_modules');
  mkdirSync(join(dst, '.bin'), { recursive: true });
  const host = MODULE_ROOT ? join(MODULE_ROOT, 'node_modules') : null;
  if (host && existsSync(host)) {
    for (const name of readdirSync(host)) {
      if (name === 'tailwindcss' || name === '.bin') continue;
      try { symlinkSync(join(host, name), join(dst, name)); } catch {}
    }
    const hostBin = join(host, '.bin');
    if (existsSync(hostBin)) {
      for (const name of readdirSync(hostBin)) {
        if (name === 'tailwindcss') continue;
        try { symlinkSync(join(hostBin, name), join(dst, '.bin', name)); } catch {}
      }
    }
  }
  assert.ok(!existsSync(join(dst, '.bin/tailwindcss')), '隔离 fixture 构造失败:产品仓里仍有 tailwindcss CLI');
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
  /* r7 起门 A 的 pass 在「执行 demo 侧代码」之后才汇总(见 verify 文件头「执行时序原则」),
     所以各段失败不再就地写 gateA.pass=false,而是置 gateAHardFail —— 汇总时
     pass = !gateAHardFail && extractorDrift==='none'。断言强度不变(CSS 复算不一致 → 门 A 红),
     只是跟着实现改成断真正的那条链路;下一行把汇总语义也一并钉住。 */
  assert.match(v, /cssCheck\.problems\.length[\s\S]{0,80}gateAHardFail = true/, 'CSS 复算不一致必须让 gate A 红');
  assert.match(v, /gateA\.pass = !gateAHardFail && gateA\.extractorDrift === 'none'/, '门 A 汇总必须把 hardFail 一票否决');

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

test('条目 1 fail-closed(r7 条目 14 起不 skip、不依赖宿主): 产品仓没有 tailwindcss CLI → 复算拒绝放行', (t) => {
  /* 隔离 fixture 自己构造「没有 tailwindcss CLI 的产品仓」,与宿主装了什么无关。
     --check-css 在 bin 存在性检查处就 fail-closed,不需要 esbuild,所以这段**任何环境都跑**。 */
  const { dir } = makeFixture({
    name: 'css-no-cli',
    repoDeps: 'no-tailwind',
    css: { tailwindConfig: 'tailwind.config.js', content: ['src/StyleOnly.tsx'] },
  });
  const r = run(CORE, ['--check-css', '--demo', dir], { cwd: dir, env: env() });
  assert.notEqual(r.status, 0, '没有 tailwindcss CLI 却宣称复算成功 = 宣称了做不到的事');
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /没有 tailwindcss CLI/);
  assert.match(out, /fail-closed|不得放行/);
  // verify 侧同样不许放行(门 A 必须红,而不是把 cssRecheck 记成 n/a 混过去)。
  // 这一段要走完整门 A(含 esbuild 输入图复算),故仅在有产品仓依赖时跑。
  if (!MODULE_ROOT) return;
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

// ==================== 条目 2 — 门 E 被排除在可信侧重跑之外 ====================

test('条目 2 源码契约(不 skip): pr-block 必须亲自重跑 pixel-compare;不许再出现「全门重跑」的不实声明', () => {
  const src = readFileSync(PR_BLOCK, 'utf8');
  assert.match(src, /CANONICAL_PIXEL\s*=\s*join\(SCRIPT_DIR, 'pixel-compare\.mjs'\)/, 'pr-block 必须指向 skill 自己的 pixel-compare');
  assert.match(
    src,
    /spawnSync\(process\.execPath, \[CANONICAL_PIXEL, '--demo', demoDir, '--report-out'/,
    '门 E 必须由 pr-block 亲自重跑,而不是只校验 demo 自报的算术自洽',
  );
  assert.match(src, /trusted-pixel:/, '可信重跑门 E 未通过必须落成 problem');
  assert.match(src, /pixel = \{ present: true, problems: \[\], report: trustedPx \}/, '出块的像素结论必须取可信侧结果');
  assert.match(src, /pixel\(自报\)/, 'demo 自报必须被明确标注为对账材料');
  // r5 那句「可信侧重跑全门(A/B/C/D/F/X)」漏了 E —— 表述必须诚实
  assert.ok(!/重跑全门/.test(src), 'pr-block 仍在声称「全门重跑」,而 verify 的门集合不含 E');
  assert.ok(!/重跑全门/.test(readFileSync(VERIFY, 'utf8')), 'verify 仍在声称「全门」');
  assert.ok(
    readFileSync(VERIFY, 'utf8').includes('门 E(像素基准)**不在本文件**'),
    'verify 必须写明门 E 的可信来源在哪(否则又会有人以为 verify 覆盖了全门)',
  );
  // pixel-compare 必须支持写到 demo 之外(否则重跑会覆盖被审方自报,对账就没了)
  assert.match(readFileSync(PIXEL, 'utf8'), /--report-out/);
});

test('条目 2 复现样本: 手写全 PASS 的 report-pixel.json + 从不跑 pixel-compare(基准图是非 PNG 字节)→ pr-block 必须拒', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const baselines = [{ key: 'one', frameSel: '#frame' }];
  const { dir, spec } = makeFixture({ name: 'pixel-forged', repoDeps: true, baselines });
  // 基准图根本不是 PNG —— 真跑 pixel-compare 一定 ERROR;手写报告里却写 PASS。
  // 必须在 verify 之前落盘:baselines 进 inputHashes,后建会让 report.json 先被 hash 门拦下,
  // 那就证明不了门 E 这个洞(测的是别的门)。
  mkdirSync(join(dir, 'baselines'), { recursive: true });
  writeFileSync(join(dir, 'baselines/one.png'), 'NOT-A-PNG');
  buildVerifyAssets(dir);
  const forged = {
    ok: true,
    skipped: false,
    toolVersion: TOOL_VERSION,
    threshold: 0.005,
    compared: 1,
    declared: 1,
    // inputHashes 用**可导出的** buildInputHashes 对自己控制的文件现算 → 天然自洽
    inputHashes: buildInputHashes(dir, spec),
    results: [{ key: 'one', status: 'PASS', engine: 'odiff', bad: 0, total: 10000, masked: 0, diffRatio: 0, detail: '' }],
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'report-pixel.json'), `${JSON.stringify(forged, null, 2)}\n`);

  // 先证明这份手写报告能过完整的「自报自洽」校验 —— 所以静态层本身不构成证明
  assert.deepEqual(
    validatePixelForPr(dir, spec).problems,
    [],
    '静态自洽层如果能拦住手写 pixel 报告,这条 CRITICAL 就不成立了',
  );

  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 2, `手写全 PASS 的门 E 报告居然出了块(条目 2 未修):${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /trusted-pixel/, '必须点名是门 E 的可信重跑不符,而不是别的偶然原因');
});

test('条目 2 阳性对照(实跑,不 skip): 真跑 pixel-compare 且基准与渲染一致 → pr-block 照常出块', async (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const baselines = [{ key: 'one', frameSel: '#frame' }];
  const { dir } = makeFixture({ name: 'pixel-ok', repoDeps: true, baselines });
  // 与 gate-e-v2 同手法:#frame 是 16x16 纯红 × baselineDpr 2 → 32x32 纯红基准
  const { PNG } = await loadPngApi(dir);
  const png = new PNG({ width: 32, height: 32 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 255; }
  mkdirSync(join(dir, 'baselines'), { recursive: true });
  writeFileSync(join(dir, 'baselines/one.png'), PNG.sync.write(png));

  buildVerifyAssets(dir);
  const px = run(PIXEL, ['--demo', dir], { env: env() });
  assert.equal(px.status, 0, `基准与渲染一致却没 PASS:${px.stdout}${px.stderr}`);
  assert.equal(readJson(join(dir, 'report-pixel.json')).results[0].status, 'PASS');
  // artifact 目录新增后要重跑资产闸门(assets/ 不含 pixel-artifacts,但 report hash 要新)
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 0, `门 E 可信重跑误伤了正常路径:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /像素基准/);
  assert.ok(!pr.stdout.includes('未运行 pixel-compare'), '门 E 真跑过,不该打「未运行」');
});


/* ============ 条目 3/4/5 — content 入链集的准确性 ============
   r7 条目 2 起 content 从 glob 降级为**显式文件路径列表**(破坏性接口变更),
   下面三条原本针对「自研/复用 glob 与 Tailwind 实扫集的语义差异」的 PoC 因此变形:
   同样的 fixture、同样的攻击意图,但期望从「差异必须被 fast-glob 消除」改成
   「这类声明在入口就被拒绝」——判定只收紧不放宽(过去是「算准它」,现在是「不许出现」)。
   条目 5 那条兜底(改 config require 的 plugin → CSS 字节复算不符)与 content 形态无关,原样保留。
   显式列表本身的正向/对抗覆盖见 comp-fix-r7.test.mjs。 */

test('条目 3/4/5 源码契约(r7 变形,不 skip): content 不再有任何展开语义;白名单只服务其它 glob 用途', () => {
  const rg = readFileSync(join(ROOT, 'scripts/lib/repo-glob.mjs'), 'utf8');
  // r6 的 fast-glob 复用整段下线 —— 留着它就等于留「还能走 glob」的错觉
  assert.ok(!/export function expandTailwindContent/.test(rg), 'content 的 fast-glob 展开应在 r7 下线');
  assert.ok(!/export function tailwindContentRelative/.test(rg), 'content.relative 的静态推断随之下线(CLI 绝对路径 override 后它不再决定集合)');
  assert.ok(!/function resolveFastGlob/.test(rg), 'fast-glob 解析器随之下线');
  assert.match(rg, /export function explicitContentFileProblem/, 'content 的入口校验必须存在');
  assert.match(rg, /export function expandRepoGlob/, 'assets/sources 等其它 glob 用途必须保留');
  assert.match(rg, /export function restrictedGlobProblem/, '受限白名单保留(服务其它 glob 用途)');

  const core = readFileSync(CORE, 'utf8');
  assert.match(core, /export function resolveContentFiles/, 'content 必须只有一份显式解析实现');
  assert.ok(!/expandTailwindContent/.test(core.replace(/\/\*[\s\S]*?\*\//g, '')), '构建核心的可执行代码里不该再有 glob 展开');
  assert.match(core, /export function contentCliArg/, '--content 参数构造必须两侧共用一份');
});

test('条目 3 PoC(r7 变形): content.relative 基准错位的前提消失 —— glob 声明在入口就被拒', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild 走到清单阶段');
  /* r6 的病灶:config.content.relative:true 时 glob 基准变成 dirname(userConfigPath),
     而 --content 只覆盖 files 不覆盖 relative → 我们入链仓根诱饵、Tailwind 实扫 config 目录下的真文件。
     r7:content 只接受显式文件、传绝对路径,relative 不再决定集合;而这条 PoC 的 glob 形态
     (以及任何 glob)在入口即拒。 */
  const { dir } = makeFixture({
    name: 'rel-base',
    repoDeps: 'skill',
    css: { tailwindConfig: 'apps/desktop/tailwind.config.js', content: ['src/*.tsx'] },
    extraRepoFiles: {
      'apps/desktop/tailwind.config.js': "module.exports = { content: { relative: true, files: [] }, theme: {} };\n",
      'apps/desktop/src/Foo.tsx': 'export const real = "bg-sky-500";\n',
      'src/Foo.tsx': 'export const decoy = "bg-amber-500";\n',
    },
  });
  const r = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });
  assert.notEqual(r.status, 0, 'glob 形态的 content 必须在入口被拒(r7 破坏性变更)');
  assert.match(r.stdout, /component\.css\.content/);
  assert.match(r.stdout, /显式/);

  // 阳性:改成显式声明 config 目录下的**真**文件 → 入链的就是它,且不含仓根诱饵
  const specPath = join(dir, 'spec.json');
  const spec2 = JSON.parse(readFileSync(specPath, 'utf8'));
  spec2.component.css.content = ['apps/desktop/src/Foo.tsx'];
  writeFileSync(specPath, JSON.stringify(spec2, null, 2));
  const r2 = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });
  assert.equal(r2.status, 0, `${r2.stdout}${r2.stderr}`);
  const product = JSON.parse(r2.stdout).buildInputs.product;
  assert.ok(product.includes('apps/desktop/src/Foo.tsx'), `显式声明的真文件必须入链:${JSON.stringify(product)}`);
  assert.ok(!product.includes('src/Foo.tsx'), `仓根诱饵不该入链:${JSON.stringify(product)}`);
});

test('条目 4 PoC(r7 变形): node_modules 非对称扫描的前提消失 —— 目录 glob 与 node_modules 路径都被拒', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild 走到清单阶段');
  /* r6 的病灶:我们的展开跳过 node_modules,Tailwind 的 fastGlob.sync 不跳 →
     src/node_modules/vendor-widget/Widget.tsx 被实扫且生效却不入链。
     r7:① 'src/**' 这类 glob 在入口即拒;② 就算有人显式写 node_modules 下的路径,也被默认拒。 */
  const { dir } = makeFixture({
    name: 'nm-asym',
    repoDeps: 'skill',
    css: { tailwindConfig: 'tailwind.config.js', content: ['src/**/*.tsx'] },
    extraRepoFiles: {
      'src/node_modules/vendor-widget/Widget.tsx': 'export const v = "bg-fuchsia-500";\n',
      'src/Plain.tsx': 'export const p = "bg-teal-500";\n',
    },
  });
  const r = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });
  assert.notEqual(r.status, 0, 'glob 形态必须被拒');
  assert.match(r.stdout, /显式/);

  const specPath = join(dir, 'spec.json');
  const spec2 = JSON.parse(readFileSync(specPath, 'utf8'));
  spec2.component.css.content = ['src/Plain.tsx', 'src/node_modules/vendor-widget/Widget.tsx'];
  writeFileSync(specPath, JSON.stringify(spec2, null, 2));
  const r2 = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });
  assert.notEqual(r2.status, 0, 'node_modules 下的显式路径必须被默认拒绝');
  assert.match(r2.stdout, /node_modules/);

  spec2.component.css.content = ['src/Plain.tsx'];
  writeFileSync(specPath, JSON.stringify(spec2, null, 2));
  const r3 = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });
  assert.equal(r3.status, 0, `${r3.stdout}${r3.stderr}`);
  const product = JSON.parse(r3.stdout).buildInputs.product;
  assert.deepEqual(product.filter((p) => p.endsWith('.tsx')), ['src/Plain.tsx']);
});

test('条目 4 交叉验证(r7 变形,实跑真 tailwind): 未声明的 node_modules 文件不再进 CSS 产物', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild 走完 build');
  /* r6 实测过「Tailwind 会扫 node_modules」——那正是非对称的成因。
     r7 只把显式文件的绝对路径传给 --content,于是它压根没有机会去扫那个目录:
     声明的 class 进 CSS,node_modules 里的不进(E = L)。 */
  const { dir } = makeFixture({
    name: 'nm-asym-css',
    repoDeps: 'skill',
    css: { tailwindConfig: 'tailwind.config.js', content: ['src/Plain.tsx'] },
    extraRepoFiles: {
      'src/node_modules/vendor-widget/Widget.tsx': 'export const v = "bg-fuchsia-500";\n',
      'src/Plain.tsx': 'export const p = "bg-teal-500";\n',
    },
  });
  const b = run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() });
  assert.equal(b.status, 0, `${b.stdout}${b.stderr}`);
  const css = readFileSync(join(dir, 'assets/component.css'), 'utf8');
  assert.match(css, /bg-teal-500/, '显式声明的 class 必须进 CSS');
  assert.ok(!css.includes('bg-fuchsia-500'), 'node_modules 下未声明的 class 进了 CSS = E = L 不成立');
});

test('条目 5 兜底(实跑真 tailwind): 改 config require 的 plugin(不在入链清单里)→ CSS 字节复算立刻不符', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild 走完 build');
  /* 条目 5 的根因(审核人未做 PoC):normalizeInputs 只把 tailwindConfig 路径本身 +
     content 命中文件 + package.json 入链,**没有**对 config 内部 require 的 presets/plugins
     做递归哈希追踪。r6 不去补递归追踪(那是又一条追不完的语义),而是让 CSS 字节复算兜住:
     改 plugin → 编出来的 CSS 变 → 磁盘字节与可信侧复算不等 → 门 A 红。 */
  const { repo, dir } = makeFixture({
    name: 'plugin-dep',
    repoDeps: 'skill',
    css: { tailwindConfig: 'tailwind.config.js', content: ['src/StyleOnly.tsx'] },
    extraRepoFiles: {
      'tw-plugin.js': "module.exports = function ({ addUtilities }) { addUtilities({ '.qa-mark': { color: '#111111' } }); };\n",
    },
  });
  writeFileSync(
    join(repo, 'tailwind.config.js'),
    "module.exports = { content: [], theme: {}, plugins: [require('./tw-plugin.js')], safelist: ['qa-mark'] };\n",
  );
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const before = hashFile(join(dir, 'assets/component.css'));
  assert.match(readFileSync(join(dir, 'assets/component.css'), 'utf8'), /#111111/, 'plugin 的产物应在 CSS 里');

  // 入链清单不含 tw-plugin.js —— 这就是条目 5;改它不会让任何 hash 变
  const inputs = readJson(join(dir, 'component.inputs.json'));
  assert.ok(!inputs.buildInputs.product.includes('tw-plugin.js'), '前提:plugin 依赖确实不在入链清单里');

  writeFileSync(
    join(repo, 'tw-plugin.js'),
    "module.exports = function ({ addUtilities }) { addUtilities({ '.qa-mark': { color: '#222222' } }); };\n",
  );
  const r = run(CORE, ['--check-css', '--demo', dir], { cwd: dir, env: env() });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.notEqual(JSON.parse(r.stdout).sha256, before, '改了 config require 的 plugin 却算出同样的 CSS = 兜底不成立');
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, 'plugin 改了没重建,verify 必须红');
  assert.match(`${v.stdout}${v.stderr}`, /CSS 字节与可信侧复算结果不一致/);
});


test('条目 3/4/5 引擎同源性(r7 变形,不 skip): content 路径已无第三方展开引擎可言', () => {
  /* r6 需要断言「我们解析到的 fast-glob 与 tailwind 内部那份同源」,因为展开语义决定入链集。
     r7 起 content 不做任何展开 —— 同源性这个风险项本身被消掉了,改为断言它确实不存在:
     构建核心不再解析/依赖 fast-glob,--check-css 的输出也不再报 contentGlob 引擎实况。 */
  // 只看可执行代码:注释里回顾历史(r6 曾复用 fast-glob)是必要的,不算残留依赖
  const core = stripComments(readFileSync(CORE, 'utf8'));
  assert.ok(!/fast-glob/.test(core), '构建核心的可执行代码不该再依赖 fast-glob(content 无展开引擎)');
  assert.match(core, /content: \{ mode: 'explicit-files'/, '--check-css 应报显式文件实况而不是展开引擎');
  // 报错文案里提到 fast-glob/micromatch 是对读者解释语义差异,不是依赖;断的是「有没有真去解析它」
  const rg = stripComments(readFileSync(join(ROOT, 'scripts/lib/repo-glob.mjs'), 'utf8'));
  assert.ok(!/require\(.fast-glob.\)|resolve\(.fast-glob.\)|from '.*fast-glob/.test(rg), 'repo-glob 不该再解析 fast-glob');
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

// ==================== 条目 6 — 文档校准(两张全表 + 信任锚表述) ====================

test('条目 6 文档契约(不 skip): SKILL.md 必须有门级全表与产物全表,且信任锚表述如实', () => {
  const raw = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  // 全角/半角标点在文档里混用,断言前统一成半角再比,免得测的是标点风格
  const md = raw.replace(/[，、]/g, ',').replace(/[：]/g, ':').replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[。]/g, '.');

  // 两张表必须在(以后加新门/新产物有判据,不再靠人肉记)
  assert.match(md, /### 门级全表/, '缺门级全表');
  assert.match(md, /### 产物全表/, '缺产物全表');
  assert.match(md, /任何结论会进 PR 附贴块的门,都必须有可信侧来源/, '门级全表必须写死这条原则');
  // 门级全表要逐门列全 A-F/X
  for (const letter of ['A 真值一致', 'B 状态覆盖', 'C 交互鲁棒', 'D 渲染绑定', 'E 像素基准', 'F 适配还原', 'X 自定义门']) {
    assert.ok(md.includes(`| ${letter}`), `门级全表漏了 ${letter}`);
  }
  // 产物全表要逐个列出「由外部工具生成」的产物
  for (const artifact of [
    'assets/component.bundle.js', 'assets/component.css', 'component.inputs.json',
    'truth.json', 'baselines/**.png', 'pixel-artifacts/*.png', 'report-pixel.json', 'report-assets.json',
  ]) {
    assert.ok(md.includes(artifact), `产物全表漏了 ${artifact}`);
  }
  // pr-block 直接读 demo 目录 json 的位置必须逐个交代
  assert.match(md, /pr-block 直接读 demo 目录文件的位置/);

  // 信任锚表述:challenge 只是 nonce 回显,不是 secret、不是安全锚
  assert.match(md, /不构成 secret/, 'challenge 不构成 secret 这条必须写明');
  assert.match(md, /形态检查,不是安全锚/, 'challenge 必须被明确标注为形态检查而非安全锚');
  assert.ok(
    !/不可预测 challenge/.test(md),
    'SKILL.md 仍把 challenge 写成「不可预测」——它是 nonce 回显,页面函数能收到 nonce,不构成 secret',
  );
  // 「全门」这类不实声明不许再出现
  assert.ok(!/把全门重跑/.test(md), 'SKILL.md 仍在声称「把全门重跑」,而 verify 的门集合不含 E');
});
