// comp-fix-r12.test.mjs — r12 P0:以路径/名字为 key 的**普通对象**在遇到 `__proto__` 时两头失真。
//
// 缺陷(审核人在 f70ef26 抓到,r11 冻结 manifest 的实现细节):
//   `captureFrozenManifest` 里 `const entries = {}` 是普通对象,于是文件名为 `__proto__` 时
//   `entries['__proto__'] = record` **不会创建 own property** —— 它触发
//   `Object.prototype.__proto__` 的 setter。两头都瞎:
//     · 冻结基准侧:`Object.keys(entries)` 遍历不到这条路径 → removed/changed 都不会报;
//     · disk 侧:`rel in frozen.entries` 因原型链返回 true → 也不会进 added。
//   实测语义(lead 亲自复核):
//     普通对象         keys=[] / hasOwn=false / `'__proto__' in e === true`
//     Object.create(null) keys=["__proto__"] / hasOwn=true
//   `safe-server` 能服务 `/__proto__`,所以这不是理论边界。
//
// 审核人 asset-sha PoC(本文件第一条回归照抄):
//   `index.html` 里 `<img id="proto-img" src="__proto__">`,truth 用 `kind:'asset-sha'` 绑该文件
//   的初始字节 → 门 D 在快照上真实 fetch 并通过;custom gate 在分界线之后改磁盘的 `__proto__`。
//   修前(main f70ef26)实测:
//     verifyExit 0 / reportOk true / gateDPass true / snapshotDrift "none" /
//     snapshotManifest {added:0,removed:0,changed:0} / postRunHashRecheck "ok"
//     expectedObservedSha 550b8aec210b5ab0 ≠ finalAssetSha ffa74a3634916f29
//   修后同一 PoC:
//     verifyExit 2 / reportOk false / snapshotDrift ["__proto__(字节被改写)"] /
//     snapshotManifest {added:0,removed:0,changed:1}(sha 对照不变,交付确实被改)
//   注意 `postRunHashRecheck` 修前修后都是 "ok" —— `__proto__` 不在 buildInputHashes 范围内,
//   窄口径本来就看不见它。这条只能由冻结 manifest 抓,与 r11 的 late.js 同理。
//
// 修法:`Object.create(null)` + `Object.hasOwn`(禁止 `in`)。`Object.freeze` 对无原型对象照样
// 生效,r11 的三层 freeze 保留。全仓同形状映射的排查结果见本文件末尾那条「全表」测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputHashes, canonicalize, hashFile, safeJsonForScript, sameInputHashes, sha256Buffer } from '../lib/fs-utils.mjs';
import { truthAt, unwrapTruth } from '../lib/schema.mjs';
import { captureFrozenManifest, diffAgainstFrozen, makeObservationSnapshot } from '../lib/observe.mjs';
import { templateExtractor } from './_extractor-template.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const HELPERS = join(ROOT, 'scripts/lib/extract-helpers.mjs');
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;
const env = () => (MODULE_ROOT ? { QA_HIFI_MODULE_ROOT: MODULE_ROOT } : {});
const NEEDS_BROWSER = '需要真 playwright(产品仓 node_modules):PoC 必须让门 D 先在快照上真实 fetch 通过';
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
/** 原型链上的名字,全部当作「文件名」用来打这类映射。 */
const PROTO_NAMES = ['__proto__', 'constructor', 'toString'];

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT, encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) }, timeout: opts.timeout ?? 300000,
  });
}

/**
 * 最小 demo。`assetFiles` / `extraFiles` 收的是 **[rel, content] 数组对**,不是对象 ——
 * 对象字面量里的 `__proto__:` 会被解析器特判成「设原型」而非建 own property
 * (`{__proto__: x}` 的 hasOwn 是 false,`{['__proto__']: x}` 才是 true)。
 * 这正是本轮 P0 的同一形状,测试自身不能踩同一个坑。
 */
