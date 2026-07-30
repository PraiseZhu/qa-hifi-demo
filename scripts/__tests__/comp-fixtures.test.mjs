// comp-fixtures.test.mjs — 服务端驱动数据的 fixture provenance(sourceKind='fixture')。
// 对抗口径:合法路径全过 / 缺 capturedFrom 拒 / fixture 篡改后 hash 不符拒 /
// source 指向 demo 外拒 / PR 附贴块出现诚实降级声明行。fixture 自给自足,不改旧测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTruth, countFixtureLeaves } from '../lib/schema.mjs';
import { makeFixtureLeaf, makeLeaf } from '../lib/extract-helpers.mjs';
import { hashFile, safeJsonForScript } from '../lib/fs-utils.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
const VERIFY = join(ROOT, 'scripts/verify.mjs');

const FIXTURE_JSON = { data: [{ id: 'ark', displayName: '火山方舟' }] };

/** 建一个带 fixtures/providers.json 的 demo 目录,返回 { dir, fixture } */
function tmpFixtureDemo(name = 'fx') {
  const dir = mkdtempSync(join(tmpdir(), `qa-hifi-${name}-`));
  mkdirSync(join(dir, 'fixtures'));
  const fixture = join(dir, 'fixtures/providers.json');
  writeFileSync(fixture, JSON.stringify(FIXTURE_JSON, null, 2));
  return { dir, fixture };
}

test('makeFixtureLeaf: 合法路径产出 sourceKind=fixture + capturedFrom,校验全过', () => {
  const { dir, fixture } = tmpFixtureDemo('ok');
  const leaf = makeFixtureLeaf(FIXTURE_JSON.data[0].displayName, 'fixtures/providers.json', {
    locator: 'data[0].displayName',
    capturedFrom: '2026-07-30 公司沙盒 GET /api/providers 响应',
    demoDir: dir,
  });
  assert.equal(leaf.value, '火山方舟');
  assert.equal(leaf.provenance.sourceKind, 'fixture');
  assert.equal(leaf.provenance.source, 'fixtures/providers.json');
  assert.equal(leaf.provenance.hash, hashFile(fixture));
  assert.match(leaf.provenance.capturedFrom, /沙盒/);
  assert.deepEqual(validateTruth({ providers: { name: leaf } }, { demoDir: dir }), []);
});

test('sourceKind 省略即 code:旧 truth 不受影响,校验仍过', () => {
  const { dir } = tmpFixtureDemo('legacy');
  writeFileSync(join(dir, 'source.txt'), 'v1');
  const leaf = makeLeaf('x', 'source.txt', { locator: '常量', demoDir: dir });
  assert.equal(leaf.provenance.sourceKind, undefined);
  assert.deepEqual(validateTruth({ a: leaf }, { demoDir: dir }), []);
  assert.equal(countFixtureLeaves({ a: leaf }), 0);
});

test('sourceKind 非法值被拒', () => {
  const { dir, fixture } = tmpFixtureDemo('badkind');
  const truth = {
    a: {
      value: 1,
      provenance: { source: 'fixtures/providers.json', sourceKind: 'server', locator: 'l', hash: hashFile(fixture) },
    },
  };
  const problems = validateTruth(truth, { demoDir: dir });
  assert.ok(problems.some((p) => /sourceKind 只能是/.test(p)), problems.join('\n'));
});

test('缺 capturedFrom:schema FAIL(工厂函数也抛)', () => {
  const { dir, fixture } = tmpFixtureDemo('nocap');
  const truth = {
    a: {
      value: 1,
      provenance: { source: 'fixtures/providers.json', sourceKind: 'fixture', locator: 'l', hash: hashFile(fixture) },
    },
  };
  const problems = validateTruth(truth, { demoDir: dir });
  assert.ok(problems.some((p) => /capturedFrom 必填/.test(p)), problems.join('\n'));
  // 空白串同样算缺
  truth.a.provenance.capturedFrom = '   ';
  assert.ok(validateTruth(truth, { demoDir: dir }).some((p) => /capturedFrom 必填/.test(p)));
  assert.throws(
    () => makeFixtureLeaf(1, 'fixtures/providers.json', { locator: 'l', demoDir: dir }),
    /capturedFrom/,
  );
});

test('fixture 文件被篡改后 hash 不符 → 拒(fixture 不是防伪豁免)', () => {
  const { dir, fixture } = tmpFixtureDemo('tamper');
  const leaf = makeFixtureLeaf('火山方舟', 'fixtures/providers.json', {
    locator: 'data[0].displayName',
    capturedFrom: '2026-07-30 沙盒响应',
    demoDir: dir,
  });
  assert.deepEqual(validateTruth({ a: leaf }, { demoDir: dir }), []);
  writeFileSync(fixture, JSON.stringify({ data: [{ id: 'ark', displayName: '被改过' }] }, null, 2));
  assert.notEqual(hashFile(fixture), leaf.provenance.hash);
  assert.ok(validateTruth({ a: leaf }, { demoDir: dir }).some((p) => /hash 与源文件不符/.test(p)));
});

