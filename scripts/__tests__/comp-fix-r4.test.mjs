// comp-fix-r4.test.mjs — 四轮终审 CRITICAL 的对抗回归。
//
// 漏洞:#2c-a 的「复算路径不执行 demo 目录代码」声明在默认配置下可绕。
//   recheckComponentInputs 把子进程 cwd 设成 demoDir(不可信侧),而子进程解析 esbuild 的
//   候选链是 [QA_HIFI_MODULE_ROOT, repoRoot, process.cwd()] —— 第三项就是 demoDir。
//   未设 QA_HIFI_MODULE_ROOT 且 repoRoot 解析不到 esbuild(pnpm 严格布局 / esbuild 只是
//   间接依赖没提升,都很常见)时,解析落到 `<demo>/node_modules/esbuild`,
//   `await import()` 让它的 CJS 顶层代码同步执行 —— 默认入口下的任意代码执行。
//   放大因素:node_modules 不入哈希链(只记数量),checkDemoBuilderIntegrity 只比 4 个
//   具名文件的 sha256,从不管 demo 里有没有不该有的依赖目录。
//
// r4 两道修法:
//   1) 解析候选链只留 [QA_HIFI_MODULE_ROOT, repoRoot](都不受单个 demo 目录内容左右);
//   2) checkDemoBuilderIntegrity 加结构性 fail-closed:demo 及任意子目录有 node_modules 即拒。
//
// **本文件的对抗用例一律不 skip**:它们刻意走「repoRoot 无 esbuild + demo 有 esbuild」
// 这条分支,不需要宿主 esbuild —— 前三轮的 224 绿全靠 QA_HIFI_MODULE_ROOT + t.skip
// 绕开了这条分支,所以这个洞在全绿下活了下来。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDemoBuilderIntegrity, hashFile, recheckComponentInputs, safeJsonForScript, stableJson } from '../lib/fs-utils.mjs';

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
/** 去掉 QA_HIFI_MODULE_ROOT 的环境 —— 漏洞触发前提之一,也是本文件的默认。 */
function envNoModuleRoot(extra = {}) {
  const e = { ...process.env, ...extra };
  delete e.QA_HIFI_MODULE_ROOT;
  return e;
}
function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env: opts.env ?? envNoModuleRoot(),
    timeout: opts.timeout ?? 150000,
  });
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

const ENTRY = [
  "import { helper } from './Helper';",
  'export function Claimed(){ return `CLAIMED-${helper()}`; }',
  '',
].join('\n');

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
 * 自造 mini 产品仓 + demo。**刻意不给 repoRoot 装 esbuild**(除 withRepoDeps=true),
 * 这正是审核人 PoC 的前提:标准 require.resolve 在产品仓解析不到 esbuild。
 */
function makeFixture({ name, withRepoDeps = false, manifest = null } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `qa-r4-${name}-`));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  writeFileSync(join(repo, 'src/components/Helper.ts'), 'export const helper = () => "helper-v1";\n');
  writeFileSync(join(repo, 'src/components/Claimed.ts'), ENTRY);
  if (withRepoDeps) symlinkSync(join(MODULE_ROOT, 'node_modules'), join(repo, 'node_modules'));

  const dir = join(repo, 'qa-demo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  for (const [from, to] of BUILD_FILES) copyFileSync(join(ROOT, from), join(dir, to));
  writeFileSync(join(dir, 'src/bootstrap.ts'), "import { Claimed } from '../../src/components/Claimed';\nglobalThis.__demo = Claimed();\n");

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
    },
  };
  writeFileSync(join(dir, 'truth.json'), stableJson(truth));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'index.html'), baseHtml(truth));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  if (manifest !== false) {
    writeFileSync(join(dir, 'component.inputs.json'), `${JSON.stringify(manifest ?? {
      generator: ROOT, entry: 'src/components/Claimed.ts', entryExport: 'Claimed', entrySentinel: 'targeted',
      productInputs: ['src/components/Claimed.ts', 'src/components/Helper.ts'],
      demoInputs: ['src/bootstrap.ts'], buildInputs: { demo: [], product: [] }, skippedExternal: [],
    }, null, 2)}\n`);
  }
  return { repo, dir };
}

