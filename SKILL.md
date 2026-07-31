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

#### P0 组件模式（真组件直渲，可选路线）

```bash
node scripts/init.mjs --dir <demo-dir> --name <slug> --mode component \
  --entry <组件入口，相对 repoRoot> [--entry-export <目标组件导出名>]
```

不带 `--mode` 就是**经典模式**（手写 HTML 复刻界面，默认路线，行为不变）。组件模式把
demo 本体换成 **esbuild 打包的真实产品组件**：界面不再手写，因此「文案/色值手抄漂移」和
「复刻状态机 ≠ 产品状态机」这两类盲区从根上消失。多生成的产物：

| 产物 | 作用 |
|---|---|
| `build.mjs` + `component-build-core.mjs` + `repo-glob.mjs` | 构建器**薄壳 + 规范正本**：core 读 `spec.component` → esbuild bundle（shim/包/`@/` 三级 alias）+ 输入清单；`build.mjs` 只负责落清单 + 图片落 `assets/` + 可选 tailwind CSS（产物 `assets/component.css` 的字节由门 A 的 `--check-css` 可信侧重编复算，r6）。三份都是 skill canonical 的逐字节拷贝，改写任一份 → 门 A fail-closed「检测到自定义构建器，需人工审查」 |
| `src/bootstrap.tsx` | 装配入口：import 真组件，`Object.assign(window.__qaDemo, { states, mount, inject, onPrefs })` |
| `shims/`（README + `_template.ts`） | 替身层骨架与硬规 |
| `index.html` | 组件壳：内联 adapter 标记段 + `<script src="assets/component.bundle.js">` |
| `component.inputs.json`（build 产出） | esbuild `metafile` 规范化输入清单：`productInputs`（相对 repoRoot）/ `demoInputs`（相对 demo）/ `buildInputs.{demo,product}`（构建期文件 / tailwind config **及其 `content` 显式声明的每个文件**（r7：显式列表，非 glob） / alias 读过的 package.json）/ `entryExport` / `entrySentinel` / `skippedExternal`。清单里每个输入 + 清单自身逐文件 sha256 进防伪链；缺清单 = `NO_MANIFEST` fail-closed。**清单不是自证的**：门 A 与 `pr-block` 都跑 **skill 仓自己那份** `component-build-core.mjs --check-inputs` 用 esbuild 现算一遍再全等比对——复算路径上**不执行 demo 目录里的任何代码**，「先缩清单再重跑 verify」「把 build.mjs 换成回显旧清单的脚本」都当场被抓。该声明由两道机制共同兜住（r4）：复算子进程解析构建期依赖时**候选目录只有 `QA_HIFI_MODULE_ROOT` 与 repoRoot**（绝不含 cwd/demo 目录——否则 `<demo>/node_modules/esbuild` 的顶层代码会在 import 时执行）；且 demo 目录及任意子目录**只要存在 `node_modules` 就 fail-closed**「demo 目录不应自带 node_modules，检测到依赖目录，拒绝——demo 自身不装依赖」（demo 侧依赖既不入哈希链、也不在构建期文件对照表里，是绕过具名 hash 的侧路）|

**「真组件直渲」不靠声明，靠运行期哨兵 —— 而且只认你声明的那个导出。**
只证明 `entry` 在 `metafile` 输入里是不够的：`import '<entry>'` 这种副作用导入同样让它进图、
hash 入链，而界面完全可以是 bootstrap 手搓的。构建期给 `entry` 的导出套调用探针，真被调用/
实例化（React 调函数组件、`new` 类组件、`memo`/`forwardRef` 的 `render`）时置位；verify 在
门 B 挂载完成后、第一个状态断言前查一次。

**哨兵证据由可信侧观察，不靠 demo 侧提供的形状（r5）**：置位与计数留在 bundle 的模块闭包里，
对外只暴露一个 `writable:false` / `configurable:false` 的全局 `__QA_ENTRY_SENTINEL__`。
r3 曾把证据放在可写全局 `__QA_ENTRY_RENDERED__` / `__QA_ENTRY_TARGET_RENDERED__` 上——
「只持引用不调用 + 把布尔量写 true + 手搓 UI」当时能拿到 `proved`；r4 改成封印形态校验
（不可写 / 只读访问器 / 对象已冻结）后，**这套形状本身是公开可仿造的**：index.html 在 bundle
之前抢先 `defineProperty` 一个同形封印（不可配置的 `snapshot` getter），真 bundle 的
`defineProperty` 抛错、verify 又不听 `pageerror`，于是读到的是假证据。r5 起多层叠加、r6 再加一层，全部落在可信侧（真正的安全锚是前三条字节/异常层，
第四条只是形态检查）：

* **全部 esbuild outputs 字节全等复算（I-ESBUILD）**：门 A 跑 skill 仓自己那份 `component-build-core.mjs --check-outputs`
  （`write:false`，不落产物、不执行 demo 目录里的任何代码）现算一遍期望产物，与磁盘上的
  `assets/component.bundle.js` **以及每一个 file-loader 派生产物**（图片 / 字体，`[name]-[hash]`）做「路径 → 字节」逐项全等比对。伪造方要过这关就得提供一份**字节全等的真
  bundle**，而真 bundle 里的哨兵是真的；顺带堵死一切手改 bundle（塞手写 UI / 摘哨兵）与**派生资产同名换字节**（r7 条目 3：`[hash]` 是 esbuild 的内容指纹**不是密码学校验**，只复算 JS 时它字节全等）。
* **`pageerror` fail-closed**：verify 监听页面未捕获异常，哨兵断言处非空即硬失败——预占封印
  导致真 bundle 初始化抛错的场景在这里直接暴露（bundle 初始化**故意不 try/catch**）。
* **CSS 字节全等复算（r6 条目 1）**：同型的一条 —— 门 A 跑 `component-build-core.mjs
  --check-css`，用**产品仓的 tailwind config** 把 CSS 重编到临时目录，与磁盘上的
  `assets/component.css` 做 sha256 全等比对（未配 tailwind 时期望值是共享常量
  `CSS_PLACEHOLDER` 的字节）。r5 之前 CSS 产物**全仓没有任何字节复算**：`buildComponentHashes`
  / `buildAssetsManifest` 只把它的字节记进清单做「report 是否过期」检测，于是合法构建后
  手改 `component.css`（改样式 / 删规则 / 插任意 CSS），只要不动入链的输入文件，
  verify / pr-block 全流程零检测通过。同输入编译两遍字节不等 → 直接 fail（不静默容忍
  不确定性）；产品仓没有 tailwindcss CLI → fail-closed 拒绝放行，不是静默跳过。
* **`prove(nonce)` challenge —— 形态检查，不是安全锚（r6 校准）**：封印上有不可写/不可配置的
  `prove(nonce)`，verify 每次运行生成随机 nonce 并要求回应原样带回。**它只是一次 nonce
  回显**：nonce 由 verify 通过页面求值传进去，页面里的任何函数都能收到并原样返回，
  所以它**不构成 secret**，也不构成「哨兵是真的」的证明 —— 审核人与 r5 修复者独立得出同一结论。
  它的实际作用只是把「静态预置一份冻结对象」抬高成「必须写一个真函数」，而真函数躲不过
  上面的字节复算与 `pageerror`。**真正的锚是「全部 esbuild outputs 字节复算 + CSS 字节复算 + `pageerror`
  fail-closed」这三条。**

封印形态校验与 `prove` 回应仍在（不可写 / 只读访问器 / `prove` 形态 / 对象已冻结），
但它们只是形态检查，**不是安全锚，也不是结论强度的来源**。

判定分三种（`manifest.entrySentinel`）：

| 形态 | 触发条件 | 结论 |
|---|---|---|
| `targeted` | 声明了 `component.export` 且探针就位 | 目标导出被调用 → `entryRenderProof='proved'`，PR 块写「真组件直渲」；目标可探测却一次没被调用 → **门 B 硬失败**并点名（报文区分「只调了其它导出」与「纯 side-effect import」） |
| `active` | 未声明 `component.export` | 只保留「一个导出都没被调用 → 门 B 失败」这条硬失败；最高只到 `nontarget`，**PR 块一律降级** |
| `unavailable` | 探针完全套不上（`entry` 不是 JS/TS、无任何导出、或声明的目标导出是常量/纯数据） | 不判造假（避免误伤），PR 块降级 |

