// comp-gates.test.mjs — 组件模式(spec.component)下七道门的适配:
// 代码层防伪链(产品源码 + bundle 产物 hash 入 inputHashes)、schema 锁源、门 D 文案、附贴块声明。
// 对抗视角:改了产品组件而 demo 没重构建 → 旧 report 必须失效。
// fixture 自给自足;非组件模式 demo 的行为必须逐字不变(回归)。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputHashes, expandRepoGlob, findGitRepoRoot, hashFile, safeJsonForScript, stableJson } from '../lib/fs-utils.mjs';
import { validateSpec } from '../lib/schema.mjs';
import { templateExtractor } from './_extractor-template.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;
/* r7 条目 14:宿主没有产品仓依赖(esbuild / playwright)时,这些用例**跑不了**,
   必须显式 skip 并说明缺什么 —— 原先它们直接 fail,把「宿主缺依赖」伪装成「实现有 bug」。
   skill 自身故意不 vendor esbuild/playwright(重依赖 + 浏览器二进制),它们由产品仓提供;
   canonical 测试命令一直带 QA_HIFI_MODULE_ROOT,两个真实产品仓下这些用例全部实跑。 */
const NEEDS_PRODUCT_REPO = '需要产品仓提供 esbuild/playwright:设 QA_HIFI_MODULE_ROOT 指向装了依赖的仓(skill 自身不 vendor 这两个重依赖)';

const ASSETS_MANIFEST = join(ROOT, 'scripts/assets-manifest.mjs');

/**
 * 资产体积闸门:组件模式 demo 必有 assets/(bundle 落在那儿),pr-block 现在强制
 * report-assets.json 存在且 hash 一致(审核 P1 #5)。集成用例在 verify 之后补跑它,
 * 否则会被资产闸门拦下而不是被本用例想测的那条门拦下。
 */
function assetsGate(dir, env) {
  const r = run(ASSETS_MANIFEST, ['--demo', dir], { env });
  assert.equal(r.status, 0, `资产闸门应通过:${r.stdout}${r.stderr}`);
}

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
// r3 起本文件的 fixture 跑**真** esbuild 构建(canonical build.mjs + 构建核心)。
// r2 时这里放的是一个「--check-inputs 就回显现有清单」的 build.mjs 测试替身 —— 终审 #2c-a
// 证明那种自证 oracle 本身就是漏洞形状(demo 侧脚本当真相源),skill 侧复算上线后
// 替身既不合法(hash 与 canonical 不等 → fail-closed)也不必要,直接删掉。
const DEFAULT_PRODUCT_INPUTS = ['src/Entry.tsx', 'src/components/Button.tsx'];
const BUILD_FILES = [
  ['templates/component-build.mjs', 'build.mjs'],
  ['scripts/lib/component-build-core.mjs', 'component-build-core.mjs'],
  ['scripts/lib/extract-helpers.mjs', 'extract-helpers.mjs'],
  ['scripts/lib/repo-glob.mjs', 'repo-glob.mjs'],
];

