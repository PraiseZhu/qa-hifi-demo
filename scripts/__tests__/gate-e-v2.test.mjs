// gate-e-v2.test.mjs — 门 E v2:odiff 比对内核 / 分端基准 / Electron 采集 / 移动端脚手架。
// 独立新文件(不改 qa-hifi-demo.test.mjs),fixture 自给自足。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareImages, loadPngApi } from '../lib/png-compare.mjs';
import { buildBaselineManifest } from '../lib/fs-utils.mjs';

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
  const spec = {
    meta: { name, summary: { what: 'what', how: 'how', accept: 'accept' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: {
      cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [] }],
      noClip: ['.box'],
    },
    bindings: [{ sel: '.box', prop: 'color', truth: 'colors.text', kind: 'color' }],
    baselineDpr,
    ...(pixelmatchThreshold !== undefined ? { pixelmatchThreshold } : {}),
    ...(baselines ? { baselines } : {}),
  };
  const truth = { colors: { text: { value: '#ff0000', provenance: { source: 'fixture', locator: 'fixture', hash: '0'.repeat(64) } } } };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><style>
    .box{color:#ff0000}
    #frame{width:16px;height:16px;background:#f00}
  </style></head><body>
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
