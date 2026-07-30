#!/usr/bin/env node
// style-sync.mjs — 把 CSS 声明白名单换算成 React Native style 对象。
//
// 在 P2.5 双向同步里的位置:跨端样式「改值」的换算器。web/Electron 侧与 RN 侧样式语法
// 不同构(shorthand 拆分、px→数字、transform 数组化),换算交给本脚本机械做;
// 产出的 mechanical 属性再由 agent/writeback 逐个写回 RN 端(本脚本不写产品代码)。
// 白名单硬原则见 lib/style-convert.mjs 头注释:不可静态保证 RN 侧生效的一律 rejected。
//
// 用法:
//   node style-sync.mjs --decl "padding: 8px 16px" [--decl "width: 1rem"] ...
//   node style-sync.mjs --css-file <path>     # 整个 CSS 文件或裸声明块
// 输出(stdout JSON):
//   { ok: true, mechanical: { <RN 属性对象> }, rejected: [{ prop, value, reason }],
//     summary: { total, mechanical, rejected } }
// exit 0 = 换算完成(有 rejected 也正常退出,由调用方处理);exit 1/2 = 用法/输入错误。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { convertDeclarations } from './lib/style-convert.mjs';
import { failJson } from './lib/fs-utils.mjs';

const args = process.argv.slice(2);
const decls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--decl' && args[i + 1]) {
    const text = args[i + 1];
    const idx = text.indexOf(':');
    if (idx <= 0) failJson(`--decl 格式必须 "prop: value":${text}`);
    decls.push({ prop: text.slice(0, idx).trim(), value: text.slice(idx + 1).trim() });
    i++;
  } else if (args[i] === '--css-file' && args[i + 1]) {
    const file = resolve(args[i + 1]);
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (err) {
      failJson(`--css-file 读取失败:${err.message}`);
    }
    // 裸声明块(没有 {})包一层选择器再交给 postcss
    const css = content.includes('{') ? content : `__qa__{${content}}`;
    let root;
    try {
      root = postcss.parse(css, { from: file });
    } catch (err) {
      failJson(`--css-file 不是合法 CSS:${err.message}`);
    }
    root.walkDecls((d) => {
      if (d.important) {
        decls.push({ prop: d.prop, value: `${d.value} !important` });
      } else {
        decls.push({ prop: d.prop, value: d.value });
      }
    });
    i++;
  }
}
if (decls.length === 0) failJson('缺输入:--decl "prop: value" 或 --css-file <path>(至少一个)');

// !important 在 RN 无对应语义:不入换算,直接 rejected
const direct = [];
const important = [];
for (const d of decls) {
  (d.value.endsWith('!important') ? important : direct).push(d);
}
const { mechanical, rejected } = convertDeclarations(direct);
for (const d of important) {
  rejected.push({ prop: d.prop, value: d.value, reason: '!important 在 RN 无对应语义,需人工裁决优先级' });
}

console.log(JSON.stringify({
  ok: true,
  mechanical,
  rejected,
  summary: {
    total: decls.length,
    mechanical: Object.keys(mechanical).length,
    rejected: rejected.length,
  },
  next: rejected.length
    ? 'rejected 条目须走 agent 双改(同步改产品代码与 demo,再 extract→verify 闭环)'
    : 'mechanical 属性可由 writeback 逐属性写回 RN 端',
}, null, 2));
