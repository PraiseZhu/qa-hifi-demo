#!/usr/bin/env node
// verify.mjs — qa-hifi-demo 门 A/B/C/D/F/X 动态验收执行器。
//
// 增量模式(调试用,2026-07-30 起):
//   --gate A,D      只跑指定门(A/B/C/D/F/X;E 在 pixel-compare.mjs)
//   --case <id,...> 只跑指定 case
//   --state <id,..> 只跑指定状态
// 任一过滤参数出现 → report.partial=true,pr-block 一律拒收 partial 报告——
// 增量是修复循环里的调试工具,定稿必须全量重跑(防「只验过改的那部分」冒充全绿)。
//
// 失败取证:任一动态门失败时自动截图到 verify-artifacts/,failure 条目带 screenshot 字段。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  buildInputHashes,
  failJson,
  failProblems,
  sha256Buffer,
  stableJson,
  TOOL_VERSION,
} from './lib/fs-utils.mjs';
import { validateSpec, validateTruth, validateCustomGateFiles, truthAt, buildVerifyCases, prefsSubsetEqual, normalizeHash } from './lib/schema.mjs';
import { createSafeStaticServer } from './lib/safe-server.mjs';
import { launchChromium } from './lib/resolve-playwright.mjs';
import { applyCase, freshLoad, reachTabState, replay, measureAdaptive } from './lib/replay.mjs';

const args = process.argv.slice(2);
const demoIdx = args.indexOf('--demo');
if (demoIdx === -1 || !args[demoIdx + 1]) failJson('缺 --demo <dir>');
const demoDir = resolve(args[demoIdx + 1]);
const headed = args.includes('--headed');

