// _template.ts — 空 shim 骨架(复制改名后用;本文件不被任何代码 import)。
//
// 头注释是交付物的一部分,必须写清三件事:
//   1. 替身对象:替的是哪个 import specifier;
//   2. 为什么必须替(render 期碰 IPC / 网络 / 原生能力 / 拖整棵 UI 依赖树);
//   3. 与真实实现的差异清单(诚实列全,这份清单会进 PR 的保真度让步说明)。
//
// 优先做窄出口 facade:能 re-export 产品真实叶子模块就不要自己写逻辑。
// export { someHelper } from '../../../packages/x/src/helper';

/** TODO:替身实现。状态类替身请用产品自己的 reducer 做 transition,只注入 state/action。 */
export {};
