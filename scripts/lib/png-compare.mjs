import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolveModule } from './resolve-playwright.mjs';

export async function loadPngApi(startDir) {
  const pngPath = resolveModule('pngjs', startDir);
  const req = createRequire(pngPath);
  const { PNG } = req(pngPath);
  let pixelmatch = null;
  try {
    const pixelmatchPath = resolveModule('pixelmatch', startDir);
    const mod = await import(pixelmatchPath);
    pixelmatch = mod.default ?? mod;
  } catch {}
  let odiff = null;
  try {
    const odiffPath = resolveModule('odiff-bin', startDir);
    const mod = await import(odiffPath);
    const api = mod.default ?? mod;
    // 用顶层 compare()(每次调用独立进程)而非 ODiffServer:门 E 单轮基准数小,
    // spawn 开销可忽略,换来零后台进程生命周期管理(无泄漏/无退出噪音)
    if (typeof api?.compare === 'function') odiff = api;
  } catch {}
  return { PNG, pixelmatch, odiff };
}

export function readPng(PNG, fileOrBuffer) {
  const buffer = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : readFileSync(fileOrBuffer);
  return PNG.sync.read(buffer);
}

function maskBitmap(width, height, cssSize, dpr, masks = []) {
  const bitmap = new Uint8Array(width * height);
  let masked = 0;
  for (const rect of masks) {
    const [x, y, w, h] = rect.map(Number);
    const x0 = Math.max(0, Math.floor(x * dpr.x));
    const y0 = Math.max(0, Math.floor(y * dpr.y));
    const x1 = Math.min(width, Math.ceil((x + w) * dpr.x));
    const y1 = Math.min(height, Math.ceil((y + h) * dpr.y));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const idx = yy * width + xx;
        if (!bitmap[idx]) { bitmap[idx] = 1; masked++; }
      }
    }
  }
  const total = width * height;
  const maskRatio = total ? masked / total : 1;
  return { bitmap, masked, maskRatio, unmasked: total - masked, cssSize, dpr };
}

function manualDiff(PNG, baseline, actual, mask, threshold = 0.01) {
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  let bad = 0;
  for (let i = 0, p = 0; i < baseline.data.length; i += 4, p++) {
    if (mask.bitmap[p]) {
      diff.data[i] = 180; diff.data[i + 1] = 180; diff.data[i + 2] = 180; diff.data[i + 3] = 80;
      continue;
    }
    const dr = baseline.data[i] - actual.data[i];
    const dg = baseline.data[i + 1] - actual.data[i + 1];
    const db = baseline.data[i + 2] - actual.data[i + 2];
    const da = baseline.data[i + 3] - actual.data[i + 3];
    const distance = Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 510;
    if (distance > threshold) {
      bad++;
      diff.data[i] = 255; diff.data[i + 1] = 0; diff.data[i + 2] = 0; diff.data[i + 3] = 255;
    } else {
      diff.data[i] = actual.data[i]; diff.data[i + 1] = actual.data[i + 1]; diff.data[i + 2] = actual.data[i + 2]; diff.data[i + 3] = 70;
    }
  }
  return { bad, diff };
}