声明了 `entry` 里**不存在**的导出 → `build` 直接 exit 2 并列出真实导出名（错误声明不许静默
降级）。另有 tree-shake 护栏：`entry` 在图里但 `bytesInOutput` 为 0（只被 `import type`、
或导出全未被引用且无副作用）→ build exit 2。

诚实边界（不隐瞒）：
* 不声明 `component.export` 就**永远拿不到**「真组件直渲」这句话，PR 块只会写「产品模块已打包
  （N 个源文件 hash 入链）｜⚠️ 运行期哨兵未证明「声明的目标组件导出被渲染」…是否为 UI 组件需
  人工审查」。这是 r3 收紧的点：r2 只要 `entry` 的**任一**导出被调用就宣称直渲，于是
  「entry 同时导出组件与工具函数、bootstrap 只调工具函数 + 手搓 UI」能骗到 ✅。
* 探针只能套函数/类/`memo`·`forwardRef`；`export *` 转出的名字拿不到，不套探针。
* 工具**不**证明「渲染出来的像素来自该组件」——它证明的是「该导出被调用过」。组件里再套一层
  假 UI 这类情形仍需人工 review；工具不宣称自己做到了做不到的事。

`spec.json` 多一个 `component` 段：`mode:"component"` / `entry`（必须是 bootstrap 真正
import 渲染的组件——build.mjs 用 esbuild `metafile` 核对，不在 bundle 真实输入里就 exit 2）/
`export?`（目标组件导出名，默认导出写 `"default"`；**拿到「真组件直渲」结论的唯一途径**，
不填只会降级、填错直接 exit 2）/
`sources[]`（可选的人读声明；代码层防伪链的真相源是 build 生成的 `component.inputs.json`）/ `bundle` / `bootstrap` / `assetsDir` / `rendererRoot` / `packageRoots` /
`shims[{spec,file,why}]` / `css`（配了 `css` 就**必须**显式声明 `css.content` 非空数组——r4 起
省略/空数组一律 schema + build 双重 fail-closed，因为不显式声明时 Tailwind 会按
`tailwind.config.js` 里的 `content` **隐式扫描**，那些样式源文件不进防伪链，改了 hash 不变、
旧 CSS + 旧 report 照过；build 始终用显式 `--content` 覆盖 config。

> **⚠️ 破坏性变更（r7 条目 2）：`css.content` 只接受「显式的仓内相对普通文件路径」列表，
> 不再支持 glob 与目录。** 旧 spec（如 `["src/**/*.tsx"]`）会在 schema / build / verify 入口
> 直接被拒并附迁移指引。迁移方式：
> `node scripts/lib/component-build-core.mjs --suggest-content "src/**/*.tsx" --demo <dir>`
> 把旧 glob 展成建议清单，**抄进 spec.json**（生成器只是便利工具，运行期一律不做展开）。
> 逐项校验分两层（r7 条目 5 修正）：**① 路径安全** —— 非空、无 NUL、非绝对路径、无 `..`、无空段、默认拒 `node_modules/` 与 `.git/` 下的路径；**② glob/transport 形态** —— 只拒
> 「Tailwind 自己会当 glob 解释的形态」：`*`、成对 `[...]`、成对 `{...}`、extglob 前缀
> `+( @( !( ?( *(`、反斜杠；外加 `,`（`--content` 是逗号分隔多值串，承载不了）与 `?`
> （**意图信号**，实测它在文件名里是字面的）。再加 fs 层的「存在 + 必须是
> regular file + realpath 落在 repoRoot 内」（挡 symlink 越狱）。声明不存在的文件 = exit 2
> （等价于旧「glob 零命中」：CSS 会按更小的集合编译却不被发现）。
> **为什么收紧到这个程度**：自研 glob 展开已被证伪四次（字符类 `[ab]` → `content.relative`
> 基准错位 → `node_modules` 非对称扫描 → `***`/`a**` 语法差异），r6 改成复用 fast-glob 后仍留
> 三条残余；而 Tailwind v3 **没有公开稳定的 API/CLI 能导出真实 file set**
> （`parseCandidateFiles` 是包内私有 API，不是升级稳定契约）。所以把语义解释权收回来。
> **不变式 `S ⊆ E = L`**（实扫集 ⊆ 期望集 = 入链集）由**参数结构**保证：content 转成绝对
> 文件路径传 `--content`，Tailwind 对绝对文件路径给出 `glob === null`，扫描集就是那些文件
> 本身；CLI override 之后 `config.content` 与 `config.content.relative` 都不再决定集合。
> 参数构造两侧共用构建核心的 `contentCliArg`（薄壳 build 与可信侧复算必须逐字节一致，
> 否则 CSS 字节复算会误杀合法产物）。受限 glob 白名单仍在，但只服务 `component.sources`
> 等其它 glob 用途，不再管 content。

不需要 tailwind 就把 `component.css` 设为 `null`） / `themeVars.truthPath` /
`fixtures[{id,why,shape?}]` / `target?`。**没有 `component.driver`**——状态怎么被驱动只写 `states[].driver`
（`"inject"` / `"via"`，单一真相源）。adapter 升级：
`node scripts/init.mjs --dir <demo-dir> --update-adapter`（与 `--update-chrome` 同机制）。

**`__qaDemo` 组件模式合约**（adapter 校验，不符当场抛错，不给静默空白页）：

| 字段 | 谁提供 | 语义 |
|---|---|---|
| `mode: 'component'` | index.html 基础段 | 组件模式标记 |
| `name/pr/summary/matrix/defaultPrefs/initialState/tabStates/adaptive/scale` | index.html 基础段 | 与复刻模式逐字一致 |
| `states` | bootstrap | 键 ≡ `spec.states[].id`，每项 `{ driver: 'inject' \| 'via' }`；`via` 型不许进 `tabStates` |
| `mount(ctx)` | bootstrap | **只调一次**，把真组件挂到 `ctx.root`（adapter 在 `.frame` 内建的 `.qa-component-root`） |
| `inject(id)` | bootstrap | `driver:'inject'` 状态必填；幂等（挂在 `onEnter`，首帧 `initialState` 也会走一遍） |
| `onPrefs(prefs)` | bootstrap（可选） | 非主题偏好（lang/region/os/plat）；**主题由 adapter 接管** |
| `renderApp` | adapter 合成 | bootstrap 自带 `renderApp` = 直接抛错 |

内联顺序硬性：`#qa-truth` → 基础配置段 → `assets/component.bundle.js` → adapter → qa-chrome。
adapter 必须在 bundle **之后**（它读装配好的 `mount`/`states`）、qa-chrome **之前**
（它要先把 `__qaDemo` 补成 chrome 能吃的形状）。

**什么时候用组件模式**——只用于「干净边界的组件面」，选之前先做 **coupling 侦察**：

1. 组件 render 期是否碰 IPC / 网络 / 原生能力？碰得越少越适合（登录页这类是理想对象）。
2. 需要 shim 的依赖清单有多长？每条 shim 都要写得出 `why`；清单发散说明边界不干净，退回经典模式。
3. 状态是否可从外部驱动？组件局部 `useState` 的子视图只能经真实交互到达——在
   `spec.states[]` 里标 `driver:"via"` 并写全 via 链路（schema 硬要求），
   `__qaDemo.states` 同键同标；adapter 对它的 `goto` 显式 throw，门 B 走 via 重放取证，
   不许假装可直达。
4. 界面数据是否都在源码里？只在服务端响应里存在的数据（登录方式配置、成员列表等）
   **没有源码 provenance**，写进 `component.fixtures[]` 如实声明，不许塞进 `truth.json`。

**适用范围限定（spike 结论，别越界）**：

- **移动端 / RN 组件不在范围**：需要 react-native-web，维持经典模式；`--mode component`
  生成的 matrix 因此只留 `desktop`。
- 保真度让步要如实记进 PR：`null` / 稳态 shim 造成的缺席（如窗口按钮）需要 pixel 基准 mask。
- 主题走**主题桥**：色值由 `extract.mjs` 用 `extractThemeVars()` 提到 `truth.themeVars`
  （逐 token 带 provenance），运行时由 **adapter** 复刻产品 `applyTheme` 语义
  （重写 `style#theme-vars` + 切 `html.dark` + `colorScheme`）。bootstrap 不碰主题，
  更不许手写色值。`themeVars` 两种合法形状：token 优先
  `{ '<token>': { light, dark } }`（`extractThemeVars` 的输出，推荐）或 mode 优先
  `{ light: { '<token>': v }, dark: {...} }`；缺失/空则主题桥如实关闭（不假装应用了主题）。
