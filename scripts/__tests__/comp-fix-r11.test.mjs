// comp-fix-r11.test.mjs — r11 P0:exec 树可反向定位并改写观察 snapshot,让收口 manifest 伪装全等。
//
// 缺陷(r10 整树可信副本的连带后果,不是实现 bug):
//   snapshot 在 `<tmp>/qa-hifi-snapshot-*`、exec 树在 `<tmp>/qa-hifi-out-* 下的 trusted-trees-*`,
//   **两者位于同一个用户可枚举、可写的 os.tmpdir() 命名空间**。custom gate 是任意 Node 代码,
//   从 `import.meta.url` 往上几层(或直接 `os.tmpdir()`)就能到 tmp 根,枚举
//   `qa-hifi-snapshot-*`、用 `spec.json` 的 `meta.name` 认出本次快照。随机后缀只防猜、不防
//   同权限枚举。于是审核人的结论成立:
//     **「manifest 证明的只是『两个当前可变对象现在相等』,不再证明『最终交付等于当时被观察的字节』」**
//
// 审核人 PoC(本文件第一条回归照抄):
//   ① 磁盘 index.html 是 `.box{width:99px}`(错),`late.js` 在页面加载时改成 16px(对),
//      truth/binding 期望 16px → 门 D 的**真实观察先正确通过**;
//   ② custom gate 从 exec 树枚举 tmp、定位本次 snapshot;
//   ③ gate 把 snapshot/late.js 与 disk/late.js **同步**改成「设为 99px」,exit 0;
//   ④ 两边同字节 → 收口 snapshotManifestDiff(snapshot, disk) 报全等;late.js 又不在
//      buildInputHashes 范围内 → postRunHashRecheck 也 ok。
//   修前实测(main HEAD=d3e17fc):verifyExit 0 / reportOk true / gateDPass true /
//   snapshotDrift "none" / postRunHashRecheck "ok" / gateXPass true,而
//   **finalComputedWidth = 99px** —— 浏览器看的是 16px,交付出去的是 99px。
//
// 修法(lead 拍板的方案 1+2:分界线前冻结的**内存** manifest):
//   进入 untrusted-script 分界线之前,父 verify 进程把 snapshot 整树的
//   `{path, type, linkTarget, sha256}` 全量捕获进 `Object.freeze` 的内存对象(不落盘);
//   后置脚本跑完之后,**最终磁盘只与这份内存 manifest 比较**,不再与 snapshot 文件树比较。
//   父进程内存不是 custom gate 可写的同权限文件对象 —— 「同步改 snapshot + disk」由此失效。
//   exec 树仍从 snapshot 复制(r10 修法保留),但它只是「让相对 import 能解析」的执行载体,
//   不再是收口 oracle。
//
// 为什么 r10 的 11 条回归没抓到:它们验的是「脚本写自己的 exec 树不会直接改 snapshot」,
// 没验「任意 Node 脚本能否枚举并写同用户 tmp 下的 sibling snapshot」。361/361 全绿也漏。
//
// 注意本文件的立场(lead 明确):**不假装能阻止枚举**(同权限枚举挡不住),而是让枚举变得无用 ——
// 所以下面有一条专门断言「脚本确实枚举到了 snapshot 并改写了它,而结论仍然正确」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, safeJsonForScript } from '../lib/fs-utils.mjs';
import {
  captureFrozenManifest, diffAgainstFrozen, makeObservationSnapshot,
} from '../lib/observe.mjs';
import { templateExtractor } from './_extractor-template.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const OBSERVE = join(ROOT, 'scripts/lib/observe.mjs');
const HELPERS = join(ROOT, 'scripts/lib/extract-helpers.mjs');
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;
const env = () => (MODULE_ROOT ? { QA_HIFI_MODULE_ROOT: MODULE_ROOT } : {});
const NEEDS_BROWSER = '需要真 playwright(产品仓 node_modules):PoC 必须让门 D 先在快照上真实通过,才谈得上「收口被伪装」';
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT, encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) }, timeout: opts.timeout ?? 300000,
  });
}

/**
 * 最小 demo。`cssWidth` 让 PoC 造出「磁盘上是错值(99)、late.js 运行期改成对值(16)」这个方向;
 * `bindWidth` 把 `.box` 的 width 绑上 truth(门 D 因此会真的去量它)。
 */
