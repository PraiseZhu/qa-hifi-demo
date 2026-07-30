---
name: qa-hifi-demo
description: 高保真可交互 QA demo 工作流——从产品源码提取带 provenance 的真值、生成可交互 HTML demo、A-F 六道门自动验收、部署并产出 PR 附贴块。用于代替沙盒测试的快速 QA 与 PR 验证环节。触发词只有一个：「qa 测试」（裸 "qa"/"测试"/"test" 均不触发，避免与 web-qa 类 skill 冲突）。
---

# qa-hifi-demo — 高保真可交互 QA demo

> **目标**：为一个功能 PR 产出一个高保真单文件可交互 HTML demo，并用机械化报告说明：
> 数据层 truth 来自产品源码且带 provenance，渲染层由 computed-style 绑定验证，像素层由真沙盒截图抽查。
> 部署到内网后贴进 PR，让 reviewer 不启动沙盒就能完整走一遍功能。
>
> **设计原则（四要素）**：结构化数据（spec.json + truth.json）、运行脚本（scripts/）、
> 工具链（Playwright + xd-pages）、验证机制（A-F 六道门；阻断门全过才允许部署/贴 PR）。
>
> **诞生背景**：2026-07-24 cindy 登录协议 demo 6 轮返工的教训固化——文案手抄漂移、
> 产品常量变更 demo 滞后、返回按钮/输入框交互 bug 靠人撞、状态覆盖靠人脑记。

## 目录约定

每个 demo 一个目录（宿主项目内 `_tmp/<name>-hifi/` 起步；随 PR 入库时移到 `docs/design-previews/<feature>/`）：

```
<demo-dir>/
├─ spec.json            # 宪法:matrix / states / verify 配置 / meta(PR 号+三段说明)
├─ extract.mjs          # 真值提取器(按 demo 定制,读产品源码,stdout 输出 truth JSON)
├─ extract-helpers.mjs  # init.mjs 从 skill lib 拷贝(findRepoRoot/makeLeaf 等,demo 自包含)
├─ truth.json           # extract.mjs 的规范化输出(脚本生成,禁止手改)
├─ index.html           # 单文件 demo(内嵌 truth + 标准 qa-chrome 运行时,见「demo 合约」)
├─ report.json          # verify.mjs 输出的 A/B/C/D/F/X 报告(部署前必须存在且阻断门 PASS)
├─ report-pixel.json    # pixel-compare.mjs 输出的门 E 报告(有基准时必须无未裁决 WARN/ERROR/MISSING)
└─ verify-artifacts/    # verify 失败现场截图(生成产物,不入库)
```

## 执行流（P0→P7，顺序硬性）

### P0 起步脚手架（新 demo 一律走这里）

```bash
node scripts/init.mjs --dir <demo-dir> --name <slug> [--pr <n>]
```

生成四件套骨架：spec.json 最小合法结构、extract.mjs 样板（已 import helpers）、
`extract-helpers.mjs`（从 skill lib 拷贝进 demo，**demo 自包含**，随 PR 入产品仓后不依赖
skill 安装位置）、index.html（demo-shell + 内联标准 qa-chrome 运行时）。已存在的文件拒绝覆盖。
chrome 运行时升级：`node scripts/init.mjs --dir <demo-dir> --update-chrome`（只换标记段）。

### P1 真值提取（杜绝手抄）

