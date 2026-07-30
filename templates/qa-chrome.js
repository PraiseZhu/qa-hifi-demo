/* qa-chrome.js — qa-hifi-demo 标准 chrome 运行时(由 init.mjs 内联进 index.html)。
 *
 * 诞生背景:__qa 五个 API + 偏好持久化 + matrix 切换器 + 状态补齐 tab 曾由每个 demo
 * 重新实现一遍——10 个 demo 写出 10 种偏好切换器(replay.mjs clickPref 要猜 7 种 selector
 * 就是后果)。本文件是「demo 合约」的唯一标准实现;demo 作者只提供 window.__qaDemo 配置:
 *
 *   window.__qaDemo = {
 *     name: 'my-demo',                 // 必填,localStorage key 用
 *     pr: 123,                         // 可选,PR 号徽标
 *     summary: { what, how, accept },  // 三段说明(各 ≤2 行)
 *     matrix: {                        // 五维切换器;键固定 plat/region/os/mode/lang
 *       plat:   { label: '端',   options: [{ v: 'desk', label: '桌面' }, ...] },
 *       region: { label: '区域', options: [...] },
 *       os:     { label: '系统', options: [...] },
 *       mode:   { label: '主题', options: [...] },
 *       lang:   { label: '语言', options: [...] },
 *     },
 *     defaultPrefs: { plat, region, os, mode, lang },   // 必填,全 string
 *     initialState: 'entry',                            // 必填
 *     states: { entry: {}, scanning: {}, ... },         // 必填:id → {}(可带 onEnter(ctx))
 *     tabStates: [{ id, label, note }],                 // via:null 状态(注意与 spec.states 对齐)
 *     adaptive: null | { min: {w,h}, initial: {w,h}, bandLabel: (w,h)=>string },
 *     scale: (prefs) => 1,                              // 设计px→CSS px(默认 1)
 *     renderApp(ctx) { ... },                           // 必填:渲染界面本体进 ctx.frame
 *   };
 *
 * ctx = { truth, prefs, state, frame, setState(id), chrome }。truth 已解包(叶子裸值)。
 * 标准 DOM 合约(verify.mjs replay.mjs 的第一优先 selector,别改):
 *   偏好入口   [data-qa-pref="key:value"]
 *   状态 tab   [data-qa-state-tab]
 *   状态入口   [data-qa-goto="<state-id>"]
 *   帧容器     .frame
 */
