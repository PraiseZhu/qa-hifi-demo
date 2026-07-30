// component-build-core.mjs — 组件模式的**构建规范正本**(esbuild 输入图 + 规范化清单)。
//
// 为什么要有这一层(审核 #2c-a):r2 的独立复算是 `node <demo>/build.mjs --check-inputs`,
// oracle 本身是 demo 目录里可手改的脚本——把 build.mjs 换成「原样回显现有
// component.inputs.json」就能让缩链后的 demo 全绿,自证闭环没断。
// r3 起:
//   * 构建规范只有这一份实现(本文件),normalizeInputs 也只有这一份;
//   * verify / pr-block 的复算**直接跑 skill 仓自己的这份**(spawn 本文件的 CLI),
//     复算路径上不执行 demo 目录里的任何代码;
//   * demo 里那份拷贝只服务 `node build.mjs`(作者本地出产物),且其 sha256 必须与
//     skill canonical 一致,不一致 → fail-closed「检测到自定义构建器,需人工审查」。
//
// CLI(仅供 skill 侧复算与薄壳 build.mjs 使用):
//   node component-build-core.mjs --check-inputs --demo <demoDir>
//     → 只重算输入图,把规范化清单打到 stdout,不落任何产物。

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRepoRoot, resolveFrom } from './extract-helpers.mjs';
import { expandRepoGlob } from './repo-glob.mjs';

export const CORE_FILE_NAME = 'component-build-core.mjs';
export const BUILDER_FILE_NAME = 'build.mjs';
/** demo 侧随模板下发的构建期文件:hash 必须与 skill canonical 全等(防「自定义构建器」)。 */
export const DEMO_BUILD_FILES = [BUILDER_FILE_NAME, CORE_FILE_NAME, 'extract-helpers.mjs', 'repo-glob.mjs'];

export class ComponentBuildError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const fail = (message, code = 1) => { throw new ComponentBuildError(message, code); };

const ENTRY_ORIG_NS = 'qa-entry-orig';
const ENTRY_ORIG_SPEC = 'qa-entry-orig:module';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/@-]/g, '\\$&');
const toPosix = (p) => p.split(sep).join('/');
const loaderFor = (p) => (p.endsWith('.tsx') ? 'tsx' : p.endsWith('.ts') ? 'ts' : p.endsWith('.jsx') ? 'jsx' : 'js');
/* vite 兼容:iife 下 import.meta 为空会 TypeError,做与 vite 构建期等价的静态替换 */
const viteCompat = (code) => code.replace(/import\.meta\.env\?\./g, '({}).').replace(/import\.meta\.env\./g, '({}).');

