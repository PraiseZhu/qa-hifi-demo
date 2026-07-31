#!/usr/bin/env node
// verify.mjs — qa-hifi-demo 门 A/B/C/D/F/X 动态验收执行器。
//
// 门 E(像素基准)**不在本文件**:它住在 pixel-compare.mjs,可信侧来源是 pr-block 定稿时
// 亲自 spawn 那个脚本(--report-out 落到 demo 之外)。因此本文件与调用方一律不得出现
// 「A-F 全部重跑」这类表述 —— r5 的 pr-block 就是这么写的,而它漏了 E(r6 条目 2 CRITICAL)。
// 门级可信来源全表见 SKILL.md「门级全表」。
//
// 增量模式(调试用,2026-07-30 起):
//   --gate A,D      只跑指定门(A/B/C/D/F/X;E 在 pixel-compare.mjs)
//   --case <id,...> 只跑指定 case
//   --state <id,..> 只跑指定状态
// 任一过滤参数出现 → report.partial=true,pr-block 一律拒收 partial 报告——
// 增量是修复循环里的调试工具,定稿必须全量重跑(防「只验过改的那部分」冒充全绿)。
//
// 失败取证:任一动态门失败时自动截图到 verify-artifacts/,failure 条目带 screenshot 字段。
//
// ══ 执行时序原则(r7 条目 1 CRITICAL,勿调换;由 comp-fix-r7 源码契约测试锁死)══
// r5/r6 立的「可信侧重跑」原则有一个前提没被满足过:**spawn canonical verify ≠ 可信**,
// 只要 canonical runner 在核心观察之前就执行了被审方的任意 Node 代码。
// r6 之前的次序是:执行 demo/extract.mjs(门 A extractor drift)→ 三项字节复算 → 启浏览器
// 跑门 B/C/D/F。于是 demo 代码拿到了**整个观察窗口**:extract.mjs 同步返回正确 truth
// (门 A 绿),同时派一个 detached+unref 的 worker,在父 verify 存活期间把永久错误的
// index.html CSS 临时改成与 truth 一致(门 D 实测绿),父进程退出瞬间恢复原错误文件。
// 最终磁盘字节与 inputHashes 完全自洽 —— pr-block exit 0 并贴「渲染绑定 ✅」。
//
// r7 起的次序:
//   ① 观察前算一次 inputHashes;
//   ② 门 A 的纯静态段(内嵌真值 ≡ truth.json)+ 三项可信侧字节复算(inputs/bundle/CSS);
//   ③ 浏览器门 B/C/D/F(全部核心测量);
//   ④ **之后**才执行 demo 侧代码:门 A 的 extractor drift 段 + 门 X 自定义门;
//   ⑤ 再算一次 inputHashes,与 ① 比对,不等即门 A 红(纵深防御,不是主防线 ——
//      攻击可以恢复原文件让前后 hash 都自洽,主防线是 ③ 早于 ④)。
//
// r7 条目 4 追加(不变式 I-OBSERVE):③ 的浏览器观察**不从 demo 原地加载**,而是从验证开始时
// 复制出去的**不可变 snapshot**(demo 之外的临时目录)提供文件。快照建立在 ② 的三项复算**之后**、
// ③ 的浏览器之前:复算的命题是「磁盘产物 == canonical 现算」,磁盘就是它自己的锚,不依赖快照;
// 观察的锚才是快照。两者之间没有 demo 代码执行窗口,所以先后不影响安全性(r8 条目 B:此前 SKILL.md
// 把这段次序写反了,已改文档并由 comp-fix-r8 源码契约锁死)。只靠时序还有一个缺口:
// demo 侧代码不止 extract.mjs / 自定义门 —— 页面自身的脚本、以及上一轮遗留的 detached
// 进程,都可能在浏览器观察窗口内换掉 index.html / assets。快照在「demo node_modules
// fail-fast 之后、执行任何 demo 代码之前」建立,观察对象从此固定;快照路径不在 demo 内,
// demo 侧代码既不知道也碰不到。分界线之后再拿快照与磁盘逐字节比对(⑤)。
// 门 E(像素)的可信重跑在 pr-block 里,必须排在可信 verify **之前**(同一理由)。
// 残余风险(诚实标注):demo 代码在 ④ 之后仍能改磁盘,只是核心观察已完成;没有把
// extractor/custom gate 放进 OS 级 sandbox(Node vm 不是安全边界,不拿它假装隔离)。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  buildInputHashes,
  checkDemoNoNodeModules,
  checkDemoNoSymlinks,
  failJson,
  failProblems,
  readComponentInputsManifest,
  recheckComponentOutputs,
  recheckComponentCss,
  recheckComponentInputs,
  sameInputHashes,
  sha256Buffer,
  stableJson,
  TOOL_VERSION,
} from './lib/fs-utils.mjs';
import { validateSpec, validateTruth, validateCustomGateFiles, truthAt, buildVerifyCases, prefsSubsetEqual, normalizeHash, countFixtureLeaves } from './lib/schema.mjs';
/* 门字母的唯一真相源(r7 条目 7a):不许在本文件再手写一份门列表 —— 门 E 那个 CRITICAL
   的根因就是 verify 与 pr-block 各写了一份、两份都漏了 E。 */
import { lettersFor } from './lib/gates.mjs';
import { createSafeStaticServer } from './lib/safe-server.mjs';
/* I-OBSERVE 的实现只有一处(r8 条目 A):整树快照 / 双向 manifest / output root / 可信脚本副本。
   pixel-compare(门 E)吃的是同一份实现 —— 「所有核心浏览器观察共用同一不可变快照」这句话
   之前对门 E 不成立(它直接 serve/read demoDir),现在两侧同源。 */
import {
  SNAPSHOT_SKIP_TOP,
  isSkippedRel,
  listFilesRel,
  captureFrozenManifest,
  diffAgainstFrozen,
  makeObservationSnapshot,
  makeOutputRoot,
  snapshotManifestDiff,
  trustedScriptCopy,
} from './lib/observe.mjs';
import { launchChromium } from './lib/resolve-playwright.mjs';
import { applyCase, freshLoad, reachTabState, replay, measureAdaptive } from './lib/replay.mjs';

const args = process.argv.slice(2);
const demoIdx = args.indexOf('--demo');
if (demoIdx === -1 || !args[demoIdx + 1]) failJson('缺 --demo <dir>');
const demoDir = resolve(args[demoIdx + 1]);
const headed = args.includes('--headed');
// --report-out <file>:把 report 写到指定路径而不是 <demo>/report.json。
// 供 pr-block 在**可信侧重跑 A/B/C/D/F/X**时使用(r5 架构主线 P0-1):重跑结果落在 demo 之外,
// 既不覆盖作者的 report.json,也不让被审对象碰到我们自己的裁决依据。
const reportOutIdx = args.indexOf('--report-out');
if (reportOutIdx !== -1 && !args[reportOutIdx + 1]) failJson('--report-out 需要一个文件路径');
const reportOut = reportOutIdx !== -1 ? resolve(args[reportOutIdx + 1]) : join(demoDir, 'report.json');

