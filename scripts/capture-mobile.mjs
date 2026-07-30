#!/usr/bin/env node
// capture-mobile.mjs — 门 E 移动端基准采集脚手架(gate-e-v2)。
//
// 输入真机/模拟器截图(maestro takeScreenshot / xcrun simctl io / adb screencap),
// 经 OS chrome 裁切 + DPR 归一化(Chromium canvas 重采样) → 尺寸校验 → 落分端基准目录:
//
//   node capture-mobile.mjs --demo <dir> --key <key> --png <截图文件>
//     [--crop <x,y,w,h>] [--crop-top <px>] [--crop-bottom <px>] [--device-dpr <n>]
//
// 硬规(与 capture-baseline --from-png 同口径):
//   - key 必须已在 spec.baselines 声明;声明了 platform(ios/android)落
//     baselines/<platform>/<key>.png,未声明落旧式平铺(兼容,但移动端强烈建议分端——
//     不同 platform 的基准永不互比);
//   - 归一化目标 DPR = spec.baselineDpr(默认 2):@3x 截图(--device-dpr 3)缩到 ×2 再校验;
//   - 最终尺寸必须 ≈ demo 帧CSS×baselineDpr(容差 2×dpr)——防「截的不是这一帧」混入基准;
//   - 裁切/缩放在 Chromium canvas 完成(drawImage 重采样,不引第三方图像库);
//   - 本脚本只管「截图 → 合规基准」后段;前段「驱动 app 到目标屏」用
//     templates/maestro-flow.yaml(maestro test 后把输出 PNG 喂给本脚本)。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
const pngArg = argOf('--png');
const cropArg = argOf('--crop');
const cropTop = Number(argOf('--crop-top') ?? 0);
const cropBottom = Number(argOf('--crop-bottom') ?? 0);
if (!demoDir) failJson('缺 --demo <dir>');
if (!key) failJson('缺 --key <baseline key>');
if (!pngArg) failJson('缺 --png <真机/模拟器截图文件>');
if (cropArg && (cropTop || cropBottom)) failJson('--crop 与 --crop-top/--crop-bottom 互斥(前者给完整矩形,后者是状态栏/导航条便捷裁切)');

let crop = null;
if (cropArg) {
  const parts = cropArg.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) failJson(`--crop 必须是 "x,y,w,h" 非负数:${cropArg}`);
  crop = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

let spec;
try {
  spec = JSON.parse(readFileSync(join(demoDir, 'spec.json'), 'utf8'));
} catch (err) {
  failProblems([`spec.json 解析失败:${err.message}`]);
}
const specProblems = validateSpec(spec);
if (specProblems.length) failProblems(specProblems.map((p) => `spec: ${p}`));

const platformArg = argOf('--platform');
// 复合键查找(review finding #4):与 capture-baseline 同一规则——同 key 多条命中且
// 未传 --platform 时 fail-closed 列候选,防 ios/android 截图互相写错端目录
const matches = (spec.baselines ?? []).filter((b) => b.key === key);
let entry;
if (platformArg) {
  entry = matches.find((b) => (b.platform ?? '') === platformArg);
  if (!entry)
    failJson(`key "${key}" + platform "${platformArg}" 未在 spec.baselines 声明(候选:${matches.map((b) => b.platform ?? '(无platform)').join(', ') || '无'})`, 2);
} else if (matches.length === 0) {
  failJson(`key "${key}" 未在 spec.baselines 声明——先声明(带 via/frameSel/mask/platform)再采集`, 2);
} else if (matches.length > 1) {
  failJson(`key "${key}" 在 spec.baselines 有 ${matches.length} 条(${matches.map((b) => b.platform ?? '(无platform)').join(', ')})——必须加 --platform 指定,防截图静默写错端目录`, 2);
} else {
  entry = matches[0];
}
const targetDpr = Number(spec.baselineDpr ?? 2);
const deviceDpr = Number(argOf('--device-dpr') ?? targetDpr);
if (!Number.isFinite(deviceDpr) || deviceDpr <= 0) failJson(`--device-dpr 必须是正数:${argOf('--device-dpr')}`);
const frameSel = entry.frameSel ?? spec.baselineFrameSel ?? '.frame';
const pngFile = resolve(pngArg);
if (!existsSync(pngFile)) failJson(`截图文件不存在:${pngFile}`);
// 分端输出:声明 platform → baselines/<platform>/<key>.png;未声明 → 旧式平铺(兼容)
const outRel = entry.platform ? `baselines/${entry.platform}/${key}.png` : `baselines/${key}.png`;
const outPath = join(demoDir, outRel);

