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
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRepoRoot, resolveFrom } from './extract-helpers.mjs';

const demoDir = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(demoDir, 'spec.json'), 'utf8'));
const comp = spec.component;
if (!comp) fail('spec.json 缺 component 段——build.mjs 只用于组件模式 demo');

const repoRoot = findRepoRoot(demoDir);
const R = (p) => (isAbsolute(p) ? p : join(repoRoot, p));
const D = (p) => (isAbsolute(p) ? p : join(demoDir, p));

function fail(message, code = 1) {
  console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(code);
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
   路径探测猜不出来。包根 = <packageRoots 值>/..(约定值指到包内 src)。
   (二修会把读过的 package.json 记进 manifest.buildInputs 一并入链。) */
const packageExports = {};
const readPackageJsons = [];
for (const [pkg, root] of Object.entries(packageRoots)) {
  const pkgJson = join(root, '..', 'package.json');
  if (!existsSync(pkgJson)) continue;
  readPackageJsons.push(pkgJson);
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
const loaderFor = (p) => (p.endsWith('.tsx') ? 'tsx' : p.endsWith('.ts') ? 'ts' : p.endsWith('.jsx') ? 'jsx' : 'js');
const viteCompat = (code) => code.replace(/import\.meta\.env\?\./g, '({}).').replace(/import\.meta\.env\./g, '({}).');
const viteEnvPlugin = {
  name: 'qa-vite-env-compat',
  setup(build) {
    build.onLoad({ filter: /\.tsx?$/, namespace: 'file' }, (args) => {
      const code = readFileSync(args.path, 'utf8');
      if (!code.includes('import.meta.env')) return undefined;
      return { contents: viteCompat(code), loader: loaderFor(args.path) };
    });
  },
};

/* ── 1. esbuild bundle ── */
const esbuildPath = resolveFrom('esbuild', [process.env.QA_HIFI_MODULE_ROOT, repoRoot, process.cwd()]);
const esbuildMod = await import(pathToFileURL(esbuildPath).href);
const esbuild = esbuildMod.default?.build ? esbuildMod.default : esbuildMod;

/* ── 1.0 运行期哨兵:入口组件「真被渲染」的机械证据(审核 #1c) ──
   仅证明 entry 出现在 metafile 输入里是不够的:`import '<entry>'` 这种副作用导入
   同样让 entry 进图、hash 入链,而界面完全可以是 bootstrap 手搓的——声明与渲染脱钩。
   这里给 entry 的每个导出套一层调用探针:被真正调用/实例化(React 渲染函数组件、
   new 类组件、memo/forwardRef 的 render)时置 globalThis.__QA_ENTRY_RENDERED__ = true,
   由 verify 在门 B 挂载后断言。同时记 __QA_ENTRY_SHAPE__.wrappable —— 导出全是
   非函数(常量/纯数据)时探针套不上,verify 不误判为造假,改由 pr-block 诚实降级。

   已知残余风险(不隐瞒):① bootstrap 调用 entry 的**非组件导出**(工具函数)也会置位;
   ② `export *` 转出的名字拿不到,不套探针。两者都由 pr-block 的降级文案与人工 review 兜。 */
const entryAbs = R(comp.entry);
const ENTRY_ORIG_NS = 'qa-entry-orig';
const ENTRY_ORIG_SPEC = 'qa-entry-orig:module';
const entrySource = readFileSync(entryAbs, 'utf8');
const entryWrappable = /\.(tsx?|jsx?|mjs|cjs)$/.test(entryAbs);
const entryHasStar = /(^|\n)\s*export\s+\*/.test(entrySource);

/** 用一次 bundle:false 的空跑拿 entry 的导出名(唯一可靠来源:esbuild 自己的 metafile)。 */
async function entryExportNames() {
  if (!entryWrappable) return [];
  try {
    const probe = await esbuild.build({
      entryPoints: [entryAbs],
      bundle: false,
      write: false,
      format: 'esm',
      metafile: true,
      logLevel: 'silent',
      outdir: join(demoDir, '.qa-export-probe'),
      loader: { '.ts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx' },
    });
    const out = Object.values(probe.metafile?.outputs ?? {})[0];
    return Array.isArray(out?.exports) ? out.exports.filter((n) => typeof n === 'string') : [];
  } catch {
    return [];
  }
}
const exportNames = await entryExportNames();

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['var', 'const', 'let', 'class', 'function', 'return', 'new', 'delete', 'in', 'of', 'do', 'if', 'else', 'null', 'true', 'false', 'this', 'void', 'typeof', 'import', 'export']);
function entryWrapperSource() {
  const L = [];
  L.push(`import * as __qaOrig from ${JSON.stringify(ENTRY_ORIG_SPEC)};`);
  L.push('var __qaShape = { total: 0, wrappable: 0, sentinel: true };');
  L.push('globalThis.__QA_ENTRY_SHAPE__ = __qaShape;');
  L.push('var __qaMark = function () { globalThis.__QA_ENTRY_RENDERED__ = true; };');
  L.push('var __qaFn = function (f) { return new Proxy(f, {');
  L.push('  apply: function (t, th, a) { __qaMark(); return Reflect.apply(t, th, a); },');
  L.push('  construct: function (t, a, nt) { __qaMark(); return Reflect.construct(t, a, nt); },');
  L.push('}); };');
  L.push('var __qaWrap = function (v) {');
  L.push('  __qaShape.total++;');
  L.push('  if (typeof v === "function") { __qaShape.wrappable++; return __qaFn(v); }');
  // React 的 memo()/forwardRef() 产物是带 $$typeof 的普通对象,真组件函数藏在 .type/.render。
  // 不复制对象(React 会按 $$typeof 与身份判定),改用 Proxy 只在 get 时换出探针函数。
  L.push('  if (v && typeof v === "object" && typeof v.$$typeof === "symbol"');
  L.push('      && (typeof v.render === "function" || typeof v.type === "function")) {');
  L.push('    __qaShape.wrappable++;');
  L.push('    var __c = {};');
  L.push('    return new Proxy(v, { get: function (t, k, r) {');
  L.push('      var val = Reflect.get(t, k, r);');
  L.push('      if ((k === "render" || k === "type") && typeof val === "function") {');
  L.push('        if (!__c[k]) __c[k] = __qaFn(val);');
  L.push('        return __c[k];');
  L.push('      }');
  L.push('      return val;');
  L.push('    } });');
  L.push('  }');
  L.push('  return v;');
  L.push('};');
  if (entryHasStar) L.push(`export * from ${JSON.stringify(ENTRY_ORIG_SPEC)};`);
  exportNames.forEach((name, i) => {
    L.push(`var __qa_${i} = __qaWrap(__qaOrig[${JSON.stringify(name)}]);`);
    const asName = name === 'default' ? 'default' : IDENT.test(name) && !RESERVED.has(name) ? name : JSON.stringify(name);
    L.push(`export { __qa_${i} as ${asName} };`);
  });
  return `${L.join('\n')}\n`;
}

const entryReal = realpathSync(entryAbs);
const sentinelActive = entryWrappable && exportNames.length > 0;
const entrySentinelPlugin = {
  name: 'qa-entry-sentinel',
  setup(build) {
    build.onResolve({ filter: new RegExp(`^${esc(ENTRY_ORIG_SPEC)}$`) }, () => ({ path: entryAbs, namespace: ENTRY_ORIG_NS }));
    build.onLoad({ filter: /.*/, namespace: ENTRY_ORIG_NS }, (args) => ({
      contents: viteCompat(readFileSync(args.path, 'utf8')),
      loader: loaderFor(args.path),
      resolveDir: dirname(args.path),
    }));
    build.onLoad({ filter: /\.(tsx?|jsx?|mjs|cjs)$/, namespace: 'file' }, (args) => {
      if (!sentinelActive) return undefined;
      let hit = args.path === entryAbs;
      if (!hit) { try { hit = realpathSync(args.path) === entryReal; } catch { hit = false; } }
      if (!hit) return undefined;
      return { contents: entryWrapperSource(), loader: 'js', resolveDir: dirname(args.path) };
    });
  },
};

const buildResult = await esbuild.build({
  metafile: true,
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
  // 哨兵插件必须在 vite 兼容插件之前:entry 的加载由它接管(替换成 wrapper),
  // 真源码在 qa-entry-orig namespace 里读并就地做同样的 import.meta.env 替换。
  plugins: [entrySentinelPlugin, aliasPlugin, viteEnvPlugin],
  outfile: bundleOut,
  logLevel: 'silent',
});

/* ── 1.5 esbuild metafile → inputs manifest(防伪链真相源) ──
   component.entry / component.sources 是「作者声明」,esbuild 真正读了哪些文件只有
   metafile 知道。bootstrap 完全可以不 import entry(手搓一份假 UI),此时 entry hash
   照样是真组件的 hash、bundle 里却一个真组件字节都没有——声明与产物脱钩。
   规范化落成 component.inputs.json:
     productInputs — 产品仓内(相对 repoRoot)的真实 bundle 输入,门 A 逐文件 sha256;
     demoInputs    — demo 内(相对 demoDir)的输入(bootstrap / shims / 本地 CSS 等);
   node_modules 与仓外文件不入链(第三方依赖版本由产品仓 lockfile 管,不是本工具职责),
   仅记数量供人核对。并强制 component.entry ∈ productInputs,否则构建直接失败。

   规范化收在一个 normalizeInputs 里(二修会让 --check-inputs 复用同一份实现)。 */
const toPosix = (p) => p.split(sep).join('/');
// macOS 的 /var → /private/var 这类 symlink 会让「同一个文件」出现两种绝对路径,
// 归属判断必须在 realpath 空间里做,否则产品输入会被误判成仓外而整体丢链。
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const demoReal = real(demoDir);
const repoReal = real(repoRoot);
const inside = (root, abs) => abs === root || abs.startsWith(root + sep);
// metafile 的 key 对自定义 namespace 是 "<ns>:<path>";哨兵把 entry 真源码放在
// qa-entry-orig 下,这里剥掉前缀,让它照常按真实文件路径归位(与未加哨兵前一致)。
const stripNs = (key) => (key.startsWith(`${ENTRY_ORIG_NS}:`) ? key.slice(ENTRY_ORIG_NS.length + 1) : key);

function normalizeInputs(metafile) {
  const productInputs = new Set();
  const demoInputs = new Set();
  let skippedExternal = 0;
  for (const key of Object.keys(metafile?.inputs ?? {})) {
    const abs = real(resolve(process.cwd(), stripNs(key)));
    if (abs.split(sep).includes('node_modules')) { skippedExternal += 1; continue; }
    if (inside(demoReal, abs)) demoInputs.add(toPosix(relative(demoReal, abs)));
    else if (inside(repoReal, abs)) productInputs.add(toPosix(relative(repoReal, abs)));
    else skippedExternal += 1;
  }
  return {
    generator: 'qa-hifi-demo/component-build',
    entry: comp.entry,
    entrySentinel: sentinelActive ? 'active' : 'unavailable',
    productInputs: [...productInputs].sort(),
    demoInputs: [...demoInputs].sort(),
    skippedExternal,
  };
}

const manifest = normalizeInputs(buildResult.metafile);
const entryRel = toPosix(relative(repoReal, real(entryAbs)));
if (!manifest.productInputs.includes(entryRel)) {
  fail(
    `声明的入口未被 bundle——bootstrap 没有 import 它:component.entry="${comp.entry}" 不在 esbuild 真实输入里。`
    + `\n真实产品输入(${manifest.productInputs.length} 个)前若干:${manifest.productInputs.slice(0, 10).join(', ') || '(空)'}`
    + '\n修法:让 bootstrap 直接 import 该入口组件渲染(组件模式的意义就是真组件直渲),或把 entry 改成 bootstrap 真正渲染的那个组件。',
    2,
  );
}

/* ── 1.6 tree-shake 护栏:entry 在图里但一个字节都没进产物 = 等于没打包 ──
   metafile.outputs[out].inputs[key].bytesInOutput === 0 说明 esbuild 把它整体摇掉了
   (只 import type、或导出全未被引用且无副作用)。此时防伪链锁的是一份没进产物的源码。 */
// 注意:被完整摇掉的模块在 metafile.inputs 里仍在,却整段不出现在 outputs[].inputs ——
// 「查不到」与「0 字节」是同一件事,一律记 0(实测 esbuild 行为,不是猜)。
const entryOutBytes = (() => {
  let bytes = 0;
  for (const out of Object.values(buildResult.metafile?.outputs ?? {})) {
    for (const [key, info] of Object.entries(out?.inputs ?? {})) {
      if (real(resolve(process.cwd(), stripNs(key))) !== entryReal) continue;
      bytes += info?.bytesInOutput ?? 0;
    }
  }
  return bytes;
})();
if (entryOutBytes === 0) {
  fail(
    `声明的入口被整体 tree-shake——component.entry="${comp.entry}" 在 esbuild 输入图里,`
    + '但进入产物的字节数是 0(只被 import type?导出全未被引用且无副作用?)。'
    + '\n修法:让 bootstrap 真的渲染该组件;只想引类型就把 entry 改成真正渲染的那个组件。',
    2,
  );
}

writeFileSync(join(demoDir, 'component.inputs.json'), `${JSON.stringify(manifest, null, 2)}\n`);

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
  entrySentinel: manifest.entrySentinel,
  bundle: comp.bundle ?? 'assets/component.bundle.js',
  bundleKB: Math.round(readFileSync(bundleOut).length / 1024),
  cssKB: Math.round(cssBytes / 1024),
  inputsManifest: 'component.inputs.json',
  productInputs: manifest.productInputs.length,
  demoInputs: manifest.demoInputs.length,
  shims: Object.keys(shims),
}, null, 2));