/**
 * 审核人 PoC 的恶意依赖:`<demo>/node_modules/esbuild`,CJS 顶层落标记文件,
 * 导出的 build() 直接抛错(它根本不需要能用 —— 顶层跑到就已经赢了)。
 * 返回标记文件绝对路径。
 */
function plantMaliciousEsbuild(repo, dir) {
  const mod = join(dir, 'node_modules/esbuild');
  mkdirSync(mod, { recursive: true });
  const marker = join(repo, 'PWNED.txt');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'qa-demo', version: '0.0.0' }));
  writeFileSync(join(mod, 'package.json'), JSON.stringify({ name: 'esbuild', version: '9.9.9', main: 'index.js' }));
  writeFileSync(join(mod, 'index.js'),
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'demo-side code executed\\n');\n`
    + "module.exports = { build: async () => { throw new Error('fake esbuild'); } };\n");
  return marker;
}

// ==================== r4 CRITICAL:复算路径不得执行 demo 目录代码 ====================

test('r4 复现样本: demo 自带 node_modules/esbuild + repoRoot 无 esbuild → 复算拒收且 demo 代码不执行', () => {
  const { repo, dir } = makeFixture({ name: 'rce-recheck' });
  const marker = plantMaliciousEsbuild(repo, dir);
  // 四个构建期文件字节等于 canonical —— 旧版 checkDemoBuilderIntegrity 在这里返回空
  assert.deepEqual(
    BUILD_FILES.filter(([from, to]) => hashFile(join(dir, to)) !== hashFile(join(ROOT, from))),
    [], '构建期文件必须与 canonical 全等(否则测的不是这条分支)',
  );

  const saved = process.env.QA_HIFI_MODULE_ROOT;
  delete process.env.QA_HIFI_MODULE_ROOT; // 触发前提:运行者没设 module root
  try {
    const problems = checkDemoBuilderIntegrity(dir);
    assert.equal(problems.length, 1, `demo 带 node_modules 必须被结构性拒收:${JSON.stringify(problems)}`);
    assert.match(problems[0], /demo 目录不应自带 node_modules,检测到依赖目录,拒绝——demo 自身不装依赖/);

    const res = recheckComponentInputs(dir);
    assert.equal(res.status, 'bad-builder', `复算必须 fail-closed,实际:${res.status} ${JSON.stringify(res.problems)}`);
    assert.match(res.problems.join('\n'), /demo 目录不应自带 node_modules/);
  } finally {
    if (saved !== undefined) process.env.QA_HIFI_MODULE_ROOT = saved;
  }
  assert.equal(existsSync(marker), false, 'demo 目录里的代码被执行了(r4 CRITICAL 未修:任意代码执行)');
});

test('r4 解析链独立生效: 直接以 cwd=demoDir 跑 skill 侧构建核心,也不许命中 demo 的 node_modules', () => {
  // 这条绕开 checkDemoBuilderIntegrity,单测「候选链去掉 process.cwd()」这一道
  // —— 两道修法各自都要能挡住,不允许只靠 node_modules 那一道兜。
  const { repo, dir } = makeFixture({ name: 'rce-core' });
  const marker = plantMaliciousEsbuild(repo, dir);
  const r = run(CORE, ['--check-inputs', '--demo', dir], { cwd: dir });
  assert.equal(existsSync(marker), false, `解析候选链仍会命中 <demo>/node_modules/esbuild 并执行其顶层代码:${r.stdout}${r.stderr}`);
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(r.status !== 0 || out.includes('"ok": false'), `解析不到 esbuild 时必须失败退出,不许静默:${out}`);
  assert.match(out, /无法解析模块 esbuild/, '应如实报「解析不到 esbuild」而不是别的错');
});

test('r4 子目录里的 node_modules 同样被拒(不是只看顶层)', () => {
  const { dir } = makeFixture({ name: 'rce-nested' });
  mkdirSync(join(dir, 'src/vendor/node_modules/esbuild'), { recursive: true });
  writeFileSync(join(dir, 'src/vendor/node_modules/esbuild/package.json'), '{"name":"esbuild","main":"index.js"}');
  const problems = checkDemoBuilderIntegrity(dir);
  assert.equal(problems.length, 1, '嵌套 node_modules 漏过了');
  assert.match(problems[0], /src\/vendor\/node_modules/);
});

test('r4 未误杀: demo 干净(无 node_modules)时新增的那道门不出声', () => {
  const { dir } = makeFixture({ name: 'clean-demo' });
  assert.deepEqual(checkDemoBuilderIntegrity(dir), [], '干净 demo 被新门误伤');
  const saved = process.env.QA_HIFI_MODULE_ROOT;
  delete process.env.QA_HIFI_MODULE_ROOT;
  try {
    // repoRoot 也没 esbuild → 这里只该是「跑不起来」的 error,绝不是 bad-builder
    const res = recheckComponentInputs(dir);
    assert.notEqual(res.status, 'bad-builder', 'node_modules 那道门误伤了干净 demo');
  } finally {
    if (saved !== undefined) process.env.QA_HIFI_MODULE_ROOT = saved;
  }
});

// ==================== 端到端:门 A / pr-block 口径 + 正常路径不误杀 ====================

test('r4 端到端: QA_HIFI_MODULE_ROOT 未设、repoRoot 有 esbuild → 合法 demo 照常构建/复算/出块', (t) => {
  if (!MODULE_ROOT) return t.skip('需要一份装了 esbuild 的仓来当产品仓依赖(QA_HIFI_MODULE_ROOT)');
  const { dir } = makeFixture({ name: 'positive', withRepoDeps: true, manifest: false });
  // 注意:全程 env 里没有 QA_HIFI_MODULE_ROOT —— 解析必须落在 repoRoot 上
  const b = run(join(dir, 'build.mjs'), [], { cwd: dir });
  assert.equal(b.status, 0, `去掉 cwd 候选后 repoRoot 解析被打断了:${b.stdout}${b.stderr}`);
  const v = run(VERIFY, ['--demo', dir]);
  assert.equal(v.status, 0, `正常路径被误杀:${v.stdout}${v.stderr}`);
  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.gateA.inputsRecheck, 'ok', '独立复算应正常算出一致结果');
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir]).status, 0);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team']);
  assert.equal(pr.status, 0, `${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /真组件直渲/);
});

