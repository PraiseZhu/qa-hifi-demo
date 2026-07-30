// comp-assets.test.mjs — 资产清单工具 + assets 段防伪链。
// 独立新文件,fixture 自给自足(不依赖其他 test 的 helper)。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAssetsManifest, buildInputHashes, hashFile, sameInputHashes, TOOL_VERSION } from '../lib/fs-utils.mjs';
import { validateReportIntegrity } from '../lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MANIFEST = join(ROOT, 'scripts/assets-manifest.mjs');

function run(args) {
  return spawnSync(process.execPath, [MANIFEST, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
}

// 最小 demo:只需 spec/truth/index 三件套(buildInputHashes 要读),assets 可选
function tmpDemo({ assets = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-hifi-assets-'));
  const spec = { meta: { name: 'a' }, baselines: [] };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'truth.json'), JSON.stringify({}, null, 2));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>demo</body></html>');
  if (assets) {
    for (const [rel, bytes] of Object.entries(assets)) {
      const file = join(dir, 'assets', rel);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, typeof bytes === 'number' ? Buffer.alloc(bytes, 7) : bytes);
    }
  }
  return { dir, spec };
}

test('assets-manifest:清单含路径/sha256/字节数/总大小,限内 exit 0', () => {
  const { dir } = tmpDemo({ assets: { 'hero.png': 1024, 'img/logo.svg': '<svg/>' } });
  const r = run(['--demo', dir]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  // 路径统一 demo 相对 posix、按路径稳定排序(嵌套目录在前)
  assert.deepEqual(out.files.map((f) => f.path), ['assets/hero.png', 'assets/img/logo.svg']);
  const hero = out.files.find((f) => f.path === 'assets/hero.png');
  assert.equal(hero.size, 1024);
  assert.equal(hero.sha256, hashFile(join(dir, 'assets/hero.png')));
  assert.equal(out.totalBytes, out.files.reduce((s, f) => s + f.size, 0));
  assert.equal(out.maxTotalBytes, 8 * 1024 * 1024); // 缺省 8MB
  assert.equal(out.indexHtmlBytes > 0, true);
  assert.equal(out.grandTotalBytes, out.totalBytes + out.indexHtmlBytes);
});

test('assets-manifest:无 assets 目录时清单为空且不报错(旧 demo)', () => {
  const { dir } = tmpDemo();
  const r = run(['--demo', dir]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.count, 0);
  assert.equal(out.totalBytes, 0);
});

test('assets-manifest:超 --max-total 时 exit 2 并点名最大项', () => {
  const { dir } = tmpDemo({ assets: { 'hero.png': 300 * 1024, 'tiny.txt': 'x' } });
  const r = run(['--demo', dir, '--max-total', '0.1']); // 0.1MB 上限
  assert.equal(r.status, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.problems.join('\n'), /超过上限/);
  assert.match(out.problems.join('\n'), /assets\/hero\.png/);
});

test('assets-manifest:缺 --demo / 非法 --max-total 都 exit 2', () => {
  assert.equal(run([]).status, 2);
  const { dir } = tmpDemo();
  assert.equal(run(['--demo', dir, '--max-total', '0']).status, 2);
  assert.equal(run(['--demo', dir, '--max-total', 'abc']).status, 2);
  assert.equal(run(['--demo', join(dir, 'nope')]).status, 2);
});

test('inputHashes:有 assets 时进链,改图后旧 report 被拒', () => {
  const { dir, spec } = tmpDemo({ assets: { 'hero.png': 64 } });
  const hashes = buildInputHashes(dir, spec);
  assert.equal(Array.isArray(hashes.assets), true);
  assert.deepEqual(hashes.assets, buildAssetsManifest(dir).files);

  const report = {
    toolVersion: TOOL_VERSION,
    ok: true,
    inputHashes: hashes,
    coverage: { cases: [{ id: 'c1', prefs: {} }] },
    gateA: { pass: true, total: 1, passed: 1, failures: [] },
    gateB: { pass: true, total: 1, passed: 1, failures: [] },
    gateC: { pass: true, total: 1, passed: 1, failures: [], checks: [] },
    gateD: { pass: true, total: 0, passed: 0, failures: [] },
    gateF: { pass: true, total: 0, passed: 0, failures: [] },
    gateX: { pass: true, total: 0, passed: 0, failures: [] },
  };
  assert.deepEqual(validateReportIntegrity(dir, spec, report), []);

  // 换图(同名不同字节)= 线上/PR 里的 demo 变了,旧 report 必须失效
  writeFileSync(join(dir, 'assets/hero.png'), Buffer.alloc(64, 9));
  const after = validateReportIntegrity(dir, spec, report);
  assert.equal(after.some((p) => /输入 hash .*不一致/.test(p)), true, after.join('\n'));
  assert.equal(sameInputHashes(hashes, buildInputHashes(dir, spec)), false);

  // 删掉整个资产也算变更(不是「少一项就当没有」)
  writeFileSync(join(dir, 'assets/hero.png'), Buffer.alloc(64, 7));
  assert.equal(sameInputHashes(hashes, buildInputHashes(dir, spec)), true); // 还原后应再次一致
});

test('inputHashes:无 assets 目录时整段省略,旧 demo 结构与校验不受影响', () => {
  const { dir, spec } = tmpDemo();
  const hashes = buildInputHashes(dir, spec);
  assert.equal('assets' in hashes, false);
  // 旧 demo 的 report(没有 assets 段)照旧通过完整性校验
  const report = {
    toolVersion: TOOL_VERSION,
    ok: true,
    inputHashes: hashes,
    coverage: { cases: [{ id: 'c1', prefs: {} }] },
    gateA: { pass: true, total: 1, passed: 1, failures: [] },
    gateB: { pass: true, total: 1, passed: 1, failures: [] },
    gateC: { pass: true, total: 1, passed: 1, failures: [], checks: [] },
    gateD: { pass: true, total: 0, passed: 0, failures: [] },
    gateF: { pass: true, total: 0, passed: 0, failures: [] },
    gateX: { pass: true, total: 0, passed: 0, failures: [] },
  };
  assert.deepEqual(validateReportIntegrity(dir, spec, report), []);

  // 之后新增 assets/(把图搬出内联)= 输入变了,旧 report 同样要失效
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets/hero.png'), Buffer.alloc(8, 1));
  assert.equal(sameInputHashes(hashes, buildInputHashes(dir, spec)), false);
});