1. 和用户确认 demo 覆盖范围：哪个功能、哪些端/区域/语言/主题（写进 `spec.json` 的 `matrix`）。
2. **编写 `extract.mjs`**：从产品源码读取 demo 需要的一切事实——布局常量（如 `loginSkinLayout.ts`）、
   i18n 文案（如 4×`common.json` + `loginMessages.ts`）、颜色 token、外部 URL。
   提取器是**代码**（import/JSON.parse/正则均可），不是 LLM 复述；每个值必须能溯源到产品文件路径。
   **必须用 demo 内的 `extract-helpers.mjs`**：仓库根用 `findRepoRoot()`（git 定位），叶子用
   `makeLeaf()` / `extractByPattern()` 构造，TS 布局公式用 `importTsModule()` 加载。
   **「预期会被用户调的参数」带上写回定位锚**（P2.5 机械写回的前提）：正则抓取的值用
   `extractByPattern()`（自动记 `locatorPattern`）；从模块 import 的常量（token/布局对象里的
   字面量）用 `makeLeaf(value, file, { keyPath: 'tokens.hero.size' })` 记 `locatorKeyPath`——
   keyPath 从顶层变量名（或 export default / JSON 根）起逐段写全。公式派生值（如 loginScale
   现算的几何）在源码无字面值，**不可机械写回**，不要硬标锚。
   **禁止 `../../..` 数目录层级推仓库根**——2026-07-29 login-all-hifi 因此一天连修 3 个 bug
   （demo 从 `_tmp/` 迁 `docs/design-previews/` 后 repoRoot/provenance 前缀全断）。
3. 跑 `node scripts/truth.mjs --demo <dir>` 生成规范化 `truth.json`。
   **禁止**：demo 里出现任何不在 truth.json 里的界面文案/几何/颜色值。

### P2 生成 demo（LLM 自由区，但守合约）

按「demo 合约」（见下节）编写/更新 `index.html`。界面渲染数据**只准**取自内嵌 truth；
交互链路、状态机、工具区按 `templates/demo-chrome.md` 的规范实现。
状态归属先在 `spec.json.states` 里声明好，再写实现——**声明是数据，实现跟着声明走**。

**内嵌真值块别手抄**：`index.html` 里放一个空的 `<script id="qa-truth" type="application/json"></script>`
占位，然后 `node scripts/truth.mjs --demo <dir> --embed` 一步把 truth.json 写回该块（`</script>` 已转义
防注入）。手抄内嵌块极易与 truth.json 漂移、撞门 A——一律用 `--embed`。只想拿转义 JSON 不改盘用 `--script-json`。

### P3 验收（A-F+X 七道门，阻断门全过才继续）

```bash
node scripts/states.mjs --demo <dir>          # 静态:状态声明完备性(每个状态 via 或 tab 二选一)
node scripts/verify.mjs --demo <dir>          # 动态:门A/B/C/D/F/X
node scripts/pixel-compare.mjs --demo <dir>   # 动态:门E 像素基准(有 baselines 时)
```

**增量模式（修复循环内的调试工具）**：`verify.mjs` 支持
`--gate A,D` / `--case <id,...>` / `--state <id,...>`——改一条 binding 不必全量重跑
（历史事故:全量 verify 超时把整轮验收堵死,obs 16320）。任一过滤参数出现 →
`report.partial=true`，**pr-block 一律拒收 partial 报告**——增量只用于调试，定稿必须全量重跑。

**失败取证**：任一动态门失败自动截图到 `verify-artifacts/`，failure 条目带 `screenshot`
字段——不用再开 `--headed` 人肉复现失败现场。`verify-artifacts/` 是生成产物，不入库。

> **playwright 依赖解析**:verify/pixel 需要 playwright。脚本按 `cwd` → `INIT_CWD` → skill 目录向上 →
> 宿主 `projects/*` package root 依次解析宿主 `node_modules`(playwright 或 playwright-core),
> Chromium 用本机缓存/系统 Chrome。宿主仓没装时打印一串 attempts + 安装提示;可用
> `QA_HIFI_MODULE_ROOT=<装了 playwright 的目录>` 显式指定。无 playwright 时门 B/C/D/F 跑不了,门 A 仍可跑。
>
> **大矩阵必须配 `verify.cases` 收敛**:门 B/C 对每个 `case × state` 都 freshLoad(两次页面加载),
> 全 matrix 笛卡尔积(如 3×2×2×4=48 组 × N 状态)会慢到不可用。真实 demo 用 `spec.verify.cases`
> 声明一组有代表性组合(pairwise / 关键端×暗色×长文案),不要默认全展开。

