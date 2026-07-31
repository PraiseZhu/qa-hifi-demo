// gate-e-v2.test.mjs — 门 E v2:odiff 比对内核 / 分端基准 / Electron 采集 / 移动端脚手架。
// 独立新文件(不改 qa-hifi-demo.test.mjs),fixture 自给自足。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareImages, loadPngApi, readPng } from '../lib/png-compare.mjs';
import { buildBaselineManifest, hashFile, safeJsonForScript } from '../lib/fs-utils.mjs';
import { validatePixelReport } from '../lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PIXEL = join(ROOT, 'scripts/pixel-compare.mjs');
const CAPTURE = join(ROOT, 'scripts/capture-baseline.mjs');
const CAPTURE_MOBILE = join(ROOT, 'scripts/capture-mobile.mjs');
const STATES = join(ROOT, 'scripts/states.mjs');
// 集成用例需要 playwright/electron:从环境变量指向的项目解析(本地=CINDY 仓)
const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 60000,
  });
}

function tmpDemo(name = 'g2') {
  return mkdtempSync(join(tmpdir(), `qa-hifi-g2-${name}-`));
}

// 最小合法 spec + 最小自证 HTML(契约与旧 fixture 一致:__qa 五要素 + goto(unknown) 必抛)
function writePixelDemo({ name = 'g2', baselines, baselineDpr = 2, pixelmatchThreshold } = {}) {
  const dir = tmpDemo(name);
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1'); // provenance.source 必须是真实存在的文件(门 A 校验)
  const spec = {
    meta: { name, summary: { what: 'what', how: 'how', accept: 'accept' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: {
      // via 非空且只含 expect:声明「demo 初始就在该 case 的偏好上,无需导航」。
      // 不用 via:[]——空数组与「忘填」不可分辨,schema 已拒(审核附带收紧项)。
      cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [{ expect: 'id' }] }],
      noClip: ['.box'],
    },
    bindings: [{ sel: '.box', prop: 'color', truth: 'colors.text', kind: 'color' }],
    baselineDpr,
    ...(pixelmatchThreshold !== undefined ? { pixelmatchThreshold } : {}),
    ...(baselines ? { baselines } : {}),
  };
  const truth = { colors: { text: { value: '#ff0000', provenance: { source: 'source.txt', locator: 'fixture', hash: hashFile(source) } } } };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
  // 门 A extractor-drift 检查需要 extract.mjs;echo 同一 truth 即过(与旧 fixture 同手法)
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><style>
    .box{color:#ff0000}
    #frame{width:16px;height:16px;background:#f00}
  </style></head><body>
  <script id="qa-truth" type="application/json">${safeJsonForScript(truth)}</script>
  <div class="box">x</div><div id="frame" class="frame"></div>
  <script>
  const S={step:'id',prefs:{plat:'desk',region:'cn',os:'ios',mode:'light',lang:'zh-CN'}};
  window.__qa={
    current:()=>S.step,
    goto:(id)=>{ if(id!=='id') throw new Error('unknown'); S.step=id; },
    prefs:()=>({...S.prefs}),
    scale:()=>1,
    resize:(w,h)=>{},
  };
  </script></body></html>`);
  return dir;
}

// 纯 JS 画 PNG(走引擎真实 PNG 编解码,不经浏览器)
async function pngApi() {
  return loadPngApi(ROOT);
}

function paintPng(PNG, w, h, painter) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b, a] = painter(x, y);
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a ?? 255;
    }
  }
  return png;
}

function solidPng(PNG, w, h, rgba) {
  return paintPng(PNG, w, h, () => rgba);
}

// ============ ① odiff 比对内核 ============

test('odiff 与 pixelmatch 双路径同 fixture 判定一致(相同→PASS,大差异→超阈值)', async () => {
  const { PNG, pixelmatch, odiff } = await pngApi();
  assert.ok(pixelmatch, 'pixelmatch 应可解析');
  assert.ok(odiff, 'odiff-bin 应可解析');
  const W = 24, H = 24;
  const base = solidPng(PNG, W, H, [255, 255, 255]);
  const same = solidPng(PNG, W, H, [255, 255, 255]);
  // 非 AA 大差异:整块 8x8 实心反色块(内部像素邻域全同色,任何 AA 检测都不会吞掉)
  const diverged = paintPng(PNG, W, H, (x, y) => (x < 8 && y < 8 ? [0, 0, 0] : [255, 255, 255]));
  const baseRaw = PNG.sync.write(base);
  const threshold = 0.05; // diffRatio 判定线 5%(diverged: 64/576≈11% 必超)

  for (const engine of ['odiff', 'pixelmatch']) {
    const okRes = await compareImages({
      PNG, pixelmatch, odiff, engine,
      baselineRaw: baseRaw, actualRaw: PNG.sync.write(same),
      cssSize: { width: W, height: H }, masks: [], threshold: 0.1,
    });
    assert.equal(okRes.status, 'OK', `${engine}: ${okRes.detail}`);
    assert.equal(okRes.bad, 0, `${engine}: 相同图 bad 应为 0`);
    assert.equal(okRes.engine, engine, `${engine}: 应如实记录引擎`);
    assert.ok(0 / okRes.total <= threshold);

    const diffRes = await compareImages({
      PNG, pixelmatch, odiff, engine,
      baselineRaw: baseRaw, actualRaw: PNG.sync.write(diverged),
      cssSize: { width: W, height: H }, masks: [], threshold: 0.1,
    });
    assert.equal(diffRes.status, 'OK', `${engine}: ${diffRes.detail}`);
    const ratio = diffRes.bad / diffRes.total;
    assert.ok(ratio > threshold, `${engine}: 11% 大差异必须超 5% 阈值(实际 ${(ratio * 100).toFixed(2)}%,bad=${diffRes.bad})`);
  }
});

test('AA 噪声(边缘亚像素位移)在 odiff 路径不计入 diff,关掉 antialiasing 则计入', async () => {
  const { PNG, pixelmatch, odiff } = await pngApi();
  const W = 24, H = 24;
  // 白底上的黑色竖边:baseline 的 AA 灰列在 x=10,actual 灰列移到 x=11 —— 教科书级 AA 噪声
  const base = paintPng(PNG, W, H, (x) => (x < 10 ? [0, 0, 0] : x === 10 ? [128, 128, 128] : [255, 255, 255]));
  const act = paintPng(PNG, W, H, (x) => (x < 10 ? [0, 0, 0] : x === 10 ? [128, 128, 128] : x === 11 ? [200, 200, 200] : [255, 255, 255]));
  const baseRaw = PNG.sync.write(base);
  const actRaw = PNG.sync.write(act);

  // 先证明 fixture 真的是 AA 型噪声:odiff 关 antialiasing → 24 个坏点全计
  const probe = mkdtempSync(join(tmpdir(), 'qa-hifi-aa-'));
  writeFileSync(join(probe, 'b.png'), baseRaw);
  writeFileSync(join(probe, 'a.png'), actRaw);
  const raw = await odiff.compare(join(probe, 'b.png'), join(probe, 'a.png'), join(probe, 'd.png'), { threshold: 0.1, antialiasing: false, outputDiffMask: true });
  assert.equal(raw.match, false);
  assert.equal(raw.diffCount, 24, `fixture 应含 24 个 AA 像素(实际 ${raw.diffCount})——fixture 失效,需重调`);

  // 门 E odiff 路径(antialiasing:true):同一 fixture bad 必须为 0
  const res = await compareImages({
    PNG, pixelmatch, odiff, engine: 'odiff',
    baselineRaw: baseRaw, actualRaw: actRaw,
    cssSize: { width: W, height: H }, masks: [], threshold: 0.1,
  });
  assert.equal(res.status, 'OK', res.detail);
  assert.equal(res.engine, 'odiff');
  assert.equal(res.bad, 0, `AA 噪声不应计入 odiff diff(实际 bad=${res.bad})`);

  // 同口径下 pixelmatch 路径(includeAA:false)也是 0 —— 两引擎对 AA 的处理语义一致
  const resPm = await compareImages({
    PNG, pixelmatch, odiff, engine: 'pixelmatch',
    baselineRaw: baseRaw, actualRaw: actRaw,
    cssSize: { width: W, height: H }, masks: [], threshold: 0.1,
  });
  assert.equal(resPm.bad, 0);
});

test('odiff 不可用时 auto 回退 pixelmatch(行为不变并记录 engineNote);点名 odiff 则直接报错', async () => {
  const { PNG, pixelmatch } = await pngApi();
  const brokenOdiff = { compare: async () => { throw new Error('spawn odiff ENOENT'); } };
  const W = 16, H = 16;
  const base = solidPng(PNG, W, H, [255, 255, 255]);
  const baseRaw = PNG.sync.write(base);

  const res = await compareImages({
    PNG, pixelmatch, odiff: brokenOdiff, engine: 'auto',
    baselineRaw: baseRaw, actualRaw: baseRaw,
    cssSize: { width: W, height: H }, masks: [], threshold: 0.1,
  });
  assert.equal(res.status, 'OK', res.detail);
  assert.equal(res.engine, 'pixelmatch');
  assert.match(res.engineNote ?? '', /odiff 不可用/);
  assert.equal(res.bad, 0);

  await assert.rejects(
    compareImages({
      PNG, pixelmatch, odiff: brokenOdiff, engine: 'odiff',
      baselineRaw: baseRaw, actualRaw: baseRaw,
      cssSize: { width: W, height: H }, masks: [], threshold: 0.1,
    }),
    /ENOENT/,
    '点名 odiff 时必须把环境问题抛出来,不许静默降级',
  );
});

test('mask 护栏(面积上限/未遮罩下限)在 odiff 路径同样先于引擎拦截', async () => {
  const { PNG, pixelmatch, odiff } = await pngApi();
  const W = 16, H = 16;
  const base = solidPng(PNG, W, H, [255, 0, 0]);
  const baseRaw = PNG.sync.write(base);
  const res = await compareImages({
    PNG, pixelmatch, odiff, engine: 'odiff',
    baselineRaw: baseRaw, actualRaw: baseRaw,
    cssSize: { width: W, height: H },
    masks: [[0, 0, 16, 16]], // 全遮罩
    threshold: 0.1, maxMaskRatio: 0.25,
  });
  assert.equal(res.status, 'ERROR');
  assert.match(res.detail, /mask 面积|超上限/);
});

// review finding #1:odiff ignoreRegions 是包含式终点,mask 右/下缘不得多遮 1px
test('mask 边界:差异落 mask 最后一列/行 vs 紧邻第一列/行,odiff 与 pixelmatch 判定一致', async () => {
  const { PNG, pixelmatch, odiff } = await pngApi();
  const W = 4, H = 4;
  const base = solidPng(PNG, W, H, [10, 10, 10]);
  const withDiffAt = (x, y) => {
    const p = solidPng(PNG, W, H, [10, 10, 10]);
    const i = (y * W + x) * 4;
    p.data[i] = 200; p.data[i + 1] = 200; p.data[i + 2] = 200;
    return p;
  };
  const baseRaw = PNG.sync.write(base);
  const masks = [[1, 1, 2, 2]]; // 遮 (1,1)(2,1)(1,2)(2,2):最后一列 x=2、最后一行 y=2
  const cases = [
    ['mask 内最后一列+最后一行(2,2)', 2, 2, 0],
    ['紧邻 mask 右缘第一列(3,2)', 3, 2, 1],
    ['紧邻 mask 下缘第一行(2,3)', 2, 3, 1],
    ['紧邻 mask 右缘+下缘角(3,3)', 3, 3, 1],
  ];
  for (const [label, dx, dy, expectBad] of cases) {
    const actRaw = PNG.sync.write(withDiffAt(dx, dy));
    for (const engine of ['odiff', 'pixelmatch']) {
      const res = await compareImages({
        PNG, pixelmatch, odiff, engine,
        baselineRaw: baseRaw, actualRaw: actRaw,
        cssSize: { width: W, height: H }, masks,
        threshold: 0.1, maxMaskRatio: 0.5, minUnmaskedRatio: 0.5,
      });
      assert.equal(res.status, 'OK', `${engine} ${label}: ${res.detail}`);
      assert.equal(res.masked, 4, `${engine} ${label}: masked 应为 4`);
      assert.equal(res.total, 12, `${engine} ${label}: total 应为 12`);
      assert.equal(res.bad, expectBad, `${engine} ${label}: bad 应为 ${expectBad}(mask 边缘多遮/少遮 1px 会让此值翻转)`);
    }
  }
});

// 终审缺口 #1b:零面积/完全出界 mask 在 maskBitmap 里 0 贡献,语义等同无 mask——
// 不得因 ignoreRegions 过滤后为空数组而让 odiff 抛 --ignore "" 错
test('mask 零面积/出界等同无 mask:点名 odiff 不抛不降级,bad 与无 mask 一致(终审缺口 #1b)', async () => {
  const { PNG, pixelmatch, odiff } = await pngApi();
  const W = 8, H = 8;
  const base = solidPng(PNG, W, H, [10, 10, 10]);
  const act = solidPng(PNG, W, H, [10, 10, 10]);
  const i = (5 * W + 5) * 4; // 一个真实差异点(任何 mask 都没遮它)
  act.data[i] = 200; act.data[i + 1] = 200; act.data[i + 2] = 200;
  const baseRaw = PNG.sync.write(base);
  const actRaw = PNG.sync.write(act);
  const ref = await compareImages({
    PNG, pixelmatch, odiff, engine: 'odiff',
    baselineRaw: baseRaw, actualRaw: actRaw,
    cssSize: { width: W, height: H }, masks: [], threshold: 0.1,
  });
  assert.equal(ref.status, 'OK');
  assert.equal(ref.bad, 1, '无 mask 参照应检出 1 个坏点');
  for (const [label, masks] of [
    ['零宽 mask [0,0,0,1]', [[0, 0, 0, 1]]],
    ['零高 mask [0,0,1,0]', [[0, 0, 1, 0]]],
    ['完全出界 mask [100,100,5,5]', [[100, 100, 5, 5]]],
  ]) {
    const res = await compareImages({
      PNG, pixelmatch, odiff, engine: 'odiff',
      baselineRaw: baseRaw, actualRaw: actRaw,
      cssSize: { width: W, height: H }, masks, threshold: 0.1,
    });
    assert.equal(res.status, 'OK', `${label}: 点名 odiff 不得抛错(${res.detail})`);
    assert.equal(res.engine, 'odiff', `${label}: 不得静默降级`);
    assert.ok(!res.engineNote, `${label}: 不得有降级 engineNote`);
    assert.equal(res.bad, ref.bad, `${label}: bad 应与无 mask 时一致`);
  }
});

// ============ ② 分端基准(platform) ============

test('manifest 覆盖分端子目录:平铺 + <platform>/<key>.png 混合,declared 同构', async () => {
  const { PNG } = await pngApi();
  const dir = tmpDemo('manifest');
  const png = PNG.sync.write(solidPng(PNG, 4, 4, [255, 0, 0]));
  mkdirSync(join(dir, 'baselines/web'), { recursive: true });
  mkdirSync(join(dir, 'baselines/ios'), { recursive: true });
  writeFileSync(join(dir, 'baselines/legacy.png'), png);
  writeFileSync(join(dir, 'baselines/web/login.png'), png);
  writeFileSync(join(dir, 'baselines/ios/login.png'), png);
  const spec = {
    baselines: [
      { key: 'legacy' },
      { key: 'login', platform: 'web' },
      { key: 'login', platform: 'ios' },
    ],
  };
  const m = buildBaselineManifest(dir, spec);
  assert.deepEqual(m.declared.sort(), ['ios/login', 'legacy', 'web/login']);
  assert.deepEqual(m.files.map((f) => f.key).sort(), ['ios/login', 'legacy', 'web/login']);
  assert.ok(m.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
});

test('schema: 非法 platform 拒绝;同一 key 跨 platform 允许、同端重复拒绝', () => {
  const bad = writePixelDemo({ name: 'bad-platform', baselines: [{ key: 'one', platform: 'webos' }] });
  const r1 = run(STATES, ['--demo', bad]);
  assert.equal(r1.status, 2);
  assert.match(r1.stdout, /platform 必须是/);

  const dup = writePixelDemo({
    name: 'dup-platform',
    baselines: [{ key: 'one', platform: 'ios' }, { key: 'one', platform: 'ios' }],
  });
  const r2 = run(STATES, ['--demo', dup]);
  assert.equal(r2.status, 2);
  assert.match(r2.stdout, /platform\+key 组合重复/);

  const crossOk = writePixelDemo({
    name: 'cross-ok',
    baselines: [{ key: 'one', platform: 'ios' }, { key: 'one', platform: 'android' }, { key: 'one' }],
  });
  const r3 = run(STATES, ['--demo', crossOk]);
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
});

test('分端目录解析:platform=web 命中 baselines/web/;旧式无 platform 命中平铺;声明了端却没图=MISSING', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成(需 playwright)');
  const { PNG } = await pngApi();
  // 16x16 CSS 帧 × dpr2 = 32x32 纯红基准(与 fixture HTML 渲染一致)
  const framePng = PNG.sync.write(solidPng(PNG, 32, 32, [255, 0, 0]));
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };

  // ① 分端:platform=web,图在 baselines/web/one.png → PASS 且走 odiff
  const d1 = writePixelDemo({ name: 'plat-web', baselines: [{ key: 'one', platform: 'web', frameSel: '#frame' }] });
  mkdirSync(join(d1, 'baselines/web'), { recursive: true });
  writeFileSync(join(d1, 'baselines/web/one.png'), framePng);
  const r1 = run(PIXEL, ['--demo', d1], { env, timeout: 90000 });
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  const rep1 = JSON.parse(readFileSync(join(d1, 'report-pixel.json'), 'utf8'));
  assert.equal(rep1.results[0].status, 'PASS');
  assert.equal(rep1.results[0].platform, 'web');
  assert.equal(rep1.results[0].engine, 'odiff');
  assert.equal(rep1.results[0].bad, 0);

  // ② 旧式兼容:无 platform,图在平铺 baselines/one.png → PASS(行为与旧版一致)
  const d2 = writePixelDemo({ name: 'plat-legacy', baselines: [{ key: 'one', frameSel: '#frame' }] });
  mkdirSync(join(d2, 'baselines'), { recursive: true });
  writeFileSync(join(d2, 'baselines/one.png'), framePng);
  const r2 = run(PIXEL, ['--demo', d2], { env, timeout: 90000 });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const rep2 = JSON.parse(readFileSync(join(d2, 'report-pixel.json'), 'utf8'));
  assert.equal(rep2.results[0].status, 'PASS');
  assert.equal(rep2.results[0].platform, undefined);

  // ③ 声明 platform=ios 但图只在平铺位置 → 必须 MISSING(分端不 fallback 到平铺,防张冠李戴)
  const d3 = writePixelDemo({ name: 'plat-missing', baselines: [{ key: 'one', platform: 'ios', frameSel: '#frame' }] });
  mkdirSync(join(d3, 'baselines'), { recursive: true });
  writeFileSync(join(d3, 'baselines/one.png'), framePng);
  const r3 = run(PIXEL, ['--demo', d3], { env, timeout: 90000 });
  assert.equal(r3.status, 2);
  const rep3 = JSON.parse(readFileSync(join(d3, 'report-pixel.json'), 'utf8'));
  assert.equal(rep3.results[0].status, 'MISSING');
  assert.match(rep3.results[0].detail, /baselines\/ios\/one\.png/);
});

// ============ ③ Electron 真壳采集 ============

function writeMinimalElectronApp() {
  const dir = tmpDemo('electron-app');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'qa-hifi-min-app', version: '0.0.0', main: 'main.js' }));
  // 20 行最小 app:强制 DPR2(截图尺寸可断言),加载带 .frame 的极简页
  writeFileSync(join(dir, 'main.js'), `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 320, height: 240,
    webPreferences: { backgroundThrottling: false },
  });
  const html = '<!doctype html><html><head><style>body{margin:0}.frame{width:16px;height:16px;background:#f00}</style></head><body><div class="frame"></div></body></html>';
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
});
app.on('window-all-closed', () => app.quit());
`);
  return dir;
}

test('--electron-app 最小 Electron app 截图成功并落分端目录', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成(需 playwright + electron)');
  const { PNG } = await pngApi();
  const appDir = writeMinimalElectronApp();
  const demo = writePixelDemo({
    name: 'electron-cap',
    baselines: [{ key: 'electron-one', platform: 'electron-mac', frameSel: '.frame' }],
  });
  const res = run(
    CAPTURE,
    ['--demo', demo, '--key', 'electron-one', '--electron-app', appDir],
    { env: { QA_HIFI_MODULE_ROOT: MODULE_ROOT }, timeout: 120000 },
  );
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'electron-capture');
  assert.equal(out.out, 'baselines/electron-mac/electron-one.png');
  const outFile = join(demo, 'baselines/electron-mac/electron-one.png');
  assert.ok(existsSync(outFile), `基准未落盘:${outFile}`);
  const png = readPng(PNG, outFile);
  // .frame = 16x16 CSS × force-device-scale-factor 2 = 32x32(容差 2×dpr)
  assert.ok(Math.abs(png.width - 32) <= 4 && Math.abs(png.height - 32) <= 4, `截图尺寸异常:${png.width}x${png.height}`);
});

// ============ ④ 移动端采集脚手架(capture-mobile) ============

test('capture-mobile: @3x 截图 DPR 归一化到 ×2 并落 ios 分端目录', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成(需 playwright)');
  const { PNG } = await pngApi();
  // 模拟 @3x 真机截图:16x16 CSS 帧 × 3 = 48x48 纯红
  const shot = join(tmpDemo('shot3x'), 'ios-shot.png');
  writeFileSync(shot, PNG.sync.write(solidPng(PNG, 48, 48, [255, 0, 0])));
  const demo = writePixelDemo({ name: 'mobile-3x', baselines: [{ key: 'one', platform: 'ios', frameSel: '#frame' }] });
  const res = run(
    CAPTURE_MOBILE,
    ['--demo', demo, '--key', 'one', '--png', shot, '--device-dpr', '3'],
    { env: { QA_HIFI_MODULE_ROOT: MODULE_ROOT }, timeout: 90000 },
  );
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'mobile-import');
  assert.equal(out.out, 'baselines/ios/one.png');
  assert.deepEqual(out.normalized, { width: 32, height: 32 });
  const png = readPng(PNG, join(demo, 'baselines/ios/one.png'));
  assert.equal(png.width, 32);
  assert.equal(png.height, 32);
});

test('capture-mobile: 归一化后尺寸与 demo 帧不符 → 拒收(防截错帧)', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成(需 playwright)');
  const { PNG } = await pngApi();
  // 48x48 但声称 device-dpr=2 → 不缩放,48 ≠ 32±4 → 必须拒
  const shot = join(tmpDemo('shot-bad'), 'bad.png');
  writeFileSync(shot, PNG.sync.write(solidPng(PNG, 48, 48, [255, 0, 0])));
  const demo = writePixelDemo({ name: 'mobile-bad', baselines: [{ key: 'one', platform: 'android', frameSel: '#frame' }] });
  const res = run(
    CAPTURE_MOBILE,
    ['--demo', demo, '--key', 'one', '--png', shot, '--device-dpr', '2'],
    { env: { QA_HIFI_MODULE_ROOT: MODULE_ROOT }, timeout: 90000 },
  );
  assert.equal(res.status, 2);
  assert.match(res.stdout, /不符|拒绝作为基准/);
  assert.ok(!existsSync(join(demo, 'baselines/android/one.png')), '拒收时不得落盘');
});

test('capture-mobile: --crop-top 裁掉状态栏后取到的必须是目标区域', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成(需 playwright)');
  const { PNG } = await pngApi();
  // 48x96:上半绿色(状态栏)下半红色(目标帧) → --crop-top 48 后应取到纯红 48x48 → 归一化 32x32
  const shot = join(tmpDemo('shot-crop'), 'crop.png');
  writeFileSync(shot, PNG.sync.write(paintPng(PNG, 48, 96, (x, y) => (y < 48 ? [0, 200, 0] : [255, 0, 0]))));
  const demo = writePixelDemo({ name: 'mobile-crop', baselines: [{ key: 'one', platform: 'ios', frameSel: '#frame' }] });
  const res = run(
    CAPTURE_MOBILE,
    ['--demo', demo, '--key', 'one', '--png', shot, '--device-dpr', '3', '--crop-top', '48'],
    { env: { QA_HIFI_MODULE_ROOT: MODULE_ROOT }, timeout: 90000 },
  );
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.cropRect, { sx: 0, sy: 48, sw: 48, sh: 48 });
  const png = readPng(PNG, join(demo, 'baselines/ios/one.png'));
  assert.equal(png.width, 32);
  // 中心像素必须是红色(裁到的是下半),不是绿色——证明裁切方向正确
  const i = (16 * 32 + 16) * 4;
  assert.ok(png.data[i] > 200 && png.data[i + 1] < 60, `裁切结果颜色异常:(${png.data[i]},${png.data[i + 1]},${png.data[i + 2]})`);
});

// ============ ⑤ report-pixel 防伪对应校验(review finding #2) ============

const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');

function realReports(demoDir, env) {
  const v = run(VERIFY, ['--demo', demoDir], { env, timeout: 150000 });
  assert.equal(v.status, 0, `verify 必须先绿:${v.stdout}${v.stderr}`);
  const p = run(PIXEL, ['--demo', demoDir], { env, timeout: 150000 });
  assert.equal(p.status, 0, `pixel-compare 必须先绿:${p.stdout}${p.stderr}`);
  return JSON.parse(readFileSync(join(demoDir, 'report-pixel.json'), 'utf8'));
}

function writeDemoWithBaselines(name, entries) {
  return (async () => {
    const { PNG } = await pngApi();
    const dir = writePixelDemo({ name, baselines: entries.map((e) => ({ frameSel: '#frame', ...e })) });
    const png = PNG.sync.write(solidPng(PNG, 32, 32, [255, 0, 0]));
    for (const e of entries) {
      const sub = e.platform ? join(dir, 'baselines', e.platform) : join(dir, 'baselines');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `${e.key}.png`), png);
    }
    return dir;
  })();
}

test('finding #2: 手写 ok:true + 空 results + 当前 hash → 拒绝(审核人复现样本)', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-empty', [{ key: 'one', platform: 'web' }]);
  const real = realReports(dir, env);
  // 审核人复现样本:declared 对、compared 0、results 空、inputHashes 用真的
  writeFileSync(join(dir, 'report-pixel.json'), JSON.stringify({
    ok: true, skipped: false, toolVersion: real.toolVersion,
    declared: 1, compared: 0, results: [], inputHashes: real.inputHashes,
  }, null, 2) + '\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 2, `伪造样本居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /results|漏端|缺 results/);
});

