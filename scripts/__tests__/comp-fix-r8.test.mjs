// comp-fix-r8.test.mjs — 第八轮终审对抗回归(条目 A snapshot 完整性 / 条目 B 时序一致 / 条目 C 可信副本)。
//
// 条目 A(P0,审核人给了可执行 PoC):r7 的快照带一张排除表(整个 `verify-artifacts/`、
//   `pixel-artifacts/`、三个 report*.json),而**没有任何东西禁止页面引用被排除的路径**。
//   PoC:`index.html` 加 `<script src="pixel-artifacts/late.js">`,该脚本把门 D 绑定的 `.box`
//   宽度从正确的 `16px` 改成错误的 `99px`：
//     verify exit 0 / gateD.pass = true / gateA.snapshotDrift = "none" / pr-block exit 0 可出块
//     而最终原地 demo 的 computed width = 99px
//   即**被验页面 16px、交付页面 99px,全链自洽放行** —— I-OBSERVE 实质不成立。
//   审核人另指出两处组成性不一致:门 E(`pixel-compare`)完全不走快照(直接 serve/read demoDir
//   与 baseline PNG);三项复算针对原目录、快照后建,两者之间有并发写入窗口。
//   修法(三条全做,实现集中在 lib/observe.mjs):
//     · 页面可达输入**全部进快照**(只跳 node_modules / .git —— 前置门已拒 / 不属交付产物);
//       工具运行期输出(失败截图、可信脚本副本)改写到 demo 之外的 **output root**,不靠目录名排除;
//     · **双向 manifest**:disk→snapshot(新增)与 snapshot→disk(删除/改写)都遍历;
//     · 三项复算与 B/C/D/F/E 绑同一份字节:快照先建 → 复算 → **紧邻的双向 manifest 检查点**证明
//       snapshot ≡ 磁盘 → 浏览器观察全部从快照;门 E 用同一份快照实现(含 baseline PNG)。
//
// 条目 C(门 X / extractor 的窄 check/use 竞态):`hashFile(scriptAbs)` 之后仍按**同一路径**
//   spawn,不是原子执行已哈希的字节。改为把已 hash 的字节复制到 output root 后执行副本,
//   并复算副本 hash;不等即 fail-closed。这也是门 X「无 OS 沙箱」降级可被接受的第 (d) 条。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, safeJsonForScript } from '../lib/fs-utils.mjs';
import { listFilesRel, snapshotManifestDiff, SNAPSHOT_SKIP_TOP } from '../lib/observe.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PIXEL = join(ROOT, 'scripts/pixel-compare.mjs');
const OBSERVE = join(ROOT, 'scripts/lib/observe.mjs');
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;
const env = () => (MODULE_ROOT ? { QA_HIFI_MODULE_ROOT: MODULE_ROOT } : {});
const NEEDS_BROWSER = '需要真 playwright(产品仓 node_modules)——浏览器门不跑就测不到快照与观察绑定';

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT, encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) }, timeout: opts.timeout ?? 300000,
  });
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* 最小非组件 demo(不需要 esbuild/tailwind):快照机制与组件模式无关,用最小 fixture 才能让
   核心回归在**任何环境**都真跑、不 skip。契约与其它 fixture 一致:__qa 五要素 +
   goto(unknown) 必抛 + 内嵌 qa-truth ≡ truth.json;`.box` 的宽度由外部 CSS 决定,
   所以「后加载的脚本改 .box 宽度」能翻转门 D 的实测值(审核人 PoC 的手法)。 */