function writeDemo({ name, extraFiles = [], assetFiles = [], customGates = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `qa-r12-${name}-`));
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
  const leaf = (v, l) => ({ value: v, provenance: { source: 'source.txt', locator: l, hash: hashFile(source) } });
  const truth = { colors: { text: leaf('#ff0000', 'text color') } };
  const imgTags = [];
  const assetBindings = [];
  let i = 0;
  for (const [rel, content] of assetFiles) {
    const buf = Buffer.from(content);
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), buf);
    const id = `asset${i++}`;
    truth[id] = { sha: leaf(sha256Buffer(buf), `${rel} asset sha`) };
    imgTags.push(`<img id="${id}-img" src="${rel}" alt="">`);
    assetBindings.push({ sel: `#${id}-img`, prop: 'src', truth: `${id}.sha`, kind: 'asset-sha' });
  }
  const spec = {
    meta: { name, summary: { what: 'what', how: 'how', accept: 'accept' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: {
      cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [{ expect: 'id' }] }],
      noClip: ['.box'],
    },
    bindings: [{ sel: '.box', prop: 'color', truth: 'colors.text', kind: 'color' }, ...assetBindings],
    ...(customGates ? { customGates } : {}),
  };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
  writeFileSync(join(dir, 'extract.mjs'), templateExtractor(truth));
  copyFileSync(HELPERS, join(dir, 'extract-helpers.mjs'));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><style>
    .box{color:#ff0000;width:16px}#frame{width:16px;height:16px;background:#f00}
  </style></head><body>
  <script id="qa-truth" type="application/json">${safeJsonForScript(truth)}</script>
  <div class="box">x</div>${imgTags.join('')}<div id="frame" class="frame"></div>
  <script>const S={step:'id',prefs:{plat:'desk',region:'cn',os:'ios',mode:'light',lang:'zh-CN'}};
  window.__qa={current:()=>S.step,goto:(id)=>{if(id!=='id')throw new Error('unknown');S.step=id;},prefs:()=>({...S.prefs}),scale:()=>1,resize:()=>{}};</script>
  </body></html>`);
  for (const [rel, content] of extraFiles) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return { dir, truth };
}

/** 分界线之后改磁盘上指定文件的 gate 源码(用 --demo 定位磁盘 demo)。 */
function tamperGateSrc(rels, bytes = 'TAMPERED-delivered-bytes') {
  return [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const argv = process.argv.slice(2);',
    "const demo = argv[argv.indexOf('--demo') + 1];",
    `for (const rel of ${JSON.stringify(rels)}) writeFileSync(join(demo, rel), Buffer.from(${JSON.stringify(bytes)}));`,
    "process.stdout.write('tampered');",
    '',
  ].join('\n');
}

// ============================================================================
// P0 主回归:审核人的 asset-sha PoC
// ============================================================================

test('r12 P0 PoC(实跑): 页面可达资源名为 __proto__,分界线后被改 → 收口必须红', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const observed = 'GIF89a-observed-bytes-v1';
  const { dir } = writeDemo({
    name: 'poc-proto-asset',
    assetFiles: [['__proto__', observed]],
    customGates: [{ id: 'attack', script: 'attack-gate.mjs' }],
  });
  writeFileSync(join(dir, 'attack-gate.mjs'), tamperGateSrc(['__proto__']));
  const res = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));

  // PoC 前提:门 D 必须先在快照上真实读到观察态字节并通过,gate 自身 exit 0
  assert.equal(rep.gateD.pass, true, `PoC 前提:门 D 必须先真实通过:${JSON.stringify(rep.gateD?.failures)}`);
  assert.equal(rep.gateX.pass, true, 'PoC 前提:攻击 gate 自身 exit 0');
  assert.notEqual(sha256Buffer(readFileSync(join(dir, '__proto__'))), sha256Buffer(Buffer.from(observed)),
    'PoC 前提:交付字节确实已被改');
  // 窄口径照样瞎 —— 说明这条只能由冻结 manifest 抓(与 r11 的 late.js 同理)
  assert.equal(rep.gateA.postRunHashRecheck, 'ok', '前提:__proto__ 不在 buildInputHashes 范围内');

  // 修前:snapshotDrift "none" / manifest {0,0,0} / exit 0
  assert.notEqual(rep.gateA.snapshotDrift, 'none', '收口必须报偏离(修前是 "none")');
  assert.ok(String(JSON.stringify(rep.gateA.snapshotDrift)).includes('__proto__'),
    `偏离必须点名 __proto__:${JSON.stringify(rep.gateA.snapshotDrift)}`);
  assert.equal(rep.gateA.snapshotManifest.changed, 1, JSON.stringify(rep.gateA.snapshotManifest));
  assert.equal(rep.ok, false);
  assert.notEqual(res.status, 0, `verify 必须非零退出(修前是 0):${res.stdout.slice(0, 400)}`);
});

test('r12(实跑): __proto__ / constructor / toString 三个名字作为页面可达 asset 时,改写必须让 verify 非零', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const assetFiles = PROTO_NAMES.map((n) => [n, `bytes-for-${n}-v1`]);
  const { dir } = writeDemo({
    name: 'proto-assets-all',
    assetFiles,
    customGates: [{ id: 'attack', script: 'attack-gate.mjs' }],
  });
  writeFileSync(join(dir, 'attack-gate.mjs'), tamperGateSrc(PROTO_NAMES));
  const res = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateD.pass, true, `前提:三个 asset 的门 D 都要先真实通过:${JSON.stringify(rep.gateD?.failures)}`);
  assert.equal(rep.gateA.snapshotManifest.changed, PROTO_NAMES.length,
    `三个名字都必须被判 changed:${JSON.stringify(rep.gateA.snapshotDrift)}`);
  for (const n of PROTO_NAMES)
    assert.ok(JSON.stringify(rep.gateA.snapshotDrift).includes(n), `偏离列表必须点名 ${n}`);
  assert.notEqual(res.status, 0);
});

// ============================================================================
// 单元层:冻结 manifest 的 own-property 语义
// ============================================================================

test('r12(不 skip): 三个原型链名字在冻结 manifest 里都必须是 own entry,改写后报 changed', () => {
  const extraFiles = PROTO_NAMES.map((n) => [n, `v1-${n}`]);
  const { dir } = writeDemo({ name: 'frozen-own', extraFiles });
  const snap = makeObservationSnapshot(dir, { prefix: 'qa-r12-own-' });
  const frozen = captureFrozenManifest(snap);
  for (const n of PROTO_NAMES) {
    assert.equal(Object.hasOwn(frozen.entries, n), true,
      `${n} 必须是 own property —— 普通对象下 entries['__proto__'] 会触发原型 setter 而不建 own key`);
    assert.equal(typeof frozen.entries[n].sha256, 'string', `${n} 必须记到 sha256`);
  }
  // 逐个改写 → 必须逐个被判 changed
  for (const n of PROTO_NAMES) writeFileSync(join(dir, n), `v2-${n}`);
  const d = diffAgainstFrozen(frozen, dir);
  assert.deepEqual(d.changed.slice().sort(), PROTO_NAMES.slice().sort(), JSON.stringify(d));
  assert.deepEqual(d.added, [], '不许误报新增');
  assert.deepEqual(d.removed, [], '不许误报删除');
});

test('r12(不 skip): 原型链名字的**新增**必须进 added(禁止用 `in` 做 membership)', () => {
  const { dir } = writeDemo({ name: 'frozen-added' });
  const snap = makeObservationSnapshot(dir, { prefix: 'qa-r12-add-' });
  const frozen = captureFrozenManifest(snap);
  for (const n of PROTO_NAMES) writeFileSync(join(dir, n), 'late-add');
  const d = diffAgainstFrozen(frozen, dir);
  assert.deepEqual(d.added.slice().sort(), PROTO_NAMES.slice().sort(),
    `用 in 做 membership 时这三条永远进不了 added:${JSON.stringify(d)}`);
});

test('r12(不 skip): 原型链名字的**删除**必须进 removed', () => {
  const extraFiles = PROTO_NAMES.map((n) => [n, 'v1']);
  const { dir } = writeDemo({ name: 'frozen-removed', extraFiles });
  const snap = makeObservationSnapshot(dir, { prefix: 'qa-r12-rm-' });
  const frozen = captureFrozenManifest(snap);
  for (const n of PROTO_NAMES) rmSync(join(dir, n));
  const d = diffAgainstFrozen(frozen, dir);
  assert.deepEqual(d.removed.slice().sort(), PROTO_NAMES.slice().sort(), JSON.stringify(d));
});

test('r12(不 skip): 冻结 manifest 仍然三层 frozen(无原型对象上 Object.freeze 照样生效)', () => {
  const { dir } = writeDemo({ name: 'frozen-still', extraFiles: [['__proto__', 'v1']] });
  const snap = makeObservationSnapshot(dir, { prefix: 'qa-r12-frz-' });
  const frozen = captureFrozenManifest(snap);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.entries), true);
  assert.equal(Object.isFrozen(frozen.entries.__proto__), true);
  assert.equal(Object.getPrototypeOf(frozen.entries), null, 'entries 必须无原型');
  const before = frozen.entries.__proto__.sha256;
  try { frozen.entries.__proto__.sha256 = 'x'.repeat(64); } catch { /* 严格模式抛,非严格静默 */ }
  assert.equal(frozen.entries.__proto__.sha256, before);
});

// ============================================================================
// exec 树纵深(r11 加的那层)同样受 membership 影响 —— 必须一起闭合
// ============================================================================

test('r12(实跑): exec 树纵深覆盖原型链名字 —— gate1 污染快照里的 __proto__ → gate2 被拒执行', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const name = 'tree-drift-proto';
  const { dir } = writeDemo({
    name,
    extraFiles: [['__proto__', 'snapshot-clean']],
    customGates: [
      { id: 'a-poison', script: 'a-poison.mjs' },
      { id: 'b-victim', script: 'b-victim.mjs' },
    ],
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
    "    writeFileSync(join(tmp, n, '__proto__'), 'snapshot-poisoned'); break; } } catch {}",
    '}',
    "process.stdout.write('poisoned');",
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'b-victim.mjs'), "process.stdout.write('victim-ran');\n");
  const res = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  const victim = rep.gateX.gates.find((g) => g.id === 'b-victim');
  assert.equal(victim.pass, false,
    `快照里名为 __proto__ 的文件被污染后,后一个 gate 必须被拒执行:${JSON.stringify(victim)}`);
  assert.match(String(victim.detail), /观察时冻结的 manifest 不一致|被改写过/, victim.detail);
  assert.notEqual(res.status, 0);
});

// ============================================================================
// 连带排查:其它同形状映射
// ============================================================================

test('r12 连带(不 skip): canonicalize / sameInputHashes 不许丢 __proto__ 键', () => {
  /* canonicalize 原来 `const out = {}`:manifest 里名为 __proto__ 的那条在规范化之后消失,
     于是 postRunHashRecheck 对它的改动完全失明。 */
  const a = JSON.parse('{"customGates":{"__proto__":"aaa","normal":"x"}}');
  const b = JSON.parse('{"customGates":{"__proto__":"bbb","normal":"x"}}');
  assert.equal(Object.hasOwn(a.customGates, '__proto__'), true, '前提:JSON.parse 会建 own property');
  const ca = canonicalize(a);
  assert.equal(Object.hasOwn(ca.customGates, '__proto__'), true, 'canonicalize 不许把这条键丢掉');
  assert.equal(sameInputHashes(a, b), false, '两份只差 __proto__ 的 hash 表必须判不同');
});

test('r12 连带(不 skip): buildInputHashes 的 customGates 表能收下名为 __proto__ 的脚本', () => {
  const { dir } = writeDemo({ name: 'ih-proto', extraFiles: [['__proto__', 'gate src']] });
  const spec = readJson(join(dir, 'spec.json'));
  spec.customGates = [{ id: 'p', script: '__proto__' }];
  const ih = buildInputHashes(dir, spec);
  assert.equal(Object.hasOwn(ih.customGates, '__proto__'), true, '路径为 key 的表必须无原型');
  assert.equal(typeof ih.customGates.__proto__, 'string');
});

test('r12 连带(不 skip): unwrapTruth 不丢 __proto__ 叶子;truthAt 不许沿原型链取值', () => {
  const truth = JSON.parse('{"__proto__":{"value":42,"provenance":{}},"ok":{"value":1,"provenance":{}}}');
  const un = unwrapTruth(truth);
  assert.equal(Object.hasOwn(un, '__proto__'), true, 'unwrapTruth 不许把 __proto__ 叶子丢掉');
  assert.equal(un.__proto__, 42);
  // truthAt 对**不存在**的原型链名字必须给 undefined(而不是把原型对象当真值返回)
  const plain = { ok: { value: 1, provenance: {} } };
  assert.equal(truthAt(plain, '__proto__'), undefined, 'truth 里没有这条叶子时必须 undefined');
  assert.equal(truthAt(plain, 'constructor'), undefined);
  assert.equal(truthAt(plain, 'toString'), undefined);
  assert.equal(truthAt(plain, 'ok'), 1, '正常路径不许受影响');
});

test('r12 连带(不 skip): 全表——所有以路径/名字为 key 的映射都不许用普通对象字面量', () => {
  /* 这条是「全表排查」的机械化落账:把已排查并修掉的那些初始化点钉住,防有人改回 `{}`。
     不受影响的那些(数组型 manifest、固定字面量 key、Set/Map)不在此表,理由见交付报告。 */
  const SPOTS = [
    ['scripts/lib/observe.mjs', 'const entries = Object.create(null)'],
    ['scripts/lib/observe.mjs', 'Object.hasOwn(frozen.entries, rel)'],
    ['scripts/lib/fs-utils.mjs', 'const out = Object.create(null);\n    for (const key of Object.keys(value).sort())'],
    ['scripts/lib/fs-utils.mjs', 'hashes.customGates = Object.create(null)'],
    ['scripts/lib/fs-utils.mjs', 'sources: Object.create(null)'],
    ['scripts/lib/fs-utils.mjs', 'demoInputs: Object.create(null)'],
    ['scripts/lib/fs-utils.mjs', 'bundle: Object.create(null)'],
    ['scripts/lib/schema.mjs', 'const out = Object.create(null);'],
    ['scripts/lib/schema.mjs', 'Object.hasOwn(o, k)'],
    ['scripts/lib/extract-helpers.mjs', 'const out = Object.create(null);'],
    ['scripts/lib/component-build-core.mjs', 'const packageExports = Object.create(null)'],
    ['scripts/lib/component-build-core.mjs', 'const map = Object.create(null)'],
    ['scripts/lib/replay.mjs', 'probes: Object.create(null)'],
    ['scripts/lib/html-lite.mjs', 'const attrs = Object.create(null)'],
    ['scripts/lib/style-convert.mjs', 'const mechanical = Object.create(null)'],
    ['scripts/dom-ops.mjs', 'const attrDiff = Object.create(null)'],
    ['scripts/dom-ops.mjs', 'const styleDiff = Object.create(null)'],
  ];
  for (const [rel, needle] of SPOTS) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(src.includes(needle), `${rel} 缺 \`${needle}\` —— 路径/名字为 key 的映射不许退回普通对象`);
  }
  // 全仓不许再出现 `X in <路径映射>` 这种 membership 写法(observe 是唯一曾有的一处)
  const observeSrc = readFileSync(join(ROOT, 'scripts/lib/observe.mjs'), 'utf8');
  assert.ok(!/\brel in frozen\.entries\b/.test(observeSrc), '不许用 `in` 做 membership(会走原型链)');
});

