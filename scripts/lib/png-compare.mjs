import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  return { PNG, pixelmatch };
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
