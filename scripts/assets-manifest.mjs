#!/usr/bin/env node
// assets-manifest.mjs — 扫描 demo 的 assets/ 输出清单 + 体积闸门(P6 定稿清单用)。
//
// 为什么要闸门:组件模式下 hero 图/组件 bundle 全内联会把单文件顶到 10MB 量级,
// 浏览器首屏卡、GitHub 预览打不开、PR diff 不可读。资产落 assets/ 独立文件后,
// 需要一个机械上限把「又悄悄长回去」拦在定稿前。
//
// 闸门不入链的问题(审核 P1 #5):本脚本原来只往 stdout 打一段 JSON 就退出,跑没跑过、
// 有没有被 --max-total 抬闸、抬了多少,定稿时全查不到——pr-block 只看 report.json,
// 资产闸门等于一条随时可以整段跳过的"自愿门"。现在固定落盘 report-assets.json
// (含 assets 段 hash + 默认阀/生效阀/抬闸理由),由 pr-block 强制存在 + hash 一致 + ok。
//
// 用法:
//   node scripts/assets-manifest.mjs --demo <dir> [--max-total <MB> --override-reason "<理由>"]
// 抬闸(--max-total 高于默认 8MB)必须同时给非空 --override-reason,理由会印在 PR 附贴块上。
// 退出码:0 = 在限内;2 = 超限或参数/目录错误。

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildAssetsManifest, stableJson, TOOL_VERSION } from './lib/fs-utils.mjs';

// 不 export:本文件是可执行脚本(顶层就跑并 process.exit),被 import 会直接把宿主进程退掉。
// pr-block 侧的同名常量各自声明,靠 __tests__/comp-fix-p1.test.mjs 的跨文件一致性断言锁住。
const DEFAULT_MAX_TOTAL_MB = 8;
const ASSETS_REPORT_NAME = 'report-assets.json';

function fail(problems) {
  console.log(stableJson({ ok: false, problems }));
  process.exit(2);
}

const args = process.argv.slice(2);
const demoIdx = args.indexOf('--demo');
if (demoIdx === -1 || !args[demoIdx + 1]) fail(['缺 --demo <dir>']);
const demoDir = resolve(args[demoIdx + 1]);
if (!existsSync(demoDir) || !statSync(demoDir).isDirectory()) fail([`--demo 不是目录:${demoDir}`]);

const maxIdx = args.indexOf('--max-total');
let maxTotalMb = DEFAULT_MAX_TOTAL_MB;
if (maxIdx !== -1) {
  const raw = args[maxIdx + 1];
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) fail([`--max-total 必须是正数(MB),当前:${raw ?? '(missing)'}`]);
  maxTotalMb = parsed;
}
const maxTotalBytes = Math.floor(maxTotalMb * 1024 * 1024);
const defaultMaxTotalBytes = Math.floor(DEFAULT_MAX_TOTAL_MB * 1024 * 1024);

// 抬闸必须留痕:高于默认阀 = 有人决定"这次可以更大",这个决定必须有署名理由并进 PR。
// 反向(收紧到默认阀以下)不需要理由——收紧永远安全。
const reasonIdx = args.indexOf('--override-reason');
const overrideReasonRaw = reasonIdx !== -1 ? args[reasonIdx + 1] : null;
const raisingLimit = maxTotalMb > DEFAULT_MAX_TOTAL_MB;
if (raisingLimit && (!overrideReasonRaw || !String(overrideReasonRaw).trim())) {
  fail([
    `--max-total ${maxTotalMb}MB 高于默认闸门 ${DEFAULT_MAX_TOTAL_MB}MB——抬闸必须同时给 ` +
      '--override-reason "<为什么这个 demo 必须更大>",理由会印在 PR 附贴块上供 reviewer 判断',
  ]);
}
if (!raisingLimit && overrideReasonRaw !== null) {
  fail([`--override-reason 只在抬闸(--max-total > ${DEFAULT_MAX_TOTAL_MB}MB)时可用——当前生效阀 ${maxTotalMb}MB 未超默认,不需要理由`]);
}
const overrideReason = raisingLimit ? String(overrideReasonRaw).trim() : null;

const manifest = buildAssetsManifest(demoDir);
const totalBytes = manifest.files.reduce((sum, f) => sum + f.size, 0);
// index.html 只做信息展示,不进闸门:闸门口径固定为 assets/,免得改了 HTML 体积口径就漂
const indexPath = join(demoDir, 'index.html');
const indexHtmlBytes = existsSync(indexPath) ? readFileSync(indexPath).length : null;

const problems = [];
if (totalBytes > maxTotalBytes) {
  const top = manifest.files.slice().sort((a, b) => b.size - a.size).slice(0, 5)
    .map((f) => `${f.path}(${(f.size / 1024 / 1024).toFixed(2)}MB)`);
  problems.push(
    `assets/ 总体积 ${(totalBytes / 1024 / 1024).toFixed(2)}MB 超过上限 ${maxTotalMb}MB` +
      `——压图/换格式(webp)/删无用资产后重跑。最大几项:${top.join('、')}`,
  );
}

const payload = {
  ok: problems.length === 0,
  toolVersion: TOOL_VERSION,
  generatedAt: new Date().toISOString(),
  demo: demoDir,
  count: manifest.files.length,
  totalBytes,
  maxTotalBytes,
  maxTotalMb,
  defaultLimitBytes: defaultMaxTotalBytes,
  defaultLimitMb: DEFAULT_MAX_TOTAL_MB,
  effectiveLimitBytes: maxTotalBytes,
  effectiveLimitMb: maxTotalMb,
  overrideReason,
  indexHtmlBytes,
  grandTotalBytes: totalBytes + (indexHtmlBytes ?? 0),
  files: manifest.files,
  // 闸门跑过的凭据:assets 段逐文件 sha 进报告。pr-block 用它比对"现在的 assets/ 就是
  // 当时被闸门量过的那批字节"——换图不重跑闸门 → hash 不符 → 拒出块。
  inputHashes: { assets: manifest.files },
  ...(problems.length ? { problems } : {}),
};
// 失败也落盘(ok:false):pr-block 读到 ok!==true 会阻断,比"文件不存在"更能说明发生了什么
writeFileSync(join(demoDir, ASSETS_REPORT_NAME), stableJson(payload));
console.log(stableJson(payload));
process.exit(problems.length ? 2 : 0);