export function comparePngs({ PNG, pixelmatch, baseline, actual, cssSize, masks = [], threshold = 0.005, maxMaskRatio = 0.25, minUnmaskedRatio = 0.5 }) {
  if (baseline.width !== actual.width || baseline.height !== actual.height)
    return { status: 'ERROR', detail: `尺寸不一致:${baseline.width}x${baseline.height} vs ${actual.width}x${actual.height}` };
  const dpr = {
    x: cssSize?.width ? baseline.width / cssSize.width : 1,
    y: cssSize?.height ? baseline.height / cssSize.height : 1,
  };
  const mask = maskBitmap(baseline.width, baseline.height, cssSize, dpr, masks);
  const totalPixels = baseline.width * baseline.height;
  if (mask.maskRatio > maxMaskRatio) return { status: 'ERROR', detail: `mask 面积 ${(mask.maskRatio * 100).toFixed(2)}% 超上限 ${(maxMaskRatio * 100).toFixed(2)}%`, masked: mask.masked, total: totalPixels };
  if (mask.unmasked / totalPixels < minUnmaskedRatio) return { status: 'ERROR', detail: '未遮罩区域过少,像素比对无意义', masked: mask.masked, total: totalPixels };
  let bad;
  let diff;
  if (pixelmatch) {
    // pixelmatch 没有原生 mask。不能事后用 diff.data 的 alpha 反推「mask 内坏点」——pixelmatch 的
    // drawPixel 对所有像素(含非差异灰度底)都写 alpha=255,alpha!=0 恒真,会把整片 mask 都算成坏点、
    // 令 bad 被过度扣减成负数、mask 外真实差异被淹没(假绿)。正确做法:调用前把 mask 区在两张图里
    // 置成完全相同的像素,pixelmatch 永远不会把它们判为差异,bad 直接就是「未遮罩区真实坏点数」。
    const baseCopy = Buffer.from(baseline.data);
    const actCopy = Buffer.from(actual.data);
    for (let p = 0; p < mask.bitmap.length; p++) {
      if (!mask.bitmap[p]) continue;
      const i = p * 4;
      actCopy[i] = baseCopy[i];
      actCopy[i + 1] = baseCopy[i + 1];
      actCopy[i + 2] = baseCopy[i + 2];
      actCopy[i + 3] = baseCopy[i + 3];
    }
    diff = new PNG({ width: baseline.width, height: baseline.height });
    bad = pixelmatch(baseCopy, actCopy, diff.data, baseline.width, baseline.height, {
      threshold: Math.max(0, Math.min(1, threshold)),
      includeAA: false,
      alpha: 0.2,
      diffMask: false,
    });
    // mask 区在 diff 图上涂灰,仅供 reviewer 看清哪里被遮,不参与 bad 统计(上面已保证其为 0 贡献)
    for (let p = 0; p < mask.bitmap.length; p++) {
      if (!mask.bitmap[p]) continue;
      const i = p * 4;
      diff.data[i] = 180; diff.data[i + 1] = 180; diff.data[i + 2] = 180; diff.data[i + 3] = 80;
    }
  } else {
    ({ bad, diff } = manualDiff(PNG, baseline, actual, mask, Math.max(0.001, threshold)));
  }
  const total = mask.unmasked;
  return { status: 'OK', bad, total, masked: mask.masked, diff, dpr };
}

export function writePng(PNG, file, png) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, PNG.sync.write(png));
}

// ============ odiff 优先的比对入口(gate-e-v2,2026-07-30) ============
//
// 阈值语义映射(必须读后再改):
//   - pixelmatch `threshold`(0..1):逐像素 YIQ 感知色差容忍度,色差 > threshold×maxDelta 记为坏点;
//     本仓默认取 spec.pixelmatchThreshold(0.1),且 includeAA:false(AA 像素不计入 diff)。
//   - odiff `threshold`(0..1):同为逐像素 YIQ 系感知色差容忍度(官方文档:"less = more precise");
//     antialiasing:true = 「AA 像素不计入 diff」,与 includeAA:false 语义对齐。
//   两者是同族但不同实现的感知阈值,数值不保证逐点一致——映射策略是**同值直传**
//   (都是「单像素容忍度」语义);最终 PASS/WARN 判定门槛仍是引擎无关的
//   diffRatio(=bad/未遮罩像素数) ≤ spec.baselineThreshold,换引擎不改变验收口径。
//   mask 面积上限 / minUnmaskedRatio 两道护栏保留在本层(maskBitmap),不全权交给 odiff;
//   mask 区映射为 odiff ignoreRegions(与 maskBitmap 同一套 CSS→设备像素换算,不重复实现)。
//
// 引擎选择:QA_HIFI_COMPARE_ENGINE = auto(缺省,odiff 优先,失败回退 pixelmatch)/ odiff
// (点名,失败直接报错不静默回退)/ pixelmatch(跳过 odiff,供 A/B 对比与排障)。

function maskToIgnoreRegions(masks, dpr, width, height) {
  return masks.map((rect) => {
    const [x, y, w, h] = rect.map(Number);
    return {
      x1: Math.max(0, Math.floor(x * dpr.x)),
      y1: Math.max(0, Math.floor(y * dpr.y)),
      x2: Math.min(width, Math.ceil((x + w) * dpr.x)),
      y2: Math.min(height, Math.ceil((y + h) * dpr.y)),
    };
  });
}