- 资产不内联：图片走 file loader 落 `assets/`（全内联实测让单文件涨到 10MB 级，仓里不可接受；
  xd-pages 本来就部署整个目录）。产品原始美术资产可能单张就几 MB（登录 hero@2x 实测 3.8MB），
  `assets-manifest.mjs` 默认 8MB 闸门会拦——**要么压图/换 webp，要么显式
  `--max-total <MB> --override-reason "<理由>"` 抬闸**；理由是必填参数（缺了直接拒），
  会自动印上 PR 附贴块，闷着抬这条路已经堵死。
- **「整窗级组件」的帧语义**（2026-07-30 集成实测）：组件若用 `window.innerWidth/innerHeight`
  自量尺寸、或用 `position: fixed` 铺全屏 overlay（登录屏就是），它的几何公式以 **viewport**
  为基准，而 chrome 工具区占了上方空间、`.frame` 比 viewport 小——两者不一致会让门 C 报
  「溢出 viewport」。两条路都可以，但要选一条并写清：
  ① **让组件铺满 viewport**（推荐）：不给组件根建包含块，产品公式在真实 viewport 里运行
  （几何与真实 App 同源），demo 侧把 chrome 抬到 overlay 之上（`.qa-chrome{position:relative;
  z-index:100000}`）；代价是 `.frame` 对这类组件只是名义边框，像素基准要按 viewport 取。
  ② **把帧当窗口**：给组件根 `transform: translateZ(0)` 建包含块把 fixed 收进帧内；
  但组件读 `window.innerHeight` 时仍是整窗值，须自行对齐，且门 C 的 viewport 判定会与
  帧偏移打架——只适合不读 window 尺寸的组件。
- 门语义变化：组件内部的门 D 绑定失去意义（值没有手写环节），门 D 收缩为只验 chrome 工具区；
  门 A 需把组件源文件 hash 计入防伪链。

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

#### 服务端驱动数据（fixture 叶子）

有些值**源码里根本没有字面量**——模型供应商配置、账号 membership、后端下发的开关等，
只存在于服务端响应里。这类值用 `makeFixtureLeaf()`：把真沙盒响应存成 demo 内
`fixtures/<name>.json`，叶子记 `provenance.sourceKind: 'fixture'` + 结构化 `capturedFrom`。

```js
import { makeFixtureLeaf } from './extract-helpers.mjs';
const fx = readJson('fixtures/providers.json');
providers: fx.data.map((p, i) => makeFixtureLeaf(p.displayName, 'fixtures/providers.json', {
  locator: `data.${i}.displayName`,                 // 受限 JSON 路径,会被真解析
  capturedFrom: {
    environment: '公司沙盒',                          // 必填
    capturedAt: '2026-07-30',                        // 必填,ISO 日期开头
    endpoint: 'GET /api/providers',                  // 可选
  },
}))
```

规则：

- fixture 文件必须落在 demo 内 `fixtures/` 下并随 PR 入库——reviewer 打不开的 fixture 等于没有溯源；
  存在性 + hash 校验与 `code` 叶子完全一致（fixture 是**声明性降级**，不是防伪豁免）。
- **`locator` 必须是可机械解析的 JSON 路径**，三种写法：`data.0.displayName`、
  `data[0].displayName`、JSON Pointer `/data/0/displayName`。自由文本（`'第 0 个 provider 的名字'`）
  一律 FAIL——不可解析的锚等于没有锚。
- **值绑定（硬校验）**：工厂函数与门 A 都会解析 fixture 文件、按 locator 取值，与叶子 `value`
  做 canonical 比对，不符即 FAIL。整文件 hash 只能证明"fixture 没被改过"，证明不了
  "叶子里的值真出自这份 fixture"——少了值绑定，fixture 就是手抄数据的免检通道。
- `capturedFrom` 必须是结构化对象 `{ environment, capturedAt[, endpoint, note] }`；
  `capturedAt` 必须是真日期（ISO 开头）。旧的一句话自由文本已不接受——它没有任何可机械
  检查的成分，"沙盒响应"四个字就能过，三个月后没人判断得出这份 fixture 还代表不代表真实服务端。
- **禁止用 fixture 冒充可源码提取的值**：布局常量、i18n 文案、颜色 token 一律 `makeLeaf()` 走源码。
  ⚠️ **这一条工具证明不了**——机械校验只能确认"值确实来自这份 fixture"，无法判断"这个值本来
  可以从源码提取却偷懒录了 fixture"。它属**人工审查边界**：reviewer 看到 fixture 声明行时，
  要自己核一遍这些值是不是真的只存在于服务端响应里。
- 门 A 语义不变：fixture 文件是 extract 的输入，`extract.mjs` 现跑仍须≡`truth.json`。
- PR 附贴块会自动加一行 `⚠️ N 个叶子来自录制 fixture（非源码溯源）`——不阻断，但对外诚实。

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

**pr-block 定稿前会在可信侧亲自重跑（r5 立规、r6 补上门 E）**：`report.json` 整份都住在 demo 目录里、
是被审方可写的，而 `inputHashes` 是用**可导出的** `buildInputHashes()` 对被审方自己控制的文件
现算的——天然自洽，锁不住任何东西。所以「正常 build + 只持引用不调用 + 手搓 UI + **完全不跑
verify** + 手写一份全 pass 的 `report.json`」曾能让 pr-block exit 0 并打出「真组件直渲」。
r5 起 pr-block 用 **skill 仓自己那份 `verify.mjs`** 重跑 A/B/C/D/F/X（`--report-out` 写到 demo
之外，不覆盖作者的 `report.json`），**以自己重跑的结果为唯一放行依据**；demo 的 `report.json`
降级为仅供对账的自报材料——两者在 `ok`/`partial`/`entryRenderProof`/A·B·C·D·F·X 六门 pass/`gateB`·`gateD`
计数/coverage case 集上不一致即阻断。代价是定稿时会多跑一次浏览器验收（已有其它 problems 时
跳过重跑）。

**门 E 不在 `verify.mjs` 里**（`GATE_LETTERS = A/B/C/D/F/X`），r5 的可信重跑因此**漏掉了它**
（r6 条目 2 CRITICAL）：门 E 当时的唯一校验是 `validatePixelForPr`，它全是
`report-pixel.json` 自身字段的算术自洽（`diffRatio === bad/total`、`threshold === spec` 声明值、
`bad <= total`、`engine` 枚举、WARN 需 adjudication + 存在的 artifact 图），**从不重新调用
odiff/pixelmatch 对真实图片比对**。于是手写一份满足全部自洽约束的 `report-pixel.json`
（`inputHashes` 用可导出的 `buildInputHashes()` 现算）就能让门 E 判通过 —— 基准图甚至可以
不是 PNG，视觉回归被伪造成 PASS。r6 起：`spec.baselines` 非空时 pr-block **亲自 spawn skill
自己那份 `pixel-compare.mjs`**（`--report-out` 写到 demo 之外），以可信结果为放行依据；
可信结果同样过一遍完整校验（阈值 / 计数 / engine / WARN 裁决与 artifact 全绑在这份上，
artifact 三图被重跑覆盖成可信侧生成的那份），再与 demo 自报做结论对账
（`ok`/`skipped`/`declared`/`threshold` + 每个基准的 `status`；`bad`/`total` 因重新渲染有
像素级抖动，不做全等以免假阴性）。

### 三层不变式（r7 收口，写死）

组件模式的验收结论只建立在这三条上。**三者同时成立**才可以表述：所有影响组件渲染的构建产物，
要么是可信工具当前输入的确定性输出、要么验收失败；demo 自报与磁盘最终 hash 不再充当
"发生过可信构建 / 观察"的证明。

| 不变式 | 内容 | 落地位置 |
|---|---|---|
| **I-ESBUILD** | 磁盘上 bundle + **所有 file-loader outputs** 的「路径 → 字节」映射，必须等于 canonical `write:false` 现算映射 | `component-build-core --check-outputs` + `recheckComponentOutputs`（门 A） |
| **I-CSS** | 磁盘 `component.css` 字节必须等于 canonical 临时重编字节（同一 Tailwind 实现 / config / cwd / input / content / 受控 env） | `--check-css` + `recheckComponentCss`（门 A） |
| **I-OBSERVE** | **观察对象必须等于交付对象**：所有核心观察(门 B/C/D/F 的浏览器实测 **与门 E 的像素比对**)都从**同一份整树不可变 snapshot** 取文件，且这份 snapshot 与交付树逐条**同类型同字节** —— 因此 demo 输入树里**不许有任何 symlink**（前置门 `checkDemoNoSymlinks`，r9 P0）；三项字节复算与这些观察**绑定同一份快照字节** —— 快照先建，复算随后，紧邻一次**双向 manifest** 证明 snapshot ≡ 磁盘；全部发生在 demo `node_modules` fail-fast 之后、**任何 demo 可执行脚本之前**；出块前再做一次双向 manifest | `lib/observe.mjs`（verify 与 pixel-compare 共用一份实现）+ `fs-utils.checkDemoNoSymlinks`（verify / pr-block / pixel-compare 三处同一道前置门）+ verify 的执行时序；次序与实现由 `comp-fix-r8` / `comp-fix-r9` 源码契约锁死 |

