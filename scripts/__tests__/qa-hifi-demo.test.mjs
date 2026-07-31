import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSafeStaticServer } from '../lib/safe-server.mjs';
import { hashFile, safeJsonForScript, stableJson } from '../lib/fs-utils.mjs';
import { comparePngs } from '../lib/png-compare.mjs';
import { templateExtractor as TEMPLATE_EXTRACTOR } from './_extractor-template.mjs';

const MODULE_ROOT = process.env.QA_HIFI_MODULE_ROOT;
/* r7 条目 14:宿主没有产品仓依赖(esbuild / playwright)时,这些用例**跑不了**,
   必须显式 skip 并说明缺什么 —— 原先它们直接 fail,把「宿主缺依赖」伪装成「实现有 bug」。
   skill 自身故意不 vendor esbuild/playwright(重依赖 + 浏览器二进制),它们由产品仓提供;
   canonical 测试命令一直带 QA_HIFI_MODULE_ROOT,两个真实产品仓下这些用例全部实跑。 */
const NEEDS_PRODUCT_REPO = '需要产品仓提供 esbuild/playwright:设 QA_HIFI_MODULE_ROOT 指向装了依赖的仓(skill 自身不 vendor 这两个重依赖)';
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VERIFY = join(ROOT, 'scripts/verify.mjs');
const PIXEL = join(ROOT, 'scripts/pixel-compare.mjs');
const PR_BLOCK = join(ROOT, 'scripts/pr-block.mjs');
const STATES = join(ROOT, 'scripts/states.mjs');

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 30000,
  });
}

function tmpDemo(name = 'demo') {
  return mkdtempSync(join(tmpdir(), `qa-hifi-${name}-`));
}

function leaf(value, source, locator = 'fixture') {
  return { value, provenance: { source: source.split('/').pop(), locator, hash: hashFile(source) } };
}

function writeDemo({ mutateSpec, mutateHtml, truthOverride, truthMutate, name = 'ok', pngBaseline = false, noExtractor = false, extractOutput } = {}) {
  const dir = tmpDemo(name);
  const source = join(dir, 'source.txt');
  writeFileSync(source, 'source-v1');
  let truth = truthOverride ?? {
    geometry: { width: leaf(16, source, 'width constant') },
    colors: { text: leaf('#ff0000', source, 'text color') },
  };
  // truthMutate 在默认 truth(provenance 指向 demo 内 source.txt,真实存在)之上改值/加子树,
  // 供 fixture 构造非法值(如 '1em')或加 adaptive,而不破坏 provenance 校验
  if (truthMutate) truth = truthMutate(truth, source);
  const baseSpec = {
    meta: { name, summary: { what: 'what', how: 'how', accept: 'accept' } },
    matrix: { platforms: ['desk'], regions: ['cn'], systems: ['ios'], themes: ['light'], langs: ['zh-CN'] },
    states: [{ id: 'id', via: [{ expect: 'id' }] }],
    verify: {
      // via 非空且只含 expect:声明「demo 初始就在该 case 的偏好上,无需导航」。
      // 不用 via:[]——空数组与「忘填」不可分辨,schema 已拒(审核附带收紧项)。
      cases: [{ id: 'desk-cn-light', prefs: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, via: [{ expect: 'id' }] }],
      noClip: ['.box'],
    },
    bindings: [
      { sel: '.box', prop: 'width', truth: 'geometry.width', kind: 'length' },
      { sel: '.box', prop: 'color', truth: 'colors.text', kind: 'color' },
    ],
  };
  const spec = mutateSpec ? mutateSpec(structuredClone(baseSpec)) : baseSpec;
  const html = mutateHtml ? mutateHtml(baseHtml(truth)) : baseHtml(truth);
  writeFileSync(join(dir, 'truth.json'), stableJson(truth));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'index.html'), html);
  // 门 A extractor-drift 检查要求有 extract.mjs;echo 型即可(输出同一 truth,drift 检查通过)。
  // noExtractor=true 或 extractOutput 覆盖 → 供「缺 extractor / 漂移」类 fixture 使用。
  if (!noExtractor) {
    const emit = extractOutput !== undefined ? extractOutput : truth;
    /* r10 fixture 忠实化:与 init.mjs 生成的官方模板**同形** —— import 兄弟模块
       `./extract-helpers.mjs`,helpers 一并拷进 demo。此前 fixture 是自包含单文件,于是
       「可信副本把脚本搬走后相对 import 解析不到兄弟模块」这类缺陷 350/350 全绿也测不出来
       (要靠 e2e 才抓到)。忠实化后官方脚手架的真实形态本身受回归保护。 */
    writeFileSync(join(dir, 'extract.mjs'), TEMPLATE_EXTRACTOR(emit));
    copyFileSync(join(ROOT, 'scripts/lib/extract-helpers.mjs'), join(dir, 'extract-helpers.mjs'));
  }
  if (pngBaseline) {
    mkdirSync(join(dir, 'baselines'), { recursive: true });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAK0lEQVR4AaXBAQEAAAiDMKR/5xuC7QYjkEgiiSSSSCKJJJJIIokkkkgiiR5YbQIeTyCVoAAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(dir, 'baselines/one.png'), png);
  }
  return dir;
}