test('r4 端到端: 绿基线上事后植入 demo/node_modules → verify 转红、门 A bad-builder、pr-block exit 2', (t) => {
  if (!MODULE_ROOT) return t.skip('需要一份装了 esbuild 的仓来当产品仓依赖(QA_HIFI_MODULE_ROOT)');
  const { repo, dir } = makeFixture({ name: 'e2e-block', withRepoDeps: true, manifest: false });
  assert.equal(run(join(dir, 'build.mjs'), [], { cwd: dir }).status, 0);
  assert.equal(run(VERIFY, ['--demo', dir]).status, 0, '基线应先绿');
  assert.equal(run(ASSETS_MANIFEST, ['--demo', dir]).status, 0);
  assert.equal(run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team']).status, 0, '基线应能出块');
  const baselineReport = readJson(join(dir, 'report.json'));

  const marker = plantMaliciousEsbuild(repo, dir);
  const v = run(VERIFY, ['--demo', dir]);
  assert.notEqual(v.status, 0, 'demo 带上依赖目录后 verify 居然还绿');
  /* r5 P0-2 把这道检查前移成**无条件 fail-fast**:命中即 process.exit,不再「置
     gateA.pass=false 后继续跑到 launchChromium」。所以断言从「report 里门 A 变红」
     改成更强的形态——verify 根本没跑到写 report 这一步(磁盘上还是上一轮的绿报告),
     失败信息直接由 stdout 给出。这是收紧不是放松:r4 的形态下恶意依赖仍会在标红之后
     被浏览器/动态 import 路径加载,r5 连门都进不去。 */
  assert.match(v.stdout + v.stderr, /demo 目录不应自带 node_modules/);
  assert.equal(readJson(join(dir, 'report.json')).generatedAt, baselineReport.generatedAt,
    'fail-fast 必须早于任何门执行 —— report.json 不应被本次运行改写');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team']);
  assert.equal(pr.status, 2, `report 未过必须 exit 2:${pr.stdout}${pr.stderr}`);
  assert.equal(existsSync(marker), false, 'verify/pr-block 全程都不许执行 demo 目录里的代码');
});
