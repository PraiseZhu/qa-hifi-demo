# qa-hifi-demo 自进化台账

自动生成:由 `scripts/evolution-note.mjs` 从 `evolution/ledger.json` 再生成,**手改本文件会被覆盖**。
条目按根因 fingerprint 去重;分类与落地规则见 SKILL.md「P7 自进化复盘」。
外部使用者欢迎把自己的台账条目以 PR 形式回流(只动 `evolution/ledger.json`,经脚本 add 生成)。

## 已自动落地(工具/文档缺口修复,不放宽口径)

- `drift-check-per-demo-manual` **漂移检查只能逐 demo 手跑,demo 一多必然漏检** — 出现 1 次,首见 2026-07-30,最近 2026-07-30,status: landed,commit `b173ced`
  - 现象:10 个 demo 要手跑 10 次 --check;预检未挂,产品常量一改全部静默过期
  - 提案:truth.mjs --check --all <root> 批量 + 挂进 cindy-pr-preflight
- `verify-failure-no-artifact` **验收失败只有 300 字文字,复现现场要人肉开 --headed** — 出现 1 次,首见 2026-07-30,最近 2026-07-30,status: landed,commit `b173ced`
  - 提案:失败自动截图 verify-artifacts/,failure 条目带 screenshot
- `baseline-capture-manual-toil` **门 E 基准图采集全手工,导致门 E 长期零使用** — 出现 1 次,首见 2026-07-30,最近 2026-07-30,status: landed,commit `b173ced`
  - 提案:capture-baseline.mjs:--url 真沙盒直采 / --from-png 导入(尺寸×DPR 校验)
- `mobile-case-desktop-viewport` **移动端 case 在 1440×960 桌面视口下验收,截断/适配结论不成立** — 出现 1 次,首见 2026-07-30,最近 2026-07-30,status: landed,commit `b173ced`
  - 提案:verify.cases[].viewport{w,h,dpr},verify 为该 case 换页
- `demo-contract-reimplemented` **__qa 合约与 chrome 工具区每个 demo 重新实现,写法漂移** — 出现 1 次,首见 2026-07-30,最近 2026-07-30,status: landed,commit `b173ced`
  - 现象:10 个 demo 写出 10 种偏好切换器,replay.clickPref 被迫猜 7 种 selector
  - 提案:templates/qa-chrome.js 标准运行时 + init.mjs 脚手架内联
- `unregistered-out-of-band-gates` **demo 自建体外 gate 脚本游离防伪链,跑没跑 pr-block 不知道** — 出现 1 次,首见 2026-07-30,最近 2026-07-30,status: landed,commit `b173ced`
  - 现象:3 个真实 demo 自建 overlap-gate/interaction-gate/render 脚本,不进 report 与 hash 链
  - 提案:spec.customGates 注册 → verify 门 X 统一执行,脚本 hash 计入 inputHashes
- `verify-no-incremental-mode` **verify 只能全量重跑,大矩阵下修一处也要等全套,曾直接超时** — 出现 1 次,首见 2026-07-30,最近 2026-07-30,status: landed,commit `b173ced`
  - 现象:2026-07-29 门 A-F 全量运行超时阻塞整轮验收(obs 16320)
  - 提案:--gate/--case/--state 增量过滤;partial 报告标记并被 pr-block 拒收
- `repo-root-depth-assumption` **extract.mjs 用目录深度推 repoRoot,demo 搬家即断** — 出现 1 次,首见 2026-07-30,最近 2026-07-30,status: landed,commit `b173ced`
  - 现象:2026-07-29 login-all-hifi:demo 从 _tmp/ 迁 docs/design-previews/ 后 repoRoot/provenance 前缀全断,一天连修 3 个 bug
  - 提案:extract-helpers.findRepoRoot() 走 git rev-parse;init 把 helpers 拷进 demo 自包含

## 无法自动化(by-design,只计数观察)

- `html-to-native-no-mechanical-path` **结构级 HTML→四端机械转换原理性不存在,agent 双改即业界最优** — 出现 1 次,首见 2026-07-30,最近 2026-07-30,status: tracked
  - 现象:2026-07-30 GitHub 全量调研确认:Mitosis 只有 JSX 子集正向编译器且无 HTML parser(RN sanitizer 策略=丢弃+警告);html-to-react-native 生态位仅 0-6 star 玩具;跨框架 patch 生成无任何开源项目。CSS/RN 样式语义鸿沟(级联/继承/grid vs flex-only)与结构语义鸿沟(div→View/Pressable 是意图判断)决定无损映射不可能