/** 无扩展名路径探测(.ts/.tsx/.js/.jsx/index.*)——alias 目标常写成无后缀。 */
function probeFile(base) {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`]) {
    if (existsSync(c)) return c;
  }
  return null;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['var', 'const', 'let', 'class', 'function', 'return', 'new', 'delete', 'in', 'of', 'do', 'if', 'else', 'null', 'true', 'false', 'this', 'void', 'typeof', 'import', 'export']);

/**
 * 组件模式构建/复算的唯一入口。
 *
 * @param {{demoDir: string, checkOnly?: boolean}} opts
 *   checkOnly=true 时 esbuild write:false,只算输入图,不落 bundle / 不写 manifest / 不编 CSS。
 * @returns {Promise<{spec, comp, repoRoot, demoDir, R, D, manifest, assetsDir, bundleOut, cssOut, sentinel}>}
 */
export async function computeComponentBuild({ demoDir, checkOnly = false }) {
  const specFile = join(demoDir, 'spec.json');
  if (!existsSync(specFile)) fail(`demo 目录缺 spec.json:${specFile}`, 2);
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  const comp = spec.component;
  if (!comp) fail('spec.json 缺 component 段——组件构建核心只用于组件模式 demo');

  const repoRoot = findRepoRoot(demoDir);
  const R = (p) => (isAbsolute(p) ? p : join(repoRoot, p));
  const D = (p) => (isAbsolute(p) ? p : join(demoDir, p));

  /* ── 参数取值 + 存在性前置校验(错在 build 期报清楚,别留到浏览器空白页) ── */
  const bootstrap = D(comp.bootstrap ?? 'src/bootstrap.tsx');
  if (!existsSync(bootstrap)) fail(`component.bootstrap 不存在:${bootstrap}`);
  if (!comp.entry) fail('component.entry 必填(相对 repoRoot 的组件入口,供人核对与门 A 计 hash)');
  if (!existsSync(R(comp.entry))) fail(`component.entry 不存在:${R(comp.entry)}`);

  const assetsDir = D(comp.assetsDir ?? 'assets');
  const bundleOut = D(comp.bundle ?? 'assets/component.bundle.js');
  const cssOut = join(assetsDir, 'component.css');

  /* ── alias 插件:精确 shim > workspace 包 > '@/' 前缀兜底 ── */
  const shims = Object.fromEntries((comp.shims ?? []).map((s) => [s.spec, D(s.file)]));
  for (const [spec_, file] of Object.entries(shims)) {
    if (!existsSync(file)) fail(`component.shims["${spec_}"] 指向的文件不存在:${file}`);
  }
  const packageRoots = Object.fromEntries(Object.entries(comp.packageRoots ?? {}).map(([pkg, root]) => [pkg, R(root)]));

  /* workspace 包的 exports 子路径表:出口名是 kebab-case 而文件是 camelCase 时
     (如 "./brand-identity": "./src/brandIdentity.ts")只能查 package.json 的 exports,
     路径探测猜不出来。包根 = <packageRoots 值>/..(约定值指到包内 src)。
     读过的 package.json 同样是构建输入(改 exports 会改整张图),记进 buildInputs 进链。 */
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

  /* ── esbuild 从**产品仓**解析(demo 自身不装依赖) ──
     候选链只许放**不受单个 demo 目录内容左右**的目录(审核 r4 CRITICAL):
     QA_HIFI_MODULE_ROOT 由运行者显式设置,repoRoot 由 git rev-parse --show-toplevel 得到。
     r3 曾把 process.cwd() 兜在最后 —— 而复算路径(recheckComponentInputs)正是把子进程
     cwd 设成 demoDir 的,于是 `<demo>/node_modules/esbuild/index.js` 成了默认入口下的
     任意代码执行:CJS 顶层代码在 import 时同步跑,且 node_modules 既不入哈希链、
     也不在 checkDemoBuilderIntegrity 的具名文件表里 —— 全绿地被执行。
     结论:**解析候选里绝不允许出现 cwd / demoDir 这类不可信侧路径**。 */
  const esbuildPath = resolveFrom('esbuild', [process.env.QA_HIFI_MODULE_ROOT, repoRoot]);
  const esbuildMod = await import(pathToFileURL(esbuildPath).href);
  const esbuild = esbuildMod.default?.build ? esbuildMod.default : esbuildMod;

  /* ── 运行期哨兵:入口**目标组件**「真被渲染」的机械证据(审核 #1c) ──
     仅证明 entry 出现在 metafile 输入里是不够的:`import '<entry>'` 这种副作用导入
     同样让 entry 进图、hash 入链,而界面完全可以是 bootstrap 手搓的——声明与渲染脱钩。

     r2 的做法是给 entry 的**每个**导出套探针,任一被调用即判「真组件直渲」。
     r3 终审实证这仍可绕:entry 同时导出组件 Claimed() 与工具函数 utility(),
     bootstrap 只调 utility() + 手搓 UI,照样 proved。
     r3 起:只有 spec 声明了 `component.export`(目标组件导出名)、且该导出真被调用,
     才允许 proved;其余一切情形一律降级,PR 块不得出现「真组件直渲」。 */
  const entryAbs = R(comp.entry);
  const entrySource = readFileSync(entryAbs, 'utf8');
  const entryWrappable = /\.(tsx?|jsx?|mjs|cjs)$/.test(entryAbs);
  const entryHasStar = /(^|\n)\s*export\s+\*/.test(entrySource);
  const targetExport = typeof comp.export === 'string' && comp.export ? comp.export : null;

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

  // 声明了不存在的导出 = spec 写错了,直接失败(不许静默降级掩盖错误声明)
  if (targetExport) {
    if (!entryWrappable)
      fail(
        `component.export="${targetExport}" 已声明,但 component.entry 不是可解析的 JS/TS 模块(${comp.entry})——`
        + '哨兵套不上探针,无法证明目标导出被渲染。修法:删掉 component.export,或把 entry 改成真正的组件源文件。',
        2,
      );
    if (!exportNames.includes(targetExport))
      fail(
        `component.export="${targetExport}" 在 component.entry(${comp.entry})里不存在——`
        + `该文件的导出是:${exportNames.length ? exportNames.join(', ') : '(空)'}。`
        + '\n修法:改成真实的目标组件导出名(默认导出写 "default"),或删掉该字段(删掉则不再宣称「真组件直渲」)。',
        2,
      );
  }

  function entryWrapperSource() {
    const L = [];
    L.push(`import * as __qaOrig from ${JSON.stringify(ENTRY_ORIG_SPEC)};`);
    L.push(`var __qaTarget = ${JSON.stringify(targetExport)};`);
    /* ── 哨兵证据必须是**封印的只读量**(审核 r4 追加 #1c) ──
       r3 把证据写在 globalThis.__QA_ENTRY_RENDERED__ / __QA_ENTRY_TARGET_RENDERED__ /
       __QA_ENTRY_SHAPE__ 这三个公开可写的字段上,而 bootstrap 本就是允许作者编辑、
       且已入 hash 链的输入 —— 于是「只 `globalThis.keep = Claimed` 持引用、从不调用,
       再把两个布尔量直接写 true + 手搓 UI」能拿到 proved 与「真组件直渲」。
       修法:计数/置位全部留在本模块闭包里(bundle 内的模块作用域,页面脚本拿不到),
       对外只暴露一个 non-writable/non-configurable 的全局,其上只有 get-only 的
       snapshot 访问器。demo 侧写旧字段不再有任何作用;想顶替这个全局只有两种下场:
       抢先定义成可配置的 → 被我们覆盖;抢先定义成不可配置的 → 下面的 defineProperty
       直接抛错、bundle 初始化失败、门 B 红(不 try/catch,就是要 fail-closed)。 */
    L.push('var __qaRendered = false, __qaTargetRendered = false;');
    L.push('var __qaShape = { total: 0, wrappable: 0, sentinel: true, target: __qaTarget, targetWrappable: 0 };');
    L.push('var __qaMark = function (isTarget) {');
    L.push('  __qaRendered = true;');
    L.push('  if (isTarget) __qaTargetRendered = true;');
    L.push('};');
    L.push('var __qaSeal = {};');
    L.push('Object.defineProperty(__qaSeal, "snapshot", { enumerable: false, configurable: false, get: function () {');
    L.push('  return Object.freeze({ rendered: __qaRendered, targetRendered: __qaTargetRendered,');
    L.push('    shape: Object.freeze({ total: __qaShape.total, wrappable: __qaShape.wrappable,');
    L.push('      targetWrappable: __qaShape.targetWrappable, target: __qaShape.target, sentinel: true }) });');
    L.push('} });');
    L.push('Object.freeze(__qaSeal);');
    L.push('Object.defineProperty(globalThis, "__QA_ENTRY_SENTINEL__", { value: __qaSeal, writable: false, configurable: false, enumerable: false });');
    L.push('var __qaFn = function (f, isTarget) { return new Proxy(f, {');
    L.push('  apply: function (t, th, a) { __qaMark(isTarget); return Reflect.apply(t, th, a); },');
    L.push('  construct: function (t, a, nt) { __qaMark(isTarget); return Reflect.construct(t, a, nt); },');
    L.push('}); };');
    L.push('var __qaWrap = function (v, isTarget) {');
    L.push('  __qaShape.total++;');
    L.push('  var __ok = function () { __qaShape.wrappable++; if (isTarget) __qaShape.targetWrappable = 1; };');
    L.push('  if (typeof v === "function") { __ok(); return __qaFn(v, isTarget); }');
    // React 的 memo()/forwardRef() 产物是带 $$typeof 的普通对象,真组件函数藏在 .type/.render。
    // 不复制对象(React 会按 $$typeof 与身份判定),改用 Proxy 只在 get 时换出探针函数。
    L.push('  if (v && typeof v === "object" && typeof v.$$typeof === "symbol"');
    L.push('      && (typeof v.render === "function" || typeof v.type === "function")) {');
    L.push('    __ok();');
    L.push('    var __c = {};');
    L.push('    return new Proxy(v, { get: function (t, k, r) {');
    L.push('      var val = Reflect.get(t, k, r);');
    L.push('      if ((k === "render" || k === "type") && typeof val === "function") {');
    L.push('        if (!__c[k]) __c[k] = __qaFn(val, isTarget);');
    L.push('        return __c[k];');
    L.push('      }');
    L.push('      return val;');
    L.push('    } });');
    L.push('  }');
    L.push('  return v;');
    L.push('};');
    if (entryHasStar) L.push(`export * from ${JSON.stringify(ENTRY_ORIG_SPEC)};`);
    exportNames.forEach((name, i) => {
      L.push(`var __qa_${i} = __qaWrap(__qaOrig[${JSON.stringify(name)}], ${JSON.stringify(name === targetExport)});`);
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
    write: !checkOnly,
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

  /* ── esbuild metafile → inputs manifest(防伪链真相源) ──
     component.entry / component.sources 是「作者声明」,esbuild 真正读了哪些文件只有
     metafile 知道。规范化落成 component.inputs.json:
       productInputs — 产品仓内(相对 repoRoot)的真实 bundle 输入,门 A 逐文件 sha256;
       demoInputs    — demo 内(相对 demoDir)的输入(bootstrap / shims / 本地 CSS 等);
       buildInputs   — 构建**过程**的输入(build.mjs / 构建核心 / tailwind config +
                       其 content 命中的每个文件 / 读过的 package.json):改它们能改整张
                       图或整份 CSS,不入链等于留后门;
     node_modules 与仓外文件不入链(第三方依赖版本由产品仓 lockfile 管),仅记数量供人核对。 */
  const CWD = process.cwd();
  // macOS 的 /var → /private/var 这类 symlink 会让「同一个文件」出现两种绝对路径,
  // 归属判断必须在 realpath 空间里做,否则产品输入会被误判成仓外而整体丢链。
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const demoReal = real(demoDir);
  const repoReal = real(repoRoot);
  const inside = (root, abs) => abs === root || abs.startsWith(root + sep);
  // metafile 的 key 对自定义 namespace 是 "<ns>:<path>";哨兵把 entry 真源码放在
  // qa-entry-orig 下,这里剥掉前缀,让它照常按真实文件路径归位。
  const stripNs = (key) => (key.startsWith(`${ENTRY_ORIG_NS}:`) ? key.slice(ENTRY_ORIG_NS.length + 1) : key);

  /** tailwind content:声明了就必须能展开成实际文件并逐一入链(审核 #2c-b)。 */
  function tailwindContentFiles() {
    const list = Array.isArray(comp.css?.content) ? comp.css.content : [];
    /* ── css 非 null 时 content 必填(审核 r4 追加 #2c-b,方案 A) ──
       r3 允许 `css: { tailwindConfig }` 不带 content:那时 build 不传 --content,
       Tailwind 按 **config.content** 隐式扫描,而清单只记 tailwind.config.js 本身,
       config.content 命中的样式源文件全不入链 —— 改它们 hash 不变、旧 CSS 照过门。
       现在:配了 css 就必须显式声明 content(非空),build 也始终用 --content 覆盖 config,
       隐式扫描这条路彻底关掉。 */
    if (comp.css && (!Array.isArray(comp.css.content) || comp.css.content.length === 0))
      fail(
        'component.css 已配置但 component.css.content 缺失/为空——组件模式要求**显式**声明 tailwind content。'
        + '\n原因:不显式声明时 Tailwind 会按 tailwind.config.js 里的 content 隐式扫描,而那些被扫到的'
        + '样式源文件不会进 component.inputs.json 防伪链;改样式源文件 hash 不变,旧 CSS + 旧 report 照过验收。'
        + '\n修法:把 config 里 content 的等价 glob 抄进 component.css.content(仓内相对,只支持 * / ** / ?);'
        + '真不需要 tailwind 就把 component.css 设为 null。',
        2,
      );
    const out = new Set();
    for (const pattern of list) {
      if (typeof pattern !== 'string' || !pattern.trim())
        fail('component.css.content 每一项必须是非空 string(仓内相对 glob)', 2);
      // 受限格式一律拒绝:本工具的 glob 只认 * / ** / ?,brace/否定/对象/require() 形式
      // 展不开就等于「声明了却没入链」,那正是 #2c-b 的漏洞形状,不许静默跳过。
      if (/[{}()!,]/.test(pattern) || pattern.startsWith('/') || pattern.includes('\\') || pattern.split('/').includes('..'))
        fail(
          `component.css.content["${pattern}"] 不是本工具可解析的标准 glob——只支持仓内相对路径 + * / ** / ?;`
          + '不支持 {a,b} brace、! 否定、绝对路径、".."、逗号多值,以及 tailwind config 里的 require()/对象形式。'
          + '\n修法:拆成多条标准 glob 写进 component.css.content。',
          2,
        );
      const matched = expandRepoGlob(repoRoot, pattern).filter((rel) => existsSync(join(repoRoot, rel)));
      if (matched.length === 0)
        fail(
          `component.css.content["${pattern}"] 在产品仓内零命中(仓根 ${repoRoot})——`
          + '声明了 content 却匹配不到任何文件 = 配置错误(CSS 会按空 content 编译,改样式源文件也不会让 hash 变)。'
          + '\n修法:修正该 glob,或从 component.css.content 里删掉它。',
          2,
        );
      matched.forEach((rel) => out.add(toPosix(rel)));
    }
    return out;
  }

  function normalizeInputs(metafile) {
    const productInputs = new Set();
    const demoInputs = new Set();
    let skippedExternal = 0;
    for (const key of Object.keys(metafile?.inputs ?? {})) {
      const abs = real(resolve(CWD, stripNs(key)));
      if (abs.split(sep).includes('node_modules')) { skippedExternal += 1; continue; }
      if (inside(demoReal, abs)) demoInputs.add(toPosix(relative(demoReal, abs)));
      else if (inside(repoReal, abs)) productInputs.add(toPosix(relative(repoReal, abs)));
      else skippedExternal += 1;
    }
    // 构建期输入(不来自 metafile,是构建器自己读/依赖的东西)。
    // 列表按「demo 里存在哪些构建期文件」判定,与由谁执行复算无关 —— skill 侧复算
    // 与 demo 侧 build.mjs 必须得到逐字节相同的清单。
    const buildDemo = new Set();
    for (const name of DEMO_BUILD_FILES) if (existsSync(join(demoDir, name))) buildDemo.add(name);
    const buildProduct = new Set();
    if (comp.css?.tailwindConfig) buildProduct.add(toPosix(comp.css.tailwindConfig));
    for (const rel of tailwindContentFiles()) buildProduct.add(rel);
    for (const pkgJson of readPackageJsons) {
      const abs = real(pkgJson);
      if (inside(demoReal, abs)) buildDemo.add(toPosix(relative(demoReal, abs)));
      else if (inside(repoReal, abs)) buildProduct.add(toPosix(relative(repoReal, abs)));
    }
    return {
      generator: 'qa-hifi-demo/component-build',
      entry: comp.entry,
      entryExport: targetExport,
      // 'targeted' = 声明了 component.export 且探针已就位(唯一可能 proved 的形态)
      // 'active'   = 未声明目标导出,探针只用于「一次都没被调用」这条硬失败
      // 'unavailable' = 探针完全套不上(entry 不是 JS/TS、或无任何导出)
      entrySentinel: sentinelActive ? (targetExport ? 'targeted' : 'active') : 'unavailable',
      productInputs: [...productInputs].sort(),
      demoInputs: [...demoInputs].sort(),
      buildInputs: { demo: [...buildDemo].sort(), product: [...buildProduct].sort() },
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

  /* ── tree-shake 护栏:entry 在图里但一个字节都没进产物 = 等于没打包 ──
     注意:被完整摇掉的模块在 metafile.inputs 里仍在,却整段不出现在 outputs[].inputs ——
     「查不到」与「0 字节」是同一件事,一律记 0(实测 esbuild 行为,不是猜)。 */
  const entryOutBytes = (() => {
    let bytes = 0;
    for (const out of Object.values(buildResult.metafile?.outputs ?? {})) {
      for (const [key, info] of Object.entries(out?.inputs ?? {})) {
        if (real(resolve(CWD, stripNs(key))) !== entryReal) continue;
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

  return { spec, comp, repoRoot, demoDir, R, D, manifest, assetsDir, bundleOut, cssOut, sentinel: manifest.entrySentinel };
}

/* ── CLI:--check-inputs(只复算,不落产物)。skill 侧复算与薄壳 build.mjs 共用。 ── */
const invokedDirectly = process.argv[1] && real0(process.argv[1]) === real0(fileURLToPath(import.meta.url));
function real0(p) { try { return realpathSync(p); } catch { return resolve(p); } }
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--check-inputs')) {
    process.stderr.write('用法: node component-build-core.mjs --check-inputs [--demo <demoDir>]\n');
    process.exit(2);
  }
  const i = argv.indexOf('--demo');
  const demoDir = i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : process.cwd();
  try {
    const { manifest } = await computeComponentBuild({ demoDir, checkOnly: true });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message ?? err) }, null, 2)}\n`);
    process.exit(err instanceof ComponentBuildError ? err.code : 1);
  }
}
