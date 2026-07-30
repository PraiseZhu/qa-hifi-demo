#!/usr/bin/env node
// writeback.mjs — 双向同步:把 demo 侧的参数改动按 provenance 反向写回产品源码。
//
// 设计边界(诚实分档):
//   · 参数级改动(色值/几何/字号/文案等「值」)→ 本脚本机械写回,前提是该 truth 叶子的
//     provenance 带 locatorPattern(恰含一个捕获组的正则,唯一命中源码中的该值)。
//   · 结构级改动(新增元素/布局重构/新交互)→ 无机械通道,由 agent 同步改产品代码与 demo,
//     再经 extract→verify 闭环证明双边一致。本脚本对无 locatorPattern 的叶子明确拒绝并提示走 agent 双改。
//
// 用法:
//   node writeback.mjs --demo <dir> --repo <产品仓根> --set <truth路径>=<新值> [--set ...] [--dry-run]
// 流程(每个 --set):
//   1. truth 叶子必须有 provenance.locatorPattern;正则在源文件中必须恰命中一次;
//   2. 捕获组当前内容必须 == truth 旧值(不等 = 源码已变,先重跑 truth.mjs 同步);
//   3. 写回新值(--dry-run 只预览);
//   4. 全部写完后重跑 extract.mjs:新 truth 里该叶子必须 == 新值(round-trip 证明),
//      truth.json 落盘 + index.html qa-truth 块同步(--embed 同款逻辑)。
// 任一步失败 → 整体 exit 2,已写的文件回滚(写回前留原文备份)。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { failJson, failProblems, safeJsonForScript, stableJson } from './lib/fs-utils.mjs';
import { validateTruth } from './lib/schema.mjs';

// schema.truthAt 会把叶子解包成裸 value;写回需要原始 {value, provenance} 节点,本地实现
function rawAt(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}
const demoDir = argOf('--demo') ? resolve(argOf('--demo')) : null;
const repoRoot = argOf('--repo') ? resolve(argOf('--repo')) : null;
const dryRun = args.includes('--dry-run');
const sets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set' && args[i + 1]) {
    const eq = args[i + 1].indexOf('=');
    if (eq <= 0) failJson(`--set 参数格式必须 <truth路径>=<新值>:${args[i + 1]}`);
    sets.push({ path: args[i + 1].slice(0, eq), value: args[i + 1].slice(eq + 1) });
  }
}
if (!demoDir) failJson('缺 --demo <dir>');
if (sets.length === 0) failJson('缺 --set <truth路径>=<新值>(至少一个)');

const truthPath = join(demoDir, 'truth.json');
if (!existsSync(truthPath)) failJson('truth.json 不存在,先跑 truth.mjs 生成');
let truth;
try {
  truth = JSON.parse(readFileSync(truthPath, 'utf8'));
} catch (err) {
  failProblems([`truth.json 解析失败:${err.message}`]);
}

function resolveSource(source) {
  if (isAbsolute(source)) return source;
  const inDemo = join(demoDir, source);
  if (existsSync(inDemo)) return inDemo;
  if (repoRoot) {
    const inRepo = join(repoRoot, source);
    if (existsSync(inRepo)) return inRepo;
  }
  return null;
}

