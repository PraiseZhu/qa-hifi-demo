// comp-init.test.mjs — init.mjs 组件模式脚手架的结构断言 + 旧模式回归 + build.mjs 可运行性。
//
// 分工:结构断言(生成了什么、spec.component 骨架完整、标记段在位)不需要产品仓;
// build.mjs 可运行性用一个最小 fixture「产品仓」(git init + 一个 tsx 组件 + 一张 png)实测,
// esbuild 从 $QA_HIFI_MODULE_ROOT / fixture 仓解析——未设置该环境变量时跳过(同 gate-e-v2 惯例)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const INIT = join(ROOT, 'scripts/init.mjs');
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 60000,
  });
}

function json(res) {
  return JSON.parse(res.stdout);
}

function tmpDir(tag) {
  return mkdtempSync(join(tmpdir(), `qa-comp-${tag}-`));
}

const ENTRY = 'src/renderer/components/Widget.tsx';

function initComponent(tag = 'demo', extraArgs = []) {
  const dir = join(tmpDir(tag), 'demo');
  const res = run(INIT, ['--dir', dir, '--name', 'comp-demo', '--mode', 'component', '--entry', ENTRY, ...extraArgs]);
  return { dir, res };
}

/* ───────────────────────── 组件模式:生成物结构 ───────────────────────── */

test('组件模式生成八件套,含 build.mjs / bootstrap / shims 骨架', () => {
  const { dir, res } = initComponent('files');
  assert.equal(res.status, 0, res.stderr);
  const out = json(res);
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'component');
  for (const f of ['spec.json', 'extract.mjs', 'extract-helpers.mjs', 'index.html', 'build.mjs', 'src/bootstrap.tsx', 'shims/README.md', 'shims/_template.ts']) {
    assert.ok(out.files.includes(f), `files 缺 ${f}`);
    assert.ok(existsSync(join(dir, f)), `未落盘 ${f}`);
  }
});

test('spec.component 骨架字段齐全,entry 原样写入,平台收窄为 desktop', () => {
  const { dir } = initComponent('spec');
  const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
  const comp = spec.component;
  assert.ok(comp, '缺 component 段');
  assert.equal(comp.mode, 'component', 'schema 硬要求 component.mode');
  assert.equal(comp.entry, ENTRY);
  // 防伪链真相源改为 build.mjs 生成的 component.inputs.json(esbuild metafile),
  // sources 降级为可选人读声明 → 骨架默认留空,不再预填 entry
  assert.deepEqual(comp.sources, [], 'sources 是可选人读声明,骨架应留空');
  assert.equal(comp.bootstrap, 'src/bootstrap.tsx');
  assert.equal(comp.bundle, 'assets/component.bundle.js');
  assert.equal(comp.assetsDir, 'assets');
  assert.deepEqual(comp.packageRoots, {});
  assert.deepEqual(comp.shims, []);
  assert.deepEqual(comp.fixtures, []);
  assert.equal(comp.css, null);
  assert.equal(comp.themeVars.truthPath, 'themeVars');
  // driver 段已下线:状态驱动方式的单一真相源是 states[].driver
  assert.equal('driver' in comp, false, 'component.driver 应已移除(与 states[].driver 重复)');
  assert.deepEqual(spec.states, [{ id: 'entry', driver: 'inject', via: [{ expect: 'entry' }] }]);
  // RN 不在方案范围:matrix 只留 desktop,verify cases 也不出现 mobile
  assert.deepEqual(spec.matrix.platforms, ['desktop']);
  assert.deepEqual(spec.verify.cases.map((c) => c.prefs.plat), ['desktop', 'desktop']);
  assert.deepEqual(spec.verify.cases.map((c) => c.prefs.mode), ['light', 'dark']);
});

test('生成的 spec.json 直接过 validateSpec(两种模式;脚手架不许一出生就非法)', async () => {
  const { validateSpec } = await import(join(ROOT, 'scripts/lib/schema.mjs'));
  const { dir } = initComponent('schema');
  const compSpec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
  assert.deepEqual(validateSpec(compSpec), [], '组件模式脚手架 spec 不合法');

  const classicDir = join(tmpDir('schema-classic'), 'demo');
  run(INIT, ['--dir', classicDir, '--name', 'classic-demo']);
  assert.deepEqual(validateSpec(JSON.parse(readFileSync(join(classicDir, 'spec.json'), 'utf8'))), []);
});

