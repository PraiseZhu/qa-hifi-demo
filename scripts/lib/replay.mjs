import { prefsSubsetEqual } from './schema.mjs';

export async function waitForQa(page, { adaptive = false } = {}) {
  await page.waitForFunction(() => typeof window.__qa === 'object' && typeof window.__qa.current === 'function', undefined, { timeout: 5000 });
  const result = await page.evaluate(async ({ adaptive }) => {
    const problems = [];
    const qa = window.__qa;
    for (const key of ['current', 'goto', 'prefs', 'scale']) {
      if (typeof qa[key] !== 'function') problems.push(`__qa.${key} must be function`);
    }
    if (adaptive) {
      // 门 F 用 verifier 侧 DOM 量几何,只需 resize 控制 API;metrics 降为可选调试(不作取证)
      if (typeof qa.resize !== 'function') problems.push('__qa.resize must be function');
    }
    let cur = null;
    try { cur = qa.current(); } catch (err) { problems.push(`__qa.current throws:${err.message}`); }
    try {
      const prefs = qa.prefs();
      for (const key of ['plat', 'region', 'os', 'mode', 'lang']) {
        if (typeof prefs?.[key] !== 'string') problems.push(`__qa.prefs().${key} must be string`);
      }
    } catch (err) { problems.push(`__qa.prefs throws:${err.message}`); }
    try {
      const scale = Number(qa.scale());
      if (!Number.isFinite(scale) || scale <= 0) problems.push('__qa.scale must return finite positive number');
    } catch (err) { problems.push(`__qa.scale throws:${err.message}`); }
    try {
      let rejected = false;
      try {
        const r = qa.goto('__qa_unknown_state__');
        if (r && typeof r.then === 'function') await r;
      } catch {
        rejected = true;
      }
      if (!rejected) problems.push('__qa.goto(unknown) must throw/reject');
      if (cur != null && qa.current() !== cur) problems.push('__qa.goto(unknown) changed current state');
    } catch (err) {
      problems.push(`__qa.goto unknown contract check failed:${err.message}`);
    }
    return problems;
  }, { adaptive });
  if (result.length) throw new Error(result.join('; '));
}

export async function freshLoad(page, base, options = {}) {
  await page.goto(base, { waitUntil: 'load' });
  if (options.clearStorage !== false) {
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload({ waitUntil: 'load' });
  }
  await waitForQa(page, options);
}

export async function replay(page, steps = []) {
  if (!Array.isArray(steps)) throw new Error('via must be an array');
  for (const [i, step] of steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`via[${i}] must be object`);
    const kinds = ['click', 'type', 'waitMs', 'expect'].filter((k) => Object.hasOwn(step, k));
    if (kinds.length !== 1) throw new Error(`via[${i}] has invalid step shape`);
    if (Object.hasOwn(step, 'click')) await page.click(step.click, { timeout: 4000 });
    else if (Object.hasOwn(step, 'type')) {
      const { sel, text, delayMs = 60 } = step.type;
      await page.click(sel, { timeout: 4000 });
      await page.type(sel, text, { delay: delayMs });
    } else if (Object.hasOwn(step, 'waitMs')) await page.waitForTimeout(step.waitMs);
    else if (Object.hasOwn(step, 'expect')) {
      const cur = await page.evaluate(() => window.__qa.current());
      if (cur !== step.expect) throw new Error(`expect "${step.expect}", got "${cur}"`);
    }
  }
}

// 真实可点击性判定:Playwright 的 visible 不查 opacity,故这里额外走祖先链核 effective
// opacity>0 与 pointer-events!=none——挡 opacity:0 / pointer-events:none 的「假入口自证」
// (codex 复审 P0-2/P0-3:原 main-world 合成 click 无 actionability 校验,隐藏入口也能取证)。
async function firstActionable(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) continue;
    let visible = false;
    try {
      await loc.waitFor({ state: 'visible', timeout: 1500 });
      visible = true;
    } catch { visible = false; }
    if (!visible) continue;
    const renderable = await loc.evaluate((el) => {
      let n = el;
      while (n) {
        const s = getComputedStyle(n);
        if (parseFloat(s.opacity) === 0) return false;
        if (s.pointerEvents === 'none') return false;
        n = n.parentElement;
      }
      return true;
    });
    if (renderable) return loc;
  }
  return null;
}

