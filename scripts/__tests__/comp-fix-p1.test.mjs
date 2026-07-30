// comp-fix-p1.test.mjs — 组件模式产品化前对抗性审核的三个 P1 + 一个附带收紧项。
//
// 每组都以「审核报的那条复现样本」为第一个断言:先证明它在修复前能过(注释里记原因),
// 现在必须被拒;再配一个合法阳性对照,证明收紧没把正常写法一起拦掉。
//
//   #3 fixture value 未绑定内容 —— locator 自由文本 + 整文件 hash = 手抄免检通道
//   #4 extractThemeVars 吃注释值 —— 裸正则命中 `// light:'#stale'`,过时色值进 truth
//   #5 资产闸门不入链 —— assets-manifest 跑没跑过/抬没抬闸,定稿时全查不到
//   附带 verify.cases[].via 空数组 —— 与「忘填」不可分辨的语义陷阱

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpec, validateTruth } from '../lib/schema.mjs';
import {
  canonicalJson,
  extractThemeVars,
  makeFixtureLeaf,
  makeLeaf,
  parseFixtureLocator,
  resolveFixtureLocator,
  validateCapturedFrom,
} from '../lib/extract-helpers.mjs';
import { hashFile, safeJsonForScript, TOOL_VERSION } from '../lib/fs-utils.mjs';

const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;
/* r7 条目 14:宿主没有产品仓依赖(esbuild / playwright)时,这些用例**跑不了**,
   必须显式 skip 并说明缺什么 —— 原先它们直接 fail,把「宿主缺依赖」伪装成「实现有 bug」。
   skill 自身故意不 vendor esbuild/playwright(重依赖 + 浏览器二进制),它们由产品仓提供;
   canonical 测试命令一直带 QA_HIFI_MODULE_ROOT,两个真实产品仓下这些用例全部实跑。 */
