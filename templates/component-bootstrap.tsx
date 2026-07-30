// bootstrap.tsx — {{NAME}} 组件模式装配入口(由 init.mjs 生成,作者按 TODO 填实)。
//
// 职责:import **真实产品组件**,把它装配成一个 driver 交给 adapter。
// 唯一对外接线点:`window.__qaDemo.inject(driver)`（adapter 在本 bundle 之前已定义好）。
//
// 硬规:
//   - 组件树里的界面数据只准来自产品源码 / truth,不许在这里手抄文案或色值;
//   - 需要替身的依赖一律走 shims/(并在 spec.component.shims 声明 why),
//     不许在本文件里就地 mock 组件内部逻辑;
//   - 服务端才有的数据(providers、memberships 之类)在 spec.component.fixtures 里
//     如实声明为 fixture——它没有源码 provenance,不许伪装成 truth 叶子。
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// TODO:import 真实产品组件(路径经 spec.component.rendererRoot / packageRoots 解析)
// import { LoginPage } from '@/components/login/LoginPage';

/** chrome 传进来的上下文(qa-chrome 的 ctx 子集)。 */
interface QaCtx {
  truth: Record<string, unknown>;
  prefs: { plat: string; region: string; os: string; mode: string; lang: string };
  state: string;
  frame: HTMLElement;
}

declare global {
  interface Window {
    __qaDemo: { inject(driver: unknown): void } & Record<string, unknown>;
  }
}

let root: Root | null = null;

/* ── 主题桥:truth.themeVars(extract.mjs 从产品 token 源提取)→ CSS 变量 ──
   语义复刻产品的 applyTheme:重写 <style id="theme-vars"> + 切 html.dark + colorScheme。
   色值不在这里写死,全部来自 truth。 */
function applyTheme(ctx: QaCtx, mode: string) {
  const vars = (ctx.truth as { themeVars?: Record<string, string> }).themeVars;
  if (!vars) return; // 该 demo 不涉主题桥
  let style = document.getElementById('theme-vars') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'theme-vars';
    document.head.appendChild(style);
  }
  style.textContent = `:root{${mode === 'dark' ? vars.dark : vars.light}}`;
  document.documentElement.classList.toggle('dark', mode === 'dark');
  document.documentElement.style.colorScheme = mode === 'dark' ? 'dark' : 'light';
}

function renderTree(ctx: QaCtx) {
  // TODO:按 ctx.state / ctx.prefs 把真实组件树渲进 root。
  // 状态注入走 shims 里的受控 store(setState/applyAction),transition 尽量走产品自己的
  // 纯 reducer——mock 只负责「注入 main 侧本会发出的 action/state」,不复刻状态机。
  root!.render(createElement('div', { 'data-qa-bootstrap-todo': '1' }, 'TODO: 渲染真实组件树'));
}

const driver = {
  mount(frameEl: HTMLElement, ctx: QaCtx) {
    frameEl.innerHTML = '';
    const host = document.createElement('div');
    host.id = 'component-root';
    frameEl.appendChild(host);
    root = createRoot(host);
    applyTheme(ctx, ctx.prefs.mode);
    renderTree(ctx);
  },
  update(ctx: QaCtx) {
    applyTheme(ctx, ctx.prefs.mode);
    renderTree(ctx);
  },
  /** 返回 false = 该状态只能经真实交互(via 链路)到达,adapter 会降级为重放。 */
  goto(_stateId: string): boolean {
    // TODO:能注入的状态在这里写 store 注入并 return true;组件局部 useState 的
    // 子视图(如弹窗、内嵌子步骤)必须 return false,不许假装注入成功。
    return false;
  },
  setLang(_lang: string) {
    // TODO:调产品 i18n 实例(i18n.changeLanguage),不要自建文案表。
  },
};

window.__qaDemo.inject(driver);
