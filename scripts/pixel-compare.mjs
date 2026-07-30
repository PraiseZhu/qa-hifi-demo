#!/usr/bin/env node
// pixel-compare.mjs — 门 E 像素基准比对(Node 可信侧 PNG 解码/比较/热图)。
//
// 门 E 不在 verify.mjs 的 GATE_LETTERS 里,它的**可信侧来源就是本脚本**:r6 起 pr-block
// 在定稿出块前会亲自 spawn 它(--report-out 写到 demo 之外),以自己重跑的结果为放行依据;
// demo 里的 report-pixel.json 降级为仅供对账的自报材料。r5 之前 pr-block 只对那份自报做
// 算术自洽校验(diffRatio===bad/total、threshold===spec…),从不重新对真实图片跑
// odiff/pixelmatch —— 手写一份满足全部自洽约束的 JSON 就能把视觉回归伪造成 PASS。

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildInputHashes,
  failJson,
  failProblems,
  sha256Buffer,
  TOOL_VERSION,
} from './lib/fs-utils.mjs';
import { validateSpec } from './lib/schema.mjs';
import { createSafeStaticServer } from './lib/safe-server.mjs';
import { launchChromium } from './lib/resolve-playwright.mjs';
import { freshLoad, replay } from './lib/replay.mjs';
import { compareImages, loadPngApi, readPng, writePng } from './lib/png-compare.mjs';
/* r8 条目 A:门 E 此前**完全不走快照** —— 直接 serve/read demoDir 与 baseline PNG,于是
   「所有核心浏览器观察共用同一不可变快照」这句话对门 E 不成立(审核人指出的组成性不一致)。
   现在与 verify 共用同一份实现:整树快照(含 baseline PNG)+ 双向 manifest。 */
import { makeObservationSnapshot, snapshotManifestDiff } from './lib/observe.mjs';

const args = process.argv.slice(2);
const demoIdx = args.indexOf('--demo');
if (demoIdx === -1 || !args[demoIdx + 1]) failJson('缺 --demo <dir>');
const demoDir = resolve(args[demoIdx + 1]);
/* --report-out <file>:把门 E 报告写到指定路径而不是 <demo>/report-pixel.json。
   供 pr-block 在**可信侧亲自重跑门 E**时使用(r6 条目 2):重跑结果落在 demo 之外,
   既不覆盖作者的 report-pixel.json(要留着对账),也不让被审对象碰到我们的裁决依据。
   注意:比对用的 artifact 图仍写在 demo 的 pixel-artifacts/ —— WARN 人工裁决要看图,
   而可信侧重跑正好把那三张图换成**我们自己生成的**,裁决从此绑在可信产物上。 */
const reportOutIdx = args.indexOf('--report-out');
if (reportOutIdx !== -1 && !args[reportOutIdx + 1]) failJson('--report-out 需要一个文件路径');
const reportOut = reportOutIdx !== -1 ? resolve(args[reportOutIdx + 1]) : join(demoDir, 'report-pixel.json');

let spec;
try {
  spec = JSON.parse(readFileSync(join(demoDir, 'spec.json'), 'utf8'));
} catch (err) {
  failProblems([`spec.json 解析失败:${err.message}`]);
}
const problems = validateSpec(spec);
if (problems.length) failProblems(problems.map((p) => `spec: ${p}`));

const threshold = spec.baselineThreshold ?? 0.005;
if (!Number.isFinite(Number(threshold)) || Number(threshold) < 0 || Number(threshold) > 0.2)
  failProblems(['baselineThreshold 必须在 [0,0.2] 内']);