test('组件壳 index.html:adapter 与 chrome 两个标记段都在位,且引用 bundle/css', () => {
  const { dir } = initComponent('shell');
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  for (const marker of ['QA_COMPONENT_ADAPTER_BEGIN', 'QA_COMPONENT_ADAPTER_END', 'QA_CHROME_BEGIN', 'QA_CHROME_END']) {
    assert.ok(html.includes(marker), `缺 ${marker}`);
  }
  // 占位符必须被替换掉(否则 demo 打开就是死页)
  assert.ok(!html.includes('{{QA_COMPONENT_ADAPTER}}'));
  assert.ok(!html.includes('{{QA_CHROME}}'));
  assert.ok(!html.includes('{{NAME}}') && !html.includes('{{PR}}'));
  assert.ok(html.includes('src="assets/component.bundle.js"'), '缺 bundle script 引用');
  assert.ok(html.includes('href="assets/component.css"'), '缺 component.css 引用');
  // 内联顺序硬性:truth → 基础配置 → bundle → adapter → chrome
  // (adapter 要读 bundle 装配好的 __qaDemo.mount/states,必须在 bundle 之后)
  const iTruth = html.indexOf('id="qa-truth"');
  const iBase = html.indexOf('window.__qaDemo');
  const iBundle = html.indexOf('src="assets/component.bundle.js"');
  const iAdapter = html.indexOf('QA_COMPONENT_ADAPTER_BEGIN');
  const iChrome = html.indexOf('QA_CHROME_BEGIN');
  assert.ok(iTruth < iBase && iBase < iBundle && iBundle < iAdapter && iAdapter < iChrome,
    `内联顺序错:truth=${iTruth} base=${iBase} bundle=${iBundle} adapter=${iAdapter} chrome=${iChrome}`);
  assert.ok(/mode:\s*'component'/.test(html.slice(iBase, iBundle)), '基础配置段缺 mode: component');
  // 组件模式不手写 renderApp
  assert.ok(!/renderApp\s*\(ctx\)\s*\{/.test(html.slice(0, html.indexOf('QA_COMPONENT_ADAPTER_BEGIN'))));
});

test('内联段不含裸 </script(否则 HTML 分词器把脚本截断,页面死在半截 adapter)', () => {
  const { dir } = initComponent('inline-safe');
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const inline = html.split('<script src=');
  // 每个内联块里都不许出现裸的结束标签;模板里的示例结束标签必须被转义成 <\/script
  const adapterBlock = html.slice(html.indexOf('QA_COMPONENT_ADAPTER_BEGIN'), html.indexOf('QA_COMPONENT_ADAPTER_END'));
  assert.ok(!adapterBlock.includes('</script'), 'adapter 内联段出现裸 </script');
  const chromeBlock = html.slice(html.indexOf('QA_CHROME_BEGIN'), html.indexOf('QA_CHROME_END'));
  assert.ok(!chromeBlock.includes('</script'), 'chrome 内联段出现裸 </script');
  assert.ok(inline.length >= 2, 'index.html 应引用外部 bundle');
});

test('verify.cases 不带 via(via:[] 会跳过偏好点击,非默认 case 必然 prefs mismatch)', () => {
  const { dir } = initComponent('cases-no-via');
  const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
  for (const c of spec.verify.cases) assert.equal('via' in c, false, `case ${c.id} 不该带 via`);
});

test('bootstrap 模板按 adapter 合约装配 __qaDemo(states/mount/inject/onPrefs)', () => {
  const { dir } = initComponent('bootstrap');
  const src = readFileSync(join(dir, 'src/bootstrap.tsx'), 'utf8');
  assert.ok(src.includes('Object.assign(window.__qaDemo'), '缺 __qaDemo 装配接线点');
  for (const fn of ['states:', 'mount(ctx', 'inject(id', 'onPrefs(prefs']) assert.ok(src.includes(fn), `合约缺 ${fn}`);
  // adapter 接管主题与渲染:bootstrap 不许自带 renderApp / applyTheme(否则两份实现)
  assert.ok(!src.includes('renderApp'), 'bootstrap 不该出现 renderApp(adapter 合成)');
  assert.ok(!/function applyTheme|applyTheme\(/.test(src), 'bootstrap 不该做主题桥(adapter 接管)');
  assert.ok(src.includes('ctx.root'), 'mount 应挂到 adapter 给的 ctx.root');
  assert.ok(src.includes('comp-demo'), '{{NAME}} 未替换');
  assert.ok(!src.includes('{{NAME}}'));
});

test('extract.mjs 组件模式带 themeVars TODO 段;经典模式不带', () => {
  const { dir } = initComponent('extract');
  const comp = readFileSync(join(dir, 'extract.mjs'), 'utf8');
  assert.ok(comp.includes('TODO(主题桥,组件模式必做)'), '缺 themeVars TODO 段');
  assert.ok(comp.includes('truth.themeVars'));
  assert.ok(comp.includes('extractThemeVars'), 'themeVars TODO 应指向 extractThemeVars(不许手拼变量串)');

  const classicDir = join(tmpDir('extract-classic'), 'demo');
  run(INIT, ['--dir', classicDir, '--name', 'classic-demo']);
  const classic = readFileSync(join(classicDir, 'extract.mjs'), 'utf8');
  assert.ok(!classic.includes('themeVars'));
});

test('shims 骨架:README 硬规 + _template.ts 空骨架', () => {
  const { dir } = initComponent('shims');
  const readme = readFileSync(join(dir, 'shims/README.md'), 'utf8');
  assert.ok(readme.includes('component.shims'));
  assert.ok(readme.includes('状态机不许复刻'));
  const tpl = readFileSync(join(dir, 'shims/_template.ts'), 'utf8');
  assert.ok(tpl.includes('export {}'), '_template.ts 应是可编译的空骨架');
});

/* ───────────────────────── 参数校验 + 拒覆盖 ───────────────────────── */

test('--mode component 缺 --entry 直接拒绝', () => {
  const dir = join(tmpDir('no-entry'), 'demo');
  const res = run(INIT, ['--dir', dir, '--name', 'tmp-demo', '--mode', 'component']);
  assert.notEqual(res.status, 0);
  assert.match(json(res).error, /--entry/);
  assert.ok(!existsSync(join(dir, 'spec.json')), '校验失败不应留下半成品');
});

test('非法 --mode 拒绝;经典模式给 --entry 拒绝', () => {
  const a = run(INIT, ['--dir', join(tmpDir('bad-mode'), 'demo'), '--name', 'tmp-demo', '--mode', 'hybrid']);
  assert.notEqual(a.status, 0);
  assert.match(json(a).error, /--mode/);
  const b = run(INIT, ['--dir', join(tmpDir('classic-entry'), 'demo'), '--name', 'tmp-demo', '--entry', ENTRY]);
  assert.notEqual(b.status, 0);
  assert.match(json(b).error, /--entry/);
});

test('组件模式对已存在文件拒绝覆盖(含 build.mjs 与 src/bootstrap.tsx)', () => {
  for (const existing of ['build.mjs', 'src/bootstrap.tsx', 'shims/README.md']) {
    const dir = join(tmpDir('clash'), 'demo');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'shims'), { recursive: true });
    writeFileSync(join(dir, existing), 'KEEP');
    const res = run(INIT, ['--dir', dir, '--name', 'tmp-demo', '--mode', 'component', '--entry', ENTRY]);
    assert.notEqual(res.status, 0, `${existing} 未被拒绝`);
    assert.match(json(res).error, /拒绝覆盖/);
    assert.equal(readFileSync(join(dir, existing), 'utf8'), 'KEEP', '既有文件被改写');
    assert.ok(!existsSync(join(dir, 'spec.json')), '拒覆盖时不应写入其他文件');
  }
});