function baseHtml(truth, extra = '') {
  return `<!doctype html><html><head><style>
    .box{width:16px;color:#ff0000;white-space:nowrap}
    #frame{width:16px;height:16px;background:#f00}
  </style></head><body>
  <script id="qa-truth" type="application/json">${safeJsonForScript(truth)}</script>
  <button data-qa-pref="plat:desk">desk</button><button data-qa-pref="region:cn">cn</button>
  <button data-qa-pref="os:ios">ios</button><button data-qa-pref="mode:light">light</button><button data-qa-pref="lang:zh-CN">zh</button>
  <button id="noop">noop</button><div class="box">x</div><div id="tick">0</div><input id="code">
  <div id="frame" class="frame"></div>
  ${extra}
  <script>
  const S={step:'id',prefs:{plat:'desk',region:'cn',os:'ios',mode:'light',lang:'zh-CN'},tick:0};
  window.__qa={
    current:()=>S.step,
    goto:(id)=>{ if(id!=='id') throw new Error('unknown'); S.step=id; },
    prefs:()=>({...S.prefs}),
    scale:()=>1,
    resize:(w,h)=>{ document.querySelector('#frame').style.width=w+'px'; document.querySelector('#frame').style.height=h+'px'; },
    metrics:()=>{ const r=document.querySelector('#frame').getBoundingClientRect(); return {frame:{w:r.width,h:r.height},probes:{}}; }
  };
  </script></body></html>`;
}

function getRaw(url, rawPath) {
  const parsed = new URL(url);
  return new Promise((resolveResponse, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        method: 'GET',
        path: rawPath,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolveResponse(res));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('P0-9 safe static server blocks encoded traversal and symlink escape', async () => {
  const dir = writeDemo();
  const outsideDir = tmpDemo('outside');
  const outsideFile = join(outsideDir, 'secret.txt');
  writeFileSync(outsideFile, 'secret');
  symlinkSync(outsideFile, join(dir, 'secret-link.txt'));
  const srv = createSafeStaticServer(dir);
  const base = await srv.listen();
  try {
    const outside = await getRaw(base, '/%2e%2e/package.json');
    assert.equal(outside.statusCode, 403);
    const symlink = await getRaw(base, '/secret-link.txt');
    assert.equal(symlink.statusCode, 403);
  } finally {
    await srv.close();
  }
});

test('P0-1 provenance is mandatory for truth leaves', () => {
  const dir = writeDemo({ truthOverride: { colors: { text: '#ff0000' } }, name: 'no-prov' });
  const res = run(VERIFY, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /provenance|叶子/);
});

test('P0-2 no-op via without target assertion is rejected instead of self-certifying', () => {
  const dir = writeDemo({
    mutateSpec: (s) => {
      s.states = [{ id: 'bad', via: [{ click: '#noop' }] }];
      return s;
    },
    name: 'noop-via',
  });
  const res = run(VERIFY, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /最后一步必须是 expect/);
});

test('P0-3 declared matrix must be executed, not printed as coverage', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({
    mutateSpec: (s) => {
      delete s.verify.cases;
      s.matrix.platforms = ['desk', 'phone'];
      return s;
    },
    name: 'matrix-fake',
  });
  const res = run(VERIFY, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /plat=phone|无法通过 DOM 切换偏好/);
});

test('P0-4 noClip selector matching zero visible elements fails', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({
    mutateSpec: (s) => { s.verify.noClip = ['.missing']; return s; },
    name: 'noclip-empty',
  });
  const res = run(VERIFY, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /未命中可见元素/);
});

test('P0-5 input stability requires an observable tick witness', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({
    mutateSpec: (s) => {
      s.verify.inputs = [{ sel: '#code', text: '123456', tickMs: 100, tickWitness: '#tick', via: [] }];
      return s;
    },
    name: 'no-tick',
  });
  const res = run(VERIFY, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /Timeout|tick|witness|#tick/);
});

test('P0-5 persistence cannot pass by prefs() self-comparison or reloads:0', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({
    mutateSpec: (s) => {
      s.verify.persistence = { via: [{ expect: 'id' }], expected: { plat: 'desk', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' }, storageKey: 'missing-key', reloads: 1 };
      return s;
    },
    name: 'prefs-self',
  });
  const res = run(VERIFY, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /localStorage 缺 key/);
});

test('P0-6 scaled length binding rejects non-finite scale instead of NaN-pass', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({
    mutateHtml: (html) => html.replace('scale:()=>1', "scale:()=>Number.NaN"),
    mutateSpec: (s) => { s.bindings[0].scaled = true; return s; },
    name: 'nan-scale',
  });
  const res = run(VERIFY, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /finite positive/);
});