const NEEDS_PRODUCT_REPO = '需要产品仓提供 esbuild/playwright:设 QA_HIFI_MODULE_ROOT 指向装了依赖的仓(skill 自身不 vendor 这两个重依赖)';
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ASSETS_MANIFEST = join(ROOT, 'scripts/assets-manifest.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
const VERIFY = join(ROOT, 'scripts/verify.mjs');

const CAPTURED = { environment: '公司沙盒', capturedAt: '2026-07-30', endpoint: 'GET /api/providers' };
const FIXTURE_JSON = { data: [{ id: 'ark', displayName: '火山方舟' }], meta: { total: 1 } };

function tmpDemo(name) {
  const dir = mkdtempSync(join(tmpdir(), `qa-hifi-p1-${name}-`));
  mkdirSync(join(dir, 'fixtures'));
  writeFileSync(join(dir, 'fixtures/providers.json'), JSON.stringify(FIXTURE_JSON, null, 2));
  return dir;
}

/** 手搓一个 fixture 叶子(绕过工厂函数的前置抛错),直接喂给 validateTruth。 */
function rawFixtureLeaf(dir, { value, locator, capturedFrom = CAPTURED }) {
  return {
    value,
    provenance: {
      source: 'fixtures/providers.json',
      sourceKind: 'fixture',
      locator,
      capturedFrom,
      hash: hashFile(join(dir, 'fixtures/providers.json')),
    },
  };
}

/* ══════════════════ #3 fixture value 绑定 ══════════════════ */

test('#3 审核复现样本:value 手打 + locator 看起来像路径 → 修复前全绿,现在必须拒', () => {
  const dir = tmpDemo('fx-repro');
  // 审核原样本:整文件 hash 对得上(fixture 一个字没改)、locator 语法也合法,
  // 但 data[0].displayName 实际是 '火山方舟',叶子写的是 'HANDWRITTEN'。
  // 旧实现没人解析 locator,这条 100% 通过 validateTruth。
  const leaf = rawFixtureLeaf(dir, { value: 'HANDWRITTEN', locator: 'data[0].displayName' });
  const problems = validateTruth({ providers: { name: leaf } }, { demoDir: dir });
  assert.ok(problems.some((p) => /value 与 fixture 不符/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /HANDWRITTEN/.test(p)), '错误信息要把手打的值印出来便于定位');
  // 工厂函数同样当场抛(extract 作者立刻看到,不用等门 A)
  assert.throws(
    () => makeFixtureLeaf('HANDWRITTEN', 'fixtures/providers.json', { locator: 'data[0].displayName', capturedFrom: CAPTURED, demoDir: dir }),
    /value 与 fixture 不符/,
  );
});

test('#3 阳性对照:三种合法 locator 写法都过,且工厂/校验器结论一致', () => {
  const dir = tmpDemo('fx-ok');
  const cases = [
    ['data.0.displayName', '火山方舟'],
    ['data[0].displayName', '火山方舟'],
    ['/data/0/displayName', '火山方舟'],
    ['data.0.id', 'ark'],
    ['meta.total', 1],
  ];
  for (const [locator, value] of cases) {
    const leaf = makeFixtureLeaf(value, 'fixtures/providers.json', { locator, capturedFrom: CAPTURED, demoDir: dir });
    assert.deepEqual(validateTruth({ a: leaf }, { demoDir: dir }), [], `${locator} 应全过`);
    assert.equal(leaf.provenance.sourceKind, 'fixture');
  }
  // 整个子树(对象值)也能绑定:locator 指向对象时按 canonical 比,键序无关
  const obj = makeFixtureLeaf({ displayName: '火山方舟', id: 'ark' }, 'fixtures/providers.json', {
    locator: 'data.0',
    capturedFrom: CAPTURED,
    demoDir: dir,
  });
  assert.deepEqual(validateTruth({ a: obj }, { demoDir: dir }), []);
});

test('#3 locator 自由文本 / 语法非法 → 拒(不可解析的锚等于没有锚)', () => {
  const dir = tmpDemo('fx-freetext');
  const bad = [
    '第 0 个 provider 的 displayName',   // 中文自由文本
    'providers 响应里的名字',
    'data[0].displayName 那一项',        // 尾部带说明文字
    'data..displayName',                 // 空段
    'data[x].displayName',               // 非数字下标
    'data[0.displayName',                // 括号未闭合
    '.data.0.id',                        // 前导点
    'data.0.id.',                        // 尾随点
    ' data.0.id',                        // 首尾空白
    '/data//0',                          // pointer 空段
  ];
  for (const locator of bad) {
    assert.equal(parseFixtureLocator(locator), null, `${JSON.stringify(locator)} 不该被解析为合法路径`);
    const problems = validateTruth({ a: rawFixtureLeaf(dir, { value: '火山方舟', locator }) }, { demoDir: dir });
    assert.ok(problems.some((p) => /locator 必须是可机械解析的/.test(p)), `${locator}: ${problems.join('\n')}`);
  }
});

test('#3 locator 语法合法但定位不到 → 拒,并说清哪一段断的', () => {
  const dir = tmpDemo('fx-miss');
  const cases = [
    ['data.9.id', /下标 9 越界/],
    ['data.0.nope', /没有键 "nope"/],
    ['data.0.id.deeper', /不是对象\/数组/],
    ['data.notanindex', /是数组,段必须是数字下标/],
  ];
  for (const [locator, re] of cases) {
    const problems = validateTruth({ a: rawFixtureLeaf(dir, { value: 'ark', locator }) }, { demoDir: dir });
    assert.ok(problems.some((p) => re.test(p)), `${locator}: ${problems.join('\n')}`);
  }
});

test('#3 capturedFrom 结构化:旧自由文本拒,缺必填段拒,合法对象过', () => {
  const dir = tmpDemo('fx-cap');
  const reject = [
    ['2026-07-30 公司沙盒 GET /api/providers 响应', /不接受自由文本/],   // 旧写法
    [{ environment: '公司沙盒' }, /capturedAt 必填/],
    [{ capturedAt: '2026-07-30' }, /environment 必填/],
    [{ environment: '  ', capturedAt: '2026-07-30' }, /environment 必填/],
    [{ environment: '沙盒', capturedAt: '07/30/2026' }, /必须以 ISO 日期开头/],
    [{ environment: '沙盒', capturedAt: '2026-13-45' }, /不是真实日期/],
    [{ environment: '沙盒', capturedAt: '2026-07-30', who: 'me' }, /who 不是支持的字段/],
    [['环境', '日期'], /必须是对象/],
  ];
  for (const [capturedFrom, re] of reject) {
    const problems = validateTruth(
      { a: rawFixtureLeaf(dir, { value: 'ark', locator: 'data.0.id', capturedFrom }) },
      { demoDir: dir },
    );
    assert.ok(problems.some((p) => re.test(p)), `${canonicalJson(capturedFrom)}: ${problems.join('\n')}`);
    assert.ok(validateCapturedFrom(capturedFrom).length > 0);
  }
  // 合法:必填两段即可;endpoint/note 可选;带时间的 ISO 串也接受
  for (const capturedFrom of [
    { environment: '公司沙盒', capturedAt: '2026-07-30' },
    { environment: '公司沙盒', capturedAt: '2026-07-30T12:00:00Z', endpoint: 'GET /api/providers', note: '灰度环境' },
  ]) {
    assert.deepEqual(validateCapturedFrom(capturedFrom), []);
    const leaf = makeFixtureLeaf('ark', 'fixtures/providers.json', { locator: 'data.0.id', capturedFrom, demoDir: dir });
    assert.deepEqual(validateTruth({ a: leaf }, { demoDir: dir }), []);
  }
});

test('#3 fixture 改了值但 hash 也一起更新 → 仍被值绑定拦下(hash 不是唯一防线)', () => {
  const dir = tmpDemo('fx-resign');
  const fixture = join(dir, 'fixtures/providers.json');
  const leaf = makeFixtureLeaf('火山方舟', 'fixtures/providers.json', { locator: 'data.0.displayName', capturedFrom: CAPTURED, demoDir: dir });
  // 攻击者改 fixture 后顺手把 hash 也重签——旧实现这就完全过了
  writeFileSync(fixture, JSON.stringify({ data: [{ id: 'ark', displayName: '改过的名字' }], meta: { total: 1 } }, null, 2));
  leaf.provenance.hash = hashFile(fixture);
  const problems = validateTruth({ a: leaf }, { demoDir: dir });
  assert.ok(problems.every((p) => !/hash 与源文件不符/.test(p)), 'hash 已重签,不该再报 hash 不符');
  assert.ok(problems.some((p) => /value 与 fixture 不符/.test(p)), problems.join('\n'));
});

test('#3 底层工具:resolveFixtureLocator 在数组/对象/标量边界上的行为', () => {
  const root = { a: [{ b: 1 }], s: 'str', n: null };
  assert.deepEqual(resolveFixtureLocator(root, ['a', '0', 'b']), { ok: true, value: 1 });
  assert.equal(resolveFixtureLocator(root, ['s', 'x']).ok, false);
  assert.equal(resolveFixtureLocator(root, ['n', 'x']).ok, false);
  assert.equal(resolveFixtureLocator(root, ['a', 'b']).ok, false);
  // 原型链上的键不算命中(hasOwn 语义)
  assert.equal(resolveFixtureLocator(root, ['toString']).ok, false);
});

/* ══════════════════ #4 extractThemeVars 注释 ══════════════════ */

function writeColors(dir, body) {
  const file = join(dir, 'colors.ts');
  writeFileSync(file, body);
  return file;
}

test('#4 审核复现样本:注释里的过时色值不得进 truth(四种注释位置)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-hifi-p1-theme-'));
  const cases = [
    [
      '行注释在真值之前',
      `registerColor('t', {\n  // light: '#stale'\n  light: '#real',\n  dark: '#dark0',\n}, 'x');\n`,
    ],
    [
      '行注释在真值之后',
      `registerColor('t', {\n  light: '#real',\n  // light: '#stale'\n  dark: '#dark0',\n}, 'x');\n`,
    ],
    [
      '块注释在真值之前',
      `registerColor('t', {\n  /* light: '#stale' */\n  light: '#real',\n  dark: '#dark0',\n}, 'x');\n`,
    ],
    [
      '块注释跨行包住伪属性',
      `registerColor('t', {\n  /*\n   * 历史值:\n   * light: '#stale'\n   * dark: '#staledark'\n   */\n  light: '#real',\n  dark: '#dark0',\n}, 'x');\n`,
    ],
  ];
  for (const [label, src] of cases) {
    const file = writeColors(dir, src);
    const out = extractThemeVars(file, { demoDir: dir });
    assert.equal(out.t.light.value, '#real', `${label}:light 取到注释值了`);
    assert.equal(out.t.dark.value, '#dark0', `${label}:dark 取到注释值了`);
    // 顺带:writeback 锚不得指向注释。指向注释时宁可不给锚(null),也不给错位置的锚。
    const pattern = out.t.light.provenance.locatorPattern;
    if (pattern) {
      const hits = [...src.matchAll(new RegExp(pattern, 'g'))];
      assert.equal(hits.length, 1, `${label}:锚必须在源码里恰命中一次`);
      assert.equal(hits[0][1], '#real', `${label}:锚捕获到的是注释里的过时值`);
    }
  }
});