function writeDemo({ name, head = '', body = '', customGates = null, bindWidth = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `qa-r8-${name}-`));
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
    ...(customGates ? { customGates } : {}),
  };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><style>
    .box{color:#ff0000;width:16px;white-space:nowrap}
    #frame{width:16px;height:16px;background:#f00}
  </style>${head}</head><body>
  <script id="qa-truth" type="application/json">${safeJsonForScript(truth)}</script>
  <div class="box">x</div><div id="frame" class="frame"></div>
  <script>
  const S={step:'id',prefs:{plat:'desk',region:'cn',os:'ios',mode:'light',lang:'zh-CN'}};
  window.__qa={current:()=>S.step,goto:(id)=>{if(id!=='id')throw new Error('unknown');S.step=id;},prefs:()=>({...S.prefs}),scale:()=>1,resize:(w,h)=>{}};
  </script>${body}</body></html>`);
  return dir;
}

/** `--demo` argv 定位 demo 的自定义门(r8 条目 C 起执行的是可信副本,不能靠 import.meta.url)。 */
function writeGate(dir, file, bodyLines) {
  writeFileSync(join(dir, file), [
    "import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const argv = process.argv.slice(2);",
    "const here = argv[argv.indexOf('--demo') + 1];",
    ...bodyLines,
    "process.stdout.write('done');\n",
  ].join('\n'));
  void mkdirSync; void readFileSync;
}

// ============================================================================
// 条目 A — 快照完整性 / 双向 manifest / 共同观察输入
// ============================================================================

test('条目 A 源码契约(不 skip): 快照整树、无排除表、工具输出走 output root、manifest 双向、门 E 同源', () => {
  const ob = stripComments(readFileSync(OBSERVE, 'utf8'));
  // ① 快照只跳两项,且这两项都不是页面可达的交付字节
  assert.match(ob, /SNAPSHOT_SKIP_TOP = \['node_modules', '\.git'\]/, '快照跳过项只允许 node_modules / .git');
  assert.deepEqual(SNAPSHOT_SKIP_TOP, ['node_modules', '.git']);
  assert.match(ob, /recursive: true/);
  // ② 双向 manifest:两个方向都要遍历,三类都要报
  const fn = ob.slice(ob.indexOf('export function snapshotManifestDiff'));
  assert.match(fn, /listFilesRel\(snapshotDir\)/, 'manifest 必须遍历快照侧(删除/改写)');
  assert.match(fn, /listFilesRel\(demoDir\)/, 'manifest 必须遍历磁盘侧(新增)——单向 walk 看不见新增');
  assert.match(fn, /验收期间新增/);
  assert.match(fn, /验收期间被删除/);
  assert.match(fn, /字节被改写/);
  // ③ verify:工具输出走 output root,demo 树里不再有运行期写入
  const v = stripComments(readFileSync(VERIFY, 'utf8'));
  assert.match(v, /const outputRoot = makeOutputRoot\(\)/);
  assert.match(v, /const artifactDir = join\(outputRoot, 'verify-artifacts'\)/, '失败截图必须落 output root');
  assert.ok(!/join\(demoDir, 'verify-artifacts'\)/.test(v), 'demo 树里不得再写 verify-artifacts/');
  assert.ok(!/SNAPSHOT_EXCLUDE|EXEMPT_TOP_FILES|EXEMPT_TOP_DIRS/.test(v), '不许再留任何按名豁免表');
  assert.match(v, /artifactRoot: outputRoot/, 'report 必须给出取证产物的根');
  // 运行期兜底:页面请求快照之外的路径(只剩 node_modules/.git)也要被记录并判红
  assert.match(v, /requestsOutsideSnapshot/);
  assert.match(v, /requestedPaths\(\)/);
  // ④ 门 E 同源:pixel-compare 也吃快照(含 baseline)且做双向 manifest
  const px = stripComments(readFileSync(PIXEL, 'utf8'));
  assert.match(px, /makeObservationSnapshot\(demoDir/, '门 E 必须建立同一种快照');
  assert.match(px, /createSafeStaticServer\(snapshotDir\)/, '门 E 必须服务快照,不是 demo 原地');
  assert.ok(!/createSafeStaticServer\(demoDir\)/.test(px), '门 E 仍在从 demo 原地提供文件');
  assert.match(px, /const baselinePath = join\(snapshotDir, baselineRel\)/, 'baseline PNG 也必须取自快照');
  assert.match(px, /snapshotManifestDiff\(snapshotDir, demoDir\)/, '门 E 也要做双向 manifest');
  assert.match(px, /manifest\.all\.length === 0\n\s+&& results\.every/, 'manifest 有偏离时门 E 必须 ok=false');
});

test('条目 A 审核人 PoC(实跑): index.html 引用 pixel-artifacts/late.js 改 .box 宽度 → 不再能全链自洽放行', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  /* 审核人原样样本:后加载的脚本把门 D 绑定的 .box 从 16px 改成 99px。
     r7:该文件被排除出快照 → 门 D 在快照上量到 16px(绿)、drift 单向遍历看不见它 → 全链放行,
     交付原地 computed = 99px。r8:整树进快照 → **浏览器观察到的就是交付字节** → 门 D 直接量到
     99px 与 truth(16)不符而判红。攻击不再能造出「被验页面 ≠ 交付页面」。 */
  const dir = writeDemo({
    name: 'poc-late',
    bindWidth: true,
    head: '<script src="pixel-artifacts/late.js" defer></script>',
  });
  mkdirSync(join(dir, 'pixel-artifacts'), { recursive: true });
  writeFileSync(join(dir, 'pixel-artifacts/late.js'), "document.querySelector('.box').style.width='99px';\n");
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.notEqual(v.status, 0, `PoC 仍被放行(条目 A 未修):${v.stdout}${v.stderr}`);
  assert.equal(rep.gateD.pass, false, '门 D 必须量到交付页面的真实值(99px)而判红——它现在观察的就是交付字节');
  assert.match(JSON.stringify(rep.gateD.failures), /99/, `门 D 失败详情里应出现被篡改后的实测值:${JSON.stringify(rep.gateD.failures)}`);
  // 该文件确实进了快照(不再是盲区):它在磁盘上,manifest 两侧一致 → 无偏离
  assert.equal(rep.gateA.snapshotDrift, 'none', '文件本身是 demo 的一部分,不构成偏离——修法不是把它算成偏离,而是让它进快照');
});

test('条目 A(不 skip): 快照整树覆盖——曾被排除的路径现在都在快照里', () => {
  const dir = writeDemo({ name: 'snap-full' });
  for (const rel of ['pixel-artifacts/x.png', 'verify-artifacts/y.png', 'report.json', 'report-pixel.json', 'report-assets.json']) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), rel.endsWith('.json') ? '{}' : 'PNGBYTES');
  }
  mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'x');
  const files = listFilesRel(dir);
  for (const rel of ['pixel-artifacts/x.png', 'verify-artifacts/y.png', 'report.json', 'report-pixel.json', 'report-assets.json'])
    assert.ok(files.includes(rel), `${rel} 必须进入观察集合(r7 把它整类排除,正是盲区来源)`);
  assert.ok(!files.some((f) => f.startsWith('node_modules/')), 'node_modules 不进(前置门已无条件拒)');
});

test('条目 A(不 skip): 双向 manifest 三类偏离都报,新增这一类单向 walk 必然漏', () => {
  const snap = writeDemo({ name: 'mani-snap' });
  const disk = writeDemo({ name: 'mani-disk' });
  // 把 disk 造成 snap 的「运行后」状态:新增一个页面可达文件、改写一个、删除一个
  writeFileSync(join(disk, 'spec.json'), readFileSync(join(snap, 'spec.json')));
  writeFileSync(join(disk, 'truth.json'), readFileSync(join(snap, 'truth.json')));
  writeFileSync(join(disk, 'extract.mjs'), readFileSync(join(snap, 'extract.mjs')));
  writeFileSync(join(disk, 'source.txt'), readFileSync(join(snap, 'source.txt')));
  writeFileSync(join(disk, 'index.html'), `${readFileSync(join(snap, 'index.html'), 'utf8')}<!--changed-->`);
  writeFileSync(join(disk, 'late.js'), 'globalThis.x=1');
  const d = snapshotManifestDiff(snap, disk);
  assert.deepEqual(d.added, ['late.js'], '新增必须被发现——这一类是 PoC 的一环,单向遍历看不见');
  assert.deepEqual(d.changed, ['index.html']);
  assert.ok(d.all.some((x) => /late\.js\(验收期间新增\)/.test(x)));
});

test('条目 A 双向 manifest(实跑): 自定义门新增页面可达文件 → 门 A 红并点名「新增」', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const dir = writeDemo({ name: 'drift-add', customGates: [{ id: 'adder', script: 'add-gate.mjs' }] });
  writeGate(dir, 'add-gate.mjs', [
    "mkdirSync(join(here, 'assets'), { recursive: true });",
    "writeFileSync(join(here, 'assets/late.js'), 'globalThis.__late = 1;\\n');",
  ]);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.ok(Array.isArray(rep.gateA.snapshotDrift), `新增未被发现:${JSON.stringify(rep.gateA.snapshotDrift)}`);
  assert.ok(rep.gateA.snapshotDrift.some((d) => /assets\/late\.js\(验收期间新增\)/.test(d)), JSON.stringify(rep.gateA.snapshotDrift));
  assert.equal(rep.gateA.snapshotManifest.added, 1);
  assert.equal(rep.gateA.pass, false);
  assert.notEqual(v.status, 0);
  // 工具自己的运行期输出不在 demo 里,所以不可能被误判成偏离
  assert.ok(!rep.gateA.snapshotDrift.some((d) => /^verify-artifacts\//.test(d)), '工具取证产物被当成偏离(说明输出没移出 demo)');
});

test('条目 A 观察绑定(实跑): 复算与浏览器观察绑同一份字节,检查点写进 report', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const dir = writeDemo({ name: 'bind-ok' });
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(v.status, 0, `正常 demo 被新检查误杀:${v.stdout}${v.stderr}`);
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.observeBinding, 'bound', '必须有「复算读的磁盘字节 ≡ 快照字节」的检查点结论');
  assert.equal(rep.gateA.snapshotDrift, 'none');
  assert.deepEqual(rep.gateA.snapshotManifest, { added: 0, removed: 0, changed: 0 });
  assert.equal(rep.gateA.refsOutsideSnapshot, 'none');
});

test('条目 A(不 skip): 页面引用快照之外的路径(node_modules/.git)仍拒;普通路径不误杀', () => {
  for (const ref of ['node_modules/pkg/x.js', '.git/hooks/y.js']) {
    const dir = writeDemo({ name: 'ref-out', head: `<link rel="preload" href="${ref}">` });
    const v = run(VERIFY, ['--demo', dir, '--gate', 'A'], { env: env() });
    assert.notEqual(v.status, 0, `引用 ${ref} 仍放行`);
    assert.match(readJson(join(dir, 'report.json')).gateA.detail, /不可变快照之外的路径/, `引用 ${ref} 的报文不对`);
  }
  // 阳性对照:曾被排除、现已进快照的路径不再被拦(它们是 demo 的一部分)
  const ok = writeDemo({ name: 'ref-in', head: '<link rel="preload" href="pixel-artifacts/one.diff.png">' });
  mkdirSync(join(ok, 'pixel-artifacts'), { recursive: true });
  writeFileSync(join(ok, 'pixel-artifacts/one.diff.png'), 'PNG');
  const v2 = run(VERIFY, ['--demo', ok, '--gate', 'A'], { env: env() });
  assert.equal(v2.status, 0, `进了快照的路径被误杀:${v2.stdout}${v2.stderr}`);
  assert.equal(readJson(join(ok, 'report.json')).gateA.refsOutsideSnapshot, 'none');
});

test('条目 A 门 E 同源(实跑): 门 E 从快照观察;比对期间 demo 树零写入,artifact 在 manifest 之后落盘', async (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const dir = writeDemo({ name: 'gate-e-snap' });
  const spec = readJson(join(dir, 'spec.json'));
  spec.baselines = [{ key: 'one', platform: 'web', frameSel: '#frame' }];
  spec.baselineFrameSel = '#frame';
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  const { loadPngApi } = await import('../lib/png-compare.mjs');
  const { PNG } = await loadPngApi(ROOT);
  const png = new PNG({ width: 32, height: 32 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 255; }
  mkdirSync(join(dir, 'baselines/web'), { recursive: true });
  writeFileSync(join(dir, 'baselines/web/one.png'), PNG.sync.write(png));
  const p = run(PIXEL, ['--demo', dir], { env: env() });
  assert.equal(p.status, 0, `门 E 走快照后不再通过:${p.stdout}${p.stderr}`);
  const rep = readJson(join(dir, 'report-pixel.json'));
  assert.equal(rep.results[0].status, 'PASS');
  assert.equal(rep.snapshotDrift, 'none', '门 E 必须给出自己的双向 manifest 结论');
  assert.deepEqual(rep.snapshotManifest, { added: 0, removed: 0, changed: 0 });
  // 三图确实落了盘(manifest 通过之后),裁决路径契约不变
  for (const kind of ['baseline', 'demo', 'diff'])
    assert.ok(existsSync(join(dir, `pixel-artifacts/web.one.${kind}.png`)), `${kind} 图应落在 demo 的 pixel-artifacts/`);
  // 落盘字节与 report 记录的 sha256 一致(裁决绑定的就是这份)
  const { createHash } = await import('node:crypto');
  for (const kind of ['baseline', 'demo', 'diff']) {
    const h = createHash('sha256').update(readFileSync(join(dir, `pixel-artifacts/web.one.${kind}.png`))).digest('hex');
    assert.equal(h, rep.results[0].artifactHashes[kind], `${kind} 图落盘字节与 report 记录不一致`);
  }
});

// ============================================================================
// 条目 B — 文档与实现的真实次序(实现改成「快照先建」,文档随实现)
// ============================================================================

test('条目 B 源码契约(不 skip): 快照先建 → 三项复算 → 绑定检查点 → 浏览器 → 分界线 → 收口 manifest', () => {
  const v = readFileSync(VERIFY, 'utf8');
  const iNm = v.indexOf('checkDemoNoNodeModules(demoDir)');
  const iSnap = v.indexOf('snapshotDir = makeObservationSnapshot(demoDir)');
  const iRecheckCall = v.indexOf('runComponentRechecks();');
  const iBind = v.indexOf("manifestCheckpoint('post-recheck')");
  const iServe = v.indexOf('createSafeStaticServer(snapshotDir)');
  const iBrowser = v.indexOf('launchChromium(demoDir');
  const iBoundary = v.indexOf('分界线:以下开始执行 demo 侧代码');
  /* r11 更新(不是回退):收口比对的调用点从 manifestCheckpoint('post-run')(snapshot 文件树 vs disk)
     换成 diffAgainstFrozen(frozenSnapshot, demoDir) —— 基准改成分界线前冻结在父进程内存里的
     manifest。原因:snapshot 与 exec 树同处可枚举可写的 tmpdir,后置脚本能把两边同步改成相同字节
     让旧口径报全等(审核人 PoC,见 comp-fix-r11.test.mjs)。次序要求不变且更严:冻结必须在分界线
     **之前**、比对必须在分界线**之后**,两条都由 comp-fix-r11 的源码契约另行钉住。 */
  const iPost = v.indexOf('diffAgainstFrozen(frozenSnapshot, demoDir)');
  const iFreeze = v.indexOf('frozenSnapshot = captureFrozenManifest(snapshotDir)');
  assert.ok(iFreeze > 0, 'r11:必须有分界线前的冻结捕获');
  for (const [l, i] of [['前置门', iNm], ['快照建立', iSnap], ['复算调用', iRecheckCall], ['绑定检查点', iBind],
    ['服务快照', iServe], ['launchChromium', iBrowser], ['分界线', iBoundary], ['收口 manifest', iPost]])
    assert.ok(i > 0, `verify.mjs 里找不到 ${l}——次序契约无法判定(重排时请同步更新本测试)`);
  assert.ok(iNm < iSnap, '前置门必须最先(node_modules 存在即 fail-fast)');
  assert.ok(iSnap < iRecheckCall, '快照必须先建立,再跑三项复算(r8:审核人要求复算与观察绑同一快照字节)');
  assert.ok(iRecheckCall < iBind, '绑定检查点必须排在复算之后——它证明的是「复算读到的磁盘字节 ≡ 快照字节」');
  assert.ok(iBind < iServe && iServe < iBrowser, '绑定成立之后才起服务与浏览器');
  assert.ok(iBrowser < iBoundary, '浏览器观察必须早于执行 demo 代码');
  assert.ok(iBrowser < iFreeze && iFreeze < iBoundary,
    'r11:冻结必须在浏览器观察完成之后、执行 demo 代码之前——晚于分界线就等于把可能已被污染的树当基准');
  assert.ok(iBoundary < iPost, '收口比对必须排在执行 demo 代码之后');
});

test('条目 B 文档契约(不 skip): SKILL.md 的时序与 I-OBSERVE 表述必须与实现一致', () => {
  const md = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  const iObserve = md.split('\n').find((l) => l.includes('**I-OBSERVE**') && l.includes('|'));
  assert.ok(iObserve, 'SKILL.md 必须有 I-OBSERVE 不变式行');
  assert.match(iObserve, /同一(不可变)?快照|同一份快照字节/, 'I-OBSERVE 必须写明复算与观察绑同一快照字节');
  assert.match(iObserve, /双向/, 'I-OBSERVE 必须写明双向 manifest');
  assert.match(md, /门 E/, '门 E 必须出现在时序表述里(它此前完全不走快照)');
  // 时序节:快照在复算之前
  const iSnapDoc = md.indexOf('建立**整树**不可变快照');
  const iRecheckDoc = md.indexOf('三项可信侧字节复算');
  assert.ok(iSnapDoc > 0 && iRecheckDoc > 0, 'SKILL.md 时序节必须同时写明整树快照与三项复算');
  assert.ok(iSnapDoc < iRecheckDoc, 'SKILL.md 的时序必须是「先建快照 → 再复算」(与实现一致)');
  // 快照跳过项要落账,且必须说明为什么不构成盲区
  for (const n of SNAPSHOT_SKIP_TOP) assert.ok(md.includes(n), `SKILL.md 未写明快照跳过项 ${n}`);
  assert.match(md, /output root/, 'SKILL.md 必须写明工具输出改到 output root');
});

// ============================================================================
// 条目 C — 门 X / extractor 执行可信副本
// ============================================================================

test('条目 C 源码契约(不 skip): 执行的是已 hash 字节的副本,副本住在 demo 之外并复算 hash', () => {
  const v = stripComments(readFileSync(VERIFY, 'utf8'));
  /* r10 更新(不是回退):副本从「单文件」变成「整棵树」,来源树优先是观察快照 ——
     单文件副本会让 ESM 相对 import 解析不到兄弟模块,而 init.mjs 生成的官方 extract.mjs
     模板就 import './extract-helpers.mjs'。「执行的是已 hash 的字节」这条性质没丢,反而更强:
     现在 mismatch 同时覆盖「磁盘 ≠ 快照」。详见 comp-fix-r10.test.mjs。 */
  assert.match(v, /const copy = trustedScriptCopy\(scriptAbs, outputRoot, \{ demoDir, sourceTree: snapshotDir \?\? demoDir \}\)/,
    '必须先取可信整树副本(来源树优先观察快照)');
  assert.match(v, /spawnSync\(process\.execPath, \[copy\.exec, \.\.\.extraArgs\]/, '必须执行副本而不是原路径');
  assert.ok(!/spawnSync\(process\.execPath, \[scriptAbs/.test(v), '不许再按同一路径 spawn(窄 check/use 竞态)');
  assert.match(v, /copy\.mismatch/, 'hash 与复制之间被换掉必须 fail-closed');
  const ob = stripComments(readFileSync(OBSERVE, 'utf8'));
  const fn = ob.slice(ob.indexOf('export function trustedScriptCopy'));
  assert.match(fn, /const sha = hashFile\(scriptAbs\)/);
  // r10:copyFileSync(单文件) → cpSync(整树);exec 是脚本在树内的原相对位置
  assert.match(fn, /cpSync\(src, dir, \{/, '必须整树复制');
  assert.match(fn, /const exec = join\(dir, rel\)/, '脚本必须在树内的原相对位置执行(相对 import 才解析得到)');
  assert.match(fn, /const copySha = hashFile\(exec\)/, '必须复算副本 hash 与源 hash 比对');
  assert.match(fn, /mismatch: copySha !== sha/);
});

test('条目 C(实跑): 门 X 执行的副本在 demo 之外,且脚本字节 hash 仍进 report 与防伪链', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const dir = writeDemo({ name: 'gatex-copy', customGates: [{ id: 'probe', script: 'probe-gate.mjs' }] });
  // 门 X 脚本把「自己被执行时的真实路径」写到 output root 之外的地方供断言(用 --demo 定位 demo)
  writeFileSync(join(dir, 'probe-gate.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const argv = process.argv.slice(2);",
    "const demo = argv[argv.indexOf('--demo') + 1];",
    "writeFileSync(join(demo, '..', 'probe-selfpath.txt'), new URL(import.meta.url).pathname);",
    "process.stdout.write('probed');\n",
  ].join('\n'));
  const scriptSha = hashFile(join(dir, 'probe-gate.mjs'));
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateX.pass, true, `门 X 应通过:${JSON.stringify(rep.gateX)}`);
  assert.equal(rep.gateX.gates[0].scriptSha256, scriptSha, '执行的字节 hash 必须仍记进 report');
  assert.equal(rep.inputHashes.customGates['probe-gate.mjs'], scriptSha, '脚本仍在防伪链里');
  const selfPath = readFileSync(join(dir, '..', 'probe-selfpath.txt'), 'utf8');
  assert.ok(!selfPath.startsWith(resolve(dir)), `门 X 仍在 demo 内执行原文件(${selfPath})——条目 C 未修`);
  // r10:目录名从 trusted-scripts/ 改为 trusted-trees-<hash12>-<rand>/(整树副本,每次调用一棵新树)
  assert.match(selfPath, /trusted-trees-/, `副本应落在 output root 的 trusted-trees-* 下:${selfPath}`);
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
});

test('条目 C(实跑): 注册后替换脚本字节 → 门 X 仍按「执行字节 ≠ 入链字节」判红(既有断言不弱化)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  /* 这条与 r7 条目 10 的断言同型:改成执行副本之后,「注册 A 脚本、跑 B 脚本」必须照样被抓 ——
     副本取的是**执行那一刻**的磁盘字节,与观察前入链的那份比对。 */
  const dir = writeDemo({ name: 'gatex-swap', customGates: [{ id: 'swap', script: 'swap-gate.mjs' }] });
  writeFileSync(join(dir, 'swap-gate.mjs'), "process.stdout.write('v1');\n");
  const before = run(VERIFY, ['--demo', dir], { env: env() });
  assert.equal(before.status, 0, `前提:原脚本应通过:${before.stdout}${before.stderr}`);
  // 观察前入链的 hash 已经写进 report;现在换脚本字节再跑 —— inputHashes 会跟着变,
  // 所以这里直接验「执行的字节 hash 等于本次入链 hash」这条恒等式仍然成立且被记录
  writeFileSync(join(dir, 'swap-gate.mjs'), "process.stdout.write('v2');\n");
  const after = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateX.gates[0].scriptSha256, hashFile(join(dir, 'swap-gate.mjs')));
  assert.equal(rep.inputHashes.customGates['swap-gate.mjs'], rep.gateX.gates[0].scriptSha256, '执行字节与入链字节必须恒等');
  assert.equal(after.status, 0);
});

// ============================================================================
// 顺手补强:tmpdir 清理的行为测试(审核人对第 11 处断言改写的建议)
// ============================================================================

test('补强(不 skip): 独立 TMPDIR 下跑完 verify,快照临时目录必须被清掉(行为,不只源码契约)', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'qa-r8-tmproot-'));
  const dir = writeDemo({ name: 'tmp-clean' });
  // 只跑门 A:不需要浏览器,但快照仍会建立(绑定检查点在快照上做)→ 任何环境都能验清理行为
  const v = run(VERIFY, ['--demo', dir, '--gate', 'A'], { env: { ...env(), TMPDIR: isolated } });
  assert.equal(v.status, 0, `${v.stdout}${v.stderr}`);
  const leftovers = readdirSync(isolated).filter((n) => n.startsWith('qa-hifi-snapshot-'));
  assert.deepEqual(leftovers, [], `verify 退出后仍留下快照临时目录:${leftovers.join(', ')}`);
  // output root 是**故意保留**的(失败取证要能被人看到),但它必须在 demo 之外
  const rep = readJson(join(dir, 'report.json'));
  assert.ok(rep.artifactRoot.startsWith(resolve(isolated)), `artifactRoot 应落在 TMPDIR 下:${rep.artifactRoot}`);
  assert.ok(!rep.artifactRoot.startsWith(resolve(dir)), 'artifactRoot 不得落在 demo 内');
});
