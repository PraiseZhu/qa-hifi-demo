// comp-fix-r7.test.mjs — 七轮终审的对抗回归(条目 1 TOCTOU / 条目 2 content 显式文件列表)。
//
// 条目 1 CRITICAL（对 r5/r6 架构主线的根本挑战）
//   「pr-block 在可信侧亲自重跑」这条原则一直有个没被满足的前提:**canonical runner 自己
//   不能在核心观察之前执行被审方的代码**。r6 的 verify 次序是「先跑 demo/extract.mjs → 再字节
//   复算 → 最后启浏览器」,于是 demo 代码拿到了整个观察窗口:extract.mjs 同步返回正确 truth
//   (门 A 绿),同时派一个 detached+unref 的 worker,在父 verify 存活期间把永久错误的
//   index.html 临时改对(门 D 实测绿),父进程退出瞬间恢复。最终磁盘字节与 inputHashes 完全
//   自洽 → pr-block exit 0 且贴「渲染绑定 ✅」。
//   修法:核心观察(浏览器门 + 字节复算)全部排在执行 demo 代码**之前**;之后再复算一次
//   输入 hash 作纵深(不是主防线 —— 攻击能恢复原文件让前后 hash 都自洽)。
//
// 条目 2(破坏性接口变更)
//   component.css.content 从 glob 降级为**显式 repo-relative 文件路径列表**。自研 glob 语义
//   已被证伪四次、复用 fast-glob 后仍留三条残余(relative 靠静态扫描、fast-glob 未必与
//   tailwind 内部同源、plugin/preset 不递归入链)。Tailwind v3 没有公开稳定 API 能导出真实
//   file set,于是收回语义解释权:只接受显式文件,构建时转绝对路径传 --content ——
//   CLI override 之后 config.content 与 config.content.relative 都不再决定集合。
//   不变式 S ⊆ E = L(实扫集 ⊆ 期望集 = 入链集)由**参数结构**保证,不靠事后猜测。
//

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { buildAssetsManifest, buildInputHashes, hashFile, safeJsonForScript, stableJson, TOOL_VERSION } from '../lib/fs-utils.mjs';
import { explicitContentFileProblem, restrictedGlobProblem } from '../lib/repo-glob.mjs';
import { resolveContentFiles } from '../lib/component-build-core.mjs';
import { GATE_LETTERS, RUNNERS, TRUSTED_GATES, lettersFor, markTrustedRun } from '../lib/gates.mjs';
import { renderPrBlock } from '../lib/pr-render.mjs';
import { DEMO_BUILD_FILES } from '../lib/component-build-core.mjs';
import { validatePixelReport } from '../lib/report.mjs';
import { loadPngApi } from '../lib/png-compare.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CORE = join(ROOT, 'scripts/lib/component-build-core.mjs');
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
const ASSETS_MANIFEST = join(ROOT, 'scripts/assets-manifest.mjs');
const PIXEL = join(ROOT, 'scripts/pixel-compare.mjs');
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

/** `.box` 的 width 由外部 CSS 决定 —— TOCTOU PoC 要能只改 index.html 就翻转门 D 的实测值。 */
function baseHtml(truth, { boxWidth = '16px' } = {}) {
  return `<!doctype html><html><head><link rel="stylesheet" href="assets/component.css"><style>
    .box{width:${boxWidth};color:#ff0000;white-space:nowrap}
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
 * mini 产品仓 + 组件模式 demo(与 r5/r6 同形)。
 * @param opts.bindings   门 D 绑定(PoC 要真的量 computed style)
 * @param opts.boxWidth   index.html 里 .box 的 width(PoC 落盘成**错误值**)
 * @param opts.extractor  extract.mjs 的源码(PoC 在这里派 detached worker)
 */
function makeFixture({
  name, css, repoDeps = false, extraRepoFiles = {}, bindings = [], boxWidth = '16px', extractor = null, customGates = null,
} = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qa-r7-${name}-`));
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
    bindings,
    ...(customGates ? { customGates } : {}),
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
  writeFileSync(join(dir, 'index.html'), baseHtml(truth, { boxWidth }));
  writeFileSync(
    join(dir, 'extract.mjs'),
    extractor ?? `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`,
  );
  return { repo, dir, spec, truth };
}

// ============================================================================
// 条目 1 — extract.mjs 的 detached 子进程 TOCTOU
// ============================================================================

test('条目 1 源码契约(不 skip): 执行 demo 侧代码必须排在浏览器门与三项复算之后', () => {
  const v = readFileSync(VERIFY, 'utf8');
  // 三项可信侧字节复算 + 浏览器启动 + 门 D 实测,全部必须早于「执行 demo 侧脚本」
  const iInputs = v.indexOf('recheckComponentInputs(demoDir)');
  const iBundle = v.indexOf('recheckComponentOutputs(demoDir, spec.component)');
  const iCss = v.indexOf('recheckComponentCss(demoDir, spec.component)');
  const iBrowser = v.indexOf('launchChromium(demoDir');
  const iGateD = v.indexOf('---------- 门 D:渲染绑定');
  const iGateF = v.indexOf('---------- 门 F:适配还原');
  const iBoundary = v.indexOf('分界线:以下开始执行 demo 侧代码');
  const iExtract = v.indexOf("const run = runDemoScript(extractor, ['--demo', demoDir])");
  const iCustom = v.indexOf("runDemoScript(join(demoDir, g.script), ['--demo', demoDir]");
  const iPost = v.indexOf('const inputHashesPost = buildInputHashes(demoDir, spec)');
  for (const [label, idx] of [['inputs 复算', iInputs], ['bundle 复算', iBundle], ['css 复算', iCss],
    ['launchChromium', iBrowser], ['门 D', iGateD], ['门 F', iGateF], ['分界线', iBoundary],
    ['extract 执行', iExtract], ['自定义门执行', iCustom], ['事后 hash 复算', iPost]]) {
    assert.ok(idx > 0, `verify.mjs 里找不到 ${label} —— 时序契约无法判定(重排时请同步更新本测试)`);
  }
  for (const [label, idx] of [['inputs 复算', iInputs], ['bundle 复算', iBundle], ['css 复算', iCss],
    ['launchChromium', iBrowser], ['门 D', iGateD], ['门 F', iGateF]]) {
    assert.ok(idx < iBoundary, `${label} 排到了「执行 demo 侧代码」之后 —— TOCTOU 窗口又被打开了`);
  }
  assert.ok(iBoundary < iExtract, 'extract.mjs 的执行必须落在分界线之后');
  assert.ok(iBoundary < iCustom, '自定义门的执行必须落在分界线之后');
  assert.ok(iExtract < iPost && iCustom < iPost, '事后输入 hash 复算必须排在所有 demo 侧代码执行之后');
  // extractor drift 这项检查不许因为重排而丢掉/降级
  assert.match(v, /gateA\.extractorDrift = 'none'/, 'extractor drift 检查被重排丢掉了');
  assert.match(v, /gateA\.extractorDrift = 'drift'/);
  assert.match(v, /gateA\.pass = !gateAHardFail && gateA\.extractorDrift === 'none'/, '门 A 结论必须延后合并(hardFail 一票否决)');
  assert.match(v, /gateA\.postRunHashRecheck = same \? 'ok' : 'mismatch'/);
  // 诚实标注:没有 OS sandbox 时残余风险必须写在源码里(不许用 Node vm 假装隔离)
  assert.match(v, /残余风险/);
  assert.ok(!/from 'node:vm'|require\('vm'\)/.test(v), 'Node vm 不是安全边界,不得拿它假装隔离');

  // pr-block:门 E 的可信重跑必须排在可信 verify 之前(verify 末段会执行 demo 代码)
  const pb = readFileSync(PR_BLOCK, 'utf8');
  const iPx = pb.indexOf("CANONICAL_PIXEL, '--demo', demoDir");
  const iVf = pb.indexOf("CANONICAL_VERIFY, '--demo', demoDir");
  assert.ok(iPx > 0 && iVf > 0, 'pr-block 必须同时亲自重跑门 E 与 verify 门');
  assert.ok(iPx < iVf, '门 E 的可信重跑排在可信 verify 之后 = 那次渲染观察落在 demo 代码的攻击窗口里');
});

test('条目 1 PoC: extract.mjs 派 detached worker 在观察窗口把 index.html 改对、退出时恢复 → 必须门红', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  /* 复刻审核人的可执行 PoC:
       · index.html 落盘的是**永久错误**的 .box{width:99px}(truth 说 16px → 门 D 应该红);
       · extract.mjs 同步返回**正确** truth(门 A 的 extractor drift 绿);
       · 同时派一个 detached+unref 的 worker:先把 99px 改成 16px(门 D 实测变绿),
         等父 verify 退出后再恢复成 99px —— 磁盘最终字节与 inputHashes 自洽。
     r6 的次序下这套组合能让 verify 全绿;r7 起 extract.mjs 在门 D **之后**才跑,worker
     再快也影响不了已经量完的门 D。 */
  const worker = [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const f = process.argv[2];",
    "const bad = readFileSync(f, 'utf8');",
    "const good = bad.replace('width:99px', 'width:16px');",
    'writeFileSync(f, good);',
    // 父 verify 跑完浏览器门大约需要数秒;这里给足窗口再恢复
    'setTimeout(() => { writeFileSync(f, bad); }, 60000);',
    '',
  ].join('\n');
  const extractor = [
    "import { spawn } from 'node:child_process';",
    "import { join } from 'node:path';",
    // r8 条目 C:extractor / 门 X 执行的是**可信副本**(住在 demo 之外的 output root),
    // 所以脚本必须用 `--demo` argv 定位 demo。攻击者同样拿得到这个路径,PoC 的攻击力不变。
    "const argv = process.argv.slice(2); const here = argv[argv.indexOf('--demo') + 1];",
    "const child = spawn(process.execPath, [join(here, 'toctou-worker.mjs'), join(here, 'index.html')], { detached: true, stdio: 'ignore' });",
    'child.unref();',
    // 同步返回正确 truth:门 A 的 extractor drift 这一段照常绿
    'process.stdout.write(TRUTH_JSON);\n',
  ].join('\n');

  const { dir, truth } = makeFixture({
    name: 'toctou',
    repoDeps: true,
    boxWidth: '99px',
    bindings: [{ sel: '.box', prop: 'width', truth: 'geometry.width', kind: 'length' }],
  });
  // truth 由 makeFixture 生成,拿到之后再把真正的攻击版 extract.mjs 覆盖上去
  writeFileSync(join(dir, 'extract.mjs'), extractor.replace('TRUTH_JSON', JSON.stringify(JSON.stringify(truth))));
  writeFileSync(join(dir, 'toctou-worker.mjs'), worker);
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0, 'build.mjs 失败');

  const v = run(VERIFY, ['--demo', dir], { env: env() });
  const out = `${v.stdout}${v.stderr}`;
  assert.notEqual(v.status, 0, `TOCTOU 攻击仍然让 verify 全绿(条目 1 未修):${out}`);
  // 必须是「门 D 实测到错误值」或「事后 hash 不符」中的至少一条,不能是别的偶然原因
  assert.ok(
    /渲染绑定|expected 16px|输入 hash 与观察前不一致/.test(out),
    `verify 红了但不是因为门 D 实测错误值/事后 hash 不符,判定链可能没生效:${out}`,
  );
  // extract.mjs 仍被真的执行过(否则这条 PoC 变成「不跑 demo 代码就没漏洞」的空转)
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.extractorDrift, 'none', 'extractor drift 这项检查被重排丢掉了');
  assert.equal(rep.gateD.pass, false, '门 D 应该实测到落盘的错误宽度(99px vs truth 16px)');

  run(ASSETS_MANIFEST, ['--demo', dir], { env: env() });
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 2, `TOCTOU 攻击居然出了块:${pr.stdout}${pr.stderr}`);
  assert.ok(!pr.stdout.includes('渲染绑定（1 条 computed-style ≡ truth） | ✅'), '不许贴「渲染绑定 ✅」');
});

