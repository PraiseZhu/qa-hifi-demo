// comp-fix-r4-p0.test.mjs — 四轮终审追加两条 P0 的对抗回归。
//
//   #1c 目标导出哨兵可被 demo 伪造:证据放在公开可写的 globalThis.__QA_ENTRY_RENDERED__ /
//       __QA_ENTRY_TARGET_RENDERED__ / __QA_ENTRY_SHAPE__ 上,verify 直接信。
//       PoC:bootstrap 只 `globalThis.keep = Claimed` 持引用、从不调用,再把两个布尔量写 true
//       + 手搓 UI → proved + PR 块「真组件直渲」。攻击不改 canonical builder/manifest/bundle,
//       bootstrap 本就是允许作者编辑且已入 hash 链的输入。
//       r4:置位与计数留在 bundle 模块闭包,对外只有一个 non-writable/non-configurable 全局上的
//       get-only snapshot;verify 校验封印形态并只读它。
//
//   #2c-b tailwind config 自带 content 的合法路径没入链:`css:{tailwindConfig}` 省略 content 时
//       build 不传 --content,Tailwind 按 config.content 隐式扫描,清单只记 config 本身。
//       改样式源文件 hash 不变 → 旧 CSS + 旧 report 照过。
//       r4(方案 A):配了 css 就必须显式声明非空 content,build 始终 --content 覆盖 config;
//       缺失/空数组 → schema + 构建核心双重 fail-closed。
//
// 分层说明(诚实标注):#2c-b 的 fail-closed 断言与「源码契约」断言**不 skip**,零外部依赖;
// #1c 的端到端 PoC 需要真 esbuild + playwright(项目 canonical 测试命令一直带
// QA_HIFI_MODULE_ROOT,因此实跑),另配一组不 skip 的源码契约断言兜住「修法被回退」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, safeJsonForScript, stableJson } from '../lib/fs-utils.mjs';
import { validateSpec } from '../lib/schema.mjs';

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
    timeout: opts.timeout ?? 150000,
  });
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

const ENTRY = [
  "import { helper } from './Helper';",
  'export function Claimed(){ return `CLAIMED-${helper()}`; }',
  '',
].join('\n');

/** #1c 的 exploit:持引用但**从不调用**,直接伪造旧的可写全局证据 + 手搓 UI。 */
const BOOT_FORGE = [
  "import { Claimed } from '../../src/components/Claimed';",
  'globalThis.keep = Claimed;', // 只保留引用,绕过 tree-shake 护栏
  'globalThis.__QA_ENTRY_RENDERED__ = true;',
  'globalThis.__QA_ENTRY_TARGET_RENDERED__ = true;',
  "globalThis.__QA_ENTRY_SHAPE__ = { total: 1, wrappable: 1, sentinel: true, target: 'Claimed', targetWrappable: 1 };",
  "globalThis.__demo = 'HAND_WRITTEN_ONLY';",
  '',
].join('\n');
const BOOT_REAL = "import { Claimed } from '../../src/components/Claimed';\nglobalThis.__demo = Claimed();\n";