test('#4 注释值与真值同字面量时:锚要么正确要么为 null,绝不指向注释', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-hifi-p1-theme2-'));
  // 注释里的伪属性值与真值完全一样 —— 次数/内容自检都骗得过,只有位置自检能识破
  const src = `registerColor('t', {\n  // light: '#same'\n  light: '#same',\n  dark: null,\n}, 'x');\n`;
  const file = writeColors(dir, src);
  const out = extractThemeVars(file, { demoDir: dir });
  assert.equal(out.t.light.value, '#same');
  const pattern = out.t.light.provenance.locatorPattern;
  if (pattern) {
    const m = new RegExp(pattern).exec(src);
    const groupStart = m.index + m[0].length - 1 - '#same'.length;
    // 真值的开引号位置(第二个 light: 那行)
    const realIdx = src.lastIndexOf("'#same'");
    assert.equal(groupStart, realIdx + 1, '锚落在注释里的那一处了');
  }
});

test('#4 嵌套对象里的同名键不再被误当成顶层 light/dark', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-hifi-p1-theme3-'));
  const src = `registerColor('t', {\n  meta: { light: '#nested', dark: '#nested2' },\n  light: '#real',\n  dark: '#realdark',\n}, 'x');\n`;
  const out = extractThemeVars(writeColors(dir, src), { demoDir: dir });
  assert.equal(out.t.light.value, '#real');
  assert.equal(out.t.dark.value, '#realdark');
});

