#!/usr/bin/env node
// capture-baseline.mjs — 门 E 基准图采集器。
//
// 背景:门 E 要求 baselines/<key>.png 来自「真沙盒截图」,但采集长期全手工(截图/裁切/
// 命名/DPR 对齐都靠人),结果是门 E 实际闲置。本脚本把采集收敛成一条命令:
//
//   真沙盒采集(推荐):
//     node capture-baseline.mjs --demo <dir> --key <key> --url <dev实例地址> --sel <帧selector> [--wait-ms 1500]
//   Electron 真壳采集(gate-e-v2):
//     node capture-baseline.mjs --demo <dir> --key <key> --electron-app <main入口或app目录> [--wait-ms 1500]
//   导入既有截图(手机模拟器等无法直连的场景):
//     node capture-baseline.mjs --demo <dir> --key <key> --from-png <截图文件>
//
// 硬规:
//   - key 必须已在 spec.baselines 声明(没声明的基准没有比对语义);
//   - DPR 用 spec.baselineDpr(默认 2),与 pixel-compare 同口径;
//   - --from-png 会先渲染 demo 量帧尺寸,校验导入图尺寸 ≈ 帧CSS尺寸×DPR(容差 2px/边),
//     尺寸不符直接拒绝——防止「随手一张图」冒充基准。
//   - 基准来源要如实:--url 采的是你指的那个实例;指了 demo 自己的地址 = 自证,门 E 失去意义。
//   - 分端(gate-e-v2):entry 声明 platform 时落到 baselines/<platform>/<key>.png,
//     未声明落旧式 baselines/<key>.png;--electron-app 采集强烈建议声明 electron-mac/win。

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { failJson, failProblems } from './lib/fs-utils.mjs';
import { validateSpec } from './lib/schema.mjs';
import { createSafeStaticServer } from './lib/safe-server.mjs';
import { launchChromium, loadPlaywrightApi, resolveModule } from './lib/resolve-playwright.mjs';
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
const electronAppArg = argOf('--electron-app');
const waitMs = Number(argOf('--wait-ms') ?? 1500);
if (!demoDir) failJson('缺 --demo <dir>');
if (!key) failJson('缺 --key <baseline key>');
const modes = [url && '--url', fromPng && '--from-png', electronAppArg && '--electron-app'].filter(Boolean);
if (modes.length === 0) failJson('三选一:--url <真沙盒地址> / --from-png <截图文件> / --electron-app <main入口或app目录>');
if (modes.length > 1) failJson(`${modes.join(' 与 ')} 互斥,一次只能用一种采集方式`);

let spec;
try {
  spec = JSON.parse(readFileSync(join(demoDir, 'spec.json'), 'utf8'));
} catch (err) {
  failProblems([`spec.json 解析失败:${err.message}`]);
}
const specProblems = validateSpec(spec);
if (specProblems.length) failProblems(specProblems.map((p) => `spec: ${p}`));

const platformArg = argOf('--platform');
// 复合键查找(review finding #4):schema 允许同 key 跨 platform,只按 key 找会把
// android 截图静默写进 ios 目录。多条命中且未传 --platform → fail-closed 列候选;
// 单命中保持旧 CLI 兼容(无需 --platform)。
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
const dpr = Number(spec.baselineDpr ?? 2);
const frameSel = entry.frameSel ?? spec.baselineFrameSel ?? '.frame';
// 分端输出:声明 platform → baselines/<platform>/<key>.png;未声明 → 旧式平铺(兼容)
const outRel = entry.platform ? `baselines/${entry.platform}/${key}.png` : `baselines/${key}.png`;
const outPath = join(demoDir, outRel);