test('finding #2: 漏一端结果(ios 条目被摘掉)→ 拒绝', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-missing', [{ key: 'one', platform: 'web' }, { key: 'one', platform: 'ios' }]);
  const real = realReports(dir, env);
  real.results = real.results.filter((r) => r.platform === 'web');
  real.compared = real.results.length;
  writeFileSync(join(dir, 'report-pixel.json'), JSON.stringify(real, null, 2) + '\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 2);
  assert.match(pr.stdout + pr.stderr, /缺 spec 声明|数量.*不一致|ios\/one/);
});

test('finding #2: 复合 key 重复(同一条目出现两次)→ 拒绝', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-dup', [{ key: 'one', platform: 'web' }, { key: 'one', platform: 'ios' }]);
  const real = realReports(dir, env);
  real.results = [real.results[0], real.results[0]]; // web 两条、ios 被顶掉
  writeFileSync(join(dir, 'report-pixel.json'), JSON.stringify(real, null, 2) + '\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 2);
  assert.match(pr.stdout + pr.stderr, /重复/);
});

test('finding #2: 伪造计数(diffRatio 与 bad/total 不符)→ 拒绝', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-count', [{ key: 'one', platform: 'web' }]);
  const real = realReports(dir, env);
  real.results[0].diffRatio = 0.5; // bad=0 却报 50% diff——手写痕迹
  writeFileSync(join(dir, 'report-pixel.json'), JSON.stringify(real, null, 2) + '\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 2);
  assert.match(pr.stdout + pr.stderr, /diffRatio|不一致/);
});

