// _extractor-template.mjs — 测试 fixture 用的 extract.mjs 生成器(非 .test.mjs,不被测试 glob 收)。
//
// r10 fixture 忠实化的落地点。此前每个 fixture 各自写一行自包含的
// `process.stdout.write(<truth>)`,而 `init.mjs` 生成的**官方模板**第一行是
// `import { ... } from './extract-helpers.mjs'`。fixture 与真实产物形态不一致,导致
// 「可信脚本副本把单文件搬到 output root 后相对 import 解析不到兄弟模块」这条真实使用路径
// 缺陷在 350/350 全绿下完全测不出来 —— 是「测试在骗自己」的又一形状。
//
// 现在 fixture 一律经本文件生成:带 helper 相对 import + 需要把 extract-helpers.mjs 拷进 demo。
// 形态一致性由 comp-fix-r10.test.mjs 的源码契约测试守着(init 模板改了、这里没跟上就红)。

/** 官方模板里那行 helper 相对 import 的**判定形态**(契约测试与本文件共用同一个正则)。 */
export const HELPER_IMPORT_RE = /import\s*\{[^}]*\}\s*from\s*'\.\/extract-helpers\.mjs'/;

/**
 * 与 init.mjs 模板同形的 extractor 源码:import 兄弟 helper 模块,再输出给定 truth。
 * `void findRepoRoot` 是为了让 import 真正被使用(否则 lint/bundler 可能摇掉它,
 * 那就又变成「形态像、实际没有相对依赖」的假忠实)。
 */
export function templateExtractor(emit) {
  return "import { findRepoRoot, makeLeaf } from './extract-helpers.mjs';\n"
    + 'void findRepoRoot; void makeLeaf;\n'
    + `process.stdout.write(${JSON.stringify(JSON.stringify(emit))});\n`;
}
