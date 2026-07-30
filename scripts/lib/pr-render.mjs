// pr-render.mjs — PR 附贴块的**唯一**渲染器(r7 条目 7)。
//
// 设计约束(比"记得取可信值"更强的结构约束):
//   1. 本模块**只接受打过 markTrustedRun 标记的结果**。demo 目录里的 report*.json 是
//      JSON.parse 出来的普通对象,永远进不来 —— 「忘了走可信侧」在这里直接 throw,
//      而不是静默渲出一份看起来很正常的 PR 块。
//   2. 门行渲染**遍历 TRUSTED_GATES**(唯一真相源),不许再手写第二份门列表 ——
//      门 E 那个 CRITICAL 的根因就是两份手写清单各自漏了它。
//   3. 本模块**不接收也不读取** demo 自报的 report(签名里根本没有那个参数),
//      所以"这一格数字来自可信侧还是自报"不靠人记,靠参数结构。
//   4. 政策输入(资产抬闸理由)与测量证据**分开传**、分开标注 —— 它是作者声明,不是测量。

import { TRUSTED_GATES, GATE_LETTERS, gateKey, requireTrusted } from './gates.mjs';

/** 每个门字母怎么渲染成一行。返回 null = 该门不出行(如非组件模式下无关的门)。 */
const GATE_ROWS = {
  A: (v) => `| 真值一致（数据层:truth 提取自源码,每个叶子带 provenance；渲染层由门 D 保证） | ✅ |`,
  B: (v) => `| 状态覆盖（实际执行 ${v.gateB.passed}/${v.gateB.total}） | ✅ |`,
  C: (v) => `| 交互鲁棒（${v.gateC.checks.map((c) => c.id).join(' / ')}） | ✅ |`,
  D: (v) => (v.gateD.total > 0
    ? `| 渲染绑定（${v.gateD.total} 条 computed-style ≡ truth） | ✅ |`
    : '| 渲染绑定 | ⚠️ 未配置 bindings，还原承诺仅到数据层 |'),
  F: (v) => (v.gateF.total > 0
    ? `| 适配还原（${v.gateF.total} 点） | ✅ |`
    : '| 适配还原（窗口拉伸行为） | ⚠️ 未配置 adaptive，拉伸未验证 |'),
  /* 门 X 的降准表述(r7 条目 10,审核人裁定):canonical verify 亲自执行注册脚本并记真实
     exit code,但**脚本本身是 demo 代码** —— 可信的只有「精确 hash 的注册脚本由可信 runner
     执行并 exit 0」这个**执行事件**,不证明脚本实现了正确的业务 oracle。文案不许暗示后者。 */
  X: (v) => (v.gateX?.total > 0
    ? `| 自定义门（${v.gateX.gates.map((g) => g.id).join(' / ')}） | ✅ 已由可信 runner 执行且 exit 0`
      + '（注册脚本 hash 入链；脚本本身是 demo 代码，其业务判断是否正确需人工审查） |'
    : null),
  E: (v, px) => {
    if (!px) return '| 像素基准（vs 真沙盒截图） | ⚠️ 未运行 pixel-compare |';
    if (px.skipped) return '| 像素基准（vs 真沙盒截图） | ⚠️ 未采基准，像素级未比对 |';
    const worst = Math.max(...px.results.map((r) => r.diffRatio ?? 1));
    const warns = px.results.filter((r) => r.status === 'WARN');
    /* r7 条目 8:WARN 的裁决人与理由必须在 PR 里可见 —— 裁决是**人工声明、不是机械测量**,
       reviewer 得能看见"是谁、以什么理由放过了这处像素差异"才能判断接不接受。 */
    const warnNote = warns.length
      ? `⚠️ WARN 已附人工裁决（绑定可信侧三图 sha256；属人工声明非机械测量）：`
        + warns.map((r) => `${r.key} 由 ${r.adjudication?.reviewer ?? '(未署名)'} 裁决 —— ${r.adjudication?.reason ?? '(无理由)'}`).join('；')
      : '✅';
    return `| 像素基准（${px.compared}/${px.declared} 组合，最大 diff ${(worst * 100).toFixed(2)}%） | ${warnNote} |`;
  },
};

/**
 * 渲染 PR 附贴块。
 * @param {object}   o
 * @param {object}   o.spec            验收声明(输入,不是证据)
 * @param {object}   o.trustedVerify   markTrustedRun('verify', …) 的盒子 —— 门 A/B/C/D/F/X 唯一来源
 * @param {object?}  o.trustedPixel    markTrustedRun('pixel', …) 的盒子 —— 门 E 唯一来源;null = 未跑
 * @param {object?}  o.trustedAssets   markTrustedRun('assets-recompute', …) 的盒子 —— 体积现算结果
 * @param {object?}  o.assetsPolicy    作者的抬闸**政策输入**(overrideReason 等),不是测量证据
 * @param {string?}  o.url             部署地址
 * @param {string?}  o.preview         .html 预览链接
 * @returns {string} markdown
 */
