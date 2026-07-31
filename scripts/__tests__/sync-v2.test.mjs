// sync-v2.test.mjs — P2.5 同步机械化三件套测试(keyPath 定位 / style-sync 白名单 / dom-ops 锚点)。
// 新文件,不改 qa-hifi-demo.test.mjs(避免与并行分支合并冲突)。
//
// keyPath 组说明:writeback 的 keyPath 通道按设计从「产品仓 node_modules」resolveFrom
// typescript(零新增运行时依赖);本组测试跑在 skill 仓内,typescript 来自 skill 自己的
// node_modules(本机 `npm i --no-save typescript`,不写入 package.json)。找不到时整组
// skip 并如实标注——与门 B-F 在无 playwright 时降级的惯例一致。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { hashFile } from '../lib/fs-utils.mjs';
import { makeLeaf } from '../lib/extract-helpers.mjs';
import { validateTruth } from '../lib/schema.mjs';
import { convertDeclarations, validateEntry, isColorValue } from '../lib/style-convert.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WRITEBACK = join(ROOT, 'scripts/writeback.mjs');
const STYLE_SYNC = join(ROOT, 'scripts/style-sync.mjs');
const DOM_OPS = join(ROOT, 'scripts/dom-ops.mjs');

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 30000,
  });
}
function tmpDemo(name = 'sync-v2') {
  return mkdtempSync(join(tmpdir(), `qa-hifi-${name}-`));
}

// typescript 可用性(见文件头说明)
let hasTs = true;
try {
  createRequire(join(ROOT, 'package.json')).resolve('typescript');
} catch {
  hasTs = false;
}
const tsOnly = hasTs ? {} : { skip: 'typescript 不可用:本机 skill node_modules 未装 typescript(npm i --no-save typescript)' };

