/* qa-component-adapter.js — 【占位 stub】组件模式适配层。
 *
 * 组件模式(spec.component)下,demo 本体不是手写 HTML,而是 esbuild 打进
 * assets/component.bundle.js 的真实产品组件。本文件是「chrome 合约(window.__qaDemo)」
 * 与「组件驱动面(bundle 注入的 driver)」之间的适配层:
 *   - 向 bundle 暴露注入口   window.__qaDemo.inject(driver)
 *   - 向 chrome 提供 renderApp(ctx) / 状态语义(goto 直达 vs via 重放降级)
 *
 * ⚠ 本文件当前是 **占位 stub**(接口空壳 + TODO):真实实现由 comp-adapter 任务交付,
 *   合并时整文件替换。init.mjs 把它内联进 index.html 的 adapter 标记段(BEGIN/END 注释),
 *   升级方式与 chrome 一致:
 *   `node <skill>/scripts/init.mjs --dir <demo-dir> --update-adapter`
 *
 * driver 合约 v1(bundle 侧 bootstrap.tsx 构造,经 inject 交给本层):
 *   driver = {
 *     mount(frameEl, ctx)   首次挂载真实组件树(React root 等),只调一次
 *     update(ctx)           prefs / state 变化后同步到组件(重渲或 store 写入)
 *     goto(stateId)         → true 表示已注入到该状态;false 表示该状态只能经
 *                             真实交互(via 链路)到达(如组件局部 useState)
 *     applyTheme(mode)      light/dark 切换(truth.themeVars 驱动的主题桥)
 *     setLang(lang)         语言切换(产品 i18n 实例)
 *   }
 */
(() => {
  'use strict';
  const cfg = window.__qaDemo;
  if (!cfg) throw new Error('qa-component-adapter: 缺 window.__qaDemo 配置(必须在本脚本之前定义)');

  let driver = null;
  let mounted = false;

  /** bundle 侧 bootstrap 就绪后调用:driver 是组件的唯一驱动面。 */
  cfg.inject = (d) => {
    if (!d || typeof d.mount !== 'function') {
      throw new Error('qa-component-adapter: inject(driver) 需要至少实现 mount(frameEl, ctx)');
    }
    driver = d;
    // TODO(comp-adapter):driver 就绪后应触发一次重渲(chrome 已经渲过一轮 stub 空帧)。
  };

  /** chrome 每次 render 都会调;组件模式下不重建 DOM,只挂载一次 + update。 */
  cfg.renderApp = (ctx) => {
    if (!driver) {
      // stub 行为:bundle 未加载/未 inject 时给出可诊断的占位,不静默空白。
      ctx.frame.innerHTML = '';
      const el = document.createElement('div');
      el.style.padding = '24px';
      el.dataset.qaAdapterStub = '1';
      el.textContent = 'qa-component-adapter(stub):等待 assets/component.bundle.js 调用 __qaDemo.inject(driver)';
      ctx.frame.appendChild(el);
      return;
    }
    if (!mounted) {
      driver.mount(ctx.frame, ctx);
      mounted = true;
      return;
    }
    // TODO(comp-adapter):update 前后要处理 theme / lang / state 差异,并实现
    // goto 返回 false 时的 via 重放降级(不许静默停在旧状态)。
    driver.update?.(ctx);
  };

  window.__qaComponentAdapter = { version: 1, stub: true, driver: () => driver };
})();