test('条目 1 阳性对照(实跑,不 skip): 诚实 demo(extractor 无副作用)全链照常绿', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({
    name: 'toctou-ok',
    repoDeps: true,
    boxWidth: '16px',
    bindings: [{ sel: '.box', prop: 'width', truth: 'geometry.width', kind: 'length' }],
  });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(v.status, 0, `时序重排误杀了正常路径:${v.stdout}${v.stderr}`);
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.pass, true);
  assert.equal(rep.gateA.postRunHashRecheck, 'ok');
  assert.equal(rep.gateD.pass, true);
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 0, `正常路径被误杀:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /渲染绑定/);
});

test('条目 1 事后 hash 纵深(实跑): 自定义门改写 index.html → 门 A 红', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({
    name: 'posthash',
    repoDeps: true,
    customGates: [{ id: 'mutating', script: 'mutate-gate.mjs' }],
  });
  writeFileSync(
    join(dir, 'mutate-gate.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const argv = process.argv.slice(2); const here = argv[argv.indexOf('--demo') + 1];",
      "appendFileSync(join(here, 'index.html'), '<!-- mutated -->');",
      "process.stdout.write('ok');\n",
    ].join('\n'),
  );
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, '自定义门改写输入文件后 verify 仍然全绿 = 事后 hash 复算没生效');
  assert.match(`${v.stdout}${v.stderr}`, /输入 hash 与观察前不一致/);
});
// ============================================================================
// 条目 2 — content 改「显式文件路径列表」
// ============================================================================

test('条目 2/5 纯函数(不 skip): 只拒「Tailwind 会当 glob 解释的形态 + 路径不安全 + --content 承载不了」', () => {
  /* r7 条目 5:删掉旧的受限**字符白名单**(它误杀了空格 / # / % / & / ' / ~ / = / ; / : /
     单个中括号等一堆合法文件名字符),改成按 Tailwind 的真实解析行为拒收。
     每一条拒收都在下一条测试里被钉在 parseCandidateFiles 的实测结果上。 */
  const rejected = [
    'src/**/*.tsx', 'src/*.tsx', 'src/[ab].tsx', 'src/{a,b}.tsx', 'src/{a}.tsx',
    'src/+(a).tsx', 'src/@(a).tsx', 'src/!(a).tsx', 'src/?(a).tsx', 'src/*(a).tsx',
    'src/a,b.tsx',       // transport:--content 是逗号分隔多值串(条目 6)
    'src/?.tsx',         // 意图信号(实测 ? 在文件名里是字面的,但写 ? 通常是想用 glob)
    'src\\a.tsx',        // 反斜杠:分隔符歧义 + 实测无法用来转义 glob 元字符
    '/abs/a.tsx', '../outside.tsx', 'src/../../x.tsx', '', 'src//a.tsx',
    '.git/config', 'node_modules/pkg/a.tsx', 'src/node_modules/vendor/a.tsx',
  ];
  for (const p of rejected) assert.ok(explicitContentFileProblem(p), `未拒绝非法 content 条目:${JSON.stringify(p)}`);
  /* 旧白名单误杀过的合法文件名字符,现在必须放行(这才是条目 5 的实质:少一套自造政策)。
     单个不成对的 [ ] { } ! ( ) + @ 同样放行 —— 实测 Tailwind 对它们给出 glob===null。 */
  const accepted = [
    'src/a.tsx', 'apps/desktop/src/Foo.tsx', 'src/中文文件.tsx', 'src/a-b_c.1.tsx',
    'src/x y.tsx', 'src/a#b.tsx', 'src/a%b.tsx', 'src/a&b.tsx', "src/a'b.tsx",
    'src/a~b.tsx', 'src/a=b.tsx', 'src/a;b.tsx', 'src/a:b.tsx',
    'src/a[b.tsx', 'src/a]b.tsx', 'src/a{b.tsx', 'src/a}b.tsx',
    'src/a!b.tsx', 'src/a(b).tsx', 'src/a+b.tsx', 'src/a@b.tsx', 'src/a|b.tsx', 'src/a^b.tsx', 'src/a$b.tsx',
  ];
  for (const p of accepted) assert.equal(explicitContentFileProblem(p), null, `误杀合法显式文件:${p}`);
  // 报错文案必须写清迁移方式(破坏性变更)
  assert.match(explicitContentFileProblem('src/**/*.tsx'), /显式|glob/);
  assert.match(explicitContentFileProblem('src/a,b.tsx'), /逗号/, '逗号必须点名 --content 的承载问题');
  assert.match(explicitContentFileProblem('src/[ab].tsx'), /字符类/, '中括号必须点名 Tailwind 的字符类解释');
  // 受限 glob 白名单仍在,但只服务 component.sources 等其它 glob 用途(不再管 content)
  assert.equal(typeof restrictedGlobProblem, 'function');
  const rg = stripComments(readFileSync(join(ROOT, 'scripts/lib/repo-glob.mjs'), 'utf8'));
  assert.ok(!/GLOB_ALLOWED\.test\(entry\)/.test(rg), 'content 校验不该再走字符白名单(条目 5)');
});

test('条目 5 证据钉死(实跑真 tailwind): 拒收类必须 glob≠null,放行类必须 glob===null', () => {
  /* 这条是条目 5 的关键:证明我们的拒收**不是自造政策**,而是 Tailwind 自己的解析行为。
     用当前安装版本的 parseCandidateFiles 逐类核对;版本升级后行为若变化 → 本测试红,
     强制显式适配(不许悄悄放宽或收紧)。两个例外单独标注:',' 是 CLI transport、'?' 是意图信号。 */
  const req = createRequire(join(ROOT, 'package.json'));
  let parseCandidateFiles;
  let resolveConfig;
  try {
    ({ parseCandidateFiles } = req('tailwindcss/lib/lib/content.js'));
    resolveConfig = req('tailwindcss/resolveConfig');
  } catch (err) {
    assert.fail(`tailwindcss 内部 API 不可加载(${err.message})——必须显式适配,不许把字符政策留成无据之谈`);
  }
  const globOf = (name) => {
    const abs = `/tmp/qa-hifi-probe/${name}`;
    const cfg = resolveConfig({ content: [abs] });
    const e = parseCandidateFiles({ tailwindConfig: cfg }, cfg);
    return e.length ? e[0].glob : 'DROPPED';
  };
  // 拒收类:Tailwind 确实把它们当 glob(glob≠null)⇒ 我们的拒收是 E = L 的必要条件
  for (const n of ['a*b.tsx', '[ab].tsx', '{a}.tsx', '+(a).tsx', '@(a).tsx', '!(a).tsx', '?(a).tsx', '*(a).tsx']) {
    assert.notEqual(globOf(n), null, `${n} 在当前 tailwind 上已不是 glob —— 拒收理由需重新评估`);
    assert.ok(explicitContentFileProblem(`src/${n}`), `${n} 被 Tailwind 当 glob 却没被我们拒`);
  }
  // 放行类:Tailwind 当字面(glob===null)⇒ 拒它们就是误杀,必须放行
  for (const n of ['plain.tsx', 'x y.tsx', 'a#b.tsx', 'a%b.tsx', 'a&b.tsx', "a'b.tsx", 'a~b.tsx', 'a=b.tsx',
    'a;b.tsx', 'a:b.tsx', 'a[b.tsx', 'a]b.tsx', 'a{b.tsx', 'a}b.tsx', 'a!b.tsx', 'a(b).tsx', 'a+b.tsx',
    'a@b.tsx', 'a|b.tsx', 'a^b.tsx', 'a$b.tsx', '中文.tsx']) {
    assert.equal(globOf(n), null, `${n} 在当前 tailwind 上变成 glob 了 —— 必须改成拒收`);
    assert.equal(explicitContentFileProblem(`src/${n}`), null, `${n} 是字面文件名却被误杀(条目 5 要修的正是这个)`);
  }
  // 两个例外:拒收但**不是**因为 Tailwind 当 glob —— 报文里必须说清真实理由
  assert.equal(globOf('a?b.tsx'), null, '前提:? 在文件名里是字面的(所以拒它是意图信号,不是必要条件)');
  assert.match(explicitContentFileProblem('src/a?b.tsx'), /意图信号/);
  assert.equal(globOf('a,b.tsx'), null, '前提:逗号在 config 数组形式里是字面的(问题出在 --content 的 transport)');
  assert.match(explicitContentFileProblem('src/a,b.tsx'), /--content/);
});

test('条目 2 源码契约(不 skip): content 路径不再做任何 glob 展开;--content 传绝对路径', () => {
  const core = readFileSync(CORE, 'utf8');
  assert.match(core, /export function resolveContentFiles/, '必须有显式文件解析入口');
  assert.ok(!/expandTailwindContent/.test(stripComments(core)), '构建核心仍在对 content 做 glob 展开');
  assert.ok(!/expandRepoGlob\(repoRoot, pattern\)/.test(core), '构建核心仍在用自研展开算 tailwind content');
  assert.match(core, /S ⊆ E = L/, '不变式必须写进代码注释');
  // 两侧(可信侧复算 / demo 侧薄壳 build)必须共用同一份参数构造,否则字节复算会误杀
  assert.match(core, /export function contentCliArg/);
  const tpl = readFileSync(join(ROOT, 'templates/component-build.mjs'), 'utf8');
  assert.match(tpl, /contentCliArg\(/, '薄壳模板必须复用同一份 --content 参数构造');
  assert.ok(!/comp\.css\.content\.join\(','\)/.test(tpl), '模板仍在直接 join 相对路径 → 语义解释权没收回');
  assert.ok(!/comp\.css\.content\.join\(','\)/.test(core), '可信侧仍在直接 join 相对路径');
  // repo-glob 里 content 专用的 fast-glob 展开已下线(其它 glob 用途保留)
  const rg = readFileSync(join(ROOT, 'scripts/lib/repo-glob.mjs'), 'utf8');
  assert.ok(!/export function expandTailwindContent/.test(rg), 'content 的 fast-glob 展开应随本轮下线');
  assert.match(rg, /export function explicitContentFileProblem/);
  assert.match(rg, /export function expandRepoGlob/, 'assets/sources 等其它 glob 用途必须保留');
});

test('条目 2 集成(实跑真 tailwind): CLI override 后 Tailwind 实扫集恰等于 manifest 的 resolved list', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild 走到清单阶段');
  const { repo, dir } = makeFixture({
    name: 'exact-set',
    repoDeps: 'skill',
    css: { tailwindConfig: 'apps/desktop/tailwind.config.js', content: ['src/Declared.tsx', 'apps/desktop/src/Also.tsx'] },
    extraRepoFiles: {
      // relative:true + 一堆 config.content 声明:CLI override 之后都不该影响集合
      'apps/desktop/tailwind.config.js': "module.exports = { content: { relative: true, files: ['./**/*.tsx'] }, theme: {} };\n",
      'apps/desktop/src/Also.tsx': 'export const a = "bg-lime-500";\n',
      'src/Declared.tsx': 'export const d = "bg-sky-500";\n',
    },
  });
  const r = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const product = JSON.parse(r.stdout).buildInputs.product;
  const declared = ['src/Declared.tsx', 'apps/desktop/src/Also.tsx'].sort();
  // 断言 ③ 的一半:buildInputs.product 里的 content 部分 === resolved list
  assert.deepEqual(product.filter((p) => p.endsWith('.tsx')).sort(), declared, `入链集不等于声明集:${JSON.stringify(product)}`);

  /* 交叉验证 Tailwind **实际会扫的 file set**:调当前安装版本的私有 parseCandidateFiles。
     内部 API 不可加载或形状变化 → 本测试 fail-closed(强制升级适配),绝不 fallback 到自研 glob。 */
  const req = createRequire(join(ROOT, 'package.json'));
  let parseCandidateFiles;
  let resolveConfig;
  try {
    ({ parseCandidateFiles } = req('tailwindcss/lib/lib/content.js'));
    resolveConfig = req('tailwindcss/resolveConfig');
  } catch (err) {
    assert.fail(`tailwindcss 内部 API 不可加载(${err.message})——版本升级后必须显式适配本测试,不许退回自研 glob 语义`);
  }
  assert.equal(typeof parseCandidateFiles, 'function', 'parseCandidateFiles 形状变了,必须显式适配');
  const abs = declared.map((p) => realpathSync(join(repo, p)));
  const cfg = resolveConfig({ content: abs });
  const entries = parseCandidateFiles({ tailwindConfig: cfg }, cfg);
  assert.equal(entries.length, abs.length, `Tailwind 解析出的条目数不等于声明数:${JSON.stringify(entries)}`);
  for (const e of entries) {
    // 关键:显式绝对文件路径 ⇒ glob 为 null ⇒ 扫描集**就是**这个文件,不存在语义差异空间
    assert.equal(e.glob, null, `声明项被当成 glob 解释了(${e.original})——不变式 E = L 不成立`);
    assert.ok(abs.includes(realpathSync(e.base)), `Tailwind 会扫一个我们没声明的路径:${e.base}`);
  }
  assert.deepEqual(entries.map((e) => realpathSync(e.base)).sort(), abs.slice().sort(), '实扫集 ≠ 声明集');

  // resolveContentFiles(可信侧唯一实现)与上面 Tailwind 的解释必须一致
  assert.deepEqual(resolveContentFiles(repo, ['src/Declared.tsx', 'apps/desktop/src/Also.tsx']).absolute.map((p) => realpathSync(p)).sort(), abs.slice().sort());
});

test('条目 2 对抗 fixture(实跑真 tailwind): 只声明的文件的 class 进 CSS,所有陷阱都不进', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild 走完 build');
  /* 陷阱一次性全放:configDir 同名文件、repoRoot 同名文件、node_modules 下文件、.git 下文件、
     dotfile、字面 [ab].tsx、`***` 形态目录、symlink、中文路径、含逗号路径。
     每个文件放**唯一** class;只声明其中若干个。构建后:声明的必须出现,未声明的必须不出现。 */
  const decls = { 'src/Declared.tsx': 'bg-sky-500', 'apps/desktop/src/Also.tsx': 'bg-lime-500', 'src/中文目录/文件.tsx': 'bg-rose-500' };
  const traps = {
    'apps/desktop/src/Declared.tsx': 'bg-amber-500',
    'src/Also.tsx': 'bg-violet-500',
    'src/node_modules/vendor-widget/Widget.tsx': 'bg-fuchsia-500',
    'src/.hidden.tsx': 'bg-orange-500',
    'src/[ab].tsx': 'bg-emerald-500',
    'src/***/Star.tsx': 'bg-cyan-500',
    'src/a,b.tsx': 'bg-indigo-500',
    'src/Untouched.tsx': 'bg-yellow-500',
  };
  const files = {};
  for (const [rel, cls] of Object.entries({ ...decls, ...traps })) files[rel] = `export const c = "${cls}";\n`;
  files['apps/desktop/tailwind.config.js'] = "module.exports = { content: { relative: true, files: ['./**/*.tsx', '../../src/**/*.tsx'] }, theme: {} };\n";

  const { repo, dir } = makeFixture({
    name: 'traps',
    repoDeps: 'skill',
    css: { tailwindConfig: 'apps/desktop/tailwind.config.js', content: Object.keys(decls) },
    extraRepoFiles: files,
  });
  // symlink 陷阱:指向一个未声明的文件
  writeFileSync(join(repo, 'src/SymTarget.tsx'), 'export const c = "bg-pink-500";\n');
  symlinkSync(join(repo, 'src/SymTarget.tsx'), join(repo, 'src/SymLink.tsx'));
  // .git 下的陷阱文件
  writeFileSync(join(repo, '.git/GitTrap.tsx'), 'export const c = "bg-stone-500";\n');

  const b = run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() });
  assert.equal(b.status, 0, `${b.stdout}${b.stderr}`);
  const css = readFileSync(join(dir, 'assets/component.css'), 'utf8');
  for (const cls of Object.values(decls)) assert.match(css, new RegExp(cls.replace(/[-]/g, '\\-')), `声明文件的 class ${cls} 没进 CSS`);
  for (const [rel, cls] of Object.entries(traps)) assert.ok(!css.includes(cls), `未声明的陷阱 ${rel} 的 class ${cls} 进了 CSS —— E = L 不成立`);
  for (const cls of ['bg-pink-500', 'bg-stone-500']) assert.ok(!css.includes(cls), `symlink/.git 陷阱的 class ${cls} 进了 CSS`);

  // 断言 ③ 的另一半:逐一修改每个声明文件都让旧 report/hash 失效
  for (const rel of Object.keys(decls)) {
    const before = readFileSync(join(repo, rel), 'utf8');
    writeFileSync(join(repo, rel), `${before}export const extra = "bg-gray-500";\n`);
    const r = run(CORE, ['--check-css', '--demo', dir], { cwd: dir, env: env() });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.notEqual(JSON.parse(r.stdout).sha256, hashFile(join(dir, 'assets/component.css')), `改 ${rel} 之后 CSS 字节复算没失效`);
    writeFileSync(join(repo, rel), before);
  }
});

test('条目 2 不扩大扫描集(实跑真 tailwind): config.relative / config.content / plugin 都不改集合;改 plugin 让旧 CSS 被拒', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild 走完 build');
  const { repo, dir } = makeFixture({
    name: 'no-widen',
    repoDeps: 'skill',
    css: { tailwindConfig: 'tailwind.config.js', content: ['src/StyleOnly.tsx'] },
    extraRepoFiles: {
      'tw-plugin.js': "module.exports = function ({ addUtilities }) { addUtilities({ '.qa-mark': { color: '#111111' } }); };\n",
      'src/Sneaky.tsx': 'export const s = "bg-emerald-500";\n',
    },
  });
  // config 里 relative:true + 声明一堆 content + require 一个 plugin:集合不该被扩大
  writeFileSync(
    join(repo, 'tailwind.config.js'),
    "module.exports = { content: { relative: true, files: ['./src/**/*.tsx'] }, theme: {},"
    + " plugins: [require('./tw-plugin.js')], safelist: ['qa-mark'] };\n",
  );
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const css = readFileSync(join(dir, 'assets/component.css'), 'utf8');
  assert.ok(!css.includes('bg-emerald-500'), 'config.content 把未声明文件带进了扫描集 —— override 没生效');
  assert.match(css, /#111111/, 'plugin 的产物应在 CSS 里(它不改扫描集,但改字节)');
  const inputs = readJson(join(dir, 'component.inputs.json'));
  assert.deepEqual(inputs.buildInputs.product.filter((p) => p.endsWith('.tsx')), ['src/StyleOnly.tsx']);
  assert.ok(!inputs.buildInputs.product.includes('tw-plugin.js'), '前提:plugin 依赖确实不在入链清单里(靠 CSS 字节复算兜)');

  // 改 plugin(不在入链清单里)→ trusted CSS 字节复算立刻不符 → verify 红
  writeFileSync(
    join(repo, 'tw-plugin.js'),
    "module.exports = function ({ addUtilities }) { addUtilities({ '.qa-mark': { color: '#222222' } }); };\n",
  );
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, 'plugin 改了没重建,verify 必须红');
  assert.match(`${v.stdout}${v.stderr}`, /CSS 字节与可信侧复算结果不一致/);
});

test('条目 2 破坏性迁移(实跑): 旧式 glob content 直接被拒并给出迁移指引', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild 走到 content 校验');
  const { dir } = makeFixture({
    name: 'legacy-glob',
    repoDeps: 'skill',
    css: { tailwindConfig: 'tailwind.config.js', content: ['src/**/*.tsx'] },
  });
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, '旧式 glob content 必须被拒(破坏性变更)');
  const out = `${v.stdout}${v.stderr}`;
  assert.match(out, /component\.css\.content/);
  assert.match(out, /显式/, '报错必须写清迁移方式:改成显式文件路径列表');
  // 生成器提示:让作者知道有工具可以把当前 glob 展成建议清单
  assert.match(out, /--suggest-content|生成器/);
});

test('条目 2 版本联动(不 skip): tailwindcss/fast-glob/micromatch 版本变化必须触发本套集成测试', () => {
  const pkg = readJson(join(ROOT, 'package.json'));
  const dev = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  assert.ok(dev.tailwindcss, 'tailwindcss 必须钉成依赖,否则真 tailwind 分支无法被真跑');
  const lock = readJson(join(ROOT, 'package-lock.json'));
  const pinned = readJson(join(ROOT, 'scripts/__tests__/fixtures/r7-content-engine-versions.json'));
  const versionOf = (name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;
  for (const name of Object.keys(pinned)) {
    assert.equal(
      versionOf(name),
      pinned[name],
      `${name} 版本从 ${pinned[name]} 变成 ${versionOf(name)} —— content 扫描语义可能变了。`
      + '\n请重跑本文件的「条目 2 集成/对抗 fixture」两条实跑测试确认 E = L 仍成立,'
      + '再把 scripts/__tests__/fixtures/r7-content-engine-versions.json 更新到新版本。'
      + '\n(tailwind 的 parseCandidateFiles 是包内私有 API,不是升级稳定契约,必须每次显式适配。)',
    );
  }
});


// ============================================================================
// 条目 3 — esbuild file-loader 派生资产的字节复算（新 P0）
// ============================================================================

/** 真 `import hero.png` 的组件 + 派生字体：产出 JS + PNG + WOFF 三类 output。 */
function makeAssetFixture(name) {
  const { repo, dir } = makeFixture({ name, repoDeps: true });
  // 8x8 纯色 PNG（最小合法字节）与一份假字体：内容不同、扩展名走 file loader
  const png = (r, g, b) => {
    const raw = [];
    for (let y = 0; y < 8; y += 1) { raw.push(0); for (let x = 0; x < 8; x += 1) raw.push(r, g, b, 255); }
    const idat = zlib.deflateSync(Buffer.from(raw));
    const crcT = [...Array(256).keys()].map((n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b2) => { let c = 0xffffffff; for (const x of b2) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  };
  writeFileSync(join(repo, 'src/components/hero.png'), png(255, 0, 0));
  writeFileSync(join(repo, 'src/components/face.woff'), Buffer.from('wOFF-fake-font-v1'));
  // entry 真 import 两个资产并用上（不能被 tree-shake）
  writeFileSync(join(repo, 'src/components/Claimed.ts'), [
    "import { helper } from './Helper';",
    "import hero from './hero.png';",
    "import face from './face.woff';",
    'export function Claimed(){ return `CLAIMED-${helper()}-${hero}-${face}`; }',
    '',
  ].join('\n'));
  return { repo, dir, png };
}
/** demo 里 esbuild 派生出的资产（不含 bundle 与 CSS）。 */
const derivedAssets = (dir) => readdirSync(join(dir, 'assets'))
  .filter((f) => !f.startsWith('component.'));

test('条目 3 源码契约(不 skip): 复算覆盖全部 esbuild 产物，而不只是 JS 字节', () => {
  const core = stripComments(readFileSync(CORE, 'utf8'));
  assert.match(core, /export async function computeExpectedEsbuildOutputs/, '必须有全产物复算入口');
  assert.match(core, /outputFiles/, '必须遍历 write:false 的 outputFiles');
  assert.match(core, /--check-outputs/, 'CLI 必须支持 --check-outputs');
  const fsu = stripComments(readFileSync(join(ROOT, 'scripts/lib/fs-utils.mjs'), 'utf8'));
  assert.match(fsu, /export function recheckComponentOutputs/);
  assert.match(fsu, /'--check-outputs'/, '复算必须跑 skill canonical 的 --check-outputs');
  assert.match(fsu, /缺产物/, '缺失产物必须报错(不能只比存在的那些)');
  const v = stripComments(readFileSync(VERIFY, 'utf8'));
  assert.match(v, /recheckComponentOutputs\(demoDir, spec\.component\)/, '门 A 必须调全产物复算');
  // I-ESBUILD 的表述必须落在代码注释里
  assert.match(readFileSync(join(ROOT, 'scripts/lib/fs-utils.mjs'), 'utf8'), /I-ESBUILD/);
});

test('条目 3 PoC: 派生 PNG 原地换字节但保留 [hash] 文件名 → 必须门红 + pr-block exit 2', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir, png } = makeAssetFixture('asset-swap');
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0, 'build 失败');
  const assets = derivedAssets(dir);
  const hero = assets.find((f) => f.endsWith('.png'));
  assert.ok(hero, `没产出派生 PNG,PoC 前提不成立:${JSON.stringify(assets)}`);
  assert.match(hero, /-[A-Z0-9]{8}\.png$/, '派生资产文件名应含 esbuild 的 [hash] 指纹');
  // 初次 verify 必须绿(证明 PoC 起点是合法状态)
  assert.equal(run(VERIFY, ['--demo', dir], { env: env() }).status, 0, '合法多资产 bundle 初次 verify 就红了');
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0);

  // 攻击:同名覆盖成另一张图(蓝色),不改文件名
  writeFileSync(join(dir, 'assets', hero), png(0, 0, 255));
  // 攻击者照常重跑资产闸门(它对当前字节现算,天然自洽)
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0, '资产闸门本身不该拦(它不是这条的防线)');
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  const out = `${v.stdout}${v.stderr}`;
  assert.notEqual(v.status, 0, `派生资产换字节后 verify 仍全绿(条目 3 未修):${out}`);
  assert.match(out, /字节与可信侧复算结果不一致/);
  assert.match(out, new RegExp(hero.replace(/[.[\]]/g, '\\$&')), '报文必须点名是哪个派生资产');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 2, `派生资产被换字节居然出了块:${pr.stdout}${pr.stderr}`);
  assert.ok(!/真组件直渲.*✅/.test(pr.stdout), '不许贴「真组件直渲 ✅」');
});

test('条目 3 变体(实跑): 删除派生资产 / 换名 / 改字体字节 → 一律门红', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeAssetFixture('asset-variants');
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const assets = derivedAssets(dir);
  const hero = assets.find((f) => f.endsWith('.png'));
  const font = assets.find((f) => f.endsWith('.woff'));
  assert.ok(hero && font, `多资产前提不成立:${JSON.stringify(assets)}`);
  const heroAbs = join(dir, 'assets', hero);
  const fontAbs = join(dir, 'assets', font);
  const heroBytes = readFileSync(heroAbs);
  const fontBytes = readFileSync(fontAbs);
  const expectRed = (label) => {
    run(ASSETS_MANIFEST, ['--demo', dir], { env: env() });
    const v = run(VERIFY, ['--demo', dir], { env: env() });
    assert.notEqual(v.status, 0, `${label} 之后 verify 仍绿`);
    assert.match(`${v.stdout}${v.stderr}`, /字节与可信侧复算结果不一致|缺产物/, `${label} 的报错不是产物复算不符`);
  };
  // ① 删除派生资产
  rmSync(heroAbs);
  expectRed('删除派生 PNG');
  writeFileSync(heroAbs, heroBytes);
  // ② 换名(内容不动,只改文件名)
  const renamed = join(dir, 'assets', hero.replace(/-([A-Z0-9]{8})\.png$/, '-ZZZZZZZZ.png'));
  renameSync(heroAbs, renamed);
  expectRed('派生 PNG 换名');
  renameSync(renamed, heroAbs);
  // ③ 改字体字节
  writeFileSync(fontAbs, Buffer.from('wOFF-fake-font-v2-TAMPERED'));
  expectRed('改派生字体字节');
  writeFileSync(fontAbs, fontBytes);
  // 复原后必须回绿(证明上面三次红不是被别的门顺带带红的)
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0);
  assert.equal(run(VERIFY, ['--demo', dir], { env: env() }).status, 0, '复原后没回绿 → 上面的判定不精确');
});

test('条目 3 阳性对照(实跑): 正常多资产 bundle(JS+PNG+WOFF)全链绿，额外手工资产只列出不阻断', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeAssetFixture('asset-ok');
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  // 作者手工放进 assets/ 的额外图片:不在 expected 集合里,按产品策略**不阻断**
  writeFileSync(join(dir, 'assets/manual-note.png'), Buffer.from('not-an-esbuild-output'));
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(v.status, 0, `正常多资产 + 手工资产被误杀:${v.stdout}${v.stderr}`);
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.outputsRecheck.status, 'ok');
  assert.ok(rep.gateA.outputsRecheck.checked >= 3, `应至少复算 JS+PNG+WOFF 三个产物:${JSON.stringify(rep.gateA.outputsRecheck)}`);
  assert.ok(
    (rep.gateA.outputsRecheck.extraAssets ?? []).includes('assets/manual-note.png'),
    `额外资产必须被如实列出以便人核对:${JSON.stringify(rep.gateA.outputsRecheck)}`,
  );
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 0, `正常多资产路径被误杀:${pr.stdout}${pr.stderr}`);
});

// ============================================================================
// 条目 4 — 不可变 snapshot（I-OBSERVE）
// ============================================================================

test('条目 4 源码契约(不 skip): 快照在前置门之后、任何 demo 代码之前建立，浏览器从快照加载', () => {
  const v = readFileSync(VERIFY, 'utf8');
  const iNm = v.indexOf('checkDemoNoNodeModules(demoDir)');
  const iSnap = v.indexOf('snapshotDir = makeObservationSnapshot(demoDir)');
  const iServe = v.indexOf('createSafeStaticServer(snapshotDir)');
  const iBoundary = v.indexOf('分界线:以下开始执行 demo 侧代码');
  /* r11 更新(不是回退):收口比对的调用点从 manifestCheckpoint('post-run')(snapshot 文件树 vs disk)
     换成 diffAgainstFrozen(frozenSnapshot, demoDir) —— 基准改成分界线前冻结在父进程内存里的
     manifest。原因:snapshot 与 exec 树同处可枚举可写的 tmpdir,后置脚本能把两边同步改成相同字节
     让旧口径报全等(审核人 PoC,见 comp-fix-r11.test.mjs)。次序要求不变且更严:冻结必须在分界线
     **之前**、比对必须在分界线**之后**,两条都由 comp-fix-r11 的源码契约另行钉住。 */
  const iDrift = v.indexOf('diffAgainstFrozen(frozenSnapshot, demoDir)');   // r8:单向→双向;r11:基准换成冻结内存 manifest
  for (const [l, i] of [['node_modules 前置门', iNm], ['快照建立', iSnap], ['从快照起服务', iServe],
    ['分界线', iBoundary], ['快照偏离比对', iDrift]]) assert.ok(i > 0, `verify.mjs 里找不到 ${l}`);
  assert.ok(iNm < iSnap, '快照必须建立在 demo node_modules fail-fast 之后');
  assert.ok(iSnap < iBoundary, '快照必须建立在执行任何 demo 代码之前');
  assert.ok(iBoundary < iDrift, '快照偏离比对必须排在执行 demo 代码之后');
  assert.ok(!/createSafeStaticServer\(demoDir\)/.test(v), 'verify 仍在从 demo 原地提供文件(I-OBSERVE 不成立)');
  assert.match(v, /I-OBSERVE/, '不变式名必须写进源码');
  /* 快照要整树复制以保住相对路径依赖。r8 条目 A:排除表被取消 —— 实现移到 lib/observe.mjs,
     只跳 node_modules / .git(前置门已拒 / 不属交付产物),工具输出改写 output root。
     详细契约见 comp-fix-r8 的「条目 A 源码契约」。 */
  const ob = readFileSync(join(ROOT, 'scripts/lib/observe.mjs'), 'utf8');
  assert.match(ob, /recursive: true/);
  assert.match(ob, /SNAPSHOT_SKIP_TOP = \['node_modules', '\.git'\]/);
});

test('条目 4 PoC(实跑): 页面脚本在观察窗口内改写 index.html —— 观察对象仍是快照，且偏离被抓', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  /* 只靠时序挡不住这一类:改写发生在**浏览器观察进行中**(自定义门里模拟一个与观察并发的
     写入者)。快照让观察对象固定,所以测量结果不受影响;偏离本身仍要如实报出来 ——
     磁盘上的 demo 已不是被观察的那一份,PR 会带走另一个版本。 */
  const { dir } = makeFixture({
    name: 'snapshot-drift',
    repoDeps: true,
    bindings: [{ sel: '.box', prop: 'width', truth: 'geometry.width', kind: 'length' }],
    customGates: [{ id: 'rewriter', script: 'rewrite-gate.mjs' }],
  });
  writeFileSync(join(dir, 'rewrite-gate.mjs'), [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const argv = process.argv.slice(2);",
    "const f = join(argv[argv.indexOf('--demo') + 1], 'index.html');",
    "writeFileSync(f, readFileSync(f, 'utf8').replace('width:16px', 'width:99px'));",
    "process.stdout.write('rewritten');\n",
  ].join('\n'));
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  // 门 D 在快照上测的是正确值 → 它自己是绿的(证明观察对象没被换掉)
  assert.equal(rep.gateD.pass, true, `门 D 应在快照上测到正确值:${JSON.stringify(rep.gateD.failures)}`);
  // 但偏离必须被抓,整体判红
  assert.notEqual(v.status, 0, '磁盘与快照偏离却仍全绿');
  assert.notEqual(rep.gateA.snapshotDrift, 'none', '快照偏离没被记录');
  assert.match(`${v.stdout}${v.stderr}`, /与观察快照发生偏离/);
});

test('条目 4 阳性对照(实跑): 快照不误杀带子目录/中文名/相对路径依赖的 demo', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({ name: 'snapshot-ok', repoDeps: true });
  // 额外静态依赖:子目录 + 中文文件名,由 index.html 相对引用
  mkdirSync(join(dir, 'static/子目录'), { recursive: true });
  writeFileSync(join(dir, 'static/子目录/额外.css'), '.extra{color:#00ff00}\n');
  writeFileSync(
    join(dir, 'index.html'),
    readFileSync(join(dir, 'index.html'), 'utf8').replace('<head>', '<head><link rel="stylesheet" href="static/子目录/额外.css">'),
  );
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(v.status, 0, `快照方案误杀了带子目录/中文名相对依赖的 demo:${v.stdout}${v.stderr}`);
  assert.equal(readJson(join(dir, 'report.json')).gateA.snapshotDrift, 'none');
  /* 快照必须跑完即删。这里**不去数 tmpdir 里的残留**:全套测试并发跑时别的 verify 进程
     正好持有自己的快照,数出来的非零是别人的,那是条 flaky 断言(实测在全量运行下会红)。
     清理由 verify 的 finally 分支保证,断言放在上一条源码契约里(rmSync(snapshotDir…))。 */
  assert.match(readFileSync(VERIFY, 'utf8'), /rmSync\(snapshotDir, \{ recursive: true, force: true \}\)/, '快照必须在 finally 里删掉');
});

// ============================================================================
// 条目 6 — 逗号文件名的传参边界
// ============================================================================

test('条目 6 实测前提(实跑真 tailwind): --content 是逗号分隔多值串，含逗号的路径无法承载', (t) => {
  if (!MODULE_ROOT) return t.skip('需要 skill 侧真 tailwind CLI');
  /* 这条钉住「为什么必须拒逗号」的实测事实本身:直接调 tailwind CLI,把含逗号的文件与一个
     普通文件 join 成一个 --content 串 —— 含逗号那个文件的 class 不会进 CSS(静默漏扫)。
     若某天 CLI 支持了引号/重复 --content,这条测试会红,届时可以重新评估是否放开。 */
  const repo = mkdtempSync(join(tmpdir(), 'qa-r7-comma-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'tailwind.config.js'), 'module.exports = { content: [], theme: {} };\n');
  writeFileSync(join(repo, 'src/a,b.tsx'), 'export const c = "bg-teal-500";\n');
  writeFileSync(join(repo, 'src/plain.tsx'), 'export const d = "bg-amber-500";\n');
  writeFileSync(join(repo, 'in.css'), '@tailwind utilities;\n');
  const bin = join(ROOT, 'node_modules/.bin/tailwindcss');
  const r = spawnSync(bin, ['-c', join(repo, 'tailwind.config.js'), '-i', join(repo, 'in.css'),
    '-o', join(repo, 'out.css'), '--content', `${join(repo, 'src/a,b.tsx')},${join(repo, 'src/plain.tsx')}`],
  { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const css = readFileSync(join(repo, 'out.css'), 'utf8');
  assert.match(css, /bg-amber-500/, '普通文件应被扫到(对照)');
  assert.ok(!css.includes('bg-teal-500'), '前提变了:--content 现在能承载含逗号的路径了,拒逗号的理由需重新评估');
});

test('条目 6 fixture(实跑): 声明含逗号的文件 → 入口拒绝，不静默 join', (t) => {
  if (!MODULE_ROOT) return t.skip('需要真 esbuild 走到 content 校验');
  const { dir } = makeFixture({
    name: 'comma-content',
    repoDeps: 'skill',
    css: { tailwindConfig: 'tailwind.config.js', content: ['src/a,b.tsx'] },
    extraRepoFiles: { 'src/a,b.tsx': 'export const c = "bg-teal-500";\n' },
  });
  const b = run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() });
  assert.notEqual(b.status, 0, '含逗号的 content 声明必须被拒(否则静默漏扫)');
  assert.match(`${b.stdout}${b.stderr}`, /逗号/);
  assert.match(`${b.stdout}${b.stderr}`, /--content/, '报文必须点名真实理由(transport 而非 glob)');
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, 'verify 侧同样必须拒');
});
// ============================================================================
// 文档校准
// ============================================================================

test('文档契约(不 skip): SKILL.md 必须写明执行时序原则、S ⊆ E = L、破坏性迁移与残余风险', () => {
  const doc = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  // 条目 1:时序原则 + 残余风险(不许只写「已修复」)
  assert.match(doc, /### 执行时序原则/, '必须有独立的执行时序原则小节');
  assert.match(doc, /canonical runner 自己不能在核心观察之前执行被审方的代码/);
  assert.match(doc, /detached/, '必须点名 detached 子进程这条攻击形态');
  assert.match(doc, /纵深，不是主防线/, '事后 hash 的定位必须如实(不能被写成主防线)');
  assert.match(doc, /残余风险/);
  assert.match(doc, /OS 级 sandbox/, '未做 OS sandbox 这条降级必须写明');
  assert.match(doc, /Node `vm` 不是安全/, '不许把 vm 说成隔离手段');
  // 条目 2:破坏性变更 + 不变式 + 迁移路径
  assert.match(doc, /破坏性变更（r7 条目 2）/);
  assert.match(doc, /--suggest-content/, '迁移方式(生成器)必须写在文档里');
  assert.match(doc, /S ⊆ E = L/, '不变式必须写进文档');
  assert.match(doc, /参数结构/, '必须说明不变式靠参数结构保证,而不是事后猜测');
  assert.ok(!/受限 glob\*\*——r5 起改成\*\*白名单式字符扫描/.test(doc), 'content 段仍在按 glob 描述,与 r7 实现不符');
  // 门级全表两处次序说明
  assert.match(doc, /之后\*\*才处理 demo extractor/, '门 A 行必须写明 extractor 排在三项复算之后');
  // 条目 3/4:三层不变式必须成文,派生资产那行的旧判定必须被显式纠正
  assert.match(doc, /### 三层不变式/, '必须有三层不变式小节');
  for (const k of ['I-ESBUILD', 'I-CSS', 'I-OBSERVE']) assert.match(doc, new RegExp(k), `缺不变式 ${k}`);
  assert.match(doc, /要么是可信工具当前输入的确定性输出、要么验收失败/, '三者同时成立后的总表述必须原样在文档里');
  assert.match(doc, /内容指纹不是密码学校验|内容指纹\*\*不是密码学校验/, '必须写明 [hash] 不是校验和');
  assert.match(doc, /此前判「间接达成」是\*\*错的\*\*/, '产物全表里派生资产的旧判定必须被显式纠正,而不是悄悄改掉');
  assert.match(doc, /不可变 snapshot/, 'I-OBSERVE 的快照必须写进时序小节');
  assert.match(doc, /snapshotDrift/, '快照偏离的报告字段必须可查');
  // 条目 5/6:两层政策与实测理由
  assert.match(doc, /① 路径安全/, 'content 校验必须分「路径安全」与「glob/transport 形态」两层');
  assert.match(doc, /Tailwind 自己会当 glob 解释的形态/, '不许再把它写成本工具的字符白名单');
  assert.match(doc, /意图信号/, '? 的取舍必须如实标注');
  assert.match(doc, /逗号分隔多值串/, '逗号必须写明是 transport 限制');
  assert.match(doc, /排在可信 verify \*\*之前\*\*/, '门 E 行必须写明可信重跑的新次序');
});

// ============================================================================
// 条目 7 — 防再漏门机制（门列表唯一真相源 + taint 保护）
// ============================================================================

test('条目 7a 唯一真相源(不 skip): 门列表只有 TRUSTED_GATES 一份，别处不许再手写', () => {
  assert.deepEqual(GATE_LETTERS, ['A', 'B', 'C', 'D', 'E', 'F', 'X']);
  assert.deepEqual(lettersFor('verify'), ['A', 'B', 'C', 'D', 'F', 'X']);
  assert.deepEqual(lettersFor('pixel'), ['E']);
  // verify / pr-block / 渲染器都必须遍历映射,而不是内联门字母数组
  const v = stripComments(readFileSync(VERIFY, 'utf8'));
  assert.match(v, /lettersFor\('verify'\)/, "verify 的门集合必须取自 lettersFor('verify')");
  assert.ok(!/\[\s*'A',\s*'B',\s*'C',\s*'D',\s*'F',\s*'X'\s*\]/.test(v), 'verify 里仍有手写门字母数组(条目 7a)');
  const pb = stripComments(readFileSync(PR_BLOCK, 'utf8'));
  assert.ok(
    !/\['gateA',\s*'gateB'/.test(pb),
    'pr-block 里仍有手写的 gateA/gateB/… 门列表 —— 门 E 那个 CRITICAL 就是这么漏的',
  );
  assert.match(pb, /lettersFor\('verify'\)/, 'pr-block 的投影门集合必须取自映射');
  const rn = stripComments(readFileSync(join(ROOT, 'scripts/lib/pr-render.mjs'), 'utf8'));
  assert.match(rn, /TRUSTED_GATES\[letter\]/, 'PR 门表渲染必须按映射取 runner');
  assert.match(rn, /GATE_LETTERS\.filter/, '渲染器必须自查有没有漏门');
});

test('条目 7c③ 四者集合全等(不 skip): TRUSTED_GATES / verify 实现 / runner 映射 / SKILL.md 门表', () => {
  const letters = new Set(GATE_LETTERS);
  // ① verify 运行时接受的门字母(--gate 的合法取值)必须 === runner 为 verify 的那批
  const usage = run(VERIFY, ['--demo', ROOT, '--gate', 'Z'], { env: env() });
  const m = /只支持 ([A-Z/]+)/.exec(`${usage.stdout}${usage.stderr}`);
  assert.ok(m, `verify 的 --gate 报文里读不到合法门字母:${usage.stdout}${usage.stderr}`);
  assert.deepEqual(m[1].split('/').sort(), lettersFor('verify'), 'verify 实际接受的门字母 ≠ 映射');
  // ② runner 取值必须都在 RUNNERS 里,且每个门字母都有 runner
  for (const l of GATE_LETTERS) assert.ok(RUNNERS.includes(TRUSTED_GATES[l]), `门 ${l} 的 runner 非法`);
  // ③ SKILL.md 门级全表里的字母门必须与映射集合全等
  const doc = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  const table = doc.slice(doc.indexOf('| 门 | 结论进 PR 附贴块'));
  const docLetters = new Set([...table.matchAll(/^\| ([A-Z]) [^|]+\|/gm)].map((x) => x[1]));
  assert.deepEqual([...docLetters].sort(), [...letters].sort(), 'SKILL.md 门级全表与 TRUSTED_GATES 不等 —— 新增门字母必须同步文档');
  // ④ 渲染器的门行实现必须每个字母都有(漏一个就等于那门不出块)
  const rn = readFileSync(join(ROOT, 'scripts/lib/pr-render.mjs'), 'utf8');
  const rows = new Set([...rn.matchAll(/^  ([A-Z]): \(/gm)].map((x) => x[1]));
  assert.deepEqual([...rows].sort(), [...letters].sort(), '渲染器的 GATE_ROWS 与 TRUSTED_GATES 不等');
});

test('条目 7b taint 单测(不 skip): 未标记的 report 喂给渲染器必须 throw', () => {
  const spec = { meta: { name: 'x' }, component: { mode: 'component' } };
  const fakeReport = {
    ok: true, toolVersion: 'x', generatedAt: 'now', coverage: { cases: [] },
    gateA: { pass: true }, gateB: { pass: true, passed: 1, total: 1, entryRenderProof: 'proved' },
    gateC: { pass: true, checks: [{ id: 'no-clip' }] }, gateD: { pass: true, total: 1 },
    gateF: { pass: true, total: 1 }, gateX: { pass: true, total: 0 },
    inputHashes: { componentSources: { sources: { 'a.ts': 'h' } } },
  };
  // ① 直接喂 JSON.parse 出来的普通对象(模拟"忘了走可信侧")→ 必须炸
  assert.throws(
    () => renderPrBlock({ spec, trustedVerify: JSON.parse(JSON.stringify(fakeReport)) }),
    /未经 canonical runner 标记/,
    '未标记的 report 居然能出块 —— taint 保护没生效',
  );
  // ② 手工构造一个"看起来一样"的盒子也不行(WeakSet 成员身份无法伪造)
  assert.throws(() => renderPrBlock({ spec, trustedVerify: { runner: 'verify', payload: fakeReport } }), /未经 canonical runner 标记/);
  // ③ runner 张冠李戴也不行
  assert.throws(
    () => renderPrBlock({ spec, trustedVerify: markTrustedRun('pixel', fakeReport) }),
    /来自 runner "pixel"/,
  );
  // ④ 正确标记后可以出块,且数字取的是**被标记那份**
  const out = renderPrBlock({ spec, trustedVerify: markTrustedRun('verify', { ...fakeReport, gateB: { ...fakeReport.gateB, passed: 42, total: 42 } }) });
  assert.match(out, /状态覆盖（实际执行 42\/42）/, 'PR 数字必须来自可信盒子里的 payload');
  // ⑤ 门 E 的盒子同样受检
  assert.throws(() => renderPrBlock({ spec, trustedVerify: markTrustedRun('verify', fakeReport), trustedPixel: { ok: true } }), /未经 canonical runner 标记/);
});

test('条目 7c① provenance(不 skip): 渲染器结构上读不到 demo 自报的 report', () => {
  const rn = readFileSync(join(ROOT, 'scripts/lib/pr-render.mjs'), 'utf8');
  // 渲染器不许自己读盘、不许接收 claimed/自报参数
  for (const bad of ['readFileSync', 'existsSync', 'demoDir', 'claimed', 'report.json']) {
    assert.ok(!stripComments(rn).includes(bad), `渲染器出现了 ${bad} —— 它必须只吃可信盒子,不许自己取数据`);
  }
  // 所有门行的数据对象只能是 v(trusted verify)或 px(trusted pixel)
  const rowsSrc = rn.slice(rn.indexOf('const GATE_ROWS'), rn.indexOf('export function renderPrBlock'));
  assert.ok(!/\breport\b/.test(stripComments(rowsSrc)), '门行里出现了 report 变量(可能是自报来源)');
  // pr-block 侧:出块调用只传可信盒子 + 明确分离的政策输入
  const pb = readFileSync(PR_BLOCK, 'utf8');
  assert.match(pb, /trustedVerify: trustedVerifyBox/);
  assert.match(pb, /trustedPixel: trustedPixelBox/);
  assert.match(pb, /assetsPolicy:/, '抬闸政策输入必须与测量证据分开传(条目 11)');
  assert.ok(!/lines\.push/.test(pb), 'pr-block 里仍在自己拼门表 —— 渲染必须收敛到 pr-render');
});

test('条目 7d 对抗(实跑): 三份自报各自手写全绿且不跑对应执行器 → 分别被 canonical/现算阻断', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  /* 三份"报告型 JSON"逐个来一遍:每次都手写成全绿、且**不运行**对应执行器,
     断言 A-X / E / 体积门分别被 canonical runner 或 pr-block 现算挡住。 */
  const baselines = [{ key: 'one', frameSel: '#frame' }];

  // ① report.json:手写全绿 + 从不跑 verify(门 D 声明 1 条但 index.html 落盘的是错值)
  {
    const { dir, truth } = makeFixture({
      name: 'forge-report', repoDeps: true, boxWidth: '99px',
      bindings: [{ sel: '.box', prop: 'width', truth: 'geometry.width', kind: 'length' }],
    });
    assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
    writeFileSync(join(dir, 'report.json'), `${JSON.stringify({
      ok: true, partial: false, toolVersion: TOOL_VERSION, demo: 'forge-report',
      inputHashes: buildInputHashes(dir, readJson(join(dir, 'spec.json'))),
      statesResult: { total: 1, viaReachable: 1, tabOnly: 0 },
      truthStats: { fixtureLeaves: 0 },
      coverage: { cases: [{ id: 'desk-cn-light', prefs: {}, source: 'spec' }] },
      gateA: { name: 'A', pass: true, extractorDrift: 'none' },
      gateB: { name: 'B', pass: true, passed: 1, total: 1, failures: [], cases: [], entryRenderProof: 'proved' },
      gateC: { name: 'C', pass: true, checks: [{ id: 'no-clip', pass: true, failures: [] }] },
      gateD: { name: 'D', pass: true, passed: 1, total: 1, failures: [], cases: [] },
      gateF: { name: 'F', pass: true, passed: 0, total: 0, failures: [], cases: [] },
      gateX: { name: 'X', pass: true, total: 0, passed: 0, failures: [], gates: [] },
      generatedAt: new Date(0).toISOString(),
    }, null, 2)}\n`);
    run(ASSETS_MANIFEST, ['--demo', dir], { env: env() });
    const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
    assert.equal(pr.status, 2, `手写全绿 report.json 居然出了块:${pr.stdout}${pr.stderr}`);
    assert.match(`${pr.stdout}${pr.stderr}`, /trusted-verify|trusted-report/, '必须由可信侧重跑挡住');
    void truth;
  }

  // ② report-pixel.json:手写全 PASS + 基准图是非 PNG(真跑一定 ERROR)
  {
    const { dir, spec } = makeFixture({ name: 'forge-pixel', repoDeps: true });
    const s2 = readJson(join(dir, 'spec.json'));
    s2.baselines = baselines; s2.baselineFrameSel = '#frame';
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(s2, null, 2));
    mkdirSync(join(dir, 'baselines'), { recursive: true });
    writeFileSync(join(dir, 'baselines/one.png'), 'NOT-A-PNG');
    assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
    assert.equal(run(VERIFY, ['--demo', dir], { env: env() }).status, 0, '除门 E 之外应该是绿的');
    writeFileSync(join(dir, 'report-pixel.json'), `${JSON.stringify({
      ok: true, skipped: false, toolVersion: TOOL_VERSION, threshold: 0.005, compared: 1, declared: 1,
      inputHashes: buildInputHashes(dir, s2),
      results: [{ key: 'one', status: 'PASS', engine: 'odiff', bad: 0, total: 10000, masked: 0, diffRatio: 0, detail: '' }],
      generatedAt: new Date(0).toISOString(),
    }, null, 2)}\n`);
    run(ASSETS_MANIFEST, ['--demo', dir], { env: env() });
    const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
    assert.equal(pr.status, 2, `手写全 PASS 的 report-pixel.json 居然出了块:${pr.stdout}${pr.stderr}`);
    assert.match(`${pr.stdout}${pr.stderr}`, /trusted-pixel/, '必须由门 E 的可信重跑挡住');
    }

  // ③ report-assets.json:手写 totalBytes:0 + ok:true,资产其实很大
  {
    const { dir } = makeFixture({ name: 'forge-assets', repoDeps: true });
    assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
    assert.equal(run(VERIFY, ['--demo', dir], { env: env() }).status, 0);
    writeFileSync(join(dir, 'assets/huge.bin'), Buffer.alloc(9 * 1024 * 1024, 7));
    // verify 要重跑一次让 assets hash 对上(否则被 report hash 门先挡下,测不到体积门)
    assert.equal(run(VERIFY, ['--demo', dir], { env: env() }).status, 0);
    writeFileSync(join(dir, 'report-assets.json'), `${JSON.stringify({
      ok: true, toolVersion: TOOL_VERSION, totalBytes: 0, defaultLimitMb: 8, effectiveLimitMb: 8,
      overrideReason: null, problems: [],
      inputHashes: { assets: buildAssetsManifest(dir).files },
      generatedAt: new Date(0).toISOString(),
    }, null, 2)}\n`);
    const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
    assert.equal(pr.status, 2, `手写 totalBytes:0 的 report-assets.json 居然出了块:${pr.stdout}${pr.stderr}`);
    assert.match(`${pr.stdout}${pr.stderr}`, /assets:/, '必须由 pr-block 自己现算的体积门挡住');
  }
});

// ============================================================================
// 条目 8 — WARN 人工裁决必须绑定 trusted 三图字节
// ============================================================================

/** 造一个必然 WARN 的像素 fixture:基准图是纯蓝 32×32,而 #frame 渲染出来是纯红。 */
async function makeWarnFixture(name) {
  const baselines = [{ key: 'one', frameSel: '#frame' }];
  const { dir } = makeFixture({ name, repoDeps: true });
  const s2 = readJson(join(dir, 'spec.json'));
  s2.baselines = baselines; s2.baselineFrameSel = '#frame';
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(s2, null, 2));
  const { PNG } = await loadPngApi(dir);
  const png = new PNG({ width: 32, height: 32 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 255; png.data[i + 3] = 255; }
  mkdirSync(join(dir, 'baselines'), { recursive: true });
  writeFileSync(join(dir, 'baselines/one.png'), PNG.sync.write(png));
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  return { dir, spec: readJson(join(dir, 'spec.json')) };
}

test('条目 8 源码契约(不 skip): 三图 sha256 入 report，裁决必须绑定它且 reviewer/理由必填', () => {
  const px = stripComments(readFileSync(PIXEL, 'utf8'));
  assert.match(px, /item\.artifactHashes = \{/, 'pixel-compare 必须把三图 sha256 记进 report');
  assert.match(px, /adjudicationMismatch\(adj, \{/, '裁决必须逐项绑定本次比对才可能被采纳');
  assert.match(px, /'key', 'diffRatio', 'threshold', 'artifactHashes'/, 'r8:裁决必须同时绑定四项');
  assert.match(px, /adjudicationRejected/, '裁决绑不上时必须留下可读原因');
  const rp = stripComments(readFileSync(join(ROOT, 'scripts/lib/report.mjs'), 'utf8'));
  assert.match(rp, /hashFile\(join\(demoDir, p\)\) !== recorded/, '磁盘三图字节必须与 report 记录比对');
  assert.match(rp, /r\.adjudication\.artifactHashes\?\.\[kind\] !== recorded/, '裁决声明的 hash 必须与 report 记录比对');
  assert.match(rp, /for \(const field of \['reviewer', 'reason'\]\)/, 'reviewer 与理由必填');
  // PR 里裁决人与理由要可见
  const rn = readFileSync(join(ROOT, 'scripts/lib/pr-render.mjs'), 'utf8');
  assert.match(rn, /adjudication\?\.reviewer/);
  assert.match(rn, /adjudication\?\.reason/);
  assert.match(rn, /属人工声明非机械测量/, '门 E 的 WARN 文案必须写明裁决是人工声明');
});

test('条目 8 PoC(实跑): 裁决只声明 ok/reviewer/reason(不绑 hash)→ 不被采纳；绑错 hash → 拒；绑对 → 过且 PR 可见', async (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir, spec } = await makeWarnFixture('warn-bind');
  mkdirSync(join(dir, 'adjudications'), { recursive: true });
  const adjFile = join(dir, 'adjudications/one.json');
  const writeAdj = (extra) => writeFileSync(adjFile, `${JSON.stringify({ ok: true, reviewer: '张三', reason: '底色改版预期差异', ...extra }, null, 2)}\n`);

  // ① 旧式裁决(只有 ok/reviewer/reason,不绑 hash)—— r6 能过,r7 起必须不被采纳
  writeAdj({});
  const p1 = run(PIXEL, ['--demo', dir], { env: env() });
  assert.notEqual(p1.status, 0, '不绑 hash 的裁决仍被采纳(条目 8 未修)');
  const r1 = readJson(join(dir, 'report-pixel.json'));
  assert.equal(r1.results[0].status, 'WARN');
  assert.equal(r1.results[0].adjudication, undefined, '裁决不该被采纳');
  assert.match(r1.results[0].adjudicationRejected?.reason ?? '', /缺字段.*artifactHashes/);
  // 三图 sha256 必须已进 report(裁决要绑的就是它)
  for (const k of ['baseline', 'demo', 'diff']) assert.match(r1.results[0].artifactHashes[k], /^[0-9a-f]{64}$/);

  // ② 绑错 hash(改一位)→ 同样不被采纳
  const g2 = r1.results[0];
  const good = g2.artifactHashes;
  // 其余三项(key/diffRatio/threshold)按本次现算填对,单独把 diff 图的 hash 改一位
  // —— 否则先撞上 r8 的「缺字段」拒收,测不到「绑错 hash」这条路径。
  writeAdj({
    key: g2.key, diffRatio: g2.diffRatio, threshold: spec.baselineThreshold ?? 0.005,
    artifactHashes: { ...good, diff: good.diff.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) },
  });
  const p2 = run(PIXEL, ['--demo', dir], { env: env() });
  assert.notEqual(p2.status, 0, '绑错 hash 的裁决被采纳了');
  assert.match(readJson(join(dir, 'report-pixel.json')).results[0].adjudicationRejected?.reason ?? '', /sha256 与本次可信侧产出不符/);

  // ③ 绑对 hash → 被采纳,门 E 过,且 PR 里能看到裁决人与理由
  //    注意:hash 要取"最后一次真跑"的三图(每次重跑都会重写它们)
  const c3 = readJson(join(dir, 'report-pixel.json')).results[0];
  writeAdj({ key: c3.key, diffRatio: c3.diffRatio, threshold: spec.baselineThreshold ?? 0.005, artifactHashes: c3.artifactHashes });
  const p3 = run(PIXEL, ['--demo', dir], { env: env() });
  assert.equal(p3.status, 0, `绑对 hash 的裁决没被采纳:${p3.stdout}${p3.stderr}`);
  const r3 = readJson(join(dir, 'report-pixel.json'));
  assert.equal(r3.results[0].adjudication?.reviewer, '张三');
  assert.equal(run(VERIFY, ['--demo', dir], { env: env() }).status, 0);
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 0, `绑对 hash 后仍不放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /张三/, 'PR 里必须能看到裁决人');
  assert.match(pr.stdout, /底色改版预期差异/, 'PR 里必须能看到裁决理由');
  assert.match(pr.stdout, /属人工声明非机械测量/);
  void spec;
});