- **门 A 真值一致 + extractor drift**：① index.html 内嵌 `<script id="qa-truth">` ≡ truth.json；
  ② 现跑 `extract.mjs` 的输出 ≡ truth.json（证明 value 真由源码提取，不是手抄 value+CSS 蒙混）；
  ③ 每个 truth 叶子带 provenance（源文件 + hash，`adaptive.samples` 计算几何除外，由 ② 覆盖）。
  **缺 extract.mjs 或漂移 = 门 A FAIL**——「truth 提取自源码」是机械证明，不是声明。
- **门 B 状态覆盖 100%**：verify 按 `verify.cases`（没有则按 matrix 全组合）实际切换偏好并断言
  `__qa.prefs()`；spec 声明的每个状态，`via` 链路重放后必须无条件断言 `current()===id`。
  `via:null` 的 tab-only 状态只能通过真实「状态补齐」tab DOM 入口点击到达；`__qa.goto()` 只是实现细节，不作为门 B 取证。
- **门 C 交互鲁棒**（固化历史踩坑）：文案零截断/零溢出（no-clip 选择器扫描）、输入框跨定时 tick
  节点不变焦点不丢、偏好持久化 reload 恢复、（返回按钮由 via 链路中的 back 步骤覆盖）。
- **门 D 渲染绑定**（`spec.bindings`）：`getComputedStyle` 逐条核对「元素 × CSS 属性 ≡ truth 值」——
  色值（浏览器解析器双侧归一化，拒 `inherit/currentColor/var()` 等上下文相关值）、圆角/描边/字号等
  长度（×`__qa.scale()` 换算，容差 0.75px）。**length truth 只允许绝对单位**（px/pt/pc/cm/mm/in/Q 或
  无单位数）——`%`/`em`/`vw`/`calc()` 等上下文相关单位会在临时元素上下文解析出错误 px、把错样式判等，一律拒绝。
  ——保证**渲染层**：堵「嵌了真值但 CSS 手写漂移」（门 A 抓不到的形态）。未配 bindings 不阻断，
  但报告降级声明「还原承诺仅到数据层」；配了就必须全过。
- **门 E 像素基准**（`scripts/pixel-compare.mjs`）：`baselines/<key>.png` = 真沙盒截图
  （桌面 dev 实例 / 手机模拟器采集），在 Node 可信侧解 PNG、比较 RGBA 并输出 baseline/demo/diff 三图。
  mask 只可跳过小面积动态区，超面积、缺图、尺寸错、ERROR/MISSING 都阻断；WARN 必须有人工裁决 artifact 才允许 PR 附贴。
  无基准时如实标注「像素级未比对」。
  **采集用 `scripts/capture-baseline.mjs`**：`--url <dev实例>` 直接截真沙盒帧元素（DPR 与
  pixel-compare 同口径），或 `--from-png <截图>` 导入真机截图（先渲染 demo 量帧尺寸，
  尺寸不符拒收，防「随手一张图」冒充基准）。key 必须先在 spec.baselines 声明。
  **来源要如实**：指 demo 自己的地址采基准 = 自证，门 E 失去意义。
- **门 X 自定义门**（`spec.customGates`）：demo 专属的体外验收脚本（元素重叠检测、特殊交互断言等
  六门覆盖不了的检查）**必须注册进 `spec.customGates`**，由 verify 统一执行（exit 0 = PASS）、
  结果计入 report、**脚本 hash 计入 inputHashes 防伪链**（verify 后改脚本 = report 失效,
  pr-block 拒绝出块）。禁止游离的体外 gate 脚本——不注册等于没跑。
- **门 F 适配还原**（`spec.adaptive`）：验证**拉伸行为**与沙盒一致——帧在每个采样尺寸
  `__qa.resize(w,h)` 后，**verifier 侧直接量 DOM**（`boundingBox`，不信 `__qa.metrics` 自报）得到探针
  实际几何 ≡ `truth.adaptive.samples` 期望表（容差默认 1px），外加最小宽高钳制断言 + sampleSizes↔samples
  一一覆盖检查（声明了采样点却没预计算 = FAIL）。
  **oracle 是产品源码的布局公式本身**：extract.mjs 用产品公式（esbuild 临时编译 TS 后 import
  纯函数，或等价方式）对 `spec.adaptive.sampleSizes` 预计算期望几何存进 truth——验收侧不重写
  公式，杜绝「demo 与验收抄同一个错公式」的假绿。采样点必须含：min 尺寸、各断点锚点尺寸、
  断点两侧 ±1（抓档位边界跳变）、若干中间插值点。未配 adaptive 不阻断，但报告降级声明
  「不含窗口拉伸行为」；配了必须全过。