test('finding #2 阳性对照:真实报告(带 engine 字段)照常放行,防过紧误伤', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-none', [{ key: 'one', platform: 'web' }]);
  const real = realReports(dir, env);
  assert.equal(real.results[0].engine, 'odiff', 'pixel-compare 应把 engine 写进 results');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 0, `真实报告被误伤:${pr.stdout}${pr.stderr}`);
});

// ============ ⑤b status 结论与阈值一致性(终审缺口 #2b) ============

test('finding #2b: 高 diff 伪 PASS(bad:50/100,diffRatio:0.5)→ 拒绝(终审人复现样本)', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-hidiff', [{ key: 'one', platform: 'web' }]);
  const real = realReports(dir, env);
  // 终审人样本:计数自洽、engine 合法,但 50% 差异伪装 PASS
  real.results[0] = { ...real.results[0], status: 'PASS', bad: 50, total: 100, masked: 0, diffRatio: 0.5, engine: 'odiff' };
  writeFileSync(join(dir, 'report-pixel.json'), JSON.stringify(real, null, 2) + '\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 2, `伪 PASS 居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /伪 PASS|超阈值/);
});

test('finding #2b: 零 diff 伪 WARN → 拒绝', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-lowwarn', [{ key: 'one', platform: 'web' }]);
  const real = realReports(dir, env);
  real.results[0] = { ...real.results[0], status: 'WARN', bad: 0, total: 100, masked: 0, diffRatio: 0, engine: 'odiff' };
  writeFileSync(join(dir, 'report-pixel.json'), JSON.stringify(real, null, 2) + '\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 2);
  assert.match(pr.stdout + pr.stderr, /伪 WARN|未超阈值/);
});