function writeDemo({
  name, cssWidth = 16, bindWidth = false, head = '', customGates = null, extraFiles = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), `qa-r11-${name}-`));
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
  const leaf = (v, l) => ({ value: v, provenance: { source: 'source.txt', locator: l, hash: hashFile(source) } });
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
  writeFileSync(join(dir, 'extract.mjs'), templateExtractor(truth));
  copyFileSync(HELPERS, join(dir, 'extract-helpers.mjs'));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><style>
    .box{color:#ff0000;width:${cssWidth}px;white-space:nowrap}
    #frame{width:16px;height:16px;background:#f00}
  </style>${head}</head><body>
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

/** 攻击 gate:枚举 tmp 找本次 snapshot(按 spec.json 的 meta.name 认),同步改 snapshot + disk。 */
function attackGateSrc(demoName) {
  return [
    "import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { tmpdir } from 'node:os';",
    'const argv = process.argv.slice(2);',
    "const demo = argv[argv.indexOf('--demo') + 1];",
    `const NAME = ${JSON.stringify(demoName)};`,
    // ② 枚举同权限 tmp 命名空间,按 spec.json 的 meta.name 认出本次 snapshot
    'const tmp = tmpdir();',
    'let snap = null;',
    "for (const n of readdirSync(tmp)) {",
    "  if (!n.startsWith('qa-hifi-snapshot-')) continue;",
    "  const spec = join(tmp, n, 'spec.json');",
    '  if (!existsSync(spec)) continue;',
    "  try { if (JSON.parse(readFileSync(spec, 'utf8')).meta?.name === NAME) { snap = join(tmp, n); break; } } catch {}",
    '}',
    // ③ 同步改 snapshot 与 disk 为**相同**的错误字节 → snapshot-vs-disk 比对报全等
    "const bad = \"document.querySelector('.box').style.width = '99px';\\n\";",
    'if (snap) writeFileSync(join(snap, \'late.js\'), bad);',
    "writeFileSync(join(demo, 'late.js'), bad);",
    // 把「有没有真枚举到 snapshot」写到 demo 之外,供回归断言 PoC 前提成立
    "writeFileSync(join(demo, '..', NAME + '-attack-found.txt'), snap ?? 'NOT-FOUND');",
    "process.stdout.write(snap ? 'snapshot-located' : 'snapshot-missing');",
    '',
  ].join('\n');
}

/** 起一个真浏览器量最终交付页面(磁盘原地)的 `.box` 计算宽度 —— PoC 的「交付 ≠ 观察」证据。 */
async function measureDeliveredWidth(demoDir) {
  const { launchChromium } = await import('../lib/resolve-playwright.mjs');
  const { createSafeStaticServer } = await import('../lib/safe-server.mjs');
  const srv = createSafeStaticServer(demoDir);
  const base = await srv.listen();
  const { browser } = await launchChromium(demoDir, { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(200);
    return await page.evaluate(() => getComputedStyle(document.querySelector('.box')).width);
  } finally {
    try { await browser.close(); } catch {}
    try { await srv.close(); } catch {}
  }
}

// ============================================================================
// P0 主回归:审核人 PoC —— 同步改 snapshot + disk 必须被冻结内存 manifest 抓到
// ============================================================================

test('r11 P0 PoC: custom gate 枚举 tmp 同步改写 snapshot 与 disk 为相同错字节 → 收口必须红', async (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const name = 'poc-snapshot-rewrite';
  const { dir } = writeDemo({
    name,
    bindWidth: true,
    cssWidth: 99,                                     // 磁盘/交付页面上的**错**值
    head: '<script src="late.js" defer></script>',
    customGates: [{ id: 'attack', script: 'attack-gate.mjs' }],
    // 观察期的 late.js 把 .box 改成**对**值 → 门 D 先真实通过
    extraFiles: { 'late.js': "document.querySelector('.box').style.width = '16px';\n" },
  });
  writeFileSync(join(dir, 'attack-gate.mjs'), attackGateSrc(name));
  const res = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));

  // PoC 前提必须真的成立,否则这条测试变成空转
  const found = readFileSync(join(dir, '..', `${name}-attack-found.txt`), 'utf8').trim();
  assert.notEqual(found, 'NOT-FOUND',
    'PoC 前提:攻击脚本必须真的枚举到本次 snapshot —— 没枚举到的话这条测的不是同一件事');
  assert.match(readFileSync(join(dir, 'late.js'), 'utf8'), /99px/, 'PoC 前提:磁盘 late.js 必须已被改成错值');
  assert.equal(rep.gateD.pass, true, `PoC 前提:门 D 必须先在快照上真实通过:${JSON.stringify(rep.gateD?.failures)}`);
  assert.equal(rep.gateX.pass, true, 'PoC 前提:攻击 gate 自身 exit 0');

  // 修前:snapshotDrift="none" / postRunHashRecheck="ok" / ok=true / exit 0(交付 99px 却全绿)
  assert.notEqual(rep.gateA.snapshotDrift, 'none',
    '收口必须报偏离:冻结内存 manifest 与最终磁盘不符(修前这里是 "none")');
  assert.equal(rep.ok, false, '整体结论必须为假');
  assert.notEqual(res.status, 0, `verify 必须非零退出(修前是 0):${res.stdout.slice(0, 400)}`);

  // 交付页面确实是错的 —— 证明「修前全绿」不是误报而是真漏
  const delivered = await measureDeliveredWidth(dir);
  assert.equal(delivered, '99px', `交付页面应为被攻击后的 99px,实测 ${delivered}`);
});

