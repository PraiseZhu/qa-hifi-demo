// comp-fix-r8.test.mjs — 第八轮终审对抗回归。
//
// 条目 A(结构性,I-OBSERVE 的实质缺口):snapshot 的排除列表曾是**盲区**。
//   `SNAPSHOT_EXCLUDE` 排除了整个 `verify-artifacts/` 与 `pixel-artifacts/`,但没有任何东西
//   禁止 index.html 引用这两个目录里的 JS/CSS。于是 `<script src="verify-artifacts/x.js">`
//   在 canonical verify 服务的 snapshot 里 **404**、在最终交付的 demo 原地却**会生效** ——
//   被验证的页面 ≠ 交付的页面。而三条本该发现它的机制全都看不见:
//     · `snapshotDrift()` 只从 **snapshot 一侧**遍历 → 看不到被排除目录,也看不到运行期新增;
//     · `buildInputHashes()` 不覆盖这两个目录;
//     · 排除是**任意层级**按段名命中(`rel.some(...)`),`sub/report.json` 这类也被漏掉。
//   前后 hash 与 drift 全部自洽,观察对象与交付对象可以不同而无人发现。
//   修法(三条一起):① 豁免清单收窄到仅顶层、报告类只按具体文件名;② 页面**不得引用**豁免路径
//   ——静态扫 index.html + 运行期记录对豁免路径的请求;③ drift 改**双向**(新增/删除/改写)。
//   三处共用**同一份**清单(`isExemptRel`),不可能再各自漂移。
//
// 条目 B(文档与实现不一致):真实次序是「三项字节复算(针对磁盘)→ 建 snapshot」,
//   而 SKILL.md 写的是「snapshot → 三项复算」。本轮选择**改文档**(理由见 SKILL.md 时序节与
//   交付说明):三项复算的命题是「磁盘产物 == 可信侧现算」,磁盘就是它的锚;改成比 snapshot
//   反而要额外证明 snapshot ≡ 磁盘,把强命题换成绕一层的弱命题。两者之间没有 demo 代码执行
//   窗口,所以顺序对安全性无影响 —— 但文档必须与实现一致,并由下面的源码契约锁死真实次序。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, safeJsonForScript } from '../lib/fs-utils.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const SERVER = join(ROOT, 'scripts/lib/safe-server.mjs');
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;
const env = () => (MODULE_ROOT ? { QA_HIFI_MODULE_ROOT: MODULE_ROOT } : {});
const NEEDS_BROWSER = '需要真 playwright(产品仓 node_modules)——浏览器门不跑就测不到 snapshot/运行期请求';

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT, encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) }, timeout: opts.timeout ?? 300000,
  });
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* 最小非组件 demo(不需要 esbuild/tailwind):门 A 静态段与快照机制都不依赖组件模式,
   用最小 fixture 才能让「引用豁免路径」这条回归在**任何环境**都真跑、不 skip。
   契约与其它 fixture 一致:__qa 五要素 + goto(unknown) 必抛 + 内嵌 qa-truth ≡ truth.json。 */