test('条目 8 PoC(实跑): 裁决绑定后又把 diff 图换掉 → 拒(裁决失去凭据)', async (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = await makeWarnFixture('warn-swap');
  mkdirSync(join(dir, 'adjudications'), { recursive: true });
  run(PIXEL, ['--demo', dir], { env: env() });
  const c0 = readJson(join(dir, 'report-pixel.json')).results[0];
  writeFileSync(join(dir, 'adjudications/one.json'), `${JSON.stringify({ ok: true, reviewer: '李四', reason: 'ok', key: c0.key, diffRatio: c0.diffRatio, threshold: 0.005, artifactHashes: c0.artifactHashes }, null, 2)}\n`);
  assert.equal(run(PIXEL, ['--demo', dir], { env: env() }).status, 0, '前提:绑对后应放行');
  // 攻击:比对完成后把 diff 图换成别的字节(report 里的 hash 不动)
  const rep = readJson(join(dir, 'report-pixel.json'));
  writeFileSync(join(dir, rep.results[0].artifacts.diff), Buffer.from('SWAPPED-NOT-A-PNG'));
  const v = validatePixelReport(dir, readJson(join(dir, 'spec.json')), rep);
  assert.ok(
    v.problems.some((p) => /字节与 report 记录不符/.test(p)),
    `换掉 artifact 图后仍认这份裁决:${JSON.stringify(v.problems)}`,
  );
});

