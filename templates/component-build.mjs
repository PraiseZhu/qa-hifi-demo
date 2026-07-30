#!/usr/bin/env node
// build.mjs — 组件模式构建器(由 init.mjs --mode component 拷进 demo 目录)。
//
//   node build.mjs            # 读 spec.json 的 component 段,产出 assets/component.bundle.js
//
// 做三件事,全部由 spec.component 驱动(本文件通用,不写任何 demo 专属常量):
//   1. esbuild bundle:entry = component.bootstrap(demo 内的装配入口,import 真实产品组件);
//      alias = component.shims(精确替身)+ component.rendererRoot('@/' 前缀兜底)
//      + component.packageRoots(monorepo workspace 包 → 源码目录);
//   2. 图片资产走 file loader 落 component.assetsDir(不内联 base64——spike 实测全内联
//      让单文件涨到 10MB,仓里反复出现 10MB HTML 不可接受;xd-pages 本来就部署整个目录);
//   3. 可选 CSS:component.css 存在时用产品 tailwind config 编译出 assets/component.css
//      (不存在也一定写出空文件,保证 index.html 的 <link> 不 404)。
//
// 产品源码全程只读;产物只落在 demo 目录内的 assets/。
// esbuild / tailwind 都从**产品仓**解析(demo 自身不装依赖),顺序:
// $QA_HIFI_MODULE_ROOT → repoRoot → cwd。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRepoRoot, resolveFrom } from './extract-helpers.mjs';

const demoDir = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(demoDir, 'spec.json'), 'utf8'));
const comp = spec.component;
if (!comp) fail('spec.json 缺 component 段——build.mjs 只用于组件模式 demo');

const repoRoot = findRepoRoot(demoDir);
const R = (p) => (isAbsolute(p) ? p : join(repoRoot, p));
const D = (p) => (isAbsolute(p) ? p : join(demoDir, p));

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}

/* ── 参数取值 + 存在性前置校验(错在 build 期报清楚,别留到浏览器空白页) ── */
const bootstrap = D(comp.bootstrap ?? 'src/bootstrap.tsx');
if (!existsSync(bootstrap)) fail(`component.bootstrap 不存在:${bootstrap}`);
if (!comp.entry) fail('component.entry 必填(相对 repoRoot 的组件入口,供人核对与门 A 计 hash)');
if (!existsSync(R(comp.entry))) fail(`component.entry 不存在:${R(comp.entry)}`);

const assetsDir = D(comp.assetsDir ?? 'assets');
const bundleOut = D(comp.bundle ?? 'assets/component.bundle.js');
const cssOut = join(assetsDir, 'component.css');
mkdirSync(assetsDir, { recursive: true });

/** 无扩展名路径探测(.ts/.tsx/.js/.jsx/index.*)——alias 目标常写成无后缀。 */
function probeFile(base) {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/* ── alias 插件:精确 shim > workspace 包 > '@/' 前缀兜底 ── */
const shims = Object.fromEntries((comp.shims ?? []).map((s) => [s.spec, D(s.file)]));
for (const [spec_, file] of Object.entries(shims)) {
  if (!existsSync(file)) fail(`component.shims["${spec_}"] 指向的文件不存在:${file}`);
}
const packageRoots = Object.fromEntries(Object.entries(comp.packageRoots ?? {}).map(([pkg, root]) => [pkg, R(root)]));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/@-]/g, '\\$&');

/* workspace 包的 exports 子路径表:出口名是 kebab-case 而文件是 camelCase 时
   (如 "./brand-identity": "./src/brandIdentity.ts")只能查 package.json 的 exports,
   路径探测猜不出来。包根 = <packageRoots 值>/..(约定值指到包内 src)。 */
const packageExports = {};
for (const [pkg, root] of Object.entries(packageRoots)) {
  const pkgJson = join(root, '..', 'package.json');
  if (!existsSync(pkgJson)) continue;
  const map = {};
  for (const [sub, target] of Object.entries(JSON.parse(readFileSync(pkgJson, 'utf8')).exports ?? {})) {
    if (typeof target === 'string') map[sub.replace(/^\.\/?/, '')] = join(root, '..', target);
  }
  packageExports[pkg] = map;
}