test('r11(不 skip): 枚举能力本身不阻止,但改写 snapshot 变得无用(冻结 manifest 是唯一 oracle)', () => {
  /* 关键区分(lead 明确):同权限枚举挡不住,所以我们**不假装**能阻止它 ——
     这条直接在单元层证明「改 snapshot 文件树 = 无用」:冻结 manifest 拿在手里之后,
     无论 snapshot 树被改成什么,diff 结论只由「冻结值 ⟷ 最终磁盘」决定。 */
  const { dir } = writeDemo({ name: 'freeze-oracle', extraFiles: { 'late.js': 'const a = 1;\n' } });
  const snap = makeObservationSnapshot(dir, { prefix: 'qa-r11-freeze-' });
  const frozen = captureFrozenManifest(snap);
  // 攻击:把 snapshot 与 disk 同步改成相同的新字节
  writeFileSync(join(snap, 'late.js'), 'const a = 999;\n');
  writeFileSync(join(dir, 'late.js'), 'const a = 999;\n');
  // 旧口径(snapshot 文件树 vs disk)会报全等 —— 这正是 PoC 的成因
  const naive = diffAgainstFrozen(captureFrozenManifest(snap), dir);
  assert.equal(naive.all.length, 0, '前提:同步改写之后,「当前 snapshot 树 ⟷ disk」确实全等(所以旧口径会瞎)');
  // 新口径:与分界线前冻结的那份比 → 必须报改写
  const real = diffAgainstFrozen(frozen, dir);
  assert.deepEqual(real.changed, ['late.js'], `冻结 manifest 必须抓到 late.js 被改:${JSON.stringify(real)}`);
});

test('r11(不 skip): 冻结 manifest 不可被改写(frozen,且不落盘)', () => {
  const { dir } = writeDemo({ name: 'frozen-immutable' });
  const snap = makeObservationSnapshot(dir, { prefix: 'qa-r11-imm-' });
  const frozen = captureFrozenManifest(snap);
  assert.equal(Object.isFrozen(frozen), true, '顶层必须 frozen');
  assert.equal(Object.isFrozen(frozen.entries), true, 'entries 必须 frozen');
  assert.equal(Object.isFrozen(frozen.entries['spec.json']), true, '每个条目必须 frozen');
  // 静默失败(非严格模式)或抛(严格模式)都可以,关键是值没变
  const before = frozen.entries['spec.json'].sha256;
  try { frozen.entries['spec.json'].sha256 = 'x'.repeat(64); } catch {}
  try { frozen.entries['injected.js'] = { type: 'file', sha256: 'y'.repeat(64), linkTarget: null }; } catch {}
  assert.equal(frozen.entries['spec.json'].sha256, before, '条目值不许被改');
  assert.equal(frozen.entries['injected.js'], undefined, '不许被塞新条目');
});

// ============================================================================
// lead 点的第 5 条:冻结 manifest 的范围必须是 snapshot **整树**,不是 buildInputHashes 的窄范围
// ============================================================================

test('r11(不 skip): 冻结范围是 snapshot 整树 —— 不在 buildInputHashes 范围内的文件也被覆盖', async () => {
  const { buildInputHashes } = await import('../lib/fs-utils.mjs');
  const { dir } = writeDemo({
    name: 'freeze-scope',
    extraFiles: { 'late.js': 'const a = 1;\n', 'assets/deep/thing.txt': 'x\n' },
  });
  const spec = readJson(join(dir, 'spec.json'));
  const narrow = buildInputHashes(dir, spec);
  assert.equal(narrow['late.js'], undefined, '前提:late.js 确实不在 buildInputHashes 范围内(PoC 就靠这点绕过 hash 复算)');
  const snap = makeObservationSnapshot(dir, { prefix: 'qa-r11-scope-' });
  const frozen = captureFrozenManifest(snap);
  for (const rel of ['late.js', 'assets/deep/thing.txt', 'extract-helpers.mjs', 'source.txt', 'index.html']) {
    assert.ok(frozen.entries[rel], `冻结 manifest 必须覆盖 ${rel}(整树,不是窄范围)`);
  }
});

