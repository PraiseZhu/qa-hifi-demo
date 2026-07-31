#!/usr/bin/env node
// dom-ops.mjs — 两份 index.html(旧/新)按 data-node-id 锚点对齐,输出结构化操作清单。
//
// 在 P2.5 双向同步里的位置:结构级改动走 agent 双改时,本脚本是 agent 的输入——
// 把「两份全文自由读」换成「结构化 op + 锚点坐标 + 前置状态」,降低双改方差。
// 本脚本只产出清单,不承诺自动应用;应用与否由 agent 按产品代码现状裁决。
//
// 用法:node dom-ops.mjs --old <旧 index.html> --new <新 index.html>
// 输出(stdout JSON):
//   { ok, ops: { added, removed, moved, attrChanged, textChanged, styleChanged },
//     unanchored: [...], meta: { oldAnchors, newAnchors } }
//   - 六类 op 均带 id(锚点)、anchorPath(祖先锚点链)与前置状态(from/parent/index);
//   - 无锚点节点的变化归入 unanchored 段如实列出:按「父锚点内同 tag 第 k 个」尽力配对,
//     是位置对齐的 best-effort,不承诺精确——锚点覆盖不到的区域请 agent 人工核对;
//   - data-node-id 重复 = 违反「稳定、语义化、不复用」约定,exit 2 列出肇事 id。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHtml, serialize, directText, ParseError } from './lib/html-lite.mjs';
import { failJson, failProblems } from './lib/fs-utils.mjs';

const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}
const oldFile = argOf('--old');
const newFile = argOf('--new');
if (!oldFile || !newFile) failJson('缺参数:--old <旧 index.html> --new <新 index.html>');

function loadTree(file) {
  let html;
  try {
    html = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    failJson(`读取失败 ${file}:${err.message}`);
  }
  try {
    return parseHtml(html);
  } catch (err) {
    if (err instanceof ParseError) failJson(`HTML 解析失败 ${file}:${err.message}——请修正文档结构或改走人工比对`);
    throw err;
  }
}

const oldRoot = loadTree(oldFile);
const newRoot = loadTree(newFile);

