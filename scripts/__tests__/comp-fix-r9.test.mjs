// comp-fix-r9.test.mjs — 第九轮终审 P0:整树快照的 `dereference:true` 改变了 symlink 的
// **可达语义**,于是「可信侧观察到的页面」比「实际交付的页面」多了本该被拒的资源。
//
// 审核人 PoC(已实跑复现,方向与 r8 的 late.js 相反 —— 那次是「交付比观察多」,这次是「观察比交付多」):
//   ① demo 原始 `.box{width:99px}`,truth/binding 期望 16px;
//   ② demo 内 `linked.js` 是 **symlink,指向 demo/repo 之外**的 JS,该 JS 把 `.box` 改成 16px;
//   ③ `index.html` 引用 `linked.js`。
// 修前实测:
//   verify exit = 0 / gateD.pass = true / gateA.observeBinding = "bound" / gateA.snapshotDrift = "none"
//   原地 safe-server: linked.js = HTTP 403     原地最终 computed width = 99px
// 即**可信侧量到 16px 判绿放行,而实际交付页面是 99px**。
//
// 根因三处同时失效:
//   · observe.makeObservationSnapshot 的 `cpSync(..., dereference: true)` 把仓外目标的字节复制成
//     快照内的**普通文件** → snapshot server 返回 200;
//   · safe-server 原地服务时用 realpath 做根边界检查,仓外目标 → **403**;
//   · snapshotManifestDiff 只记相对路径 + **跟随 symlink 后**的文件 hash,没记 lstat 类型与
//     readlink target,所以「快照里的普通文件」与「磁盘上的 symlink」被判全等。
//
// 修法(三条):
//   ① **主修**:输入树发现任何 symlink 即 fail-closed,检查排在**建立快照之前**(前置门阶段,
//      与 checkDemoNoNodeModules 同阶段)。含 demo 内部指向 demo 内的 symlink 也拒 —— 内部
//      symlink 在 dereference 后同样变成普通文件、manifest 同样判不出差异,且部署侧对 symlink
//      行为不确定,原地/快照/部署三处语义仍不一致。
//   ② **双 server 一致性通用回归**:对每个页面可达资源,断言「原地 safe-server」与
//      「snapshot safe-server」的 status + bytes 都一致。这是「观察 == 交付」的直接验证,
//      不只针对 symlink —— 未来任何让两侧行为分叉的机制都会在这里翻车。
//   ③ **纵深**:manifest 用 lstat 记录并比较 { type, linkTarget },即使前置门被绕过也不再瞎。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDemoNoSymlinks, hashFile, safeJsonForScript } from '../lib/fs-utils.mjs';
import { findDemoSymlinks } from '../lib/repo-glob.mjs';
import {
  entryKind, listFilesRel, makeObservationSnapshot, snapshotManifestDiff,
} from '../lib/observe.mjs';
import { createSafeStaticServer } from '../lib/safe-server.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PIXEL = join(ROOT, 'scripts/pixel-compare.mjs');
const PRBLOCK = join(ROOT, 'scripts/pr-block.mjs');
const OBSERVE = join(ROOT, 'scripts/lib/observe.mjs');
const FSUTILS = join(ROOT, 'scripts/lib/fs-utils.mjs');
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;
const env = () => (MODULE_ROOT ? { QA_HIFI_MODULE_ROOT: MODULE_ROOT } : {});
const NEEDS_BROWSER = '需要真 playwright(产品仓 node_modules)——浏览器门不跑就走不到快照/观察绑定之后';

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT, encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) }, timeout: opts.timeout ?? 300000,
  });
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* 最小非组件 demo(不需要 esbuild/tailwind):symlink 语义与组件模式无关,用最小 fixture 才能让
   核心回归在**任何环境**都真跑、不 skip。契约同 r8 fixture:__qa 五要素 + goto(unknown) 必抛 +
   内嵌 qa-truth ≡ truth.json。`.box` 宽度由外部 CSS 决定,所以「后加载的脚本改 .box 宽度」
   能翻转门 D 的实测值(审核人 PoC 的手法)。
   `cssWidth` 让 PoC 能造出「磁盘上是错值(99)、被链接进来的脚本改成对值(16)」这个方向。 */