/* ───────────────────────── 旧模式回归 ───────────────────────── */

test('旧模式(不带 --mode)行为不变:四件套 + 无 component 段 + 无 adapter 段', () => {
  const dir = join(tmpDir('classic'), 'demo');
  const res = run(INIT, ['--dir', dir, '--name', 'classic-demo', '--pr', '77']);
  assert.equal(res.status, 0, res.stderr);
  const out = json(res);
  assert.deepEqual(out.files, ['spec.json', 'extract.mjs', 'extract-helpers.mjs', 'index.html']);
  assert.equal('mode' in out, false, '经典模式 stdout 不应新增字段');
  assert.deepEqual(out.next, [
    '1. 写 extract.mjs(P1 真值提取),跑 truth.mjs --demo <dir> --embed',
    '2. 填 spec.json states/verify + index.html __qaDemo 配置与 renderApp(P2)',
    '3. node scripts/states.mjs && node scripts/verify.mjs 验收(P3)',
  ]);
  const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
  assert.equal('component' in spec, false);
  assert.deepEqual(spec.matrix.platforms, ['desktop', 'mobile']);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.ok(!html.includes('QA_COMPONENT_ADAPTER'), '经典壳不该带 adapter 段');
  assert.ok(html.includes('QA_CHROME_BEGIN'));
  assert.ok(html.includes('renderApp(ctx)'), '经典壳仍需手写 renderApp');
  assert.ok(!existsSync(join(dir, 'build.mjs')) && !existsSync(join(dir, 'shims')));
  assert.equal(spec.meta.pr, 77);
});

