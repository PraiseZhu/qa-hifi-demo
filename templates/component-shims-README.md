# shims/ — 组件模式替身层

这里放**真实产品组件的依赖替身**。每个 shim 必须在 `spec.json` 的
`component.shims[]` 里声明 `{ spec, file, why }`——`why` 是给 reviewer 看的
「为什么这条依赖必须换掉」，写不出理由的 shim 就是保真度损失，应删掉改用真件。

## 三类合法 shim（按保真度从高到低）

| 类型 | 做法 | 例 |
|---|---|---|
| 窄出口 facade（**首选**） | 不写逻辑，只 re-export 产品真实叶子模块，绕开包根的重依赖 | `@cindy/auth-client` → `packages/auth-client/src/email` |
| 受控 store 替身 | 用产品自己的纯 reducer 做 transition，shim 只负责注入「main 侧本会发出的 action/state」 | `@/hooks/useLogin` |
| 稳态 / noop 替身 | 拖 IPC、原生能力或整棵 UI 依赖树，且 demo 面不验证它 | `@/hooks/useTheme`、窗口按钮 |

## 硬规

1. **状态机不许复刻**：transition 必须走产品自己的纯函数；shim 只做数据注入。
   自己写一套状态流转 = 把「复刻版 demo 的最大盲区」搬进了组件模式。
2. **noop 替身是保真度让步**：渲染 `null` / 返回稳态的 shim，必须记进 PR 说明的
   「保真度让步清单」（如窗口按钮缺席 → pixel 基准需要 mask）。
3. **服务端数据不是 truth**：只在服务端响应里存在的数据（providers、成员列表等）
   写进 `spec.component.fixtures[]` 如实声明，不许塞进 `truth.json` 冒充源码真值。
4. **能用真件就别写 shim**：先跑一遍 coupling 侦察（组件 render 期是否碰 IPC /
   网络 / 原生 API），只对真正碰边界的依赖立 shim。

## 模板

`_template.ts` 是空 shim 骨架，复制改名后用；它本身不被任何代码 import。
