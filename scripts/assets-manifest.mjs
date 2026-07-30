#!/usr/bin/env node
// assets-manifest.mjs — 扫描 demo 的 assets/ 输出清单 + 体积闸门(P6 定稿清单用)。
//
// 为什么要闸门:组件模式下 hero 图/组件 bundle 全内联会把单文件顶到 10MB 量级,
// 浏览器首屏卡、GitHub 预览打不开、PR diff 不可读。资产落 assets/ 独立文件后,
// 需要一个机械上限把「又悄悄长回去」拦在定稿前。
//
// 用法:
//   node scripts/assets-manifest.mjs --demo <dir> [--max-total <MB>]
// 退出码:0 = 在限内;2 = 超限或参数/目录错误。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildAssetsManifest, stableJson } from './lib/fs-utils.mjs';

const DEFAULT_MAX_TOTAL_MB = 8;

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
  demo: demoDir,
  count: manifest.files.length,
  totalBytes,
  maxTotalBytes,
  maxTotalMb,
  indexHtmlBytes,
  grandTotalBytes: totalBytes + (indexHtmlBytes ?? 0),
  files: manifest.files,
  ...(problems.length ? { problems } : {}),
};
console.log(stableJson(payload));
process.exit(problems.length ? 2 : 0);