test('P0-7 pixel full-mask is rejected', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({
    mutateSpec: (s) => {
      s.baselines = [{ key: 'one', frameSel: '#frame', mask: [[0, 0, 16, 16]] }];
      s.baselineThreshold = 0.005;
      s.baselineDpr = 1;
      return s;
    },
    pngBaseline: true,
    name: 'full-mask',
  });
  const res = run(PIXEL, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /mask 面积|超上限/);
});

test('P0-7 missing declared baseline is a hard failure', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({
    mutateSpec: (s) => { s.baselines = [{ key: 'missing', frameSel: '#frame' }]; return s; },
    name: 'missing-baseline',
  });
  const res = run(PIXEL, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /MISSING|缺少基准图/);
});

test('P0-8 pr-block rejects stale report hashes', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({ name: 'stale-report' });
  const ok = run(VERIFY, ['--demo', dir]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  writeFileSync(join(dir, 'index.html'), readFileSync(join(dir, 'index.html'), 'utf8').replace('>x</div>', '>changed</div>'));
  const res = run(PR_BLOCK, ['--demo', dir, '--preview', 'https://github.com/org/repo/blob/main/demo/index.html', '--url', 'https://workers.xd.team/demo']);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /hash|不一致|重跑/);
});

test('P1 strict schema exits cleanly on malformed state', () => {
  const dir = writeDemo({ mutateSpec: (s) => { s.states = [null]; return s; }, name: 'bad-schema' });
  const res = run(STATES, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /states\[0\] 必须是 object/);
  assert.equal(res.stderr, '');
});

test('P1 pr-block validates preview and experience URL domains', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({ name: 'url-validate' });
  const ok = run(VERIFY, ['--demo', dir]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const badUrl = run(PR_BLOCK, ['--demo', dir, '--url', 'https://example.com/demo']);
  assert.equal(badUrl.status, 2);
  assert.match(badUrl.stderr, /workers\.xd\.team/);
  const badPreview = run(PR_BLOCK, ['--demo', dir, '--preview', 'https://evil.example/demo.html']);
  assert.equal(badPreview.status, 2);
  assert.match(badPreview.stderr, /白名单/);
});

// 复审新发现(P0-7 修复引入的假绿):pixelmatch 分支 mask 处理。
// 用 fake pixelmatch 复刻真 pixelmatch「drawPixel 对所有像素写 alpha=255」的行为,
// 构造「mask 内仅部分像素变化 + mask 外有真实差异」的场景:
//   旧代码 bad -= maskedBad(按 alpha!=0 数出整片 mask)→ bad 变负 → mask 外差异被隐藏(假绿);
//   新代码在调用前把 mask 区两图置同 → mask 内 0 贡献 → bad 恰为 mask 外真实差异数。
test('P0-7(recheck) pixelmatch mask must not hide out-of-mask diffs', () => {
  const W = 4, H = 4;
  const fill = (r, g, b, a = 255) => {
    const buf = Buffer.alloc(W * H * 4);
    for (let i = 0; i < buf.length; i += 4) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a; }
    return buf;
  };
  const baseline = { width: W, height: H, data: fill(10, 10, 10) };
  const actual = { width: W, height: H, data: fill(10, 10, 10) };
  // mask 覆盖左上 2x2(4 像素);其中只有 1 个像素在 actual 里变化,另外 3 个不变
  actual.data[0] = 200; actual.data[1] = 200; actual.data[2] = 200; // px(0,0) 变(mask 内动态)
  // mask 外一个真实差异:px(3,3) = index 15
  const oi = 15 * 4;
  actual.data[oi] = 200; actual.data[oi + 1] = 0; actual.data[oi + 2] = 0;
  function FakePNG({ width, height }) { this.width = width; this.height = height; this.data = Buffer.alloc(width * height * 4); }
  // 复刻真 pixelmatch:逐像素判差,输出 alpha 恒为 255(差异点红、非差异点灰底)
  const fakePixelmatch = (a, b, out, w, h) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      const diff = a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3];
      out[i] = diff ? 255 : 128; out[i + 1] = diff ? 0 : 128; out[i + 2] = diff ? 0 : 128; out[i + 3] = 255;
      if (diff) n++;
    }
    return n;
  };
  const res = comparePngs({
    PNG: FakePNG, pixelmatch: fakePixelmatch, baseline, actual,
    cssSize: { width: W, height: H }, masks: [[0, 0, 2, 2]],
    threshold: 0.005, maxMaskRatio: 0.5, minUnmaskedRatio: 0.5,
  });
  assert.equal(res.status, 'OK', res.detail);
  // mask 内 4 px 被中和为 0 贡献;唯一被统计的是 mask 外那个真实差异
  assert.equal(res.bad, 1, `期望 mask 外 1 个坏点被检出,实际 bad=${res.bad}(负数=旧假绿 bug)`);
  assert.ok(res.bad >= 0, 'bad 不得为负(旧代码 over-subtract 会变负导致假绿)');
});

// ============ 复审第二轮:本轮新修洞的对抗 fixture(旧绿新红) ============