test('finding #2b: 伪 engine(photoshop)→ 拒绝', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-engine', [{ key: 'one', platform: 'web' }]);
  const real = realReports(dir, env);
  real.results[0].engine = 'photoshop';
  writeFileSync(join(dir, 'report-pixel.json'), JSON.stringify(real, null, 2) + '\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 2);
  assert.match(pr.stdout + pr.stderr, /engine 非法|photoshop/);
});

test('finding #2b: 阈值篡改(report.threshold=0.9)→ 拒绝', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-threshold', [{ key: 'one', platform: 'web' }]);
  const real = realReports(dir, env);
  real.threshold = 0.9;
  writeFileSync(join(dir, 'report-pixel.json'), JSON.stringify(real, null, 2) + '\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 2);
  assert.match(pr.stdout + pr.stderr, /threshold|篡改/);
});

test('finding #2b 阳性对照:更严校验下真实报告仍放行', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-none-2b', [{ key: 'one', platform: 'web' }]);
  const real = realReports(dir, env);
  assert.equal(real.threshold, 0.005);
  assert.ok(real.results[0].diffRatio <= real.threshold);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 0, `真实报告被误伤:${pr.stdout}${pr.stderr}`);
});

// ============ ⑥ 采集器复合键查找(review finding #4) ============