const aliasPlugin = {
  name: 'qa-component-alias',
  setup(build) {
    for (const [spec_, target] of Object.entries(shims)) {
      build.onResolve({ filter: new RegExp(`^${esc(spec_)}$`) }, () => ({ path: target }));
    }
    for (const [pkg, root] of Object.entries(packageRoots)) {
      build.onResolve({ filter: new RegExp(`^${esc(pkg)}(\\/|$)`) }, (args) => {
        const sub = args.path.slice(pkg.length).replace(/^\//, '');
        // exports 表优先(kebab→camel 这类映射只有它知道),再退回路径探测
        const fromExports = packageExports[pkg]?.[sub || '.'];
        const hit = (fromExports && existsSync(fromExports) && fromExports) || probeFile(sub ? join(root, sub) : root);
        if (hit) return { path: hit };
        return { errors: [{ text: `qa-component-alias: ${args.path} 在 ${root} 下探测不到文件` }] };
      });
    }
    if (comp.rendererRoot) {
      const rendererRoot = R(comp.rendererRoot);
      build.onResolve({ filter: /^@\// }, (args) => {
        const hit = probeFile(join(rendererRoot, args.path.slice(2)));
        if (hit) return { path: hit };
        return { errors: [{ text: `qa-component-alias: ${args.path} 探测不到文件(基准 ${rendererRoot})` }] };
      });
    }
  },
};

/* ── vite 兼容:iife 下 import.meta 为空会 TypeError,做与 vite 构建期等价的静态替换 ── */
const viteEnvPlugin = {
  name: 'qa-vite-env-compat',
  setup(build) {
    build.onLoad({ filter: /\.tsx?$/ }, (args) => {
      const code = readFileSync(args.path, 'utf8');
      if (!code.includes('import.meta.env')) return undefined;
      return {
        contents: code.replace(/import\.meta\.env\?\./g, '({}).').replace(/import\.meta\.env\./g, '({}).'),
        loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
      };
    });
  },
};

/* ── 1. esbuild bundle ── */
const esbuildPath = resolveFrom('esbuild', [process.env.QA_HIFI_MODULE_ROOT, repoRoot, process.cwd()]);
const esbuildMod = await import(pathToFileURL(esbuildPath).href);
const esbuild = esbuildMod.default?.build ? esbuildMod.default : esbuildMod;

await esbuild.build({
  entryPoints: [bootstrap],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: comp.target ?? 'chrome120',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  // 图片/字体落成 assets/ 内独立文件,index.html 相对引用(资产 hash 由门 A 计入防伪链)
  loader: {
    '.png': 'file',
    '.jpg': 'file',
    '.jpeg': 'file',
    '.gif': 'file',
    '.svg': 'file',
    '.webp': 'file',
    '.woff': 'file',
    '.woff2': 'file',
  },
  assetNames: '[name]-[hash]',
  publicPath: `./${comp.assetsDir ?? 'assets'}`,
  plugins: [aliasPlugin, viteEnvPlugin],
  outfile: bundleOut,
  logLevel: 'silent',
});

/* ── 2. 可选 CSS(产品 tailwind config;不配置也写空文件保证 <link> 不 404) ── */
let cssBytes = 0;
if (comp.css?.tailwindConfig) {
  const inputCss = join(assetsDir, '.tailwind-input.css');
  writeFileSync(inputCss, comp.css.input ?? '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
  const bin = join(repoRoot, 'node_modules', '.bin', 'tailwindcss');
  if (!existsSync(bin)) fail(`component.css.tailwindConfig 已配置,但产品仓没有 tailwindcss CLI:${bin}`);
  const args = ['-c', R(comp.css.tailwindConfig), '-i', inputCss, '-o', cssOut];
  if (Array.isArray(comp.css.content) && comp.css.content.length) args.push('--content', comp.css.content.join(','));
  execFileSync(bin, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
  rmSync(inputCss, { force: true });
  cssBytes = readFileSync(cssOut).length;
} else {
  writeFileSync(cssOut, '/* 组件模式:spec.component.css 未配置,无编译产物(占位,保证 index.html <link> 不 404) */\n');
  cssBytes = readFileSync(cssOut).length;
}

console.log(JSON.stringify({
  ok: true,
  entry: comp.entry,
  bundle: comp.bundle ?? 'assets/component.bundle.js',
  bundleKB: Math.round(readFileSync(bundleOut).length / 1024),
  cssKB: Math.round(cssBytes / 1024),
  shims: Object.keys(shims),
}, null, 2));