// ============================================================================
// 条目 10 — 门 X 的降准 / 后置 / 隔离
// ============================================================================

test('条目 10 契约(不 skip): 降准表述 + 后置 + 整组回收 + 脚本字节绑定', () => {
  const v = readFileSync(VERIFY, 'utf8');
  // ③ 新进程组 + 整组回收
  assert.match(v, /detached: true/, '门 X / extractor 必须在新进程组里跑');
  assert.match(v, /process\.kill\(-res\.pid, 'SIGKILL'\)/, '返回后必须整组回收子进程');
  // ⑤ 脚本 hash 与实际执行字节绑定
  assert.match(v, /entry\.scriptSha256 = run\.scriptSha256/);
  assert.match(v, /inputHashes\.customGates\?\.\[g\.script\]/, '实际执行的字节必须与观察前入链的那份比对');
  // ② 后置(与条目 1 的时序一致)—— 由条目 1 的时序契约测试覆盖,这里只钉门 X 在分界线之后
  assert.ok(v.indexOf('分界线:以下开始执行 demo 侧代码') < v.indexOf('runDemoScript(join(demoDir, g.script)'));
  // ① 降准表述:PR 文案 + SKILL.md 都不许暗示脚本语义可信
  const rn = readFileSync(join(ROOT, 'scripts/lib/pr-render.mjs'), 'utf8');
  assert.match(rn, /已由可信 runner 执行且 exit 0/);
  assert.match(rn, /其业务判断是否正确需人工审查/);
  const doc = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  assert.match(doc, /只能声称「精确 hash 的注册脚本被可信 runner 执行且 exit 0」这个执行事件/);
  assert.match(doc, /### 门 X 的隔离与残余风险/, '未做 OS 沙箱这条降级必须成文');
  assert.match(doc, /孙进程会拿到自己的新进程组/, '整组回收的局限必须如实写明');
});

test('条目 10 实跑: 注册后替换脚本字节 → 门 X 红并点名字节不一致', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({
    name: 'gatex-swap', repoDeps: true,
    customGates: [{ id: 'oracle', script: 'oracle-gate.mjs' }],
  });
  writeFileSync(join(dir, 'oracle-gate.mjs'), "process.stdout.write('ok');\n");
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v0 = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(v0.status, 0, `合法自定义门初次就红了:${v0.stdout}${v0.stderr}`);
  const rep0 = readJson(join(dir, 'report.json'));
  assert.match(rep0.gateX.gates[0].scriptSha256, /^[0-9a-f]{64}$/, '门 X 必须记下实际执行的脚本字节');
  assert.equal(rep0.gateX.gates[0].scriptSha256, rep0.inputHashes.customGates['oracle-gate.mjs'], '执行字节应等于入链字节');
});

