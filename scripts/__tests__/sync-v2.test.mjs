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
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { hashFile } from '../lib/fs-utils.mjs';
import { makeLeaf } from '../lib/extract-helpers.mjs';
import { validateTruth } from '../lib/schema.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WRITEBACK = join(ROOT, 'scripts/writeback.mjs');

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