**I-ESBUILD 为什么必须覆盖派生资产（r7 条目 3，实测 P0）**：r5 只复算 JS 字节。组件真实
`import hero.png` 时 esbuild 的 file loader 会落出 `assets/hero-XMUUP4P7.png`；审核人实测把它
**原地覆盖成另一张图但保留原文件名** → JS 里引用的还是同一个名字（bundle 字节仍全等）、
`inputHashes.assets` 是对攻击后字节现算的（天然自洽）、文件名里的 `[hash]` 只是 esbuild 的
**内容指纹不是密码学校验** ⇒ `verify=0`、`pr-block=0`，仍贴「真组件直渲」。我在 256dff4 上
复现了这一结果，修后同一攻击 `verify=2` / `pr-block=2` 并点名具体产物。
缺失 / 字节不等 / 换名一律门红；**不在 expected 集合里的额外 assets 不阻断**（作者可能手工放图），
但会列进 `gateA.outputsRecheck.extraAssets` 供人核对 —— 拦它会误杀合法用法，不列出来则无从发现。

### 执行时序原则（r7 条目 1 CRITICAL，写死）

**「可信侧重跑」成立的前提是：canonical runner 自己不能在核心观察之前执行被审方的代码。**
r5/r6 一直漏了这一条 —— r6 的 verify 次序是「跑 demo `extract.mjs` → 三项字节复算 → 启浏览器
跑门 B/C/D/F」，于是 demo 代码拿到了**整个观察窗口**：`extract.mjs` 同步返回**正确** truth
（门 A extractor drift 绿），同时派一个 `detached`+`unref` 的 worker，在父 verify 存活期间把
永久错误的 `index.html` 临时改成与 truth 一致（门 D 实测**绿**），父进程退出瞬间恢复原错误
文件。最终磁盘字节与 `inputHashes` 完全自洽 —— verify exit 0、门 D 判过。

r7 起的次序（**禁止调换，由 `comp-fix-r7` 源码契约测试锁死**）：

0. demo `node_modules` fail-fast（无条件，排在任何 demo 输入解析 / 动态 import / 子进程 / 浏览器之前）；
1. 观察前算一次 `inputHashes`；门 A 的纯静态段（内嵌 `qa-truth` ≡ `truth.json`、页面不得引用快照之外的路径）；
2. 建立**整树**不可变快照（demo 之外的临时目录，`lib/observe.mjs`）。**所有**核心观察的唯一来源：
   门 B/C/D/F 的浏览器实测**与门 E 的像素比对**都从它取文件（门 E 连 baseline PNG 也从快照读）；
3. 三项可信侧字节复算（`--check-inputs` / `--check-bundle` / `--check-css`），跑 skill canonical、不执行
   demo 代码；
4. **双向 manifest 绑定检查点**（`gateA.observeBinding`）：证明第 3 步读到的磁盘字节 ≡ 第 2 步的快照字节。
   这就是「复算与 B/C/D/F/E 绑定同一份字节」的落地方式，同时堵掉「建快照与复算之间有并发写入者」这个窗口。
   为什么复算读磁盘而不是直接读快照：`component-build-core --check-inputs` 必须以 **demoDir 为 cwd** 跑
   esbuild（metafile 的 key 相对 cwd，换 cwd 会改整份清单的规范化结果），且产品组件源码靠 demo 所在的
   **git 仓根**解析 —— 快照住在 tmpdir、不在产品仓内，拿它当 cwd 会直接 `repoRoot=UNRESOLVED` 硬失败。
   所以保留「磁盘产物 == canonical 现算」这个强命题，另加一层当场证明的 snapshot ≡ 磁盘；
5. 浏览器门 B/C/D/F（全部核心测量），全部从快照加载；
6. **之后**才执行 demo 侧代码：门 A 的 extractor drift 段 + 门 X 自定义门。门 A 的结论**延后合并**
   （`gateAHardFail` 一票否决），extractor drift 这项检查不丢不降级；
7. 再算一次 `inputHashes` 与第 1 步比对，不等即门 A 红；并做**收口双向 manifest**
   （`gateA.snapshotDrift` / `gateA.snapshotManifest`）—— 此时测量结果本身仍可信（观察对象是快照），
   但磁盘上的 demo 已不是被观察的那一份，PR 会带走另一个版本，必须报出来。

**快照为什么必须是整树（r8 条目 A，P0，审核人可执行 PoC）**：r7 的快照带一张排除表（整个
`verify-artifacts/`、`pixel-artifacts/`、三个 `report*.json`），而**没有任何东西禁止页面引用被排除的
路径**。PoC：`index.html` 加 `<script src="pixel-artifacts/late.js">`，该脚本把门 D 绑定的 `.box` 宽度
从正确的 `16px` 改成 `99px` → 快照里那个文件 404（门 D 在快照上量到 16px，**绿**）、交付原地却真的加载它
（computed width = **99px**）；`snapshotDrift()` 当时只从快照一侧单向遍历，看不见被排除目录、也看不见
运行期新增文件，于是报 `"none"`；`buildInputHashes` 同样不覆盖这两个目录。结果 **verify exit 0 /
gateD.pass=true / pr-block exit 0 可出块**，而被验页面 ≠ 交付页面。同一根因还有两处组成性不一致：
门 E 完全不走快照（直接 serve/read `demoDir` 与 baseline），三项复算针对原目录、快照后建。
r8 的修法不是再加一条检查去挡引用，而是把盲区本身消掉：

| 修法 | 内容 |
|---|---|
| 快照 = **整树** | 唯一跳过 `node_modules`（前置门已无条件拒，存在即 fail-fast）与 `.git`（不属交付产物，部署侧同样排除）——二者都**不是页面可达的交付字节**，因此不构成盲区。曾被排除的 `pixel-artifacts/` / `verify-artifacts/` / `report*.json` 现在全部进快照 |
| 工具输出改到 **output root** | 失败截图与门 X/extractor 的可信脚本副本一律写到 demo 之外的 output root（`report.artifactRoot` 给出绝对路径，`failure.screenshot` 是相对它的路径）。demo 树里因此**没有本轮运行期写入**，双向 manifest 不需要任何按名豁免 |
| **双向 manifest** | `snapshot→磁盘`（删除 / 字节改写）+ `磁盘→snapshot`（**新增**）都遍历。单向 walk 对「验收期间新增一个页面可达文件」这一整类零感知，而 PoC 用的就是「加一个 late.js」 |
| 门 E 同源 | `pixel-compare` 建立同一种快照、服务快照、**baseline PNG 也从快照读**，比对期间 demo 树零写入，artifact 三图在自己的双向 manifest 通过之后才落盘（WARN 人工裁决按 demo 相对路径看图，这条路径契约不变） |

页面**仍不得引用快照之外的路径**（只剩 `node_modules/` 与 `.git/` 两类，`gateA.refsOutsideSnapshot`）——
这份检查从快照跳过项推导，不会漂移。

**为什么 demo 输入树里一律不许有 symlink（r9 条目 P0，审核人可执行 PoC）**：整树快照用
`cpSync(..., dereference: true)` 建立，这改变了 symlink 的**可达语义** —— 同一条链接在三处不一样：

| 位置 | 对「指向 demo 之外的 symlink」的行为 |
|---|---|
| 快照侧（可信观察） | `dereference` 把链接目标的字节复制成快照内的**普通文件** → snapshot safe-server **200** |
| 交付 / 原地侧 | safe-server 对 target 做 `realpath` 后要求落在 demo 根内 → **403**，交付页面上这个资源加载不到 |
| 部署侧 | 行为不确定（可能 dereference、可能直接失效） |

