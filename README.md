# qa-hifi-demo

高保真可交互 QA demo 工作流（Claude Code skill）——从产品源码机械提取带 provenance 的真值、
生成可交互 HTML demo、七道门自动验收、部署后产出防伪的 PR 附贴块，让 reviewer 不启动沙盒
就能完整走一遍功能。

> A Claude Code skill that builds high-fidelity interactive QA demos with
> machine-verified truth extraction (provenance-tracked), a 7-gate acceptance
> pipeline, and tamper-proof PR evidence blocks — plus a self-evolution ledger.

## 它解决什么问题

UI 功能 PR 的验证有两个老大难：

1. **demo 造假/漂移**：手抄文案与常量、demo 与产品代码各改各的、验收报告手写 `ok:true`;
2. **reviewer 成本**：想确认交互对不对就得起沙盒。

本 skill 的答案是「机械证明,不是声明」：

- **真值层（门 A）**：demo 里的每个文案/几何/色值必须由 `extract.mjs` 从产品源码提取，
  带 `source + hash + locator` provenance；验收时现跑提取器比对，手抄/漂移直接红。
- **状态层（门 B）**：spec 声明的每个界面状态都被 Playwright 沿真实交互链路重放到达。
- **交互层（门 C）**：文案零截断、输入框跨 tick 稳定、偏好持久化 reload 恢复。
- **渲染层（门 D）**：`getComputedStyle` 逐条核对 CSS ≡ truth（拒上下文相关单位防假绿）。
- **像素层（门 E）**：与真沙盒截图逐像素比对（mask 面积受限,WARN 必须人工裁决）。
- **适配层（门 F）**：窗口拉伸行为与产品布局公式逐采样点比对（oracle 是产品公式本身）。
- **自定义门（门 X）**：demo 专属检查脚本注册进 spec，hash 计入防伪链。
- **PR 附贴块**：`pr-block.mjs` 重算全部输入 hash、校验报告完整性、比对线上部署字节——
  输入漂移、增量报告冒充全量、脚本被篡改、部署旧版,全部拒绝出块。

## 快速开始

```bash
# 1. 脚手架(生成 spec/extract/index 四件套骨架,内联标准 chrome 运行时)
node scripts/init.mjs --dir <demo-dir> --name my-feature --pr 123

# 2. 写 extract.mjs 提取真值(用 demo 内 extract-helpers.mjs,repoRoot 走 git)
node scripts/truth.mjs --demo <demo-dir> --embed

# 3. 验收(全量;调试时可 --gate A,D / --case <id> 增量,增量报告不可用于定稿)
node scripts/states.mjs --demo <demo-dir>
node scripts/verify.mjs --demo <demo-dir>
node scripts/pixel-compare.mjs --demo <demo-dir>

# 4. 生成 PR 附贴块(定稿模式:必须已 commit + 已部署最新版)
node scripts/pr-block.mjs --demo <demo-dir> --require-committed --require-deployed --url <部署地址>

# 漂移守护:产品常量一改,所有 demo 的过期状态一条命令看完
node scripts/truth.mjs --check --all <previews-root>
```

完整流程（P0 脚手架 → P7 自进化）见 [SKILL.md](SKILL.md)。

依赖：Node ≥ 20；门 B-F 需要宿主项目可解析的 `playwright`（或 `playwright-core` + 本机 Chrome）；
门 E 需要 `pixelmatch` + `pngjs`。

## 自进化台账（self-evolution ledger)

每轮 demo 会话收尾时,agent 对「靠人肉发现的问题」做根因复盘,经
`scripts/evolution-note.mjs` 写入 [`evolution/ledger.json`](evolution/ledger.json)
（人类可读视图 [EVOLUTION.md](EVOLUTION.md) 由脚本再生成）。三档纪律：

- **auto**：不放宽验收口径的工具/文档缺口——可当轮落地,带 commit 记 landed;
- **proposal**：**任何放宽验收口径的改动**（容差/阈值/白名单/跳门）——永不自动落地,等维护者拍板;
- **by-design**：本来就该人来的(人工裁决/产品拍板)——只计数观察。

条目按根因 fingerprint 去重,同一坑第二次出现只自增计数。**欢迎外部使用者把自己的台账
条目以 PR 回流**（只动 `evolution/ledger.json`,经脚本 add 生成,不改判定脚本）——
这正是这个仓库公开的目的：让每个使用者踩过的坑变成所有人的护栏。

## 目录结构

```
SKILL.md                  # Claude Code skill 正文(P0-P7 全流程)
EVOLUTION.md              # 自进化台账(脚本再生成,勿手改)
evolution/ledger.json     # 台账事实源(只经 evolution-note.mjs 读写)
scripts/
├─ init.mjs               # P0 脚手架
├─ truth.mjs              # P1 真值生成 / --check 漂移检查 / --check --all 批量
├─ states.mjs             # P3 静态:状态声明完备性
├─ verify.mjs             # P3 动态:门 A/B/C/D/F/X(支持 --gate/--case/--state 增量)
├─ pixel-compare.mjs      # P3 动态:门 E 像素基准
├─ capture-baseline.mjs   # 门 E 基准图采集(真沙盒 --url / 导入 --from-png)
├─ writeback.mjs          # P2.5 参数级改动机械写回产品源码(round-trip 验证)
├─ pr-block.mjs           # P4/P6 PR 附贴块(防伪校验全家桶)
├─ evolution-note.mjs     # P7 自进化台账唯一读写通道
└─ lib/                   # schema/replay/防伪 hash/playwright 解析/extract-helpers
templates/
├─ qa-chrome.js           # demo 合约标准运行时(__qa API/切换器/状态补齐 tab/拉伸手柄)
├─ demo-shell.html        # index.html 模板
├─ demo-chrome.md         # chrome 工具区规范
└─ spec.schema.md         # spec.json 字段规范
```

## 测试

```bash
node --test 'scripts/__tests__/*.test.mjs'   # 或裸 npm test
```

测试是对抗式的：大量 fixture 专门构造「旧实现会假绿」的场景（合成 click 自证、mask 隐藏
差异、伪 tick、NaN scale、partial 报告冒充全量、篡改自定义门脚本……），锁死防伪语义。

## License

MIT

## 环境坑备忘

- **typescript 必须 5.x**：keyPath 写回（writeback AST 定位）依赖 TS Compiler API；TS7 起默认包（原生版）移除了该 API，裸 `npm i typescript` 会拉到 TS7 导致 keyPath 相关测试红。安装用 `npm i --no-save typescript@^5`，或让 writeback 从产品仓 node_modules 解析（推荐，零依赖）。
- **`node --test scripts/__tests__/`（目录形式）在 Node 24 不可用**——用 `node --test 'scripts/__tests__/*.test.mjs'` 或裸 `npm test`。
- worktree/异地跑测试需 `QA_HIFI_MODULE_ROOT=<装了 playwright 的项目>`。