test('r11(实跑): 改「不在 buildInputHashes 范围内」的文件 → postRunHashRecheck 仍 ok,但收口必须红', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const { dir } = writeDemo({
    name: 'outside-inputhashes',
    customGates: [{ id: 'touch', script: 'touch-gate.mjs' }],
    extraFiles: { 'late.js': 'const a = 1;\n' },
  });
  writeFileSync(join(dir, 'touch-gate.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const argv = process.argv.slice(2);',
    "const demo = argv[argv.indexOf('--demo') + 1];",
    "writeFileSync(join(demo, 'late.js'), 'const a = 2;\\n');",
    "process.stdout.write('touched');",
    '',
  ].join('\n'));
  const res = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.postRunHashRecheck, 'ok',
    '前提:窄范围 hash 复算看不见 late.js —— 所以这条只能靠冻结 manifest 抓');
  assert.notEqual(rep.gateA.snapshotDrift, 'none', '冻结 manifest 必须抓到 late.js 被改');
  assert.ok(rep.gateA.snapshotManifest.changed >= 1, JSON.stringify(rep.gateA.snapshotManifest));
  assert.notEqual(res.status, 0, res.stdout.slice(0, 300));
});

test('r11 纵深(实跑): 前一个 gate 改写快照 → 后一个 gate 的可信执行树被判不符,拒绝执行', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  /* exec 树逐次从快照复制,所以 gate1 污染快照会让 gate2 的**兄弟模块**带毒(入口脚本有 hash
     绑定,兄弟模块没有)。这不构成越权(同一个作者),但会让「exec 树兄弟模块 ≡ 观察态字节」
     变假。冻结 manifest 现在也用来逐条校刚复制出的树 —— 于是那句话恒真。 */
  const name = 'tree-drift';
  const { dir } = writeDemo({
    name,
    customGates: [
      { id: 'a-poison', script: 'a-poison.mjs' },
      { id: 'b-victim', script: 'b-victim.mjs' },
    ],
    extraFiles: { 'lib/shared.mjs': "export const v = 'clean';\n" },
  });
  writeFileSync(join(dir, 'a-poison.mjs'), [
    "import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { tmpdir } from 'node:os';",
    `const NAME = ${JSON.stringify(name)};`,
    'const tmp = tmpdir();',
    'for (const n of readdirSync(tmp)) {',
    "  if (!n.startsWith('qa-hifi-snapshot-')) continue;",
    "  const spec = join(tmp, n, 'spec.json');",
    '  if (!existsSync(spec)) continue;',
    "  try { if (JSON.parse(readFileSync(spec, 'utf8')).meta?.name === NAME) {",
    "    writeFileSync(join(tmp, n, 'lib/shared.mjs'), \"export const v = 'poisoned';\\n\"); break; } } catch {}",
    '}',
    "process.stdout.write('poisoned');",
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'b-victim.mjs'), [
    "import { v } from './lib/shared.mjs';",
    'process.stdout.write(v);',
    '',
  ].join('\n'));
  const res = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  const victim = rep.gateX.gates.find((g) => g.id === 'b-victim');
  assert.equal(victim.pass, false, `后一个 gate 必须被拒绝执行:${JSON.stringify(victim)}`);
  assert.match(String(victim.detail), /观察时冻结的 manifest 不一致|被改写过/,
    `失败原因必须点明快照被改写:${victim.detail}`);
  assert.notEqual(res.status, 0);
});

// ============================================================================
// 误报 / 漏报两侧对照(r10 已有的不许退化)
// ============================================================================

