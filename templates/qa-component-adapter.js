/* qa-component-adapter.js — 组件模式(spec.component.mode === 'component')下 __qa 合约的标准实现。
 *
 * 地位:与 templates/qa-chrome.js 并列的「demo 合约」标准实现,但服务的是
 * **真产品组件浏览器直渲**(esbuild bundle 真组件 + shim hooks),而不是 LLM 手写 HTML 复刻。
 * 它不重写 chrome 工具区,而是**叠加在 qa-chrome.js 之上**——DOM 合约
 * (data-qa-pref / data-qa-state-tab / data-qa-goto / .frame)与复刻模式逐字节相同,
 * verify.mjs / replay.mjs 的 selector 不需要任何组件模式分支。
 *
 * 内联顺序(硬性,init.mjs 按此拼 index.html):
 *   ① <script id="qa-truth" type="application/json">…<\/script>  真值块(含 truth.themeVars)
 *      (上面这处结束标签写成 <\/script>:本文件会被内联进 index.html 的 <script> 里,
 *       出现裸的结束标签会被 HTML 分词器提前截断脚本——init.mjs 也做了同样的兜底转义)
 *   ② demo bundle(assets/component.bundle.js):bootstrap 里定义 window.__qaDemo(见下)
 *   ③ 本文件                                     ← 读 truth、装主题桥、包 goto、补 renderApp
 *   ④ qa-chrome.js                               ← 建 chrome DOM、建 window.__qa
 * 本文件跑在 qa-chrome **之前**(它要先把 __qaDemo 补成 qa-chrome 能吃的形状),
 * 对 window.__qa 的加工靠一个 accessor 钩子完成——qa-chrome 赋值的那一刻被包装。
 *
 * 组件模式的 window.__qaDemo(由 demo 作者的 bootstrap 提供):
 *   window.__qaDemo = {
 *     mode: 'component',               // 必填,组件模式标记
 *     name, pr, summary, matrix, defaultPrefs, initialState, tabStates, adaptive, scale,
 *                                      // ↑ 语义与 qa-chrome 完全一致
 *     states: {                        // 必填;键 ≡ spec.states[].id
 *       entry:        { driver: 'inject' },              // 可被 inject(id) 直达
 *       'sso-org':    { driver: 'via', onEnter(ctx){} },  // 局部 useState,只能真实交互到达
 *     },
 *     mount(ctx) { ... },              // 必填,只调用一次:把真组件挂到 ctx.root(在 .frame 内)
 *     inject(id) { ... },              // driver:'inject' 状态必填:推 reducer/setState 到该状态
 *     onPrefs(prefs) { ... },          // 可选:偏好变化(lang/region/os/plat…)回调,主题由本层接管
 *   };
 *
 * ctx = { truth, rawTruth, prefs, state, frame, root, setState, chrome }。
 *
 * 与 qa-chrome 的语义差异(诚实清单):
 * - `renderApp` 由本层合成:首帧调 `mount(ctx)` 一次,之后每次 render 只做「主题桥 + onPrefs」
 *   ——真组件自己持有 React 树,重复 unmount/mount 会丢局部 useState(consent 弹窗、sso-org 子视图)。
 * - `__qa.goto(id)`:未声明 id → throw;`driver:'via'` → throw(该状态只能 via 链路到达,
 *   门 B 本来就走 via 重放取证,不依赖 goto);其余 → 走 `inject(id)` 把真组件推到该状态。
 * - 主题不再由 demo CSS 承担:`truth.themeVars` 复刻产品 `theme-service.applyTheme` 语义
 *   (重写 style#theme-vars + 切 html.dark + colorScheme),色值来源是产品 themes 源码(带 provenance)。
 */