async function comparePngsOdiff({ PNG, odiff, baselineRaw, actualRaw, cssSize, masks = [], threshold = 0.005, maxMaskRatio = 0.25, minUnmaskedRatio = 0.5 }) {
  const baseline = readPng(PNG, baselineRaw);
  const actual = readPng(PNG, actualRaw);
  if (baseline.width !== actual.width || baseline.height !== actual.height)
    return { status: 'ERROR', detail: `尺寸不一致:${baseline.width}x${baseline.height} vs ${actual.width}x${actual.height}` };
  const dpr = {
    x: cssSize?.width ? baseline.width / cssSize.width : 1,
    y: cssSize?.height ? baseline.height / cssSize.height : 1,
  };
  // 护栏与 pixelmatch 路径同一实现:mask 面积上限 / 未遮罩下限不过 → 直接 ERROR,不进引擎
  const mask = maskBitmap(baseline.width, baseline.height, cssSize, dpr, masks);
  const totalPixels = baseline.width * baseline.height;
  if (mask.maskRatio > maxMaskRatio) return { status: 'ERROR', detail: `mask 面积 ${(mask.maskRatio * 100).toFixed(2)}% 超上限 ${(maxMaskRatio * 100).toFixed(2)}%`, masked: mask.masked, total: totalPixels };
  if (mask.unmasked / totalPixels < minUnmaskedRatio) return { status: 'ERROR', detail: '未遮罩区域过少,像素比对无意义', masked: mask.masked, total: totalPixels };

  const tmp = mkdtempSync(join(tmpdir(), 'qa-hifi-odiff-'));
  const basePath = join(tmp, 'base.png');
  const actPath = join(tmp, 'actual.png');
  const diffPath = join(tmp, 'diff.png');
  try {
    writeFileSync(basePath, baselineRaw);
    writeFileSync(actPath, actualRaw);
    // 注意:odiff 把 ignoreRegions 序列化成 --ignore "x1:y1-x2:y2,...",空数组会变 --ignore ""
    // 被二进制拒绝(Invalid ignore regions format)——无 mask 时不得传该选项
    const odiffOptions = {
      threshold: Math.max(0, Math.min(1, threshold)),
      antialiasing: true,
      outputDiffMask: true,
    };
    if (masks.length) odiffOptions.ignoreRegions = maskToIgnoreRegions(masks, dpr, baseline.width, baseline.height);
    const result = await odiff.compare(basePath, actPath, diffPath, odiffOptions);
    if (result.match === false && result.reason === 'layout-diff')
      return { status: 'ERROR', detail: `尺寸不一致(odiff layout-diff):${baseline.width}x${baseline.height} vs ${actual.width}x${actual.height}` };
    if (result.match === false && result.reason === 'file-not-exists')
      throw new Error(`odiff 读不到输入文件:${result.file}`);
    const bad = result.match === true ? 0 : result.diffCount;
    // odiff 只在有差异时才写 diff 文件(match:true 不落盘,已实测)——无文件时用 actual
    // 合成暗化底图,保持「三图 artifact」契约与 pixelmatch 路径一致
    let diff;
    if (existsSync(diffPath)) {
      diff = readPng(PNG, diffPath);
    } else {
      diff = new PNG({ width: actual.width, height: actual.height });
      for (let i = 0; i < actual.data.length; i += 4) {
        diff.data[i] = actual.data[i]; diff.data[i + 1] = actual.data[i + 1]; diff.data[i + 2] = actual.data[i + 2]; diff.data[i + 3] = 70;
      }
    }
    // mask 区涂灰(与 pixelmatch 路径的 reviewer 体验一致,不参与 bad 统计)
    for (let p = 0; p < mask.bitmap.length; p++) {
      if (!mask.bitmap[p]) continue;
      const i = p * 4;
      diff.data[i] = 180; diff.data[i + 1] = 180; diff.data[i + 2] = 180; diff.data[i + 3] = 80;
    }
    return { status: 'OK', bad, total: mask.unmasked, masked: mask.masked, diff, dpr, engine: 'odiff' };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function compareImages(opts) {
  const prefer = opts.engine ?? 'auto';
  const decoded = {
    ...opts,
    baseline: opts.baseline ?? readPng(opts.PNG, opts.baselineRaw),
    actual: opts.actual ?? readPng(opts.PNG, opts.actualRaw),
  };
  if ((prefer === 'auto' || prefer === 'odiff') && opts.odiff) {
    try {
      return await comparePngsOdiff({ ...opts, ...decoded });
    } catch (err) {
      if (prefer === 'odiff') throw err; // 点名 odiff:环境问题必须暴露,不许静默降级
      const res = comparePngs(decoded);
      res.engine = decoded.pixelmatch ? 'pixelmatch' : 'manual';
      res.engineNote = `odiff 不可用,回退 ${res.engine}:${String(err.message || err).slice(0, 120)}`;
      return res;
    }
  }
  const res = comparePngs(decoded);
  res.engine = decoded.pixelmatch ? 'pixelmatch' : 'manual';
  return res;
}
