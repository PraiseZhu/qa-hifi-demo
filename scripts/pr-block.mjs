#!/usr/bin/env node
// pr-block.mjs — 基于当前输入 hash + report 门统计生成 PR 验收附贴块。

import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAssetsManifest, checkDemoNoNodeModules, checkDemoNoSymlinks, failProblems, sameInputHashes, TOOL_VERSION } from './lib/fs-utils.mjs';
import { validateSpec } from './lib/schema.mjs';
import { validatePixelForPr, validatePixelReport, validateReportIntegrity } from './lib/report.mjs';
/* 门字母 ⟷ runner 的唯一机读映射 + taint 标记(r7 条目 7)。
   本文件**不许**再手写第二份门列表 —— 门 E 那个 CRITICAL 就是两份手写清单各自漏了它。 */
import { GATE_LETTERS, TRUSTED_GATES, gateKey, lettersFor, markTrustedRun } from './lib/gates.mjs';
import { renderPrBlock } from './lib/pr-render.mjs';

/* ══ r5 架构主线(P0-1 CRITICAL):放行依据必须由可信侧亲自算出来 ══
   总原则:**验证方绝不把 demo 目录产出的文件当作「某事已发生」的证明。**
   report.json 整份都住在 demo 目录里,是被审方可写的。r4 之前 pr-block 只校验它
   「自洽」:toolVersion 对、各 gate.pass=true、inputHashes 等于现算值——而 inputHashes
   是攻击者用可导出的 buildInputHashes() 对自己控制的文件现算的,天然自洽。于是:
   正常 build(真 esbuild、entry 真进图) + bootstrap 只 `void Button` 从不调用 + mount 里
   innerHTML 手搓 UI + **完全不跑 verify**、手写一份全 pass 的 report.json(gateB
   .entryRenderProof="proved"),pr-block 就 exit 0 并打出「真组件直渲」✅ ——
   那台机器上连 Playwright 都没装。
   r5 起(方案 A):定稿出块前 pr-block 用 **skill 仓自己那份 verify.mjs** 在可信侧
   把 A/B/C/D/F/X 门重跑一遍,以自己重跑的结果为唯一放行依据;demo 的 report.json 降级为
   仅供对账的自报材料(不一致要报),绝不再充当「verify 跑过且通过」的证明。

   r6 条目 2(CRITICAL)补上 r5 自己漏掉的门 E:verify 的 GATE_LETTERS 不含 E(门 E 住在
   pixel-compare.mjs),而 r5 的可信重跑投影比对门集合也硬编码 A/B/C/D/F/X —— 门 E 的唯一
   校验是 validatePixelForPr,它全是 report-pixel.json 自身的字段算术自洽,**从不重新对真实
   图片跑 odiff/pixelmatch**。于是手写一份满足全部自洽约束的 report-pixel.json(inputHashes
   用可导出的 buildInputHashes 现算、计数一致、diffRatio<=threshold、engine 合法、WARN 补
   adjudication + 存在的 artifact 文件),不跑 pixel-compare 就能让门 E 判通过 —— 视觉回归
   可伪造成 PASS。现在:声明了 baseline 时 pr-block **亲自 spawn skill 自己那份
   pixel-compare**(--report-out 落到 demo 之外),以可信结果为放行依据;demo 自报降级为对账。

   r7 条目 1(CRITICAL)再补一层**次序**约束:可信 verify 的末段会执行 demo 侧 Node 代码
   (extract.mjs / 自定义门),之后被审方就有一个 detached 子进程能改磁盘的窗口。因此门 E 的
   可信重跑必须排在可信 verify **之前** —— 否则那次真实渲染观察正好落在攻击窗口里。
   本文件里两次 spawn 的先后(CANONICAL_PIXEL 早于 CANONICAL_VERIFY)由源码契约测试锁死。 */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CANONICAL_VERIFY = join(SCRIPT_DIR, 'verify.mjs');
const CANONICAL_PIXEL = join(SCRIPT_DIR, 'pixel-compare.mjs');
const TRUSTED_VERIFY_TIMEOUT_MS = 900000;

const PREVIEW_HOSTS = new Set(['github.com', 'gitlab.com', 'workers.xd.team']);
// 与 assets-manifest.mjs 保持一致(那边是可执行脚本不能被 import,一致性由测试锁住)
const ASSETS_REPORT_NAME = 'report-assets.json';
const DEFAULT_ASSETS_LIMIT_MB = 8;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseUrl(raw, name) {
  try { return new URL(raw); } catch { die(`${name} 不是合法 URL:${raw}`, 2); }
}