门 A/B/C/D/F/X FAIL → 修 demo（或修 spec 声明），重跑，绿灯前不许部署。
门 E 有基准时 ERROR/MISSING/未裁决 WARN 也阻断；无基准时只降级承诺并如实进 PR 附贴块。
PR 文案只允许承诺「数据层 truth 提取自源码（带 provenance）；渲染层由门 D 保证；像素层按门 E 结果说明」。

### P4 部署 + PR 附贴

1. `ghost_call(ghost_id='xd-pages', tool='pages_deploy', args={name:'<name>', preset:'static'}, dir=<demo-dir 绝对路径>)`。
2. `node scripts/pr-block.mjs --demo <dir> --preview <仓内.html链接> --url <workers.xd.team地址>` 生成 PR 附贴块。
   pr-block 会重算 spec/truth/index/baselines hash，逐门检查统计一致性；任何输入漂移、手写 `ok:true`、缺门都会拒绝输出。
3. 贴进 PR description/评论**前必须经用户确认**（对外写操作）。

**部署渠道硬规**：demo 一律用 Cindy 自带的 **xd-pages** 部署(`workers.xd.team`,仅公司内网可见)。
**禁止**把 demo 放任何公网预览服务(htmlpreview.github.io / raw.githack / CodePen / JSFiddle /
CodeSandbox / StackBlitz)——那会把未发布的产品界面暴露到公网,且私有仓 raw 这些服务也拿不到。