test('r11 误报侧(实跑): 诚实脚本写自己的 exec 树 → 结论仍 none、verify exit 0', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const { dir } = writeDemo({ name: 'honest-exectree', customGates: [{ id: 'honest', script: 'honest-gate.mjs' }] });
  writeFileSync(join(dir, 'honest-gate.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { dirname } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const here = dirname(fileURLToPath(import.meta.url));',
    "writeFileSync(here + '/scratch.txt', 'scratch');",
    "process.stdout.write('ok');",
    '',
  ].join('\n'));
  const res = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.snapshotDrift, 'none', `不许误报:${JSON.stringify(rep.gateA.snapshotDrift)}`);
  assert.equal(rep.gateA.snapshotManifest.added, 0, '写 exec 树不算 demo 侧新增');
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('r11 漏报侧(实跑): 脚本改磁盘 demo(不碰 snapshot)→ 仍必须红', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const { dir } = writeDemo({ name: 'diskonly', customGates: [{ id: 'disk', script: 'disk-gate.mjs' }] });
  writeFileSync(join(dir, 'disk-gate.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const argv = process.argv.slice(2);',
    "const demo = argv[argv.indexOf('--demo') + 1];",
    "writeFileSync(join(demo, 'index.html'), '<!doctype html><html><body>tampered</body></html>');",
    "process.stdout.write('ok');",
    '',
  ].join('\n'));
  const res = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.notEqual(rep.gateA.snapshotDrift, 'none');
  assert.ok(rep.gateA.snapshotManifest.changed >= 1);
  assert.notEqual(res.status, 0);
});

test('r11(不 skip): 新增 / 删除 / 类型变化三类偏离,冻结 manifest 都能分类报出', () => {
  const { dir } = writeDemo({ name: 'diff-classes', extraFiles: { 'gone.txt': 'g\n' } });
  const snap = makeObservationSnapshot(dir, { prefix: 'qa-r11-cls-' });
  const frozen = captureFrozenManifest(snap);
  writeFileSync(join(dir, 'brand-new.txt'), 'n\n');
  rmSync(join(dir, 'gone.txt'));
  const d = diffAgainstFrozen(frozen, dir);
  assert.deepEqual(d.added, ['brand-new.txt'], JSON.stringify(d));
  assert.deepEqual(d.removed, ['gone.txt'], JSON.stringify(d));
  assert.equal(d.changed.length, 0, JSON.stringify(d));
});

// ============================================================================
// 源码契约
// ============================================================================

test('r11 源码契约(不 skip): 收口只与分界线前冻结的内存 manifest 比,不再与 snapshot 文件树比', () => {
  /* 次序断言用**未去注释**的原文:分界线本身是一条注释,stripComments 会把它抹掉。 */
  const vRaw = readFileSync(VERIFY, 'utf8');
  const v = stripComments(vRaw);
  const iFreeze = vRaw.indexOf('frozenSnapshot = captureFrozenManifest(snapshotDir)');
  const iBoundary = vRaw.indexOf('分界线:以下开始执行 demo 侧代码');
  assert.ok(iFreeze > 0, '必须有 captureFrozenManifest(snapshotDir)');
  assert.ok(iBoundary > 0, '分界线注释必须还在');
  assert.ok(iFreeze < iBoundary,
    '冻结必须排在 untrusted 脚本分界线之前 —— 分界线之后冻结等于把被污染的树当基准');
  // 收口必须用 diffAgainstFrozen,且不许再出现 snapshot-vs-disk 的收口调用
  const iClose = vRaw.indexOf('diffAgainstFrozen(frozenSnapshot, demoDir)');
  assert.ok(iClose > iBoundary, '收口比对必须在分界线之后、且用冻结 manifest');
  assert.ok(!/manifestCheckpoint\('post-run'\)/.test(v),
    "收口不许再走 manifestCheckpoint('post-run')(那是 snapshot 文件树 vs disk,可被同步改写伪装全等)");
  const ob = stripComments(readFileSync(OBSERVE, 'utf8'));
  const fn = ob.slice(ob.indexOf('export function captureFrozenManifest'), ob.indexOf('export function diffAgainstFrozen'));
  assert.match(fn, /Object\.freeze/, '必须冻结');
  assert.match(fn, /listFilesRel\(root\)/, '范围必须是整树(不是 buildInputHashes 的窄范围)');
  assert.ok(!/writeFileSync|mkdirSync|mkdtempSync/.test(fn), '冻结 manifest 不许落盘(落盘就又变成可写的同权限文件对象)');
});

test('r11 源码契约(不 skip): SKILL.md 把 (d) 的绑定范围限定为「入口脚本字节」', () => {
  const md = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  assert.match(md, /入口脚本/, 'SKILL.md 必须显式限定 scriptSha256 只绑入口脚本字节');
  assert.ok(!/整棵(执行)?依赖树(都)?被 hash 绑定/.test(md),
    'scriptSha256 只绑入口脚本,不许把文案扩大成「整棵执行依赖树都被 hash 绑定」');
  assert.match(md, /冻结|frozen/i, 'SKILL.md 必须写明收口 oracle 是分界线前冻结的内存 manifest');
});
