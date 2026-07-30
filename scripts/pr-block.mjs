#!/usr/bin/env node
// pr-block.mjs — 基于当前输入 hash + report 门统计生成 PR 验收附贴块。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { buildAssetsManifest, failProblems, sameInputHashes, TOOL_VERSION } from './lib/fs-utils.mjs';
import { countFixtureLeaves, validateSpec } from './lib/schema.mjs';
import { validatePixelForPr, validateReportIntegrity } from './lib/report.mjs';

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

const pixel = validatePixelForPr(demoDir, spec);
problems.push(...pixel.problems.map((p) => `pixel: ${p}`));

// 资产闸门入链(审核 P1 #5):demo 一旦有 assets/,就必须能出示"闸门真跑过且当时量的
// 就是这批字节"的凭据。缺报告 = 闸门没跑;hash 不符 = 跑完又换了图;ok:false = 超阀
// 没抬闸。三者任一即阻断——否则 assets-manifest.mjs 是一条谁都可以整段跳过的自愿门。
let assetsReport = null;
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
      if (ar.toolVersion !== TOOL_VERSION) problems.push(`assets: ${ASSETS_REPORT_NAME} toolVersion 缺失或不匹配:${ar.toolVersion ?? '(missing)'}——重跑闸门`);
      if (!sameInputHashes(ar.inputHashes?.assets, buildAssetsManifest(demoDir).files))
        problems.push(`assets: ${ASSETS_REPORT_NAME} 的 assets hash 与当前 assets/ 不一致——闸门跑完又换过资产,重跑 assets-manifest.mjs`);
      if (ar.ok !== true) problems.push(`assets: ${ASSETS_REPORT_NAME} ok 不是 true(资产超闸门未抬闸):${(ar.problems ?? []).join(';')}`);
      if (ar.overrideReason !== null && ar.overrideReason !== undefined && (typeof ar.overrideReason !== 'string' || !ar.overrideReason.trim()))
        problems.push(`assets: ${ASSETS_REPORT_NAME} overrideReason 非法(抬闸必须有非空理由)`);
      assetsReport = ar;
    }
  }
}
if (problems.length) failProblems(problems);

const meta = spec.meta ?? {};
const cases = report.coverage.cases ?? [];
const lines = [];
lines.push('### 可交互 QA demo（代替沙盒试用）');
lines.push('');
if (preview) lines.push(`**UI 证据（HTML 界面）**：[demo 页面预览](${preview})`);
// URL 与后缀标注之间必须隔断:全角括号紧贴 URL 会被 GitHub autolink 吞进 href
// 导致链接 404(2026-07-25 实踩)。用 <> 显式划定链接边界。
if (url) lines.push(`**体验地址**：<${url}>（内网）`);
if (!preview) console.error('⚠️ 未传 --preview:.html 证据链接缺失,建议补 GitHub/GitLab 仓内 .html 链接');
lines.push('');
if (meta.summary) {
  lines.push(`- **做了什么**：${meta.summary.what}`);
  lines.push(`- **怎么做的**：${meta.summary.how}`);
  lines.push(`- **怎么验收**：${meta.summary.accept}`);
  lines.push('');
}
lines.push(`**实际执行矩阵**：${cases.map((c) => `${c.id} ${JSON.stringify(c.prefs)}`).join('；')}`);
lines.push('');
lines.push('| 验收门 | 结论 |');
lines.push('|---|---|');
lines.push('| 真值一致（数据层:truth 提取自源码,每个叶子带 provenance；渲染层由门 D 保证） | ✅ |');
lines.push(`| 状态覆盖（实际执行 ${report.gateB.passed}/${report.gateB.total}） | ✅ |`);
lines.push(`| 交互鲁棒（${report.gateC.checks.map((c) => c.id).join(' / ')}） | ✅ |`);
if (report.gateD.total > 0) lines.push(`| 渲染绑定（${report.gateD.total} 条 computed-style ≡ truth） | ✅ |`);
else lines.push('| 渲染绑定 | ⚠️ 未配置 bindings，还原承诺仅到数据层 |');
// 组件模式:声明「真组件直渲」并给出进链的源文件数——读者一眼看出渲染不是手搓复刻
if (spec.component?.mode === 'component') {
  const srcCount = Object.keys(report.inputHashes?.componentSources?.sources ?? {}).length;
  lines.push(`| 真组件直渲（${srcCount} 个源文件 hash 入链） | ✅ |`);
}
if (report.gateF.total > 0) lines.push(`| 适配还原（${report.gateF.total} 点） | ✅ |`);
else lines.push('| 适配还原（窗口拉伸行为） | ⚠️ 未配置 adaptive，拉伸未验证 |');
if (report.gateX?.total > 0) lines.push(`| 自定义门（${report.gateX.gates.map((g) => g.id).join(' / ')}） | ✅ |`);
if (pixel.present) {
  const px = pixel.report;
  if (px.skipped) lines.push('| 像素基准（vs 真沙盒截图） | ⚠️ 未采基准，像素级未比对 |');
  else {
    const worst = Math.max(...px.results.map((r) => r.diffRatio ?? 1));
    const anyWarn = px.results.some((r) => r.status === 'WARN');
    lines.push(`| 像素基准（${px.compared}/${px.declared} 组合，最大 diff ${(worst * 100).toFixed(2)}%） | ${anyWarn ? '⚠️ WARN 已附人工裁决' : '✅'} |`);
  }
} else {
  lines.push('| 像素基准（vs 真沙盒截图） | ⚠️ 未运行 pixel-compare |');
}
lines.push('');
// 诚实降级声明:服务端驱动的值(providers 配置等)源码里没有字面量,只能录 fixture。
// 不阻断——但必须在 PR 上写明"这些叶子不是源码溯源",否则 reviewer 会误以为全部可回查源码。
const fixtureLeaves = (() => {
  const truthPath = join(demoDir, 'truth.json');
  if (!existsSync(truthPath)) return 0;
  try { return countFixtureLeaves(JSON.parse(readFileSync(truthPath, 'utf8'))); } catch { return 0; }
})();
if (fixtureLeaves > 0) {
  lines.push(`⚠️ ${fixtureLeaves} 个叶子来自录制 fixture（非源码溯源），来源见 truth provenance`);
  lines.push('');
}
// 抬闸声明:资产超默认闸门是保真度/体积的取舍,必须让 reviewer 看见理由再决定接不接受。
// 不抬闸时这行不出现——常贴的声明就没信息量了。
if (assetsReport?.overrideReason) {
  const mb = (n) => (Number(n) / 1024 / 1024).toFixed(2);
  lines.push(
    `⚠️ 资产 ${mb(assetsReport.totalBytes)} MB 超默认闸门 ${assetsReport.defaultLimitMb ?? DEFAULT_ASSETS_LIMIT_MB} MB` +
      `（本次生效阀 ${assetsReport.effectiveLimitMb} MB），抬闸理由：${assetsReport.overrideReason}`,
  );
  lines.push('');
}
lines.push(`<sub>由 qa-hifi-demo 生成 · 工具版本 ${report.toolVersion} · 验收时间 ${report.generatedAt}</sub>`);

console.log(lines.join('\n'));
