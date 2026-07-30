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

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, safeJsonForScript, stableJson } from '../lib/fs-utils.mjs';

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
  const iBundle = v.indexOf('recheckComponentBundle(demoDir, spec.component)');
  const iCss = v.indexOf('recheckComponentCss(demoDir, spec.component)');
  const iBrowser = v.indexOf('launchChromium(demoDir');
  const iGateD = v.indexOf('---------- 门 D:渲染绑定');
  const iGateF = v.indexOf('---------- 门 F:适配还原');
  const iBoundary = v.indexOf('分界线:以下开始执行 demo 侧代码');
  const iExtract = v.indexOf('execFileSync(process.execPath, [extractor]');
  const iCustom = v.indexOf("execFileSync(process.execPath, [join(demoDir, g.script), '--demo', demoDir]");
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
    "const here = new URL('.', import.meta.url).pathname;",
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
      "appendFileSync(join(new URL('.', import.meta.url).pathname, 'index.html'), '<!-- mutated -->');",
      "process.stdout.write('ok');\n",
    ].join('\n'),
  );
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, '自定义门改写输入文件后 verify 仍然全绿 = 事后 hash 复算没生效');
  assert.match(`${v.stdout}${v.stderr}`, /输入 hash 与观察前不一致/);
});