const args = process.argv.slice(2);
const demoIdx = args.indexOf('--demo');
if (demoIdx === -1 || !args[demoIdx + 1]) die('缺 --demo <dir>');
const demoDir = resolve(args[demoIdx + 1]);
const urlIdx = args.indexOf('--url');
const url = urlIdx !== -1 ? args[urlIdx + 1] : null;
const prevIdx = args.indexOf('--preview');
const preview = prevIdx !== -1 ? args[prevIdx + 1] : null;
const requireCommitted = args.includes('--require-committed');
const requireDeployed = args.includes('--require-deployed');

// xd-pages 真实部署地址是 <name>.workers.xd.team 子域,裸域校验会把真地址拒掉(修:允许子域)。
// QA_HIFI_URL_ALLOW(逗号分隔)供测试/特批扩展 host,生产不设即无影响。
const extraHosts = (process.env.QA_HIFI_URL_ALLOW ?? '').split(',').filter(Boolean);
const urlHostOk = (h) => h === 'workers.xd.team' || h.endsWith('.workers.xd.team') || extraHosts.includes(h);
if (url) {
  const u = parseUrl(url, '--url');
  if (!urlHostOk(u.hostname)) die(`--url 只允许 workers.xd.team 内网域(含子域),当前:${u.hostname}`, 2);
}
if (preview) {
  const p = parseUrl(preview, '--preview');
  if (!PREVIEW_HOSTS.has(p.hostname)) die(`--preview host 不在白名单:${p.hostname}`, 2);
  if (!p.pathname.endsWith('.html')) die('--preview 必须指向 .html 预览/附件链接', 2);
}

// 与 verify 同一道无条件 fail-fast(r5 P0-2):demo 自带 node_modules 一律拒,
// 排在读取任何 demo 输入之前。
{
  const nm = checkDemoNoNodeModules(demoDir);
  if (nm.length) failProblems(nm);
  // r9 P0:symlink 同样在读取任何 demo 输入之前无条件拒(观察对象 ≠ 交付对象)。
  const sl = checkDemoNoSymlinks(demoDir);
  if (sl.length) failProblems(sl);
}

const specPath = join(demoDir, 'spec.json');
const reportPath = join(demoDir, 'report.json');
if (!existsSync(specPath)) die('spec.json 不存在');
if (!existsSync(reportPath)) die('report.json 不存在——先跑 verify.mjs,全绿才许贴 PR', 2);

let spec;
let report;
try {
  spec = JSON.parse(readFileSync(specPath, 'utf8'));
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  failProblems([`输入 JSON 解析失败:${err.message}`]);
}
const problems = [
  ...validateSpec(spec).map((p) => `spec: ${p}`),
  ...validateReportIntegrity(demoDir, spec, report).map((p) => `report: ${p}`),
];