export function renderPrBlock({ spec, trustedVerify, trustedPixel = null, trustedAssets = null, assetsPolicy = null, url = null, preview = null }) {
  // taint 闸门:两个门结论来源都必须是 canonical runner 的产出
  const v = requireTrusted(trustedVerify, 'verify', 'verify 门结论');
  const px = trustedPixel === null ? null : requireTrusted(trustedPixel, 'pixel', '门 E 结论');
  const assets = trustedAssets === null ? null : requireTrusted(trustedAssets, 'assets-recompute', '资产体积现算结果');

  const meta = spec.meta ?? {};
  const cases = v.coverage?.cases ?? [];
  const lines = [];
  lines.push('### 可交互 QA demo（代替沙盒试用）');
  lines.push('');
  if (preview) lines.push(`**UI 证据（HTML 界面）**：[demo 页面预览](${preview})`);
  // URL 与后缀标注之间必须隔断:全角括号紧贴 URL 会被 GitHub autolink 吞进 href
  // 导致链接 404(2026-07-25 实踩)。用 <> 显式划定链接边界。
  if (url) lines.push(`**体验地址**：<${url}>（内网）`);
  lines.push('');
  if (meta.summary) {
    lines.push(`- **做了什么**：${meta.summary.what}`);
    lines.push(`- **怎么做的**：${meta.summary.how}`);
    lines.push(`- **怎么验收**：${meta.summary.accept}`);
    lines.push('');
  }
  lines.push(`**实际执行矩阵**：${cases.map((c) => `${c.id} ${JSON.stringify(c.prefs)}`).join('；')}`);
  lines.push('');
  lines.push('| 验收门 | 结论 |');
  lines.push('|---|---|');

  /* 门行只按 TRUSTED_GATES 遍历(条目 7a)。渲染顺序固定为 A→F(人读习惯),
     但**集合**取自映射:漏一个门字母在这里就会漏一行,而下面那句断言会立刻发现。 */
  const ORDER = ['A', 'B', 'C', 'D', 'F', 'X', 'E'];
  const missing = GATE_LETTERS.filter((l) => !ORDER.includes(l));
  if (missing.length)
    throw new Error(`PR 门表渲染漏了门 ${missing.join(',')}——TRUSTED_GATES 加了新门字母就必须同步这里(r7 条目 7a)`);
  for (const letter of ORDER) {
    const runner = TRUSTED_GATES[letter];
    if (!runner) throw new Error(`门 ${letter} 不在 TRUSTED_GATES 里`);
    // 数据对象只可能是 v(verify 可信产出)或 px(pixel 可信产出),按映射取
    const source = runner === 'verify' ? v : px;
    if (runner === 'verify' && !source[gateKey(letter)] && letter !== 'X')
      throw new Error(`可信 verify 产出里缺 ${gateKey(letter)}——不许拿缺字段的结果出块`);
    const row = GATE_ROWS[letter](v, px);
    if (row) lines.push(row);
    // 组件模式的「真组件直渲 / 已打包」行紧跟在门 D 之后(它的证据在 gateB.entryRenderProof)
    if (letter === 'D' && spec.component?.mode === 'component') {
      const srcCount = Object.keys(v.inputHashes?.componentSources?.sources ?? {}).length;
      if (v.gateB?.entryRenderProof === 'proved')
        lines.push(`| 真组件直渲（${srcCount} 个源文件 hash 入链，运行期哨兵实测声明的目标组件导出被渲染） | ✅ |`);
      else
        lines.push(
          `| 产品模块已打包（${srcCount} 个源文件 hash 入链） | ⚠️ 运行期哨兵未证明「声明的目标组件导出被渲染」`
          + '（未声明 component.export／目标导出形态不可探测／仅非目标导出被调用），是否为 UI 组件需人工审查 |',
        );
    }
  }
  lines.push('');

  /* 诚实降级声明:服务端驱动的值(providers 配置等)源码里没有字面量,只能录 fixture。
     r7 条目 9:计数取**可信 verify 在观察前统计出来的那份**,不在流程末尾重读 demo 的
     truth.json —— 那是 TOCTOU 变体(demo 代码可能已在中途改过它)。 */
  const fixtureLeaves = Number(v.truthStats?.fixtureLeaves ?? 0);
  if (fixtureLeaves > 0) {
    lines.push(`⚠️ ${fixtureLeaves} 个叶子来自录制 fixture（非源码溯源），来源见 truth provenance`);
    lines.push('');
  }

  /* 资产抬闸声明(r7 条目 11):体积数字取**可信侧现算**,抬闸阀与理由是**作者的政策输入**
     —— 机械重跑拦不住作者把阀抬到 999MB,所以这一行只做"让 reviewer 看见并决定"。 */
  if (assetsPolicy?.overrideReason) {
    const mb = (n) => (Number(n) / 1024 / 1024).toFixed(2);
    lines.push(
      `⚠️ 资产 ${mb(assets?.totalBytes ?? 0)} MB（可信侧现算）超默认闸门 ${assetsPolicy.defaultLimitMb} MB`
      + `（作者声明本次生效阀 ${assetsPolicy.effectiveLimitMb} MB），抬闸理由：${assetsPolicy.overrideReason}`
      + '　—— 抬闸是**作者的政策请求**，不是测量证据；是否接受请 reviewer 判断',
    );
    lines.push('');
  }
  lines.push(`<sub>由 qa-hifi-demo 生成 · 工具版本 ${v.toolVersion} · 验收时间 ${v.generatedAt}</sub>`);
  return lines.join('\n');
}