test('P0-A(recheck) declared baselines but no pixel report blocks pr-block', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({ mutateSpec: (s) => { s.baselines = [{ key: 'k1', via: [{ expect: 'id' }] }]; return s; }, name: 'baseline-noreport' });
  const v = run(VERIFY, ['--demo', dir]);
  assert.equal(v.status, 0, v.stdout + v.stderr); // verify 不管门 E
  // 声明了 baseline 却没跑 pixel-compare → pr-block 必须拒绝(旧代码只 warning 放行)
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://workers.xd.team']);
  assert.equal(pr.status, 2);
  assert.match(pr.stderr + pr.stdout, /baseline|门 E|report-pixel/);
});

test('P0-B(recheck) baseline key path traversal is rejected by schema', () => {
  const dir = writeDemo({ mutateSpec: (s) => { s.baselines = [{ key: '../../evil', via: [{ expect: 'id' }] }]; return s; }, name: 'baseline-traversal' });
  const v = run(VERIFY, ['--demo', dir]);
  assert.equal(v.status, 2);
  assert.match(v.stdout, /key 只允许|\.\./);
});

test('P0-C(recheck) gate F measures DOM, not page self-reported metrics', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  // probe 指向不存在的元素:旧代码信 __qa.metrics 自报(demo 的 metrics 可回显 oracle)→ 门 F 全绿(假绿);
  // 新代码 verifier 侧直接量 DOM(measureAdaptive)→ 元素不存在 → 红。新门 F 不再调 __qa.metrics。
  const dir = writeDemo({
    name: 'gatef-selfreport',
    truthMutate: (t) => {
      t.adaptive = { samples: [{ w: 320, h: 240, probes: { p: { x: 0, y: 0, w: 10, h: 10 } } }] };
      return t;
    },
    mutateSpec: (s) => {
      s.adaptive = { min: { w: 300, h: 200 }, sampleSizes: [[320, 240]], probes: [{ id: 'p', sel: '.does-not-exist' }], tolerancePx: 1 };
      return s;
    },
  });
  const res = run(VERIFY, ['--demo', dir], { timeout: 60000 });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /量不到 DOM 几何|does-not-exist/);
});

test('P1(recheck) schema does not crash on container-type states', () => {
  const dir = writeDemo({ mutateSpec: (s) => { s.states = {}; return s; }, name: 'states-obj' });
  const res = run(STATES, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.equal(res.stderr, ''); // 结构化 FAIL,不是 TypeError 崩栈
  assert.match(res.stdout, /states 必须是非空数组/);
});

test('P1(recheck) verify.cases prefs must belong to declared matrix', () => {
  const dir = writeDemo({
    name: 'case-offmatrix',
    mutateSpec: (s) => {
      s.verify.cases = [{ id: 'bad', prefs: { plat: 'watch', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' } }];
      return s;
    },
  });
  const res = run(VERIFY, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /不在 matrix/);
});

test('P0-6(recheck) gate D rejects context-relative length units (em/%)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({
    name: 'gated-em',
    // 把默认 width leaf 的 value 改成 '1em'(上下文相关单位),provenance 仍指向 demo 内 source.txt
    truthMutate: (t) => { t.geometry.width.value = '1em'; return t; },
    mutateSpec: (s) => { s.bindings = [{ sel: '.box', prop: 'width', truth: 'geometry.width', kind: 'length', scaled: false }]; return s; },
  });
  const res = run(VERIFY, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /上下文相关单位|非绝对/);
});

test('P0-2(recheck) hidden tab-only entry is not accepted as reachable', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  // tab-only 状态,但 tab 入口 display:none:旧合成 click 照点 → 门B 绿;新 actionability → 红
  const dir = writeDemo({
    name: 'hidden-tab',
    mutateSpec: (s) => {
      s.states = [
        { id: 'id', via: [{ expect: 'id' }] },
        { id: 'hidden', via: null, tab: '状态补齐', note: '需外部触发,链路难达' },
      ];
      return s;
    },
    mutateHtml: (html) =>
      html.replace(
        '<div id="frame" class="frame"></div>',
        '<div id="frame" class="frame"></div>' +
          '<div data-qa-state-tab style="display:none"><a data-qa-goto="hidden" onclick="S.step=\'hidden\'">go</a></div>',
      ),
  });
  const res = run(VERIFY, ['--demo', dir], { timeout: 60000 });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /可交互|状态补齐 tab|隐藏/);
});

test('P0-3(recheck) opacity:0 pref entry cannot self-certify matrix switch', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  // matrix 含 phone,但 phone 切换入口 opacity:0:旧合成 click → 门B 绿;新 actionability → 红
  const dir = writeDemo({
    name: 'opacity-pref',
    mutateSpec: (s) => {
      s.matrix.platforms = ['desk', 'phone'];
      delete s.verify.cases; // 走 matrix 笛卡尔积,会生成 phone case
      return s;
    },
    mutateHtml: (html) =>
      html.replace(
        '<div id="frame" class="frame"></div>',
        '<button data-qa-pref="plat:phone" style="opacity:0" onclick="S.prefs.plat=\'phone\'">phone</button><div id="frame" class="frame"></div>',
      ),
  });
  const res = run(VERIFY, ['--demo', dir], { timeout: 60000 });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /可交互 DOM 入口|plat=phone/);
});