// ============================================================================
// 条目 12 / 13 — index.html 定位；canonical 文件集合与实际依赖一致
// ============================================================================

test('条目 12 文档契约(不 skip): 不声称 adapter/chrome 段是 canonical，只声称 hash + 浏览器实测', () => {
  const doc = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  assert.match(doc, /\*\*init 生成后可编辑的运行输入\*\*，不是可信产物/, 'index.html 的定位必须写清');
  assert.match(doc, /没有做逐段字节全等校验/, '做不到逐段校验就必须明说,不许含糊');
  assert.match(doc, /渲染结论由 canonical 浏览器从 immutable snapshot 实测/);
  // 反向:全文不许出现「index.html/adapter/chrome 段是 canonical」这类声明
  for (const line of doc.split('\n')) {
    if (!/canonical/.test(line)) continue;
    // 否定式表述(「不声称…是 canonical」)是我们要的那句,不能被反向断言误判
    const positive = line.replace(/不声称[^，。|]*canonical[^，。|]*/g, '');
    assert.ok(
      !/(adapter|chrome)\s*(段|块)?[^|]{0,20}(是|必须是)\s*canonical/.test(positive),
      `SKILL.md 声称 adapter/chrome 段是 canonical 但没有逐段字节校验:${line.trim().slice(0, 120)}`,
    );
  }
});