function makeRepoDemo({
  name = 'comp',
  component = true,
  sources = [],
  bindings = [],
  noGit = false,
  // component.inputs.json(build.mjs 从 esbuild metafile 生成的 bundle 真实输入清单)
  // 是代码层防伪链的真相源;本 fixture 不跑真 esbuild,直接手写等价清单。
  productInputs = DEFAULT_PRODUCT_INPUTS,
  demoInputs = [],
  manifest = true,
} = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qa-hifi-comp-${name}-`));
  if (!noGit) execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  // Entry 真 import Button:真构建后 productInputs 恰好是这两个文件(与本文件的断言一致)
  writeFileSync(join(repo, 'src/Entry.tsx'), "import { Button } from './components/Button';\nexport const Entry = () => Button();\n");
  writeFileSync(join(repo, 'src/components/Button.tsx'), 'export const Button = () => "button-v1";\n');
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
      // via 非空且只含 expect:声明「demo 初始就在该 case 的偏好上,无需导航」。
      // 不用 via:[]——空数组与「忘填」不可分辨,schema 已拒(审核附带收紧项)。
      cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [{ expect: 'id' }] }],
      noClip: ['.box'],
    },
    bindings,
    // 故意**不**声明 component.export:本文件同时充当「未声明目标导出 → PR 结论必须降级」
    // 这条 r3 语义的回归(声明并证明的阳性对照在 comp-fix-r2 / comp-fix-r3)。
    ...(component ? { component: { mode: 'component', entry: 'src/Entry.tsx', sources, bundle: 'assets/component.bundle.js', bootstrap: 'src/bootstrap.tsx' } } : {}),
  };
  writeFileSync(join(dir, 'truth.json'), stableJson(truth));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'index.html'), baseHtml(truth));
    /* r10 fixture 忠实化:与 init.mjs 生成的官方模板**同形**(import 兄弟
       ./extract-helpers.mjs)。此前是自包含单文件,于是「可信副本搬走脚本后相对 import 断」
       这类真实使用路径缺陷在全绿下测不出来。 */
  writeFileSync(join(dir, 'extract.mjs'), templateExtractor(truth));
  copyFileSync(join(ROOT, 'scripts/lib/extract-helpers.mjs'), join(dir, 'extract-helpers.mjs'));
  writeFileSync(join(dir, 'assets/component.bundle.js'), '/* bundle v1 */\n');
  if (component) {
    // 构建期文件必须是 skill canonical 原版:门 A 会 hash 比对(改写 = 自定义构建器 → fail-closed)
    for (const [from, to] of BUILD_FILES) copyFileSync(join(ROOT, from), join(dir, to));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/bootstrap.tsx'), "import { Entry } from '../../src/Entry';\nglobalThis.__demo = Entry();\n");
    // noGit fixture 不在任何 git 仓内 → 真构建无从进行(repoRoot 不可解析,这正是它要测的
    // UNRESOLVED 场景),只落一份等价清单;其余 fixture 一律跑真 esbuild 出 bundle + 清单。
    if (noGit) {
      writeFileSync(join(dir, 'component.inputs.json'), `${JSON.stringify({
        generator: 'qa-hifi-demo/component-build',
        entry: 'src/Entry.tsx',
        entryExport: null,
        entrySentinel: 'active',
        productInputs,
        demoInputs,
        buildInputs: { demo: [], product: [] },
        skippedExternal: 0,
      }, null, 2)}\n`);
    } else {
      const b = run(join(dir, 'build.mjs'), [], { cwd: dir, timeout: 120000 });
      assert.equal(b.status, 0, `fixture 真构建失败(需要可解析的 esbuild):${b.stdout}${b.stderr}`);
    }
    if (!manifest) rmSync(join(dir, 'component.inputs.json'), { force: true });
    // 只有显式传了非默认清单的用例才改写真清单(它们测的就是 MISSING/INVALID_PATH 这些状态)
    else if (productInputs !== DEFAULT_PRODUCT_INPUTS || demoInputs.length) {
      const m = JSON.parse(readFileSync(join(dir, 'component.inputs.json'), 'utf8'));
      writeFileSync(join(dir, 'component.inputs.json'), `${JSON.stringify({ ...m, productInputs, demoInputs }, null, 2)}\n`);
    }
  }
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

test('schema: sources 可选(空/缺失均合法),非数组仍拒', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  // 锁源不再靠自报 sources:真相源是 build.mjs 生成的 component.inputs.json
  for (const patch of [{ sources: [] }, { sources: undefined }]) {
    const spec = specWithComponent(patch);
    if (patch.sources === undefined) delete spec.component.sources;
    assert.deepEqual(validateSpec(spec).filter((p) => p.includes('component.sources')), []);
  }
  assert.ok(validateSpec(specWithComponent({ sources: 'src/a.ts' })).some((p) => /component\.sources 必须是数组/.test(p)));
});

test('schema: component 合法声明通过', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  assert.deepEqual(validateSpec(specWithComponent({})).filter((p) => p.includes('component')), []);
});

test('schema: mode 必须是 "component"', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const problems = validateSpec(specWithComponent({ mode: 'chrome' }));
  assert.ok(problems.some((p) => /component\.mode 必须是/.test(p)));
});

test('schema: bundle 限 demo 内相对路径(.. / 绝对路径 / 反斜杠全拒)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  for (const bundle of ['../../etc/passwd', '/etc/passwd', 'assets\\bundle.js', '', 42]) {
    const problems = validateSpec(specWithComponent({ bundle }));
    assert.ok(problems.some((p) => /component\.bundle/.test(p)), `bundle=${JSON.stringify(bundle)} 居然放行`);
  }
});

test('schema: entry / sources 同样禁 ".." 与绝对路径', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  assert.ok(validateSpec(specWithComponent({ entry: '../outside.tsx' })).some((p) => /component\.entry/.test(p)));
  assert.ok(validateSpec(specWithComponent({ sources: ['/abs/**/*.ts'] })).some((p) => /component\.sources\[0\]/.test(p)));
  assert.ok(validateSpec(specWithComponent({ sources: ['src/../../x.ts'] })).some((p) => /component\.sources\[0\]/.test(p)));
});

test('schema: component 不认识的字段直接拒(防拼错静默失效)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const problems = validateSpec(specWithComponent({ soruces: ['src/a.ts'] }));
  assert.ok(problems.some((p) => /component\.soruces 不是支持的字段/.test(p)));
});

test('schema: 非组件模式 spec 不受影响(回归)', () => {
  const { dir } = makeRepoDemo({ name: 'schema-plain', component: false });
  const problems = validateSpec(readSpec(dir));
  assert.deepEqual(problems, [], `旧式 spec 被误伤:${JSON.stringify(problems)}`);
});

// ============ ② buildInputHashes:componentSources 段 ============

test('glob 展开:** 跨目录、只命中声明后缀、跳过 node_modules/.git', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const { repo } = makeRepoDemo({ name: 'glob' });
  mkdirSync(join(repo, 'node_modules/pkg'), { recursive: true });
  writeFileSync(join(repo, 'node_modules/pkg/x.tsx'), 'x\n');
  assert.deepEqual(expandRepoGlob(repo, 'src/**/*.tsx'), ['src/Entry.tsx', 'src/components/Button.tsx']);
  assert.deepEqual(expandRepoGlob(repo, 'src/*.tsx'), ['src/Entry.tsx']);
  assert.deepEqual(expandRepoGlob(repo, 'src/Entry.tsx'), ['src/Entry.tsx']);
});

test('buildInputHashes: component 模式按 manifest 逐文件 sha256 + bundle/清单自身入链', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const { repo, dir } = makeRepoDemo({ name: 'hash' });
  const h = buildInputHashes(dir, readSpec(dir));
  assert.ok(h.componentSources, 'component 模式必须有 componentSources 段');
  assert.equal(h.componentSources.sources['src/components/Button.tsx'], hashFile(join(repo, 'src/components/Button.tsx')));
  assert.equal(h.componentSources.sources['src/Entry.tsx'], hashFile(join(repo, 'src/Entry.tsx')));
  assert.equal(h.componentSources.bundle['assets/component.bundle.js'], hashFile(join(dir, 'assets/component.bundle.js')));
  // manifest 文件自身也进链:改清单本身 = 改链范围,必须让 hash 变
  assert.equal(h.componentSources.manifest, hashFile(join(dir, 'component.inputs.json')));
  // 不在 manifest 里的文件不该混进来(自报 sources 不再决定范围)
  assert.equal(h.componentSources.sources['src/notes.md'], undefined);
});

test('buildInputHashes: 缺 manifest → manifest 记 NO_MANIFEST(fail-closed 新态)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const { dir } = makeRepoDemo({ name: 'hash-nomanifest', manifest: false });
  const h = buildInputHashes(dir, readSpec(dir));
  assert.equal(h.componentSources.manifest, 'NO_MANIFEST');
  /* r12:这些映射改成了无原型对象(路径/名字为 key 的映射统一收紧,见 comp-fix-r12)。
     deepStrictEqual 会比原型,所以期望值也用 Object.create(null) 构造 —— 顺带把
     「必须是无原型对象」这条不变式钉进断言,比改成 deepEqual 更严。 */
  assert.deepEqual(h.componentSources.sources, Object.create(null));
  assert.equal(Object.getPrototypeOf(h.componentSources.sources), null, 'r12:路径为 key,必须无原型');
});

test('buildInputHashes: 改源文件 / 改 bundle 都让 hash 变', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const { repo, dir } = makeRepoDemo({ name: 'hash-change' });
  const spec = readSpec(dir);
  const before = JSON.stringify(buildInputHashes(dir, spec));
  writeFileSync(join(repo, 'src/components/Button.tsx'), 'export const Button = () => null; // v2\n');
  const afterSrc = JSON.stringify(buildInputHashes(dir, spec));
  assert.notEqual(afterSrc, before, '改产品源文件后 hash 居然没变');
  writeFileSync(join(dir, 'assets/component.bundle.js'), '/* bundle v2 */\n');
  assert.notEqual(JSON.stringify(buildInputHashes(dir, spec)), afterSrc, '改 bundle 产物后 hash 居然没变');
});

test('buildInputHashes: manifest 里的文件不在了记 MISSING、bundle 缺失记 MISSING、越狱路径记 INVALID_PATH', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const { dir } = makeRepoDemo({ name: 'hash-missing', productInputs: ['src/deleted.tsx', '../outside.tsx'] });
  const spec = readSpec(dir);
  spec.component.bundle = 'assets/nope.js';
  const h = buildInputHashes(dir, spec);
  assert.equal(h.componentSources.sources['src/deleted.tsx'], 'MISSING');
  assert.equal(h.componentSources.sources['../outside.tsx'], 'INVALID_PATH');
  assert.equal(h.componentSources.bundle['assets/nope.js'], 'MISSING');
});

test('buildInputHashes: 非组件模式不长出 componentSources(回归)', () => {
  const { dir } = makeRepoDemo({ name: 'hash-plain', component: false });
  const h = buildInputHashes(dir, readSpec(dir));
  assert.equal(h.componentSources, undefined);
  // fixture 自带 assets/(bundle 落位),合并后 assets 段对所有 demo 合法入链(comp-assets 设计)
  assert.deepEqual(Object.keys(h).sort(), ['assets', 'baselines', 'index.html', 'spec.json', 'truth.json']);
});

test('findGitRepoRoot: 定位到 demo 所在仓根', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
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
  assetsGate(dir, env);
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

test('组件模式:门 D 文案改为「渲染由产品代码路径承载」,附贴块给出组件模式结论行', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'e2e-gated' });
  const v = run(VERIFY, ['--demo', dir], { env });
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assetsGate(dir, env);
  assert.equal(report.gateD.pass, true);
  assert.match(report.gateD.detail, /组件模式|产品代码路径/);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
  assert.equal(pr.status, 0, `${pr.stdout}${pr.stderr}`);
  // 本 fixture 的 bundle 是手写替身、页面里没有运行期哨兵 → 附贴块必须诚实降级,
  // 不许宣称「真组件直渲」(哨兵证明到了才许,覆盖见 comp-fix-r2.test.mjs)。
  assert.match(pr.stdout, /产品模块已打包（2 个源文件 hash 入链）/);
  assert.match(pr.stdout, /需人工审查/);
  assert.ok(!pr.stdout.includes('真组件直渲'), '哨兵未证明却宣称真组件直渲');
});

test('回归:非组件模式旧 demo 门 D 文案与附贴块不变', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'e2e-plain', component: false });
  const v = run(VERIFY, ['--demo', dir], { env });
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assetsGate(dir, env);
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

function verifyThenPrBlock(dir, env, tamper = null) {
  const v = run(VERIFY, ['--demo', dir], { env });
  assert.equal(v.status, 0, `verify 必须先绿(fail-closed 只在 pr-block 侧):${v.stdout}${v.stderr}`);
  assetsGate(dir, env);
  if (tamper) tamper(dir); // 篡改点放在 verify 之后:模拟「跑绿后再改」这条真实攻击顺序
  return run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
}

test('fail-closed: 自报 sources 声明零命中 → pr-block 拒并提示修 sources', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'fc-nomatch', sources: ['src/**/*.nope'] });
  const pr = verifyThenPrBlock(dir, env);
  assert.equal(pr.status, 2, `零命中声明居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /零命中/);
});