test('--update-chrome 仍只换 chrome 段;--update-adapter 只换 adapter 段', () => {
  // 经典 demo:update-chrome 可用,update-adapter 因缺标记段被拒
  const classicDir = join(tmpDir('upd-classic'), 'demo');
  run(INIT, ['--dir', classicDir, '--name', 'cc-demo']);
  const okChrome = run(INIT, ['--dir', classicDir, '--update-chrome']);
  assert.equal(okChrome.status, 0, okChrome.stdout + okChrome.stderr);
  assert.equal(json(okChrome).block, 'QA_CHROME');
  const noAdapter = run(INIT, ['--dir', classicDir, '--update-adapter']);
  assert.notEqual(noAdapter.status, 0);
  assert.match(json(noAdapter).error, /QA_COMPONENT_ADAPTER/);

  // 组件 demo:改脏两段后各自更新,互不越界
  const { dir } = initComponent('upd-comp');
  const indexPath = join(dir, 'index.html');
  const original = readFileSync(indexPath, 'utf8');
  const dirty = original
    .replace(/(QA_COMPONENT_ADAPTER_BEGIN[\s\S]*?\*\/\n)[\s\S]*?(\n\/\* QA_COMPONENT_ADAPTER_END)/, '$1/*ADAPTER-DIRTY*/$2')
    .replace(/(QA_CHROME_BEGIN[\s\S]*?\*\/\n)[\s\S]*?(\n\/\* QA_CHROME_END)/, '$1/*CHROME-DIRTY*/$2');
  writeFileSync(indexPath, dirty);

  const upA = run(INIT, ['--dir', dir, '--update-adapter']);
  assert.equal(upA.status, 0, upA.stdout);
  let html = readFileSync(indexPath, 'utf8');
  assert.ok(!html.includes('ADAPTER-DIRTY'), 'adapter 段未被替换');
  assert.ok(html.includes('CHROME-DIRTY'), '--update-adapter 越界改了 chrome 段');

  const upC = run(INIT, ['--dir', dir, '--update-chrome']);
  assert.equal(upC.status, 0, upC.stdout);
  html = readFileSync(indexPath, 'utf8');
  assert.ok(!html.includes('CHROME-DIRTY'));
  assert.equal(html, original, '两段各更新一次后应与初始生成物一致');
});

/* ───────────────────────── build.mjs 可运行性(最小 fixture 产品仓) ───────────────────────── */

/**
 * 造一个最小「产品仓」:git init + 组件入口 + 一张 png + 一个 workspace 包 + 一个待 shim 的模块,
 * demo 落在 <repo>/_tmp/demo(与真实用法一致,repoRoot 由 findRepoRoot 经 git 定位)。
 */
function makeFixtureRepo() {
  const repo = tmpDir('repo');
  execFileSync('git', ['init', '-q', repo]);
  const rendererRoot = join(repo, 'src/renderer');
  mkdirSync(join(rendererRoot, 'components'), { recursive: true });
  mkdirSync(join(rendererRoot, 'hooks'), { recursive: true });
  mkdirSync(join(repo, 'packages/util/src'), { recursive: true });
  mkdirSync(join(repo, 'assets-src'), { recursive: true });
  // 1x1 png:走 file loader,应被落到 demo 的 assets/
  writeFileSync(
    join(repo, 'assets-src/pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'),
  );
  writeFileSync(
    join(rendererRoot, 'components/Widget.tsx'),
    [
      "import pixel from '../../../assets-src/pixel.png';",
      "import { useFlag } from '@/hooks/useFlag';",
      "import { label } from '@fixture/util/label';",
      'export function renderWidget() {',
      '  return `${label()}:${useFlag()}:${pixel}`;',
      '}',
    ].join('\n'),
  );
  // 真件:会被 shim 顶掉(断言 shim 优先级)
  writeFileSync(join(rendererRoot, 'hooks/useFlag.ts'), "export const useFlag = () => 'REAL_FLAG';\n");
  writeFileSync(join(repo, 'packages/util/src/label.ts'), "export const label = () => 'PKG_LABEL';\n");
  return repo;
}