(() => {
  'use strict';
  const ADAPTER_VERSION = 1;
  const cfg = window.__qaDemo;
  if (!cfg) throw new Error('qa-component-adapter: 缺 window.__qaDemo(必须由 demo bundle 在本脚本之前定义)');
  if (cfg.mode !== 'component') throw new Error(`qa-component-adapter: __qaDemo.mode 必须是 "component"(当前 ${JSON.stringify(cfg.mode)})`);
  if (typeof cfg.mount !== 'function') throw new Error('qa-component-adapter: __qaDemo.mount(ctx) 必填(把真组件挂到 ctx.root)');
  if (typeof cfg.renderApp === 'function') throw new Error('qa-component-adapter: 组件模式不接受自带 renderApp(渲染由 mount 一次性接管)');
  if (!cfg.states || typeof cfg.states !== 'object') throw new Error('qa-component-adapter: __qaDemo.states 必填');

  // ---------- driver 表(键 ≡ spec.states[].id;缺省视为 inject) ----------
  const DRIVERS = Object.create(null);
  for (const [id, st] of Object.entries(cfg.states)) {
    const d = st && typeof st === 'object' ? st.driver : undefined;
    if (d !== undefined && d !== 'inject' && d !== 'via') {
      throw new Error(`qa-component-adapter: states.${id}.driver 只允许 "inject"|"via"(当前 ${JSON.stringify(d)})`);
    }
    DRIVERS[id] = d ?? 'inject';
  }
  const injectIds = Object.keys(DRIVERS).filter((id) => DRIVERS[id] === 'inject');
  if (injectIds.length > 0 && typeof cfg.inject !== 'function') {
    throw new Error(`qa-component-adapter: 有 driver:"inject" 状态(${injectIds.join(', ')})但未提供 __qaDemo.inject(id)`);
  }
  // via 型状态不该出现在「状态补齐」tab 里:tab 是直达入口,与「只能 via 到达」矛盾。
  for (const ts of Array.isArray(cfg.tabStates) ? cfg.tabStates : []) {
    if (ts && DRIVERS[ts.id] === 'via') throw new Error(`qa-component-adapter: tabStates 含 driver:"via" 状态 "${ts.id}"(via 状态只能真实交互到达,不能给直达入口)`);
  }

  // ---------- 主题桥(复刻产品 theme-service.applyTheme 语义) ----------
  const truthEl = document.getElementById('qa-truth');
  if (!truthEl) throw new Error('qa-component-adapter: 缺 <script id="qa-truth"> 内嵌真值块');
  let RAW_TRUTH;
  try {
    RAW_TRUTH = JSON.parse(truthEl.textContent);
  } catch (err) {
    throw new Error(`qa-component-adapter: #qa-truth 不是合法 JSON:${err.message}`);
  }
  const unwrap = (n) => {
    if (n && typeof n === 'object' && !Array.isArray(n) && 'value' in n && n.provenance) return n.value;
    if (Array.isArray(n)) return n.map(unwrap);
    if (n && typeof n === 'object') return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, unwrap(v)]));
    return n;
  };
  const TRUTH = unwrap(RAW_TRUTH);

  /* themeVars 两种合法形状(extract 侧择一,本层都吃):
   *   token 优先:themeVars.<token> = { light: '#..', dark: '#..' }   ← 推荐(一个 token 一个叶子对)
   *   mode  优先:themeVars.<mode>  = { <token>: '#..' }
   * 空/缺失 → 主题桥关闭(如实降级:组件模式但没提供色值,不假装应用了主题)。 */
  const rawVars = TRUTH && typeof TRUTH.themeVars === 'object' && TRUTH.themeVars !== null ? TRUTH.themeVars : null;
  function pickModeVars(mode) {
    if (!rawVars) return null;
    const keys = Object.keys(rawVars);
    if (keys.length === 0) return null;
    const modeFirst = keys.every((k) => k === 'light' || k === 'dark') && keys.some((k) => rawVars[k] && typeof rawVars[k] === 'object');
    const out = {};
    if (modeFirst) {
      const bucket = rawVars[mode];
      if (!bucket || typeof bucket !== 'object') return null;
      for (const [token, v] of Object.entries(bucket)) if (v !== null && v !== undefined && typeof v !== 'object') out[token] = v;
    } else {
      for (const [token, pair] of Object.entries(rawVars)) {
        if (!pair || typeof pair !== 'object' || Array.isArray(pair)) continue;
        const v = Object.hasOwn(pair, mode) ? pair[mode] : undefined;
        if (v !== null && v !== undefined && typeof v !== 'object') out[token] = v;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  const cssVarName = (token) => (String(token).startsWith('--') ? String(token) : `--${token}`);
  let appliedMode = null;
  function applyTheme(mode) {
    const m = mode === 'dark' ? 'dark' : 'light';
    const vars = pickModeVars(m);
    if (vars) {
      let style = document.getElementById('theme-vars');
      if (!style) {
        style = document.createElement('style');
        style.id = 'theme-vars';
        document.head.appendChild(style);
      }
      const decls = Object.entries(vars).map(([token, v]) => `${cssVarName(token)}:${v};`).join('');
      style.textContent = `:root{${decls}}`;
    }
    const root = document.documentElement;
    root.classList.toggle('dark', m === 'dark');
    root.style.colorScheme = m;
    appliedMode = m;
    return Boolean(vars);
  }
  applyTheme(cfg.defaultPrefs?.mode === 'dark' ? 'dark' : 'light');

  // ---------- renderApp 合成:mount 一次,之后只推主题与偏好 ----------
  let mounted = false;
  let rootEl = null;
  cfg.renderApp = (ctx) => {
    applyTheme(ctx.prefs?.mode);
    if (!mounted) {
      rootEl = document.createElement('div');
      rootEl.className = 'qa-component-root';
      rootEl.dataset.qaComponentRoot = '';
      ctx.frame.appendChild(rootEl);
      mounted = true;
      cfg.mount({ ...ctx, root: rootEl });
      // 首帧状态也要真注入:qa-chrome 只对 gotoState 调 onEnter,initialState 不经该路径,
      // 不注入的话「声明的 initialState」与「组件自带默认 state」可能不是同一个而无人发现。
      if (DRIVERS[ctx.state] === 'inject') cfg.inject(ctx.state);
      // mount 之后也要过一遍 onPrefs:首帧的非主题偏好(lang/region/…)同样得生效。
    }
    if (typeof cfg.onPrefs === 'function') cfg.onPrefs({ ...ctx.prefs });
  };

  // ---------- goto 分流:inject 走 inject(id),via 直接拒绝,未知 id 抛错 ----------
  function wrapApi(api) {
    if (!api || typeof api.goto !== 'function') return api;
    const origGoto = api.goto.bind(api);
    api.goto = (id) => {
      const key = String(id);
      if (!Object.hasOwn(DRIVERS, key)) throw new Error(`qa-component-adapter: unknown state "${key}"`);
      if (DRIVERS[key] === 'via') throw new Error(`qa-component-adapter: 状态 "${key}" 只能 via 链路到达(driver:"via",局部组件状态无法外部注入;门 B 走 via 重放取证)`);
      // 真注入统一由 onEnter 承担(见下),goto 这里只做分流校验——单一注入路径,不会双注入。
      origGoto(key);
    };
    return api;
  }
  // qa-chrome 在本脚本之后执行 `window.__qa = {...}`——用 accessor 在赋值那一刻接管。
  let installed = window.__qa ? wrapApi(window.__qa) : null;
  Object.defineProperty(window, '__qa', {
    configurable: true,
    get: () => installed,
    set: (api) => { installed = wrapApi(api); },
  });

  /* 状态补齐 tab / setState 等**非 goto** 路径也要真注入:qa-chrome 的 tab 按钮调内部
   * gotoState,不经 window.__qa.goto。把注入挂到每个 inject 型状态的 onEnter 上,
   * 于是任何进入该状态的路径(goto / tab 点击 / demo 内部 setState)都会推真组件,
   * 且只推一次(goto 分流不自己 inject)。 */
  for (const [id, driver] of Object.entries(DRIVERS)) {
    if (driver !== 'inject') continue;
    const st = cfg.states[id];
    if (!st || typeof st !== 'object') { cfg.states[id] = { driver, onEnter: () => cfg.inject(id) }; continue; }
    const orig = typeof st.onEnter === 'function' ? st.onEnter.bind(st) : null;
    st.onEnter = (ctx) => {
      cfg.inject(id);
      if (orig) orig(ctx);
    };
  }

  // ---------- 诊断面(verify / 测试用,不参与渲染) ----------
  window.__qaComponentAdapter = {
    version: ADAPTER_VERSION,
    drivers: () => ({ ...DRIVERS }),
    themeMode: () => appliedMode,
    themeTokenCount: (mode) => Object.keys(pickModeVars(mode ?? appliedMode) ?? {}).length,
    applyTheme,
    root: () => rootEl,
  };
})();
