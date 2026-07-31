#!/usr/bin/env node
// build.mjs — 组件模式构建器**薄壳**(由 init.mjs --mode component 拷进 demo 目录)。
//
//   node build.mjs                  # 读 spec.json 的 component 段,产出 assets/component.bundle.js
//   node build.mjs --check-inputs   # 不落任何产物,只把输入图重算一遍打到 stdout
//
// 构建规范(esbuild 输入图 / 哨兵 / 清单规范化)全部在 ./component-build-core.mjs —— 与
// skill 仓 scripts/lib/component-build-core.mjs 是同一份文件的拷贝。
//
// 重要(审核 #2c-a):verify / pr-block 的**独立复算不会执行本文件**,它们直接跑 skill 仓
// 自己那份 core。本文件与 core 的 demo 侧拷贝只服务作者本地出产物,且 sha256 必须与
// skill canonical 全等,不一致 → 门 A fail-closed 报「检测到自定义构建器,需人工审查」。
// 所以「把 build.mjs 换成原样回显旧清单的脚本」这条路在 r3 起不再存在。
//
// 本文件只做三件薄事:
//   1. 调 core 完成 esbuild bundle + 输入清单(含 entry 在图 / 未被摇掉 / 哨兵等全部护栏);
//   2. 落 component.inputs.json;
//   3. 可选 CSS:component.css 存在时用产品 tailwind config 编译出 assets/component.css
//      (不存在也一定写出空文件,保证 index.html 的 <link> 不 404)。
//
// 产品源码全程只读;产物只落在 demo 目录内的 assets/。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentBuildError, computeComponentBuild, contentCliArg, CSS_PLACEHOLDER, DEFAULT_TAILWIND_INPUT } from './component-build-core.mjs';

const demoDir = dirname(fileURLToPath(import.meta.url));
const CHECK_ONLY = process.argv.includes('--check-inputs');

function fail(message, code = 1) {
  console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(code);
}

let built;
try {
  built = await computeComponentBuild({ demoDir, checkOnly: CHECK_ONLY });
} catch (err) {
  fail(String(err?.message ?? err), err instanceof ComponentBuildError ? err.code : 1);
}

const { comp, repoRoot, manifest, assetsDir, bundleOut, cssOut } = built;
const R = (p) => (isAbsolute(p) ? p : join(repoRoot, p));

if (CHECK_ONLY) {
  // 独立复算模式:只把清单打到 stdout(与 component.inputs.json 可全等比对),不落任何产物
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  process.exit(0);
}

mkdirSync(assetsDir, { recursive: true });
writeFileSync(join(demoDir, 'component.inputs.json'), `${JSON.stringify(manifest, null, 2)}\n`);

/* ── 可选 CSS(产品 tailwind config;不配置也写空文件保证 <link> 不 404) ── */
let cssBytes = 0;
if (comp.css?.tailwindConfig) {
  const inputCss = join(assetsDir, '.tailwind-input.css');
  writeFileSync(inputCss, comp.css.input ?? DEFAULT_TAILWIND_INPUT);
  const bin = join(repoRoot, 'node_modules', '.bin', 'tailwindcss');
  if (!existsSync(bin)) fail(`component.css.tailwindConfig 已配置,但产品仓没有 tailwindcss CLI:${bin}`);
  /* --content 始终显式传(r4 追加 #2c-b):不传时 Tailwind 按 config.content 隐式扫描,
     那些文件不入 component.inputs.json 防伪链。
     r7 条目 2:content 是**显式文件路径列表**,参数构造统一走构建核心的 contentCliArg
     (转成绝对路径)—— 两侧参数必须逐字节一致,否则可信侧 CSS 字节复算会误杀本地产物。
     content 非空/格式/存在性由构建核心 fail-closed 保证,这里不再自己判。 */
  const args = ['-c', R(comp.css.tailwindConfig), '-i', inputCss, '-o', cssOut, '--content', contentCliArg(repoRoot, comp)];
  execFileSync(bin, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
  rmSync(inputCss, { force: true });
  cssBytes = readFileSync(cssOut).length;
} else {
  // 占位字节由构建核心导出(CSS_PLACEHOLDER):可信侧 --check-css 对它做字节复算,
  // 两侧必须是同一个常量,不许在这里写字面量(写死就会漂移 → 误杀)。
  writeFileSync(cssOut, CSS_PLACEHOLDER);
  cssBytes = readFileSync(cssOut).length;
}

console.log(JSON.stringify({
  ok: true,
  entry: comp.entry,
  entryExport: manifest.entryExport,
  entrySentinel: manifest.entrySentinel,
  bundle: comp.bundle ?? 'assets/component.bundle.js',
  bundleKB: Math.round(readFileSync(bundleOut).length / 1024),
  cssKB: Math.round(cssBytes / 1024),
  inputsManifest: 'component.inputs.json',
  productInputs: manifest.productInputs.length,
  demoInputs: manifest.demoInputs.length,
  buildInputs: manifest.buildInputs.demo.length + manifest.buildInputs.product.length,
  shims: (comp.shims ?? []).map((s) => s.spec),
}, null, 2));
