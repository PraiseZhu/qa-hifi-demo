// comp-gates.test.mjs — 组件模式(spec.component)下七道门的适配:
// 代码层防伪链(产品源码 + bundle 产物 hash 入 inputHashes)、schema 锁源、门 D 文案、附贴块声明。
// 对抗视角:改了产品组件而 demo 没重构建 → 旧 report 必须失效。
// fixture 自给自足;非组件模式 demo 的行为必须逐字不变(回归)。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputHashes, expandRepoGlob, findGitRepoRoot, hashFile, safeJsonForScript, stableJson } from '../lib/fs-utils.mjs';
import { validateSpec } from '../lib/schema.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
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
  <button data-qa-pref="plat:desk">desk</button><button data-qa-pref="region:cn">cn</button>
  <button data-qa-pref="os:ios">ios</button><button data-qa-pref="mode:light">light</button><button data-qa-pref="lang:zh-CN">zh</button>
  <button id="noop">noop</button><div class="box">x</div><div id="tick">0</div><input id="code">
  <div id="frame" class="frame"></div>
  <script src="assets/component.bundle.js"></script>
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
 * 造一个「demo 位于产品仓内」的 fixture:<repo>/.git + <repo>/src/*.tsx + <repo>/qa-demo/。
 * component=false 时不写 spec.component(回归用:非组件模式旧 demo)。
 */
