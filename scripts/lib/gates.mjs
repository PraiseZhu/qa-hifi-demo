// gates.mjs — 门字母 ⟷ canonical runner 的**唯一机读映射** + 可信运行标记(r7 条目 7)。
//
// 为什么必须有这一层:门 E 那个 CRITICAL(r6 条目 2)的根因不是判断写错了,而是**门列表被手写
// 了两份** —— verify.mjs 里的 `GATE_LETTERS = ['A','B','C','D','F','X']` 与 pr-block 里投影
// 比对的 `['gateA','gateB','gateC','gateD','gateF','gateX']`。门 E 住在 pixel-compare.mjs,
// 两份手写清单都"自然地"没有它,于是可信侧重跑漏掉整整一门,而两边看起来都自洽。
// 只要还允许第二份手写门列表存在,这类漏门就会再发生。
//
// 所以:
//   * TRUSTED_GATES 是唯一真相源。verify 的门过滤、pr-block 的投影门集合、PR 附贴块的门表
//     渲染,**只能遍历它**,不许再手写第二份门列表(源码契约测试会拦)。
//   * 新增门字母时,TRUSTED_GATES / verify 的实现 / SKILL.md 门级全表 四者必须同步,
//     否则「四者集合全等」那条测试直接红。
//
// taint-style 保护(条目 7b):canonical runner 产出的结果被 markTrustedRun 打上**不可伪造的
// 内存标记**(WeakSet,不落盘、不进 JSON、跨进程不可携带);PR 渲染器只接受打过标记的结果,
// 拿到未标记的 report 立刻 throw。这样「忘了走可信侧、直接用 demo 自报数字出块」会在运行时
// 炸掉,而不是静默出一份看起来很正常的 PR 块。

/** 门字母 → 负责它的 canonical runner。唯一真相源,勿在别处重复定义门列表。 */
export const TRUSTED_GATES = Object.freeze({
  A: 'verify',
  B: 'verify',
  C: 'verify',
  D: 'verify',
  E: 'pixel',
  F: 'verify',
  X: 'verify',
});

/** 合法的 runner 名(canonical 可执行体)。 */
export const RUNNERS = Object.freeze(['verify', 'pixel', 'assets-recompute']);

/** 全部门字母(排序稳定)。 */
export const GATE_LETTERS = Object.freeze(Object.keys(TRUSTED_GATES).sort());

/** 某个 runner 负责的门字母。verify 的 `--gate` 过滤集合就取这一份。 */
export function lettersFor(runner) {
  return GATE_LETTERS.filter((letter) => TRUSTED_GATES[letter] === runner);
}

/** report 里的门字段名(gateA/gateB/…),同样只从映射派生。 */
export const gateKey = (letter) => `gate${letter}`;

/* ── 可信运行标记 ──
   WeakSet 里的成员身份无法被伪造:JSON.parse 出来的对象永远不在里面,
   而 markTrustedRun 只在 canonical runner 真的被本进程 spawn 并成功返回后才被调用。 */
const TRUSTED_BOXES = new WeakSet();
const BOX_RUNNER = new WeakMap();

/**
 * 给 canonical runner 的产出打可信标记。
 * @param {string} runner  RUNNERS 之一
 * @param {object} payload runner 的结果(report JSON / 现算结果对象)
 * @returns {{runner: string, payload: object}} 已打标记的盒子(只有它能进渲染器)
 */
export function markTrustedRun(runner, payload) {
  if (!RUNNERS.includes(runner)) throw new Error(`未知 runner:${runner}(合法:${RUNNERS.join('/')})`);
  if (!payload || typeof payload !== 'object') throw new Error(`runner ${runner} 的 payload 必须是对象`);
  const box = { runner, payload };
  TRUSTED_BOXES.add(box);
  BOX_RUNNER.set(box, runner);
  return box;
}

/** 是否是本进程内由 canonical runner 产出的结果。 */
export function isTrustedRun(box) {
  return !!box && typeof box === 'object' && TRUSTED_BOXES.has(box);
}

/**
 * 取出可信结果的 payload;未打标记(或 runner 不符)一律 throw ——
 * 「忘了走可信侧」必须在运行时炸,不许静默用自报数字。
 */
export function requireTrusted(box, expectedRunner, what = '结果') {
  if (!isTrustedRun(box))
    throw new Error(
      `拒绝用未经 canonical runner 标记的${what}出块(r7 条目 7b taint 保护)。`
      + '\n只有 markTrustedRun() 打过标记的结果能进 PR 渲染器 —— demo 目录里的 report*.json'
      + '(JSON.parse 出来的普通对象)永远不满足这个条件。'
      + '\n如果你是在扩功能:请先在可信侧亲自 spawn canonical runner,再把它的产出 markTrustedRun。',
    );
  const actual = BOX_RUNNER.get(box);
  if (expectedRunner && actual !== expectedRunner)
    throw new Error(`${what} 来自 runner "${actual}",但这里要求 "${expectedRunner}"`);
  return box.payload;
}