test('P0-5(recheck) synchronous oninput fake tick is rejected (needs independent timer)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  // #tick 只由 #code 的 oninput 同步更新,无独立定时器:旧代码只看输入前后变化 → 绿;
  // 新代码先要求 witness 无输入时自主变化 → 伪 tick 不动 → 红
  const dir = writeDemo({
    name: 'fake-tick',
    mutateSpec: (s) => {
      s.verify.inputs = [{ sel: '#code', text: '123456', tickMs: 300, tickWitness: '#tick', via: [] }];
      return s;
    },
    mutateHtml: (html) =>
      html.replace('<input id="code">', '<input id="code" oninput="document.getElementById(\'tick\').textContent=this.value.length">'),
  });
  const res = run(VERIFY, ['--demo', dir], { timeout: 60000 });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /非独立定时器|伪 tick|不自主变化/);
});

// ============ 双向同步(writeback):参数写回 round-trip + 拒绝路径 ============

const WRITEBACK = join(ROOT, 'scripts/writeback.mjs');

function writeWritebackDemo() {
  // 模拟「产品源文件」:consts.txt 里有一个 width 常量;extract.mjs 用同一 locatorPattern 提取
  const dir = tmpDemo('writeback');
  writeFileSync(join(dir, 'consts.txt'), 'panel { width: 16 } // 产品常量\n');
  writeFileSync(
    join(dir, 'extract.mjs'),
    `import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const src = new URL('consts.txt', import.meta.url).pathname;
const content = readFileSync(src, 'utf8');
const width = Number(/width:\\s*(\\d+)/.exec(content)[1]);
const hash = createHash('sha256').update(readFileSync(src)).digest('hex');
process.stdout.write(JSON.stringify({ geometry: { width: {
  value: width,
  provenance: { source: 'consts.txt', locator: 'width constant', locatorPattern: 'width:\\\\s*(\\\\d+)', hash },
} } }));
`,
  );
  const truth = run(join(ROOT, 'scripts/truth.mjs'), ['--demo', dir]);
  assert.equal(truth.status, 0, truth.stdout + truth.stderr);
  // 空 qa-truth 块占位 + --embed 语义由 writeback 内部同步,先手动嵌当前 truth
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><body><script id="qa-truth" type="application/json">${readFileSync(join(dir, 'truth.json'), 'utf8')}</script></body></html>`);
  return dir;
}

test('writeback round-trips a parameter change into product source', () => {
  const dir = writeWritebackDemo();
  const res = run(WRITEBACK, ['--demo', dir, '--set', 'geometry.width=20']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.roundTrip, true);
  // 产品源文件真的变了
  assert.match(readFileSync(join(dir, 'consts.txt'), 'utf8'), /width: 20/);
  // truth.json 与内嵌块同步为新值
  const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8'));
  assert.equal(truth.geometry.width.value, 20);
  assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /"value":\s*20|"value":20/);
});

test('writeback refuses leaves without locatorPattern (structural changes go to agent)', () => {
  const dir = writeDemo({ name: 'wb-nopattern' }); // 默认 leaf 无 locatorPattern
  const res = run(WRITEBACK, ['--demo', dir, '--set', 'geometry.width=20']);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /不可机械写回|agent 双改/);
});

test('writeback refuses when source drifted from truth (stale truth)', () => {
  const dir = writeWritebackDemo();
  // 源码被别人改了(width 16→18),truth 还是 16 → 写回必须拒绝防盲写
  writeFileSync(join(dir, 'consts.txt'), 'panel { width: 18 } // 产品常量\n');
  const res = run(WRITEBACK, ['--demo', dir, '--set', 'geometry.width=20']);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /源码已变|先重跑 truth/);
});

test('pr-block --require-committed blocks untracked demo, passes committed one', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({ name: 'committed-gate' });
  const v = run(VERIFY, ['--demo', dir]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  // 未入 git:必须拒绝
  const blocked = run(PR_BLOCK, ['--demo', dir, '--require-committed']);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stdout + blocked.stderr, /不在 git 仓内|未被 git 跟踪/);
  // git init + 只 add 不 commit:仍拒绝(工作区脏 = PR 带旧版/没版)
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'qa@test.local');
  git('config', 'user.name', 'qa');
  git('add', '-A');
  const staged = run(PR_BLOCK, ['--demo', dir, '--require-committed']);
  assert.equal(staged.status, 2);
  assert.match(staged.stdout + staged.stderr, /未提交改动/);
  // commit 后:通过
  git('commit', '-qm', 'demo');
  const ok = run(PR_BLOCK, ['--demo', dir, '--require-committed']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /可交互 QA demo/);
});

// 独立子进程起一个静态 server serve <file> 于 127.0.0.1,回传 {proc, base}。
// 必须独立进程:run() 用 spawnSync 会阻塞本测试进程 event loop,同进程 server 期间无法响应。
async function spawnLiveServer(htmlPath) {
  const code = `const http=require('http'),fs=require('fs');` +
    `const s=http.createServer((q,r)=>{try{r.writeHead(200,{'content-type':'text/html'});r.end(fs.readFileSync(${JSON.stringify(htmlPath)}));}catch{r.writeHead(500).end();}});` +
    `s.listen(0,'127.0.0.1',()=>process.stdout.write('PORT='+s.address().port+'\\n'));`;
  const { spawn } = await import('node:child_process');
  const proc = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((res, rej) => {
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d; const m = /PORT=(\d+)/.exec(buf); if (m) res(m[1]); });
    proc.on('error', rej);
    setTimeout(() => rej(new Error('live server 起不来')), 5000);
  });
  return { proc, base: `http://127.0.0.1:${port}/` };
}