test('finding #4: 同 key 双端,capture-baseline 不传 --platform 拒绝并列候选;传 android 正确落位', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const { PNG } = await pngApi();
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const entries = [{ key: 'one', platform: 'ios' }, { key: 'one', platform: 'android' }];
  const shot = join(tmpDemo('import-dual'), 'shot.png');
  writeFileSync(shot, PNG.sync.write(solidPng(PNG, 32, 32, [255, 0, 0])));

  const d1 = writePixelDemo({ name: 'dual-noplat', baselines: entries.map((e) => ({ frameSel: '#frame', ...e })) });
  const r1 = run(CAPTURE, ['--demo', d1, '--key', 'one', '--from-png', shot], { env, timeout: 90000 });
  assert.equal(r1.status, 2);
  assert.match(r1.stdout, /必须加 --platform|ios.*android|android.*ios/);
  assert.ok(!existsSync(join(d1, 'baselines/ios/one.png')) && !existsSync(join(d1, 'baselines/android/one.png')), '拒绝时不得落任何一端');

  const d2 = writePixelDemo({ name: 'dual-plat', baselines: entries.map((e) => ({ frameSel: '#frame', ...e })) });
  const r2 = run(CAPTURE, ['--demo', d2, '--key', 'one', '--platform', 'android', '--from-png', shot], { env, timeout: 90000 });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(JSON.parse(r2.stdout).out, 'baselines/android/one.png');
  assert.ok(existsSync(join(d2, 'baselines/android/one.png')));
  assert.ok(!existsSync(join(d2, 'baselines/ios/one.png')), '指定 android 不得碰 ios 目录');
});