const declared = spec.baselines ?? [];
if (declared.length === 0) {
  const out = {
    ok: true,
    skipped: true,
    toolVersion: TOOL_VERSION,
    reason: 'spec.baselines 为空——像素级未比对',
    inputHashes: buildInputHashes(demoDir, spec),
  };
  writeFileSync(reportOut, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const { PNG, pixelmatch, odiff } = await loadPngApi(demoDir);
/* I-OBSERVE(r8 条目 A):门 E 的观察对象也是**整树不可变快照** —— 页面从快照加载,
   baseline PNG 也从快照读。artifact 三图仍写回 demo 的 pixel-artifacts/(WARN 人工裁决要按
   demo 相对路径看图,r7/r8 的裁决绑定就建立在这份路径上),但**写入排在双向 manifest 检查之后**:
   比对期间 demo 树零写入,manifest 因此不需要任何按名豁免。 */
const snapshotDir = makeObservationSnapshot(demoDir, { prefix: 'qa-hifi-pixel-snap-' });
const artifactDir = join(demoDir, 'pixel-artifacts');
/** 比对期间先把三图字节留在内存,manifest 检查通过后再落盘(见上)。 */
const pendingArtifacts = [];
let safeServer;
let browser;
let page;
const results = [];
try {
  safeServer = createSafeStaticServer(snapshotDir);   // 服务快照,不是 demo 原地
  const base = await safeServer.listen();
  ({ browser } = await launchChromium(demoDir, { headless: true }));
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: spec.baselineDpr ?? 2 });

  for (const entry of declared) {
    const item = { key: entry.key, status: 'ERROR', diffRatio: null, bad: 0, total: 0, masked: 0, detail: '' };
    // 分端基准(gate-e-v2):声明 platform → baselines/<platform>/<key>.png;未声明 → 兼容旧平铺。
    // 比对目标始终是 demo 渲染帧;不同 platform 的基准只各自与 demo 比,彼此永不互比。
    if (entry.platform) item.platform = entry.platform;
    const artKey = entry.platform ? `${entry.platform}.${entry.key}` : entry.key;
    const baselineRel = entry.platform ? `baselines/${entry.platform}/${entry.key}.png` : `baselines/${entry.key}.png`;
    const baselinePath = join(snapshotDir, baselineRel);   // 基准图同样取自快照
    try {
      if (!existsSync(baselinePath)) {
        item.status = 'MISSING';
        item.detail = `缺少基准图 ${baselineRel}`;
        results.push(item);
        continue;
      }
      await freshLoad(page, base, { clearStorage: true, adaptive: !!spec.adaptive });
      await replay(page, entry.via ?? []);
      const sel = entry.frameSel ?? spec.baselineFrameSel ?? '.frame';
      const loc = page.locator(sel).first();
      const box = await loc.boundingBox({ timeout: 4000 });
      if (!box) throw new Error(`截图元素不可见:${sel}`);
      const shot = await loc.screenshot();
      const baseline = readPng(PNG, baselinePath);
      const actual = readPng(PNG, shot);
      const compared = await compareImages({
        PNG,
        pixelmatch,
        odiff,
        engine: process.env.QA_HIFI_COMPARE_ENGINE,
        baseline,
        actual,
        baselineRaw: readFileSync(baselinePath),
        actualRaw: shot,
        cssSize: { width: box.width, height: box.height },
        masks: entry.mask ?? [],
        threshold: spec.pixelmatchThreshold ?? 0.1,
        maxMaskRatio: entry.maxMaskRatio ?? spec.maxMaskRatio ?? 0.25,
        minUnmaskedRatio: entry.minUnmaskedRatio ?? spec.minUnmaskedRatio ?? 0.5,
      });
      item.engine = compared.engine ?? null;
      if (compared.engineNote) item.engineNote = compared.engineNote;
      item.sidecar = {
        dpr: compared.dpr ?? { x: actual.width / box.width, y: actual.height / box.height },
        viewport: page.viewportSize(),
        host: { platform: process.platform, arch: process.arch },
        appCommit: process.env.GIT_COMMIT ?? process.env.CI_COMMIT_SHA ?? null,
        screenshot: { width: actual.width, height: actual.height },
        cssFrame: { width: box.width, height: box.height },
        sourceHash: buildInputHashes(demoDir, spec)['index.html'],
        compareEngine: compared.engine ?? null,
      };
      if (compared.status !== 'OK') {
        item.status = 'ERROR';
        item.detail = compared.detail;
      } else {
        item.bad = compared.bad;
        item.total = compared.total;
        item.masked = compared.masked;
        item.diffRatio = compared.total ? compared.bad / compared.total : 1;
        item.status = item.diffRatio <= threshold ? 'PASS' : 'WARN';
        item.detail = item.status === 'PASS'
          ? ''
          : `diff ${(item.diffRatio * 100).toFixed(2)}% 超阈值 ${(threshold * 100).toFixed(2)}%`;
        const bytes = {
          baseline: readFileSync(baselinePath),
          demo: shot,
          diff: PNG.sync.write(compared.diff),
        };
        item.artifacts = {
          baseline: `pixel-artifacts/${artKey}.baseline.png`,
          demo: `pixel-artifacts/${artKey}.demo.png`,
          diff: `pixel-artifacts/${artKey}.diff.png`,
        };
        // 落盘推迟到双向 manifest 之后(比对期间 demo 树必须零写入)
        for (const kind of ['baseline', 'demo', 'diff'])
          pendingArtifacts.push({ file: join(artifactDir, `${artKey}.${kind}.png`), data: bytes[kind] });
        /* r7 条目 8:artifact 三图的 **sha256** 一并记进 report。
           它是「人工裁决判的是哪三张图」的唯一凭据 —— 只校验路径存在是不够的:
           路径可以指向后来被换掉的图,裁决就绑不住任何具体字节。可信侧重跑会覆盖这三张图,
           于是 report 里的 hash 就是**可信侧生成字节**的 hash。 */
        item.artifactHashes = {
          baseline: sha256Buffer(bytes.baseline),
          demo: sha256Buffer(bytes.demo),
          diff: sha256Buffer(bytes.diff),
        };
        const adj = readAdjudication(snapshotDir, artKey);   // 裁决文件是输入,同样取自快照
        if (item.status === 'WARN') {
          /* 裁决要能影响放行,前提是它**同时绑定这次比对的四项**(r8):
               key(含 platform 的复合 key) / diffRatio / threshold / 三图 sha256。
             r7 只绑三图字节 —— 挡得住「换图」,挡不住「换差异」:同一 key 上一次小幅 WARN 的
             裁决,在差异变大后只要三图跟着重跑更新,旧裁决的语义(判的是 0.1% 还是 8%)无人核对。
             人工裁决的是**当时那个具体差异**,差异变了就必须重新裁决;key 带 platform 则防止
             mac 端的裁决被 windows 端的 WARN 复用(基准本就分端存放、永不互比)。
             裁决文件本身仍是**人工裁决声明、不是机械测量** —— 工具只能保证「它判的是我们这次
             生成的那三张图、那个具体差异」,保证不了「判断本身对」。绑不上就不认(→ ok=false)。 */
          const reason = adjudicationMismatch(adj, {
            key: item.platform ? `${item.platform}/${entry.key}` : entry.key,
            diffRatio: item.diffRatio,
            threshold,
            artifactHashes: item.artifactHashes,
          });
          if (adj?.ok === true && !reason) item.adjudication = adj;
          else if (adj?.ok !== true) item.detail += '; 缺人工裁决 artifact';
          else {
            item.detail += `; ${reason}`;
            item.adjudicationRejected = { file: adj.file, reason };
          }
        }
      }
    } catch (err) {
      item.status = 'ERROR';
      item.detail = String(err.message || err).slice(0, 300);
    }
    results.push(item);
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err.message || err), toolVersion: TOOL_VERSION }, null, 2));
  process.exitCode = 2;
} finally {
  try { if (page) await page.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  try { if (safeServer) await safeServer.close(); } catch {}
}

/* 返回 null = 裁决绑定成立;返回字符串 = 拒收原因(会同时进 detail 与 adjudicationRejected)。
   四项字段全部要求**全等**:缺任一项点名缺哪个;不等则同时打印「裁决声明值 vs 本次现算值」,
   让人一眼看出这是旧裁决被复用,而不是「哪里格式不对」。 */
function adjudicationMismatch(adj, expected) {
  if (!adj) return '缺人工裁决 artifact';
  const REQUIRED = ['key', 'diffRatio', 'threshold', 'artifactHashes'];
  const missing = REQUIRED.filter((f) => adj[f] === undefined || adj[f] === null);
  if (missing.length)
    return `人工裁决缺字段 ${missing.join(' / ')}——WARN 裁决必须同时声明 ${REQUIRED.join(' / ')}(否则旧裁决可被复用到新的差异上)`;
  const KINDS = ['baseline', 'demo', 'diff'];
  const noHash = KINDS.filter((k) => typeof adj.artifactHashes[k] !== 'string');
  if (noHash.length) return `人工裁决 artifactHashes 缺 ${noHash.join(' / ')} 的 sha256(裁决无凭据)`;
  const badHash = KINDS.filter((k) => adj.artifactHashes[k] !== expected.artifactHashes[k]);
  if (badHash.length)
    return `人工裁决声明的 ${badHash.join(' / ')} sha256 与本次可信侧产出不符(图被换过 / 裁决是旧版)`;
  if (adj.key !== expected.key)
    return `人工裁决 key 不符:裁决声明 ${adj.key} vs 本次现算 ${expected.key}——裁决属于另一个 platform/baseline,不得跨端复用`;
  if (adj.diffRatio !== expected.diffRatio)
    return `人工裁决 diffRatio 与本次现算不符:裁决声明 ${adj.diffRatio} vs 本次现算 ${expected.diffRatio}——旧裁决被复用到新的差异上,必须针对当前差异重新裁决`;
  if (adj.threshold !== expected.threshold)
    return `人工裁决 threshold 与本次不符:裁决声明 ${adj.threshold} vs 本次现算 ${expected.threshold}——裁决判的不是当前阈值口径`;
  return null;
}

function readAdjudication(root, key) {
  for (const rel of [`adjudications/${key}.json`, `baselines/${key}.adjudication.json`]) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data && typeof data.reviewer === 'string' && typeof data.reason === 'string' && data.ok === true)
        return { ...data, file: rel };
    } catch {}
  }
  return null;
}

