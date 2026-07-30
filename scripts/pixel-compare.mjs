#!/usr/bin/env node
// pixel-compare.mjs — 门 E 像素基准比对(Node 可信侧 PNG 解码/比较/热图)。

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildInputHashes,
  failJson,
  failProblems,
  TOOL_VERSION,
} from './lib/fs-utils.mjs';
import { validateSpec } from './lib/schema.mjs';
import { createSafeStaticServer } from './lib/safe-server.mjs';
import { launchChromium } from './lib/resolve-playwright.mjs';
import { freshLoad, replay } from './lib/replay.mjs';
import { comparePngs, loadPngApi, readPng, writePng } from './lib/png-compare.mjs';

const args = process.argv.slice(2);
const demoIdx = args.indexOf('--demo');
if (demoIdx === -1 || !args[demoIdx + 1]) failJson('缺 --demo <dir>');
const demoDir = resolve(args[demoIdx + 1]);

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
  writeFileSync(join(demoDir, 'report-pixel.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const { PNG, pixelmatch } = await loadPngApi(demoDir);
const baseDir = join(demoDir, 'baselines');
const artifactDir = join(demoDir, 'pixel-artifacts');
let safeServer;
let browser;
let page;
const results = [];
try {
  safeServer = createSafeStaticServer(demoDir);
  const base = await safeServer.listen();
  ({ browser } = await launchChromium(demoDir, { headless: true }));
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: spec.baselineDpr ?? 2 });

  for (const entry of declared) {
    const item = { key: entry.key, status: 'ERROR', diffRatio: null, bad: 0, total: 0, masked: 0, detail: '' };
    const baselinePath = join(baseDir, `${entry.key}.png`);
    try {
      if (!existsSync(baselinePath)) {
        item.status = 'MISSING';
        item.detail = `缺少基准图 baselines/${entry.key}.png`;
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
      const compared = comparePngs({
        PNG,
        pixelmatch,
        baseline,
        actual,
        cssSize: { width: box.width, height: box.height },
        masks: entry.mask ?? [],
        threshold: spec.pixelmatchThreshold ?? 0.1,
        maxMaskRatio: entry.maxMaskRatio ?? spec.maxMaskRatio ?? 0.25,
        minUnmaskedRatio: entry.minUnmaskedRatio ?? spec.minUnmaskedRatio ?? 0.5,
      });
      item.sidecar = {
        dpr: compared.dpr ?? { x: actual.width / box.width, y: actual.height / box.height },
        viewport: page.viewportSize(),
        host: { platform: process.platform, arch: process.arch },
        appCommit: process.env.GIT_COMMIT ?? process.env.CI_COMMIT_SHA ?? null,
        screenshot: { width: actual.width, height: actual.height },
        cssFrame: { width: box.width, height: box.height },
        sourceHash: buildInputHashes(demoDir, spec)['index.html'],
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
        const baseOut = join(artifactDir, `${entry.key}.baseline.png`);
        const demoOut = join(artifactDir, `${entry.key}.demo.png`);
        const diffOut = join(artifactDir, `${entry.key}.diff.png`);
        mkdirSync(artifactDir, { recursive: true });
        copyFileSync(baselinePath, baseOut);
        writeFileSync(demoOut, shot);
        writePng(PNG, diffOut, compared.diff);
        item.artifacts = {
          baseline: `pixel-artifacts/${entry.key}.baseline.png`,
          demo: `pixel-artifacts/${entry.key}.demo.png`,
          diff: `pixel-artifacts/${entry.key}.diff.png`,
        };
        const adj = readAdjudication(demoDir, entry.key);
        if (item.status === 'WARN') {
          if (adj?.ok === true) item.adjudication = adj;
          else item.detail += '; 缺人工裁决 artifact';
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
const ok = results.every((r) => r.status === 'PASS' || (r.status === 'WARN' && r.adjudication?.ok === true));
const out = {
  ok,
  skipped: false,
  toolVersion: TOOL_VERSION,
  threshold,
  compared: results.filter((r) => r.status !== 'MISSING').length,
  declared: declared.length,
  inputHashes: buildInputHashes(demoDir, spec),
  results,
  generatedAt: new Date().toISOString(),
};
writeFileSync(join(demoDir, 'report-pixel.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
process.exit(ok ? 0 : 2);