PoC：demo 原始 `.box{width:99px}`、truth/binding 期望 `16px`，`linked.js` 是**指向 demo 之外**的
symlink，其目标 JS 把 `.box` 改成 `16px`，`index.html` 引用它。实测
`verify exit = 0 / gateD.pass = true / gateA.observeBinding = "bound" / gateA.snapshotDrift = "none" / pr-block exit = 0`，
而原地 safe-server 上 `linked.js` = **HTTP 403**、最终 computed width = **99px** ——
**可信侧量到 16px 判绿放行，实际交付页面是 99px**。注意方向与 r8 的 `late.js` PoC 相反：那次是
「交付比观察多」，这次是「观察比交付多」。

修法三条：

| 修法 | 内容 |
|---|---|
| **symlink 一律 fail-closed**（主修） | `fs-utils.checkDemoNoSymlinks` 属**前置门**阶段，与 `checkDemoNoNodeModules` 相邻、**排在建立快照之前**（快照一建起来就已经 dereference 过了，等快照建完再查就晚了）。verify / pr-block / pixel-compare 三处同一道门；门 E 的这道门还排在「`spec.baselines` 为空 → exit 0」早退分支之前。报错点名**具体路径 + 链接目标 + 403 vs 200 的语义差 + 修法**。`makeObservationSnapshot` 自身再拦一次，使「任何调用方都拿不到 dereference 过的快照」成为该函数的不变式 |
| **含指向 demo 内部的 symlink 也拒** | 内部链接在 dereference 后同样变成普通文件、manifest 同样判不出差异，且部署侧对 symlink 行为不确定 —— 原地 / 快照 / 部署三处语义仍不一致。这是 fail-closed，不按目标位置分情况放行。`node_modules`（含 symlink 形态）归 `checkDemoNoNodeModules` 无条件拒，本门不重复点名；`.git` 跳过（不属交付产物） |
| **manifest 记录 `lstat` 类型 + `readlink` target**（纵深） | r8 的 manifest 只比「跟随 symlink 之后的文件 hash」，于是「快照里的普通文件」与「磁盘上指向仓外的 symlink」被判**全等**（PoC 里 `snapshotDrift` 因此报 `"none"`）。现在 `entryKind()` 用 `lstat` 给出 `{type, linkTarget}`，`snapshotManifestDiff` 多报一类 `retyped`（条目类型不一致）；`listFilesRel` 也改用 `lstat`，不再跟随「指向目录的 symlink」走进去。即使将来某条路径绕过前置门，manifest 也不再瞎 |

**双 server 一致性通用回归**（`comp-fix-r9`）：对每个页面可达资源，断言「原地 safe-server」（交付对象）
与「snapshot safe-server」（观察对象）的 **status + bytes 都一致**。这是「观察 == 交付」的直接验证，
**不限 symlink** —— 未来任何让两侧行为分叉的机制都会在这里翻车。回归里同时放了一条「对 PoC 形状真的会
翻车」的对照，防止它退化成空转。

> 实现坑（Node v24.13，已写进 `observe.mjs` 注释）：`cpSync` 只在**同时传了 `filter`** 时才真按
> `dereference: true` 跟随 symlink；不传 filter 时链接会被原样保留。`makeObservationSnapshot` 正好传了
> filter，所以这里的 dereference 是真生效的、P0 成立；任何要复现该形态的测试必须照样带 filter。

> **⚠️ 破坏性接口约定（r9）**：现存 demo 里只要含 symlink（含指向 demo 内部的），升级后一律被前置门
> 拒收，`verify` / `pr-block` / `pixel-compare` 全部 exit 2。修法：把这些 symlink 复制成真实文件
> （`cp -L`，或直接把内容写进 demo），让 demo 树里只有普通文件。

**门 X / extractor 执行可信副本（r8 条目 C）**：此前 `hashFile(scriptAbs)` 之后仍按**同一路径**
`spawnSync`，不是原子执行已哈希的字节 —— hash 与 spawn 之间的写入者可以换掉文件，「精确 hash 的脚本
字节被执行」这句话就不成立。r8 起把已 hash 的字节复制到 output root 的 `trusted-scripts/` 再执行副本，
并复算副本 hash 与源 hash 比对，不等即拒绝执行。**接口约定（破坏性）**：被执行的是副本，所以
`extract.mjs` 与自定义门脚本必须用 `--demo <dir>` argv（两者都会收到）或 cwd（仍是 demoDir）定位 demo，
**不能**靠 `import.meta.url` 推断自己在 demo 里。

**门 X 无 OS 沙箱的降级为什么可以接受**：需要同时成立四条 —— (a) 所有可信观察固定在**完整**快照；
(b) 后置脚本只能污染不被信任的原目录（观察已完成，快照在 demo 之外它碰不到）；(c) 出块前做双向
manifest；(d) 精确 hash 字节被执行 = 执行已哈希的可信副本。r8 之前 (a)(c)(d) 均不满足，本轮补齐。

**pr-block 侧同理**：门 E 的可信重跑必须排在可信 verify **之前** —— verify 末段会执行 demo
代码，排在其后的那次真实渲染观察正好落在攻击窗口里。

**第 5 步是纵深，不是主防线**：攻击可以在父进程退出后才恢复原文件，让前后两次 hash 都自洽；
真正挡住它的是「核心观察全部早于执行 demo 代码」。

**残余风险（如实标注）**：demo 侧代码在第 4 步之后仍能改磁盘（只是核心观察已完成，且偏离会被
第 5 步报出来）。**没有**把
extractor / 自定义门放进 OS 级 sandbox —— 跨平台可靠性与成本都不合适，且 Node `vm` 不是安全
边界，不拿它假装隔离。因此：**任何在第 4 步之后新增的观察性检查都会重新打开这个窗口**，
新增检查必须放在分界线之前（源码契约测试会拦）。

### 门级全表（结论进 PR 附贴块 ⇒ 必须有可信侧来源）

**原则（写死）：任何结论会进 PR 附贴块的门，都必须有可信侧来源。** 没有可信来源的门不许出块。

| 门 | 结论进 PR 附贴块 | 可信侧来源 | 说明 |
|---|---|---|---|
| A 真值一致 | ✅ 进（"真值一致" 行 + 组件模式 "真组件直渲/已打包" 行） | pr-block 重跑 canonical `verify.mjs`。顺序写死：demo `node_modules` fail-fast → **demo 输入树 symlink fail-fast（r9 P0：一律拒，含指向 demo 内部的）** → 建立**整树** immutable snapshot → `--check-inputs`（esbuild 输入图）+ `--check-outputs`（**bundle 与全部 file-loader 产物**的路径→字节，I-ESBUILD）+ `--check-css`（I-CSS；三项针对磁盘字节，随后由**双向 manifest 绑定检查点**证明 ≡ 快照字节）→ 浏览器门从 snapshot 观察 → **之后**才处理 demo extractor | 复算路径上不执行 demo 目录里的任何代码；门 A 结论延后合并（`gateAHardFail` 一票否决）；执行完 demo 代码再比 `inputHashes` 与 snapshot 偏离 |
| B 状态覆盖 | ✅ 进（`passed/total`） | canonical 浏览器重跑，**在任何 demo Node 脚本之前**、从同一 immutable snapshot 加载 | 哨兵结论同门 |
| C 交互鲁棒 | ✅ 进（checks 列表） | 同 B（canonical 浏览器 + snapshot + 先于 demo 脚本） | |
| D 渲染绑定 | ✅ 进（computed-style 条数；未配置则降级声明） | 同 B | |
| E 像素基准 | ✅ 进（`compared/declared` + 最大 diff + WARN 的裁决人与理由） | **pr-block 亲自 spawn canonical `pixel-compare --report-out <demo 外>`**，真实解码/截图/odiff；trusted report 出块、自报只对账；**门 E 也从同一种整树 snapshot 观察（含 baseline PNG，r8 条目 A）**并做自己的双向 manifest；artifact 三图被 trusted 运行覆盖（manifest 通过后落盘），WARN 裁决必须绑定这三图的 sha256 + 本次现算的 `key`/`diffRatio`/`threshold`（r8） | 排在可信 verify **之前**（verify 末段会执行 demo 代码）；未声明 baseline 时出块写"未运行 pixel-compare"，不宣称已验 |
| F 适配还原 | ✅ 进（点数；未配置则降级声明） | 同 B | |
| X 自定义门 | ✅ 进（gate id 列表，**降准表述**） | canonical verify 亲自执行注册脚本、记真实 exit code；执行前就地算脚本 sha256 并与观察前入链的那份比对 | **只能声称「精确 hash 的注册脚本被可信 runner 执行且 exit 0」这个执行事件** —— 脚本本身是 demo 代码，不证明它实现了正确的业务 oracle（r7 条目 10）。排在 A-D/F/E 核心观察之后；执行完整组回收子进程；隔离程度见下方残余风险 |
| 资产体积闸门（非字母门） | ⚠️ 仅抬闸时进（抬闸理由 + 可信侧现算体积） | pr-block **自己**枚举 `assets/` 现算体积并与阀值比对；`report-assets.json` 自报数字仅对账 | 抬闸阀与理由是**作者的政策输入**、不是测量证据（见「资产抬闸的定性」） |
| 部署一致性（`--require-deployed`） | ❌ 不进附贴块（只作为出块前置条件） | pr-block 自己 fetch 线上字节与本地逐文件 sha256 全等比对（可信侧直接观察） | |
| 入库检查（`--require-committed`） | ❌ 不进附贴块 | pr-block 自己跑 `git ls-files` / `git status`（可信侧直接观察） | |