(() => {
  'use strict';
  const cfg = window.__qaDemo;
  if (!cfg) throw new Error('qa-chrome: 缺 window.__qaDemo 配置(必须在本脚本之前定义)');
  for (const key of ['name', 'defaultPrefs', 'initialState', 'states', 'renderApp']) {
    if (!cfg[key]) throw new Error(`qa-chrome: __qaDemo.${key} 必填`);
  }

  // ---------- truth ----------
  const truthEl = document.getElementById('qa-truth');
  if (!truthEl) throw new Error('qa-chrome: 缺 <script id="qa-truth"> 内嵌真值块');
  const RAW_TRUTH = JSON.parse(truthEl.textContent);
  const unwrap = (n) => {
    if (n && typeof n === 'object' && !Array.isArray(n) && 'value' in n && n.provenance) return n.value;
    if (Array.isArray(n)) return n.map(unwrap);
    if (n && typeof n === 'object') return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, unwrap(v)]));
    return n;
  };
  const TRUTH = unwrap(RAW_TRUTH);

  // ---------- prefs(五维,localStorage 持久化;流程状态不持久化) ----------
  const PREF_KEYS = ['plat', 'region', 'os', 'mode', 'lang'];
  const STORE_KEY = `qa-hifi:${cfg.name}:prefs`;
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch {}
  const prefs = { ...cfg.defaultPrefs };
  if (stored && typeof stored === 'object') for (const k of PREF_KEYS) if (typeof stored[k] === 'string') prefs[k] = stored[k];
  const persistPrefs = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch {} };

  // ---------- state ----------
  let state = cfg.initialState;
  if (!(state in cfg.states)) throw new Error(`qa-chrome: initialState "${state}" 不在 states 里`);

  // ---------- chrome DOM ----------
  const css = `
  :root { --qa-bg:#f4f5f7; --qa-panel:#fff; --qa-ink:#1c1e21; --qa-sub:#6b7280; --qa-line:#e5e7eb; --qa-acc:#2563eb; }
  body.qa-dark { --qa-bg:#111318; --qa-panel:#1b1e25; --qa-ink:#e8eaed; --qa-sub:#9aa0a6; --qa-line:#2c313a; --qa-acc:#5b8def; }
  body { margin:0; background:var(--qa-bg); color:var(--qa-ink); font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .qa-chrome { padding:12px 16px; border-bottom:1px solid var(--qa-line); background:var(--qa-panel); }
  .qa-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .qa-title { font-size:15px; font-weight:600; }
  .qa-badge { font-size:12px; padding:1px 8px; border-radius:999px; background:var(--qa-acc); color:#fff; }
  .qa-summary { margin:6px 0 0; padding:0; list-style:none; color:var(--qa-sub); font-size:12px; }
  .qa-summary b { color:var(--qa-ink); font-weight:600; }
  .qa-ctl { display:flex; gap:14px; flex-wrap:wrap; margin-top:10px; align-items:center; }
  .qa-seg { display:flex; align-items:center; gap:6px; }
  .qa-seg-label { font-size:12px; color:var(--qa-sub); }
  .qa-seg-group { display:inline-flex; border:1px solid var(--qa-line); border-radius:8px; overflow:hidden; }
  .qa-seg-group button { border:0; background:transparent; color:var(--qa-ink); padding:3px 10px; font-size:12px; cursor:pointer; }
  .qa-seg-group button.on { background:var(--qa-acc); color:#fff; }
  .qa-tabbtn { margin-left:auto; border:1px solid var(--qa-line); background:transparent; color:var(--qa-ink); border-radius:8px; padding:3px 12px; font-size:12px; cursor:pointer; }
  .qa-tabbtn.on { background:var(--qa-acc); color:#fff; border-color:var(--qa-acc); }
  .qa-tabpanel { display:none; margin-top:10px; border:1px dashed var(--qa-line); border-radius:8px; padding:10px; }
  .qa-tabpanel.on { display:block; }
  .qa-tabpanel .qa-tab-entry { display:flex; gap:8px; align-items:baseline; padding:4px 0; }
  .qa-tabpanel .qa-tab-entry button { border:1px solid var(--qa-acc); color:var(--qa-acc); background:transparent; border-radius:6px; padding:2px 10px; font-size:12px; cursor:pointer; }
  .qa-tabpanel .qa-tab-note { color:var(--qa-sub); font-size:12px; }
  .qa-stage { display:flex; justify-content:center; padding:28px 16px; }
  .qa-framewrap { position:relative; }
  .frame { position:relative; background:var(--qa-panel); border:1px solid var(--qa-line); border-radius:12px; overflow:hidden; box-shadow:0 8px 30px rgba(0,0,0,.08); }
  .qa-size-badge { position:absolute; left:0; bottom:-22px; font-size:11px; color:var(--qa-sub); }
  .qa-handle { position:absolute; z-index:9; }
  .qa-handle-e { right:-6px; top:0; width:12px; height:100%; cursor:ew-resize; }
  .qa-handle-s { bottom:-6px; left:0; height:12px; width:100%; cursor:ns-resize; }
  .qa-handle-se { right:-8px; bottom:-8px; width:16px; height:16px; cursor:nwse-resize; }
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const chromeEl = document.createElement('div');
  chromeEl.className = 'qa-chrome';
  const head = document.createElement('div');
  head.className = 'qa-head';
  const title = document.createElement('span');
  title.className = 'qa-title';
  title.textContent = cfg.name;
  head.appendChild(title);
  if (cfg.pr) {
    const badge = document.createElement('span');
    badge.className = 'qa-badge';
    badge.textContent = `PR #${cfg.pr}`;
    head.appendChild(badge);
  }
  chromeEl.appendChild(head);
  if (cfg.summary) {
    const ul = document.createElement('ul');
    ul.className = 'qa-summary';
    for (const [k, label] of [['what', '做了什么'], ['how', '怎么做'], ['accept', '怎么验收']]) {
      if (!cfg.summary[k]) continue;
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = `${label}:`;
      li.appendChild(b);
      li.appendChild(document.createTextNode(cfg.summary[k]));
      ul.appendChild(li);
    }
    chromeEl.appendChild(ul);
  }

  const ctl = document.createElement('div');
  ctl.className = 'qa-ctl';
  const segButtons = {};
  for (const key of PREF_KEYS) {
    const dim = cfg.matrix?.[key];
    if (!dim || !Array.isArray(dim.options) || dim.options.length === 0) continue;
    const seg = document.createElement('div');
    seg.className = 'qa-seg';
    const label = document.createElement('span');
    label.className = 'qa-seg-label';
    label.textContent = dim.label ?? key;
    seg.appendChild(label);
    const group = document.createElement('div');
    group.className = 'qa-seg-group';
    for (const opt of dim.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.qaPref = `${key}:${opt.v}`;
      btn.textContent = opt.label ?? opt.v;
      btn.addEventListener('click', () => { prefs[key] = opt.v; persistPrefs(); render(); });
      group.appendChild(btn);
      (segButtons[key] ??= []).push({ v: opt.v, btn });
    }
    seg.appendChild(group);
    ctl.appendChild(seg);
  }

  // 状态补齐 tab(via:null 状态的唯一取证入口;进 tab 必须写理由)
  const tabStates = Array.isArray(cfg.tabStates) ? cfg.tabStates : [];
  let tabOpen = false;
  let tabBtn = null;
  let tabPanel = null;
  if (tabStates.length) {
    tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = 'qa-tabbtn';
    tabBtn.dataset.qaStateTab = '';
    tabBtn.textContent = '状态补齐';
    tabBtn.addEventListener('click', () => { tabOpen = !tabOpen; render(); });
    ctl.appendChild(tabBtn);

    tabPanel = document.createElement('div');
    tabPanel.className = 'qa-tabpanel';
    for (const ts of tabStates) {
      if (!(ts.id in cfg.states)) throw new Error(`qa-chrome: tabStates "${ts.id}" 不在 states 里`);
      const row = document.createElement('div');
      row.className = 'qa-tab-entry';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.qaGoto = ts.id;
      btn.textContent = ts.label ?? ts.id;
      btn.addEventListener('click', () => { gotoState(ts.id); });
      row.appendChild(btn);
      const note = document.createElement('span');
      note.className = 'qa-tab-note';
      note.textContent = ts.note ?? '';
      row.appendChild(note);
      tabPanel.appendChild(row);
    }
  }
  chromeEl.appendChild(ctl);
  if (tabPanel) chromeEl.appendChild(tabPanel);
  document.body.prepend(chromeEl);

  // ---------- 帧 + 拉伸 ----------
  const stage = document.createElement('div');
  stage.className = 'qa-stage';
  const frameWrap = document.createElement('div');
  frameWrap.className = 'qa-framewrap';
  const frame = document.createElement('div');
  frame.className = 'frame';
  frameWrap.appendChild(frame);
  stage.appendChild(frameWrap);
  document.body.appendChild(stage);

  const ad = cfg.adaptive ?? null;
  let frameW = ad?.initial?.w ?? ad?.min?.w ?? 960;
  let frameH = ad?.initial?.h ?? ad?.min?.h ?? 640;
  let sizeBadge = null;

  // 拖拽手柄与 __qa.resize 走同一代码路径(setFrameSize),内部 clamp 到 adaptive.min
  function setFrameSize(w, h) {
    if (ad?.min) { w = Math.max(ad.min.w, w); h = Math.max(ad.min.h, h); }
    frameW = Math.round(w);
    frameH = Math.round(h);
    frame.style.width = `${frameW}px`;
    frame.style.height = `${frameH}px`;
    if (sizeBadge) {
      const band = typeof ad?.bandLabel === 'function' ? ` · ${ad.bandLabel(frameW, frameH)}` : '';
      sizeBadge.textContent = `${frameW}×${frameH}${band}`;
    }
    render();
  }
  if (ad) {
    sizeBadge = document.createElement('div');
    sizeBadge.className = 'qa-size-badge';
    frameWrap.appendChild(sizeBadge);
    for (const [dirCls, dx, dy] of [['e', 1, 0], ['s', 0, 1], ['se', 1, 1]]) {
      const handle = document.createElement('div');
      handle.className = `qa-handle qa-handle-${dirCls}`;
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = frameW;
        const startH = frameH;
        const move = (ev) => setFrameSize(startW + (ev.clientX - startX) * dx, startH + (ev.clientY - startY) * dy);
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      frameWrap.appendChild(handle);
    }
  }

  // ---------- 状态机 ----------
  function gotoState(id) {
    if (!(id in cfg.states)) throw new Error(`qa-chrome: unknown state "${id}"`);
    state = id;
    const onEnter = cfg.states[id]?.onEnter;
    render();
    if (typeof onEnter === 'function') onEnter(ctx());
  }

  function ctx() {
    return { truth: TRUTH, rawTruth: RAW_TRUTH, prefs: { ...prefs }, state, frame, setState: gotoState, chrome: chromeEl };
  }

  // ---------- 渲染 ----------
  function render() {
    document.body.classList.toggle('qa-dark', prefs.mode === 'dark');
    for (const key of Object.keys(segButtons)) {
      for (const { v, btn } of segButtons[key]) btn.classList.toggle('on', prefs[key] === v);
    }
    if (tabBtn) tabBtn.classList.toggle('on', tabOpen);
    if (tabPanel) tabPanel.classList.toggle('on', tabOpen);
    cfg.renderApp(ctx());
  }

  // ---------- __qa API(demo 合约) ----------
  window.__qa = {
    current: () => state,
    goto: (id) => { gotoState(id); },
    prefs: () => ({ ...prefs }),
    scale: () => (typeof cfg.scale === 'function' ? Number(cfg.scale({ ...prefs })) : 1),
    resize: (w, h) => { setFrameSize(Number(w), Number(h)); },
    metrics: (ids) => {
      const fr = frame.getBoundingClientRect();
      const probes = {};
      for (const id of ids ?? []) {
        const el = frame.querySelector(`[data-qa-probe="${id}"]`);
        if (!el) { probes[id] = null; continue; }
        const r = el.getBoundingClientRect();
        probes[id] = { x: r.x - fr.x, y: r.y - fr.y, w: r.width, h: r.height };
      }
      return { frame: { w: fr.width, h: fr.height }, probes };
    },
  };

  // ---------- 启动 ----------
  setFrameSize(frameW, frameH);
})();