test('条目 13 契约(不 skip): DEMO_BUILD_FILES 恰等于 demo 侧构建期文件的实际 import 闭包', () => {
  /* 钉死"钉字节的集合"与"真实依赖"一致:
     - 少了 → 有文件在安全路径上却没被钉字节(真漏洞);
     - 多了 → 钉着一个已经不在安全路径上的文件,制造"看起来有保护其实无关"的假象。
     r7 条目 2/5 把 content 改成显式列表、删掉字符白名单之后,repo-glob.mjs 仍在安全路径上
     (构建核心从它取 explicitContentFileProblem 与 findDemoNodeModules,--suggest-content 另有
     动态 import),所以集合不变 —— 这条测试是为了让"不变"也有据可查、并拦住未来的漂移。 */
  const LOCAL = {
    'build.mjs': join(ROOT, 'templates/component-build.mjs'),
    'component-build-core.mjs': join(ROOT, 'scripts/lib/component-build-core.mjs'),
    'extract-helpers.mjs': join(ROOT, 'scripts/lib/extract-helpers.mjs'),
    'repo-glob.mjs': join(ROOT, 'scripts/lib/repo-glob.mjs'),
    'fs-utils.mjs': join(ROOT, 'scripts/lib/fs-utils.mjs'),
    'schema.mjs': join(ROOT, 'scripts/lib/schema.mjs'),
    'gates.mjs': join(ROOT, 'scripts/lib/gates.mjs'),
  };
  const seen = new Set();
  const queue = ['build.mjs'];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const file = LOCAL[name];
    assert.ok(file, `demo 侧构建期依赖 ${name} 不在已知文件表里 —— 新增本地依赖必须同步 DEMO_BUILD_FILES 与本测试`);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from '\.\/([A-Za-z0-9._-]+\.mjs)'/g)) queue.push(m[1]);
    for (const m of src.matchAll(/import\('\.\/([A-Za-z0-9._-]+\.mjs)'\)/g)) queue.push(m[1]);
  }
  assert.deepEqual([...seen].sort(), [...DEMO_BUILD_FILES].sort(),
    'DEMO_BUILD_FILES 与 demo 侧构建期文件的实际 import 闭包不一致 —— 要么漏钉、要么钉了无关文件');
  // 每个被钉的文件都必须真有 canonical 源可比(否则 checkDemoBuilderIntegrity 会静默跳过它)
  for (const name of DEMO_BUILD_FILES) assert.ok(existsSync(LOCAL[name]), `${name} 没有 canonical 源文件`);
});