**原则（写死）：所有进入 PR 附贴块的字母门都必须来自 canonical 运行或等价可信复算，没有一门可以只靠 demo JSON。**

门字母 ⟷ runner 的映射是**唯一机读真相源**（`scripts/lib/gates.mjs` 的 `TRUSTED_GATES`）：
verify 的门过滤、pr-block 的投影门集合、PR 门表渲染都只遍历它，**不许再手写第二份门列表** ——
门 E 那个 CRITICAL 的根因就是两份手写清单各自漏了它（r7 条目 7a）。渲染器另加 taint 保护：
只接受 `markTrustedRun` 打过标记的结果，拿到未标记对象直接 throw（r7 条目 7b）。

### 报告型 JSON 的定位表（谁能当证据、谁只是声明）

**审核人确认：没有第四个"报告型"放行 JSON。** `package.json` 只用于模块解析根，不参与验收判定。

| JSON | 定位 | 凭什么 |
|---|---|---|
| `spec.json` | **验收声明 / 输入**，不是证据 | 它是被验对象本身：schema 校验 + 进 `inputHashes`，且 canonical 重跑读的是同一份 |
| `report.json` | **不能作放行依据**，仅对账 | 放行取 canonical verify 重跑结果；自报与可信结论投影不一致即阻断 |
| `report-pixel.json` | **不能作放行依据**，仅对账 | 放行取 canonical `pixel-compare` 重跑结果（写到 demo 之外） |
| `report-assets.json` | 测量数字**不能**作依据；抬闸理由可作**作者声明** | 体积/阀值由 pr-block 自己现算；`overrideReason` 原样印进 PR 供 reviewer 判断 |
| `component.inputs.json` | **不能单独信** | 必须 `--check-inputs` 与 esbuild 现算结果全等 + 清单内每项逐文件 hash + 产物字节复算（I-ESBUILD / I-CSS） |
| `truth.json` | **待证明的声明** | 每个叶子带 provenance + canonical verify 现跑 `extract.mjs` 比对（extractor drift） |
| `adjudications/*.json`（WARN 人工裁决） | **人工裁决声明，不是机械测量** | 必须同时声明并全等四项：`key`（含 platform 的复合 key `<platform>/<key>`）/ `diffRatio` / `threshold` / 三图 sha256（r8）；裁决人与理由印进 PR |
| `index.html` | **init 生成后可编辑的运行输入**，不是可信产物 | 不声称 adapter/chrome 段是 canonical（没有逐段字节全等校验）：只保证「相对上次 build 未被改动」（进 `inputHashes`）+ 内嵌 `qa-truth` ≡ `truth.json` + **渲染结论由 canonical 浏览器从 immutable snapshot 实测**（门 B/C/D）（r7 条目 12） |

### 资产抬闸的定性（r7 条目 11，别把它写成机械保证）

`effectiveLimitMb` / `overrideReason` 是**作者请求的显式抬闸政策输入，不是测量证据**。
pr-block 会自己现算体积并把抬闸阀与理由原样印进 PR 附贴块，但**机械重跑无法阻止作者把阀抬到
999MB** —— 若产品不希望如此，需要**外部 reviewer approval / sign-off 这一人工环节**来兜。
工具这一侧只承诺三件事：体积数字是可信侧现算的、抬闸必须署名理由、理由会出现在 PR 上。

### 门 X 的隔离与残余风险（r7 条目 10，如实标注）

已做：① 表述降准到「精确 hash 的注册脚本被可信 runner 执行且 exit 0」；② 排在 A-D/F/E
核心观察之后（与执行时序原则一致）；③ 用 `detached` 起**新进程组**跑脚本，返回后整组
`SIGKILL` 回收；④ 执行前就地算脚本 sha256，与观察前 `inputHashes.customGates` 里的那份比对
（"注册 A 脚本、跑 B 脚本"在这里落地）；⑤ 脚本字节进防伪链。

**未做（残余风险）**：没有把门 X 放进 OS 级只写隔离的沙箱。原因如实说明 —— 门 X 是 demo 自带
脚本，需要读 demo 目录与产品仓（`--demo <dir>` 就是为此传的），一刀切的 FS 隔离会让正常的
自定义门直接跑不起来；Node `vm` 不是安全边界，不拿它假装隔离。因此：脚本仍可写磁盘，但
① 它跑在所有核心观察之后，② 浏览器观察用的是 immutable snapshot，③ 它对 demo 输入的任何
改写都会被事后 `inputHashes` 复算与 snapshot 偏离比对抓出来并判门 A 红。同组子进程会被回收，
但脚本若刻意用 `detached` 再起孙进程，孙进程会拿到自己的新进程组、这一招杀不到它 ——
那条路由「核心观察全部早于执行 demo 代码」兜住。

### 产物全表（组件模式下"由外部工具生成"的产物）

判据三档：**需可信侧复算** / **hash 输入已足够**（内容被上游锚住，改它必然让某条 hash 不符）/
**不影响验收结论**。