test('finding #4: capture-mobile 同 key 双端同样 fail-closed;--platform ios 正确落位', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const { PNG } = await pngApi();
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const entries = [{ key: 'one', platform: 'ios' }, { key: 'one', platform: 'android' }];
  const shot = join(tmpDemo('mobile-dual'), 'shot3x.png');
  writeFileSync(shot, PNG.sync.write(solidPng(PNG, 48, 48, [255, 0, 0])));

  const d1 = writePixelDemo({ name: 'mdual-noplat', baselines: entries.map((e) => ({ frameSel: '#frame', ...e })) });
  const r1 = run(CAPTURE_MOBILE, ['--demo', d1, '--key', 'one', '--png', shot, '--device-dpr', '3'], { env, timeout: 90000 });
  assert.equal(r1.status, 2);
  assert.match(r1.stdout, /必须加 --platform/);

  const d2 = writePixelDemo({ name: 'mdual-plat', baselines: entries.map((e) => ({ frameSel: '#frame', ...e })) });
  const r2 = run(CAPTURE_MOBILE, ['--demo', d2, '--key', 'one', '--platform', 'ios', '--png', shot, '--device-dpr', '3'], { env, timeout: 90000 });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(JSON.parse(r2.stdout).out, 'baselines/ios/one.png');
  assert.ok(existsSync(join(d2, 'baselines/ios/one.png')));
});

test('finding #4: --electron-app 采集 electron-win 条目在非 Windows 宿主直接拒绝(不启动 app)', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  if (process.platform === 'win32') return t.skip('本用例只在非 Windows 宿主有意义');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const demo = writePixelDemo({ name: 'electron-wronghost', baselines: [{ key: 'e', platform: 'electron-win', frameSel: '.frame' }] });
  const bogusApp = tmpDemo('bogus-app'); // 宿主校验应先于 app 解析/启动
  const res = run(CAPTURE, ['--demo', demo, '--key', 'e', '--electron-app', bogusApp], { env, timeout: 60000 });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /electron-win|宿主|拒绝/);
  assert.ok(!existsSync(join(demo, 'baselines/electron-win/e.png')), '拒绝时不得落盘');
});

// ============ ⑤c 零分母绕过(终审第三轮缺口 #2c) ============