// ============================================================================
// 条目 14 / 15 — 测试环境敏感性 与 skill 自身依赖钉版
// ============================================================================

test('条目 14 契约(不 skip): 「产品仓无 tailwind」必须自建隔离 fixture，不许依赖宿主碰巧没装', () => {
  /* 根因回顾:原用例用 `repoDeps: true`(整份宿主 node_modules symlink)+ 假设"宿主产品仓碰巧
     没装 tailwind"。MivoCanvas 没装 → 绿;Project CINDY 装了 3.4.19 → --check-css 正常成功、
     断言失败(lead 实测 278/280)。这类"看起来有保护、其实是环境碰巧"正是我们花七轮在防的东西,
     出现在我们自己的测试里。 */
  const r6 = readFileSync(join(ROOT, 'scripts/__tests__/comp-fix-r6.test.mjs'), 'utf8');
  assert.match(r6, /function makeNoTailwindNodeModules/, '必须有自建「无 tailwind CLI 产品仓」的 fixture 构造');
  assert.match(r6, /repoDeps: 'no-tailwind'/, 'fail-closed 用例必须用隔离 fixture');
  // 那个用例不许再出现「假设宿主没装」的写法
  const caseSrc = r6.slice(r6.indexOf("test('条目 1 fail-closed"), r6.indexOf("test('条目 1 真 tailwind 分支"));
  assert.ok(!/repoDeps: true/.test(caseSrc), 'fail-closed 用例仍在整份 symlink 宿主 node_modules(会随宿主装了什么而变)');
  assert.match(caseSrc, /repoDeps: 'no-tailwind'/);
  // 构造必须是确定性的:显式跳过 tailwindcss 并自查
  const helper = r6.slice(r6.indexOf('function makeNoTailwindNodeModules'), r6.indexOf('/** 出块前的三件事'));
  assert.match(helper, /name === 'tailwindcss'/, '构造必须显式跳过 tailwindcss 包');
  assert.match(helper, /if \(name === 'tailwindcss'\) continue;/, '.bin 也必须跳过 tailwindcss');
  assert.match(helper, /隔离 fixture 构造失败/, '构造完必须自查前提成立(否则又变成靠环境碰巧)');
  // r6 的「引擎同源性」旧用例(把运行时解析结果与 skill 自身比,恒失败)已随条目 2 下线
  assert.ok(!/createRequire\(join\(ROOT, 'package\.json'\)\)[\s\S]{0,300}fast-glob/.test(r6),
    '旧的「与 skill 自身的 fast-glob 比对」写法必须已下线(比较对象选错 → 恒失败)');
});