test('r12 阳性对照(实跑): 普通文件名的 demo 行为完全不变', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_BROWSER);
  const { dir } = writeDemo({
    name: 'normal-names',
    assetFiles: [['assets/logo.gif', 'GIF89a-normal']],
    customGates: [{ id: 'honest', script: 'honest.mjs' }],
  });
  writeFileSync(join(dir, 'honest.mjs'), "process.stdout.write('ok');\n");
  const res = run(VERIFY, ['--demo', dir], { env: env() });
  const rep = readJson(join(dir, 'report.json'));
  assert.equal(rep.gateA.snapshotDrift, 'none', JSON.stringify(rep.gateA.snapshotDrift));
  assert.equal(rep.gateD.pass, true, JSON.stringify(rep.gateD?.failures));
  assert.equal(rep.ok, true, rep.gateA?.detail);
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('r12 文档契约(不 skip): 门 E 的「若未来执行 demo 脚本必须改用冻结 oracle」告示必须在位', () => {
  const px = readFileSync(join(ROOT, 'scripts/pixel-compare.mjs'), 'utf8');
  assert.match(px, /冻结/, 'pixel-compare 必须写明「一旦引入 demo 脚本执行,收口必须改用冻结 oracle」');
  assert.match(px, /一旦本脚本将来引入任何 demo 脚本执行/, 'pixel-compare 的告示必须点明触发条件');
  const md = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  /* SKILL.md 侧同样要记这条**有前提的豁免**:门 E 继续用文件树收口的理由 + 前提失效时怎么办。
     分两条断言(而不是同一行的正则),因为文档里这两句本来就分行写。 */
  assert.match(md, /门 E（pixel-compare）为什么可以继续用/, 'SKILL.md 必须写明门 E 的豁免理由');
  assert.match(md, /必须同步改用 `observe\.captureFrozenManifest`/, 'SKILL.md 必须写明前提失效后的动作');
});
