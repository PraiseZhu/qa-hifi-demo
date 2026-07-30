# spec.json 字段规范

demo 目录的宪法文件。全部字段如下（`?` = 可选）：

```jsonc
{
  "meta": {
    "name": "cindy-login-consent-hifi",     // = xd-pages 部署名
    "pr": 331,                              // 关联 PR 号(头部徽标 + pr-block 用)
    "basePr": 322,                          // ? 基于哪个已合 PR
    "summary": {                            // 三段说明,各 ≤2 行,工具区展示
      "what": "登录页协议同意链路全端落地",
      "how": "手机号/邮箱/社交提交前过协议门,SSO 豁免;四语双区双主题",
      "accept": "A-F 门自动验收:truth provenance/状态覆盖/交互鲁棒/渲染绑定/像素基准/适配还原"
    }
  },

  "matrix": {                               // 工具区切换器 + 验收抽查的组合空间
    "platforms": ["desk", "phone", "pad"],
    "regions":   ["cn", "global"],
    "systems":   ["ios", "android"],
    "themes":    ["light", "dark"],
    "langs":     ["zh-CN", "en", "ja", "ko"]
  },

  "states": [
    // 能通过交互链路表达的状态:via = 步骤数组,最后一步必须 expect 断言落点
    { "id": "id",             "via": [{ "expect": "id" }] },                    // 初始态
    { "id": "verify.counting","via": [
        { "type": { "sel": "#phone", "text": "13800000000" } },
        { "click": "#cta" },
        { "click": "#consent-agree" },
        { "expect": "verify.counting" }
    ]},
    { "id": "main",           "via": [ /* ...走到进入正式主界面为止 */ { "expect": "main" } ] },

    // 链路难触达的状态:via=null + tab + note(理由必填,states.mjs 强制)
    { "id": "verify.expired", "via": null, "tab": "状态补齐",
      "note": "需等 42s 倒计时归零后再等验证码过期,链路等待过长" },
    { "id": "browser.denied", "via": null, "tab": "状态补齐",
      "note": "浏览器授权被拒回调,真实场景由外部浏览器触发" }
  ],

  "verify": {                               // 门 B/C 配置
    "cases": [                              // ? 优先于 matrix 全组合；每个 case 必须实际执行并断言 prefs
      { "id": "phone-cn-ios-dark-zh", "prefs": {
        "plat": "phone", "region": "cn", "os": "ios", "mode": "dark", "lang": "zh-CN"
      }}
    ],
    "noClip": [".panel .title", ".panel .subtitle", ".consent"],   // 文案零截断扫描
    "inputs": [                             // 输入稳定性(跨 tick 节点不换/焦点不丢/值完整)
      { "via": [ { "click": "#cta" } ], "sel": "#code", "text": "123456", "tickMs": 1000,
        "tickWitness": "#resend-countdown" }
    ],
    "persistence": {                        // 偏好持久化(reload 恢复)
      "via": [ { "click": "[data-seg=phone]" }, { "click": "[data-seg=dark]" } ],
      "expected": { "plat": "phone", "region": "cn", "os": "ios", "mode": "dark", "lang": "zh-CN" },
      "storageKey": "qa-hifi:cindy-login-consent-hifi:prefs",
      "reloads": 2,
      "initialState": "id"
    }
  },

  "bindings": [                             // 门 D:computed style ≡ 真值(渲染层保证)
    // kind 缺省推断:prop 含 "color" → color(浏览器解析器双侧归一化),否则 length(px)
    { "sel": ".panel",  "prop": "background-color", "truth": "colors.light.panelBg", "kind": "color" },
    { "sel": ".dlg",    "prop": "border-radius",    "truth": "geometry.dialog.radius",        "kind": "length", "scaled": true },
    { "sel": ".ring",   "prop": "border-width",     "truth": "geometry.radio.ringStroke",     "kind": "length", "scaled": true },
    { "sel": ".title",  "prop": "font-size",        "truth": "typography.panelTitle.size",    "kind": "length", "scaled": true },
    { "sel": "#phone",  "prop": "color",            "pseudo": "::placeholder",
      "truth": "colors.light.placeholder", "kind": "color" },
    { "sel": ".logo",   "prop": "src",              "truth": "assets.logo.sha256", "kind": "asset-sha" },
    // 暗色态:先用 via 切主题再核对
    { "sel": ".panel",  "prop": "background-color", "truth": "colors.dark.panelBg", "via": [ { "click": "[data-seg=dark]" } ] }
  ],

  "baselines": [                            // 门 E:真沙盒截图抽查(声明即必须存在；WARN 需人工裁决)
    { "key": "desk-zh-light-id", "via": [ { "expect": "id" } ] },
    { "key": "phone-ko-dark-id", "via": [ { "click": "[data-seg=phone]" }, { "click": "[data-seg=dark]" }, { "click": "[data-seg=ko]" }, { "expect": "id" } ],
      "mask": [[300, 480, 80, 20]] }        // 动态区(倒计时数字等)按 CSS 像素跳过
    // 分端(gate-e-v2):加 "platform" 后基准落 baselines/<platform>/<key>.png,未声明落旧平铺;
    // 不同 platform 基准永不互比;同一 key 可跨端各声明一条(唯一性按 platform+key)
    // { "key": "login", "platform": "electron-mac", "frameSel": ".frame" }
    // { "key": "login", "platform": "ios", "frameSel": ".frame", "mask": [[0, 0, 390, 24]] }
  ],
  "baselineFrameSel": ".frame",             // ? 截图元素,缺省 .frame
  "baselineThreshold": 0.005,               // ? diff 像素占比阈值,缺省 0.5%
  "baselineDpr": 2,                          // ? screenshot DPR,支持 1 或 2
  "maxMaskRatio": 0.25,                      // ? mask 面积上限,超出即 FAIL
  "minUnmaskedRatio": 0.5,                   // ? 最小未遮罩比例,低于即 FAIL

  "adaptive": {                             // 门 F:拉伸适配还原(oracle = 产品布局公式)
    "min": { "w": 960, "h": 640 },          // 沙盒最小窗口宽高(extract 从产品常量提取)
    "sampleSizes": [                        // 采样点:min、断点锚点、断点±1、中间插值点
      [960, 640], [1280, 667], [1280, 812], [1280, 811], [1440, 900]
    ],
    "probes": [                             // 门 F 要量几何的关键元素
      { "id": "slogan", "sel": ".slogan" },
      { "id": "panel",  "sel": ".panel" },
      { "id": "consent","sel": ".consent" }
    ],
    "tolerancePx": 1
  }
}
```