test('pr-block --require-deployed verifies live HTML matches local (fresh pass, stale fail, missing fail)', async (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({ name: 'deploy-gate' });
  const v = run(VERIFY, ['--demo', dir]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const env = { QA_HIFI_URL_ALLOW: '127.0.0.1' };
  // ① 线上 serve 本地这份 index.html → 一致 → 过
  const live = await spawnLiveServer(join(dir, 'index.html'));
  try {
    const ok = run(PR_BLOCK, ['--demo', dir, '--require-deployed', '--url', live.base], { env });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  } finally { live.proc.kill(); }
  // ② 线上 serve 一份「旧版」(多一段注释字节)→ 不一致 → 拦
  const staleHtml = join(tmpDemo('stale'), 'old.html');
  writeFileSync(staleHtml, readFileSync(join(dir, 'index.html'), 'utf8') + '<!-- old deploy -->');
  const live2 = await spawnLiveServer(staleHtml);
  try {
    const stale = run(PR_BLOCK, ['--demo', dir, '--require-deployed', '--url', live2.base], { env });
    assert.equal(stale.status, 2);
    assert.match(stale.stdout + stale.stderr, /旧版|不一致/);
  } finally { live2.proc.kill(); }
  // ③ --require-deployed 但没给 --url → 拦
  const nourl = run(PR_BLOCK, ['--demo', dir, '--require-deployed'], { env });
  assert.equal(nourl.status, 2);
  assert.match(nourl.stdout + nourl.stderr, /需要 --url|没部署/);
});

test('pr-block --url accepts workers.xd.team subdomains (real deploy hosts)', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({ name: 'subdomain-url' });
  const v = run(VERIFY, ['--demo', dir]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  // 真实部署地址是 <name>.workers.xd.team 子域——之前裸域精确匹配会误拒(现存 bug 修复锁定)
  const ok = run(PR_BLOCK, ['--demo', dir, '--url', 'https://cindy-x-hifi.workers.xd.team']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = run(PR_BLOCK, ['--demo', dir, '--url', 'https://evil-workers.xd.team.attacker.com']);
  assert.equal(bad.status, 2);
});

// ============ 2026-07-30 DX+evolution 批次:增量/门X/批量check/脚手架/自进化 ============

const TRUTH_SCRIPT = join(ROOT, 'scripts/truth.mjs');
const INIT = join(ROOT, 'scripts/init.mjs');
const EVO = join(ROOT, 'scripts/evolution-note.mjs');

test('partial: --gate 过滤产出 partial 报告,pr-block 拒收', () => {
  const dir = writeDemo({ name: 'partial-gate' });
  const res = run(VERIFY, ['--demo', dir, '--gate', 'A']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.partial, true);
  assert.equal(report.gateB.skipped, true);
  // partial 报告喂 pr-block 必须拒绝——增量只用于调试,不可用于定稿
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team']);
  assert.equal(pr.status, 2);
  assert.match(pr.stdout + pr.stderr, /partial|增量/);
});

test('partial: 全量重跑后 pr-block 恢复接受', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({ name: 'partial-then-full' });
  const p1 = run(VERIFY, ['--demo', dir, '--gate', 'A']);
  assert.equal(p1.status, 0, p1.stdout + p1.stderr);
  const full = run(VERIFY, ['--demo', dir]);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  const ok = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test('partial: --case 未命中直接失败并列出可用 id', () => {
  const dir = writeDemo({ name: 'case-miss' });
  const res = run(VERIFY, ['--demo', dir, '--case', 'nope']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /没有命中任何 case|desk-cn-light/);
});

test('gateX: 自定义门失败 → verify 红;通过 → 绿且进 report', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({ name: 'gatex-fail' });
  writeFileSync(join(dir, 'my-gate.mjs'), 'process.exit(1);\n');
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({
    ...JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')),
    customGates: [{ id: 'my-gate', script: 'my-gate.mjs' }],
  }, null, 2));
  const bad = run(VERIFY, ['--demo', dir]);
  assert.equal(bad.status, 2);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.gateX.pass, false);
  // 改成通过
  writeFileSync(join(dir, 'my-gate.mjs'), 'console.log("ok");process.exit(0);\n');
  const good = run(VERIFY, ['--demo', dir]);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const report2 = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(report2.gateX.pass, true);
  assert.equal(report2.gateX.gates[0].id, 'my-gate');
});