// ---- keyPath 通道的 fixture:产品 TS 源文件 + 用 locatorKeyPath 提取的 extract.mjs ----
function writeKeyPathDemo({ source, runTruth = true } = {}) {
  const dir = tmpDemo('keypath');
  const tokens =
    source ??
    `export const tokens = {
  hero: { size: 934, x: 443 },
  colors: { panelBg: '#FAFAFA' },
} as const;
`;
  writeFileSync(join(dir, 'tokens.ts'), tokens);
  writeFileSync(
    join(dir, 'extract.mjs'),
    `import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const src = new URL('tokens.ts', import.meta.url).pathname;
const content = readFileSync(src, 'utf8');
const hash = createHash('sha256').update(readFileSync(src)).digest('hex');
const size = /size:\\s*(\\d+)/.exec(content)[1];
const panelBg = /panelBg:\\s*'([^']+)'/.exec(content)[1];
process.stdout.write(JSON.stringify({
  geometry: { heroSize: { value: size, provenance: { source: 'tokens.ts', locator: 'tokens.hero.size', locatorKeyPath: 'tokens.hero.size', hash } } },
  colors: { panelBg: { value: panelBg, provenance: { source: 'tokens.ts', locator: 'tokens.colors.panelBg', locatorKeyPath: 'tokens.colors.panelBg', hash } } },
}));
`,
  );
  if (!runTruth) return dir; // 调用方手写 truth.json(extract 抓不到的场景,如非字面量初始化)
  const truth = run(join(ROOT, 'scripts/truth.mjs'), ['--demo', dir]);
  assert.equal(truth.status, 0, truth.stdout + truth.stderr);
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><html><body><script id="qa-truth" type="application/json">${readFileSync(join(dir, 'truth.json'), 'utf8')}</script></body></html>`,
  );
  return dir;
}

// ============ keyPath 定位通道 ============

test('keyPath: number+string 双叶子 round-trip 成功,引号风格保留', tsOnly, () => {
  const dir = writeKeyPathDemo();
  const res = run(WRITEBACK, ['--demo', dir, '--set', 'geometry.heroSize=947', '--set', 'colors.panelBg=#FFFFFF']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.roundTrip, true);
  assert.equal(out.written.find((w) => w.path === 'geometry.heroSize').via, 'keyPath:tokens.hero.size');
  const src = readFileSync(join(dir, 'tokens.ts'), 'utf8');
  assert.match(src, /size: 947/); // number 直接替换
  assert.match(src, /panelBg: '#FFFFFF'/); // string 保留原单引号风格
  const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8'));
  assert.equal(truth.geometry.heroSize.value, '947');
  assert.equal(truth.colors.panelBg.value, '#FFFFFF');
});

test('keyPath: 多处定义(同名变量处于不同函数作用域)拒转', tsOnly, () => {
  const dir = writeKeyPathDemo({
    source: `function a() { const tokens = { hero: { size: 100 } }; return tokens; }
function b() { const tokens = { hero: { size: 200 } }; return tokens; }
export const probe = { hero: { size: 934 }, colors: { panelBg: '#FAFAFA' } };
`,
  });
  // fixture extract 仍能 regex 出 size/panelBg,但 keyPath 'tokens.hero.size' 在 AST 上命中两处
  const res = run(WRITEBACK, ['--demo', dir, '--set', 'geometry.heroSize=947']);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /AMBIGUOUS|多处定义/);
});

test('keyPath: 源码值与 truth 漂移拒转(防盲写)', tsOnly, () => {
  const dir = writeKeyPathDemo();
  // 别人把源码 size 改了,truth 还是 934
  writeFileSync(
    join(dir, 'tokens.ts'),
    `export const tokens = {
  hero: { size: 999, x: 443 },
  colors: { panelBg: '#FAFAFA' },
} as const;
`,
  );
  const res = run(WRITEBACK, ['--demo', dir, '--set', 'geometry.heroSize=947']);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /源码已变|先重跑 truth/);
});

test('keyPath: 非字面量初始化(函数调用)拒转走 agent', tsOnly, () => {
  const dir = writeKeyPathDemo({
    runTruth: false, // extract 的 regex 抓不到 computeSize(),truth.json 直接手写
    source: `declare function computeSize(): number;
export const tokens = {
  hero: { size: computeSize(), x: 443 },
  colors: { panelBg: '#FAFAFA' },
} as const;
`,
  });
  // extract 的 regex 抓不到 size(没有数字字面量),本例直接手写 truth.json 绕过
  const hash = hashFile(join(dir, 'tokens.ts'));
  writeFileSync(
    join(dir, 'truth.json'),
    JSON.stringify({
      geometry: { heroSize: { value: '934', provenance: { source: 'tokens.ts', locator: 'tokens.hero.size', locatorKeyPath: 'tokens.hero.size', hash } } },
      colors: { panelBg: { value: '#FAFAFA', provenance: { source: 'tokens.ts', locator: 'tokens.colors.panelBg', locatorKeyPath: 'tokens.colors.panelBg', hash } } },
    }, null, 2),
  );
  const res = run(WRITEBACK, ['--demo', dir, '--set', 'geometry.heroSize=947']);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /NON_LITERAL|不是字面量/);
});

// ============ makeLeaf keyPath 记录 + schema 校验 ============

test('makeLeaf: keyPath 记进 provenance.locatorKeyPath;坏路径拒绝', () => {
  const dir = tmpDemo('makeleaf');
  const source = join(dir, 'tokens.ts');
  writeFileSync(source, 'export const tokens = { hero: { size: 934 } };\n');
  const leaf = makeLeaf(934, source, { locator: 'tokens.hero.size', keyPath: 'tokens.hero.size', demoDir: dir });
  assert.equal(leaf.provenance.locatorKeyPath, 'tokens.hero.size');
  // 过 schema 校验
  const problems = validateTruth({ g: { s: leaf } }, { demoDir: dir, requireProvenance: true });
  assert.deepEqual(problems, []);
  // 坏 keyPath(空段/空白)两处都拦
  assert.throws(() => makeLeaf(1, source, { locator: 'x', keyPath: 'tokens..size', demoDir: dir }), /keyPath/);
  const bad = { value: 1, provenance: { source: 'tokens.ts', locator: 'x', hash: hashFile(source), locatorKeyPath: 'tokens. .size' } };
  const badProblems = validateTruth({ g: { s: bad } }, { demoDir: dir, requireProvenance: true });
  assert.ok(badProblems.some((p) => p.includes('locatorKeyPath')), badProblems.join(';'));
});

// ============ style-sync 白名单 ============

test('style-sync: padding shorthand 展开为四边 number', () => {
  const { mechanical, rejected } = convertDeclarations([{ prop: 'padding', value: '8px 16px' }]);
  // r12:mechanical 改成无原型对象(名字为 key 的映射统一收紧);期望值同构,顺带钉住原型
  assert.deepEqual(mechanical, Object.assign(Object.create(null), { paddingTop: 8, paddingRight: 16, paddingBottom: 8, paddingLeft: 16 }));
  assert.equal(Object.getPrototypeOf(mechanical), null, 'r12:必须无原型');
  assert.deepEqual(rejected, []);
});

test('style-sync: passthrough 陷阱必须拒(1rem / calc / var)', () => {
  const { mechanical, rejected } = convertDeclarations([
    { prop: 'width', value: '1rem' },
    { prop: 'height', value: 'calc(100% - 8px)' },
    { prop: 'color', value: 'var(--fg)' },
  ]);
  assert.deepEqual(mechanical, Object.create(null));   // r12:无原型对象(见上)
  assert.equal(rejected.length, 3);
  assert.match(rejected[0].reason, /非 px 单位/);
  assert.match(rejected[1].reason, /不可静态求值/);
  assert.match(rejected[2].reason, /不可静态求值/);
});

test('style-sync: shorthand 原子——padding 混 1rem 整条拒', () => {
  const { mechanical, rejected } = convertDeclarations([{ prop: 'padding', value: '8px 1rem' }]);
  assert.deepEqual(mechanical, Object.create(null));   // r12:无原型对象(见上)
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].prop, 'padding');
});

test('style-sync: 枚举与颜色校验(block 拒、#hex 过、transform 数组过)', () => {
  const r1 = convertDeclarations([{ prop: 'display', value: 'block' }]);
  assert.equal(r1.rejected.length, 1);
  const r2 = convertDeclarations([
    { prop: 'color', value: '#FAFAFA' },
    { prop: 'transform', value: 'translate(10px, 5px) scale(2)' },
    { prop: 'box-shadow', value: '10px 5px 2px black' },
  ]);
  assert.equal(r2.mechanical.color, '#FAFAFA');
  assert.ok(Array.isArray(r2.mechanical.transform));
  assert.equal(r2.rejected.length, 1); // boxShadow 拒
  assert.ok(isColorValue('rgba(0,0,0,0.2)') && isColorValue('transparent') && !isColorValue('1rem'));
  assert.match(validateEntry('fontSize', '1rem'), /不是 number/);
});

test('style-sync CLI: --decl 输出 mechanical/rejected JSON', () => {
  const res = run(STYLE_SYNC, ['--decl', 'padding: 8px 16px', '--decl', 'width: 1rem']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.mechanical.paddingTop, 8);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.summary.rejected, 1);
});

// ============ dom-ops 结构化操作集 ============

const DOM_OLD = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div id="app">
  <section data-node-id="panel" class="card" style="padding: 8px">
    <h2 data-node-id="title">旧标题</h2>
    <button data-node-id="ok-btn" disabled>确定</button>
    <p>无锚点段落一</p>
  </section>
  <footer data-node-id="foot">v1</footer>
</div>
<script id="qa-truth" type="application/json">{"a":1}</script>
</body></html>
`;
const DOM_NEW = `<!doctype html>
<html><head><title>t</title></head>
<body>
<div id="app">
  <section data-node-id="panel" class="card large" style="padding: 16px">
    <span data-node-id="badge">新徽章</span>
    <h2 data-node-id="title">新标题</h2>
    <button data-node-id="ok-btn">确定</button>
    <p>无锚点段落一改了</p>
  </section>
</div>
<script id="qa-truth" type="application/json">{"a":2}</script>
</body></html>
`;

test('dom-ops: 六类操作齐出 + unanchored 如实列出 + qa-truth 块不噪音', () => {
  const dir = tmpDemo('dom-ops');
  writeFileSync(join(dir, 'old.html'), DOM_OLD);
  writeFileSync(join(dir, 'new.html'), DOM_NEW);
  const res = run(DOM_OPS, ['--old', join(dir, 'old.html'), '--new', join(dir, 'new.html')]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ops.added[0].id, 'badge');
  assert.equal(out.ops.added[0].parent.anchor, 'panel');
  assert.equal(out.ops.removed[0].id, 'foot');
  assert.ok(out.ops.moved.some((m) => m.id === 'title'));
  assert.ok(out.ops.attrChanged.some((a) => a.id === 'panel' && a.attrs.class));
  assert.ok(out.ops.attrChanged.some((a) => a.id === 'ok-btn' && a.attrs.disabled.to === null));
  assert.ok(out.ops.textChanged.some((t) => t.id === 'title' && t.to === '新标题'));
  assert.ok(out.ops.styleChanged.some((s) => s.id === 'panel' && s.style.padding.to === '16px'));
  // unanchored:<p> 文本变化上榜;qa-truth 内嵌块变化不上榜
  assert.ok(out.unanchored.some((u) => u.tag === 'p' && u.change === 'modified'));
  assert.ok(!out.unanchored.some((u) => u.tag === 'script'), JSON.stringify(out.unanchored));
});

test('dom-ops: data-node-id 重复 = 违约,exit 2 列出肇事 id', () => {
  const dir = tmpDemo('dom-dup');
  const dup = `<!doctype html><html><body><div data-node-id="x">1</div><span data-node-id="x">2</span></body></html>`;
  writeFileSync(join(dir, 'a.html'), dup);
  writeFileSync(join(dir, 'b.html'), dup);
  const res = run(DOM_OPS, ['--old', join(dir, 'a.html'), '--new', join(dir, 'b.html')]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /"x"|多次/);
});

// ============ writeback 事务完整性(审核 finding #3):三类文件同事务,失败全恢复 ============
// 注入方式:原子写的临时路径(<file>.qa-writeback-tmp)预建同名目录 → writeFileSync(tmp) 必失败。
// 这是确定性、跨平台的写失败注入;index/truth 目标文件本身的权限在 rename 语义下不影响落盘
// (rename 只看目录可写),见第三个测试——审核人的「index.html chmod 444」场景现已整体成功。

test('writeback 事务: index.html 原子写失败 → 源码+truth.json+index 三文件全恢复', tsOnly, () => {
  const dir = writeKeyPathDemo();
  const before = {
    tokens: readFileSync(join(dir, 'tokens.ts'), 'utf8'),
    truth: readFileSync(join(dir, 'truth.json'), 'utf8'),
    index: readFileSync(join(dir, 'index.html'), 'utf8'),
  };
  // truth.json 先原子落盘成功、index.html 写失败——修复前:truth 留在新值、源码回滚 = 门 A 输入分裂
  mkdirSync(join(dir, 'index.html.qa-writeback-tmp'));
  const res = run(WRITEBACK, ['--demo', dir, '--set', 'geometry.heroSize=947', '--set', 'colors.panelBg=#FFFFFF']);
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stdout, /写回失败已回滚/);
  assert.doesNotMatch(res.stdout, /恢复未完成/);
  assert.equal(readFileSync(join(dir, 'tokens.ts'), 'utf8'), before.tokens); // 源码恢复
  assert.equal(readFileSync(join(dir, 'truth.json'), 'utf8'), before.truth); // truth.json 恢复(本 finding 的核心)
  assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), before.index); // index 无半写状态
});