// --require-committed(P6 定稿模式):demo 必须真的会随 PR 走——
// ① demo 目录在 git 仓内且核心文件已被跟踪(否则 push 了分支 demo 也不在 diff 里);
// ② demo 目录工作区干净(改了没 commit = PR 带的是旧版);
// 生成产物(report*.json / pixel-artifacts)不强制入库,只强制 spec/extract/truth/index。
if (requireCommitted) {
  try {
    execFileSync('git', ['-C', demoDir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
    const tracked = execFileSync('git', ['-C', demoDir, 'ls-files', '--', '.'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    for (const f of ['spec.json', 'extract.mjs', 'truth.json', 'index.html']) {
      if (!tracked.some((t) => t === f || t.endsWith(`/${f}`)))
        problems.push(`committed: ${f} 未被 git 跟踪——demo 没入库,PR 带不上它(git add + commit 后重试)`);
    }
    const dirty = execFileSync('git', ['-C', demoDir, 'status', '--porcelain', '--', '.'], { encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .filter((l) => !/report(-pixel|-assets)?\.json$|pixel-artifacts\//.test(l));
    if (dirty.length)
      problems.push(`committed: demo 目录有未提交改动(${dirty.length} 项)——PR 会带旧版,先 commit:\n${dirty.slice(0, 5).join('\n')}`);
  } catch {
    problems.push('committed: demo 目录不在 git 仓内——先入库到 docs/design-previews/<feature>/ 再定稿');
  }
}
// --require-deployed(P6 定稿模式):验证「线上跑的就是本地这份最新 demo」——
// 拉取部署地址(带 cache-bust 防 CDN 旧缓存),整文件 sha256 与本地比对。
// 覆盖 index.html + assets/**(多文件 demo 的线上旧资产同样是假证据,不只比首页)。
if (requireDeployed) {
  if (!url) {
    problems.push('deployed: --require-deployed 需要 --url <xd-pages 部署地址>——没部署就不能定稿(P4)');
  } else {
    const fetchSha = async (target) => {
      const bust = `${target}${target.includes('?') ? '&' : '?'}qa=${Date.now()}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(bust, { signal: ctrl.signal, redirect: 'follow' });
        if (!res.ok) return { ok: false, status: res.status };
        return { ok: true, sha: createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex') };
      } finally {
        clearTimeout(timer);
      }
    };
    const localSha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    try {
      const remote = await fetchSha(url);
      if (!remote.ok) {
        problems.push(`deployed: 部署地址返回 HTTP ${remote.status}——未部署或部署坏了,重新 xd-pages 部署`);
      } else if (remote.sha !== localSha(join(demoDir, 'index.html'))) {
        problems.push('deployed: 线上 HTML 与本地 index.html 字节不一致——线上是旧版(或本地改后没重部署),重新 xd-pages 部署再定稿');
      } else {
        // assets/** 逐文件比对(存在才比;xd-pages 按目录整体部署,路径一一对应)
        const assetsDir = join(demoDir, 'assets');
        if (existsSync(assetsDir)) {
          const walk = (dir, out = []) => {
            for (const name of readdirSync(dir)) {
              const file = join(dir, name);
              if (statSync(file).isDirectory()) walk(file, out);
              else out.push(file);
            }
            return out;
          };
          const origin = new URL(url);
          const basePath = origin.pathname.replace(/index\.html$/, '').replace(/\/?$/, '/');
          for (const file of walk(assetsDir)) {
            const rel = relative(demoDir, file).split('\\').join('/');
            const assetUrl = new URL(basePath + rel, origin).href;
            try {
              const r = await fetchSha(assetUrl);
              if (!r.ok) problems.push(`deployed: 线上缺资产 ${rel}(HTTP ${r.status})——部署不完整`);
              else if (r.sha !== localSha(file)) problems.push(`deployed: 线上资产 ${rel} 与本地字节不一致——线上是旧版资产`);
            } catch (err) {
              problems.push(`deployed: 资产 ${rel} 拉取失败:${String(err.cause?.message || err.message).slice(0, 120)}`);
            }
          }
        }
      }
    } catch (err) {
      problems.push(`deployed: 部署地址不可达:${String(err.cause?.message || err.message).slice(0, 120)}(不在内网?未部署?)`);
    }
  }
}

/* demo 自报的门 E 报告:先做自洽/存在性校验(缺报告 = 门 E 没跑,这条仍是硬阻断)。
   注意它**不是放行依据** —— 放行依据是下面可信侧亲自重跑 pixel-compare 的结果。 */
let pixel = validatePixelForPr(demoDir, spec);
problems.push(...pixel.problems.map((p) => `pixel(自报): ${p}`));

// 资产闸门入链(审核 P1 #5):demo 一旦有 assets/,就必须能出示"闸门真跑过且当时量的
// 就是这批字节"的凭据。缺报告 = 闸门没跑;hash 不符 = 跑完又换了图;ok:false = 超阀
// 没抬闸。三者任一即阻断——否则 assets-manifest.mjs 是一条谁都可以整段跳过的自愿门。
let assetsReport = null;
/* ── 可信运行标记的三个盒子(r7 条目 7b) ──
   只有 canonical runner(trusted verify / trusted pixel-compare)与 pr-block 自己的现算
   才会给它们赋值;渲染器拿到 null 或未标记对象一律 throw。模块级声明 —— 放进块作用域
   会让渲染处读不到(实测踩过)。 */
let trustedVerifyBox = null;
let trustedPixelBox = null;
let trustedAssetsBox = null;
if (existsSync(join(demoDir, 'assets'))) {
  const assetsReportPath = join(demoDir, ASSETS_REPORT_NAME);
  if (!existsSync(assetsReportPath)) {
    problems.push(
      `assets: demo 有 assets/ 但缺 ${ASSETS_REPORT_NAME}——资产体积闸门未跑,先跑 ` +
        'node scripts/assets-manifest.mjs --demo <dir>',
    );
  } else {
    let ar;
    try {
      ar = JSON.parse(readFileSync(assetsReportPath, 'utf8'));
    } catch (err) {
      ar = null;
      problems.push(`assets: ${ASSETS_REPORT_NAME} 不是合法 JSON:${err.message}`);
    }
    if (ar) {
      // 审核 #5c:原来只查 hash + ok:true,而这两项都写在同一份可手写的 JSON 里——
      // 手写一份 { ok:true, totalBytes:0, inputHashes:<真 hash> } 就能把 9MB 资产送过闸。
      // 现在阀值与体积一律由 pr-block 自己从 assets/ 重算,report 自报的数字只用于对账。
      const actual = buildAssetsManifest(demoDir).files;
      const actualTotal = actual.reduce((sum, f) => sum + f.size, 0);
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const defaultMb = num(ar.defaultLimitMb);
      const effectiveMb = num(ar.effectiveLimitMb);
      const claimedTotal = num(ar.totalBytes);
      const MB = (b) => (b / 1024 / 1024).toFixed(2);

      if (ar.toolVersion !== TOOL_VERSION) problems.push(`assets: ${ASSETS_REPORT_NAME} toolVersion 缺失或不匹配:${ar.toolVersion ?? '(missing)'}——重跑闸门`);
      if (!sameInputHashes(ar.inputHashes?.assets, actual))
        problems.push(`assets: ${ASSETS_REPORT_NAME} 的 assets hash 与当前 assets/ 不一致——闸门跑完又换过资产,重跑 assets-manifest.mjs`);
      if (ar.ok !== true) problems.push(`assets: ${ASSETS_REPORT_NAME} ok 不是 true(资产超闸门未抬闸):${(ar.problems ?? []).join(';')}`);
      // ① 默认阀常量一致性:报告里的默认阀必须等于本工具写死的 8MB(改常量 = 换了口径)
      if (defaultMb !== DEFAULT_ASSETS_LIMIT_MB)
        problems.push(`assets: ${ASSETS_REPORT_NAME} defaultLimitMb=${JSON.stringify(ar.defaultLimitMb)} 与本工具默认闸门 ${DEFAULT_ASSETS_LIMIT_MB}MB 不一致——报告不是当前 assets-manifest.mjs 产出的,重跑闸门`);
      // ② 生效阀必须是有限正数
      if (effectiveMb === null || effectiveMb <= 0)
        problems.push(`assets: ${ASSETS_REPORT_NAME} effectiveLimitMb=${JSON.stringify(ar.effectiveLimitMb)} 不是有限正数——报告被手改过,重跑闸门`);
      // ③ 自报体积必须等于现算体积(手写 totalBytes:0 在这里落地)
      if (claimedTotal !== actualTotal)
        problems.push(`assets: ${ASSETS_REPORT_NAME} 自报 totalBytes=${JSON.stringify(ar.totalBytes)} 与现算 ${actualTotal}(${MB(actualTotal)}MB)不符——报告被手改过或资产已变,重跑 assets-manifest.mjs`);
      // ④ 现算体积必须真的在生效阀内(不看 ok 字段,自己判)
      if (effectiveMb !== null && effectiveMb > 0 && actualTotal > Math.floor(effectiveMb * 1024 * 1024)) {
        const top = actual.slice().sort((a, b) => b.size - a.size).slice(0, 5).map((f) => `${f.path}(${MB(f.size)}MB)`);
        problems.push(`assets: assets/ 现算总体积 ${MB(actualTotal)}MB 超过生效阀 ${effectiveMb}MB——压图/换 webp/删无用资产。最大几项:${top.join('、')}`);
      }
      // ⑤ 抬闸 ⟺ 有非空理由(双向:抬了必须有理由;没抬不许挂理由)
      const raised = effectiveMb !== null && defaultMb !== null && effectiveMb > defaultMb;
      const reasonOk = typeof ar.overrideReason === 'string' && ar.overrideReason.trim().length > 0;
      if (raised && !reasonOk)
        problems.push(`assets: ${ASSETS_REPORT_NAME} 把闸门从 ${defaultMb}MB 抬到 ${effectiveMb}MB 却没有非空 overrideReason——抬闸必须署名理由,理由会印在 PR 上`);
      if (!raised && ar.overrideReason !== null && ar.overrideReason !== undefined && !reasonOk)
        problems.push(`assets: ${ASSETS_REPORT_NAME} overrideReason 非法(未抬闸时应为 null)`);
      if (!raised && reasonOk)
        problems.push(`assets: ${ASSETS_REPORT_NAME} 未抬闸(生效阀 ${effectiveMb}MB ≤ 默认 ${defaultMb}MB)却带了 overrideReason——报告被手改过,重跑闸门`);
      assetsReport = ar;
      trustedAssetsBox = markTrustedRun('assets-recompute', { totalBytes: actualTotal, files: actual.length });
    }
  }
}
/* ── 可信侧重跑 verify 门 A/B/C/D/F/X(P0-1 的落地;见文件头「架构主线」)。
   门 E 不在 verify 里,紧跟其后由 pixel-compare 单独重跑(r6 条目 2)。 ──
   已有 problems 时不必再花一次浏览器代价:反正一定 exit 2。全绿候选才重跑。
   重跑用 skill 仓自己的 verify.mjs,报告落到 demo 之外的临时目录(--report-out),
   demo 侧 report.json 不被覆盖——作者的自报材料要留着对账。 */
if (problems.length === 0) {
  /* ── 门 E 的可信侧重跑(r6 条目 2),**必须排在可信 verify 之前**(r7 条目 1) ──
     次序理由:可信 verify 的末段会执行 demo 侧 Node 代码(extract.mjs / 自定义门),
     那之后被审方就有一个 detached 子进程能改磁盘的窗口。像素比对是一次真实渲染观察,
     排在 verify 之后就落在那个窗口里 —— 临时把错误样式改对、pixel 判 PASS、退出时恢复。
     所以:先做像素观察,再去碰 demo 代码。禁止把这两段调换回去(源码契约测试锁住)。
     artifact 三图会被重跑覆盖成**可信侧生成的**那份,WARN 的人工裁决从此绑在可信产物上
     (裁决文件本身仍是作者署名的 —— 人工裁决的性质决定的,但它判的图是我们的)。 */
    const declaredBaselines = Array.isArray(spec.baselines) ? spec.baselines.length : 0;
  if (declaredBaselines > 0) {
    const pxOut = join(mkdtempSync(join(tmpdir(), 'qa-hifi-trusted-px-')), 'report-pixel.json');
    const pxRun = spawnSync(process.execPath, [CANONICAL_PIXEL, '--demo', demoDir, '--report-out', pxOut], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: TRUSTED_VERIFY_TIMEOUT_MS,
    });
    const pxTail = (s) => String(s ?? '').trim().split('\n').slice(-12).join('\n').slice(-1500);
    let trustedPx = null;
    if (existsSync(pxOut)) { try { trustedPx = JSON.parse(readFileSync(pxOut, 'utf8')); } catch {} }
    if (pxRun.status !== 0 || !trustedPx || trustedPx.ok !== true) {
      problems.push(
        `trusted-pixel: pr-block 在可信侧重跑门 E(pixel-compare)未通过——不接受 demo 目录里的 report-pixel.json 作为「门 E 跑过且通过」的证明(exit=${pxRun.status})。`
        + `\n可信侧重跑输出(尾部):\n${pxTail(pxRun.stdout) || pxTail(pxRun.stderr) || '(空)'}`,
      );
    } else {
      // 可信产物同样过一遍完整校验(阈值/计数/engine/WARN 裁决与 artifact 均绑在这份上)
      const tv = validatePixelReport(demoDir, spec, trustedPx);
      problems.push(...tv.problems.map((p) => `trusted-pixel: ${p}`));
      /* 对账:自报与可信结论必须一致。只比「PR 上会宣称的结论」——ok/skipped/declared/
         阈值 + 每个基准的 status;bad/total 是重新渲染后现算的像素计数,天然会有微小抖动,
         拿它做全等比对只会制造假阴性。 */
      const pxProjection = (r) => ({
        ok: r?.ok === true,
        skipped: r?.skipped === true,
        declared: r?.declared ?? null,
        threshold: r?.threshold ?? null,
        statuses: (Array.isArray(r?.results) ? r.results : [])
          .map((x) => `${x?.platform ? `${x.platform}/` : ''}${x?.key}=${x?.status}`)
          .sort(),
      });
      const pxClaimed = JSON.stringify(pxProjection(pixel.report));
      const pxActual = JSON.stringify(pxProjection(trustedPx));
      if (pxClaimed !== pxActual)
        problems.push(
          'trusted-pixel: demo 的 report-pixel.json 与可信侧重跑结论不一致——那份门 E 报告不是当前输入真跑出来的'
          + `\n  demo 自报:${pxClaimed}\n  可信重跑:${pxActual}`
          + '\n修法:重跑 node scripts/pixel-compare.mjs --demo <dir> 生成真实 report-pixel.json。',
        );
      // 出块的像素结论同样取可信侧结果,并打上可信运行标记(条目 7b)
      pixel = { present: true, problems: [], report: trustedPx };
      trustedPixelBox = markTrustedRun('pixel', trustedPx);
    }
  }
}
if (problems.length === 0) {
  const outFile = join(mkdtempSync(join(tmpdir(), 'qa-hifi-trusted-')), 'report.json');
  const run = spawnSync(process.execPath, [CANONICAL_VERIFY, '--demo', demoDir, '--report-out', outFile], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: TRUSTED_VERIFY_TIMEOUT_MS,
  });
  let trusted = null;
  if (existsSync(outFile)) { try { trusted = JSON.parse(readFileSync(outFile, 'utf8')); } catch {} }
  if (!trusted) { try { trusted = JSON.parse(run.stdout); } catch {} }
  const tail = (s) => String(s ?? '').trim().split('\n').slice(-12).join('\n').slice(-1500);
  if (run.status !== 0 || !trusted || trusted.ok !== true) {
    problems.push(
      `trusted-verify: pr-block 在可信侧重跑 verify 门(${lettersFor('verify').join('/')};门 ${lettersFor('pixel').join('/')} 另由 pixel-compare 重跑)未通过——`
      + `不接受 demo 目录里的 report.json 作为「verify 跑过且通过」的证明(exit=${run.status})。`
      + `\n可信侧重跑输出(尾部):\n${tail(run.stdout) || tail(run.stderr) || '(空)'}`,
    );
  } else {
    // 可信侧产物同样要过一遍完整性校验(它是我们自己跑出来的,这里主要兜 component 防伪链)
    problems.push(...validateReportIntegrity(demoDir, spec, trusted).map((p) => `trusted-report: ${p}`));
    /* 对账:demo 自报的 report 与可信侧重跑结论必须一致。不一致意味着那份 report 不是
       这套输入真跑出来的(手写/旧版/改过) —— 即使可信侧本身是绿的,也要报出来,
       否则「PR 上贴的结论」与「仓库里存的证据」两张皮。 */
    const projection = (r) => ({
      ok: r.ok === true,
      partial: r.partial === true,
      entryRenderProof: r.gateB?.entryRenderProof ?? null,
      // 门集合从 TRUSTED_GATES 派生(条目 7a):runner 为 verify 的那些门,一个不许漏
      gates: Object.fromEntries(lettersFor('verify').map((l) => [gateKey(l), r[gateKey(l)]?.pass === true])),
      gateB: `${r.gateB?.passed}/${r.gateB?.total}`,
      gateD: `${r.gateD?.passed}/${r.gateD?.total}`,
      cases: (r.coverage?.cases ?? []).map((c) => c?.id).sort(),
    });
    const claimed = JSON.stringify(projection(report));
    const actual = JSON.stringify(projection(trusted));
    if (claimed !== actual)
      problems.push(
        'trusted-report: demo 的 report.json 与可信侧重跑结论不一致——那份报告不是当前输入真跑出来的'
        + `\n  demo 自报:${claimed}\n  可信重跑:${actual}`
        + '\n修法:重跑 node scripts/verify.mjs --demo <dir> 生成真实 report.json。',
      );
    // 出块用的一切数字/结论都取可信侧重跑结果,不再取 demo 自报
    report = trusted;
    trustedVerifyBox = markTrustedRun('verify', trusted);
  }
}
if (problems.length) failProblems(problems);

/* ── 出块:渲染器只接受打过可信标记的结果(r7 条目 7b) ──
   demo 自报的 report / report-pixel 从这里开始**再也不出现** —— 渲染器的签名里没有它们,
   拿未标记的对象喂进去会直接 throw。这不是靠"记得取可信值",是靠参数结构。 */
console.log(renderPrBlock({
  spec,
  trustedVerify: trustedVerifyBox,
  trustedPixel: trustedPixelBox,
  trustedAssets: trustedAssetsBox,
  // 抬闸是**作者的政策输入**,不是测量证据(条目 11):分开传、分开标注
  assetsPolicy: assetsReport?.overrideReason
    ? {
      overrideReason: assetsReport.overrideReason,
      effectiveLimitMb: assetsReport.effectiveLimitMb,
      defaultLimitMb: assetsReport.defaultLimitMb ?? DEFAULT_ASSETS_LIMIT_MB,
    }
    : null,
  url,
  preview,
}));
if (!preview) console.error('⚠️ 未传 --preview:.html 证据链接缺失,建议补 GitHub/GitLab 仓内 .html 链接');