function writeDemo({ name, head = '', body = '', customGates = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `qa-r8-${name}-`));
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
  const truth = { colors: { text: { value: '#ff0000', provenance: { source: 'source.txt', locator: 'fixture', hash: hashFile(source) } } } };
  const spec = {
    meta: { name, summary: { what: 'what', how: 'how', accept: 'accept' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: {
      cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [{ expect: 'id' }] }],
      noClip: ['.box'],
    },
    bindings: [{ sel: '.box', prop: 'color', truth: 'colors.text', kind: 'color' }],
    ...(customGates ? { customGates } : {}),
  };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><style>
    .box{color:#ff0000}
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

// ============================================================================
// 条目 A — 豁免清单不再是盲区
// ============================================================================

test('条目 A 源码契约(不 skip): 豁免清单只有一份,snapshot/drift/页面可达性三处共用;drift 双向', () => {
  const v = stripComments(readFileSync(VERIFY, 'utf8'));
  // ① 唯一真相源:清单只声明一次,三处都走 isExemptRel
  assert.equal((v.match(/const EXEMPT_TOP_FILES =/g) ?? []).length, 1, '豁免文件清单必须只声明一处');
  assert.equal((v.match(/const EXEMPT_TOP_DIRS =/g) ?? []).length, 1, '豁免目录清单必须只声明一处');
  assert.ok(!/SNAPSHOT_EXCLUDE/.test(v), '不许再留一份独立的 snapshot 排除表(它就是盲区的来源)');
  const iFilter = v.indexOf('filter: (src)');
  const iSnapUse = v.indexOf('isExemptRel', iFilter);
  assert.ok(iFilter > 0 && iSnapUse > iFilter, 'snapshot 排除必须走 isExemptRel');
  // ② 只认顶层:嵌套同名必须进 snapshot(旧代码 rel.some(...) 是任意层级命中)
  assert.ok(!/rel\.some\(\(seg\) => \w+\.has\(seg\)\)/.test(v), '豁免不得再按任意层级段名命中');
  assert.match(v, /segs\.length === 1/, 'isExemptRel 必须区分顶层文件与顶层目录');
  // ③ drift 双向:两个方向都要遍历
  const iDriftFn = v.indexOf('function snapshotDrift');
  const drift = v.slice(iDriftFn, v.indexOf('\n}', iDriftFn));
  assert.match(drift, /listFilesRel\(snapshotDir\)/, 'drift 必须遍历 snapshot 侧(删除/改写)');
  assert.match(drift, /listFilesRel\(demoDir\)/, 'drift 必须遍历磁盘侧(新增)——旧版单向遍历看不见新增');
  assert.match(drift, /验收期间新增/);
  assert.match(drift, /验收期间被删除/);
  assert.match(drift, /字节被改写/);
  // ④ 页面可达性:静态 + 运行期两层
  assert.match(v, /function exemptRefsInHtml/, '必须静态扫 index.html 对豁免路径的引用');
  assert.match(v, /exemptPathRefs/);
  assert.match(v, /exemptPathRequests/, '必须有运行期兜底(动态构造的 URL 静态扫不出来)');
  assert.match(v, /requestedPaths\(\)/);
  // safe-server 必须真的记录请求,且是只读拷贝
  const srv = stripComments(readFileSync(SERVER, 'utf8'));
  assert.match(srv, /requestedPaths: \(\) => requested\.slice\(\)/, 'safe-server 必须暴露请求记录(只读拷贝)');
  assert.match(srv, /requested\.push\(/);
});

test('条目 A 复现样本(不 skip,任何环境都真跑): index.html 引用 verify-artifacts/ → 门 A 红', () => {
  /* 审核人给的核心场景:被排除目录里的 JS 在 snapshot 里 404、在交付原地生效。
     只需门 A 静态段即可判定,所以本条不依赖浏览器,任何环境都必须真跑。 */
  const dir = writeDemo({ name: 'ref-exempt', head: '<script src="verify-artifacts/boot.js"></script>' });
  mkdirSync(join(dir, 'verify-artifacts'), { recursive: true });
  writeFileSync(join(dir, 'verify-artifacts/boot.js'), 'globalThis.__evil = 1;\n');
  const v = run(VERIFY, ['--demo', dir, '--gate', 'A'], { env: env() });
  assert.notEqual(v.status, 0, `引用被豁免目录里的脚本仍放行(条目 A 未修):${v.stdout}${v.stderr}`);
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.pass, false, '门 A 必须红');
  assert.deepEqual(rep.gateA.exemptPathRefs, ['verify-artifacts/boot.js']);
  assert.match(rep.gateA.detail, /观察豁免路径/);
  assert.match(rep.gateA.detail, /被验证的页面与交付的页面可以不同/);
});

test('条目 A(不 skip): pixel-artifacts / report*.json 的引用同样拦;普通目录不误杀', () => {
  for (const ref of ['pixel-artifacts/one.web.diff.png', 'report-pixel.json', 'node_modules/x/y.js']) {
    const dir = writeDemo({ name: 'ref-more', head: `<link rel="preload" href="${ref}">` });
    const v = run(VERIFY, ['--demo', dir, '--gate', 'A'], { env: env() });
    assert.notEqual(v.status, 0, `引用 ${ref} 仍放行`);
    assert.match(readJson(join(dir, 'report.json')).gateA.detail, /观察豁免路径/, `引用 ${ref} 的报文不对`);
  }
  // 阳性对照:同名但**嵌套**在子目录下 → 进 snapshot,不豁免、不拦(收紧不等于乱杀)
  const ok = writeDemo({ name: 'ref-nested', head: '<link rel="stylesheet" href="assets/verify-artifacts/x.css">' });
  mkdirSync(join(ok, 'assets/verify-artifacts'), { recursive: true });
  writeFileSync(join(ok, 'assets/verify-artifacts/x.css'), '.box{}\n');
  const v2 = run(VERIFY, ['--demo', ok, '--gate', 'A'], { env: env() });
  assert.equal(v2.status, 0, `嵌套同名目录被误杀:${v2.stdout}${v2.stderr}`);
  assert.equal(readJson(join(ok, 'report.json')).gateA.exemptPathRefs, 'none');
});

test('条目 A 阳性对照(不 skip): 正常 demo 的门 A 静态段照常绿', () => {
  const dir = writeDemo({ name: 'ref-clean' });
  const v = run(VERIFY, ['--demo', dir, '--gate', 'A'], { env: env() });
  assert.equal(v.status, 0, `正常 demo 被新检查误杀:${v.stdout}${v.stderr}`);
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.exemptPathRefs, 'none');
  assert.equal(rep.gateA.pass, true);
});