test('fail-closed: 缺 manifest(NO_MANIFEST)→ pr-block 拒并要求先跑 build.mjs', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'fc-nomanifest', manifest: false });
  const pr = verifyThenPrBlock(dir, env);
  assert.equal(pr.status, 2, `缺清单居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /NO_MANIFEST/);
  assert.match(pr.stdout + pr.stderr, /build\.mjs/);
});

test('fail-closed: manifest 里的源文件缺失(MISSING)→ pr-block 拒并点名文件', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  // r3:清单被手改后 verify 自己就会被独立复算抓住(oracle 不再是 demo 侧脚本),
  // 所以「verify 绿」只能在篡改**之前**成立。先健康跑绿,再往清单里塞一个不存在的文件,
  // 断言 pr-block 侧的 fail-closed 仍然点名 MISSING(本用例要守的就是这条)。
  const { dir } = makeRepoDemo({ name: 'fc-missing' });
  const pr = verifyThenPrBlock(dir, env, (d) => {
    const m = JSON.parse(readFileSync(join(d, 'component.inputs.json'), 'utf8'));
    m.productInputs = [...m.productInputs, 'src/deleted.tsx'];
    writeFileSync(join(d, 'component.inputs.json'), `${JSON.stringify(m, null, 2)}\n`);
  });
  assert.equal(pr.status, 2, `缺源文件居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /MISSING/);
  assert.match(pr.stdout + pr.stderr, /src\/deleted\.tsx/);
});

test('fail-closed: demo 不在 git 仓内(UNRESOLVED)→ pr-block 拒并要求 demo 落在产品仓内', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { dir } = makeRepoDemo({ name: 'fc-nogit', noGit: true });
  // r3:demo 不在任何 git 仓内 → 清单根本无法独立复算(repoRoot 不可解析),verify 门 A
  // 自己就会红。这里不再要求 verify 绿(要求它绿等于要求存在一个可自证的窄链),
  // 只守住 pr-block 侧的 fail-closed:必须点名 UNRESOLVED 并说清 demo 该放哪。
  run(VERIFY, ['--demo', dir], { env });
  run(ASSETS_MANIFEST, ['--demo', dir], { env });
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env });
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
  assert.match(pr.stdout, /产品模块已打包/);
});