test('finding #2c: 零分母伪 PASS(bad:50,total:0,diffRatio:0)→ 拒绝(终审人复现样本)', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-zerodenom', [{ key: 'one', platform: 'ios' }]);
  const real = realReports(dir, env);
  // 终审人样本:total=0 跳过自洽校验、diffRatio 手写 0 ≤ threshold → 旧代码放行
  real.results[0] = { ...real.results[0], status: 'PASS', bad: 50, total: 0, masked: 0, diffRatio: 0, engine: 'odiff' };
  writeFileSync(join(dir, 'report-pixel.json'), JSON.stringify(real, null, 2) + '\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 2, `零分母伪 PASS 居然放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout + pr.stderr, /total 必须是正整数|零比对/);
});

test('finding #2c: bad>total 与 diffRatio 越界([0,1] 外)均拒绝', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeDemoWithBaselines('forge-badgtotal', [{ key: 'one', platform: 'web' }]);
  const real = realReports(dir, env);
  real.results[0] = { ...real.results[0], status: 'PASS', bad: 200, total: 100, masked: 0, diffRatio: 2, engine: 'odiff' };
  writeFileSync(join(dir, 'report-pixel.json'), JSON.stringify(real, null, 2) + '\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team'], { env });
  assert.equal(pr.status, 2);
  assert.match(pr.stdout + pr.stderr, /bad\(200\) > total\(100\)|\[0,1\]/);
});

// ============ ⑤ r8:WARN 人工裁决必须绑定 key/diffRatio/threshold/三图 sha256 ============
//
// r7 只绑三图字节 —— 挡得住「换图」,挡不住「换差异」:同一 key 上一次小幅 WARN 的裁决,在差异
// 变大、三图跟着重跑更新之后,旧裁决的语义(判的是 0.1% 还是 8%)此前无人核对,于是「小幅差异
// 的人工放行」可以被复用到后续任意大幅 WARN 上。r8 起裁决必须同时声明并全等四项;key 用含
// platform 的复合形式(`<platform>/<key>`,与 report.mjs 校验用的 ck 同构),因为基准分端存放、
// 永不互比,mac 端的裁决不得给 windows 端的 WARN 用。

/** 造一个必然 WARN 的 demo:#frame 是纯红,基准图把 `bad` 个像素涂蓝 → diffRatio = bad/1024。 */
async function writeWarnDemo(name, { bad, platform = 'web' } = {}) {
  const { PNG } = await pngApi();
  const dir = writePixelDemo({ name, baselines: [{ key: 'one', platform, frameSel: '#frame' }] });
  writeWarnBaseline(dir, PNG, { bad, platform });
  return dir;
}

function writeWarnBaseline(dir, PNG, { bad, platform = 'web' } = {}) {
  const png = paintPng(PNG, 32, 32, (x, y) => (y * 32 + x < bad ? [0, 0, 255] : [255, 0, 0]));
  const sub = join(dir, 'baselines', platform);
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'one.png'), PNG.sync.write(png));
}

const ADJ_REL = 'adjudications/web.one.json';
function writeAdj(dir, fields) {
  mkdirSync(join(dir, 'adjudications'), { recursive: true });
  writeFileSync(join(dir, ADJ_REL), `${JSON.stringify({ ok: true, reviewer: '张三', reason: '底色改版预期差异', ...fields }, null, 2)}\n`);
}
const pixelReport = (dir) => JSON.parse(readFileSync(join(dir, 'report-pixel.json'), 'utf8'));
const specOf = (dir) => JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
/** 只跑 report.mjs 侧的校验(pr-block 对 demo 自报 report 走的就是这条),回传 problems。 */
const validatePixelReportR8 = (dir, rep) => validatePixelReport(dir, specOf(dir), rep).problems;
/** 跑一次门 E,回传 {status, out, item} —— item 是唯一那条比对结果。 */
function runPixel(dir, env) {
  const p = run(PIXEL, ['--demo', dir], { env, timeout: 150000 });
  const rep = pixelReport(dir);
  return { status: p.status, out: p.stdout + p.stderr, item: rep.results[0], rep };
}
/** 四项全部取自本次现算的合法裁决字段。 */
const boundFields = (item) => ({
  key: `${item.platform}/${item.key}`,
  diffRatio: item.diffRatio,
  threshold: 0.005,
  artifactHashes: item.artifactHashes,
});

test('r8: 裁决只绑三图 sha256(缺 key/diffRatio/threshold)→ 拒并点名缺失字段', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeWarnDemo('r8-missing', { bad: 8 });
  const first = runPixel(dir, env);
  assert.equal(first.item.status, 'WARN', `前提:必须是 WARN(diffRatio=${first.item.diffRatio})`);
  // r7 式裁决:hash 绑对,但没声明这次判的是哪个 key、多大差异、什么阈值
  writeAdj(dir, { artifactHashes: first.item.artifactHashes });
  const second = runPixel(dir, env);
  assert.notEqual(second.status, 0, 'r7 式裁决(只绑三图)仍被采纳 —— r8 语义绑定未生效');
  assert.equal(second.item.adjudication, undefined, '缺语义字段的裁决不该被采纳');
  const reason = second.item.adjudicationRejected?.reason ?? '';
  assert.match(reason, /缺字段/);
  for (const f of ['key', 'diffRatio', 'threshold']) assert.match(reason, new RegExp(f), `拒收原因必须点名缺 ${f}`);
  // report.mjs 侧同样要拦(demo 自报 report 里塞一份缺字段的裁决)
  const rep = pixelReport(dir);
  rep.results[0].adjudication = { ok: true, reviewer: '张三', reason: 'r', artifactHashes: rep.results[0].artifactHashes };
  const v = validatePixelReportR8(dir, rep);
  assert.ok(v.some((p) => /缺 diffRatio/.test(p)), `report.mjs 未拦缺字段裁决:${JSON.stringify(v)}`);
});