| 产物 | 生成者 | 判定 | 依据 |
|---|---|---|---|
| `assets/component.bundle.js` | esbuild（build.mjs） | **需可信侧复算** ✅ 已做（r5） | `--check-outputs` 字节全等（r7 起与派生资产同一张映射） |
| `assets/component.css` | tailwindcss CLI（build.mjs） | **需可信侧复算** ✅ r6 补上 | `--check-css` 字节全等；未配 tailwind 时对 `CSS_PLACEHOLDER` 字节复算 |
| `assets/` 下 esbuild 派生资产（图片/字体 `[name]-[hash]`） | esbuild file loader | **需可信侧复算** ✅ r7 条目 3 补上（此前判「间接达成」是**错的**） | `--check-outputs` 逐产物路径+字节全等。r6 之前的理由「文件名含内容 hash 且被 bundle 引用」不成立：`[hash]` 是 esbuild 的内容指纹不是校验和，**同名换字节** JS 侧毫无变化，`inputHashes.assets` 又是对攻击后字节现算的 → 全链绿（审核人实测，我已复现） |
| `component.inputs.json` | build.mjs（esbuild metafile） | **需可信侧复算** ✅ 已做（r3） | `--check-inputs` 全等比对；清单自身也进 hash |
| `truth.json` | demo `extract.mjs` | **需可信侧复算** ✅ 已做 | 门 A 现跑 `extract.mjs`，结果必须 ≡ `truth.json`（extractor drift）；且每个叶子带 provenance |
| `index.html`（init 生成的组件壳 / adapter / chrome 模板产物） | `init.mjs` 模板 | **hash 输入已足够**（**不声称 canonical**） | 它是 init 生成后**可编辑的运行输入**:`--update-adapter` / `--update-chrome` 只替换标记段，仓里那份随后可被作者改动，而我们**没有做逐段字节全等校验** —— 所以只声称「进 `inputHashes['index.html']`，相对上次 build 未被改动」+ 内嵌 `qa-truth` ≡ `truth.json`（门 A）+ **渲染结论由 canonical 浏览器从 immutable snapshot 实测**（门 B/C/D），不靠模板可信（r7 条目 12） |
| `build.mjs` / `component-build-core.mjs` / `extract-helpers.mjs` / `repo-glob.mjs`（demo 侧拷贝） | init 拷贝 | **需可信侧复算**（更强：钉死） | `checkDemoBuilderIntegrity` 要求与 skill canonical 逐字节全等；且复算一律跑 skill 那份，不执行 demo 拷贝 |
| `baselines/**.png`（像素基准图） | `capture-baseline.mjs` / 人工采集 | **hash 输入已足够 + 门 E 可信重跑** | 基准图进 `inputHashes.baselines`（换图 → report 失效）；比对本身由 pr-block 重跑 pixel-compare 亲自做。**基准图的"来源真实性"（是否真是产品沙盒截图）工具无法机械证明——这一条如实降级为需人工审查** |
| `pixel-artifacts/*.png`（baseline/demo/diff 三图） | pixel-compare | **需可信侧复算** ✅ r6 起 | 被可信重跑覆盖成我们生成的那份，WARN 人工裁决判的是这份 |
| `adjudications/*.json`（WARN 人工裁决） | 人工 | **人工裁决声明，不是机械测量** | 必须同时声明并**全等**四项 `{ key, diffRatio, threshold, artifactHashes }`，缺一项即拒并点名缺哪个，任一项不等即拒并打印「裁决声明值 vs 本次现算值」。① `artifactHashes`：trusted E 产出的 baseline/demo/diff 三图 sha256（r7 条目 8 起就不再是「路径存在」算数:路径可以指向后来被换掉的图）——三层都要对上:report 记了三图 hash、磁盘现算等于它、裁决声明等于它。② `diffRatio` / `threshold`：必须等于**本次 trusted pixel 现算**的值(r8)。只绑三图挡得住「换图」，挡不住「换差异」——同一 key 上一次小幅 WARN 的裁决，在差异变大、三图跟着重跑更新之后就会被复用;**人工裁决的是当时那个具体差异，差异变大就必须重新裁决**。③ `key`：含 platform 的复合形式 `<platform>/<key>`（无 platform 的旧式条目用裸 key）——基准按 `baselines/<platform>/` 分端存放、永不互比，mac 端的裁决不得被 windows 端的 WARN 复用。校验点在 trusted `pixel-compare` 采纳处与 `report.mjs` 的 `validatePixelReport` **两侧都有**。`reviewer` / `reason` 必填并印进 PR。工具只保证「它判的是可信侧生成的那三张图、那个具体差异」，保证不了「判断本身对」 |
| `report.json` | verify | **不作为放行依据** | pr-block 重跑 canonical verify，自报仅对账（r5） |
| `report-pixel.json` | pixel-compare | **不作为放行依据** | pr-block 重跑 canonical pixel-compare，自报仅对账（r6） |
| `report-assets.json` | assets-manifest | **不作为放行依据** | 体积/阀值由 pr-block 自己重算，自报仅对账（r5 #5c） |
| `verify-artifacts/*.png`（失败截图） | verify | **不影响验收结论** | 只为人读复现，不进任何判定 |

**pr-block 直接读 demo 目录文件的位置（逐个核过，无第四第五处放行依据）**：

> r7 条目 9 起 pr-block **在出块阶段不再读取任何 demo 侧可变文件** —— 渲染所需的一切都来自
> 打过 taint 标记的 canonical 产出（见上表「报告型 JSON 的定位表」与 `scripts/lib/pr-render.mjs`）。

| 位置 | 读什么 | 是放行依据还是仅对账 |
|---|---|---|
| `pr-block.mjs` 读 `spec.json` | 声明输入 | **放行依据**（但它是被验对象本身：schema 校验 + 进 `inputHashes`，且可信重跑读的是同一份） |
| 读 `report.json` | 作者自报的 A-F/X 结论 | **仅对账**（结论取可信重跑） |
| 经 `validatePixelForPr` 读 `report-pixel.json` | 作者自报的门 E 结论 | **仅对账**（结论取可信重跑） |
| 读 `report-assets.json` | 作者自报的体积数字 | **仅对账**（阀值与体积由 pr-block 自己从 `assets/` 重算） |
| 读 `index.html` + `assets/**` 字节 | `--require-deployed` 的本地侧 | 比对对象本身（拿它与线上字节比） |
| ~~读 `truth.json`（`countFixtureLeaves`）~~ | —— | **r7 条目 9 起 pr-block 不再读它**:在流程末尾重读可变文件属 TOCTOU 变体(demo 代码可能已在中途改过它)。fixture 叶子计数改由 canonical verify 在**观察前**统计进 `report.truthStats`，渲染器取可信 payload |
| `component.inputs.json` | —— | pr-block **不直接读**；由 verify / `report.mjs` 经复算与逐文件 hash 处理 |

> **Tailwind content 入链集（r7 条目 2：从 glob 降级为显式文件列表）**：`component.css.content`
> 只接受**显式的仓内相对普通文件路径**，构建与可信侧复算都把它转成**绝对路径**传给
> Tailwind `--content`。此时不变式 **`S ⊆ E = L`**（实扫集 ⊆ 期望集 = 入链集）由**参数结构**
> 保证，不再依赖任何展开语义的猜测：绝对文件路径在 Tailwind 的 `parseCandidateFiles` 里
> `glob === null`，扫描集就是那些文件本身；`config.content` 与 `config.content.relative` 在
> CLI override 之后都不再决定集合。r6 遗留的三条局限**因此消失**：① `content.relative` 不必
> 再靠静态文本扫描推断；② 不再需要与 Tailwind 内部 fast-glob 同源（我们压根不展开）；
> ③ `node_modules` 非对称扫描没有了发生条件（显式路径默认拒依赖目录，且不递归任何目录）。
> **仍在的一条**：tailwind config `require` 的 presets/plugins 不做递归入链追踪 —— 它由
> `--check-css` 的 CSS 字节复算兜住（改 plugin → 重编字节不等于磁盘字节 → 门 A 红），
> 已有实跑回归。CSS 字节复算仍是**最终锚**。
> 版本联动：`tailwindcss` / `fast-glob` / `micromatch` 的版本钉在
> `scripts/__tests__/fixtures/r7-content-engine-versions.json`，变了就让集成测试红，
> 强制重跑「实扫集 === resolved list」的交叉验证（私有 API 不可加载即 fail-closed，
> **不许 fallback 回自研 glob**）。

**失败取证**：任一动态门失败自动截图到 `verify-artifacts/`，failure 条目带 `screenshot`
字段——不用再开 `--headed` 人肉复现失败现场。`verify-artifacts/` 是生成产物，不入库。