test('条目 A 双向 drift(实跑): 运行期往 demo 新增页面可达文件 → 必须被发现', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  /* 旧版 drift 只从 snapshot 一侧遍历,所以「验收期间新增一个文件」这一整类完全看不见:
     新增的文件不在 snapshot 里 → 遍历不到 → 零偏离。这里用自定义门模拟(它在分界线之后跑,
     正是能改 demo 的位置);新增的是页面可达的 assets/late.js,交付会带走它。 */
  const dir = writeDemo({
    name: 'drift-add',
    customGates: [{ id: 'adder', script: 'add-gate.mjs' }],
  });
  writeFileSync(join(dir, 'add-gate.mjs'), [
    "import { writeFileSync, mkdirSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const d = new URL('.', import.meta.url).pathname;",
    "mkdirSync(join(d, 'assets'), { recursive: true });",
    "writeFileSync(join(d, 'assets/late.js'), 'globalThis.__late = 1;\\n');",
    "process.stdout.write('added');\n",
  ].join('\n'));
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.ok(Array.isArray(rep.gateA.snapshotDrift), `新增文件未被 drift 发现:${JSON.stringify(rep.gateA.snapshotDrift)}`);
  assert.ok(
    rep.gateA.snapshotDrift.some((d) => /assets\/late\.js\(验收期间新增\)/.test(d)),
    `drift 里没有「新增」这一类:${JSON.stringify(rep.gateA.snapshotDrift)}`,
  );
  assert.equal(rep.gateA.pass, false, '磁盘已不是被观察的那份,门 A 必须红');
  assert.notEqual(v.status, 0);
  // 工具自己写的报告/取证产物不得被误判成「新增」
  assert.ok(
    !rep.gateA.snapshotDrift.some((d) => /^(report|report-pixel|report-assets)\.json|^verify-artifacts\//.test(d)),
    `工具自己的产物被当成偏离:${JSON.stringify(rep.gateA.snapshotDrift)}`,
  );
});

test('条目 A 运行期兜底(实跑): 动态构造的豁免路径请求 → 门 A 红(静态扫不出来的那一类)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  /* 静态扫描只看得见声明式引用与明文路径;`'pixel-' + 'artifacts/...'` 这种拼出来的 URL
     扫不出来。服务的是 snapshot,所以这次请求在服务端表现为一次对豁免路径的取用记录 ——
     运行期这一层就是为它准备的。 */
  const dir = writeDemo({
    name: 'runtime-req',
    body: "<script>fetch('pixel-'+'artifacts/late.png').catch(()=>{});</script>",
  });
  // 前提:这条不能被静态扫描抓到,否则测的还是静态那一层
  const staticOnly = run(VERIFY, ['--demo', dir, '--gate', 'A'], { env: env() });
  assert.equal(staticOnly.status, 0, `动态拼接被静态层抓到了,本条测不到运行期层:${staticOnly.stdout}`);
  const v = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.ok(
    Array.isArray(rep.gateA.exemptPathRequests)
      && rep.gateA.exemptPathRequests.some((r) => /pixel-artifacts\/late\.png/.test(r)),
    `运行期对豁免路径的请求未被记录:${JSON.stringify(rep.gateA.exemptPathRequests)}`,
  );
  assert.equal(rep.gateA.pass, false);
  assert.notEqual(v.status, 0);
});

// ============================================================================
// 条目 B — 文档与实现的真实次序
// ============================================================================