test('r8: 裁决声明的 diffRatio/threshold 与本次现算不符 → 拒并打印两个值的对照', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeWarnDemo('r8-wrongvalue', { bad: 80 });
  const first = runPixel(dir, env);
  assert.equal(first.item.status, 'WARN');
  assert.ok(first.item.diffRatio > 0.05, `前提:本次差异要明显(实际 ${first.item.diffRatio})`);
  writeAdj(dir, { ...boundFields(first.item), diffRatio: 0.001, threshold: 0.01 });
  const second = runPixel(dir, env);
  assert.notEqual(second.status, 0, '错值裁决被采纳了');
  const reason = second.item.adjudicationRejected?.reason ?? '';
  assert.match(reason, /diffRatio/);
  assert.match(reason, /0\.001/, '报文必须含裁决声明值');
  assert.match(reason, new RegExp(String(second.item.diffRatio).replace('.', '\\.')), '报文必须含本次现算值');
  // report.mjs 侧:同一份错值裁决塞进 report 也要被拦,且同样打印两个值
  const rep = pixelReport(dir);
  rep.results[0].adjudication = { ok: true, reviewer: '张三', reason: 'r', ...boundFields(rep.results[0]), diffRatio: 0.001 };
  const v = validatePixelReportR8(dir, rep);
  assert.ok(
    v.some((p) => /diffRatio 与本次现算不符/.test(p) && p.includes('0.001') && p.includes(String(rep.results[0].diffRatio))),
    `report.mjs 未打印裁决声明值 vs 本次现算值:${JSON.stringify(v)}`,
  );
});

test('r8 核心: 小幅 WARN 的旧裁决,在差异变大后(三图 hash 已更新)不得复用 → 拒', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const { PNG } = await pngApi();
  const dir = await writeWarnDemo('r8-stale', { bad: 8 });
  // ① 小幅 WARN + 一份当时合法的裁决 → 放行(阳性对照)
  const small = runPixel(dir, env);
  assert.equal(small.item.status, 'WARN');
  const staleFields = boundFields(small.item);
  writeAdj(dir, staleFields);
  const ok1 = runPixel(dir, env);
  assert.equal(ok1.status, 0, `前提:四项一致的裁决必须放行:${ok1.out}`);
  assert.equal(ok1.item.adjudication?.reviewer, '张三');
  assert.equal(run(VERIFY, ['--demo', dir], { env, timeout: 150000 }).status, 0);
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team'], { env, timeout: 150000 });
  assert.equal(pr.status, 0, `四项一致却不放行:${pr.stdout}${pr.stderr}`);
  assert.match(pr.stdout, /张三/, 'PR 里必须能看到裁决人');
  assert.match(pr.stdout, /底色改版预期差异/, 'PR 里必须能看到裁决理由');

  // ② 差异变大(基准换成 200px 蓝),重跑 → 三图字节随之更新
  writeWarnBaseline(dir, PNG, { bad: 200 });
  const big = runPixel(dir, env);
  assert.equal(big.item.status, 'WARN');
  assert.ok(big.item.diffRatio > small.item.diffRatio * 5, `前提:差异必须明显变大(${small.item.diffRatio} → ${big.item.diffRatio})`);

  // ③ 只把旧裁决的 diffRatio/threshold 留成旧值,三图 hash 补成新的
  //    → 这正是「三图 hash 对得上但语义字段过期」,r7 会放行,r8 必须拒
  writeAdj(dir, {
    key: staleFields.key,
    diffRatio: staleFields.diffRatio,
    threshold: staleFields.threshold,
    artifactHashes: big.item.artifactHashes,
  });
  const reused = runPixel(dir, env);
  const KINDS = ['baseline', 'demo', 'diff'];
  assert.ok(
    KINDS.every((k) => reused.item.artifactHashes[k] === big.item.artifactHashes[k]),
    '前提:这一跑的三图 hash 必须与裁决声明的一致(否则测的还是三图绑定那条)',
  );
  assert.notEqual(reused.status, 0, '旧裁决在差异变大后仍被复用 —— r8 核心场景未修');
  assert.equal(reused.item.adjudication, undefined);
  const reason = reused.item.adjudicationRejected?.reason ?? '';
  assert.match(reason, /diffRatio/, `拒收原因必须指向 diffRatio 过期,而不是三图 hash:${reason}`);
  assert.doesNotMatch(reason, /sha256 与本次可信侧产出不符/, '不该被误判成换图');
  assert.ok(reason.includes(String(staleFields.diffRatio)) && reason.includes(String(reused.item.diffRatio)));
  // report.mjs 侧同样拦
  const v = validatePixelReportR8(dir, { ...reused.rep, results: [{ ...reused.item, adjudication: JSON.parse(readFileSync(join(dir, ADJ_REL), 'utf8')) }] });
  assert.ok(v.some((p) => /diffRatio 与本次现算不符/.test(p)), `report.mjs 未拦旧裁决复用:${JSON.stringify(v)}`);
});

test('r8: 裁决 key 必须含 platform —— 裸 key 或另一端的 key 都拒(基准分端永不互比)', async (t) => {
  if (!MODULE_ROOT) return t.skip('QA_HIFI_MODULE_ROOT 未设置,跳过集成');
  const env = { QA_HIFI_MODULE_ROOT: MODULE_ROOT };
  const dir = await writeWarnDemo('r8-key', { bad: 8, platform: 'web' });
  const first = runPixel(dir, env);
  assert.equal(first.item.status, 'WARN');
  for (const wrong of ['one', 'ios/one']) {
    writeAdj(dir, { ...boundFields(first.item), key: wrong });
    const r = runPixel(dir, env);
    assert.notEqual(r.status, 0, `key=${wrong} 的裁决被采纳了`);
    assert.match(r.item.adjudicationRejected?.reason ?? '', /key 不符/);
    assert.match(r.item.adjudicationRejected?.reason ?? '', /web\/one/, '报文必须给出本次期望的复合 key');
  }
  // 阳性对照:复合 key 正确 → 放行
  writeAdj(dir, boundFields(first.item));
  assert.equal(runPixel(dir, env).status, 0);
});