test('writeback 事务: truth.json 原子写失败 → 源码恢复、truth.json 保持原值', tsOnly, () => {
  const dir = writeKeyPathDemo();
  const before = {
    tokens: readFileSync(join(dir, 'tokens.ts'), 'utf8'),
    truth: readFileSync(join(dir, 'truth.json'), 'utf8'),
  };
  mkdirSync(join(dir, 'truth.json.qa-writeback-tmp'));
  const res = run(WRITEBACK, ['--demo', dir, '--set', 'geometry.heroSize=947']);
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stdout, /写回失败已回滚/);
  assert.doesNotMatch(res.stdout, /恢复未完成/);
  assert.equal(readFileSync(join(dir, 'tokens.ts'), 'utf8'), before.tokens);
  assert.equal(readFileSync(join(dir, 'truth.json'), 'utf8'), before.truth);
});

test('writeback 事务: 审核人复现场景(index.html chmod 444)在 rename 语义下整体成功', tsOnly, () => {
  const dir = writeKeyPathDemo();
  const indexPath = join(dir, 'index.html');
  chmodSync(indexPath, 0o444);
  try {
    const res = run(WRITEBACK, ['--demo', dir, '--set', 'geometry.heroSize=947']);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    // 临时文件+rename 落盘只要求目录可写,目标文件只读不再制造半事务失败
    assert.match(readFileSync(join(dir, 'tokens.ts'), 'utf8'), /size: 947/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8')).geometry.heroSize.value, '947');
    assert.match(readFileSync(indexPath, 'utf8'), /947/);
  } finally {
    chmodSync(indexPath, 0o644);
  }
});