test('#4 回灸:cindy 真实 colors.ts 提取数不变,夹注释的 avatar-border 仍正确', (t) => {
  const colors = '/Users/praise/AI-Agent/Claude/projects/Project CINDY/apps/desktop/src/renderer/themes/colors.ts';
  if (!existsSync(colors)) return t.skip('本机没有 cindy 产品仓,跳过回灸');
  const dir = mkdtempSync(join(tmpdir(), 'qa-hifi-p1-real-'));
  const skipped = [];
  const out = extractThemeVars(colors, { demoDir: dir, onSkip: (s) => skipped.push(...s) });
  const total = Object.keys(out).length;
  // 481 个 registerColor,跳过项 + 提取项必须刚好把它们分完(没有被静默吞掉的 token)
  assert.equal(total + skipped.length, 481, `提取 ${total} + 跳过 ${skipped.length} 应等于 registerColor 总数`);
  assert.ok(total > 400, `可用 token 只有 ${total} 个,提取链疑似退化`);
  // 审核点名的夹注释案例:dark 值写在两行注释之后,必须取到真值而不是注释里的说明
  const border = out['settings-integration-avatar-border'];
  assert.equal(border.light.value, '#e8e8e6');
  assert.equal(border.dark.value, 'rgba(255, 255, 255, 0.08)');
  // 每个叶子都得是真 provenance(source 指向 colors.ts、hash 对得上)
  assert.equal(border.dark.provenance.hash, hashFile(colors));
});

/* ══════════════════ #5 资产闸门入链 ══════════════════ */