/** 把 demo 装成 fixture 可构建的形态(react-free bootstrap:本测试验构建管线,不验 React 装配)。 */
function prepareFixtureDemo(repo) {
  const demoDir = join(repo, '_tmp/demo');
  const res = run(INIT, ['--dir', demoDir, '--name', 'fixture-demo', '--mode', 'component', '--entry', 'src/renderer/components/Widget.tsx',
    // r3:目标组件导出名(拿到「真组件直渲」结论的唯一途径;init 只在给了该 flag 时才写进 spec)
    '--entry-export', 'renderWidget']);
  assert.equal(res.status, 0, res.stdout + res.stderr);

  const specPath = join(demoDir, 'spec.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  spec.component.rendererRoot = 'src/renderer';
  spec.component.packageRoots = { '@fixture/util': 'packages/util/src' };
  spec.component.shims = [{ spec: '@/hooks/useFlag', file: 'shims/useFlag.ts', why: 'fixture:验证精确 shim 优先于 @/ 兜底' }];
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
  writeFileSync(join(demoDir, 'shims/useFlag.ts'), "export const useFlag = () => 'SHIM_FLAG';\n");
  writeFileSync(
    join(demoDir, 'src/bootstrap.tsx'),
    [
      "import { renderWidget } from '@/components/Widget';",
      'const driver = { mount(frameEl: HTMLElement) { frameEl.textContent = renderWidget(); } };',
      '(window as unknown as { __qaDemo: { inject(d: unknown): void } }).__qaDemo.inject(driver);',
    ].join('\n'),
  );
  return demoDir;
}

test('build.mjs 在 fixture 产品仓里跑通:bundle 产出 + shim 优先 + 图片落 assets/', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过构建集成(需可解析的 esbuild)');
  const repo = makeFixtureRepo();
  const demoDir = prepareFixtureDemo(repo);

  const res = run(join(demoDir, 'build.mjs'), [], { cwd: demoDir, env: { QA_HIFI_MODULE_ROOT: MODULE_ROOT }, timeout: 120000 });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = json(res);
  assert.equal(out.ok, true);
  assert.equal(out.bundle, 'assets/component.bundle.js');
  assert.deepEqual(out.shims, ['@/hooks/useFlag']);

  const bundle = readFileSync(join(demoDir, 'assets/component.bundle.js'), 'utf8');
  assert.ok(bundle.includes('SHIM_FLAG'), 'shim 未生效');
  assert.ok(!bundle.includes('REAL_FLAG'), '真件未被 shim 顶掉');
  assert.ok(bundle.includes('PKG_LABEL'), 'packageRoots alias 未生效');
  assert.ok(bundle.includes('__qaDemo'), 'inject 接线未进 bundle');

  // 图片走 file loader:assets/ 下落了独立 png,bundle 里是相对路径而非 base64
  const assets = readdirSync(join(demoDir, 'assets'));
  assert.ok(assets.some((f) => /^pixel-.*\.png$/.test(f)), `assets/ 没有落 png:${assets.join(',')}`);
  assert.ok(!bundle.includes('data:image/png;base64'), '图片被内联成 dataurl(应走 file loader)');
  assert.ok(bundle.includes('./assets/pixel-'), 'bundle 未引用 assets/ 相对路径');

  // 未配置 css 时也要有占位文件,保证 index.html 的 <link> 不 404
  assert.ok(existsSync(join(demoDir, 'assets/component.css')));
});

test('build.mjs 前置校验:缺 component 段 / entry 不存在 / shim 文件缺失都报清楚', (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过构建集成(需可解析的 esbuild)');
  const repo = makeFixtureRepo();
  const demoDir = prepareFixtureDemo(repo);
  const specPath = join(demoDir, 'spec.json');
  const good = JSON.parse(readFileSync(specPath, 'utf8'));
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };

  const cases = [
    [(s) => { delete s.component; }, /component 段/],
    [(s) => { s.component.entry = 'src/renderer/components/Nope.tsx'; }, /entry 不存在/],
    [(s) => { s.component.shims = [{ spec: '@/x', file: 'shims/missing.ts', why: 'w' }]; }, /不存在/],
    [(s) => { s.component.bootstrap = 'src/nope.tsx'; }, /bootstrap 不存在/],
  ];
  for (const [mutate, expected] of cases) {
    const spec = structuredClone(good);
    mutate(spec);
    writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
    const res = run(join(demoDir, 'build.mjs'), [], { cwd: demoDir, env, timeout: 60000 });
    assert.notEqual(res.status, 0, `应失败:${expected}`);
    const out = json(res);
    assert.equal(out.ok, false);
    assert.match(out.error, expected);
  }
});
