// comp-fix-r10.test.mjs — r10 P0:可信脚本副本破坏 ESM 相对 import 的回归。
//
// 缺陷(正式 e2e 抓到,十轮安全终审全部漏过):
//   · init.mjs:192 生成的**官方** extract.mjs 模板第一行就是
//     `import { findRepoRoot, ... } from './extract-helpers.mjs'`;
//   · init.mjs:213 把 scripts/lib/extract-helpers.mjs 拷进 demo(设计意图:demo 自包含、
//     随 PR 进产品仓、不依赖 skill 安装位置);SKILL.md 也要求作者用 demo 内那份 helper;
//   · 但 r8 条目 C 的 trustedScriptCopy 只把 extract.mjs **单文件**复制到
//     `<outputRoot>/trusted-scripts/<hash12>-<name>` 再执行 —— ESM 相对 specifier 按脚本
//     自身位置解析,兄弟模块不在旁边 → ERR_MODULE_NOT_FOUND。
//   结论:**官方脚手架的推荐写法在可信执行路径下跑不通**,门 A 的 extractorDrift 恒为 'error'。
//
// 修前实测(本仓 HEAD=ae2d385,最小复现 demo,verify --gate A):
//   exit 2 / gateA.pass=false / gateA.extractorDrift="error"
//   gateA.detail="extract.mjs 执行失败:... Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//                 '/private/var/folders/.../T/qa-hifi-out-2dyg1z/tr..."
// 修后同一 demo:exit 0 / gateA.pass=true / gateA.extractorDrift="none"。
//
// 为什么 350/350 测不出来:所有 fixture 的 extract.mjs 都是自包含单行
// `process.stdout.write(<truth>)`,与真实产物形态不一致 —— 「测试在骗自己」的第三种形状
// (前两次:宿主碰巧装了 tailwind、TS 钉错被产品仓掩盖)。本轮把 fixture 忠实化,
// 并加源码契约测试把「init 模板形态 ⟷ fixture 形态」钉在一起。
//
// 修法(方向 A 的收紧版):复制的不再是单文件而是**整棵树**,字节取自观察快照,脚本在树内的
// 原相对位置执行。为什么不选另两条:
//   · 方向 B(复制 import 闭包):作者可以动态 import 任意 demo 内文件,闭包边界静态定不住;
//   · 方向 C(重写 specifier / 挂 loader):改写后字节就变了,与「执行的是已 hash 的字节」直接冲突。
// 副作用的处理:exec 树是**每次调用新开的一次性副本**(从快照复制,不是快照本身),
// 所以 demo 脚本写自己所在的树时,动不到已用于观察的那份快照字节(I-OBSERVE 不回退),
// 收口 manifest 比的仍是 snapshot ⟷ disk 两棵,与 exec 树无关。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, safeJsonForScript } from '../lib/fs-utils.mjs';
import { makeFixtureLeaf } from '../lib/extract-helpers.mjs';
import { makeObservationSnapshot, makeOutputRoot, trustedScriptCopy } from '../lib/observe.mjs';
import { HELPER_IMPORT_RE, templateExtractor } from './_extractor-template.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const OBSERVE = join(ROOT, 'scripts/lib/observe.mjs');
const INIT = join(ROOT, 'scripts/init.mjs');
const HELPERS = join(ROOT, 'scripts/lib/extract-helpers.mjs');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
}

/* 最小非组件 demo:门 A 不需要浏览器,所以这些核心回归在**任何环境**都真跑、不 skip。
   extractor 形态由 `extractor` 参数决定 —— 默认就是官方模板形态(带 helper 相对 import)。 */