/** 建一个能真跑 verify 的最小 demo(可选带 assets/)。返回 demo 目录。 */
function writeAssetDemo({ name, assetBytes = null }) {
  const dir = mkdtempSync(join(tmpdir(), `qa-hifi-p1-${name}-`));
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
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
  const truth = { colors: { text: makeLeaf('#ff0000', source, { locator: 'source.txt 常量', demoDir: dir }) } };
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
  window.__qa={current:()=>S.step,goto:(id)=>{if(id!=='id')throw new Error('unknown');S.step=id;},prefs:()=>({...S.prefs}),scale:()=>1,resize:()=>{}};
  </script></body></html>`,
  );
  if (assetBytes !== null) {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets/hero.bin'), Buffer.alloc(assetBytes, 7));
  }
  return dir;
}

const runVerify = (dir) => spawnSync(process.execPath, [VERIFY, '--demo', dir], { encoding: 'utf8', timeout: 180000, cwd: ROOT });
const runPrBlock = (dir) => spawnSync(process.execPath, [PR_BLOCK, '--demo', dir], { encoding: 'utf8', timeout: 60000, cwd: ROOT });
const runManifest = (dir, extra = []) =>
  spawnSync(process.execPath, [ASSETS_MANIFEST, '--demo', dir, ...extra], { encoding: 'utf8', timeout: 60000, cwd: ROOT });

test('#5 审核复现样本:有 assets/ 但没跑闸门 → pr-block 必须拒(旧实现直接出块)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeAssetDemo({ name: 'as-norun', assetBytes: 1024 });
  const ok = runVerify(dir);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(existsSync(join(dir, 'report-assets.json')), false, '前置条件:闸门确实没跑');
  const res = runPrBlock(dir);
  assert.notEqual(res.status, 0, '没跑资产闸门却出块了:\n' + res.stdout);
  assert.match(res.stdout, /资产体积闸门未跑/);
  // 跑完闸门就能出块(证明拒的是"没跑",不是"有 assets 就拒")
  assert.equal(runManifest(dir).status, 0);
  const after = runPrBlock(dir);
  assert.equal(after.status, 0, after.stdout + after.stderr);
  const report = JSON.parse(readFileSync(join(dir, 'report-assets.json'), 'utf8'));
  assert.equal(report.ok, true);
  assert.equal(report.toolVersion, TOOL_VERSION);
  assert.equal(report.overrideReason, null);
  assert.equal(report.defaultLimitMb, 8);
  assert.equal(report.effectiveLimitMb, 8);
  assert.equal(report.inputHashes.assets.length, 1);
  assert.equal(report.inputHashes.assets[0].path, 'assets/hero.bin');
  // 没抬闸就不许出现抬闸声明行(常贴的声明没信息量)
  assert.doesNotMatch(after.stdout, /抬闸理由/);
});

test('#5 抬闸无理由 → 闸门自己拒;有理由 → 过且附贴块印出理由', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeAssetDemo({ name: 'as-override', assetBytes: 1024 });
  assert.equal(runVerify(dir).status, 0);
  // 超默认阀:不抬闸 = ok:false,pr-block 拒
  const over = runManifest(dir, ['--max-total', '0.0005']);
  assert.notEqual(over.status, 0);
  assert.match(over.stdout, /超过上限/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'report-assets.json'), 'utf8')).ok, false, '失败也要落盘 ok:false');
  const blocked = runPrBlock(dir);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout, /ok 不是 true/);
  // 抬闸但不给理由 → 参数就被拒(报告不该被这次调用改写成 ok:true)
  const noReason = runManifest(dir, ['--max-total', '16']);
  assert.notEqual(noReason.status, 0);
  assert.match(noReason.stdout, /抬闸必须同时给/);
  // 不抬闸却给理由 → 也拒(避免"理由"变成随手贴的装饰)
  const strayReason = runManifest(dir, ['--max-total', '4', '--override-reason', '随便写写']);
  assert.notEqual(strayReason.status, 0);
  assert.match(strayReason.stdout, /只在抬闸/);
  // 抬闸 + 非空理由 → 过,理由进报告并印上附贴块
  const reason = 'hero 视频封面无法进一步压缩,产品要求保留 2x 资源';
  const lifted = runManifest(dir, ['--max-total', '16', '--override-reason', reason]);
  assert.equal(lifted.status, 0, lifted.stdout);
  const report = JSON.parse(readFileSync(join(dir, 'report-assets.json'), 'utf8'));
  assert.equal(report.overrideReason, reason);
  assert.equal(report.effectiveLimitMb, 16);
  assert.equal(report.defaultLimitMb, 8);
  const res = runPrBlock(dir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /⚠️ 资产 .* MB（可信侧现算）超默认闸门 8 MB（作者声明本次生效阀 16 MB），抬闸理由：/);
  assert.ok(res.stdout.includes(reason), '抬闸理由必须原样印在附贴块上');
});

test('#5 篡改 assets 后旧 report-assets 失效 → pr-block 拒(换图不重跑闸门)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeAssetDemo({ name: 'as-tamper', assetBytes: 1024 });
  assert.equal(runVerify(dir).status, 0);
  assert.equal(runManifest(dir).status, 0);
  assert.equal(runPrBlock(dir).status, 0);
  // 换掉资产字节(体积仍在闸门内,所以"超阀"拦不住它,只有 hash 能拦)
  writeFileSync(join(dir, 'assets/hero.bin'), Buffer.alloc(1024, 9));
  const res = runPrBlock(dir);
  assert.notEqual(res.status, 0, '换了资产字节仍出块:\n' + res.stdout);
  assert.match(res.stdout, /assets hash 与当前 assets\/ 不一致/);
  // 新增一个资产同样要被发现(不只比已知文件)
  writeFileSync(join(dir, 'assets/hero.bin'), Buffer.alloc(1024, 7));
  assert.equal(runPrBlock(dir).status, 0, '还原字节后应恢复');
  writeFileSync(join(dir, 'assets/extra.bin'), Buffer.alloc(16, 1));
  assert.match(runPrBlock(dir).stdout, /assets hash 与当前 assets\/ 不一致/);
});

test('#5 没有 assets/ 的 demo 不受影响(旧 demo 不被新门拦下)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeAssetDemo({ name: 'as-none', assetBytes: null });
  assert.equal(runVerify(dir).status, 0);
  const res = runPrBlock(dir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.doesNotMatch(res.stdout, /资产体积闸门/);
  assert.equal(existsSync(join(dir, 'report-assets.json')), false);
});

test('#5 pr-block 与 assets-manifest 的常量必须一致(两处声明的漂移守卫)', () => {
  const manifestSrc = readFileSync(ASSETS_MANIFEST, 'utf8');
  const prBlockSrc = readFileSync(PR_BLOCK, 'utf8');
  const grab = (src, name) => new RegExp(`${name} = ([^;]+);`).exec(src)?.[1]?.trim();
  assert.equal(grab(manifestSrc, 'ASSETS_REPORT_NAME'), grab(prBlockSrc, 'ASSETS_REPORT_NAME'));
  assert.equal(grab(manifestSrc, 'DEFAULT_MAX_TOTAL_MB'), grab(prBlockSrc, 'DEFAULT_ASSETS_LIMIT_MB'));
});

/* ══════════════════ 附带收紧:verify.cases[].via 空数组 ══════════════════ */

function specWithCaseVia(via) {
  const spec = {
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: {
      noClip: ['.box'],
      cases: [{ id: 'c1', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, ...(via === undefined ? {} : { via }) }],
    },
  };
  return validateSpec(spec);
}

test('附带收紧:verify.cases[].via 空数组被拒,省略与非空都过', () => {
  const empty = specWithCaseVia([]);
  assert.ok(empty.some((p) => /via 不能是空数组/.test(p)), empty.join('\n'));
  assert.ok(empty.some((p) => /省略 via 字段/.test(p)), '错误信息要告诉作者正确写法');
  assert.deepEqual(specWithCaseVia(undefined), [], '省略 via = 走默认偏好点击,合法');
  assert.deepEqual(specWithCaseVia([{ expect: 'id' }]), [], '非空 via 合法');
  // 非数组仍按原口径拒
  assert.ok(specWithCaseVia('nope').some((p) => /via 必须是 step 数组/.test(p)));
});