test('条目 15 契约(不 skip): skill 自身依赖钉版与 README/实现一致，且不靠产品仓兜住', () => {
  const pkg = readJson(join(ROOT, 'package.json'));
  const lock = readJson(join(ROOT, 'package-lock.json'));
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  /* ── typescript:必须 5.x ──
     根因:fix-r6 把它钉成 ^7.0.2(实装 7.0.2),而 README 明写必须 5.x、writeback.mjs 依赖
     TS5 的 lib/typescript.js(TS7 原生版没有该文件)。全量没暴露是因为
     QA_HIFI_MODULE_ROOT 优先解析了产品仓的 TS 5.9.3 —— skill 自己的依赖错误被产品仓掩盖。 */
  assert.match(readme, /typescript 必须 5\.x/, 'README 的 TS 版本要求是这条断言的依据');
  assert.match(pkg.devDependencies.typescript, /^\^?5\./, `package.json 的 typescript 必须钉 5.x(当前 ${pkg.devDependencies.typescript})`);
  const tsLocked = lock.packages?.['node_modules/typescript']?.version ?? '';
  assert.match(tsLocked, /^5\./, `package-lock 里的 typescript 必须是 5.x(当前 ${tsLocked})`);
  // 实装那份必须真有 Compiler API 入口(writeback.mjs 取的就是它)
  assert.ok(
    existsSync(join(ROOT, 'node_modules/typescript/lib/typescript.js')),
    'skill 实装的 typescript 里没有 lib/typescript.js —— keyPath 写回会 fail-closed(不许靠产品仓的 TS 兜住)',
  );
  // 实现与钉版一致:writeback 显式取经典入口,而不是在模块形态上猜
  assert.match(readFileSync(join(ROOT, 'scripts/writeback.mjs'), 'utf8'), /lib\/typescript\.js/);

  /* ── tailwindcss:钉法与实现/文档一致(顺带核) ──
     实现依赖 v3 的 CLI 参数形态(-c/-i/-o/--content)与 lib/lib/content.js 的 parseCandidateFiles
     (条目 2/5 的交叉验证靠它),因此必须钉在 3.x。 */
  assert.match(pkg.devDependencies.tailwindcss, /^\^?3\./, `tailwindcss 必须钉 3.x(当前 ${pkg.devDependencies.tailwindcss})`);
  const twLocked = lock.packages?.['node_modules/tailwindcss']?.version ?? '';
  assert.match(twLocked, /^3\./, `package-lock 里的 tailwindcss 必须是 3.x(当前 ${twLocked})`);
  assert.ok(existsSync(join(ROOT, 'node_modules/tailwindcss/lib/lib/content.js')), 'tailwind 内部 API 路径变了 → 条目 2/5 的交叉验证需显式适配');
  // 钉版清单与「版本联动闸门」那份 fixture 必须一致(否则升级时两处会漂移)
  const pinned = readJson(join(ROOT, 'scripts/__tests__/fixtures/r7-content-engine-versions.json'));
  assert.equal(pinned.tailwindcss, twLocked, '版本联动 fixture 与 package-lock 的 tailwindcss 版本不一致');
});

test('条目 15 自足性(不 skip): 只需 TS 的那组在没有产品仓时也必须能真跑', () => {
  /* sync-v2(keyPath 写回)只依赖 typescript,不需要 esbuild/playwright ——
     所以它在**不设 QA_HIFI_MODULE_ROOT** 时也必须全绿(这是条目 15 的验收硬标准)。
     这里用源码契约保证它不会被误加「缺产品仓就 skip」的 guard,把自足性悄悄丢掉。 */
  const sync = readFileSync(join(ROOT, 'scripts/__tests__/sync-v2.test.mjs'), 'utf8');
  assert.ok(!/NEEDS_PRODUCT_REPO/.test(sync), 'sync-v2 不该依赖产品仓依赖(它只需要 typescript)');
  // writeback 的 TS 解析候选链必须含 skillRoot,否则没有产品仓时它解析不到自己的 TS
  const wb = readFileSync(join(ROOT, 'scripts/writeback.mjs'), 'utf8');
  assert.match(wb, /resolveFrom\('typescript\/package\.json', \[process\.env\.QA_HIFI_MODULE_ROOT, repoRoot, skillRoot\]\)/,
    'TS 解析候选链必须包含 skillRoot(自足)且不含 demoDir(不可信)');
  // 只看可执行代码:注释里说明「候选链不放 demoDir」是必要的,不能被反向断言误判
  const wbCode = stripComments(wb);
  const at = wbCode.indexOf("resolveFrom('typescript/package.json'");
  assert.ok(!/demoDir/.test(wbCode.slice(at - 200, at + 200)),
    'TS 解析候选链里不许出现 demoDir(那是 demo 侧任意代码执行)');
});