test('gateX: verify 后篡改自定义门脚本 → pr-block 因 hash 不一致拒绝', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({ name: 'gatex-tamper' });
  writeFileSync(join(dir, 'my-gate.mjs'), 'process.exit(0);\n');
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({
    ...JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')),
    customGates: [{ id: 'my-gate', script: 'my-gate.mjs' }],
  }, null, 2));
  const ok = run(VERIFY, ['--demo', dir]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  // 篡改脚本(换宽松实现)后不重跑 verify → 必须被拒
  writeFileSync(join(dir, 'my-gate.mjs'), '/* loosened */process.exit(0);\n');
  const pr = run(PR_BLOCK, ['--demo', dir, '--url', 'https://demo.workers.xd.team']);
  assert.equal(pr.status, 2);
  assert.match(pr.stdout + pr.stderr, /hash|不一致/);
});

test('gateX: script 路径穿越被 schema 拒绝', () => {
  const dir = writeDemo({
    name: 'gatex-traversal',
    mutateSpec: (s) => { s.customGates = [{ id: 'evil', script: '../evil.mjs' }]; return s; },
  });
  const res = run(VERIFY, ['--demo', dir]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /相对路径|\.\./);
});

test('truth --check 输出叶子级 driftedPaths', () => {
  const dir = writeDemo({ name: 'deep-drift' });
  // extractor 输出与 truth.json 在深层叶子上漂移
  const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8'));
  const drifted = structuredClone(truth);
  drifted.colors.text.value = '#00ff00';
  writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(drifted))});\n`);
  const res = run(TRUTH_SCRIPT, ['--demo', dir, '--check']);
  assert.equal(res.status, 2);
  const out = JSON.parse(res.stdout);
  assert.ok(out.driftedPaths.some((d) => d.path === 'colors.text.value'), JSON.stringify(out.driftedPaths));
});

test('truth --check --all 批量扫描,单个漂移则整体 exit 2', () => {
  const root = tmpDemo('all-root');
  const mk = (name, drift) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const source = join(dir, 'source.txt');
    writeFileSync(source, 'source-v1');
    const truth = { geometry: { width: leaf(16, source, 'w') } };
    writeFileSync(join(dir, 'truth.json'), stableJson(truth));
    writeFileSync(join(dir, 'spec.json'), '{}');
    const emit = drift ? { geometry: { width: { ...truth.geometry.width, value: 99 } } } : truth;
    writeFileSync(join(dir, 'extract.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(emit))});\n`);
  };
  mk('demo-ok', false);
  mk('demo-drift', true);
  const res = run(TRUTH_SCRIPT, ['--check', '--all', root]);
  assert.equal(res.status, 2);
  const out = JSON.parse(res.stdout);
  assert.equal(out.total, 2);
  assert.equal(out.drifted, 1);
  assert.ok(out.results.find((r) => r.demo === 'demo-drift' && !r.ok));
  assert.ok(out.results.find((r) => r.demo === 'demo-ok' && r.ok));
});

test('extract-helpers: findRepoRoot 走 git,与目录深度解耦', () => {
  const repo = tmpDemo('repo');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  const nested = join(repo, 'docs/design-previews/x-hifi');
  mkdirSync(nested, { recursive: true });
  const probe = join(nested, 'probe.mjs');
  writeFileSync(probe, `import { findRepoRoot } from ${JSON.stringify(join(ROOT, 'scripts/lib/extract-helpers.mjs'))};\nprocess.stdout.write(findRepoRoot());\n`);
  const res = run(probe, [], { cwd: nested });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(), res.stdout.trim());
});

test('extract-helpers: makeLeaf 产出可过 validateTruth 的 provenance;坏 locatorPattern 拒绝', () => {
  const dir = tmpDemo('makeleaf');
  const source = join(dir, 'consts.txt');
  writeFileSync(source, 'width: 16');
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, `import { makeLeaf } from ${JSON.stringify(join(ROOT, 'scripts/lib/extract-helpers.mjs'))};
const ok = makeLeaf(16, ${JSON.stringify(source)}, { locator: 'w', locatorPattern: 'width:\\\\s*(\\\\d+)', demoDir: ${JSON.stringify(dir)} });
let badCaught = false;
try { makeLeaf(1, ${JSON.stringify(source)}, { locator: 'w', locatorPattern: '(a)(b)', demoDir: ${JSON.stringify(dir)} }); } catch { badCaught = true; }
process.stdout.write(JSON.stringify({ ok, badCaught }));\n`);
  const res = run(probe, [], { cwd: dir });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.badCaught, true);
  assert.equal(out.ok.provenance.source, 'consts.txt');
  assert.match(out.ok.provenance.hash, /^[0-9a-f]{64}$/);
});