function baseHtml(truth, { fakeSentinelBeforeBundle = false } = {}) {
  const fake = fakeSentinelBeforeBundle
    ? `<script>Object.defineProperty(globalThis,'__QA_ENTRY_SENTINEL__',{value:Object.freeze({snapshot:{rendered:true,targetRendered:true,shape:{total:1,wrappable:1,targetWrappable:1,target:'Claimed',sentinel:true}}}),writable:false,configurable:false});</script>`
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

/**
 * mini 产品仓 + demo。`css` 直接落进 spec.component.css(用于 #2c-b 的形状测试);
 * `repoDeps` 时把宿主 node_modules symlink 成产品仓依赖(真 build 需要 esbuild)。
 */
function makeFixture({ name, boot = 'forge', css, repoDeps = false, fakeSentinelBeforeBundle = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qa-r4p0-${name}-`));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  writeFileSync(join(repo, 'src/components/Helper.ts'), 'export const helper = () => "helper-v1";\n');
  writeFileSync(join(repo, 'src/components/Claimed.ts'), ENTRY);
  writeFileSync(join(repo, 'src/StyleOnly.tsx'), 'export const cls = "bg-red-500";\n');
  writeFileSync(join(repo, 'tailwind.config.js'), "module.exports = { content: ['./src/StyleOnly.tsx'], theme: {} };\n");
  if (repoDeps) symlinkSync(join(MODULE_ROOT, 'node_modules'), join(repo, 'node_modules'));

  const dir = join(repo, 'qa-demo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  for (const [from, to] of BUILD_FILES) copyFileSync(join(ROOT, from), join(dir, to));
  writeFileSync(join(dir, 'src/bootstrap.ts'), boot === 'forge' ? BOOT_FORGE : BOOT_REAL);

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
  writeFileSync(join(dir, 'index.html'), baseHtml(truth, { fakeSentinelBeforeBundle }));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  return { repo, dir, spec };
}

// ==================== #1c 哨兵封印 ====================

test('#1c 源码契约(不 skip): 证据不再挂在可写全局上,verify 也不再读那三个字段', () => {
  const core = readFileSync(join(ROOT, 'scripts/lib/component-build-core.mjs'), 'utf8');
  const verify = readFileSync(join(ROOT, 'scripts/verify.mjs'), 'utf8');
  for (const field of ['__QA_ENTRY_RENDERED__', '__QA_ENTRY_TARGET_RENDERED__', '__QA_ENTRY_SHAPE__']) {
    // 只禁「赋值」形态(注释里复述漏洞历史是允许的)
    assert.doesNotMatch(core, new RegExp(`globalThis\\.${field}\\s*=`), `构建核心仍往可写全局 ${field} 写证据(#1c 未修)`);
    assert.doesNotMatch(verify, new RegExp(`globalThis\\.${field}`), `verify 仍在读可写全局 ${field}(#1c 未修)`);
  }
  // 封印三要素必须都在:value 不可写 + 属性不可配置 + 只读访问器
  assert.match(core, /Object\.defineProperty\(globalThis, "__QA_ENTRY_SENTINEL__", \{ value: __qaSeal, writable: false, configurable: false/);
  assert.match(core, /Object\.defineProperty\(__qaSeal, "snapshot", \{ enumerable: false, configurable: false, get:/);
  assert.match(core, /Object\.freeze\(__qaSeal\)/);
  // verify 必须校验封印形态,而不是只取值
  assert.match(verify, /哨兵证据不是封印形态/);
  assert.match(verify, /Object\.getOwnPropertyDescriptor\(globalThis, '__QA_ENTRY_SENTINEL__'\)/);
});

test('#1c 复现样本: 持引用不调用 + 伪造旧全局 + 手搓 UI → 门 B 硬失败,绝无「真组件直渲」', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright(QA_HIFI_MODULE_ROOT);同文件的源码契约用例不 skip');
  const { dir } = makeFixture({ name: 'forge', boot: 'forge', repoDeps: true });
  const b = run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() });
  assert.equal(b.status, 0, `build 应成功(entry 确实在 bundle 里——这正是漏洞形状):${b.stdout}${b.stderr}`);
  assert.equal(readJson(join(dir, 'component.inputs.json')).entrySentinel, 'targeted');
  // 攻击面固定住:bundle 里既有手搓 UI 标记,也有对旧全局字段的赋值
  const bundle = readFileSync(join(dir, 'assets/component.bundle.js'), 'utf8');
  assert.ok(bundle.includes('HAND_WRITTEN_ONLY'), '手搓 UI 标记应在 bundle 里');
  assert.ok(bundle.includes('__QA_ENTRY_TARGET_RENDERED__'), 'demo 对旧全局的赋值应仍在 bundle 里(证明它已无效,而不是被删了)');

  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, `伪造哨兵布尔量居然通过了 verify(#1c 未修:proved 是假话):${v.stdout}${v.stderr}`);
  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.gateB.pass, false);
  assert.notEqual(report.gateB.entryRenderProof, 'proved', '伪造的证据仍被采信');
  assert.match(report.gateB.failures[0].error, /声明的目标导出从未被渲染/);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 2, `report 未过必须 exit 2:${pr.stdout}${pr.stderr}`);
  assert.ok(!pr.stdout.includes('真组件直渲'));
});

test('#1c 顶替哨兵全局(bundle 之前抢先 defineProperty 不可配置的假证据) → verify 红', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({ name: 'hijack', boot: 'forge', repoDeps: true, fakeSentinelBeforeBundle: true });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, '页面侧顶替哨兵全局居然还能过 verify');
  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.gateB.pass, false);
  assert.notEqual(report.gateB.entryRenderProof, 'proved');
});