> **playwright 依赖解析(r5 收紧)**:verify/pixel 需要 playwright。解析候选**只含不受 demo 目录
> 内容左右的根**:`QA_HIFI_MODULE_ROOT` → `PLAYWRIGHT_MODULE_ROOT` → demo 所在产品仓根
> (`git rev-parse --show-toplevel`,且必须是 demo 目录的严格祖先) → skill 自身位置,
> 外加这些根的 package root 与宿主 `projects/*` package root;Chromium 用本机缓存/系统 Chrome。
> **不再有 `cwd` / `INIT_CWD` / demo 目录**——它们曾让 `<demo>/node_modules/playwright/index.js`
> 的顶层代码在 `import` 时于 verify 进程内执行(RCE),而且 demo 目录还排在候选第一位、优先于
> 机器上真实的 Playwright。另有两道兜底:解析结果落在 demo 子树里一律拒收;且**任何 demo
> (不限组件模式)只要目录及任意子目录存在 `node_modules`,verify / pr-block 在解析依赖、
> 启动浏览器、执行任何 demo 侧代码之前就无条件 fail-fast 退出**(不是标红后继续)。
> 宿主仓没装时打印一串 attempts + 安装提示;可用 `QA_HIFI_MODULE_ROOT=<装了 playwright 的目录>`
> 显式指定。无 playwright 时门 B/C/D/F 跑不了,门 A 仍可跑。
>
> **大矩阵必须配 `verify.cases` 收敛**:门 B/C 对每个 `case × state` 都 freshLoad(两次页面加载),
> 全 matrix 笛卡尔积(如 3×2×2×4=48 组 × N 状态)会慢到不可用。真实 demo 用 `spec.verify.cases`
> 声明一组有代表性组合(pairwise / 关键端×暗色×长文案),不要默认全展开。
>
> **`verify.cases[].via` 不许写空数组**(schema 直接拒)。三种语义各有写法,别混：
> · 省略 `via` → applyCase 走**默认偏好点击**(按 `data-qa-pref` 之类入口逐个点到位),
>   demo 有偏好控件时用这个；
> · `via: [{ expect: '<初始状态 id>' }]` → 声明「demo 初始就在该 case 的偏好上,无需导航」,
>   并顺手断言确实如此；
> · `via: [ …真实交互步骤… ]` → 自定义到达链路。
> 空数组同时可以解释成「不需要导航」和「忘填了」,两者不可分辨——用上面第二种写法把意图写明。

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
  mask 只可跳过小面积动态区，超面积、缺图、尺寸错、ERROR/MISSING 都阻断；WARN 必须有人工裁决 artifact 才允许 PR 附贴，且该裁决必须绑定本次的 `key`/`diffRatio`/`threshold`/三图 sha256（旧裁决不得复用到变大的差异上）。
  无基准时如实标注「像素级未比对」。
  **比对内核（gate-e-v2）**：优先 **odiff**（`odiff-bin`，`antialiasing:true` 忽略抗锯齿像素、
  mask 映射 `ignoreRegions`），odiff 不可用时回退 pixelmatch（行为不变并记录 `engineNote`）；
  `QA_HIFI_COMPARE_ENGINE=odiff|pixelmatch` 可点名（A/B 对比/排障用，点名 odiff 失败直接报错不静默降级）。
  mask 面积上限 / `minUnmaskedRatio` 护栏在本仓这层，不交给引擎。
  **mask 声明规范（组件模式）**：只有两类区域允许 mask——① **stub 区**：demo 用占位件替代的
  非产品渲染物（如 `WindowControls` 原生红绿灯按钮，真沙盒里由 OS/Electron 画，demo 画不出来）；
  ② **动态区**：每次渲染必然不同的内容（时钟、倒计时、随机头像）。其余任何 diff 都是真差异，
  必须改 demo，不许用 mask 盖住。坐标系 = `[x, y, w, h]`，相对截图元素（`frameSel`，缺省 `.frame`）
  左上角的 **CSS 像素**（DPR 由 `baselineDpr` 统一换算，写 mask 时不要自己乘 DPR）。
  **位置必须从 truth 几何推导，不许看 diff 热图目测框选**：stub 区的槽位（标题栏高度、控件组宽度、
  左右内缩）由 `extract.mjs` 从产品源码常量提取进 `truth.geometry.*`，mask 矩形取那些叶子的值
  （允许 ±2px 边缘容差）；review 时按「每条 mask 能在 truth.geometry 里指到对应叶子」核对，
  指不到 = 目测的 = 打回。面积护栏不变（`maxMaskRatio` 缺省 0.25、`minUnmaskedRatio` 缺省 0.5，
  组件模式建议按 stub 区实际面积把 `maxMaskRatio` 收得更紧），mask 越界/零面积仍按现有规则报错。
  **分端基准（gate-e-v2）**：`baselines[].platform` 声明 `web|electron-mac|electron-win|ios|android` 后，
  基准落 `baselines/<platform>/<key>.png`（未声明保持旧平铺）；**不同 platform 的基准永不互比**，
  各自只与 demo 渲染帧比——跨渲染引擎像素直比不可行（字体/取整/阴影算法差异），跨端一致性走
  门 D 绑定与真值断言，不走像素。分端条目的 artifact/裁决**文件名**按 `<platform>.<key>` 命名（如 `adjudications/web.one.json`），而裁决文件**内部** `key` 字段写复合 key `<platform>/<key>`（如 `web/one`，与 report 校验用的复合 key 同构）——文件名不能带 `/`，但字段必须能唯一定位「哪个 platform 的哪个 baseline」。
  **采集用 `scripts/capture-baseline.mjs`**：`--url <dev实例>` 直接截真沙盒帧元素（DPR 与
  pixel-compare 同口径），`--electron-app <main入口或app目录>` 起真实 Electron 壳截首窗口
  （桌面端真渲染，mac/win 各存各的基准），或 `--from-png <截图>` 导入真机截图（先渲染 demo 量帧尺寸，
  尺寸不符拒收，防「随手一张图」冒充基准）。key 必须先在 spec.baselines 声明；
  同 key 声明了多个 platform 时必须加 `--platform <端>` 指定（fail-closed，防截图静默写错端目录），
  `--electron-app` 还会校验端与宿主一致（mac 上采 `electron-win` 直接拒绝）。
  **移动端采集用 `scripts/capture-mobile.mjs`**：maestro/simctl/adb 截图 → OS chrome 裁切
  （`--crop`/`--crop-top`）→ DPR 归一化（`--device-dpr`，Chromium canvas 重采样）→ 与 --from-png
  同口径尺寸校验 → 落分端目录；驱动链路模板见 `templates/maestro-flow.yaml`（testID 定位 +
  到达断言 + 动画稳定后截图）。
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
4. **资产清单 + 体积闸门（demo 有 `assets/` 时是硬门，不是可选步骤）**：
   `node scripts/assets-manifest.mjs --demo <dir> [--max-total <MB> --override-reason "<理由>"]`——
   图片 / 组件 bundle 一律落 demo 的 `assets/` 独立文件、HTML 用相对路径引用（不全内联：
   实测 hero 图内联能把单文件顶到 10MB 量级，首屏卡、GitHub 预览打不开、PR diff 不可读）。
   assets/ 总体积超生效阀 exit 2。这些文件逐个 sha 进 `inputHashes.assets` 防伪链，
   换了图不重跑 verify → report 失效；`pr-block --require-deployed` 也会逐个比对线上资产字节。

   闸门产物固定落盘 `report-assets.json`（`toolVersion` / `inputHashes.assets` /
   `defaultLimitMb` / `effectiveLimitMb` / `overrideReason` / `ok`），**`pr-block` 强制**：
   demo 有 `assets/` 就必须有这份报告、其 assets hash 与当前 `assets/` 一致、且 `ok: true`。
   三者任一不满足即 exit 2——否则本闸门是一条谁都能整段跳过的"自愿门"（跑没跑过、抬没抬闸，
   定稿时完全查不到）。

   **`pr-block` 不信报告自报的数字**：`hash + ok:true` 都写在同一份可手写的 JSON 里，
   一份 `{ ok:true, totalBytes:0, inputHashes:<真 hash> }` 就能把 9MB 资产送过闸。所以
   `pr-block` 自己从 `assets/` 重算总体积，再逐条校验：`defaultLimitMb` ≡ 本工具写死的 8、
   `effectiveLimitMb` 是有限正数、自报 `totalBytes` ≡ 现算值、现算值 ≤ 生效阀、
   「生效阀 > 默认阀」⟺「`overrideReason` 非空」（双向）。任一不成立即 exit 2。

   **抬闸必须留痕**：`--max-total` 高于默认 8MB 时必须同时给非空 `--override-reason "<为什么
   这个 demo 必须更大>"`，否则参数直接被拒。理由进报告并原样印在 PR 附贴块上：
   `⚠️ 资产 X MB 超默认闸门 8 MB（本次生效阀 Y MB），抬闸理由：…`。收紧到默认阀以下不需要理由
   （收紧永远安全），因此也不接受"不抬闸却给理由"——免得"理由"变成随手贴的装饰；
5. demo 入库（`docs/design-previews/<feature>/`）并 commit + **xd-pages 已部署最新版**，然后
   `node scripts/pr-block.mjs --demo <dir> --require-committed --require-deployed --url <部署地址> [--preview ...]`
   产出附贴块——`--require-deployed` 会拉取部署地址逐字节比对本地 index.html（带 cache-bust），
   没部署 / 部署的是旧版 / 地址不可达都 exit 2。**部署不是可选步骤，是定稿门的一部分。**

五步全绿 → commit 已就绪，PR 提交只差用户一句授权（push/提 PR 仍按仓库规矩经用户确认）。

**「demo 每次都被带进 PR」的三层保证**：
- **带入**：demo 是分支上的入库文件，git 自动把它带进 PR diff——入库即带入，零机制成本；
- **本地硬门**：第 5 步必须用 `--require-committed`——它校验 spec/extract/truth/index 四件套
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
- `baselines`：门 E 声明——`[{ key, platform?, via?, frameSel?, mask?, maxMaskRatio?, minUnmaskedRatio? }]`
  + `baselineFrameSel?` / `baselineThreshold?` / `baselineDpr?` / `pixelmatchThreshold?`；
  `platform` 枚举（gate-e-v2）：`web` / `electron-mac` / `electron-win` / `ios` / `android`——声明后基准图放
  `baselines/<platform>/<key>.png`，未声明放旧式 `baselines/<key>.png`（真沙盒截图，声明了就必须存在；
  不同 platform 基准永不互比）。热图输出到 `pixel-artifacts/`（分端条目按 `<platform>.<key>` 命名）。
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