let browser;
let page;
let safeServer;
let electronAppInst;
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
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, shot);
    console.log(JSON.stringify({
      ok: true, mode: 'live-capture', key, platform: entry.platform ?? null, out: outRel, dpr,
      cssFrame: { width: box.width, height: box.height },
      source: target.href,
      note: '来源要如实:这是你指定实例的截图;下一步跑 pixel-compare.mjs 比对',
    }, null, 2));
  } else if (electronAppArg) {
    // 宿主一致性(review finding #4):electron-mac 只能在 macOS 采、electron-win 只能在
    // Windows 采——跨宿主采集的基准必然带系统字体噪声,直接拒绝;
    // --electron-app 产出的是 Electron 桌面壳渲染,也不得写进 ios/android/web 目录。
    if (entry.platform === 'electron-mac' && process.platform !== 'darwin')
      failJson(`entry platform 是 electron-mac,但当前宿主是 ${process.platform}——跨宿主采集的基准必然带字体噪声,拒绝`, 2);
    if (entry.platform === 'electron-win' && process.platform !== 'win32')
      failJson(`entry platform 是 electron-win,但当前宿主是 ${process.platform}——跨宿主采集的基准必然带字体噪声,拒绝`, 2);
    if (entry.platform && !entry.platform.startsWith('electron-'))
      failJson(`--electron-app 采集的是 Electron 桌面壳截图,不能写进 platform:"${entry.platform}" 基准(web 用 --url,移动端用 capture-mobile.mjs)`, 2);
    // Electron 真壳采集:playwright _electron 起真实 app,截第一个窗口的帧元素。
    // 与 --url 的差异:渲染环境是产品真实 Electron(真实 Chrome 版本/窗口配置/注入样式),
    // 不再是 dev 实例的裸 Chromium——门 E 桌面端采集侧升级(gate-e-v2)。
    // electron 二进制与 app 路径都从调用方环境解析(QA_HIFI_MODULE_ROOT/工作区兄弟项目)。
    const { api } = await loadPlaywrightApi(demoDir);
    if (typeof api?._electron?.launch !== 'function') failJson('当前 playwright 模块不含 _electron API(需要 playwright/playwright-core ≥1.9)');
    let electronBinary;
    try {
      const electronPkg = resolveModule('electron', demoDir);
      electronBinary = createRequire(electronPkg)(electronPkg); // electron 包入口导出二进制路径字符串
    } catch (err) {
      failJson(`解析不到 electron 二进制(装 electron,或用 QA_HIFI_MODULE_ROOT 指向含 electron 的项目):${String(err.message || err).slice(0, 200)}`);
    }
    const appPath = resolve(electronAppArg);
    if (!existsSync(appPath)) failJson(`--electron-app 路径不存在:${appPath}`);
    electronAppInst = await api._electron.launch({ executablePath: electronBinary, args: [appPath] });
    const win = await electronAppInst.firstWindow();
    if (waitMs > 0) await win.waitForTimeout(waitMs);
    const loc = win.locator(frameSel).first();
    const box = await loc.boundingBox({ timeout: 8000 });
    if (!box) failJson(`截图元素不可见:${frameSel}(确认该 selector 在 Electron 首窗口页面成立)`, 2);
    const shot = await loc.screenshot();
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, shot);
    console.log(JSON.stringify({
      ok: true, mode: 'electron-capture', key, platform: entry.platform ?? null, out: outRel,
      cssFrame: { width: box.width, height: box.height },
      source: appPath,
      note: (entry.platform ? '' : '建议给该 entry 声明 platform:"electron-mac"/"electron-win"(分端基准,mac 与 win 基准永不互比);') +
        '这是 Electron 真壳首窗口截图;下一步跑 pixel-compare.mjs 比对',
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
    mkdirSync(dirname(outPath), { recursive: true });
    copyFileSync(pngFile, outPath);
    console.log(JSON.stringify({
      ok: true, mode: 'import', key, platform: entry.platform ?? null, out: outRel, dpr,
      imported: { width: png.width, height: png.height },
      note: '导入的必须是真沙盒/真机截图;下一步跑 pixel-compare.mjs 比对',
    }, null, 2));
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
  process.exitCode = 2;
} finally {
  try { if (electronAppInst) await electronAppInst.close(); } catch {}
  try { if (page) await page.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  try { if (safeServer) await safeServer.close(); } catch {}
}