**上游 review-pr 证据格式对齐（cindy 仓,2026-07-24 Lizi efb0a75 起）**：上游格式门把 HTML 界面
当作有效 UI 证据,硬判认三种形态——```` ```html ````代码块、完整 HTML 文档、`.html` 附件/预览链接。
内网部署域名 workers.xd.team 若尚未进识别列表,证据这样给:demo 随 PR 入库到
`docs/design-previews/<feature>/index.html`,PR 里贴该文件的 **GitHub 仓内链接**(以 `.html` 结尾,
命中「.html 附件链接」判定,且私有仓权限天然受控),xd-pages 内网地址作为体验入口一并贴;
同时建议向 Lizi 提一句把 `workers.xd.team` 加进 review-pr 的预览域名识别列表,加了以后内网地址自身即证据。
上游阶段二还会**核对 HTML 与 diff 实现的一致性**(「HTML 很漂亮但代码不是这么写的」= P1)——
本 skill 的门 A(真值提取自产品源码)正是一致性的机械证明,pr-block 里带上验收报告即为自证。

### P5 漂移守护

- 产品常量/文案变更后（或 cindy 预检时）跑 `node scripts/truth.mjs --demo <dir> --check`：
  重新提取与现有 truth.json diff，漂移 → exit 2 + **叶子级差异路径清单**（`driftedPaths`,
  精确到 `colors.light.panelBg` 这一级,不用人肉 diff）→ 回 P1 重新走。
- **批量检查**：`node scripts/truth.mjs --check --all <previews-root>` 扫描目录下所有 demo
  逐个 --check，任一漂移 exit 2——产品常量一改，全部 demo 的过期状态一条命令看完。
- demo 随 PR 入库后，把 `--check --all docs/design-previews` 挂进项目预检流程
  （cindy 仓 = cindy-pr-preflight），让所有 demo 永不默默过期。

### P2.5 双向同步（demo 改动 → 产品代码，两档口径）

demo 是产品代码的**镜像视图**，改动的 source of truth 永远是产品代码。**禁止单边改 demo**
（改了 demo 不落产品代码 = 制造漂移，门 A 下一轮就会红）。用户在 demo 上提出的每处改动按两档同步：

- **参数级改动**（色值/几何/字号/间距/文案——改「值」不改「结构」）→ **机械写回**：
  ```bash
  node scripts/writeback.mjs --demo <dir> --repo <产品仓根> \
    --set colors.light.panelBg=#FAFAFA --set geometry.loginY=933 [--dry-run]
  ```
  前提：该 truth 叶子的 provenance 带**定位锚**，两种通道（同时有时优先 regex）：
  ① `locatorPattern`——恰含一个捕获组的正则（`extractByPattern()` 自动带上）；
  ② `locatorKeyPath`——源文件中该值的完整对象路径（`makeLeaf({ keyPath })` 记上），
  writeback 用**产品仓的 typescript** 在 AST 上定位字面量（支持 ts/tsx/js/json；
  `as const`/`satisfies` 自动解包；多处定义、条件赋值、shorthand、spread、非字面量初始化
  一律拒转走 agent——宁可拒转不写错位置）。脚本保证：唯一定位 + 源码当前值≡truth 旧值
  （防盲写）→ 写回 → **重跑 extract round-trip 证明写回生效** → truth.json + qa-truth
  内嵌块同步更新 → 失败整体回滚。写完重跑 verify，门 A-F 绿 = 双边一致有机械证明。
- **跨端样式换算**（一次「改值」涉双端语法差异：web `padding:8px 16px` ↔ RN
  `paddingVertical/Horizontal`；px→数字；transform 数组化；font/textShadow/border shorthand）→
  **style-sync.mjs 白名单换算**：
  ```bash
  node scripts/style-sync.mjs --decl "padding: 8px 16px" [--css-file <path>]
  ```
  输出 `{ mechanical: {RN 属性对象}, rejected: [{prop, value, reason}] }`——属性 ∈ RN 合法
  样式集 ∧ 值可静态保证 RN 侧生效才进 mechanical；`1rem`/`calc()`/`var()`/grid/float 等
  passthrough 陷阱与无对应语义项**必须**进 rejected。mechanical 属性再由 writeback 逐属性
  写回；rejected 条目连同原因交 agent 双改。换算不写产品代码，shorthand 原子（任一片段
  不过校验整条 rejected），防「半边机械写回、半边漂移」。
- **结构级改动**（新增元素/布局重构/新交互/新状态）→ **agent 双改**：同一轮里既改产品代码
  又改 demo（HTML 与 React/RN 无同构映射，机械直译不存在，诚实走人智），然后 `truth.mjs --embed`
  + `verify.mjs` 闭环——门 A（extractor drift）+ 门 D（渲染绑定）+ 门 F（适配采样）就是
  「两边真的一致」的验收器。无定位锚的叶子 writeback 会明确拒绝并提示走本档。
  **双改的结构化输入**：界面关键元素按约定带 `data-node-id`（稳定、语义化、不复用，见
  templates/demo-shell.html 头注释）时，改动前后两份 index.html 可过
  `node scripts/dom-ops.mjs --old <旧> --new <新>` 产出结构化操作清单
  （added/removed/moved/attrChanged/textChanged/styleChanged，含锚点坐标与前置状态；
  无锚点节点归入 unanchored 段如实列出、须人工核对）。清单是 agent 双改的输入，
  **不自动应用**——它替代「两份全文自由读」，不替代「映射到产品组件树」的人智判断。

### P6 定稿 = PR ready（用户确认最终 HTML 后的收口）

用户对 demo 说「确认/定稿」即触发，全过才算 PR ready：

1. `truth.mjs --check` 零漂移（demo 与产品代码同步的最终证明）；
2. `verify.mjs` 门 A-F 全绿 + （有基准时）`pixel-compare` 无未裁决 WARN；
3. **产品仓自己的门禁**：受影响包 typecheck + 定向测试 + 仓库要求的全量门禁
   （cindy 仓 = 根目录 `pnpm test:unit`，见其 AGENTS.md）；
4. demo 入库（`docs/design-previews/<feature>/`）并 commit + **xd-pages 已部署最新版**，然后
   `node scripts/pr-block.mjs --demo <dir> --require-committed --require-deployed --url <部署地址> [--preview ...]`
   产出附贴块——`--require-deployed` 会拉取部署地址逐字节比对本地 index.html（带 cache-bust），
   没部署 / 部署的是旧版 / 地址不可达都 exit 2。**部署不是可选步骤，是定稿门的一部分。**

四步全绿 → commit 已就绪，PR 提交只差用户一句授权（push/提 PR 仍按仓库规矩经用户确认）。

**「demo 每次都被带进 PR」的三层保证**：
- **带入**：demo 是分支上的入库文件，git 自动把它带进 PR diff——入库即带入，零机制成本；
- **本地硬门**：第 4 步必须用 `--require-committed`——它校验 spec/extract/truth/index 四件套
  已被 git 跟踪 + demo 目录无未提交改动（防「忘了入库」与「入库了但 PR 带旧版」）+ 报告 hash
  与当前文件一致（防旧验收报告冒充），任一不满足 exit 2、附贴块生成不出来；
- **远端兜底**：上游 review-pr 格式门把 UI 证据（HTML/截图）列为硬要求，PR 里没带直接被打回——
  即使本地两层都被绕过，上游也合不进去。

### P7 自进化复盘（self-evolution，每轮 demo 会话收尾时执行）

设计对齐 review-pr skill 的同名机制。目标：**同一类工具缺口或流程坑不第二次靠人发现**。
每轮 demo 工作（定稿、或一次返工循环结束）后，对本轮「靠人肉发现的问题」做根因复盘，
写入 Skill 自己的进化台账。复盘只影响未来轮次，不回头改本轮已出的验收结论。

**根因三分类（tier）**：

- **by-design（本来就该人来）**：像素 WARN 人工裁决、产品口径拍板、真沙盒采集授权——只计数。
- **proposal（放宽口径类，永不自动落地）**：**任何放宽验收标准的改动**——提高容差/阈值、
  跳过某道门、扩 URL 白名单、弱化 partial 拒收。写进台账等维护者拍板，agent 不许当轮落地。
- **auto（可自动化的工具/文档缺口）**：不放宽口径的修复（新 helper、新过滤参数、文档补充）。
  满足「有测试锁定 + 不触碰防伪链语义」即可当轮直接改 Skill 落地，带 `--commit` 记 landed。

**台账通道（唯一读写路径,不许手改台账文件）**：

```bash
node "<SKILL_ROOT>/scripts/evolution-note.mjs" add \
  --fingerprint <root-cause-slug> --tier <by-design|proposal|auto> \
  --title "<一句话根因>" [--detail "<现象与证据>"] [--proposal "<具体改法>"] [--commit <sha>]