test('条目 B 源码契约(不 skip): 三项字节复算在 snapshot **之前**,snapshot 在浏览器门与分界线之前', () => {
  const v = readFileSync(VERIFY, 'utf8');
  const iNm = v.indexOf('checkDemoNoNodeModules(demoDir)');
  const iInputs = v.indexOf('recheckComponentInputs(demoDir)');
  const iOutputs = v.indexOf('recheckComponentOutputs(demoDir, spec.component)');
  const iCss = v.indexOf('recheckComponentCss(demoDir, spec.component)');
  const iSnap = v.indexOf('snapshotDir = makeObservationSnapshot()');
  const iServe = v.indexOf('createSafeStaticServer(snapshotDir)');
  const iBrowser = v.indexOf('launchChromium(demoDir');
  const iBoundary = v.indexOf('分界线:以下开始执行 demo 侧代码');
  const iDrift = v.indexOf('const drift = snapshotDrift()');
  for (const [l, i] of [['node_modules 前置门', iNm], ['inputs 复算', iInputs], ['outputs 复算', iOutputs],
    ['css 复算', iCss], ['快照建立', iSnap], ['从快照起服务', iServe], ['launchChromium', iBrowser],
    ['分界线', iBoundary], ['drift', iDrift]])
    assert.ok(i > 0, `verify.mjs 里找不到 ${l}——次序契约无法判定(重排时请同步更新本测试)`);
  assert.ok(iNm < iInputs, '前置门必须最先');
  // 这就是条目 B 里被文档写反的那一段:复算针对磁盘、先跑;snapshot 随后建立
  for (const [l, i] of [['inputs', iInputs], ['outputs', iOutputs], ['css', iCss]])
    assert.ok(i < iSnap, `${l} 复算必须排在 snapshot 建立之前(文档与实现须一致)`);
  assert.ok(iSnap < iServe && iServe < iBrowser, '快照必须先建立,再据此起服务与开浏览器');
  assert.ok(iBrowser < iBoundary, '浏览器观察必须早于执行 demo 代码');
  assert.ok(iBoundary < iDrift, 'drift 必须排在执行 demo 代码之后');
});

test('条目 B 文档契约(不 skip): SKILL.md 的时序与 I-OBSERVE 表述必须与实现一致', () => {
  const md = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  // I-OBSERVE 不得再声称「复算与观察都从同一 snapshot」
  const iObserveLine = md.split('\n').find((l) => l.includes('**I-OBSERVE**') && l.includes('|'));
  assert.ok(iObserveLine, 'SKILL.md 必须有 I-OBSERVE 不变式行');
  assert.match(iObserveLine, /复算锚定磁盘字节/, 'I-OBSERVE 必须写明复算锚定的是磁盘字节');
  assert.match(iObserveLine, /观察锚定.*snapshot/, 'I-OBSERVE 必须写明观察锚定 snapshot');
  assert.match(iObserveLine, /无 demo 代码执行窗口/, 'I-OBSERVE 必须写明两者之间没有执行窗口');
  assert.ok(
    !/同一不可变 snapshot\*\* 提供文件/.test(iObserveLine),
    'I-OBSERVE 不得再声称复算也从 snapshot 取文件(与实现相反)',
  );
  // 时序节:复算在建 snapshot 之前
  const iRecheck = md.indexOf('三项可信侧字节复算');
  const iSnapDoc = md.indexOf('建立 **demo 之外的不可变 snapshot**');
  assert.ok(iRecheck > 0 && iSnapDoc > 0, 'SKILL.md 时序节必须同时写明三项复算与 snapshot 建立');
  assert.ok(iRecheck < iSnapDoc, 'SKILL.md 的时序必须是「三项复算 → 建 snapshot」(与实现一致)');
  // 门级全表里的门 A 次序也要跟着改
  const gateARow = md.split('\n').find((l) => l.startsWith('| A 真值一致'));
  assert.ok(gateARow, '门级全表必须有门 A 行');
  assert.ok(
    gateARow.indexOf('--check-inputs') < gateARow.indexOf('immutable snapshot'),
    '门级全表的门 A 次序也必须是「三项复算 → snapshot」',
  );
  // 条目 A 的三条要在文档里落账
  assert.match(md, /豁免路径/, 'SKILL.md 必须写明观察豁免清单');
  assert.match(md, /双向/, 'SKILL.md 必须写明 drift 是双向比对');
});

test('条目 A/B 交叉(不 skip): 豁免清单在 SKILL.md 与实现里必须一致', () => {
  const v = readFileSync(VERIFY, 'utf8');
  const files = /const EXEMPT_TOP_FILES = \[([^\]]*)\]/.exec(v)?.[1] ?? '';
  const dirs = /const EXEMPT_TOP_DIRS = \[([^\]]*)\]/.exec(v)?.[1] ?? '';
  const names = [...files.matchAll(/'([^']+)'/g), ...dirs.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 6, `豁免清单解析失败:${names.join(',')}`);
  const md = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  for (const n of names) assert.ok(md.includes(n), `SKILL.md 未写明豁免项 ${n}——清单漂移无人知道`);
  void existsSync;
});