function listArg(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  if (!args[i + 1]) failJson(`${flag} 需要一个逗号分隔的取值列表`);
  return args[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
}
const GATE_LETTERS = ['A', 'B', 'C', 'D', 'F', 'X'];
const gateFilter = listArg('--gate')?.map((g) => g.toUpperCase());
const caseFilter = listArg('--case');
const stateFilter = listArg('--state');
if (gateFilter) {
  const bad = gateFilter.filter((g) => !GATE_LETTERS.includes(g));
  if (bad.length) failJson(`--gate 只支持 ${GATE_LETTERS.join('/')}(门 E 用 pixel-compare.mjs),非法:${bad.join(',')}`);
}
const partial = !!(gateFilter || caseFilter || stateFilter);
const runGate = (letter) => !gateFilter || gateFilter.includes(letter);

for (const f of ['spec.json', 'truth.json', 'index.html'])
  if (!existsSync(join(demoDir, f))) failJson(`${f} 不存在于 ${demoDir}`);

let spec;
let truthObj;
let html;
try {
  spec = JSON.parse(readFileSync(join(demoDir, 'spec.json'), 'utf8'));
  truthObj = JSON.parse(readFileSync(join(demoDir, 'truth.json'), 'utf8'));
  html = readFileSync(join(demoDir, 'index.html'), 'utf8');
} catch (err) {
  failProblems([`输入解析失败:${err.message}`]);
}

const schemaProblems = [
  ...validateSpec(spec).map((p) => `spec: ${p}`),
  ...validateTruth(truthObj, { demoDir, requireProvenance: true }).map((p) => `truth: ${p}`),
  ...validateCustomGateFiles(spec, demoDir).map((p) => `spec: ${p}`),
];
if (schemaProblems.length) failProblems(schemaProblems);

const inputHashes = buildInputHashes(demoDir, spec);
const allCases = buildVerifyCases(spec);
const cases = caseFilter ? allCases.filter((c) => caseFilter.includes(c.id)) : allCases;
if (caseFilter && cases.length === 0)
  failJson(`--case 没有命中任何 case;可用:${allCases.map((c) => c.id).join(', ')}`);
const statesRun = stateFilter ? spec.states.filter((s) => stateFilter.includes(s.id)) : spec.states;
if (stateFilter && statesRun.length === 0)
  failJson(`--state 没有命中任何状态;可用:${spec.states.map((s) => s.id).join(', ')}`);

function makeGate(name, total = 0) {
  return { name, pass: false, total, passed: 0, failures: [], cases: [] };
}
function skippedGate(name) {
  return { name, pass: false, skipped: true, detail: '本次为增量运行(--gate 过滤),该门未执行' };
}

// ---------- 门 A:真值一致 + provenance + extractor drift ----------
// 三段:① 内嵌 qa-truth ≡ truth.json;② truth 由 extract.mjs 现跑重算 ≡ truth.json(证明 value
// 真由源码提取,不是手抄 value+CSS+内嵌块蒙混,codex 复审 P0-1);③ provenance 由 validateTruth 保证。
let gateA;
if (!runGate('A')) gateA = skippedGate('真值一致');
else {
  gateA = { name: '真值一致', pass: false, detail: '', provenance: 'required', extractorDrift: 'unknown' };
  const m = html.match(/<script[^>]*id=["']qa-truth["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) gateA.detail = 'index.html 缺 <script id="qa-truth" type="application/json"> 内嵌真值块';
  else {
    try {
      const embedded = JSON.parse(m[1]);
      if (stableJson(embedded) !== stableJson(truthObj)) {
        gateA.detail = '内嵌真值与 truth.json 不一致(规范化比对失败)';
      } else {
        // extractor drift:跑 demo/extract.mjs,现算结果必须 ≡ truth.json
        const extractor = join(demoDir, 'extract.mjs');
        if (!existsSync(extractor)) {
          gateA.pass = false;
          gateA.extractorDrift = 'no-extractor';
          gateA.detail = '缺 extract.mjs——无法证明 truth 由源码提取(只有 provenance hash 声明,不构成机械证明);请补 extractor';
        } else {
          try {
            const fresh = execFileSync(process.execPath, [extractor], { cwd: demoDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
            if (stableJson(JSON.parse(fresh)) === stableJson(truthObj)) {
              gateA.pass = true;
              gateA.extractorDrift = 'none';
            } else {
              gateA.extractorDrift = 'drift';
              gateA.detail = 'extract.mjs 现算结果与 truth.json 漂移——truth 被手改或源码已变,重跑 truth.mjs 生成';
            }
          } catch (err) {
            gateA.extractorDrift = 'error';
            gateA.detail = `extract.mjs 执行失败:${String(err.stderr || err.message).slice(0, 200)}`;
          }
        }
      }
    } catch (err) {
      gateA.detail = `真值块解析失败:${err.message}`;
    }
  }
}

const needBrowser = runGate('B') || runGate('C') || runGate('D') || runGate('F');
let safeServer;
let browser;
let page = null;
let currentPageKey = null;
const artifactDir = join(demoDir, 'verify-artifacts');
let shotSeq = 0;

/** per-case 视口:case 声明 viewport(w/h/dpr)时换新 page——移动端 case 必须在移动端视口下验。 */
async function pageFor(testCase = {}) {
  const vp = testCase.viewport ?? null;
  const key = vp ? `${vp.w}x${vp.h}@${vp.dpr ?? 'default'}` : 'default';
  if (page && currentPageKey === key) return page;
  if (page) { try { await page.close(); } catch {} }
  page = await browser.newPage({
    viewport: { width: vp?.w ?? 1440, height: vp?.h ?? 960 },
    ...(vp?.dpr ? { deviceScaleFactor: vp.dpr } : {}),
  });
  currentPageKey = key;
  return page;
}

/** 失败现场截图(best-effort):落 verify-artifacts/,返回相对路径供 failure 条目引用。 */
async function failShot(label) {
  if (!page) return null;
  try {
    mkdirSync(artifactDir, { recursive: true });
    const name = `${String(++shotSeq).padStart(2, '0')}-${label.replace(/[^A-Za-z0-9一-鿿._=-]+/g, '_').slice(0, 100)}.png`;
    await page.screenshot({ path: join(artifactDir, name) });
    return `verify-artifacts/${name}`;
  } catch {
    return null;
  }
}

try {
  let base = null;
  if (needBrowser) {
    safeServer = createSafeStaticServer(demoDir);
    base = await safeServer.listen();
    ({ browser } = await launchChromium(demoDir, { headless: !headed }));
  }

  // ---------- 门 B:状态覆盖 ----------
  let gateB;
  if (!runGate('B')) gateB = skippedGate('状态覆盖');
  else {
    gateB = makeGate('状态覆盖', cases.length * statesRun.length);
    for (const testCase of cases) {
      const caseResult = { id: testCase.id, prefs: testCase.prefs, passed: 0, total: statesRun.length, failures: [] };
      const p = await pageFor(testCase);
      for (const st of statesRun) {
        try {
          await freshLoad(p, base, { adaptive: !!spec.adaptive });
          await applyCase(p, testCase);
          if (Array.isArray(st.via)) await replay(p, st.via);
          else await reachTabState(p, st);
          const cur = await p.evaluate(() => window.__qa.current());
          if (cur !== st.id) throw new Error(`via 执行后 current="${cur}", expected "${st.id}"`);
          caseResult.passed++;
          gateB.passed++;
        } catch (err) {
          const failure = { case: testCase.id, state: st.id, error: String(err.message || err).slice(0, 300), screenshot: await failShot(`B-${testCase.id}-${st.id}`) };
          caseResult.failures.push(failure);
          gateB.failures.push(failure);
        }
      }
      gateB.cases.push(caseResult);
    }
    gateB.pass = gateB.failures.length === 0;
  }

  // ---------- 门 C:交互鲁棒 ----------
  let gateC;
  if (!runGate('C')) gateC = skippedGate('交互鲁棒');
  else {
    gateC = { name: '交互鲁棒', pass: false, checks: [], cases: cases.map((c) => ({ id: c.id, prefs: c.prefs })) };

    const noClipCheck = { id: 'no-clip', pass: false, failures: [] };
    for (const testCase of cases) {
      const p = await pageFor(testCase);
      for (const st of statesRun) {
        try {
          await freshLoad(p, base, { adaptive: !!spec.adaptive });
          await applyCase(p, testCase);
          if (Array.isArray(st.via)) await replay(p, st.via);
          else await reachTabState(p, st);
          const failures = await p.evaluate((selectors) => {
            const out = [];
            const visible = (el) => {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
            };
            for (const sel of selectors) {
              const all = [...document.querySelectorAll(sel)].filter(visible);
              if (all.length === 0) { out.push(`${sel}:未命中可见元素`); continue; }
              for (const el of all) {
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                const txt = (el.textContent || '').trim().slice(0, 40);
                const clippedX = el.scrollWidth > el.clientWidth + 1;
                const clippedY = el.scrollHeight > el.clientHeight + 1;
                if (clippedX) out.push(`${sel}:"${txt}" 横向截断`);
                if (clippedY) out.push(`${sel}:"${txt}" 纵向截断`);
                if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)
                  out.push(`${sel}:"${txt}" 溢出 viewport`);
                // ellipsis/line-clamp 仅在「确实发生截断」时报——设了但内容没溢出是合法用法,不误杀
                // (codex 复审 P1;真截断已由上面 scroll 比对覆盖,这里补一句更明确的成因)
                if (clippedX && s.textOverflow === 'ellipsis') out.push(`${sel}:"${txt}" ellipsis 截断生效`);
                if (clippedY && s.webkitLineClamp && s.webkitLineClamp !== 'none') out.push(`${sel}:"${txt}" line-clamp 截断生效`);
              }
            }
            return out;
          }, spec.verify.noClip);
          if (failures.length) {
            const screenshot = await failShot(`C-noclip-${testCase.id}-${st.id}`);
            for (const f of failures) noClipCheck.failures.push({ case: testCase.id, state: st.id, error: f, screenshot });
          }
        } catch (err) {
          noClipCheck.failures.push({ case: testCase.id, state: st.id, error: String(err.message || err).slice(0, 300), screenshot: await failShot(`C-noclip-${testCase.id}-${st.id}`) });
        }
      }
    }
    noClipCheck.pass = noClipCheck.failures.length === 0;
    gateC.checks.push(noClipCheck);

    for (const inp of spec.verify.inputs ?? []) {
      const check = { id: `input-stable:${inp.sel}`, pass: false, failures: [] };
      for (const testCase of cases) {
        const p = await pageFor(testCase);
        try {
          await freshLoad(p, base, { adaptive: !!spec.adaptive });
          await applyCase(p, testCase);
          await replay(p, inp.via ?? []);
          // 先证明 witness 由独立定时器自主变化(全程不碰输入)——否则是「靠 oninput 同步更新」的
          // 伪 tick,input 一停就不动,不能用来证明跨 tick 稳定(codex 复审 P0-5)
          const idleBefore = await p.locator(inp.tickWitness).first().textContent({ timeout: 4000 });
          await p
            .waitForFunction(
              ({ sel, before }) => document.querySelector(sel)?.textContent !== before,
              { sel: inp.tickWitness, before: idleBefore },
              { timeout: Number(inp.tickMs) * 3 },
            )
            .catch(() => { throw new Error(`tickWitness ${inp.tickWitness} 在无输入时不自主变化——非独立定时器(伪 tick),无法证明跨 tick 输入稳定`); });
          const beforeWitness = await p.locator(inp.tickWitness).first().textContent({ timeout: 4000 });
          await p.locator(inp.sel).waitFor({ state: 'visible', timeout: 4000 });
          await p.locator(inp.sel).evaluate((el) => { el.value = ''; el.__qaInputMark = true; });
          await p.locator(inp.sel).focus();
          const perChar = Math.ceil(Number(inp.tickMs) / inp.text.length) + 60;
          await p.type(inp.sel, inp.text, { delay: perChar });
          await p.waitForFunction(
            ({ sel, before }) => document.querySelector(sel)?.textContent !== before,
            { sel: inp.tickWitness, before: beforeWitness },
            { timeout: Number(inp.tickMs) * 3 },
          );
          const res = await p.evaluate((sel) => {
            const el = document.querySelector(sel);
            return { value: el?.value, focused: document.activeElement === el, sameNode: el?.__qaInputMark === true };
          }, inp.sel);
          const problems = [];
          if (res.value !== inp.text) problems.push(`值不完整:"${res.value}"`);
          if (!res.focused) problems.push('焦点丢失');
          if (!res.sameNode) problems.push('DOM 节点被替换');
          if (problems.length) throw new Error(problems.join('; '));
        } catch (err) {
          check.failures.push({ case: testCase.id, error: String(err.message || err).slice(0, 300), screenshot: await failShot(`C-input-${testCase.id}`) });
        }
      }
      check.pass = check.failures.length === 0;
      gateC.checks.push(check);
    }

    if (spec.verify.persistence) {
      const pers = spec.verify.persistence;
      const check = { id: 'persistence', pass: false, failures: [] };
      const p = await pageFor({});
      try {
        await freshLoad(p, base, { adaptive: !!spec.adaptive });
        await replay(p, pers.via);
        const got = await p.evaluate(() => window.__qa.prefs());
        // key-wise 比对,不用 JSON.stringify(受 key 顺序影响会误杀语义相同的 prefs;codex 复审 P1)
        if (!prefsSubsetEqual(got, pers.expected))
          throw new Error(`via 后 prefs 不等于 expected:${JSON.stringify(got)} vs ${JSON.stringify(pers.expected)}`);
        const stored = await p.evaluate((key) => localStorage.getItem(key), pers.storageKey);
        if (stored == null) throw new Error(`localStorage 缺 key:${pers.storageKey}`);
        let parsed;
        try { parsed = JSON.parse(stored); } catch { throw new Error(`localStorage ${pers.storageKey} 不是 JSON`); }
        if (!prefsSubsetEqual(parsed, pers.expected))
          throw new Error(`localStorage ${pers.storageKey} 不含 expected prefs:${stored}`);
        const initial = pers.initialState ?? spec.states[0].id;
        for (let i = 0; i < Number(pers.reloads); i++) {
          await p.reload({ waitUntil: 'load' });
          await p.waitForFunction(() => !!window.__qa, undefined, { timeout: 5000 });
          const prefs = await p.evaluate(() => window.__qa.prefs());
          const cur = await p.evaluate(() => window.__qa.current());
          if (!prefsSubsetEqual(prefs, pers.expected))
            throw new Error(`reload ${i + 1} prefs 漂移:${JSON.stringify(prefs)}`);
          if (cur !== initial) throw new Error(`reload ${i + 1} current="${cur}", expected initial "${initial}"`);
        }
      } catch (err) {
        check.failures.push({ error: String(err.message || err).slice(0, 300), screenshot: await failShot('C-persistence') });
      }
      check.pass = check.failures.length === 0;
      gateC.checks.push(check);
    }
    gateC.pass = gateC.checks.length > 0 && gateC.checks.every((c) => c.pass);
  }

  // ---------- 门 D:渲染绑定 ----------
  const bindings = spec.bindings ?? [];
  let gateD;
  if (!runGate('D')) gateD = skippedGate('渲染绑定');
  else {
    gateD = makeGate('渲染绑定', bindings.length * cases.length);
    if (bindings.length === 0) {
      gateD.pass = true;
      gateD.detail = 'spec.bindings 未配置——渲染层未验证,还原承诺只到数据层';
    } else {
      for (const testCase of cases) {
        const p = await pageFor(testCase);
        for (const b of bindings) {
          const label = `${testCase.id} · ${b.sel} · ${b.prop}`;
          try {
            const raw = truthAt(truthObj, b.truth);
            if (raw === undefined) throw new Error(`truth 路径不存在:${b.truth}`);
            await freshLoad(p, base, { adaptive: !!spec.adaptive });
            await applyCase(p, testCase);
            await replay(p, b.via ?? []);
            const actual = await p.evaluate(({ sel, prop, pseudo }) => {
              const el = document.querySelector(sel);
              return el ? getComputedStyle(el, pseudo || null).getPropertyValue(prop).trim() : null;
            }, { sel: b.sel, prop: b.prop, pseudo: b.pseudo });
            if (actual === null) throw new Error('元素不存在');
            const kind = b.kind ?? (b.prop.includes('color') ? 'color' : 'length');
            if (kind === 'color') {
              const result = await p.evaluate(({ raw, actual }) => {
                const bad = /\b(inherit|currentColor|unset|initial|revert|revert-layer)\b|var\(/i;
                if (typeof raw !== 'string' || bad.test(raw) || !CSS.supports('color', raw))
                  return { ok: false, error: `非法或上下文相关 color truth:${raw}` };
                const norm = (color) => {
                  const d = document.createElement('div');
                  d.style.color = color;
                  document.body.appendChild(d);
                  const v = getComputedStyle(d).color;
                  d.remove();
                  return v;
                };
                return { ok: true, expected: norm(raw), actual: norm(actual) };
              }, { raw, actual });
              if (!result.ok) throw new Error(result.error);
              if (result.expected !== result.actual)
                throw new Error(`expected ${result.expected}, actual ${result.actual}`);
            } else if (kind === 'length') {
              const scale = b.scaled ? await p.evaluate(() => window.__qa.scale()) : 1;
              if (!Number.isFinite(Number(scale)) || Number(scale) <= 0) throw new Error(`__qa.scale 非 finite positive:${scale}`);
              const result = await p.evaluate((raw) => {
                if (typeof raw === 'number') return Number.isFinite(raw) ? { ok: true, px: raw } : { ok: false, error: 'length truth 非 finite number' };
                if (typeof raw !== 'string') return { ok: false, error: `非法 length truth:${raw}` };
                // 拒绝上下文相关单位——%/em/rem/vw/vh/vmin/vmax/ch/ex/cap/ic/lh/rlh/vi/vb/q、
                // calc()/var()/env()/attr()/clamp()/min()/max():它们的 px 取决于容器/字号/视口,
                // 在临时 div 上下文解析出的 px 与目标元素上下文不一致 → 会把错误样式判等(codex 复审 P0-6)。
                // truth 的几何应是产品常量的绝对 px(extract 提取的就是 px),故只允许绝对长度。
                if (/[a-z%(]/i.test(raw.replace(/^-?\d*\.?\d+\s*(px|pt|pc|cm|mm|in|Q)?$/i, '')))
                  return { ok: false, error: `length truth 含上下文相关单位/函数,禁用(只允许绝对 px/pt/pc/cm/mm/in/Q 或无单位数):${raw}` };
                const m = /^(-?\d*\.?\d+)\s*(px|pt|pc|cm|mm|in|Q)?$/i.exec(raw.trim());
                if (!m) return { ok: false, error: `非法或非绝对 CSS length:${raw}` };
                const d = document.createElement('div');
                d.style.width = `${m[1]}${m[2] ?? 'px'}`;
                d.style.position = 'absolute';
                d.style.visibility = 'hidden';
                document.body.appendChild(d);
                const px = parseFloat(getComputedStyle(d).width);
                d.remove();
                return Number.isFinite(px) ? { ok: true, px } : { ok: false, error: `CSS length 无法解析为 px:${raw}` };
              }, raw);
              if (!result.ok) throw new Error(result.error);
              const expectedPx = result.px * Number(scale);
              const actualPx = parseFloat(actual);
              if (!Number.isFinite(actualPx) || Math.abs(actualPx - expectedPx) > (b.tolerancePx ?? 0.75))
                throw new Error(`expected ${expectedPx}px, actual ${actual}`);
            } else if (kind === 'text') {
              const actualText = await p.locator(b.sel).first().textContent({ timeout: 4000 });
              if (String(raw) !== actualText.trim()) throw new Error(`expected text "${raw}", actual "${actualText.trim()}"`);
            } else if (kind === 'asset-sha') {
              const assetUrl = await p.evaluate(({ sel, prop, pseudo }) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                if (prop === 'src') return el.currentSrc || el.getAttribute('src');
                if (prop === 'href') return el.href || el.getAttribute('href');
                const value = getComputedStyle(el, pseudo || null).getPropertyValue(prop).trim();
                const m = value.match(/^url\(["']?(.+?)["']?\)$/);
                return m ? m[1] : value;
              }, { sel: b.sel, prop: b.prop, pseudo: b.pseudo });
              if (!assetUrl) throw new Error('元素不存在或 asset URL 为空');
              const resolved = new URL(assetUrl, base);
              if (resolved.origin !== new URL(base).origin) throw new Error(`asset-sha 只允许同源本地资源:${resolved.href}`);
              const response = await fetch(resolved);
              if (!response.ok) throw new Error(`asset 读取失败:${response.status} ${resolved.pathname}`);
              const actualSha = sha256Buffer(Buffer.from(await response.arrayBuffer()));
              const expectedSha = normalizeHash(raw);
              if (actualSha !== expectedSha) throw new Error(`expected sha256 ${expectedSha}, actual ${actualSha}`);
            } else if (String(raw) !== actual) {
              throw new Error(`expected "${raw}", actual "${actual}"`);
            }
            gateD.passed++;
          } catch (err) {
            gateD.failures.push({ binding: label, error: String(err.message || err).slice(0, 300), screenshot: await failShot(`D-${testCase.id}-${b.prop}`) });
          }
        }
        gateD.cases.push({ id: testCase.id, prefs: testCase.prefs });
      }
      gateD.pass = gateD.failures.length === 0;
    }
  }

  // ---------- 门 F:适配还原 ----------
  const ad = spec.adaptive;
  let gateF;
  if (!runGate('F')) gateF = skippedGate('适配还原');
  else {
    gateF = makeGate('适配还原', 0);
    if (!ad) {
      gateF.pass = true;
      gateF.detail = 'spec.adaptive 未配置——窗口拉伸行为未验证';
    } else {
      const samples = truthAt(truthObj, 'adaptive.samples') ?? [];
      const tol = ad.tolerancePx ?? 1;
      const probes = ad.probes ?? [];
      const frameSel = ad.frameSel ?? spec.baselineFrameSel ?? '.frame';
      gateF.total = samples.length + (ad.min ? 1 : 0);
      if (samples.length === 0) gateF.failures.push({ check: 'samples', error: 'truth.adaptive.samples 为空——extract 未按 sampleSizes 预计算期望几何' });
      // sampleSizes ↔ truth.samples 一一覆盖:声明了采样点却没预计算 = FAIL(不许缺采样点静默过)
      for (const [sw, sh] of ad.sampleSizes ?? []) {
        if (!samples.some((s) => s.w === sw && s.h === sh))
          gateF.failures.push({ check: `${sw}x${sh}`, error: 'sampleSizes 声明但 truth.samples 无对应期望几何' });
      }
      const finite = (v) => typeof v === 'number' && Number.isFinite(v);
      try {
        const p = await pageFor({});
        await freshLoad(p, base, { adaptive: true });
        for (const s of samples) {
          try {
            // resize 是控制 API;几何由 verifier 侧直接量 DOM(measureAdaptive),不信页面自报
            await p.evaluate(({ w, h }) => window.__qa.resize(w, h), { w: s.w, h: s.h });
            const m = await measureAdaptive(p, frameSel, probes);
            if (!finite(m.frame.w) || !finite(m.frame.h) || Math.abs(m.frame.w - s.w) > tol || Math.abs(m.frame.h - s.h) > tol)
              throw new Error(`resize(${s.w},${s.h}) 后 DOM 帧为 ${m.frame.w}x${m.frame.h}`);
            for (const probe of probes) {
              const want = s.probes?.[probe.id];
              const got = m.probes?.[probe.id];
              if (!want) { gateF.failures.push({ check: `${s.w}x${s.h}·${probe.id}`, error: 'truth 采样点缺该 probe 期望几何' }); continue; }
              if (!got) { gateF.failures.push({ check: `${s.w}x${s.h}·${probe.id}`, error: `probe selector ${probe.sel} 量不到 DOM 几何` }); continue; }
              for (const k of ['x', 'y', 'w', 'h']) {
                if (want[k] === undefined) continue;
                if (!finite(got[k]) || !finite(want[k]) || Math.abs(got[k] - want[k]) > tol)
                  gateF.failures.push({ check: `${s.w}x${s.h}·${probe.id}.${k}`, expected: want[k], actual: got[k] });
              }
            }
            gateF.passed++;
          } catch (err) {
            gateF.failures.push({ check: `${s.w}x${s.h}`, error: String(err.message || err).slice(0, 300), screenshot: await failShot(`F-${s.w}x${s.h}`) });
          }
        }
        if (ad.min) {
          await p.evaluate(({ w, h }) => window.__qa.resize(w, h), { w: Math.max(1, ad.min.w - 120), h: Math.max(1, ad.min.h - 120) });
          const m = await measureAdaptive(p, frameSel, []);
          if (!finite(m.frame.w) || !finite(m.frame.h) || Math.abs(m.frame.w - ad.min.w) > tol || Math.abs(m.frame.h - ad.min.h) > tol)
            gateF.failures.push({ check: 'min-clamp', expected: `${ad.min.w}x${ad.min.h}`, actual: `${m.frame.w}x${m.frame.h}` });
          else gateF.passed++;
        }
      } catch (err) {
        gateF.failures.push({ check: 'api', error: String(err.message || err).slice(0, 300) });
      }
      gateF.pass = gateF.failures.length === 0;
    }
  }

  // ---------- 门 X:自定义门(demo 专属体外脚本,注册进防伪链) ----------
  // 背景:多个真实 demo 自建了 overlap-gate.mjs / interaction-gate.mjs 等体外脚本,
  // 不进 report/hash 链——pr-block 不知道它们跑没跑。注册进 spec.customGates 后:
  // 脚本 hash 计入 inputHashes(改脚本 = report 失效),结果计入 report.ok。
  const customGates = spec.customGates ?? [];
  let gateX;
  if (!runGate('X')) gateX = skippedGate('自定义门');
  else {
    gateX = { name: '自定义门', pass: false, total: customGates.length, passed: 0, failures: [], gates: [] };
    if (customGates.length === 0) {
      gateX.pass = true;
      gateX.detail = '未声明 customGates';
    } else {
      for (const g of customGates) {
        const entry = { id: g.id, script: g.script, pass: false, detail: '' };
        try {
          const out = execFileSync(process.execPath, [join(demoDir, g.script), '--demo', demoDir], {
            cwd: demoDir,
            encoding: 'utf8',
            timeout: Number(g.timeoutMs ?? 180000),
            maxBuffer: 32 * 1024 * 1024,
          });
          entry.pass = true;
          entry.detail = out.trim().split('\n').slice(-3).join('\n').slice(0, 400);
          gateX.passed++;
        } catch (err) {
          entry.detail = String(err.stdout || err.stderr || err.message).slice(-400);
          gateX.failures.push({ gate: g.id, error: entry.detail });
        }
        gateX.gates.push(entry);
      }
      gateX.pass = gateX.failures.length === 0;
    }
  }

  const gatesRun = [gateA, gateB, gateC, gateD, gateF, gateX].filter((g) => !g.skipped);
  const allPass = gatesRun.every((g) => g.pass);
  const statesResult = {
    total: spec.states.length,
    viaReachable: spec.states.filter((s) => Array.isArray(s.via)).length,
    tabOnly: spec.states.filter((s) => s.via === null).length,
  };
  const report = {
    ok: allPass,
    partial,
    ...(partial ? { filters: { gates: gateFilter ?? null, cases: caseFilter ?? null, states: stateFilter ?? null }, partialNote: '增量运行仅供调试;定稿必须全量重跑 verify(pr-block 拒收 partial 报告)' } : {}),
    toolVersion: TOOL_VERSION,
    demo: spec.meta?.name ?? demoDir,
    inputHashes,
    statesResult,
    coverage: { cases: cases.map((c) => ({ id: c.id, prefs: c.prefs, source: c.source, ...(c.viewport ? { viewport: c.viewport } : {}) })) },
    gateA,
    gateB,
    gateC,
    gateD,
    gateF,
    gateX,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(demoDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = allPass ? 0 : 2;
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err.message || err), toolVersion: TOOL_VERSION }, null, 2));
  process.exitCode = 2;
} finally {
  try { if (page) await page.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  try { if (safeServer) await safeServer.close(); } catch {}
}