function makeRepoDemo({ name = 'comp', component = true, sources = ['src/**/*.tsx'], bindings = [], noGit = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qa-hifi-comp-${name}-`));
  if (!noGit) execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  writeFileSync(join(repo, 'src/Entry.tsx'), 'export const Entry = () => null;\n');
  writeFileSync(join(repo, 'src/components/Button.tsx'), 'export const Button = () => null;\n');
  writeFileSync(join(repo, 'src/notes.md'), 'not a source file\n');

  const dir = join(repo, 'qa-demo');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
  const leaf = (value, locator) => ({ value, provenance: { source: 'source.txt', locator, hash: hashFile(source) } });
  const truth = { geometry: { width: leaf(16, 'width constant') }, colors: { text: leaf('#ff0000', 'text color') } };
  const spec = {
    meta: { name, summary: { what: 'what', how: 'how', accept: 'accept' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: {
      cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [] }],
      noClip: ['.box'],
    },
    bindings,
    ...(component ? { component: { mode: 'component', entry: 'src/Entry.tsx', sources, bundle: 'assets/component.bundle.js' } } : {}),
  };
  writeFileSync(join(dir, 'truth.json'), stableJson(truth));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'index.html'), baseHtml(truth));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  writeFileSync(join(dir, 'assets/component.bundle.js'), '/* bundle v1 */\n');
  return { repo, dir, spec };
}

const readSpec = (dir) => JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));

// ============ ① schema:component 段校验 ============

function specWithComponent(patch) {
  const { dir } = makeRepoDemo({ name: 'schema', component: true });
  const spec = readSpec(dir);
  spec.component = patch === null ? undefined : { ...spec.component, ...patch };
  if (patch === null) delete spec.component;
  return spec;
}

test('schema: sources 为空/缺失 → FAIL(声明了组件模式就必须锁源)', () => {
  for (const patch of [{ sources: [] }, { sources: undefined }]) {
    const spec = specWithComponent(patch);
    if (patch.sources === undefined) delete spec.component.sources;
    const problems = validateSpec(spec);
    assert.ok(problems.some((p) => /component\.sources 必须是非空数组/.test(p)), `空 sources 居然放行:${JSON.stringify(problems)}`);
  }
});

test('schema: component 合法声明通过', () => {
  assert.deepEqual(validateSpec(specWithComponent({})).filter((p) => p.includes('component')), []);
});

test('schema: mode 必须是 "component"', () => {
  const problems = validateSpec(specWithComponent({ mode: 'chrome' }));
  assert.ok(problems.some((p) => /component\.mode 必须是/.test(p)));
});

test('schema: bundle 限 demo 内相对路径(.. / 绝对路径 / 反斜杠全拒)', () => {
  for (const bundle of ['../../etc/passwd', '/etc/passwd', 'assets\\bundle.js', '', 42]) {
    const problems = validateSpec(specWithComponent({ bundle }));
    assert.ok(problems.some((p) => /component\.bundle/.test(p)), `bundle=${JSON.stringify(bundle)} 居然放行`);
  }
});

test('schema: entry / sources 同样禁 ".." 与绝对路径', () => {
  assert.ok(validateSpec(specWithComponent({ entry: '../outside.tsx' })).some((p) => /component\.entry/.test(p)));
  assert.ok(validateSpec(specWithComponent({ sources: ['/abs/**/*.ts'] })).some((p) => /component\.sources\[0\]/.test(p)));
  assert.ok(validateSpec(specWithComponent({ sources: ['src/../../x.ts'] })).some((p) => /component\.sources\[0\]/.test(p)));
});

test('schema: component 不认识的字段直接拒(防拼错静默失效)', () => {
  const problems = validateSpec(specWithComponent({ soruces: ['src/a.ts'] }));
  assert.ok(problems.some((p) => /component\.soruces 不是支持的字段/.test(p)));
});

test('schema: 非组件模式 spec 不受影响(回归)', () => {
  const { dir } = makeRepoDemo({ name: 'schema-plain', component: false });
  const problems = validateSpec(readSpec(dir));
  assert.deepEqual(problems, [], `旧式 spec 被误伤:${JSON.stringify(problems)}`);
});

// ============ ② buildInputHashes:componentSources 段 ============

test('glob 展开:** 跨目录、只命中声明后缀、跳过 node_modules/.git', () => {
  const { repo } = makeRepoDemo({ name: 'glob' });
  mkdirSync(join(repo, 'node_modules/pkg'), { recursive: true });
  writeFileSync(join(repo, 'node_modules/pkg/x.tsx'), 'x\n');
  assert.deepEqual(expandRepoGlob(repo, 'src/**/*.tsx'), ['src/Entry.tsx', 'src/components/Button.tsx']);
  assert.deepEqual(expandRepoGlob(repo, 'src/*.tsx'), ['src/Entry.tsx']);
  assert.deepEqual(expandRepoGlob(repo, 'src/Entry.tsx'), ['src/Entry.tsx']);
});

test('buildInputHashes: component 模式逐文件 sha256 + bundle 产物 hash 入链', () => {
  const { repo, dir } = makeRepoDemo({ name: 'hash' });
  const h = buildInputHashes(dir, readSpec(dir));
  assert.ok(h.componentSources, 'component 模式必须有 componentSources 段');
  assert.equal(h.componentSources.sources['src/components/Button.tsx'], hashFile(join(repo, 'src/components/Button.tsx')));
  assert.equal(h.componentSources.sources['src/Entry.tsx'], hashFile(join(repo, 'src/Entry.tsx')));
  assert.equal(h.componentSources.bundle['assets/component.bundle.js'], hashFile(join(dir, 'assets/component.bundle.js')));
  // md 不在 glob 内,不该混进来
  assert.equal(h.componentSources.sources['src/notes.md'], undefined);
});

test('buildInputHashes: 改源文件 / 改 bundle 都让 hash 变', () => {
  const { repo, dir } = makeRepoDemo({ name: 'hash-change' });
  const spec = readSpec(dir);
  const before = JSON.stringify(buildInputHashes(dir, spec));
  writeFileSync(join(repo, 'src/components/Button.tsx'), 'export const Button = () => null; // v2\n');
  const afterSrc = JSON.stringify(buildInputHashes(dir, spec));
  assert.notEqual(afterSrc, before, '改产品源文件后 hash 居然没变');
  writeFileSync(join(dir, 'assets/component.bundle.js'), '/* bundle v2 */\n');
  assert.notEqual(JSON.stringify(buildInputHashes(dir, spec)), afterSrc, '改 bundle 产物后 hash 居然没变');
});

test('buildInputHashes: 源文件删了记 MISSING、glob 零命中记 NO_MATCH、bundle 缺失记 MISSING', () => {
  const { dir } = makeRepoDemo({ name: 'hash-missing', sources: ['src/gone/**/*.tsx', 'src/deleted.tsx'] });
  const spec = readSpec(dir);
  spec.component.bundle = 'assets/nope.js';
  const h = buildInputHashes(dir, spec);
  assert.equal(h.componentSources.sources['src/gone/**/*.tsx'], 'NO_MATCH');
  assert.equal(h.componentSources.sources['src/deleted.tsx'], 'MISSING');
  assert.equal(h.componentSources.bundle['assets/nope.js'], 'MISSING');
});

test('buildInputHashes: 非组件模式不长出 componentSources(回归)', () => {
  const { dir } = makeRepoDemo({ name: 'hash-plain', component: false });
  const h = buildInputHashes(dir, readSpec(dir));
  assert.equal(h.componentSources, undefined);
  assert.deepEqual(Object.keys(h).sort(), ['baselines', 'index.html', 'spec.json', 'truth.json']);
});

test('findGitRepoRoot: 定位到 demo 所在仓根', () => {
  const { repo, dir } = makeRepoDemo({ name: 'reporoot' });
  // macOS tmpdir 是 /var → /private/var symlink,比较用 realpath 后的尾段
  assert.equal(findGitRepoRoot(dir).split('/').pop(), repo.split('/').pop());
});

// ============ ③④ 集成:verify → 篡改 → pr-block 拒 ============

test('组件模式:改 sources 里任一源文件 → 旧 report 被 pr-block 拒', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { repo, dir } = makeRepoDemo({ name: 'e2e-src' });
  const v = run(VERIFY, ['--demo', dir], { env });
  assert.equal(v.status, 0, `verify 必须先绿:${v.stdout}${v.stderr}`);
  const ok = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(ok.status, 0, `未篡改时应放行:${ok.stdout}${ok.stderr}`);
  writeFileSync(join(repo, 'src/components/Button.tsx'), 'export const Button = () => null; // tampered\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(pr.status, 2, `改了产品源码居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /hash|不一致|重跑/);
});