test('fixture source 指向 demo 外(../ 逃逸 / 绝对路径)→ 拒', () => {
  const { dir } = tmpFixtureDemo('escape');
  const outside = join(dir, '..', 'outside.json');
  writeFileSync(outside, '{}');
  const mk = (source) => ({
    a: {
      value: 1,
      provenance: {
        source,
        sourceKind: 'fixture',
        locator: 'l',
        capturedFrom: '沙盒响应',
        hash: hashFile(outside),
      },
    },
  });
  for (const source of ['../outside.json', outside]) {
    const problems = validateTruth(mk(source), { demoDir: dir });
    assert.ok(problems.some((p) => /demo 目录外/.test(p)), `${source}: ${problems.join('\n')}`);
  }
  // demo 内但不在 fixtures/ 下也拒(必须随 PR 走且位置可预期)
  writeFileSync(join(dir, 'stray.json'), '{}');
  const stray = validateTruth(
    {
      a: {
        value: 1,
        provenance: {
          source: 'stray.json',
          sourceKind: 'fixture',
          locator: 'l',
          capturedFrom: '沙盒响应',
          hash: hashFile(join(dir, 'stray.json')),
        },
      },
    },
    { demoDir: dir },
  );
  assert.ok(stray.some((p) => /fixtures\/<name>\.json/.test(p)), stray.join('\n'));
  // 工厂函数同样拦
  assert.throws(
    () => makeFixtureLeaf(1, outside, { locator: 'l', capturedFrom: '沙盒', demoDir: dir }),
    /demo 目录内|fixtures\//,
  );
});

test('countFixtureLeaves: 只数 fixture 叶子,嵌套/数组都数到', () => {
  const { dir, fixture } = tmpFixtureDemo('count');
  const fx = (v) =>
    makeFixtureLeaf(v, 'fixtures/providers.json', { locator: 'l', capturedFrom: '沙盒响应', demoDir: dir });
  writeFileSync(join(dir, 'source.txt'), 'v1');
  const code = makeLeaf('c', 'source.txt', { locator: '常量', demoDir: dir });
  assert.equal(hashFile(fixture).length, 64);
  assert.equal(countFixtureLeaves({ a: fx(1), b: { c: [fx(2), code] }, d: code }), 2);
});

// 走真 verify.mjs 产出 report(手搓 report 会被完整性校验拒,也不算真验证过附贴块链路)。
// withFixture=true 时额外挂一个 fixture 叶子,除此之外两份 demo 完全一致。
function writeVerifiableDemo({ name, withFixture }) {
  const { dir } = tmpFixtureDemo(name);
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
  const spec = {
    meta: { name, summary: { what: 'what', how: 'how', accept: 'accept' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: {
      cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [] }],
      noClip: ['.box'],
    },
    bindings: [{ sel: '.box', prop: 'color', truth: 'colors.text', kind: 'color' }],
  };
  const truth = {
    colors: { text: makeLeaf('#ff0000', source, { locator: 'source.txt 常量', demoDir: dir }) },
    ...(withFixture
      ? {
          providers: {
            name: makeFixtureLeaf('火山方舟', 'fixtures/providers.json', {
              locator: 'data[0].displayName',
              capturedFrom: '2026-07-30 公司沙盒 GET /api/providers 响应',
              demoDir: dir,
            }),
          },
        }
      : {}),
  };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><html><head><style>.box{color:#ff0000}</style></head><body>
  <script id="qa-truth" type="application/json">${safeJsonForScript(truth)}</script>
  <div class="box">x</div>
  <script>
  const S={step:'id',prefs:{plat:'desk',region:'cn',os:'ios',mode:'light',lang:'zh-CN'}};
  window.__qa={
    current:()=>S.step,
    goto:(id)=>{ if(id!=='id') throw new Error('unknown'); S.step=id; },
    prefs:()=>({...S.prefs}),
    scale:()=>1,
    resize:(w,h)=>{},
  };
  </script></body></html>`,
  );
  return dir;
}

test('pr-block 附贴块:存在 fixture 叶子时输出诚实降级声明行', () => {
  for (const withFixture of [true, false]) {
    const dir = writeVerifiableDemo({ name: withFixture ? 'pb-fx' : 'pb-code', withFixture });
    const ok = spawnSync(process.execPath, [VERIFY, '--demo', dir], { encoding: 'utf8', timeout: 180000, cwd: ROOT });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const res = spawnSync(process.execPath, [PR_BLOCK, '--demo', dir], { encoding: 'utf8', timeout: 60000, cwd: ROOT });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    if (withFixture) assert.match(res.stdout, /1 个叶子来自录制 fixture（非源码溯源）/);
    // 全 code 叶子时不得出现该行——声明常贴就没信息量了
    else assert.doesNotMatch(res.stdout, /录制 fixture/);
  }
});