test('init.mjs 生成四件套且拒绝覆盖', () => {
  const dir = join(tmpDemo('init'), 'fresh');
  const res = run(INIT, ['--dir', dir, '--name', 'my-demo', '--pr', '42']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  for (const f of ['spec.json', 'extract.mjs', 'extract-helpers.mjs', 'index.html']) {
    assert.ok(existsSync(join(dir, f)), `缺 ${f}`);
  }
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.match(html, /QA_CHROME_BEGIN/);
  assert.match(html, /window\.__qaDemo/);
  assert.match(html, /id="qa-truth"/);
  // spec 骨架能过 states.mjs 静态校验
  const st = run(STATES, ['--demo', dir]);
  assert.equal(st.status, 0, st.stdout + st.stderr);
  // 再跑一次:拒绝覆盖
  const again = run(INIT, ['--dir', dir, '--name', 'my-demo']);
  assert.equal(again.status, 1);
  assert.match(again.stdout, /拒绝覆盖/);
});

test('viewport: 非法 viewport 被 schema 拒;合法 viewport 进 coverage', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const bad = writeDemo({
    name: 'vp-bad',
    mutateSpec: (s) => { s.verify.cases[0].viewport = { w: -1, h: 0 }; return s; },
  });
  const r1 = run(VERIFY, ['--demo', bad]);
  assert.equal(r1.status, 2);
  assert.match(r1.stdout, /viewport/);
  const good = writeDemo({
    name: 'vp-good',
    mutateSpec: (s) => { s.verify.cases[0].viewport = { w: 800, h: 900, dpr: 2 }; return s; },
  });
  const r2 = run(VERIFY, ['--demo', good], { timeout: 60000 });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const report = JSON.parse(readFileSync(join(good, 'report.json'), 'utf8'));
  assert.deepEqual(report.coverage.cases[0].viewport, { w: 800, h: 900, dpr: 2 });
});

test('failShot: 门 B 失败自动留现场截图', (t) => {
  if (!MODULE_ROOT) return t.skip(NEEDS_PRODUCT_REPO);
  const dir = writeDemo({
    name: 'failshot',
    mutateSpec: (s) => {
      // goto('ghost') 会 throw(demo 只认 'id')→ 门 B 失败 → 应留截图
      s.states = [
        { id: 'id', via: [{ expect: 'id' }] },
        { id: 'ghost', via: [{ expect: 'ghost' }] },
      ];
      return s;
    },
  });
  const res = run(VERIFY, ['--demo', dir], { timeout: 60000 });
  assert.equal(res.status, 2);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  const failure = report.gateB.failures.find((f) => f.state === 'ghost');
  assert.ok(failure, 'gateB 应有 ghost 失败');
  assert.ok(failure.screenshot, 'failure 应带 screenshot 字段');
  /* r8 条目 A:失败取证不再写进 demo 树(那会让运行期写入落在快照比对范围里),改落 demo 之外的
     output root;绝对根记在 report.artifactRoot,screenshot 是相对它的路径。 */
  assert.ok(report.artifactRoot, 'report 必须给出 artifactRoot(取证产物的根)');
  assert.ok(existsSync(join(report.artifactRoot, failure.screenshot)), '截图文件应存在于 artifactRoot 下');
  assert.ok(!existsSync(join(dir, 'verify-artifacts')), 'demo 树里不得再出现运行期写入的 verify-artifacts/');
});

test('evolution-note: add 去重 + md 再生成 + proposal 永不降档(QA_HIFI_SKILL_ROOT 隔离)', () => {
  const root = tmpDemo('evo-root');
  const env = { QA_HIFI_SKILL_ROOT: root };
  const add1 = run(EVO, ['add', '--fingerprint', 'repo-root-depth', '--tier', 'auto', '--title', 'repoRoot 目录深度假设', '--no-sync'], { env });
  assert.equal(add1.status, 0, add1.stdout + add1.stderr);
  assert.equal(JSON.parse(add1.stdout).isNew, true);
  const add2 = run(EVO, ['add', '--fingerprint', 'repo-root-depth', '--tier', 'auto', '--title', 'repoRoot 目录深度假设', '--no-sync'], { env });
  assert.equal(JSON.parse(add2.stdout).isNew, false);
  assert.equal(JSON.parse(add2.stdout).entry.occurrences, 2);
  // proposal 档不可被后续 add 降档
  run(EVO, ['add', '--fingerprint', 'loosen-tolerance', '--tier', 'proposal', '--title', '放宽容差', '--no-sync'], { env });
  const demote = run(EVO, ['add', '--fingerprint', 'loosen-tolerance', '--tier', 'auto', '--title', '放宽容差', '--no-sync'], { env });
  assert.equal(JSON.parse(demote.stdout).entry.tier, 'proposal');
  // md 从 ledger 再生成
  const md = readFileSync(join(root, 'EVOLUTION.md'), 'utf8');
  assert.match(md, /repo-root-depth/);
  assert.match(md, /永不自动落地/);
  const ls = run(EVO, ['list'], { env });
  assert.equal(JSON.parse(ls.stdout).count, 2);
});