test('组件模式:改 bundle 产物 → 旧 report 被 pr-block 拒', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'e2e-bundle' });
  const v = run(VERIFY, ['--demo', dir], { env });
  assert.equal(v.status, 0, `verify 必须先绿:${v.stdout}${v.stderr}`);
  writeFileSync(join(dir, 'assets/component.bundle.js'), '/* bundle v2 */\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(pr.status, 2, `改了 bundle 产物居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /hash|不一致|重跑/);
});

test('组件模式:门 D 文案改为「渲染由产品代码路径承载」,附贴块声明真组件直渲', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'e2e-gated' });
  const v = run(VERIFY, ['--demo', dir], { env });
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.gateD.pass, true);
  assert.match(report.gateD.detail, /组件模式|产品代码路径/);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(pr.status, 0, `${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /真组件直渲（2 个源文件 hash 入链）/);
});

test('回归:非组件模式旧 demo 门 D 文案与附贴块不变', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'e2e-plain', component: false });
  const v = run(VERIFY, ['--demo', dir], { env });
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.match(report.gateD.detail, /spec\.bindings 未配置/);
  assert.equal(report.inputHashes.componentSources, undefined);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(pr.status, 0, `${pr.stdout}${pr.stderr}`);
  assert.ok(!pr.stdout.includes('真组件直渲'), '非组件模式不该出现组件声明行');
  assert.match(pr.stdout, /还原承诺仅到数据层/);
});

// ============ ⑤ fail-closed:防伪链没锁住任何东西 = 阻断(lead 裁决) ============
// 攻击面:作者写个匹配不到的 glob / 源文件被删 / demo 不在 git 仓内 —— 这些情况下
// componentSources 记的是 NO_MATCH/MISSING/UNRESOLVED,verify 仍绿、hash 也「一致」,
// 旧 report 照样过 pr-block。fail-closed 要求 pr-block 一律拒并说清怎么修。

function verifyThenPrBlock(dir, env) {
  const v = run(VERIFY, ['--demo', dir], { env });
  assert.equal(v.status, 0, `verify 必须先绿(fail-closed 只在 pr-block 侧):${v.stdout}${v.stderr}`);
  return run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
}

test('fail-closed: glob 零命中(NO_MATCH)→ pr-block 拒并提示修 sources', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'fc-nomatch', sources: ['src/**/*.nope'] });
  const pr = verifyThenPrBlock(dir, env);
  assert.equal(pr.status, 2, `零命中 glob 居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /NO_MATCH/);
  assert.match(pr.stdout + pr.stderr, /glob 零命中/);
});

test('fail-closed: 源文件缺失(MISSING)→ pr-block 拒并提示查路径', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'fc-missing', sources: ['src/components/Button.tsx', 'src/deleted.tsx'] });
  const pr = verifyThenPrBlock(dir, env);
  assert.equal(pr.status, 2, `缺源文件居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /MISSING/);
  assert.match(pr.stdout + pr.stderr, /src\/deleted\.tsx/);
});

test('fail-closed: demo 不在 git 仓内(UNRESOLVED)→ pr-block 拒并要求 demo 落在产品仓内', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'fc-nogit', noGit: true });
  const pr = verifyThenPrBlock(dir, env);
  assert.equal(pr.status, 2, `demo 不在仓内居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /UNRESOLVED/);
  assert.match(pr.stdout + pr.stderr, /必须位于产品 git 仓内/);
});

test('fail-closed 阳性对照: 源文件与 bundle 全部真 hash → 照常放行(不误伤)', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'fc-healthy' });
  const pr = verifyThenPrBlock(dir, env);
  assert.equal(pr.status, 0, `健康组件 demo 被误伤:${pr.stdout}${pr.stderr}`);
  assert.ok(!/防伪链未锁住/.test(pr.stdout + pr.stderr), 'fail-closed 误报');
  assert.match(pr.stdout, /真组件直渲/);
});
