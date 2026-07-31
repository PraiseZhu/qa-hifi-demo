// bootstrap.tsx — {{NAME}} 组件模式装配入口(由 init.mjs 生成,作者按 TODO 填实)。
//
// 职责:import **真实产品组件**,把它装配成 adapter 认的 __qaDemo 形状。
// 唯一对外接线点:`Object.assign(window.__qaDemo, { states, mount, inject, onPrefs })`
// ——index.html 的基础配置段已建好 window.__qaDemo(mode/matrix/defaultPrefs/…),
// 本文件只补「需要 import 真组件才能写」的四项;adapter 在本 bundle 之后执行,
// 读到的是补齐后的完整合约(缺 mount / states 会当场抛错,不会静默空白页)。
//
// 硬规:
//   - 界面渲染只调 mount(ctx) 一次:真组件自己持有 React 树,重复 unmount/mount
//     会丢局部 useState(弹窗、子视图);偏好变化走 onPrefs,不要重挂;
//   - 主题**不在这里做**:adapter 用 truth.themeVars 复刻产品 applyTheme
//     (重写 style#theme-vars + 切 html.dark),bootstrap 碰主题就是两份实现;
//   - 组件树里的界面数据只准来自产品源码 / truth,不许在这里手抄文案或色值;
//   - 需要替身的依赖一律走 shims/(并在 spec.component.shims 声明 why),
//     不许在本文件里就地 mock 组件内部逻辑;
//   - 服务端才有的数据(providers、memberships 之类)在 spec.component.fixtures 里
//     如实声明为 fixture——它没有源码 provenance,不许伪装成 truth 叶子。
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// TODO:import 真实产品组件(路径经 spec.component.rendererRoot / packageRoots 解析)
// import { LoginPage } from '@/components/login/LoginPage';

/** adapter 合成的 ctx(qa-chrome ctx + root)。 */
interface QaCtx {
  truth: Record<string, unknown>;
  rawTruth: Record<string, unknown>;
  prefs: { plat: string; region: string; os: string; mode: string; lang: string };
  state: string;
  frame: HTMLElement;
  /** adapter 在 .frame 内创建的组件根(.qa-component-root),挂树就挂这里。 */
  root: HTMLElement;
}

declare global {
  interface Window {
    __qaDemo: Record<string, unknown>;
  }
}

let root: Root | null = null;

Object.assign(window.__qaDemo, {
  /* 状态表:键 ≡ spec.states[].id,driver 与 spec.states[].driver 必须一致。
     'inject' = 可由 inject(id) 直达(推 reducer / 受控 store);
     'via'    = 组件局部 useState 的子视图,外部注入不到,只能真实交互到达
                (adapter 对它的 goto 显式 throw,门 B 走 via 重放取证)。 */
  states: {
    entry: { driver: 'inject' },
    // TODO:补齐 spec.states 声明的所有状态(键集必须一致,门 B 会验)。
  },

  /** 只调用一次:把真组件挂到 ctx.root。 */
  mount(ctx: QaCtx) {
    root = createRoot(ctx.root);
    // TODO:渲染真实组件树(结构对齐产品真实挂载层级)。
    root.render(createElement('div', { 'data-qa-bootstrap-todo': '1' }, 'TODO: 渲染真实组件树'));
  },

  /** driver:'inject' 状态的注入:把受控 store 推到该状态。 */
  inject(id: string) {
    // TODO:走 shims 里的受控 store 注入(transition 尽量用产品自己的纯 reducer,
    // mock 只负责注入 main 侧本会发出的 action/state,不复刻状态机)。
    // 未实现的 id 直接抛错,别静默忽略——静默 = 门 B 假绿。
    throw new Error(`bootstrap.inject: 未实现的状态 "${id}"`);
  },

  /** 可选:非主题偏好(lang/region/os/plat)变化;主题由 adapter 接管。 */
  onPrefs(prefs: QaCtx['prefs']) {
    // TODO:调产品 i18n 实例(i18n.changeLanguage(prefs.lang)),不要自建文案表。
    void prefs;
  },
});