if (process.exitCode === 2) process.exit();

/* ── 双向 manifest 检查点 + artifact 落盘(r8 条目 A)──
   比对全程 demo 树零写入,所以这里可以对**整树**做双向比对而不需要任何按名豁免:
   disk→snapshot(新增)与 snapshot→disk(删除/改写)都遍历。通过之后才把三图写进 demo 的
   pixel-artifacts/ —— WARN 人工裁决按 demo 相对路径看图,这条路径契约保持不变。 */
const manifest = snapshotManifestDiff(snapshotDir, demoDir);
if (manifest.all.length === 0) {
  mkdirSync(artifactDir, { recursive: true });
  for (const a of pendingArtifacts) writeFileSync(a.file, a.data);
}
try { rmSync(snapshotDir, { recursive: true, force: true }); } catch {}

const ok = manifest.all.length === 0
  && results.every((r) => r.status === 'PASS' || (r.status === 'WARN' && r.adjudication?.ok === true));
const out = {
  ok,
  skipped: false,
  toolVersion: TOOL_VERSION,
  threshold,
  compared: results.filter((r) => r.status !== 'MISSING').length,
  declared: declared.length,
  inputHashes: buildInputHashes(demoDir, spec),
  // 门 E 的观察快照与磁盘的双向 manifest 结论(r8 条目 A);非 none 时 ok 强制 false
  snapshotDrift: manifest.all.length ? manifest.all.slice(0, 10) : 'none',
  snapshotManifest: { added: manifest.added.length, removed: manifest.removed.length, changed: manifest.changed.length },
  results,
  generatedAt: new Date().toISOString(),
};
writeFileSync(reportOut, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
process.exit(ok ? 0 : 2);