function indexAnchors(root, label) {
  const map = new Map();
  const dups = [];
  const walk = (n) => {
    if (n.type === 'element') {
      const id = n.attrs['data-node-id'];
      if (id) {
        if (map.has(id)) dups.push(id);
        else map.set(id, n);
      }
    }
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  if (dups.length) failProblems([...new Set(dups)].map((id) => `${label}: data-node-id "${id}" 出现多次——锚点必须稳定、语义化、不复用`));
  return map;
}

const oldAnchors = indexAnchors(oldRoot, '--old');
const newAnchors = indexAnchors(newRoot, '--new');

function nearestAnchorId(node) {
  let p = node.parent;
  while (p && p.type !== 'root') {
    if (p.attrs?.['data-node-id']) return p.attrs['data-node-id'];
    p = p.parent;
  }
  return '(root)';
}

function anchoredSiblingIndex(node) {
  if (!node.parent) return 0;
  const anchored = node.parent.children.filter((c) => c.type === 'element' && c.attrs['data-node-id']);
  return anchored.indexOf(node);
}

function anchorPath(node) {
  const chain = [];
  let p = node.parent;
  while (p && p.type !== 'root') {
    if (p.attrs?.['data-node-id']) chain.unshift(p.attrs['data-node-id']);
    p = p.parent;
  }
  return ['(root)', ...chain];
}

function styleDecls(style) {
  const out = Object.create(null);   // r12:CSS 属性名由页面控制
  for (const part of String(style ?? '').split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim().toLowerCase();
    const v = part.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

const excerpt = (node) => serialize(node, { foldAnchored: false, cap: 200 });
const trunc = (s) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

const ops = { added: [], removed: [], moved: [], attrChanged: [], textChanged: [], styleChanged: [] };

for (const [id, node] of newAnchors) {
  if (oldAnchors.has(id)) continue;
  ops.added.push({
    id,
    tag: node.tag,
    anchorPath: anchorPath(node),
    parent: { anchor: nearestAnchorId(node), index: anchoredSiblingIndex(node) },
    outerHTML: excerpt(node),
  });
}
for (const [id, node] of oldAnchors) {
  if (newAnchors.has(id)) continue;
  ops.removed.push({
    id,
    tag: node.tag,
    anchorPath: anchorPath(node),
    from: { parent: nearestAnchorId(node), index: anchoredSiblingIndex(node) },
    outerHTML: excerpt(node),
  });
}

const matchedPairs = [];
for (const [id, oldNode] of oldAnchors) {
  const newNode = newAnchors.get(id);
  if (!newNode) continue;
  matchedPairs.push([oldNode, newNode]);

  const fromParent = nearestAnchorId(oldNode);
  const toParent = nearestAnchorId(newNode);
  const fromIndex = anchoredSiblingIndex(oldNode);
  const toIndex = anchoredSiblingIndex(newNode);
  if (fromParent !== toParent || fromIndex !== toIndex) {
    ops.moved.push({
      id,
      anchorPath: anchorPath(newNode),
      from: { parent: fromParent, index: fromIndex },
      to: { parent: toParent, index: toIndex },
    });
  }

  const attrDiff = Object.create(null);   // r12:同上
  const keys = new Set([...Object.keys(oldNode.attrs), ...Object.keys(newNode.attrs)]);
  for (const k of keys) {
    if (k === 'data-node-id' || k === 'style') continue;
    const from = oldNode.attrs[k];
    const to = newNode.attrs[k];
    if (from !== to) attrDiff[k] = { from: from ?? null, to: to ?? null }; // null = 该侧无此属性
  }
  if (Object.keys(attrDiff).length) ops.attrChanged.push({ id, anchorPath: anchorPath(newNode), attrs: attrDiff });

  const oldStyle = styleDecls(oldNode.attrs.style);
  const newStyle = styleDecls(newNode.attrs.style);
  const styleDiff = Object.create(null);   // r12:同上
  for (const k of new Set([...Object.keys(oldStyle), ...Object.keys(newStyle)])) {
    if (oldStyle[k] !== newStyle[k]) styleDiff[k] = { from: oldStyle[k] ?? null, to: newStyle[k] ?? null };
  }
  if (Object.keys(styleDiff).length) ops.styleChanged.push({ id, anchorPath: anchorPath(newNode), style: styleDiff });

  const oldText = directText(oldNode);
  const newText = directText(newNode);
  if (oldText !== newText) {
    ops.textChanged.push({ id, anchorPath: anchorPath(newNode), from: trunc(oldText), to: trunc(newText) });
  }
}

// ---- unanchored:父锚点(或 root)内,无锚点元素按「同 tag 第 k 个」尽力配对、逐层下钻 ----
// 降噪设计:
//   - script#qa-truth 直接跳过——内嵌真值块由 truth.mjs --embed 机械再生,永远不是手工改动;
//   - 「modified」只报最深层差异节点(自身签名 = tag+attrs+直接文本,不含子树),
//     祖先不因后代变化重复上榜;
//   - 子树级的增删在各层分别报告,outerHTML 摘录带折叠上限。
const unanchored = [];
const shallowSig = (node) => {
  const attrs = Object.entries(node.attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `${node.tag}|${attrs}|${directText(node)}`;
};
const shallowExcerpt = (node) => {
  const attrs = Object.entries(node.attrs).map(([k, v]) => (v === '' ? k : `${k}="${v}"`)).join(' ');
  const text = trunc(directText(node));
  return trunc(`<${node.tag}${attrs ? ' ' + attrs : ''}>${text}${text ? ' ' : ''}</${node.tag}>`);
};
function compareUnanchoredChildren(oldParent, newParent, atPath) {
  const pick = (n) => (n.children ?? []).filter((c) =>
    c.type === 'element' && !c.attrs['data-node-id'] && c.attrs.id !== 'qa-truth');
  const oldKids = pick(oldParent);
  const newKids = pick(newParent);
  const group = (kids) => {
    const byTag = new Map();
    for (const k of kids) {
      const list = byTag.get(k.tag) ?? [];
      list.push(k);
      byTag.set(k.tag, list);
    }
    return byTag;
  };
  const oldByTag = group(oldKids);
  const newByTag = group(newKids);
  for (const [tag, olds] of oldByTag) {
    const news = newByTag.get(tag) ?? [];
    const n = Math.max(olds.length, news.length);
    for (let i = 0; i < n; i++) {
      const o = olds[i];
      const w = news[i];
      const at = [...atPath, `${tag}(无锚点#${i + 1})`];
      if (o && !w) {
        unanchored.push({ at, tag, change: 'removed', outerHTML: excerpt(o) });
      } else if (!o && w) {
        unanchored.push({ at, tag, change: 'added', outerHTML: excerpt(w) });
      } else {
        if (shallowSig(o) !== shallowSig(w)) {
          unanchored.push({ at, tag, change: 'modified', from: shallowExcerpt(o), to: shallowExcerpt(w) });
        }
        compareUnanchoredChildren(o, w, at);
      }
    }
  }
}
for (const [o, w] of matchedPairs) compareUnanchoredChildren(o, w, anchorPath(w).concat(w.attrs['data-node-id']));
compareUnanchoredChildren(oldRoot, newRoot, ['(root)']);

console.log(JSON.stringify({
  ok: true,
  ops,
  unanchored,
  meta: {
    oldAnchors: oldAnchors.size,
    newAnchors: newAnchors.size,
    changed: Object.values(ops).reduce((n, list) => n + list.length, 0) + unanchored.length,
  },
  next: '本清单是 agent 双改的结构化输入,不自动应用;unanchored 段为位置对齐的尽力比对,须人工核对',
}, null, 2));