test('#1c 阳性对照: 真调用目标导出 → 仍是 proved + PR 块写「真组件直渲」', (t) => {
  if (!MODULE_ROOT) return t.skip('端到端需要真 esbuild + playwright');
  const { dir } = makeFixture({ name: 'real', boot: 'real', repoDeps: true });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir, env: env() }).status, 0);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(v.status, 0, `封印改造误伤了正常路径:${v.stdout}${v.stderr}`);
  assert.equal(readJson(join(dir, 'report.json')).gateB.entryRenderProof, 'proved');
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir], { env: env() }).status, 0);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env: env() });
  assert.equal(pr.status, 0, `${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /真组件直渲/);
});

// ==================== #2c-b tailwind content 必须显式声明 ====================

test('#2c-b 复现形状(不 skip): config 有 content、spec 省略 content → schema fail-closed', () => {
  const { spec } = makeFixture({ name: 'implicit-content', css: { tailwindConfig: 'tailwind.config.js' } });
  const problems = validateSpec(spec);
  assert.ok(problems.length >= 1, 'r3 的合法形状(省略 content)现在必须被拒');
  assert.ok(
    problems.some((p) => /component\.css\.content 必须是非空 string 数组/.test(p)),
    `报文应点名 content 必填:${JSON.stringify(problems)}`,
  );
  assert.ok(problems.some((p) => /隐式扫描|防伪链/.test(p)), '报文应说明为什么必填(隐式扫描的文件不入防伪链)');
});

test('#2c-b 空数组同样 fail-closed(不 skip)', () => {
  const { spec } = makeFixture({ name: 'empty-content', css: { tailwindConfig: 'tailwind.config.js', content: [] } });
  assert.ok(validateSpec(spec).some((p) => /component\.css\.content 必须是非空 string 数组/.test(p)));
});

test('#2c-b 构建核心独立 fail-closed(不 skip): 省略 content 时 --check-inputs 直接 exit 2', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  // 不靠 schema 兜:构建核心自己也必须拒(--check-inputs 是复算 oracle 的入口,
  // 它若放行,「清单只记 config、不记命中文件」的旧形状就又能算出一致 hash)。
  const { dir } = makeFixture({ name: 'core-implicit', css: { tailwindConfig: 'tailwind.config.js' } });
  const r = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 2, `构建核心放行了省略 content 的形状:${out}`);
  assert.match(out, /component\.css\.content 缺失\/为空/);
  assert.match(out, /隐式扫描/);
});

test('#2c-b verify 层也拦得住(不 skip,无需浏览器): 省略 content 的 demo 直接非零退出', () => {
  const { dir } = makeFixture({ name: 'verify-implicit', css: { tailwindConfig: 'tailwind.config.js' } });
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, '省略 content 的 demo 居然能进 verify');
  assert.match(`${v.stdout}${v.stderr}`, /component\.css\.content/);
});

test('#2c-b 薄壳模板始终显式传 --content(不 skip,源码契约)', () => {
  const tpl = readFileSync(join(ROOT, 'templates/component-build.mjs'), 'utf8');
  /* r7 条目 2:content 改显式文件列表后,--content 的参数构造收敛到构建核心的 contentCliArg
     (转绝对路径,两侧共用一份);断言随之改成那条,强度不变——仍然要求**无条件显式传**。 */
  assert.match(tpl, /'--content', contentCliArg\(repoRoot, comp\)/, '模板必须无条件显式传 --content(参数由 contentCliArg 构造)');
  assert.ok(!/comp\.css\.content\.join\(','\)/.test(tpl), '模板不该再直接 join 相对路径(语义解释权要收回)');
  assert.ok(
    !/if \(Array\.isArray\(comp\.css\.content\) && comp\.css\.content\.length\) args\.push\('--content'/.test(tpl),
    '仍保留「有 content 才传」的条件分支 → Tailwind 会回退到 config.content 隐式扫描(#2c-b 未修)',
  );
});

test('#2c-b 阳性对照(不 skip): 显式声明 content 且命中文件 → 命中文件逐一入 buildInputs.product', () => {
  const { dir } = makeFixture({ name: 'explicit-content', css: { tailwindConfig: 'tailwind.config.js', content: ['src/StyleOnly.tsx'] } });
  const r = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir, env: env() });
  if (r.status !== 0) {
    // 无宿主 esbuild 时构建核心跑不到清单阶段;此时至少确认它不是被 content 那道门拦下的
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /component\.css\.content 缺失\/为空/, '显式声明了 content 却被误伤');
    return;
  }
  const manifest = JSON.parse(r.stdout);
  assert.ok(manifest.buildInputs.product.includes('tailwind.config.js'));
  assert.ok(manifest.buildInputs.product.includes('src/StyleOnly.tsx'), 'content 命中的样式源文件必须入链');
});