function writeDemo({ name, extractor, extraFiles = {}, truthExtra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `qa-r10-${name}-`));
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
  const leaf = (v, l) => ({ value: v, provenance: { source: 'source.txt', locator: l, hash: hashFile(source) } });
  const truth = { colors: { text: leaf('#ff0000', 'text color') }, ...truthExtra };
  const spec = {
    meta: { name, summary: { what: 'what', how: 'how', accept: 'accept' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: {
      cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [{ expect: 'id' }] }],
      noClip: ['.box'],
    },
    bindings: [{ sel: '.box', prop: 'color', truth: 'colors.text', kind: 'color' }],
  };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
  writeFileSync(join(dir, 'extract.mjs'), extractor ?? templateExtractor(truth));
  copyFileSync(HELPERS, join(dir, 'extract-helpers.mjs'));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><style>
    .box{color:#ff0000;width:16px}#frame{width:16px;height:16px}
  </style></head><body>
  <script id="qa-truth" type="application/json">${safeJsonForScript(truth)}</script>
  <div class="box">x</div><div id="frame" class="frame"></div>
  <script>const S={step:'id',prefs:{plat:'desk',region:'cn',os:'ios',mode:'light',lang:'zh-CN'}};
  window.__qa={current:()=>S.step,goto:(id)=>{if(id!=='id')throw new Error('unknown');S.step=id;},prefs:()=>({...S.prefs}),scale:()=>1,resize:()=>{}};</script>
  </body></html>`);
  for (const [rel, content] of Object.entries(extraFiles)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return { dir, truth };
}

/** 只跑门 A(不需要 playwright);--gate 过滤下 report 落 demo/report.json。 */
function verifyGateA(dir, extraArgs = []) {
  const res = run(VERIFY, ['--demo', dir, '--gate', 'A', ...extraArgs]);
  return { res, rep: readJson(join(dir, 'report.json')) };
}

// ============================================================================
// P0 主回归:官方模板形态必须跑通
// ============================================================================

test('r10 P0(不 skip): 模板式 extract.mjs(import ./extract-helpers.mjs)在可信执行路径下跑通', () => {
  const { dir } = writeDemo({ name: 'tpl-import' });
  assert.match(readFileSync(join(dir, 'extract.mjs'), 'utf8'), HELPER_IMPORT_RE, 'fixture 必须是模板形态,否则这条测不到 P0');
  const { res, rep } = verifyGateA(dir);
  assert.equal(rep.gateA.extractorDrift, 'none',
    `修前这里是 "error"/ERR_MODULE_NOT_FOUND:${rep.gateA.detail}`);
  assert.equal(rep.gateA.pass, true, rep.gateA.detail);
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('r10 阳性对照(不 skip): 自包含 extract.mjs(不 import 任何兄弟模块)仍照常工作', () => {
  const { dir, truth } = writeDemo({ name: 'selfcontained', extractor: 'PLACEHOLDER' });
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  const { rep } = verifyGateA(dir);
  assert.equal(rep.gateA.extractorDrift, 'none', rep.gateA.detail);
  assert.equal(rep.gateA.pass, true, rep.gateA.detail);
});

test('r10(不 skip): extract.mjs 深层相对 import(子目录里的模块)同样可解析', () => {
  // 整树副本的必要性:单文件副本连一层子目录都跟不过去,而作者完全可能拆 lib/。
  const { dir, truth } = writeDemo({
    name: 'deep-import',
    extractor: "import { emit } from './lib/emit.mjs';\nimport './extract-helpers.mjs';\nemit();\n",
    extraFiles: { 'lib/emit.mjs': 'PLACEHOLDER' },
  });
  writeFileSync(join(dir, 'lib/emit.mjs'),
    `export function emit(){ process.stdout.write(${JSON.stringify(JSON.stringify(truth))}); }\n`);
  const { rep } = verifyGateA(dir);
  assert.equal(rep.gateA.extractorDrift, 'none', rep.gateA.detail);
});

test('r10(不 skip): fixture 叶子路径(makeFixtureLeaf/fixtures/*.json)+ 模板式 extractor 端到端跑通', () => {
  // e2e 里 FAIL 的正是这条:C2 fixture 叶子 demo 的 extract.mjs 是模板形态。
  const fixtureJson = JSON.stringify({ data: [{ displayName: '火山方舟' }] }, null, 2);
  const { dir } = writeDemo({ name: 'fixture-leaf', extraFiles: { 'fixtures/providers.json': fixtureJson } });
  // truth 里加一个 fixture 叶子(provenance 指向 demo 内 fixtures/*.json + capturedFrom)
  const truth = readJson(join(dir, 'truth.json'));
  truth.providers = {
    name: makeFixtureLeaf('火山方舟', 'fixtures/providers.json', {
      locator: 'data[0].displayName',
      capturedFrom: { environment: '公司沙盒', capturedAt: '2026-07-30', endpoint: 'GET /api/providers' },
      demoDir: dir,
    }),
  };
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
  writeFileSync(join(dir, 'extract.mjs'), templateExtractor(truth));
  const { rep } = verifyGateA(dir);
  assert.equal(rep.gateA.extractorDrift, 'none', rep.gateA.detail);
  assert.ok((rep.truthStats?.fixtureLeaves ?? 0) >= 1, 'fixture 叶子必须被计数,否则这条没走 fixture 路径');
});

test('r10(不 skip): 门 X 自定义门脚本 import 兄弟模块同样跑通,且 hash 仍入链', () => {
  const { dir } = writeDemo({ name: 'gatex-import' });
  writeFileSync(join(dir, 'gate-lib.mjs'), "export const verdict = () => 'gate-ok';\n");
  writeFileSync(join(dir, 'probe-gate.mjs'),
    "import { verdict } from './gate-lib.mjs';\n"
    + "import { findRepoRoot } from './extract-helpers.mjs';\nvoid findRepoRoot;\n"
    + 'process.stdout.write(verdict());\n');
  const spec = readJson(join(dir, 'spec.json'));
  spec.customGates = [{ id: 'probe', script: 'probe-gate.mjs' }];
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  const sha = hashFile(join(dir, 'probe-gate.mjs'));
  const res = run(VERIFY, ['--demo', dir, '--gate', 'A,X']);
  const rep = readJson(join(dir, 'report.json'));
  const entry = rep.gateX.gates.find((g) => g.id === 'probe');
  assert.ok(entry, JSON.stringify(rep.gateX));
  assert.equal(entry.pass, true, entry.detail);
  assert.match(String(entry.detail), /gate-ok/, '必须真跑到 import 之后的业务输出');
  assert.equal(entry.scriptSha256, sha, '执行的脚本字节 hash 必须仍是磁盘上那份(防伪链不许松)');
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

// ============================================================================
// 硬要求 1:「执行的字节 == 前置 hash 的字节」不许因为改成整树副本而变松
// ============================================================================

test('r10(不 skip): 可信执行树里那份字节 ≠ 磁盘 hash 时 → mismatch,调用方 fail-closed', () => {
  const { dir } = writeDemo({ name: 'byte-bind' });
  // 先建快照(= 观察对象),再改磁盘上的 extract.mjs → 两棵树在这条路径上分叉
  const snap = makeObservationSnapshot(dir, { prefix: 'qa-r10-bind-' });
  writeFileSync(join(dir, 'extract.mjs'), 'process.stdout.write("{}");\n');
  const out = makeOutputRoot({ prefix: 'qa-r10-out-' });
  const copy = trustedScriptCopy(join(dir, 'extract.mjs'), out, { demoDir: dir, sourceTree: snap });
  assert.equal(copy.sha256, hashFile(join(dir, 'extract.mjs')), 'sha256 仍必须是磁盘那份(入链的就是它)');
  assert.equal(copy.mismatch, true, '磁盘字节 ≠ 树内字节必须报 mismatch —— 这比 r8 更强:顺带绑住了快照 ≡ 磁盘');
  // 反向:不改磁盘时必须一致(否则这条断言退化成恒真)
  const clean = writeDemo({ name: 'byte-bind-ok' });
  const snap2 = makeObservationSnapshot(clean.dir, { prefix: 'qa-r10-bind2-' });
  const ok = trustedScriptCopy(join(clean.dir, 'extract.mjs'), makeOutputRoot({ prefix: 'qa-r10-out2-' }),
    { demoDir: clean.dir, sourceTree: snap2 });
  assert.equal(ok.mismatch, false);
  assert.equal(ok.copySha256, ok.sha256);
});

test('r10 源码契约(不 skip): verify 执行的是可信树内副本,且 mismatch 一律 fail-closed', () => {
  const v = stripComments(readFileSync(VERIFY, 'utf8'));
  /* 与 r8 条目 C 的契约相比,唯一变化是 trustedScriptCopy 多了 { demoDir, sourceTree } ——
     这不是回退:sourceTree 优先传观察快照,「执行已 hash 字节」这条由 copy.mismatch 守着,
     而且现在**同时**要求磁盘 ≡ 快照。r8 那条断言按此更新,不是被删掉。 */
  assert.match(v, /const copy = trustedScriptCopy\(scriptAbs, outputRoot, \{ demoDir, sourceTree: snapshotDir \?\? demoDir \}\)/,
    '必须先取可信整树副本,且来源树优先是观察快照');
  assert.match(v, /spawnSync\(process\.execPath, \[copy\.exec, \.\.\.extraArgs\]/, '必须执行副本而不是原路径');
  assert.ok(!/spawnSync\(process\.execPath, \[scriptAbs/.test(v), '不许再按同一路径 spawn(窄 check/use 竞态)');
  assert.match(v, /copy\.mismatch/, '字节不一致必须 fail-closed');
  const ob = stripComments(readFileSync(OBSERVE, 'utf8'));
  const fn = ob.slice(ob.indexOf('export function trustedScriptCopy'));
  assert.match(fn, /const sha = hashFile\(scriptAbs\)/, 'hash 的对象仍是磁盘上的脚本');
  assert.match(fn, /cpSync\(src, dir, \{/, '必须整树复制(单文件复制会断相对 import)');
  assert.match(fn, /const copySha = hashFile\(exec\)/, '必须复算树内那份 hash 与磁盘 hash 比对');
  assert.match(fn, /mismatch: copySha !== sha/);
  assert.match(fn, /findDemoSymlinks/, 'symlink 纵深必须保留(否则 exec 树的 cpSync 会 dereference 仓外目标)');
  assert.match(fn, /demoDir \|\| !sourceTree/, '缺参数必须抛,不许静默退回单文件副本');
});

// ============================================================================
// 硬要求 3:I-OBSERVE 不回退 —— 脚本改不到「已用于观察的那份快照字节」
// ============================================================================

test('r10(不 skip): 脚本在执行期写自己所在的树 → 观察快照字节不变,收口 manifest 不误报', () => {
  const { dir, truth } = writeDemo({ name: 'selfwrite', extractor: 'PLACEHOLDER' });
  /* extract.mjs 往「自己所在目录」(= exec 树)写一个新文件、并改写自己的兄弟模块。
     如果 exec 树就是观察快照本身,这两下会让收口 manifest 把快照与磁盘判成不一致(误报)。 */
  writeFileSync(join(dir, 'extract.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { dirname } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "import './extract-helpers.mjs';",
    'const here = dirname(fileURLToPath(import.meta.url));',
    "writeFileSync(here + '/side-effect.txt', 'written-by-extractor');",
    "writeFileSync(here + '/extract-helpers.mjs', '// clobbered\\n');",
    `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});`,
    '',
  ].join('\n'));
  const helpersSha = hashFile(join(dir, 'extract-helpers.mjs'));
  const { res, rep } = verifyGateA(dir);
  assert.equal(rep.gateA.extractorDrift, 'none', rep.gateA.detail);
  assert.equal(rep.gateA.snapshotDrift, 'none', '不许误报:脚本写的是一次性 exec 树,不是快照,磁盘也没变');
  assert.equal(rep.gateA.snapshotManifest.added, 0, `不许误报新增:${JSON.stringify(rep.gateA.snapshotManifest)}`);
  assert.equal(rep.gateA.snapshotManifest.changed, 0, '不许误报改写');
  assert.equal(hashFile(join(dir, 'extract-helpers.mjs')), helpersSha, '磁盘上的 helper 不该被动到');
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('r10(不 skip): 脚本真去改**磁盘上的 demo** → 收口 manifest 必须报出来(不许漏报)', () => {
  const { dir, truth } = writeDemo({ name: 'diskwrite', extractor: 'PLACEHOLDER' });
  // 用 --demo argv 定位磁盘 demo(接口约定的定位方式),往那里写 —— 这是真的偏离,必须被抓到
  writeFileSync(join(dir, 'extract.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import './extract-helpers.mjs';",
    'const argv = process.argv.slice(2);',
    "const demo = argv[argv.indexOf('--demo') + 1];",
    "writeFileSync(join(demo, 'index.html'), '<!doctype html><html><body>tampered</body></html>');",
    `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});`,
    '',
  ].join('\n'));
  const { res, rep } = verifyGateA(dir);
  assert.notEqual(rep.gateA.snapshotDrift, 'none', '磁盘被脚本改写必须报偏离');
  assert.ok(rep.gateA.snapshotManifest.changed >= 1,
    `index.html 的改写必须落进 manifest.changed:${JSON.stringify(rep.gateA.snapshotManifest)}`);
  assert.notEqual(res.status, 0, '偏离必须让 verify 非零退出');
});

// ============================================================================
// 连带必修:fixture 忠实化的源码契约
// ============================================================================

test('r10 源码契约(不 skip): init.mjs 模板与测试 fixture 的 helper import 形态一致', () => {
  const initSrc = readFileSync(INIT, 'utf8');
  assert.match(initSrc, HELPER_IMPORT_RE,
    'init.mjs 生成的 extract.mjs 模板必须仍 import ./extract-helpers.mjs —— 若官方模板改了形态,'
    + '请同步 _extractor-template.mjs 与本断言(fixture 必须忠实于真实产物)');
  assert.match(initSrc, /copyFileSync\(join\(SKILL_ROOT, 'scripts\/lib\/extract-helpers\.mjs'\)/,
    'init.mjs 必须仍把 helpers 拷进 demo(demo 自包含);否则 fixture 的忠实化前提不成立');
  assert.match(templateExtractor({}), HELPER_IMPORT_RE, 'fixture 生成器必须与官方模板同形');
});

test('r10 源码契约(不 skip): 主链 fixture 一律经 templateExtractor 生成,不再手写自包含单行', () => {
  /* 覆盖:经典模式主链(qa-hifi-demo)、fixture 叶子路径(comp-fixtures)、
     组件模式(comp-gates / comp-metafile)。自包含形态仍有阳性对照(本文件里那条),
     但**默认** fixture 必须忠实于 init 产物 —— 否则同类缺陷还会漏。 */
  for (const f of ['qa-hifi-demo.test.mjs', 'comp-fixtures.test.mjs', 'comp-gates.test.mjs', 'comp-metafile.test.mjs']) {
    const src = readFileSync(join(ROOT, 'scripts/__tests__', f), 'utf8');
    assert.match(src, /_extractor-template\.mjs/, `${f} 必须用共享的 templateExtractor 生成 extract.mjs`);
    assert.match(src, /copyFileSync\([^)]*extract-helpers\.mjs'\), join\(dir, 'extract-helpers\.mjs'\)\)/,
      `${f} 必须把 extract-helpers.mjs 拷进 fixture demo(与 init 产物一致)`);
  }
});