let browser;
let page;
let safeServer;
try {
  const { PNG } = await loadPngApi(demoDir);
  // 与 capture-baseline --from-png 同口径:先渲染 demo 量帧尺寸,作为尺寸校验基准
  safeServer = createSafeStaticServer(demoDir);
  const base = await safeServer.listen();
  ({ browser } = await launchChromium(demoDir, { headless: true }));
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: targetDpr });
  await freshLoad(page, base, { adaptive: !!spec.adaptive });
  await replay(page, entry.via ?? []);
  const box = await page.locator(frameSel).first().boundingBox({ timeout: 8000 });
  if (!box) failJson(`demo 帧元素不可见:${frameSel}`, 2);

  // Chromium canvas 完成裁切 + 重采样(浏览器级双线性质量,不引第三方图像库)
  const dataUrl = `data:image/png;base64,${readFileSync(pngFile).toString('base64')}`;
  const scale = targetDpr / deviceDpr;
  const processed = await page.evaluate(async ({ dataUrl, crop, cropTop, cropBottom, scale }) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('截图解码失败(非 PNG 或文件损坏)'));
      img.src = dataUrl;
    });
    const sx = crop ? crop.x : 0;
    const sy = crop ? crop.y : cropTop;
    const sw = crop ? crop.w : img.naturalWidth;
    const sh = crop ? crop.h : img.naturalHeight - cropTop - cropBottom;
    if (sw <= 0 || sh <= 0) throw new Error(`裁切后区域为空:${sw}x${sh}(原图 ${img.naturalWidth}x${img.naturalHeight})`);
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
    return {
      data: canvas.toDataURL('image/png'),
      src: { width: img.naturalWidth, height: img.naturalHeight },
      rect: { sx, sy, sw, sh },
      out: { width: dw, height: dh },
    };
  }, { dataUrl, crop, cropTop, cropBottom, scale });
  const outBuffer = Buffer.from(processed.data.split(',')[1], 'base64');
  const png = readPng(PNG, outBuffer);

  // 尺寸校验:归一化后必须 ≈ demo 帧CSS×baselineDpr(容差 2×dpr,与 --from-png 同)
  const expectW = box.width * targetDpr;
  const expectH = box.height * targetDpr;
  const tol = 2 * targetDpr;
  if (Math.abs(png.width - expectW) > tol || Math.abs(png.height - expectH) > tol) {
    failJson(
      `归一化后尺寸 ${png.width}x${png.height} 与 demo 帧 ${box.width}x${box.height}(CSS)×dpr${targetDpr}=${expectW}x${expectH} 不符(容差 ${tol}px)——` +
      '截的不是这一帧(或 --device-dpr/裁切参数不对),拒绝作为基准',
      2,
    );
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, outBuffer);
  console.log(JSON.stringify({
    ok: true,
    mode: 'mobile-import',
    key,
    platform: entry.platform ?? null,
    out: outRel,
    source: { file: pngFile, width: processed.src.width, height: processed.src.height },
    cropRect: processed.rect,
    deviceDpr,
    targetDpr,
    normalized: { width: png.width, height: png.height },
    note: (entry.platform ? '' : '建议给该 entry 声明 platform:"ios"/"android"(分端基准,跨端基准永不互比);') +
      '导入的必须是真机/模拟器截图;下一步跑 pixel-compare.mjs 比对',
  }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
  process.exitCode = 2;
} finally {
  try { if (page) await page.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  try { if (safeServer) await safeServer.close(); } catch {}
}