function writeDemo({ name, head = '', body = '', bindWidth = false, cssWidth = 16, extraFiles = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `qa-r9-${name}-`));
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
  const leaf = (value, locator) => ({ value, provenance: { source: 'source.txt', locator, hash: hashFile(source) } });
  const truth = {
    colors: { text: leaf('#ff0000', 'text color') },
    ...(bindWidth ? { geometry: { width: leaf(16, 'width constant') } } : {}),
  };
  const spec = {
    meta: { name, summary: { what: 'what', how: 'how', accept: 'accept' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: {
      cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [{ expect: 'id' }] }],
      noClip: ['.box'],
    },
    bindings: [
      { sel: '.box', prop: 'color', truth: 'colors.text', kind: 'color' },
      ...(bindWidth ? [{ sel: '.box', prop: 'width', truth: 'geometry.width', kind: 'length' }] : []),
    ],
  };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><style>
    .box{color:#ff0000;width:${cssWidth}px;white-space:nowrap}
    #frame{width:16px;height:16px;background:#f00}
  </style>${head}</head><body>
  <script id="qa-truth" type="application/json">${safeJsonForScript(truth)}</script>
  <div class="box">x</div><div id="frame" class="frame"></div>
  <script>
  const S={step:'id',prefs:{plat:'desk',region:'cn',os:'ios',mode:'light',lang:'zh-CN'}};
  window.__qa={current:()=>S.step,goto:(id)=>{if(id!=='id')throw new Error('unknown');S.step=id;},prefs:()=>({...S.prefs}),scale:()=>1,resize:(w,h)=>{}};
  </script>${body}</body></html>`);
  for (const [rel, content] of Object.entries(extraFiles)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** 审核人 PoC 原样:`linked.js` 是指向 demo 之外的 symlink,把 `.box` 从磁盘上的 99px 改成 16px。 */
function writePocDemo(name = 'poc-symlink') {
  const dir = writeDemo({
    name,
    bindWidth: true,
    cssWidth: 99,                                              // 磁盘/交付页面上的**错**值
    head: '<script src="linked.js" defer></script>',
  });
  const outside = mkdtempSync(join(tmpdir(), 'qa-r9-outside-'));
  writeFileSync(join(outside, 'evil.js'), "document.querySelector('.box').style.width='16px';\n");
  symlinkSync(join(outside, 'evil.js'), join(dir, 'linked.js'));  // 指向仓外
  return { dir, outside };
}

// ============================================================================
// ① 主修 — 输入树 symlink 一律 fail-closed,且发生在建快照之前
// ============================================================================

test('r9 P0 审核人 PoC(不 skip): 外链 symlink 在**前置检查处**就 fail-closed,不靠「量到 99px 判红」间接兜住', () => {
  const { dir } = writePocDemo();
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, `PoC 仍被放行(r9 P0 未修):${v.stdout}${v.stderr}`);
  const out = v.stdout + v.stderr;
  assert.match(out, /demo 输入树里检测到 symlink,拒绝/, `必须由 symlink 前置门拒收,而不是任何下游门:\n${out.slice(0, 1200)}`);
  // 点名:具体路径 + 链接目标 + 为什么拒(403 vs 200 的语义差)+ 修法
  assert.match(out, /linked\.js -> .*evil\.js/, '报错必须点名具体路径与链接目标');
  assert.match(out, /403/, '报错必须说明交付/原地侧 realpath 判 403');
  assert.match(out, /200/, '报错必须说明快照侧 dereference 后返回 200');
  assert.match(out, /复制成真实文件/, '报错必须给修法提示');
  /* 关键:拒收发生在**建立快照之前** —— 前置门阶段还没写过任何 report,更没启动浏览器。
     若靠下游门(门 D 量到 99px)拒,report.json 一定已经生成。 */
  assert.ok(!existsSync(join(dir, 'report.json')),
    'symlink 必须在前置门就被拒(建快照/启浏览器之前);report.json 存在说明检查排到了下游');
});

test('r9 P0(不 skip): demo **内部**指向 demo 内的 symlink 同样拒', () => {
  const dir = writeDemo({ name: 'inner-link', extraFiles: { 'real.js': 'globalThis.__real=1;\n' } });
  symlinkSync(join(dir, 'real.js'), join(dir, 'alias.js'));     // 目标就在 demo 内
  const problems = checkDemoNoSymlinks(dir);
  assert.equal(problems.length, 1, '内部 symlink 必须命中——dereference 后同样变成普通文件、manifest 同样判不出差异');
  assert.match(problems[0], /alias\.js -> /);
  assert.match(problems[0], /指向 demo 内部的 symlink 同样拒/, '报错要说清为什么内部链接也不放行');
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.notEqual(v.status, 0, '内部 symlink 也必须让 verify fail-closed');
  assert.match(v.stdout + v.stderr, /检测到 symlink/);
});

test('r9 P0(不 skip): 嵌套目录里的 symlink 也命中,.git 跳过,node_modules 不重复点名', () => {
  const dir = writeDemo({ name: 'nested-link', extraFiles: { 'assets/real.css': '.x{}\n' } });
  mkdirSync(join(dir, 'assets/deep'), { recursive: true });
  symlinkSync(join(dir, 'assets/real.css'), join(dir, 'assets/deep/alias.css'));
  // .git 里的 symlink 不该被算(不属交付产物,部署侧同样排除)
  mkdirSync(join(dir, '.git'), { recursive: true });
  symlinkSync(join(dir, 'assets/real.css'), join(dir, '.git/hook-link'));
  const hits = findDemoSymlinks(dir);
  assert.deepEqual(hits.map((h) => h.path), ['assets/deep/alias.css'],
    `只应命中嵌套的那条;.git 下的不算:${JSON.stringify(hits)}`);
  // node_modules(含 symlink 形态)归 checkDemoNoNodeModules,本门不重复点名
  symlinkSync(join(dir, 'assets'), join(dir, 'node_modules'));
  assert.deepEqual(findDemoSymlinks(dir).map((h) => h.path), ['assets/deep/alias.css'],
    'node_modules 这条由 checkDemoNoNodeModules 无条件拒,symlink 门不重复报');
});

test('r9 P0(不 skip): 悬空 symlink 也拒(readlink 拿得到目标,exists 为 false 不构成豁免)', () => {
  const dir = writeDemo({ name: 'dangling' });
  symlinkSync(join(dir, 'nope-does-not-exist.js'), join(dir, 'dangling.js'));
  const problems = checkDemoNoSymlinks(dir);
  assert.equal(problems.length, 1, '悬空链接同样是 symlink——快照 dereference 会直接抛,原地 404,两侧仍不一致');
  assert.match(problems[0], /dangling\.js -> /);
});

test('r9 P0(不 skip): pr-block / pixel-compare 与 verify 同一道门,且都排在读取 demo 输入之前', () => {
  const { dir } = writePocDemo('poc-prblock');
  // pr-block:连 report.json 都还没读就该拒(正常缺 report.json 会报另一句)
  const pb = run(PRBLOCK, ['--demo', dir], { env: env() });
  assert.notEqual(pb.status, 0);
  assert.match(pb.stdout + pb.stderr, /检测到 symlink/, 'pr-block 必须在读 report.json 之前先拒 symlink');
  // pixel-compare:必须在 makeObservationSnapshot 之前拒
  const px = run(PIXEL, ['--demo', dir, '--report-out', join(dir, '..', 'r9-px.json')], { env: env() });
  assert.notEqual(px.status, 0);
  assert.match(px.stdout + px.stderr, /检测到 symlink/, '门 E 也必须在建快照之前拒 symlink');
});

test('r9 P0 源码契约(不 skip): 前置门位置 + 快照自身不变式', () => {
  const fu = stripComments(readFileSync(FSUTILS, 'utf8'));
  assert.match(fu, /export function checkDemoNoSymlinks/);
  const v = stripComments(readFileSync(VERIFY, 'utf8'));
  // 前置门必须排在建立快照之前
  const iSym = v.indexOf('checkDemoNoSymlinks(demoDir)');
  const iSnap = v.indexOf('makeObservationSnapshot(demoDir)');
  assert.ok(iSym > 0 && iSnap > 0, 'verify 里两处都应存在');
  assert.ok(iSym < iSnap, 'symlink 前置门必须排在 makeObservationSnapshot 之前——快照一建起来就已经 dereference 过了');
  // 与 node_modules 门同阶段(相邻的前置门块)
  assert.ok(v.indexOf('checkDemoNoNodeModules(demoDir)') < iSym, 'symlink 门应紧随 node_modules 门,同属前置门阶段');
  const px = stripComments(readFileSync(PIXEL, 'utf8'));
  assert.ok(px.indexOf('checkDemoNoSymlinks(demoDir)') < px.indexOf('makeObservationSnapshot(demoDir'),
    '门 E 的 symlink 前置门也必须排在建快照之前');
  // 快照自身的不变式:任何调用方都拿不到 dereference 过的快照
  const ob = stripComments(readFileSync(OBSERVE, 'utf8'));
  const fn = ob.slice(ob.indexOf('export function makeObservationSnapshot'), ob.indexOf('export function makeOutputRoot'));
  assert.match(fn, /findDemoSymlinks/, 'makeObservationSnapshot 自身必须再拦一次(纵深)');
  assert.ok(fn.indexOf('findDemoSymlinks') < fn.indexOf('cpSync'), '拦截必须发生在 cpSync 之前');
});

test('r9 P0(不 skip): makeObservationSnapshot 对含 symlink 的树直接抛,不产出快照', () => {
  const { dir } = writePocDemo('snap-guard');
  assert.throws(() => makeObservationSnapshot(dir), /symlink/, '含 symlink 的树不许产出观察快照');
});

// ============================================================================
// ② 双 server 一致性通用回归 — 「观察 == 交付」的直接验证(不限 symlink)
// ============================================================================

/**
 * 页面可达资源的**超集**:磁盘上的全部条目 ∪ index.html 里声明引用的路径 ∪ 目录索引入口。
 * 取超集而不是「浏览器实际请求过的路径」是刻意的:后者需要真 playwright(会 skip),
 * 且只覆盖本次渲染碰到的资源;超集在任何环境都能跑,且能提前发现「某条路径两侧行为不同」。
 */
function reachableCandidates(demoDir) {
  const set = new Set(['/', '/index.html']);
  for (const rel of listFilesRel(demoDir)) set.add(`/${rel}`);
  const html = existsSync(join(demoDir, 'index.html')) ? readFileSync(join(demoDir, 'index.html'), 'utf8') : '';
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const raw = m[1];
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(raw)) continue;       // 外链/锚点/data: 不由本 server 提供
    set.add(raw.startsWith('/') ? raw : `/${raw}`);
  }
  return [...set].sort();
}

/**
 * 通用回归核心:同一个 demo,分别用**原地** server(交付对象)与**快照** server(观察对象)服务,
 * 对每个候选路径断言 status 与 bytes 都一致。任何让两侧行为分叉的机制(symlink 是其中一种)
 * 都会在这里翻车。
 * @returns {Array<{path,inPlace,snapshot}>} 不一致项(空数组 = 通过)
 */
async function dualServerDivergence(demoDir, snapshotDir) {
  const a = createSafeStaticServer(demoDir);
  const b = createSafeStaticServer(snapshotDir);
  const baseA = await a.listen();
  const baseB = await b.listen();
  const bad = [];
  try {
    for (const p of reachableCandidates(demoDir)) {
      const [ra, rb] = await Promise.all([fetch(baseA.replace(/\/$/, '') + p), fetch(baseB.replace(/\/$/, '') + p)]);
      const [ba, bb] = await Promise.all([ra.arrayBuffer(), rb.arrayBuffer()]);
      const ha = Buffer.from(ba).toString('hex');
      const hb = Buffer.from(bb).toString('hex');
      if (ra.status !== rb.status || ha !== hb) {
        bad.push({
          path: p,
          inPlace: { status: ra.status, bytes: ba.byteLength },
          snapshot: { status: rb.status, bytes: bb.byteLength },
        });
      }
    }
  } finally {
    await a.close();
    await b.close();
  }
  return bad;
}

test('r9 条目②(不 skip): 双 server 一致性通用回归——正常 demo 每个可达资源 status+bytes 都一致', async () => {
  /* 通用性:多种 fixture 形状(纯页面 / 带子目录资源 / 带上一轮遗留 artifact),都必须两侧全等。
     这条既是回归也是阳性对照 —— 修法不许把正常 demo 弄坏。 */
  const shapes = [
    writeDemo({ name: 'dual-plain' }),
    writeDemo({
      name: 'dual-assets',
      head: '<link rel="stylesheet" href="assets/x.css"><script src="assets/x.js" defer></script>',
      extraFiles: { 'assets/x.css': '.box{opacity:1}\n', 'assets/x.js': 'globalThis.__x=1;\n' },
    }),
    writeDemo({
      name: 'dual-artifacts',
      extraFiles: { 'pixel-artifacts/a.png': 'PNGBYTES', 'report.json': '{}', 'baselines/k.png': 'PNGBYTES2' },
    }),
  ];
  for (const dir of shapes) {
    const snap = makeObservationSnapshot(dir, { prefix: 'qa-r9-dual-' });
    const bad = await dualServerDivergence(dir, snap);
    assert.deepEqual(bad, [], `原地 server 与快照 server 出现分叉(观察对象 ≠ 交付对象):${JSON.stringify(bad, null, 2)}`);
    // 顺带确认这个通用回归不是空转:候选集里真的有资源被 200 提供
    assert.ok(reachableCandidates(dir).length >= 5, '候选集太小,回归会退化成空转');
  }
});

test('r9 条目②(不 skip): 通用回归对 PoC 形状真的会翻车——证明它不是空转', async () => {
  /* 用**绕过前置门**的方式直接建一份 dereference 快照(模拟「将来某条路径逃过了检查」),
     验证双 server 回归本身能独立抓住这类分叉:linked.js 在快照侧 200、原地侧 403。
     这一条正是「不止 symlink」的价值所在 —— 它检的是行为分叉本身,不是某个具体机制。 */
  const { dir } = writePocDemo('dual-poc');
  const { cpSync, mkdtempSync: mkdt } = await import('node:fs');
  const snap = mkdt(join(tmpdir(), 'qa-r9-deref-'));
  /* 必须**带 filter** 才能复刻修前的 makeObservationSnapshot:实测 Node v24.13 的 cpSync
     只在同时传了 filter 时才真按 dereference:true 跟随 symlink,不传 filter 时原样保留链接。
     修前的 makeObservationSnapshot 正好传了 filter —— 所以 P0 成立;这里照样传。 */
  cpSync(dir, snap, { recursive: true, dereference: true, filter: () => true });
  const bad = await dualServerDivergence(dir, snap);
  const hit = bad.find((b) => b.path === '/linked.js');
  assert.ok(hit, `通用回归必须抓住 linked.js 的两侧分叉,实际不一致项:${JSON.stringify(bad)}`);
  assert.equal(hit.inPlace.status, 403, '原地(交付)侧对仓外链接判 403');
  assert.equal(hit.snapshot.status, 200, 'dereference 后的快照(观察)侧返回 200 —— 这就是 P0 的形状');
});

// ============================================================================
// ③ 纵深 — manifest 记录并比较 lstat 类型 + readlink target
// ============================================================================

test('r9 条目③(不 skip): entryKind 用 lstat 区分 file / symlink,并给出 linkTarget', () => {
  const dir = writeDemo({ name: 'kind', extraFiles: { 'real.js': 'x\n' } });
  symlinkSync(join(dir, 'real.js'), join(dir, 'alias.js'));
  const f = entryKind(dir, 'real.js');
  assert.equal(f.type, 'file');
  assert.equal(f.linkTarget, null);
  assert.ok(f.sha256, '普通文件要给 hash');
  const l = entryKind(dir, 'alias.js');
  assert.equal(l.type, 'symlink', 'lstat 之下 symlink 不许被当成普通文件(statSync 会跟随)');
  assert.match(l.linkTarget, /real\.js$/);
  assert.equal(l.sha256, null, 'symlink 不给 hash——按 hash 比对正是 r8 manifest 判「全等」的原因');
  assert.equal(entryKind(dir, 'nope.js').type, 'missing');
});

test('r9 条目③(不 skip): manifest 抓住「快照普通文件 vs 磁盘 symlink」——r8 的按 hash 比对判它全等', () => {
  // 磁盘侧:linked.js 是指向仓外的 symlink
  const { dir, outside } = writePocDemo('mani-retype');
  // 快照侧:模拟 dereference 后的形态 —— 同名路径是普通文件,字节等于链接目标
  const snap = writeDemo({ name: 'mani-snap', bindWidth: true, cssWidth: 99, head: '<script src="linked.js" defer></script>' });
  for (const f of ['spec.json', 'truth.json', 'extract.mjs', 'source.txt', 'index.html'])
    writeFileSync(join(snap, f), readFileSync(join(dir, f)));
  writeFileSync(join(snap, 'linked.js'), readFileSync(join(outside, 'evil.js')));   // 字节完全相同
  const d = snapshotManifestDiff(snap, dir);
  assert.deepEqual(d.added, [], '两棵树路径集合相同');
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, [], '字节相同 —— 这正是 r8 只比 hash 时报「全等」的原因');
  assert.equal(d.retyped.length, 1, '类型不一致必须被单独报出来(r8 完全看不见这一类)');
  assert.equal(d.retyped[0].path, 'linked.js');
  assert.equal(d.retyped[0].snapshot, 'file');
  assert.equal(d.retyped[0].disk, 'symlink');
  assert.match(d.retyped[0].diskTarget, /evil\.js$/, 'readlink target 必须记下来');
  assert.ok(d.all.some((x) => /linked\.js\(条目类型不一致/.test(x)), '合并列表里要人可读地点名');
});

test('r9 条目③(不 skip): listFilesRel 用 lstat——指向目录的 symlink 不被当目录走进去', () => {
  const dir = writeDemo({ name: 'walk-lstat', extraFiles: { 'assets/deep/a.js': 'a\n' } });
  symlinkSync(join(dir, 'assets'), join(dir, 'alias-dir'));
  const files = listFilesRel(dir);
  assert.ok(files.includes('alias-dir'), '指向目录的 symlink 本身应作为叶子条目收录');
  assert.ok(!files.some((f) => f.startsWith('alias-dir/')),
    'statSync 会跟随进去、把同一份字节按两条路径重复收录(还可能成环);lstat 之下不跟随');
  assert.ok(files.includes('assets/deep/a.js'), '真实目录仍要正常递归');
});

test('r9 条目③(不 skip): manifest 三类既有偏离不退化(added / removed / changed)', () => {
  const snap = writeDemo({ name: 'reg-snap' });
  const disk = writeDemo({ name: 'reg-disk' });
  for (const f of ['spec.json', 'truth.json', 'extract.mjs', 'source.txt'])
    writeFileSync(join(disk, f), readFileSync(join(snap, f)));
  writeFileSync(join(disk, 'index.html'), `${readFileSync(join(snap, 'index.html'), 'utf8')}<!--changed-->`);
  writeFileSync(join(disk, 'late.js'), 'globalThis.x=1');
  const d = snapshotManifestDiff(snap, disk);
  assert.deepEqual(d.added, ['late.js']);
  assert.deepEqual(d.changed, ['index.html']);
  assert.deepEqual(d.retyped, [], '正常两棵树不该报类型不一致');
});

// ============================================================================
// ⑤ 阳性对照 — 正常无 symlink 的 demo 不受影响
// ============================================================================

test('r9 阳性对照(不 skip): 正常 demo 的 symlink 门零命中,快照照常建立', () => {
  const dir = writeDemo({
    name: 'positive',
    head: '<link rel="stylesheet" href="assets/x.css">',
    extraFiles: { 'assets/x.css': '.box{opacity:1}\n', 'baselines/k.png': 'PNG', 'report.json': '{}' },
  });
  assert.deepEqual(checkDemoNoSymlinks(dir), [], '正常 demo 不许被误杀');
  const snap = makeObservationSnapshot(dir, { prefix: 'qa-r9-pos-' });
  assert.deepEqual(snapshotManifestDiff(snap, dir).all, [], '快照与磁盘应逐条全等');
});

test('r9 阳性对照(实跑): 正常 demo 仍能全绿通过 verify', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const dir = writeDemo({ name: 'positive-run', bindWidth: true });
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(v.status, 0, `正常 demo 被 r9 改动弄坏了:${v.stdout}${v.stderr}`);
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateD.pass, true);
  assert.equal(rep.gateA.snapshotDrift, 'none');
  assert.equal(rep.gateA.observeBinding, 'bound');
});