function listArg(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  if (!args[i + 1]) failJson(`${flag} 需要一个逗号分隔的取值列表`);
  return args[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
}
// 本文件负责的门 = TRUSTED_GATES 里 runner 为 'verify' 的那些(门 E 属 pixel-compare)
const GATE_LETTERS = lettersFor('verify');
const gateFilter = listArg('--gate')?.map((g) => g.toUpperCase());
const caseFilter = listArg('--case');
const stateFilter = listArg('--state');
if (gateFilter) {
  const bad = gateFilter.filter((g) => !GATE_LETTERS.includes(g));
  if (bad.length) failJson(`--gate 只支持 ${GATE_LETTERS.join('/')}(门 E 用 pixel-compare.mjs),非法:${bad.join(',')}`);
}
const partial = !!(gateFilter || caseFilter || stateFilter);
const runGate = (letter) => !gateFilter || gateFilter.includes(letter);

/* ── 无条件 fail-fast:demo 自带 node_modules 一律拒(r5 P0-2) ──
   必须排在**任何** demo 侧输入解析、动态 import、子进程执行、浏览器启动之前:
   playwright/esbuild 这类模块一旦从 <demo>/node_modules 解析出来,import 的瞬间
   它的顶层代码就在本进程里跑了。不限组件模式,对所有 demo 生效;命中即退出,
   不是「标红后继续」。 */
{
  const problems = checkDemoNoNodeModules(demoDir);
  if (problems.length) failProblems(problems);
}

/* ── 无条件 fail-fast:demo 输入树里的 symlink 一律拒(r9 P0) ──
   必须与上面那道门同阶段、**排在建立快照之前**:快照 cpSync(dereference:true) 一跑,
   仓外链接目标的字节就已被复制成快照内的普通文件(观察侧 200),而交付原地 server 对它
   realpath 后判 403 —— 观察对象由此比交付对象「多」了本该被拒的资源(与 r8 late.js 反向)。
   等快照建完再检查就晚了。理由全文见 fs-utils.checkDemoNoSymlinks。 */
{
  const problems = checkDemoNoSymlinks(demoDir);
  if (problems.length) failProblems(problems);
}

for (const f of ['spec.json', 'truth.json', 'index.html'])
  if (!existsSync(join(demoDir, f))) failJson(`${f} 不存在于 ${demoDir}`);

let spec;
let truthObj;
let html;
try {
  spec = JSON.parse(readFileSync(join(demoDir, 'spec.json'), 'utf8'));
  truthObj = JSON.parse(readFileSync(join(demoDir, 'truth.json'), 'utf8'));
  html = readFileSync(join(demoDir, 'index.html'), 'utf8');
} catch (err) {
  failProblems([`输入解析失败:${err.message}`]);
}

const schemaProblems = [
  ...validateSpec(spec).map((p) => `spec: ${p}`),
  ...validateTruth(truthObj, { demoDir, requireProvenance: true }).map((p) => `truth: ${p}`),
  ...validateCustomGateFiles(spec, demoDir).map((p) => `spec: ${p}`),
];
if (schemaProblems.length) failProblems(schemaProblems);

const isComponentMode = spec.component?.mode === 'component';
const inputHashes = buildInputHashes(demoDir, spec);
const allCases = buildVerifyCases(spec);
const cases = caseFilter ? allCases.filter((c) => caseFilter.includes(c.id)) : allCases;
if (caseFilter && cases.length === 0)
  failJson(`--case 没有命中任何 case;可用:${allCases.map((c) => c.id).join(', ')}`);
const statesRun = stateFilter ? spec.states.filter((s) => stateFilter.includes(s.id)) : spec.states;
if (stateFilter && statesRun.length === 0)
  failJson(`--state 没有命中任何状态;可用:${spec.states.map((s) => s.id).join(', ')}`);

function makeGate(name, total = 0) {
  return { name, pass: false, total, passed: 0, failures: [], cases: [] };
}
function skippedGate(name) {
  return { name, pass: false, skipped: true, detail: '本次为增量运行(--gate 过滤),该门未执行' };
}

/* r8 条目 A:页面可达输入**全部进快照**,所以这里不再有「豁免清单」需要维护。
   仍需挡住的只有一类:引用了**快照里根本不存在**的顶层目录 —— 即 `node_modules/`(前置门已
   无条件拒)与 `.git/`(不属交付产物)。除这两项之外,demo 树里的一切都在快照里,引用它们
   不再构成「被验页面 ≠ 交付页面」。这份检查因此是从 SNAPSHOT_SKIP_TOP 推导出来的,不会漂移。 */
function refsOutsideSnapshot(source) {
  const hits = new Set();
  for (const m of source.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(raw)) continue;
    const rel = raw.split(/[?#]/)[0].replace(/^\.?\//, '');
    if (isSkippedRel(rel)) hits.add(rel);
  }
  return [...hits];
}

// ---------- 门 A 第一段(纯静态 + 可信侧字节复算,不执行 demo 侧代码) ----------
// 门 A 一共四段:① 内嵌 qa-truth ≡ truth.json;② 三项可信侧字节复算(组件模式);
// ③ truth 由 extract.mjs 现跑重算 ≡ truth.json(证明 value 真由源码提取,不是手抄
// value+CSS+内嵌块蒙混,codex 复审 P0-1);④ provenance 由 validateTruth 保证。
// r7 起 ③ 因为要**执行 demo 侧代码**,被推到所有浏览器门之后(见文件头「执行时序原则」)。
let gateA;
/** 门 A 里除 extractor drift 之外的任一段已判失败 —— 延后汇总时不许被 extractor 绿覆盖。 */
let gateAHardFail = false;
if (!runGate('A')) gateA = skippedGate('真值一致');
else {
  gateA = { name: '真值一致', pass: false, detail: '', provenance: 'required', extractorDrift: 'pending' };
  /* r8 条目 A:页面不得引用快照之外的路径(只剩 node_modules/ 与 .git/ 两类)。 */
  const outsideRefs = refsOutsideSnapshot(html);
  gateA.refsOutsideSnapshot = outsideRefs.length ? outsideRefs : 'none';
  if (outsideRefs.length) {
    gateAHardFail = true;
    gateA.detail = [
      gateA.detail,
      `index.html 引用了不可变快照之外的路径(${outsideRefs.join('、')})——快照跳过的顶层目录只有 `
      + `${SNAPSHOT_SKIP_TOP.join(' / ')}(前置门已拒 / 不属交付产物)。引用它们意味着浏览器验证时取不到、`
      + '交付原地却可能取到:被验证的页面与交付的页面不同。修法:页面需要的资源一律放进 assets/ 等普通目录。',
    ].filter(Boolean).join('\n');
  }
  const m = html.match(/<script[^>]*id=["']qa-truth["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    gateAHardFail = true;
    gateA.detail = 'index.html 缺 <script id="qa-truth" type="application/json"> 内嵌真值块';
  } else {
    try {
      const embedded = JSON.parse(m[1]);
      if (stableJson(embedded) !== stableJson(truthObj)) {
        gateAHardFail = true;
        gateA.detail = '内嵌真值与 truth.json 不一致(规范化比对失败)';
      }
    } catch (err) {
      gateAHardFail = true;
      gateA.detail = `真值块解析失败:${err.message}`;
    }
  }
}

/* ── 三项可信侧字节复算(组件模式)──
   r8 条目 B/A:调用点在**快照建立之后**,并由紧邻的双向 manifest 检查点把它读到的磁盘字节与
   快照字节绑在一起(见 bindObservationToDisk)。为什么复算仍然读磁盘而不是读快照:
   `component-build-core --check-inputs` 必须以 **demoDir 为 cwd** 跑 esbuild(metafile 的 key
   相对 cwd,换 cwd 会改整份清单的规范化结果),且产品组件源码是靠 demo 所在的 **git 仓根**解析的
   —— 快照住在 tmpdir、不在产品仓内,拿快照当 cwd 会直接 repoRoot=UNRESOLVED 硬失败。
   所以「复算与观察绑定同一份字节」这条不变式的落地方式是:复算读磁盘 ∧ 紧随其后的双向 manifest
   当场证明 snapshot ≡ 磁盘。语义不丢(「磁盘产物 == canonical 现算」原样保留),只多一层锁。 */
function runComponentRechecks() {
  if (gateA.skipped || !isComponentMode) return;
  {
    const recheck = recheckComponentInputs(demoDir);
    gateA.inputsRecheck = recheck.status;
    if (recheck.problems.length) {
      gateAHardFail = true;
      gateA.detail = [gateA.detail, ...recheck.problems].filter(Boolean).join('\n');
    }
    /* r5 #1c 第一层 → r7 条目 3 升级(不变式 I-ESBUILD):
       esbuild **全部产物**(JS bundle + file loader 派生的图片/字体/…)的「路径→字节」映射
       必须等于可信侧 write:false 现算映射。
       堵手改 bundle、堵「预占同形假封印 + 让真 bundle 初始化失败」(伪造方拿不出一份字节
       全等的真 bundle),也堵 r7 条目 3 那条 P0:**派生资产原地换字节但保留 [hash] 文件名**
       —— 只复算 JS 时它字节全等、assets hash 又是对攻击后字节现算的,全链绿。 */
    const outputsCheck = recheckComponentOutputs(demoDir, spec.component);
    gateA.bundleRecheck = outputsCheck.status;          // 字段名保持兼容(旧 report 可读)
    gateA.outputsRecheck = { status: outputsCheck.status, checked: outputsCheck.checked ?? null };
    // 额外资产只如实列出、不阻断(作者可能手工放图);列出来才有人能核对
    if (outputsCheck.extraAssets?.length) gateA.outputsRecheck.extraAssets = outputsCheck.extraAssets;
    if (outputsCheck.problems.length) {
      gateAHardFail = true;
      gateA.detail = [gateA.detail, ...outputsCheck.problems].filter(Boolean).join('\n');
    }
    /* r6 条目 1:CSS 字节必须等于可信侧重编结果(与 bundle 同型)。
       原先 assets/component.css 全仓没有任何字节复算 —— 合法构建后手改它,
       只要不动入链的输入文件,全流程零检测通过。这一条同时兜住 content glob
       语义差异 / node_modules 非对称扫描 / config 的 preset·plugin 未入链。 */
    const cssCheck = recheckComponentCss(demoDir, spec.component);
    gateA.cssRecheck = cssCheck.status;
    if (cssCheck.problems.length) {
      gateAHardFail = true;
      gateA.detail = [gateA.detail, ...cssCheck.problems].filter(Boolean).join('\n');
    }
  }
}

const needBrowser = runGate('B') || runGate('C') || runGate('D') || runGate('F');
// 门 A 也要靠快照(复算与观察的绑定检查点在快照上做),所以只要跑门 A 就得建快照
const needSnapshot = needBrowser || runGate('A');

/* ── 不可变 snapshot(r7 条目 4 / r8 条目 A,不变式 I-OBSERVE) ──
   实现在 lib/observe.mjs(与门 E 共用同一份):**整树**复制到 demo 之外的临时目录,浏览器一律
   从这里加载。r7 的版本带一张排除表(整个 verify-artifacts/ / pixel-artifacts/ / 三个
   report*.json),而没有任何东西禁止页面引用被排除的路径 —— 审核人 PoC:index.html 加
   `<script src="pixel-artifacts/late.js">` 把门 D 绑定的 .box 从 16px 改成 99px,快照里该文件
   404(门 D 量到 16px 绿)、交付原地却真加载(computed 99px),单向 drift 报 "none",全链放行。
   r8 起:整树进快照(只跳 node_modules / .git —— 前置门已拒 / 不属交付产物),工具自己的运行期
   输出改写到 demo 之外的 output root,盲区本身被消掉。
   失败即 fail-closed:拿不到不可变观察对象就不许继续(不静默退回原地加载)。 */
let snapshotDir = null;
/* r11 P0:分界线前冻结的内存 manifest —— 收口比对的唯一 oracle(见分界线处的注释)。 */
let frozenSnapshot = null;

/* ── 工具运行期输出的独立根(r8 条目 A ②)──
   失败截图与门 X/extractor 的可信脚本副本一律写在这里,不再写进 demo 树 —— 这样 demo 树里
   就没有「本轮运行期新写入」的文件,双向 manifest 不需要任何按名豁免。 */
const outputRoot = makeOutputRoot();
const artifactDir = join(outputRoot, 'verify-artifacts');

/** 双向 manifest 检查点:证明快照(观察对象)与磁盘(复算对象 / 交付对象)逐字节相同。 */
function manifestCheckpoint(when) {
  const diff = snapshotManifestDiff(snapshotDir, demoDir);
  return { when, ...diff };
}
let safeServer;
let browser;
let page = null;
let currentPageKey = null;
let shotSeq = 0;
/** 页面未捕获异常(r5 #1c 第二层);哨兵断言时非空即 fail-closed。 */
const pageErrors = [];

/** per-case 视口:case 声明 viewport(w/h/dpr)时换新 page——移动端 case 必须在移动端视口下验。 */
async function pageFor(testCase = {}) {
  const vp = testCase.viewport ?? null;
  const key = vp ? `${vp.w}x${vp.h}@${vp.dpr ?? 'default'}` : 'default';
  if (page && currentPageKey === key) return page;
  if (page) { try { await page.close(); } catch {} }
  page = await browser.newPage({
    viewport: { width: vp?.w ?? 1440, height: vp?.h ?? 960 },
    ...(vp?.dpr ? { deviceScaleFactor: vp.dpr } : {}),
  });
  /* r5 #1c 第二层:监听 pageerror。组件模式的 bundle 初始化是**故意不 try/catch** 的——
     哨兵 defineProperty 撞上「页面侧预占的不可配置同名全局」时会抛错,bundle 整段初始化
     失败。r4 的 verify 不听 pageerror,于是读到的是预占的那份假封印。现在任何未捕获
     页面异常都被记下,哨兵断言处 fail-closed。 */
  page.on('pageerror', (err) => { pageErrors.push(String(err?.message ?? err).slice(0, 300)); });
  currentPageKey = key;
  return page;
}

/** 失败现场截图(best-effort):落 **output root** 的 verify-artifacts/(r8 条目 A:不再写进 demo 树),
    返回相对 output root 的路径;绝对根记在 report.artifactRoot 里供人查看。 */
async function failShot(label) {
  if (!page) return null;
  try {
    mkdirSync(artifactDir, { recursive: true });
    const name = `${String(++shotSeq).padStart(2, '0')}-${label.replace(/[^A-Za-z0-9一-鿿._=-]+/g, '_').slice(0, 100)}.png`;
    await page.screenshot({ path: join(artifactDir, name) });
    return `verify-artifacts/${name}`;
  } catch {
    return null;
  }
}

try {
  let base = null;
  /* ══════════ I-OBSERVE 的次序(r8 条目 A/B,勿调换)══════════
     ① 建立**整树**不可变快照(所有核心观察的唯一来源,门 E 用同一份实现);
     ② 三项可信侧字节复算(读磁盘,原因见 runComponentRechecks 的注释);
     ③ **双向 manifest 检查点**:证明 ② 读到的磁盘字节 ≡ ① 的快照字节 —— 这就是「复算与
        B/C/D/F/E 绑定同一份字节」的落地方式,也堵掉了「① 与 ② 之间同步的外部写入者」这个窗口;
     ④ 浏览器门 B/C/D/F 全部从快照加载;⑤ 分界线之后才执行 demo 代码;⑥ 收口再做一次双向 manifest。 */
  if (needSnapshot) {
    snapshotDir = makeObservationSnapshot(demoDir);
  }
  runComponentRechecks();                       // ② 读磁盘;字节由 ③ 当场绑到快照上
  if (needSnapshot && !gateA.skipped) {         // ③ 检查点:snapshot ≡ 磁盘
    const bind = manifestCheckpoint('post-recheck');
    gateA.observeBinding = bind.all.length ? bind.all.slice(0, 10) : 'bound';
    if (bind.all.length) {
      gateAHardFail = true;
      gateA.detail = [
        gateA.detail,
        `快照与磁盘在「建立快照 → 三项复算」这段窗口内就已不一致(${bind.all.length} 项):`
        + `${bind.all.slice(0, 5).join('、')}\n有并发写入者在动 demo —— 复算读到的字节与浏览器将要观察的`
        + '字节不是同一份,本次结论不可信。',
      ].filter(Boolean).join('\n');
    }
  }
  if (needBrowser) {
    // I-OBSERVE:服务的是快照,不是 demo 原地
    safeServer = createSafeStaticServer(snapshotDir);
    base = await safeServer.listen();
    ({ browser } = await launchChromium(demoDir, { headless: !headed }));
  }

  // ---------- 门 B:状态覆盖 ----------
  let gateB;
  if (!runGate('B')) gateB = skippedGate('状态覆盖');
  else {
    gateB = makeGate('状态覆盖', cases.length * statesRun.length);
    // 组件模式运行期哨兵(审核 #1c):entry 的导出被 build.mjs 套过调用探针,
    // 真被渲染(React 调函数组件 / new 类组件 / memo·forwardRef 的 render)才会置位。
    // `import '<entry>'` 这种副作用导入让 entry 进图、hash 入链,但一次也不会调用它——
    // 界面全是 bootstrap 手搓的。这里在挂载完成后、第一个状态断言前查一次。
    // 只有哨兵真挂上(manifest.entrySentinel === 'active')才断言;entry 导出全是常量/
    // 纯数据时探针套不上,不误判为造假,由 pr-block 把结论诚实降级为「需人工审查」。
    // r3(终审 #1c):只有 spec 声明了 component.export、且**那个目标导出**被调用,才算证明。
    // r2 给 entry 的每个导出套探针、任一被调用即 proved —— 终审实证 entry 同时导出组件
    // Claimed() 与工具函数 utility()、bootstrap 只调 utility() 时照样 proved,「真组件直渲」
    // 这句话就成了假话。现在:
    //   entrySentinel='targeted'    → 目标导出被调用 = proved;目标可探测却从未被调用 = 硬失败
    //   entrySentinel='active'      → 未声明目标导出:只保留「一个导出都没被调用」这条硬失败,
    //                                 结论最高只到 'nontarget'(PR 块降级,不许宣称直渲)
    //   entrySentinel='unavailable' → 探针完全套不上,不断言,结论 'unavailable'
    const sentinelState = isComponentMode ? readComponentInputsManifest(demoDir)?.entrySentinel : null;
    const sentinelExpected = sentinelState === 'targeted' || sentinelState === 'active';
    let sentinelChecked = false;
    // 'proved' = 哨兵实测**目标导出**被调用;'nontarget' = 只证明了某个入口导出被调用,
    // 是不是 UI 组件不知道;'unavailable' = 探针套不上;'n/a' = 非组件模式。
    let entryRenderProof = isComponentMode ? 'unavailable' : 'n/a';
    const assertSentinel = async (p) => {
      if (!sentinelExpected || sentinelChecked) return;
      sentinelChecked = true;
      // 只认封印形态的证据(r4 追加 #1c):证据存在 bundle 模块闭包里,页面侧只能读
      // 一个 non-writable/non-configurable 全局上的 get-only snapshot。
      // demo 侧写任何可写全局都影响不了它;形态不对 = 有人顶替了哨兵,当造假处理。
      /* bundle 初始化期抛错 = 哨兵没能装上(最常见成因:页面侧预占了同名不可配置全局,
         让真 bundle 的 defineProperty 抛错)。此时页面上留下的那份「证据」必然不是
         哨兵写的,一律按造假处理(r5 #1c 第二层)。 */
      if (pageErrors.length)
        throw new Error(
          `bundle 初始化期页面抛错,哨兵未能装上——不接受页面上残留的任何「证据」:${pageErrors.slice(0, 3).join(' | ')}`
          + '\n最常见成因:index.html 在 bundle 之前预占了 globalThis.__QA_ENTRY_SENTINEL__(不可配置),'
          + '导致真哨兵的 defineProperty 抛错。'
          + '\n修法:删掉 demo 侧对 __QA_ENTRY_* 的任何定义/赋值,重跑 node build.mjs。',
        );
      // challenge:每次运行一个不可预测 nonce,回应必须原样带回(r5 #1c 第三层)。
      // 静态预置的冻结 snapshot 预知不了它;要能回应就得写真函数,而那躲不过字节复算与 pageerror。
      const challenge = randomUUID();
      const raw = await p.evaluate((nonce) => {
        const d = Object.getOwnPropertyDescriptor(globalThis, '__QA_ENTRY_SENTINEL__');
        if (!d) return { present: false };
        const sd = d.value && typeof d.value === 'object' ? Object.getOwnPropertyDescriptor(d.value, 'snapshot') : null;
        const pd = d.value && typeof d.value === 'object' ? Object.getOwnPropertyDescriptor(d.value, 'prove') : null;
        let snap = null;
        try { snap = d.value?.snapshot ?? null; } catch { snap = null; }
        let proof = null;
        try { proof = d.value?.prove?.(nonce) ?? null; } catch { proof = null; }
        return {
          present: true,
          sealed: d.writable === false && d.configurable === false,
          accessorOk: !!sd && typeof sd.get === 'function' && sd.set === undefined && sd.configurable === false,
          proveOk: !!pd && typeof pd.value === 'function' && pd.writable === false && pd.configurable === false,
          frozen: !!d.value && Object.isFrozen(d.value),
          snap,
          proof,
        };
      }, challenge);
      // 结论一律取 challenge 回应(而不是静态 snapshot)——静态形状只用于形态校验
      const st = { rendered: raw.proof?.rendered === true, targetRendered: raw.proof?.targetRendered === true, shape: raw.proof?.shape ?? null };
      if (raw.present && !(raw.proveOk && raw.proof && raw.proof.nonce === challenge))
        throw new Error(
          '哨兵未按 challenge 回应——页面上的 __QA_ENTRY_SENTINEL__ 不是本次 bundle 里那个活的哨兵'
          + `(prove 形态:${raw.proveOk} 回应 nonce:${JSON.stringify(raw.proof?.nonce ?? null)} 期望:${challenge})。`
          + '\n静态预置的同形封印能仿造形状,但预知不了每次运行才生成的 nonce。'
          + '\n修法:删掉 demo 侧对 __QA_ENTRY_* 的任何定义/赋值,重跑 node build.mjs。',
        );
      if (!st.shape?.sentinel)
        throw new Error('运行期哨兵未在页面里出现——assets/component.bundle.js 不是当前 build.mjs 产出的(手改过 bundle?),重跑 node build.mjs');
      if (!(raw.sealed && raw.accessorOk && raw.frozen))
        throw new Error(
          '运行期哨兵证据不是封印形态——globalThis.__QA_ENTRY_SENTINEL__ 被页面侧顶替/改写了'
          + `(封印:${raw.sealed} 只读访问器:${raw.accessorOk} 冻结:${raw.frozen})。`
          + '\n哨兵证据只能由 build 产出的 bundle 自己写;bootstrap/index.html 里手动构造这个全局一律按造假处理。'
          + '\n修法:删掉 demo 侧对 __QA_ENTRY_* 的任何赋值/定义,重跑 node build.mjs。',
        );
      if (sentinelState === 'targeted') {
        if (st.targetRendered) { entryRenderProof = 'proved'; return; }
        // 目标导出存在(build 已校验)但形态套不上探针(常量/纯数据):不判造假,诚实降级
        if (!(st.shape.targetWrappable > 0)) return;
        throw new Error(
          `声明的目标导出从未被渲染——component.export="${st.shape.target}" 已打包,渲染期一次调用/实例化都没发生`
          + (st.rendered ? '(entry 的**其它**导出被调用过:调工具函数不等于渲染组件)' : '(bootstrap 是不是只做了 side-effect import?)')
          + '\n修法:让 bootstrap 真的渲染该目标组件;若真正渲染的是别的组件,把 component.entry/component.export 改成那一个。',
        );
      }
      // 未声明目标导出:能证明的上限只有「入口的某个导出被调用过」
      if (st.rendered) { entryRenderProof = 'nontarget'; return; }
      if (!(st.shape.wrappable > 0)) return; // 探针一个都套不上:不断言,由 pr-block 降级
      throw new Error(
        'entry 已打包但从未被渲染——bootstrap 是不是只做了 side-effect import?'
        + `(哨兵:探针 ${st.shape.wrappable}/${st.shape.total} 个导出已就位,渲染期一次调用都没发生)`
        + '\n修法:让 bootstrap 真的 import 并渲染该入口组件;若 entry 只是被间接用到,把 component.entry 改成真正渲染的那个组件。'
        + '\n另:要在 PR 上拿到「真组件直渲」结论,必须在 spec.component.export 里声明目标组件导出名。',
      );
    };
    for (const testCase of cases) {
      const caseResult = { id: testCase.id, prefs: testCase.prefs, passed: 0, total: statesRun.length, failures: [] };
      const p = await pageFor(testCase);
      for (const st of statesRun) {
        try {
          await freshLoad(p, base, { adaptive: !!spec.adaptive });
          await applyCase(p, testCase);
          await assertSentinel(p);
          if (Array.isArray(st.via)) await replay(p, st.via);
          else await reachTabState(p, st);
          const cur = await p.evaluate(() => window.__qa.current());
          if (cur !== st.id) throw new Error(`via 执行后 current="${cur}", expected "${st.id}"`);
          caseResult.passed++;
          gateB.passed++;
        } catch (err) {
          const failure = { case: testCase.id, state: st.id, error: String(err.message || err).slice(0, 300), screenshot: await failShot(`B-${testCase.id}-${st.id}`) };
          caseResult.failures.push(failure);
          gateB.failures.push(failure);
        }
      }
      gateB.cases.push(caseResult);
    }
    gateB.entryRenderProof = entryRenderProof;
    gateB.pass = gateB.failures.length === 0;
  }

  // ---------- 门 C:交互鲁棒 ----------
  let gateC;
  if (!runGate('C')) gateC = skippedGate('交互鲁棒');
  else {
    gateC = { name: '交互鲁棒', pass: false, checks: [], cases: cases.map((c) => ({ id: c.id, prefs: c.prefs })) };

    const noClipCheck = { id: 'no-clip', pass: false, failures: [] };
    for (const testCase of cases) {
      const p = await pageFor(testCase);
      for (const st of statesRun) {
        try {
          await freshLoad(p, base, { adaptive: !!spec.adaptive });
          await applyCase(p, testCase);
          if (Array.isArray(st.via)) await replay(p, st.via);
          else await reachTabState(p, st);
          const failures = await p.evaluate((selectors) => {
            const out = [];
            const visible = (el) => {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
            };
            for (const sel of selectors) {
              const all = [...document.querySelectorAll(sel)].filter(visible);
              if (all.length === 0) { out.push(`${sel}:未命中可见元素`); continue; }
              for (const el of all) {
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                const txt = (el.textContent || '').trim().slice(0, 40);
                const clippedX = el.scrollWidth > el.clientWidth + 1;
                const clippedY = el.scrollHeight > el.clientHeight + 1;
                if (clippedX) out.push(`${sel}:"${txt}" 横向截断`);
                if (clippedY) out.push(`${sel}:"${txt}" 纵向截断`);
                if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)
                  out.push(`${sel}:"${txt}" 溢出 viewport`);
                // ellipsis/line-clamp 仅在「确实发生截断」时报——设了但内容没溢出是合法用法,不误杀
                // (codex 复审 P1;真截断已由上面 scroll 比对覆盖,这里补一句更明确的成因)
                if (clippedX && s.textOverflow === 'ellipsis') out.push(`${sel}:"${txt}" ellipsis 截断生效`);
                if (clippedY && s.webkitLineClamp && s.webkitLineClamp !== 'none') out.push(`${sel}:"${txt}" line-clamp 截断生效`);
              }
            }
            return out;
          }, spec.verify.noClip);
          if (failures.length) {
            const screenshot = await failShot(`C-noclip-${testCase.id}-${st.id}`);
            for (const f of failures) noClipCheck.failures.push({ case: testCase.id, state: st.id, error: f, screenshot });
          }
        } catch (err) {
          noClipCheck.failures.push({ case: testCase.id, state: st.id, error: String(err.message || err).slice(0, 300), screenshot: await failShot(`C-noclip-${testCase.id}-${st.id}`) });
        }
      }
    }
    noClipCheck.pass = noClipCheck.failures.length === 0;
    gateC.checks.push(noClipCheck);

    for (const inp of spec.verify.inputs ?? []) {
      const check = { id: `input-stable:${inp.sel}`, pass: false, failures: [] };
      for (const testCase of cases) {
        const p = await pageFor(testCase);
        try {
          await freshLoad(p, base, { adaptive: !!spec.adaptive });
          await applyCase(p, testCase);
          await replay(p, inp.via ?? []);
          // 先证明 witness 由独立定时器自主变化(全程不碰输入)——否则是「靠 oninput 同步更新」的
          // 伪 tick,input 一停就不动,不能用来证明跨 tick 稳定(codex 复审 P0-5)
          const idleBefore = await p.locator(inp.tickWitness).first().textContent({ timeout: 4000 });
          await p
            .waitForFunction(
              ({ sel, before }) => document.querySelector(sel)?.textContent !== before,
              { sel: inp.tickWitness, before: idleBefore },
              { timeout: Number(inp.tickMs) * 3 },
            )
            .catch(() => { throw new Error(`tickWitness ${inp.tickWitness} 在无输入时不自主变化——非独立定时器(伪 tick),无法证明跨 tick 输入稳定`); });
          const beforeWitness = await p.locator(inp.tickWitness).first().textContent({ timeout: 4000 });
          await p.locator(inp.sel).waitFor({ state: 'visible', timeout: 4000 });
          await p.locator(inp.sel).evaluate((el) => { el.value = ''; el.__qaInputMark = true; });
          await p.locator(inp.sel).focus();
          const perChar = Math.ceil(Number(inp.tickMs) / inp.text.length) + 60;
          await p.type(inp.sel, inp.text, { delay: perChar });
          await p.waitForFunction(
            ({ sel, before }) => document.querySelector(sel)?.textContent !== before,
            { sel: inp.tickWitness, before: beforeWitness },
            { timeout: Number(inp.tickMs) * 3 },
          );
          const res = await p.evaluate((sel) => {
            const el = document.querySelector(sel);
            return { value: el?.value, focused: document.activeElement === el, sameNode: el?.__qaInputMark === true };
          }, inp.sel);
          const problems = [];
          if (res.value !== inp.text) problems.push(`值不完整:"${res.value}"`);
          if (!res.focused) problems.push('焦点丢失');
          if (!res.sameNode) problems.push('DOM 节点被替换');
          if (problems.length) throw new Error(problems.join('; '));
        } catch (err) {
          check.failures.push({ case: testCase.id, error: String(err.message || err).slice(0, 300), screenshot: await failShot(`C-input-${testCase.id}`) });
        }
      }
      check.pass = check.failures.length === 0;
      gateC.checks.push(check);
    }

    if (spec.verify.persistence) {
      const pers = spec.verify.persistence;
      const check = { id: 'persistence', pass: false, failures: [] };
      const p = await pageFor({});
      try {
        await freshLoad(p, base, { adaptive: !!spec.adaptive });
        await replay(p, pers.via);
        const got = await p.evaluate(() => window.__qa.prefs());
        // key-wise 比对,不用 JSON.stringify(受 key 顺序影响会误杀语义相同的 prefs;codex 复审 P1)
        if (!prefsSubsetEqual(got, pers.expected))
          throw new Error(`via 后 prefs 不等于 expected:${JSON.stringify(got)} vs ${JSON.stringify(pers.expected)}`);
        const stored = await p.evaluate((key) => localStorage.getItem(key), pers.storageKey);
        if (stored == null) throw new Error(`localStorage 缺 key:${pers.storageKey}`);
        let parsed;
        try { parsed = JSON.parse(stored); } catch { throw new Error(`localStorage ${pers.storageKey} 不是 JSON`); }
        if (!prefsSubsetEqual(parsed, pers.expected))
          throw new Error(`localStorage ${pers.storageKey} 不含 expected prefs:${stored}`);
        const initial = pers.initialState ?? spec.states[0].id;
        for (let i = 0; i < Number(pers.reloads); i++) {
          await p.reload({ waitUntil: 'load' });
          await p.waitForFunction(() => !!window.__qa, undefined, { timeout: 5000 });
          const prefs = await p.evaluate(() => window.__qa.prefs());
          const cur = await p.evaluate(() => window.__qa.current());
          if (!prefsSubsetEqual(prefs, pers.expected))
            throw new Error(`reload ${i + 1} prefs 漂移:${JSON.stringify(prefs)}`);
          if (cur !== initial) throw new Error(`reload ${i + 1} current="${cur}", expected initial "${initial}"`);
        }
      } catch (err) {
        check.failures.push({ error: String(err.message || err).slice(0, 300), screenshot: await failShot('C-persistence') });
      }
      check.pass = check.failures.length === 0;
      gateC.checks.push(check);
    }
    gateC.pass = gateC.checks.length > 0 && gateC.checks.every((c) => c.pass);
  }

  // ---------- 门 D:渲染绑定 ----------
  const bindings = spec.bindings ?? [];
  let gateD;
  if (!runGate('D')) gateD = skippedGate('渲染绑定');
  else {
    gateD = makeGate('渲染绑定', bindings.length * cases.length);
    if (bindings.length === 0) {
      gateD.pass = true;
      // 组件模式下 bindings 为空不等于「渲染层未验证」:渲染由产品代码路径本身承载,
      // 其源码 + bundle 已进 inputHashes 防伪链。仅改声明文案,判定逻辑不变。
      gateD.detail = spec.component?.mode === 'component'
        ? '组件模式:渲染由产品代码路径承载(源码 hash 入链),chrome 层可选配 bindings'
        : 'spec.bindings 未配置——渲染层未验证,还原承诺只到数据层';
    } else {
      for (const testCase of cases) {
        const p = await pageFor(testCase);
        for (const b of bindings) {
          const label = `${testCase.id} · ${b.sel} · ${b.prop}`;
          try {
            const raw = truthAt(truthObj, b.truth);
            if (raw === undefined) throw new Error(`truth 路径不存在:${b.truth}`);
            await freshLoad(p, base, { adaptive: !!spec.adaptive });
            await applyCase(p, testCase);
            await replay(p, b.via ?? []);
            const actual = await p.evaluate(({ sel, prop, pseudo }) => {
              const el = document.querySelector(sel);
              return el ? getComputedStyle(el, pseudo || null).getPropertyValue(prop).trim() : null;
            }, { sel: b.sel, prop: b.prop, pseudo: b.pseudo });
            if (actual === null) throw new Error('元素不存在');
            const kind = b.kind ?? (b.prop.includes('color') ? 'color' : 'length');
            if (kind === 'color') {
              const result = await p.evaluate(({ raw, actual }) => {
                const bad = /\b(inherit|currentColor|unset|initial|revert|revert-layer)\b|var\(/i;
                if (typeof raw !== 'string' || bad.test(raw) || !CSS.supports('color', raw))
                  return { ok: false, error: `非法或上下文相关 color truth:${raw}` };
                const norm = (color) => {
                  const d = document.createElement('div');
                  d.style.color = color;
                  document.body.appendChild(d);
                  const v = getComputedStyle(d).color;
                  d.remove();
                  return v;
                };
                return { ok: true, expected: norm(raw), actual: norm(actual) };
              }, { raw, actual });
              if (!result.ok) throw new Error(result.error);
              if (result.expected !== result.actual)
                throw new Error(`expected ${result.expected}, actual ${result.actual}`);
            } else if (kind === 'length') {
              const scale = b.scaled ? await p.evaluate(() => window.__qa.scale()) : 1;
              if (!Number.isFinite(Number(scale)) || Number(scale) <= 0) throw new Error(`__qa.scale 非 finite positive:${scale}`);
              const result = await p.evaluate((raw) => {
                if (typeof raw === 'number') return Number.isFinite(raw) ? { ok: true, px: raw } : { ok: false, error: 'length truth 非 finite number' };
                if (typeof raw !== 'string') return { ok: false, error: `非法 length truth:${raw}` };
                // 拒绝上下文相关单位——%/em/rem/vw/vh/vmin/vmax/ch/ex/cap/ic/lh/rlh/vi/vb/q、
                // calc()/var()/env()/attr()/clamp()/min()/max():它们的 px 取决于容器/字号/视口,
                // 在临时 div 上下文解析出的 px 与目标元素上下文不一致 → 会把错误样式判等(codex 复审 P0-6)。
                // truth 的几何应是产品常量的绝对 px(extract 提取的就是 px),故只允许绝对长度。
                if (/[a-z%(]/i.test(raw.replace(/^-?\d*\.?\d+\s*(px|pt|pc|cm|mm|in|Q)?$/i, '')))
                  return { ok: false, error: `length truth 含上下文相关单位/函数,禁用(只允许绝对 px/pt/pc/cm/mm/in/Q 或无单位数):${raw}` };
                const m = /^(-?\d*\.?\d+)\s*(px|pt|pc|cm|mm|in|Q)?$/i.exec(raw.trim());
                if (!m) return { ok: false, error: `非法或非绝对 CSS length:${raw}` };
                const d = document.createElement('div');
                d.style.width = `${m[1]}${m[2] ?? 'px'}`;
                d.style.position = 'absolute';
                d.style.visibility = 'hidden';
                document.body.appendChild(d);
                const px = parseFloat(getComputedStyle(d).width);
                d.remove();
                return Number.isFinite(px) ? { ok: true, px } : { ok: false, error: `CSS length 无法解析为 px:${raw}` };
              }, raw);
              if (!result.ok) throw new Error(result.error);
              const expectedPx = result.px * Number(scale);
              const actualPx = parseFloat(actual);
              if (!Number.isFinite(actualPx) || Math.abs(actualPx - expectedPx) > (b.tolerancePx ?? 0.75))
                throw new Error(`expected ${expectedPx}px, actual ${actual}`);
            } else if (kind === 'text') {
              const actualText = await p.locator(b.sel).first().textContent({ timeout: 4000 });
              if (String(raw) !== actualText.trim()) throw new Error(`expected text "${raw}", actual "${actualText.trim()}"`);
            } else if (kind === 'asset-sha') {
              const assetUrl = await p.evaluate(({ sel, prop, pseudo }) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                if (prop === 'src') return el.currentSrc || el.getAttribute('src');
                if (prop === 'href') return el.href || el.getAttribute('href');
                const value = getComputedStyle(el, pseudo || null).getPropertyValue(prop).trim();
                const m = value.match(/^url\(["']?(.+?)["']?\)$/);
                return m ? m[1] : value;
              }, { sel: b.sel, prop: b.prop, pseudo: b.pseudo });
              if (!assetUrl) throw new Error('元素不存在或 asset URL 为空');
              const resolved = new URL(assetUrl, base);
              if (resolved.origin !== new URL(base).origin) throw new Error(`asset-sha 只允许同源本地资源:${resolved.href}`);
              const response = await fetch(resolved);
              if (!response.ok) throw new Error(`asset 读取失败:${response.status} ${resolved.pathname}`);
              const actualSha = sha256Buffer(Buffer.from(await response.arrayBuffer()));
              const expectedSha = normalizeHash(raw);
              if (actualSha !== expectedSha) throw new Error(`expected sha256 ${expectedSha}, actual ${actualSha}`);
            } else if (String(raw) !== actual) {
              throw new Error(`expected "${raw}", actual "${actual}"`);
            }
            gateD.passed++;
          } catch (err) {
            gateD.failures.push({ binding: label, error: String(err.message || err).slice(0, 300), screenshot: await failShot(`D-${testCase.id}-${b.prop}`) });
          }
        }
        gateD.cases.push({ id: testCase.id, prefs: testCase.prefs });
      }
      gateD.pass = gateD.failures.length === 0;
    }
  }

  // ---------- 门 F:适配还原 ----------
  const ad = spec.adaptive;
  let gateF;
  if (!runGate('F')) gateF = skippedGate('适配还原');
  else {
    gateF = makeGate('适配还原', 0);
    if (!ad) {
      gateF.pass = true;
      gateF.detail = 'spec.adaptive 未配置——窗口拉伸行为未验证';
    } else {
      const samples = truthAt(truthObj, 'adaptive.samples') ?? [];
      const tol = ad.tolerancePx ?? 1;
      const probes = ad.probes ?? [];
      const frameSel = ad.frameSel ?? spec.baselineFrameSel ?? '.frame';
      gateF.total = samples.length + (ad.min ? 1 : 0);
      if (samples.length === 0) gateF.failures.push({ check: 'samples', error: 'truth.adaptive.samples 为空——extract 未按 sampleSizes 预计算期望几何' });
      // sampleSizes ↔ truth.samples 一一覆盖:声明了采样点却没预计算 = FAIL(不许缺采样点静默过)
      for (const [sw, sh] of ad.sampleSizes ?? []) {
        if (!samples.some((s) => s.w === sw && s.h === sh))
          gateF.failures.push({ check: `${sw}x${sh}`, error: 'sampleSizes 声明但 truth.samples 无对应期望几何' });
      }
      const finite = (v) => typeof v === 'number' && Number.isFinite(v);
      try {
        const p = await pageFor({});
        await freshLoad(p, base, { adaptive: true });
        for (const s of samples) {
          try {
            // resize 是控制 API;几何由 verifier 侧直接量 DOM(measureAdaptive),不信页面自报
            await p.evaluate(({ w, h }) => window.__qa.resize(w, h), { w: s.w, h: s.h });
            const m = await measureAdaptive(p, frameSel, probes);
            if (!finite(m.frame.w) || !finite(m.frame.h) || Math.abs(m.frame.w - s.w) > tol || Math.abs(m.frame.h - s.h) > tol)
              throw new Error(`resize(${s.w},${s.h}) 后 DOM 帧为 ${m.frame.w}x${m.frame.h}`);
            for (const probe of probes) {
              const want = s.probes?.[probe.id];
              const got = m.probes?.[probe.id];
              if (!want) { gateF.failures.push({ check: `${s.w}x${s.h}·${probe.id}`, error: 'truth 采样点缺该 probe 期望几何' }); continue; }
              if (!got) { gateF.failures.push({ check: `${s.w}x${s.h}·${probe.id}`, error: `probe selector ${probe.sel} 量不到 DOM 几何` }); continue; }
              for (const k of ['x', 'y', 'w', 'h']) {
                if (want[k] === undefined) continue;
                if (!finite(got[k]) || !finite(want[k]) || Math.abs(got[k] - want[k]) > tol)
                  gateF.failures.push({ check: `${s.w}x${s.h}·${probe.id}.${k}`, expected: want[k], actual: got[k] });
              }
            }
            gateF.passed++;
          } catch (err) {
            gateF.failures.push({ check: `${s.w}x${s.h}`, error: String(err.message || err).slice(0, 300), screenshot: await failShot(`F-${s.w}x${s.h}`) });
          }
        }
        if (ad.min) {
          await p.evaluate(({ w, h }) => window.__qa.resize(w, h), { w: Math.max(1, ad.min.w - 120), h: Math.max(1, ad.min.h - 120) });
          const m = await measureAdaptive(p, frameSel, []);
          if (!finite(m.frame.w) || !finite(m.frame.h) || Math.abs(m.frame.w - ad.min.w) > tol || Math.abs(m.frame.h - ad.min.h) > tol)
            gateF.failures.push({ check: 'min-clamp', expected: `${ad.min.w}x${ad.min.h}`, actual: `${m.frame.w}x${m.frame.h}` });
          else gateF.passed++;
        }
      } catch (err) {
        gateF.failures.push({ check: 'api', error: String(err.message || err).slice(0, 300) });
      }
      gateF.pass = gateF.failures.length === 0;
    }
  }

  /* ── r11 P0:把「当时被观察的字节」搬进父进程内存并冻结,**必须在执行任何 demo 侧代码之前** ──
     成因:snapshot 与 exec 树同处用户可枚举、可写的 os.tmpdir();custom gate 是任意 Node 代码,
     枚举 `qa-hifi-snapshot-*` + 按 spec.json 的 meta.name 认出本次快照,再把 snapshot 与 disk
     **同步**改成相同字节 —— 收口的 snapshot⟷disk 比对于是报全等,而交付页面已经是错的。
     审核人的定性:「manifest 证明的只是『两个当前可变对象现在相等』,不再证明『最终交付等于
     当时被观察的字节』」。随机后缀只防猜、不防同权限枚举,所以不去挡枚举(挡不住),而是把
     oracle 搬到子进程碰不到的地方 —— 父进程内存,冻结,不落盘。收口只与它比。 */
  if (snapshotDir) frozenSnapshot = captureFrozenManifest(snapshotDir);

  /* ══════════ 分界线:以下开始执行 demo 侧代码(r7 条目 1) ══════════
     以上所有**核心观察**已完成:门 A 的静态段与三项可信侧字节复算、门 B/C/D/F 的全部
     浏览器实测。以下两段(门 A 的 extractor drift、门 X 的自定义门)都要跑 demo 目录里的
     Node 脚本,一旦执行,被审方就能派 detached 子进程改磁盘 —— 所以它们必须在这里,
     而不是像 r6 那样排在最前面。禁止把任何观察性检查移到本分界线之下。 */

  /* ── demo 侧脚本的执行封装(r7 条目 10④⑤) ──
     ④ 杀净子进程:用 detached 起一个**新进程组**跑它,返回后无条件 kill 整组 —— 脚本自己
        起的同组后台进程不会活过这一步。诚实标注:如果脚本刻意用 detached 再起孙进程,
        孙进程会拿到自己的新组,这一招杀不到它(那条路由「核心观察早于执行 demo 代码」兜)。
     ⑤ 字节绑定:执行前就地算一次脚本 sha256 并记进 report,与观察前 inputHashes 里那份
        比对 —— 「注册的是 A 脚本、跑的是 B 脚本」在这里落地。 */
  function runDemoScript(scriptAbs, extraArgs = [], { timeout } = {}) {
    /* r8 条目 C:执行**已 hash 的那份字节的副本**,不是 hash 完再按同一路径 spawn。
       后者中间有窄 check/use 竞态:hash 与 spawn 之间的写入者可以换掉文件,于是
       「精确 hash 的脚本字节被执行」这句话不成立。副本落在 demo 之外的 output root,
       被审方的后置脚本改不到它。copy 后再算一次副本 hash,不等即 fail-closed。
       r10 P0:副本是**整棵树**(字节取自观察快照),不再是单文件 —— 单文件搬走之后 ESM 的
       相对 import 解析不到兄弟模块,而 init.mjs 生成的官方 extract.mjs 模板就 import
       `./extract-helpers.mjs`。整树副本让相对 import 天然可用,同时保住「执行的字节 ≡ 已 hash
       的字节」(树内那份复算 hash 后与磁盘 hash 比对)。详见 observe.trustedScriptCopy。
       注意(接口约定):被执行的是副本,所以脚本必须用 `--demo` argv 或 cwd(仍是 demoDir)
       定位 demo,**不能**靠 `import.meta.url` 推断自己在 demo 里 —— 已写进 SKILL.md。 */
    const copy = trustedScriptCopy(scriptAbs, outputRoot, { demoDir, sourceTree: snapshotDir ?? demoDir });
    const sha = copy.sha256;
    if (copy.mismatch) {
      /* r10:mismatch 现在覆盖两种形态 —— ① hash 与复制之间源文件被换过;
         ② 磁盘字节与观察快照字节本就不一致(exec 树的字节来自快照)。两者都意味着
         「要执行的字节 ≠ 已 hash 的字节」,一律拒执行。missingInTree = 脚本在快照里根本不存在。 */
      const why = copy.missingInTree
        ? `脚本在可信执行树里不存在(${copy.missingInTree})——磁盘上有、观察快照里没有`
        : `要执行的字节与已 hash 的字节不一致(磁盘 ${sha} → 可信树 ${copy.copySha256})——拒绝执行`;
      return { status: 1, stdout: '', stderr: why, scriptSha256: sha, trustedCopyMismatch: true };
    }
    /* r11 纵深:exec 树逐次从快照复制,而快照住在可枚举可写的 tmpdir —— 前一个脚本改了快照,
       后一个脚本的 exec 树就会带上被污染的**兄弟模块**(入口脚本本身有 hash 绑定,兄弟模块没有)。
       这不构成越权(gate1 与 gate2 同属一个作者),但会让「exec 树的兄弟模块字节 ≡ 观察态字节」
       这句话变假。这里拿分界线前冻结的内存 manifest 逐条校一遍刚复制出来的树,不符即拒绝执行 ——
       于是那句话恒真。frozenSnapshot 为空(只跑门 X、没有快照)时跳过,并在下面如实标注。 */
    if (frozenSnapshot && copy.tree) {
      const treeDiff = diffAgainstFrozen(frozenSnapshot, copy.tree);
      if (treeDiff.all.length) {
        return {
          status: 1,
          stdout: '',
          stderr: '可信执行树的字节与观察时冻结的 manifest 不一致('
            + `${treeDiff.all.slice(0, 5).join('、')})——观察快照在本次验收过程中被改写过,拒绝执行`,
          scriptSha256: sha,
          trustedTreeDrift: treeDiff.all.slice(0, 10),
        };
      }
    }
    const res = spawnSync(process.execPath, [copy.exec, ...extraArgs], {
      cwd: demoDir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      detached: true,           // 新进程组 → 下面能整组回收
      ...(timeout ? { timeout } : {}),
    });
    if (res.pid) {
      // 整组回收(best-effort:进程组可能已空;Windows 无进程组语义,失败即忽略)
      try { process.kill(-res.pid, 'SIGKILL'); } catch {}
    }
    return { ...res, scriptSha256: sha };
  }

  // ---------- 门 A 第三段:extractor drift(执行 demo/extract.mjs) ----------
  // 现算结果必须 ≡ truth.json;证明 truth 真由源码提取,不是手抄 value + 内嵌块蒙混。
  if (!gateA.skipped) {
    const extractor = join(demoDir, 'extract.mjs');
    if (!existsSync(extractor)) {
      gateA.extractorDrift = 'no-extractor';
      gateA.detail = [gateA.detail, '缺 extract.mjs——无法证明 truth 由源码提取(只有 provenance hash 声明,不构成机械证明);请补 extractor'].filter(Boolean).join('\n');
    } else {
      const run = runDemoScript(extractor, ['--demo', demoDir]);
      gateA.extractorSha256 = run.scriptSha256;
      try {
        if (run.status !== 0) throw new Error(String(run.stderr || run.stdout || `exit ${run.status}`));
        const fresh = run.stdout;
        if (stableJson(JSON.parse(fresh)) === stableJson(truthObj)) gateA.extractorDrift = 'none';
        else {
          gateA.extractorDrift = 'drift';
          gateA.detail = [gateA.detail, 'extract.mjs 现算结果与 truth.json 漂移——truth 被手改或源码已变,重跑 truth.mjs 生成'].filter(Boolean).join('\n');
        }
      } catch (err) {
        gateA.extractorDrift = 'error';
        gateA.detail = [gateA.detail, `extract.mjs 执行失败:${String(err.stderr || err.message).slice(0, 200)}`].filter(Boolean).join('\n');
      }
    }
    gateA.pass = !gateAHardFail && gateA.extractorDrift === 'none';
  }

  // ---------- 门 X:自定义门(demo 专属体外脚本,注册进防伪链) ----------
  // 背景:多个真实 demo 自建了 overlap-gate.mjs / interaction-gate.mjs 等体外脚本,
  // 不进 report/hash 链——pr-block 不知道它们跑没跑。注册进 spec.customGates 后:
  // 脚本 hash 计入 inputHashes(改脚本 = report 失效),结果计入 report.ok。
  const customGates = spec.customGates ?? [];
  let gateX;
  if (!runGate('X')) gateX = skippedGate('自定义门');
  else {
    gateX = { name: '自定义门', pass: false, total: customGates.length, passed: 0, failures: [], gates: [] };
    if (customGates.length === 0) {
      gateX.pass = true;
      gateX.detail = '未声明 customGates';
    } else {
      for (const g of customGates) {
        const entry = { id: g.id, script: g.script, pass: false, detail: '' };
        /* 门 X 能声称的只有:「**精确 hash 的**注册脚本被可信 runner 执行且 exit 0」这个执行事件。
           脚本本身是 demo 代码,它的业务判断是否正确工具证明不了(r7 条目 10,PR 文案已降准)。 */
        const run = runDemoScript(join(demoDir, g.script), ['--demo', demoDir], { timeout: Number(g.timeoutMs ?? 180000) });
        entry.scriptSha256 = run.scriptSha256;
        // ⑤ 实际执行的字节必须等于观察前入链的那份(注册 A 脚本、跑 B 脚本在这里落地)
        const chained = inputHashes.customGates?.[g.script];
        if (chained && run.scriptSha256 && chained !== run.scriptSha256) {
          entry.detail = `执行的脚本字节(${run.scriptSha256})与观察前入链的那份(${chained})不一致——脚本在验收过程中被换过`;
          gateX.failures.push({ gate: g.id, error: entry.detail });
        } else if (run.status === 0) {
          entry.pass = true;
          entry.detail = String(run.stdout ?? '').trim().split('\n').slice(-3).join('\n').slice(0, 400);
          gateX.passed++;
        } else {
          entry.detail = String(run.stdout || run.stderr || `exit ${run.status}`).slice(-400);
          gateX.failures.push({ gate: g.id, error: entry.detail });
        }
        gateX.gates.push(entry);
      }
      gateX.pass = gateX.failures.length === 0;
    }
  }

  /* ── 事后输入 hash 复算(r7 条目 1,纵深防御而非主防线) ──
     demo 侧代码(extract.mjs / 自定义门)执行完之后,把 inputHashes 再算一次,与观察前那份
     比对。它抓的是「跑完 demo 代码后磁盘已经不是我们观察的那份」这种情形。
     诚实标注:攻击可以在父进程退出后才恢复原文件,从而让前后两次 hash 都自洽 ——
     所以这一条**不是**主防线,主防线是「核心观察全部排在执行 demo 代码之前」。 */
  const inputHashesPost = buildInputHashes(demoDir, spec);
  if (!gateA.skipped && snapshotDir && frozenSnapshot) {
    /* I-OBSERVE 的收口比对:快照(观察对象)与磁盘逐字节比对。比单纯的 hash-vs-hash 更强 ——
       快照住在 demo 之外,demo 侧代码碰不到它,所以「改了又恢复」在这里同样无处可藏的前提是
       改动发生在快照建立之后且未复原;真正的保证仍来自「观察对象一开始就固定了」。 */
    /* 运行期兜底:页面在观察期间请求过**快照之外**的路径(只剩 node_modules/ 与 .git/)。
       静态扫描看不见动态构造的 URL,而服务的是快照,所以这类请求在服务端留下的是一次 404 记录。 */
    const outsideHits = [...new Set((safeServer?.requestedPaths() ?? [])
      .filter((r) => isSkippedRel(r.path))
      .map((r) => `${r.path}(HTTP ${r.status})`))];
    gateA.requestsOutsideSnapshot = outsideHits.length ? outsideHits.slice(0, 10) : 'none';
    if (outsideHits.length) {
      gateA.pass = false;
      gateA.detail = [
        gateA.detail,
        `页面在观察期间请求了快照之外的路径(${outsideHits.slice(0, 5).join('、')})——`
        + '验证时取不到、交付原地却可能取到:被验证的页面与交付的页面不同。',
      ].filter(Boolean).join('\n');
    }
    /* ⑥ 收口:双向比对(r8 条目 A)。disk→观察态 与 观察态→disk 都遍历 —— 单向 walk 看不见
       「验收期间新增页面可达文件」这一整类,而审核人 PoC 用的就是「加一个 late.js」。
       工具自己的运行期输出已经全部写在 demo 之外的 output root,所以这里不需要任何按名豁免。
       r11 P0:基准**不再是 snapshot 文件树**,而是分界线前冻结的内存 manifest ——
       snapshot 与 exec 树同处可枚举可写的 tmpdir,后置脚本能把两边同步改成相同字节让
       snapshot⟷disk 报全等(见分界线处注释)。换成内存基准之后,「同步改 snapshot + disk」失效:
       子进程改不到父进程内存。冻结 manifest 是 snapshot **整树**,因此也覆盖了
       buildInputHashes 窄范围之外的文件(PoC 的 late.js 正是这一类)。 */
    const diff = { when: 'post-run', ...diffAgainstFrozen(frozenSnapshot, demoDir) };
    gateA.snapshotDrift = diff.all.length ? diff.all.slice(0, 10) : 'none';
    gateA.snapshotManifest = { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length };
    if (diff.all.length) {
      gateA.pass = false;
      gateA.detail = [
        gateA.detail,
        `验收期间 demo 侧文件与观察快照发生偏离(新增 ${diff.added.length} / 删除 ${diff.removed.length} / 改写 ${diff.changed.length}):`
        + `${diff.all.slice(0, 5).join('、')}`
        + '\n(基准是分界线前冻结在父进程内存里的观察态字节,不是 tmp 下那棵仍可被改写的快照树)'
        + '\n浏览器观察用的是验证开始时的不可变快照,所以本次测量结果本身仍然可信;'
        + '但磁盘上的 demo 已不是被观察的那一份,PR 带走的会是另一个版本。'
        + '\n修法:extract.mjs 与自定义门必须只读,不得改写或新增 demo 文件。',
      ].filter(Boolean).join('\n');
    }
  }
  if (!gateA.skipped) {
    const same = sameInputHashes(inputHashes, inputHashesPost);
    gateA.postRunHashRecheck = same ? 'ok' : 'mismatch';
    if (!same) {
      gateA.pass = false;
      gateA.detail = [
        gateA.detail,
        '执行 demo 侧代码(extract.mjs / 自定义门)之后,输入 hash 与观察前不一致——'
        + 'demo 代码在本次验收过程中改写了自己的输入文件(index.html / assets / truth 等),'
        + '本次所有测量结果都不可信。\n修法:extract.mjs 与自定义门必须是只读的,不得改写 demo 输入。',
      ].filter(Boolean).join('\n');
    }
  }

  const gatesRun = [gateA, gateB, gateC, gateD, gateF, gateX].filter((g) => !g.skipped);
  const allPass = gatesRun.every((g) => g.pass);
  const statesResult = {
    total: spec.states.length,
    viaReachable: spec.states.filter((s) => Array.isArray(s.via)).length,
    tabOnly: spec.states.filter((s) => s.via === null).length,
  };
  const report = {
    ok: allPass,
    partial,
    ...(partial ? { filters: { gates: gateFilter ?? null, cases: caseFilter ?? null, states: stateFilter ?? null }, partialNote: '增量运行仅供调试;定稿必须全量重跑 verify(pr-block 拒收 partial 报告)' } : {}),
    toolVersion: TOOL_VERSION,
    demo: spec.meta?.name ?? demoDir,
    inputHashes,
    statesResult,
    /* r7 条目 9:fixture 叶子计数在**观察前**就地统计好,进 report 由 PR 渲染器取用。
       pr-block 原先在流程末尾重读 demo 的 truth.json —— 那是 TOCTOU 变体(demo 代码可能
       已在中途改过它),现在末尾不再重读任何可变文件。 */
    truthStats: { fixtureLeaves: countFixtureLeaves(truthObj) },
    /* r8 条目 A:工具运行期输出(失败截图、门 X/extractor 的可信脚本副本)不再写进 demo 树,
       改落这个 demo 之外的 output root。failure 条目里的 screenshot 是相对本根的路径。 */
    artifactRoot: outputRoot,
    coverage: { cases: cases.map((c) => ({ id: c.id, prefs: c.prefs, source: c.source, ...(c.viewport ? { viewport: c.viewport } : {}) })) },
    gateA,
    gateB,
    gateC,
    gateD,
    gateF,
    gateX,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(reportOut, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = allPass ? 0 : 2;
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err.message || err), toolVersion: TOOL_VERSION }, null, 2));
  process.exitCode = 2;
} finally {
  try { if (page) await page.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  try { if (safeServer) await safeServer.close(); } catch {}
  // 快照是临时观察对象,跑完即删(留着只会在 tmp 里堆垃圾)
  try { if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true }); } catch {}
}
