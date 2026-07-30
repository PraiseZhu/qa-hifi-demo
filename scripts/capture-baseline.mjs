#!/usr/bin/env node
// capture-baseline.mjs — 门 E 基准图采集器。
//
// 背景:门 E 要求 baselines/<key>.png 来自「真沙盒截图」,但采集长期全手工(截图/裁切/
// 命名/DPR 对齐都靠人),结果是门 E 实际闲置。本脚本把采集收敛成一条命令:
//
//   真沙盒采集(推荐):
//     node capture-baseline.mjs --demo <dir> --key <key> --url <dev实例地址> --sel <帧selector> [--wait-ms 1500]
//   导入既有截图(手机模拟器等无法直连的场景):
//     node capture-baseline.mjs --demo <dir> --key <key> --from-png <截图文件>
//
// 硬规:
//   - key 必须已在 spec.baselines 声明(没声明的基准没有比对语义);
//   - DPR 用 spec.baselineDpr(默认 2),与 pixel-compare 同口径;
//   - --from-png 会先渲染 demo 量帧尺寸,校验导入图尺寸 ≈ 帧CSS尺寸×DPR(容差 2px/边),
//     尺寸不符直接拒绝——防止「随手一张图」冒充基准。
//   - 基准来源要如实:--url 采的是你指的那个实例;指了 demo 自己的地址 = 自证,门 E 失去意义。

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { failJson, failProblems } from './lib/fs-utils.mjs';
import { validateSpec } from './lib/schema.mjs';
import { createSafeStaticServer } from './lib/safe-server.mjs';
import { launchChromium } from './lib/resolve-playwright.mjs';
import { freshLoad, replay } from './lib/replay.mjs';
import { loadPngApi, readPng } from './lib/png-compare.mjs';

const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}
const demoDir = argOf('--demo') ? resolve(argOf('--demo')) : null;
const key = argOf('--key');
const url = argOf('--url');
const fromPng = argOf('--from-png');
const waitMs = Number(argOf('--wait-ms') ?? 1500);
if (!demoDir) failJson('缺 --demo <dir>');
if (!key) failJson('缺 --key <baseline key>');
if (!url && !fromPng) failJson('二选一:--url <真沙盒地址> 或 --from-png <截图文件>');
if (url && fromPng) failJson('--url 与 --from-png 互斥');

let spec;
try {
  spec = JSON.parse(readFileSync(join(demoDir, 'spec.json'), 'utf8'));
} catch (err) {
  failProblems([`spec.json 解析失败:${err.message}`]);
}
const specProblems = validateSpec(spec);
if (specProblems.length) failProblems(specProblems.map((p) => `spec: ${p}`));

const entry = (spec.baselines ?? []).find((b) => b.key === key);
if (!entry) failJson(`key "${key}" 未在 spec.baselines 声明——先声明(带 via/frameSel/mask)再采集`, 2);
const dpr = Number(spec.baselineDpr ?? 2);
const frameSel = entry.frameSel ?? spec.baselineFrameSel ?? '.frame';
const baseDir = join(demoDir, 'baselines');
const outPath = join(baseDir, `${key}.png`);

let browser;
let page;
let safeServer;
try {
  if (url) {
    // 真沙盒采集:直接截产品 dev 实例的帧元素
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) failJson(`--url 只支持 http/https:${url}`);
    ({ browser } = await launchChromium(demoDir, { headless: true }));
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: dpr });
    await page.goto(target.href, { waitUntil: 'load', timeout: 30000 });
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const loc = page.locator(frameSel).first();
    const box = await loc.boundingBox({ timeout: 8000 });
    if (!box) failJson(`截图元素不可见:${frameSel}(确认 --sel/spec.baselineFrameSel 在沙盒页面同样成立)`, 2);
    const shot = await loc.screenshot();
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(outPath, shot);
    console.log(JSON.stringify({
      ok: true, mode: 'live-capture', key, out: `baselines/${key}.png`, dpr,
      cssFrame: { width: box.width, height: box.height },
      source: target.href,
      note: '来源要如实:这是你指定实例的截图;下一步跑 pixel-compare.mjs 比对',
    }, null, 2));
  } else {
    // 导入模式:渲染 demo 量帧尺寸,校验导入图尺寸后落位
    const pngFile = resolve(fromPng);
    if (!existsSync(pngFile)) failJson(`截图文件不存在:${pngFile}`);
    const { PNG } = await loadPngApi(demoDir);
    const png = readPng(PNG, pngFile);
    safeServer = createSafeStaticServer(demoDir);
    const base = await safeServer.listen();
    ({ browser } = await launchChromium(demoDir, { headless: true }));
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: dpr });
    await freshLoad(page, base, { adaptive: !!spec.adaptive });
    await replay(page, entry.via ?? []);
    const box = await page.locator(frameSel).first().boundingBox({ timeout: 8000 });
    if (!box) failJson(`demo 帧元素不可见:${frameSel}`, 2);
    const expectW = box.width * dpr;
    const expectH = box.height * dpr;
    const tol = 2 * dpr;
    if (Math.abs(png.width - expectW) > tol || Math.abs(png.height - expectH) > tol) {
      failJson(
        `导入图尺寸 ${png.width}x${png.height} 与 demo 帧 ${box.width}x${box.height}(CSS)×dpr${dpr}=${expectW}x${expectH} 不符(容差 ${tol}px)——` +
        '不是同一帧/同一 DPR 的截图,拒绝作为基准',
        2,
      );
    }
    mkdirSync(baseDir, { recursive: true });
    copyFileSync(pngFile, outPath);
    console.log(JSON.stringify({
      ok: true, mode: 'import', key, out: `baselines/${key}.png`, dpr,
      imported: { width: png.width, height: png.height },
      note: '导入的必须是真沙盒/真机截图;下一步跑 pixel-compare.mjs 比对',
    }, null, 2));
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
  process.exitCode = 2;
} finally {
  try { if (page) await page.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  try { if (safeServer) await safeServer.close(); } catch {}
}