node "<SKILL_ROOT>/scripts/evolution-note.mjs" set-status --fingerprint <slug> --status <landed|adopted|rejected> [--note "…"]
```

`evolution/ledger.json` 为事实源，`EVOLUTION.md` 由脚本再生成（手改会被覆盖）。条目按
fingerprint 去重：`isNew=false` 时只自增计数，不重复分析。每次写盘后脚本自动把台账两个文件
commit + push 本仓 main（best-effort：断网/非 main 分支不阻塞，失败如实写进收尾摘要；
`--no-sync` 仅本地调试）。台账正文不写 token、凭证、内部绝对路径。

**收尾摘要**：本轮有新条目时向用户报一组「自进化」——auto 已落地的写一句话 + commit 短 sha；
proposal 点名维护者看 EVOLUTION.md；全是 isNew=false 时整组省略。

**外部使用者**：本 skill 是公开仓（github.com/PraiseZhu/qa-hifi-demo）。欢迎把你的台账条目
以 PR 回流——只动 `evolution/ledger.json`（经 evolution-note.mjs add 生成），不改判定脚本。

## demo 合约（index.html 必须实现）

> **标准实现**：合约(§1-§5)的标准实现是 `templates/qa-chrome.js`（init.mjs 自动内联进
> index.html）。demo 作者只写 `window.__qaDemo` 配置（matrix/states/renderApp 等），
> **不要手写 __qa API / 偏好持久化 / 切换器 / 状态补齐 tab**——历史上 10 个 demo 写出
> 10 种偏好切换器（replay.mjs clickPref 要猜 7 种 selector 就是后果）。手写合约仅限
> chrome 无法覆盖的特殊场景，且 DOM 合约（`data-qa-pref` / `data-qa-state-tab` /
> `data-qa-goto` / `.frame`）必须与标准一致。

1. **内嵌真值**：`<script id="qa-truth" type="application/json">{...}</script>`，内容 = truth.json。
   渲染代码从这个节点 `JSON.parse` 取数，不许另抄一份。
2. **__qa API**（供 verify.mjs 驱动）：
   ```js
   window.__qa = {
     current: () => S.step,          // 当前状态 id(与 spec.states 的 id 对齐)
     goto: (id) => {...},            // 直达任意已声明状态；未知 id 必须 throw/reject
     prefs: () => ({ plat, region, os, mode, lang }),  // 当前持久化偏好,五项必须精确返回 string
     scale: () => k,                 // 当前端的 设计px→CSS px 缩放系数(门 D scaled 绑定用)
     resize: (w, h) => {...},        // 设帧尺寸(CSS px,内部 clamp 到沙盒 min;与拖拽手柄同一代码路径)
     metrics: (ids) => ({            // 门 F 量几何:帧尺寸 + 探针元素帧内相对 rect
       frame: { w, h }, probes: { [id]: { x, y, w, h } },
     }),
   };
   ```
3. **状态补齐 tab**：`via: null` 的状态自动汇入该 tab；每个条目 = 状态快照入口 + 一句
   「为什么链路难触达」+ 来源场景。tab 不是垃圾抽屉——进 tab 必须写理由。
4. **工具区（chrome）**：头部含 PR 号徽标、三段说明（做了什么/怎么做/怎么验收，各 ≤2 行）、
   matrix 切换器（端/区域/系统/主题/语言）、「状态补齐」tab 入口。言简意赅，界面本体按 truth 渲染，
   工具区文字做减法。详见 `templates/demo-chrome.md`。
5. **偏好持久化**：matrix 五类选择存 localStorage（key `qa-hifi:<name>:prefs`），流程状态不持久化。

## spec.json 字段规范

见 `templates/spec.schema.md`。核心三段：

- `meta`：`{ name, pr, basePr?, summary: {what, how, accept} }`
- `matrix`：`{ platforms, regions, systems, themes, langs }`（数组；`systems` 映射到 `os`，verify 无 cases 时跑全组合）
- `states`：`[{ id, via: [step...] | null, tab?: "状态补齐", note? }]`
  - step 语法：`{click:"<sel>"}` / `{type:{sel,text,delayMs?}}` / `{waitMs:n}` / `{expect:"<state-id>"}`
  - **能通过交互链路表达的状态必须给 via**（链路走到「进入正式主界面」为止）；
    只有确实难触达的（错误态全集/过期态/授权被拒/加载中间帧）才 `via: null` + `tab` + `note` 写理由。
- `verify`：`{ cases?, noClip, inputs?, persistence? }`
  - `cases`: `[{ id?, prefs:{plat,region,os,mode,lang}, via?, viewport? }]`，优先级高于 matrix 全组合。
    `viewport: {w, h, dpr?}`——**移动端 case 必须声明移动端视口**（如 `{w:390,h:844,dpr:3}`），
    verify 会为该 case 换用对应尺寸/DPR 的页面；不声明 = 1440×960 桌面视口，mobile 的
    截断/溢出结论不成立。
  - `noClip`: 非空 selector 数组；每个 selector 在每个状态/组合至少命中一个可见元素，横纵 overflow、viewport 溢出、ellipsis、line-clamp 都算 FAIL。
  - `inputs`: `[{ via?, sel, text, tickMs, tickWitness }]`；`text` 非空，`tickWitness` 必须在等待窗口内真实变化。
  - `persistence`: `{ via, expected:{plat,region,os,mode,lang}, storageKey, reloads, initialState? }`；先断言 via 后 prefs，再验 localStorage，再 reload 恢复偏好且 current 回初始态。
- `bindings`：门 D 声明——`[{ sel, prop, truth, scaled?, kind?, pseudo?, via?, tolerancePx? }]`；
  `kind` 枚举：`color` / `length` / `text` / `asset-sha`。`pseudo` 枚举：`::before` / `::after` / `::placeholder`。
  `color` 会拒绝 `inherit/currentColor/var()` 等上下文相关值；`length` 支持严格 CSS length 解析，可按 `__qa.scale()` 缩放；
  `asset-sha` 只允许同源本地资源，按 SHA256 与 truth 比对。
- `baselines`：门 E 声明——`[{ key, via?, frameSel?, mask?, maxMaskRatio?, minUnmaskedRatio? }]`
  + `baselineFrameSel?` / `baselineThreshold?` / `baselineDpr?` / `pixelmatchThreshold?`；
  基准图放 `baselines/<key>.png`（真沙盒截图，声明了就必须存在）。热图输出到 `pixel-artifacts/`。
- `adaptive`：门 F 声明——`{ min: {w,h}, sampleSizes: [[w,h]...], probes: [{id, sel}], tolerancePx? }`；
  `min` = 沙盒最小窗口宽高（extract 从产品常量提取,如 Electron BrowserWindow minWidth/minHeight）；
  `sampleSizes` 供 extract.mjs 预计算 `truth.adaptive.samples`（每条 = `{w, h, probes:{<id>:{x,y,w,h}}}`）。
- `customGates`：门 X 声明——`[{ id, script, description?, timeoutMs? }]`；`script` 是 demo 目录内
  相对路径（禁 `..`/绝对路径），verify 以 `node <script> --demo <dir>` 执行，exit 0 = PASS；
  脚本 hash 计入 inputHashes（verify 后改脚本 → report 失效）。demo 需要六门之外的专属检查
  （元素重叠、特殊交互断言）时用这里注册，**不许留游离脚本**。

## demo 拉伸交互（有 adaptive 段时必须实现）

- 帧右缘/下缘/右下角提供**拖拽手柄**,可直接左右(宽)、上下(高)拉伸;拖拽与 `__qa.resize()`
  走同一代码路径,内部 clamp 到 `adaptive.min`(拖不小于沙盒最小宽高)。
- 帧角落常显 `W×H` 与当前所处适配档位(如「长屏档/短屏档/压缩档」),让人拉的时候看得见档位切换。
- 帧内布局是**复刻产品布局引擎的连续函数**(锚点/插值/钳制参数全部来自 truth),
  不是几个固定断点的静态摆放——拉伸中间任意尺寸都要与沙盒一致,门 F 采样点会验证这一点。

## 硬性红线

1. **真值不许手抄**——界面上任何文案/几何/颜色，extract.mjs 提取不到就去补提取器，不许"看着源码敲进 demo"。
2. **阻断门不绿不部署**；report.json 是部署的前置产物，有 baselines 时 report-pixel.json 也必须可被 pr-block 接受。
3. **状态两边都不在 = 构建失败**——不存在"这个状态先不管"的中间态；要么进链路，要么进补齐 tab 并写理由。
4. **对外动作（部署链接贴 PR、发评论）先经用户确认**。
5. demo 是 QA 工件不是产品代码：禁止反向把 demo 里的实验改动"顺手"带回产品源码。

## 试点

第一个试点 = cindy 登录协议 demo（`Project CINDY/_tmp/consent-hifi/`）反向改造：
拆出 spec.json + extract.mjs（从 loginSkinLayout.ts / 4×common.json / loginMessages.ts /
themes tokens 提取），给现有 index.html 补 `qa-truth` 内嵌块与 `__qa` API，跑通 A-F 门。
它经历过 6 轮真实返工，是现成的回归基准。