// 阶段 1:全部预检(不写盘)——任何一条不合格,一个字都不改
const plans = [];
const problems = [];
for (const s of sets) {
  const leaf = rawAt(truth, s.path);
  if (!leaf || typeof leaf !== 'object' || !('value' in leaf)) {
    problems.push(`${s.path}: 不是 truth 叶子({value, provenance})`);
    continue;
  }
  const prov = leaf.provenance ?? {};
  if (typeof prov.locatorPattern !== 'string' || !prov.locatorPattern) {
    problems.push(`${s.path}: provenance 无 locatorPattern——该叶子不可机械写回,走 agent 双改(同步改产品代码与 demo,再 extract→verify 闭环)`);
    continue;
  }
  let re;
  try {
    re = new RegExp(prov.locatorPattern, 'g');
  } catch (err) {
    problems.push(`${s.path}: locatorPattern 不是合法正则:${err.message}`);
    continue;
  }
  const sourceFile = resolveSource(prov.source);
  if (!sourceFile) {
    problems.push(`${s.path}: 源文件 ${prov.source} 在 demo 目录与 --repo 下都找不到(需要 --repo <产品仓根>?)`);
    continue;
  }
  const content = readFileSync(sourceFile, 'utf8');
  const matches = [...content.matchAll(re)];
  if (matches.length !== 1) {
    problems.push(`${s.path}: locatorPattern 在 ${prov.source} 命中 ${matches.length} 次(必须恰 1 次,否则写回位置不确定)`);
    continue;
  }
  const m = matches[0];
  if (m.length !== 2) {
    problems.push(`${s.path}: locatorPattern 必须恰含一个捕获组(当前 ${m.length - 1} 个)`);
    continue;
  }
  if (m[1] !== String(leaf.value)) {
    problems.push(`${s.path}: 源码当前值 "${m[1]}" ≠ truth 旧值 "${leaf.value}"——源码已变,先重跑 truth.mjs 同步再写回`);
    continue;
  }
  const start = m.index + m[0].indexOf(m[1]);
  plans.push({
    path: s.path,
    sourceFile,
    source: prov.source,
    old: m[1],
    next: s.value,
    newContent: content.slice(0, start) + s.value + content.slice(start + m[1].length),
    backup: content,
  });
}
if (problems.length) failProblems(problems);

if (dryRun) {
  console.log(JSON.stringify({ ok: true, dryRun: true, plans: plans.map(({ path, source, old, next }) => ({ path, source, old, new: next })) }, null, 2));
  process.exit(0);
}

// 阶段 2:写回 + round-trip 验证;extract 不认账就整体回滚
const written = [];
try {
  for (const p of plans) {
    writeFileSync(p.sourceFile, p.newContent);
    written.push(p);
  }
  const extractor = join(demoDir, 'extract.mjs');
  if (!existsSync(extractor)) throw new Error('缺 extract.mjs,无法 round-trip 验证');
  const raw = execFileSync(process.execPath, [extractor], { cwd: demoDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const freshTruth = JSON.parse(raw);
  const validation = validateTruth(freshTruth, { demoDir, requireProvenance: true });
  if (validation.length) throw new Error(`写回后 truth 校验失败:${validation.join('; ')}`);
  const failures = [];
  for (const p of plans) {
    const leaf = rawAt(freshTruth, p.path);
    if (String(leaf?.value) !== p.next)
      failures.push(`${p.path}: 写回后 extract 现算值 "${leaf?.value}" ≠ 期望 "${p.next}"(locator 与提取器口径不一致?)`);
  }
  if (failures.length) throw new Error(failures.join('; '));

  // round-trip 通过:truth.json 落盘 + 同步 index.html 内嵌块(与 truth.mjs --embed 同一语义)
  writeFileSync(truthPath, stableJson(freshTruth));
  const indexPath = join(demoDir, 'index.html');
  let embedded = false;
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, 'utf8');
    const blockRe = /(<script[^>]*id=["']qa-truth["'][^>]*>)([\s\S]*?)(<\/script>)/;
    if (blockRe.test(html)) {
      writeFileSync(indexPath, html.replace(blockRe, `$1${safeJsonForScript(freshTruth)}$3`));
      embedded = true;
    }
  }
  console.log(JSON.stringify({
    ok: true,
    roundTrip: true,
    embedded,
    written: plans.map(({ path, source, old, next }) => ({ path, source, old, new: next })),
    next: '重跑 verify.mjs 门 A-F 确认双边一致;结构级改动另走 agent 双改',
  }, null, 2));
} catch (err) {
  for (const p of written) writeFileSync(p.sourceFile, p.backup); // 回滚已写文件
  failProblems([`写回失败已回滚:${String(err.message || err).slice(0, 400)}`]);
}