export async function clickPref(page, key, value) {
  const candidates = [
    `[data-qa-pref="${key}:${value}"]`,
    `[data-pref="${key}:${value}"]`,
    `[data-pref-key="${key}"][data-pref-value="${value}"]`,
    `[data-key="${key}"][data-v="${value}"]`,
    `#seg${key[0].toUpperCase()}${key.slice(1)} [data-v="${value}"]`,
    `[data-v="${value}"]`,
    `[data-seg="${value}"]`,
  ];
  const loc = await firstActionable(page, candidates);
  if (!loc) throw new Error(`无法通过可交互 DOM 入口切换偏好 ${key}=${value}(缺入口/隐藏/opacity:0/pointer-events:none)`);
  // Playwright click 再次校验 actionability + hit-test(被遮挡则超时失败)
  await loc.click({ timeout: 4000 });
}

export async function applyCase(page, testCase) {
  if (Array.isArray(testCase.via)) await replay(page, testCase.via);
  else {
    const order = ['plat', 'region', 'os', 'mode', 'lang'];
    for (const key of order) {
      if (testCase.prefs?.[key] !== undefined) await clickPref(page, key, testCase.prefs[key]);
    }
  }
  const prefs = await page.evaluate(() => window.__qa.prefs());
  if (!prefsSubsetEqual(prefs, testCase.prefs)) {
    throw new Error(`case prefs mismatch expected ${JSON.stringify(testCase.prefs)}, got ${JSON.stringify(prefs)}`);
  }
  return prefs;
}

// verifier 侧直接量 DOM 几何(帧内相对坐标),不信 __qa.metrics 自报(codex 复审 P0-C)。
// 返回 { frame:{w,h}, probes:{ <id>:{x,y,w,h} } };元素缺失/无 box 时该 probe 记 null。
export async function measureAdaptive(page, frameSel, probes) {
  const frame = await page.locator(frameSel).first().boundingBox();
  if (!frame) throw new Error(`门F 量不到帧元素 ${frameSel} 的 boundingBox`);
  // r12:probes 的 key 是 spec 里作者可控的 probe id,同一形状 —— 用无原型对象
  const out = { frame: { w: frame.width, h: frame.height }, probes: Object.create(null) };
  for (const p of probes) {
    const loc = page.locator(p.sel).first();
    if ((await loc.count()) === 0) { out.probes[p.id] = null; continue; }
    const box = await loc.boundingBox();
    out.probes[p.id] = box
      ? { x: box.x - frame.x, y: box.y - frame.y, w: box.width, h: box.height }
      : null;
  }
  return out;
}

export async function reachTabState(page, state) {
  // tab 入口与状态项都必须是「reviewer 真能看见并点」的入口——走 Playwright actionability
  // + effective-opacity/pointer-events 校验,不接受合成 click(codex 复审 P0-2)。
  const tab = await firstActionable(page, ['[data-qa-state-tab]', '[data-state-tab]', '[data-tab="states"]', '[data-tab="状态补齐"]']);
  if (!tab) throw new Error('tab-only 状态缺少可交互的「状态补齐」tab DOM 入口(隐藏/opacity:0 不算)');
  await tab.click({ timeout: 4000 });
  const entry = await firstActionable(page, [`[data-qa-goto="${state.id}"]`, `[data-state-id="${state.id}"]`, `[data-goto="${state.id}"]`]);
  if (!entry) throw new Error(`「状态补齐」tab 缺少状态 "${state.id}" 的可交互 DOM 入口`);
  await entry.click({ timeout: 4000 });
  const cur = await page.evaluate(() => window.__qa.current());
  if (cur !== state.id) throw new Error(`tab 入口点击后 current="${cur}", expected "${state.id}"`);
}
