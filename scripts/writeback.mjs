#!/usr/bin/env node
// writeback.mjs — 双向同步:把 demo 侧的参数改动按 provenance 反向写回产品源码。
//
// 设计边界(诚实分档):
//   · 参数级改动(色值/几何/字号/文案等「值」)→ 本脚本机械写回,前提是该 truth 叶子的
//     provenance 带定位锚,两种通道(同时有时优先 locatorPattern):
//       a) locatorPattern:恰含一个捕获组的正则,唯一命中源码中的该值;
//       b) locatorKeyPath:源文件中该值的完整对象路径(如 'loginDesignTokens.hero.size'),
//          用产品仓的 typescript 在 AST 上定位字面量(支持 ts/tsx/js/json;as const/satisfies
//          自动解包;shorthand/spread/计算属性/非字面量初始化一律拒转走 agent)。
//   · 结构级改动(新增元素/布局重构/新交互)→ 无机械通道,由 agent 同步改产品代码与 demo,
//     再经 extract→verify 闭环证明双边一致。本脚本对无定位锚的叶子明确拒绝并提示走 agent 双改。
//
// 用法:
//   node writeback.mjs --demo <dir> --repo <产品仓根> --set <truth路径>=<新值> [--set ...] [--dry-run]
// 流程(每个 --set):
//   1. truth 叶子必须有 provenance.locatorPattern 或 provenance.locatorKeyPath;
//      regex 正则在源文件中必须恰命中一次;keyPath 在 AST 上必须恰命中一处字面量;
//   2. 定位处当前内容必须 == truth 旧值(不等 = 源码已变,先重跑 truth.mjs 同步);
//   3. 写回新值(--dry-run 只预览);
//   4. 全部写完后重跑 extract.mjs:新 truth 里该叶子必须 == 新值(round-trip 证明),
//      truth.json + index.html qa-truth 块先内存构造、再临时文件+rename 原子落盘。
// 任一步失败 → 整体 exit 2,三类文件(源码/truth.json/index.html)全部恢复原文
// (源码/两 JSON-HTML 各有备份;恢复本身失败会如实并列出,不谎报已回滚)。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { failJson, failProblems, safeJsonForScript, stableJson } from './lib/fs-utils.mjs';
import { resolveFrom } from './lib/extract-helpers.mjs';
import { locateKeyPathLiteral, buildReplacement, LocateError } from './lib/keypath-locate.mjs';
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
// typescript 惰性解析:只有 keyPath 通道的 --set 才需要,从产品仓 node_modules 偷(零新增依赖)
let tsModule = null;
let tsError = null;
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function loadTs() {
  if (tsModule || tsError) return;
  try {
    // 显式取 lib/typescript.js 经典入口:TS7+ 原生重写版 exports['.'] 指向 version.cjs,
    // 没有 Compiler API——那种环境直接拒转,不在模块形态上猜
    // 候选链不放 demoDir:随后要 import 这个包,命中 <demo>/node_modules/typescript
    // 就是 demo 侧任意代码执行(与审核 r4 CRITICAL 同形)。
    const pkgPath = resolveFrom('typescript/package.json', [process.env.QA_HIFI_MODULE_ROOT, repoRoot, skillRoot]);
    const entry = join(dirname(pkgPath), 'lib/typescript.js');
    if (!existsSync(entry)) {
      throw new Error(`typescript 包内无 lib/typescript.js(TS7+ 原生版无 Compiler API,需要 5.x)`);
    }
    tsModule = await import(pathToFileURL(entry).href);
    if (!tsModule.createSourceFile && tsModule.default?.createSourceFile) tsModule = tsModule.default;
    if (!tsModule.createSourceFile) throw new Error('typescript 模块形态不可识别(无 createSourceFile)');
  } catch (err) {
    tsError = err.message;
  }
}
for (const s of sets) {
  const leaf = rawAt(truth, s.path);
  if (!leaf || typeof leaf !== 'object' || !('value' in leaf)) {
    problems.push(`${s.path}: 不是 truth 叶子({value, provenance})`);
    continue;
  }
  const prov = leaf.provenance ?? {};
  const sourceFile = prov.source ? resolveSource(prov.source) : null;
  if (typeof prov.locatorPattern !== 'string' || !prov.locatorPattern) {
    if (typeof prov.locatorKeyPath === 'string' && prov.locatorKeyPath) {
      // keyPath 通道:AST 定位(下方统一处理,typescript 惰性加载)
      if (!sourceFile) {
        problems.push(`${s.path}: 源文件 ${prov.source} 在 demo 目录与 --repo 下都找不到(需要 --repo <产品仓根>?)`);
        continue;
      }
      if (!tsModule && !tsError) await loadTs();
      if (tsError) {
        problems.push(`${s.path}: keyPath 定位需要产品仓的 typescript,解析失败:${tsError}`);
        continue;
      }
      const content = readFileSync(sourceFile, 'utf8');
      try {
        const loc = locateKeyPathLiteral(tsModule, { fileName: sourceFile, content, keyPath: prov.locatorKeyPath });
        if (loc.currentValue !== String(leaf.value)) {
          problems.push(`${s.path}: 源码当前值 "${loc.currentValue}" ≠ truth 旧值 "${leaf.value}"——源码已变,先重跑 truth.mjs 同步再写回`);
          continue;
        }
      const replacement = buildReplacement(loc, s.value);
        plans.push({
          path: s.path,
          sourceFile,
          source: prov.source,
          old: loc.currentValue,
          next: s.value,
          via: `keyPath:${prov.locatorKeyPath}`,
          start: loc.start,
          end: loc.end,
          newText: replacement,
          backup: content,
        });
      } catch (err) {
        if (err instanceof LocateError) {
          problems.push(`${s.path}: keyPath 定位拒转(${err.code})——${err.message};请走 agent 双改(同步改产品代码与 demo,再 extract→verify 闭环)`);
        } else {
          problems.push(`${s.path}: keyPath 定位异常:${err.message}`);
        }
      }
      continue;
    }
    problems.push(`${s.path}: provenance 无 locatorPattern/locatorKeyPath——该叶子不可机械写回,走 agent 双改(同步改产品代码与 demo,再 extract→verify 闭环)`);
    continue;
  }
  let re;
  try {
    re = new RegExp(prov.locatorPattern, 'g');
  } catch (err) {
    problems.push(`${s.path}: locatorPattern 不是合法正则:${err.message}`);
    continue;
  }
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
    start,
    end: start + m[1].length,
    newText: s.value,
    backup: content,
  });
}
if (problems.length) failProblems(problems);