> `adaptive` 的期望几何表由 extract.mjs 生成:读 `sampleSizes`,对每个尺寸调**产品源码的布局
> 函数**(TS 纯函数用宿主仓 esbuild 临时编译后 import,或等价方式)算出各探针的 {x,y,w,h},
> 写进 `truth.adaptive.samples`。验收(verify.mjs 门 F)只做「resize → 量 → 比对」,不重写公式。
> demo 侧要求:帧带右缘/下缘/右下角拖拽手柄(与 `__qa.resize` 同一代码路径,clamp 到 min),
> 角落常显 W×H + 当前档位。

## 约束回顾

- `states` 每项:`via` 与 `tab` **二选一**;进 tab 必须写 `note` 理由(`states.mjs` 静态拦截)。`via:null` 状态必须通过 demo 的真实状态补齐 tab DOM 入口点击到达。
- `via` 步骤语法:`{click}` / `{type:{sel,text,delayMs?}}` / `{waitMs}` / `{expect}`,每步恰一种；状态 via 最后一步必须是 `{expect:"<state-id>"}`。
- `expect` 指向的 state id 必须已声明。
- `verify.noClip` 至少配一项,否则门 C 记 FAIL(防"忘了配就当全过")。
- `truth.json` 顶层必须是 plain object；每个叶子必须包装为 `{ "value": ..., "provenance": { "source": "...", "locator": "...", "hash": "sha256..." } }`。
- `verify.persistence` 必须写 `expected`、`storageKey`、`reloads>=1`；不能只让 demo 的 `__qa.prefs()` 自证。
- `verify.inputs` 必须写非空 `text`、正数 `tickMs` 与 `tickWitness`；验收会等 witness 真实变化后再断言输入框 DOM 节点未被替换。
- `bindings.kind` 只允许 `color` / `length` / `text` / `asset-sha`；`pseudo` 只允许 `::before` / `::after` / `::placeholder`。
- `baselines` 声明的每个 key 必须有对应基准图（声明 `platform` → `baselines/<platform>/<key>.png`，未声明 → `baselines/<key>.png`）；mask 超面积、未遮罩区域过少、WARN 无人工裁决都阻断 PR 附贴。分端条目的裁决文件按 `<platform>.<key>` 命名（`adjudications/<platform>.<key>.json`）。
- 规范化只排序 object key；语义为集合的数组必须由 `extract.mjs` 按稳定 key 排序后输出。

## customGates（门 X,2026-07-30 起）

```jsonc
"customGates": [
  { "id": "overlap-gate", "script": "overlap-gate.mjs", "description": "元素重叠检测", "timeoutMs": 120000 }
]
```

- `id`:slug(小写字母/数字/连字符),同 spec 内唯一;
- `script`:demo 目录内相对路径(禁 `..`/绝对路径);verify 以 `node <script> --demo <dir>` 执行,exit 0 = PASS;
- 脚本 hash 计入 inputHashes——verify 后改脚本,pr-block 因 hash 不一致拒绝出块。

## verify.cases[].viewport(per-case 视口,2026-07-30 起)

```jsonc
{ "id": "mobile-cn-dark", "prefs": { ... }, "viewport": { "w": 390, "h": 844, "dpr": 3 } }
```

- 移动端 case 必须声明移动端视口,verify 为该 case 换用对应尺寸/DPR 的页面;
- 不声明 = 1440×960 桌面视口(mobile 的截断/溢出/适配结论在桌面视口下不成立)。
