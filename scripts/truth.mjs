#!/usr/bin/env node
// truth.mjs — 运行 demo/extract.mjs,严格校验 provenance,生成/检查 truth.json。
//
// 批量漂移检查(预检/CI 用):node truth.mjs --check --all <previews-root>
//   扫描 <previews-root> 下所有含 spec.json + extract.mjs 的直接子目录,逐个跑 --check,
//   任一漂移 exit 2——产品常量一改,所有 demo 的过期状态一条命令看完,不再逐个手跑。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failJson, failProblems, isPlainObject, safeJsonForScript, stableJson } from './lib/fs-utils.mjs';
import { validateTruth } from './lib/schema.mjs';

const args = process.argv.slice(2);
const checkMode = args.includes('--check');
const printScriptJson = args.includes('--script-json');
const embedMode = args.includes('--embed');

// 叶子级漂移定位:递归 diff 两棵 canonical 树,输出具体路径(顶层 key 粒度定位太慢——
// 「colors 漂了」还得人肉 diff 几十个叶子)。截断到 80 条防爆屏。
function diffPaths(a, b, path = '', out = []) {
  if (out.length >= 80) return out;
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffPaths(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    const short = (v) => { const s = v === undefined ? '(缺失)' : JSON.stringify(v); return s.length > 120 ? s.slice(0, 120) + '…' : s; };
    out.push({ path: path || '(root)', old: short(a), new: short(b) });
  }
  return out;
}

// --all <root>:批量 --check
const allIdx = args.indexOf('--all');
if (allIdx !== -1) {
  if (!checkMode) failJson('--all 只支持配合 --check 使用(批量生成太危险,逐 demo 手动生成)');
  if (!args[allIdx + 1]) failJson('--all 需要 <previews-root> 目录');
  const root = resolve(args[allIdx + 1]);
  if (!existsSync(root)) failJson(`目录不存在:${root}`);
  const self = fileURLToPath(import.meta.url);
  const demos = readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => {
      try { return statSync(dir).isDirectory() && existsSync(join(dir, 'spec.json')) && existsSync(join(dir, 'extract.mjs')); } catch { return false; }
    });
  if (demos.length === 0) failJson(`目录下没有任何 qa-hifi demo(含 spec.json + extract.mjs 的子目录):${root}`);
  const results = [];
  for (const dir of demos) {
    const res = spawnSync(process.execPath, [self, '--demo', dir, '--check'], { encoding: 'utf8', timeout: 120000 });
    let parsed = null;
    try { parsed = JSON.parse(res.stdout); } catch {}
    results.push({
      demo: dir.split('/').pop(),
      ok: res.status === 0,
      drift: parsed?.drift ?? null,
      driftedPaths: parsed?.driftedPaths ?? undefined,
      error: res.status !== 0 && !parsed ? String(res.stderr || res.stdout).slice(0, 200) : undefined,
    });
  }
  const allOk = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok: allOk, total: results.length, drifted: results.filter((r) => !r.ok).length, results }, null, 2));
  process.exit(allOk ? 0 : 2);
}

const demoIdx = args.indexOf('--demo');
if (demoIdx === -1 || !args[demoIdx + 1]) failJson('缺 --demo <dir>');
const demoDir = resolve(args[demoIdx + 1]);

const extractor = join(demoDir, 'extract.mjs');
if (!existsSync(extractor)) failJson(`提取器不存在:${extractor}(先按 SKILL P1 编写 extract.mjs)`);

let raw;
try {
  raw = execFileSync(process.execPath, [extractor], {
    cwd: demoDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (err) {
  failJson(`extract.mjs 执行失败:${err.stderr || err.message}`);
}

let extracted;
try {
  extracted = JSON.parse(raw);
} catch (err) {
  failProblems([`extract.mjs stdout 不是合法 JSON:${err.message}`]);
}

const problems = validateTruth(extracted, { demoDir, requireProvenance: true });
if (problems.length) failProblems(problems);

const fresh = stableJson(extracted);
const truthPath = join(demoDir, 'truth.json');

if (printScriptJson) {
  console.log(safeJsonForScript(extracted));
  process.exit(0);
}

if (checkMode) {
  if (!existsSync(truthPath)) failJson('truth.json 不存在,先跑一次不带 --check 的生成', 2);
  const existing = readFileSync(truthPath, 'utf8');
  if (existing === fresh) {
    console.log(JSON.stringify({ ok: true, drift: false }));
    process.exit(0);
  }
  // r12:解析失败时的兜底值也用无原型对象,免得 a['__proto__'] 取到原型
  let a = Object.create(null);
  let b = Object.create(null);
  try { a = JSON.parse(existing); b = JSON.parse(fresh); } catch {}
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const driftedKeys = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  const driftedPaths = diffPaths(a, b);
  console.log(JSON.stringify({ ok: false, drift: true, driftedKeys, driftedPaths }, null, 2));
  process.exit(2);
}

writeFileSync(truthPath, fresh);

// --embed:顺带把 index.html 的 <script id="qa-truth"> 块重写为同一份真值(消除「手抄内嵌块」toil,
// 使用方案:qa-hifi 首个使用者反馈——truth→HTML 同步全靠手写正则,忘同步就撞门 A)。
// 用 safeJsonForScript 转义 </script> 防注入;缺块时报错让作者先放一个空块占位。
let embedded = false;
if (embedMode) {
  const indexPath = join(demoDir, 'index.html');
  if (!existsSync(indexPath)) failJson(`--embed 需要 index.html,不存在:${indexPath}`);
  const html = readFileSync(indexPath, 'utf8');
  const re = /(<script[^>]*id=["']qa-truth["'][^>]*>)([\s\S]*?)(<\/script>)/;
  if (!re.test(html))
    failJson('index.html 缺 <script id="qa-truth" type="application/json"></script> 块——先放一个空块占位再 --embed', 2);
  writeFileSync(indexPath, html.replace(re, `$1${safeJsonForScript(extracted)}$3`));
  embedded = true;
}

console.log(JSON.stringify({ ok: true, written: truthPath, embedded, topKeys: Object.keys(JSON.parse(fresh)) }));