if (dryRun) {
  console.log(JSON.stringify({ ok: true, dryRun: true, plans: plans.map(({ path, source, old, next, via }) => ({ path, source, old, new: next, ...(via ? { via } : {}) })) }, null, 2));
  process.exit(0);
}

// 阶段 2:写回 + round-trip 验证——三类文件(源码/truth.json/index.html)同一事务:
// 任一环节失败,catch 里三类全部恢复原文;恢复本身失败如实并列出,不谎报「已回滚」。
// 同一文件多个 --set:按 start 降序累积应用(前面的位置不因后面的替换而移位),
// 每个文件只写一次——否则后写的 plan 会拿原始内容覆盖先写的结果。
// truth.json/index.html 先在内存构造完整,再「临时文件 + rename」原子落盘:
// 读取方永远只看到旧版或新版完整文件,不会看到写了一半的中间态。
const indexPath = join(demoDir, 'index.html');
const tmpOf = (file) => `${file}.qa-writeback-tmp`;
function writeAtomic(file, text) {
  const tmp = tmpOf(file);
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
const writtenFiles = new Set();
const backups = new Map();
let truthTouched = false;
let indexTouched = false;
let truthBackup = null;
let indexBackup = null;
try {
  const byFile = new Map();
  for (const p of plans) {
    const list = byFile.get(p.sourceFile) ?? [];
    list.push(p);
    byFile.set(p.sourceFile, list);
  }
  for (const [file, filePlans] of byFile) {
    if (!backups.has(file)) backups.set(file, filePlans[0].backup);
    let content = filePlans[0].backup;
    for (const p of [...filePlans].sort((a, b) => b.start - a.start)) {
      content = content.slice(0, p.start) + p.newText + content.slice(p.end);
    }
    writeFileSync(file, content);
    writtenFiles.add(file);
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

  // round-trip 通过:truth.json 与 index.html 内嵌块(与 truth.mjs --embed 同一语义)原子落盘
  truthBackup = existsSync(truthPath) ? readFileSync(truthPath, 'utf8') : null;
  writeAtomic(truthPath, stableJson(freshTruth));
  truthTouched = true;
  let embedded = false;
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, 'utf8');
    const blockRe = /(<script[^>]*id=["']qa-truth["'][^>]*>)([\s\S]*?)(<\/script>)/;
    if (blockRe.test(html)) {
      indexBackup = html;
      writeAtomic(indexPath, html.replace(blockRe, `$1${safeJsonForScript(freshTruth)}$3`));
      indexTouched = true;
      embedded = true;
    }
  }
  console.log(JSON.stringify({
    ok: true,
    roundTrip: true,
    embedded,
    written: plans.map(({ path, source, old, next, via }) => ({ path, source, old, new: next, ...(via ? { via } : {}) })),
    next: '重跑 verify.mjs 门 A-F 确认双边一致;结构级改动另走 agent 双改',
  }, null, 2));
} catch (err) {
  const restoreErrors = [];
  for (const file of writtenFiles) {
    try { writeFileSync(file, backups.get(file)); } catch (e) { restoreErrors.push(`源码 ${file}:${e.message}`); }
  }
  if (truthTouched) {
    try {
      if (truthBackup === null) unlinkSync(truthPath);
      else writeFileSync(truthPath, truthBackup);
    } catch (e) { restoreErrors.push(`truth.json:${e.message}`); }
  }
  if (indexTouched) {
    try { writeFileSync(indexPath, indexBackup); } catch (e) { restoreErrors.push(`index.html:${e.message}`); }
  }
  for (const tmp of [tmpOf(truthPath), tmpOf(indexPath)]) {
    try { unlinkSync(tmp); } catch {} // 残留原子写临时文件,清不掉不遮主错误
  }
  const suffix = restoreErrors.length
    ? `;但恢复未完成:${restoreErrors.join('; ')}——三文件状态须人工核对`
    : '';
  failProblems([`写回失败已回滚:${String(err.message || err).slice(0, 400)}${suffix}`]);
}
