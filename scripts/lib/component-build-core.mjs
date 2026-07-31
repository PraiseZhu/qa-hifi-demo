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
//   node component-build-core.mjs --check-outputs --demo <demoDir>   (旧名 --check-bundle 仍可用)
//     → write:false 现算一遍,给出 esbuild **全部产物**的「路径→字节」可信映射
//       (JS bundle + file loader 派生的图片/字体/…);r7 条目 3 前只复算 JS 字节。
//   node component-build-core.mjs --check-css --demo <demoDir>
//     → 用产品 tailwind config 重编一遍 CSS 到临时目录,给出「应该得到的
//       assets/component.css」sha256(r6 条目 1;未配 tailwind 时给占位字节的期望值)。
//   node component-build-core.mjs --suggest-content "<旧 glob>" [...] --demo <demoDir>
//     → **生成器**(r7 条目 2):把旧式 glob 在产品仓内展开成建议的显式文件清单打到 stdout,
//       供作者抄进 spec.json 的 component.css.content。它只是便利工具:运行期一律不做展开,
//       定稿输入必须是显式列表(不变式 S ⊆ E = L 由参数结构保证,不能依赖展开语义)。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRepoRoot, resolveFrom } from './extract-helpers.mjs';
import { explicitContentFileProblem, findDemoNodeModules } from './repo-glob.mjs';

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

/** 未配置 tailwind 时 build.mjs 写进 assets/component.css 的**唯一**占位内容。
 *  由本模块导出、薄壳模板 import ——两侧字节必须完全一致,可信侧才能对它做字节复算。 */
export const CSS_PLACEHOLDER =
  '/* 组件模式:spec.component.css 未配置,无编译产物(占位,保证 index.html <link> 不 404) */\n';
export const DEFAULT_TAILWIND_INPUT = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n';

/* ══ tailwind content = **显式文件路径列表**(r7 条目 2,破坏性接口变更)══

   不变式 **S ⊆ E = L**:
     L(入链集)  = component.css.content 解析出的那批文件,逐一进 buildInputs.product;
     E(期望集)  = 传给 Tailwind `--content` 的绝对路径列表,与 L 逐项同源;
     S(实扫集)  ⊆ E —— 因为每一项都是**绝对普通文件路径**,Tailwind 的 parseCandidateFiles
                  对它给出 glob === null,扫描集就是这些文件本身,没有任何展开语义空间。
   这条不变式由**参数结构**保证,不靠事后比对/猜测。CLI 上的 `--content` override 之后,
   config.content 与 config.content.relative 都不再决定集合(r6 条目 3 那条基准错位因此消失)。

   为什么不再自研/复用 glob:语义差异已被证伪四次,而 Tailwind v3 没有公开稳定 API 能导出
   真实 file set(parseCandidateFiles 是包内私有 API)。旧 glob 的迁移见
   repo-glob.explicitContentFileProblem 的报文,以及本文件 CLI 的 `--suggest-content` 生成器。 */

/**
 * 把 component.css.content 解析成绝对路径列表(唯一实现;构建、可信侧复算、薄壳 build 共用)。
 * 逐项校验:格式(explicitContentFileProblem)+ 存在 + regular file + realpath 落在 repoRoot 内。
 * @returns {{absolute: string[], relative: string[]}} 两者一一对应且已排序去重。
 */
export function resolveContentFiles(repoRoot, list) {
  const repoReal = realpathish(repoRoot);
  const problems = [];
  const pairs = new Map(); // rel(posix,相对 repoReal) → abs(realpath)
  for (const [i, entry] of (Array.isArray(list) ? list : []).entries()) {
    const formatProblem = explicitContentFileProblem(entry);
    if (formatProblem) { problems.push(`component.css.content[${i}] ${formatProblem}`); continue; }
    const abs = join(repoRoot, entry);
    if (!existsSync(abs)) { problems.push(`component.css.content[${i}] 文件不存在:${entry}(显式列表不许声明不存在的文件——它会让 CSS 按更小的集合编译却不被发现)`); continue; }
    let st;
    try { st = statSync(abs); } catch (err) { problems.push(`component.css.content[${i}] 无法 stat:${entry}(${err.message})`); continue; }
    if (!st.isFile()) { problems.push(`component.css.content[${i}] 不是普通文件(目录/设备/socket 一律拒):${entry}`); continue; }
    const real = realpathish(abs);
    // symlink 越狱:声明项本身在仓内,realpath 可能指到仓外 —— 那份文件不入链却会被实扫
    if (real !== repoReal && !real.startsWith(repoReal + sep)) {
      problems.push(`component.css.content[${i}] realpath 落在产品仓外(symlink 越狱?):${entry} → ${real}`);
      continue;
    }
    pairs.set(toPosix(relative(repoReal, real)), real);
  }
  if (problems.length) fail(problems.join('\n'), 2);
  const rels = [...pairs.keys()].sort();
  return { relative: rels, absolute: rels.map((r) => pairs.get(r)) };
}

/**
 * `--content` 的**唯一**参数构造:可信侧复算(compileTailwindOnce)与 demo 侧薄壳 build.mjs
 * 都必须调它。两侧参数只要有一点不同,CSS 字节复算就会误杀合法 demo。
 */
export function contentCliArg(repoRoot, comp) {
  return contentSetup(repoRoot, comp).absolute.join(',');
}

/** content 必填校验 + 解析,构建清单与 CSS 复算共用一条路径。 */
function contentSetup(repoRoot, comp) {
  /* ── css 非 null 时 content 必填(审核 r4 追加 #2c-b,方案 A) ──
     不显式声明时 Tailwind 会按 config.content 隐式扫描,而清单只记 tailwind.config.js 本身,
     被扫到的样式源文件全不入链 —— 改它们 hash 不变、旧 CSS 照过门。 */
  if (comp.css && (!Array.isArray(comp.css.content) || comp.css.content.length === 0))
    fail(
      'component.css 已配置但 component.css.content 缺失/为空——组件模式要求**显式**声明 tailwind content。'
      + '\n原因:不显式声明时 Tailwind 会按 tailwind.config.js 里的 content 隐式扫描,而那些被扫到的'
      + '样式源文件不会进 component.inputs.json 防伪链;改样式源文件 hash 不变,旧 CSS + 旧 report 照过验收。'
      + '\n修法(r7 起):把样式源文件**逐个显式列出**(仓内相对普通文件路径,不支持 glob/目录),'
      + '可用 `node component-build-core.mjs --suggest-content "<旧 glob>" --demo <dir>` 生成建议清单;'
      + '真不需要 tailwind 就把 component.css 设为 null。',
      2,
    );
  return resolveContentFiles(repoRoot, comp.css?.content ?? []);
}

/** 入链集 L:content 解析出的仓内相对路径(与传给 Tailwind 的绝对路径一一对应)。 */
export function tailwindContentSet(repoRoot, comp) {
  return new Set(contentSetup(repoRoot, comp).relative);
}

/**
 * 可信侧复算 **CSS 产物字节**(r6 条目 1 CRITICAL)。
 *
 * 为什么必须有:r5 把 bundle 做成了字节复算(computeExpectedBundleSha),但
 * assets/component.css 全仓**没有任何字节复算** —— buildComponentHashes 只把它的
 * 字节记进 assets 清单用于「report 是否过期」检测,从不独立重编译比对。于是:
 * 合法构建产出 component.css 之后手工编辑它(改样式/删规则/插任意 CSS),只要不动
 * 哈希链已记录的输入文件,verify / pr-block 全流程零检测通过。
 *
 * 它同时是条目 3/4/5(content glob 语义差异、node_modules 非对称、config 的
 * presets/plugins 依赖未入链)的**统一兜底**:不管入链清单算得对不对,只要有人改了
 * Tailwind 实扫到的任何文件而不重建,可信侧现编出来的 CSS 字节就不等于磁盘字节 → 门 A 红。
 *
 * 边界(审核裁定):跑 Tailwind config 属于执行**产品仓**代码,产品 repoRoot 是可信侧
 * (我们本来就在打包它的源码),与 demo 不可信侧性质不同;但必须排在 **demo node_modules
 * 前置门之后**,该次序在下面写死并由源码契约测试锁住。
 */
export async function computeExpectedCssSha(demoDir) {
  const specFile = join(demoDir, 'spec.json');
  if (!existsSync(specFile)) fail(`demo 目录缺 spec.json:${specFile}`, 2);
  const comp = JSON.parse(readFileSync(specFile, 'utf8')).component;
  if (!comp) fail('spec.json 缺 component 段——组件构建核心只用于组件模式 demo');

  const cssRel = `${comp.assetsDir ?? 'assets'}/component.css`;
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');

  // 未配置 tailwind:产物是**确定的**占位字节,直接给期望值(无需任何外部工具)
  if (!comp.css?.tailwindConfig) {
    const buf = Buffer.from(CSS_PLACEHOLDER, 'utf8');
    return { css: cssRel, mode: 'placeholder', sha256: sha(buf), bytes: buf.length, deterministic: true };
  }

  /* ── 次序护栏(硬性,勿调换):先跑 demo node_modules 前置门,再执行任何产品仓代码 ──
     Tailwind CLI 是子进程、且会 require 产品 tailwind config(以及它的 presets/plugins)。
     即便解析基准是产品仓,也一律先把「demo 自带依赖目录」这条侧路关掉再动手 —— 它是
     r5 P0-2 的根因形状(模块解析命中 <demo>/node_modules → import 即执行顶层代码)。 */
  const nmHits = findDemoNodeModules(demoDir);
  if (nmHits.length)
    fail(
      `demo 目录自带 node_modules,拒绝在此之上执行产品构建工具:${nmHits.join(', ')}`
      + '\n修法:删掉 demo 里的 node_modules;需要宿主依赖时设 QA_HIFI_MODULE_ROOT。',
      2,
    );

  const repoRoot = findRepoRoot(demoDir);
  const demoReal = realpathish(demoDir);
  const repoReal = realpathish(repoRoot);
  // repoRoot 必须是 demo 的**严格祖先**:demo 自己就是 git 仓时,repoRoot===demoDir,
  // 那等于把不可信目录当成「可信产品仓」去执行它的 config / CLI。
  if (repoReal === demoReal || !demoReal.startsWith(repoReal + sep))
    fail(
      `无法可信复算 CSS:产品仓根(${repoRoot})不是 demo 目录(${demoDir})的严格祖先——`
      + 'demo 必须位于产品 git 仓内的子目录,否则执行「产品」tailwind config 等于执行被审侧代码。',
      2,
    );

  const configAbs = isAbsolute(comp.css.tailwindConfig) ? comp.css.tailwindConfig : join(repoRoot, comp.css.tailwindConfig);
  if (!existsSync(configAbs)) fail(`component.css.tailwindConfig 不存在:${configAbs}`, 2);
  // content 的格式/存在性/仓内归属一律先判(与输入清单同一份实现,报文一致)
  const contentFiles = resolveContentFiles(repoRoot, comp.css.content);

  const bin = join(repoRoot, 'node_modules', '.bin', 'tailwindcss');
  if (!existsSync(bin))
    fail(
      `component.css 已配置,但产品仓没有 tailwindcss CLI:${bin}——`
      + '可信侧无法独立复算 assets/component.css 的字节,不得放行(fail-closed)。'
      + '\n修法:在产品仓安装 tailwindcss(与出产物时同一版本),或把 component.css 设为 null。',
      2,
    );

  /* 复算跑两遍:Tailwind 输出若含不确定成分(时间戳/随机序),两遍字节就不等。
     不静默容忍差异 —— 直接 fail 并要求人工处理,否则字节复算这条锚本身不成立。 */
  const runs = [];
  for (let i = 0; i < 2; i += 1) runs.push(compileTailwindOnce({ repoRoot, bin, configAbs, comp, tag: `r${i}` }));
  if (runs[0].sha256 !== runs[1].sha256)
    fail(
      'Tailwind 同输入两次编译的字节不一致——CSS 字节复算这条验收锚在当前 tailwind 版本上不成立。'
      + `\n  第一次:${runs[0].sha256}\n  第二次:${runs[1].sha256}`
      + '\n不静默容忍:请先定位不确定成分(时间戳/banner/插件随机序),必要时在产品侧固定它,'
      + '再重跑;或把该 demo 的 CSS 验收降级为人工审查并在 PR 上写明。',
      2,
    );
  return {
    css: cssRel, mode: 'tailwind', sha256: runs[0].sha256, bytes: runs[0].bytes, deterministic: true,
    // 展开引擎实况:同源性风险(我们用的 fast-glob 与 tailwind 内部那份是否同一份)靠它可查
    /* 不变式 S ⊆ E = L 的实况:contentFiles 就是传给 Tailwind --content 的绝对路径列表,
       也是进 buildInputs.product 的那一批(相对路径形态)。没有展开引擎、没有基准歧义。 */
    content: { mode: 'explicit-files', count: contentFiles.relative.length, files: contentFiles.relative },
  };
}

/** 单次 tailwind 编译到 demo 之外的临时目录,返回产物 sha256/字节数。 */
function compileTailwindOnce({ repoRoot, bin, configAbs, comp, tag }) {
  const tmp = mkdtempSync(join(tmpdir(), `qa-hifi-css-${tag}-`));
  const inputCss = join(tmp, 'input.css');
  const outCss = join(tmp, 'component.css');
  writeFileSync(inputCss, comp.css.input ?? DEFAULT_TAILWIND_INPUT);
  try {
    // 参数与薄壳 build.mjs 逐项对齐(cwd=repoRoot、-c/-i/-o/--content 同序),
    // 否则复算字节与作者产出字节会因参数差异而不等 —— 那是误杀不是检出。
    // --content 传**绝对文件路径**(contentCliArg 是两侧唯一实现):CLI override 之后
    // config.content 与 config.content.relative 都不再决定集合(不变式 E = L)。
    execFileSync(bin, ['-c', configAbs, '-i', inputCss, '-o', outCss, '--content', contentCliArg(repoRoot, comp)], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    fail(`可信侧 tailwind 编译失败:${String(err.stderr || err.stdout || err.message).slice(0, 400)}`, 2);
  }
  const buf = readFileSync(outCss);
  rmSync(tmp, { recursive: true, force: true });
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

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
  const packageExports = Object.create(null);   // r12:包名为 key
  const readPackageJsons = [];
  for (const [pkg, root] of Object.entries(packageRoots)) {
    const pkgJson = join(root, '..', 'package.json');
    if (!existsSync(pkgJson)) continue;
    readPackageJsons.push(pkgJson);
    const map = Object.create(null);   // r12:exports 子路径为 key
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
    /* ── challenge 回应(r5 #1c 第三层) ──
       r4 的证据是一个**静态形状**:不可写全局 + 不可配置的 get-only snapshot + 冻结对象。
       这套协议完全公开、可被 index.html 在 bundle 加载前逐字段精确仿造(终审实证)。
       所以再加一条只有「活的哨兵」才做得到的事:verify 每次运行生成一个不可预测的
       nonce,调 prove(nonce),回应里必须原样带回该 nonce。静态预置的冻结 snapshot
       无法预知 nonce;要能回应就得写一个真函数,而那时它又躲不过 (a) bundle 字节
       全等复算与 (b) pageerror fail-closed 两层。 */
    L.push('Object.defineProperty(__qaSeal, "prove", { enumerable: false, configurable: false, writable: false,');
    L.push('  value: function (__n) { return Object.freeze({ nonce: String(__n),');
    L.push('    rendered: __qaRendered, targetRendered: __qaTargetRendered,');
    L.push('    shape: Object.freeze({ total: __qaShape.total, wrappable: __qaShape.wrappable,');
    L.push('      targetWrappable: __qaShape.targetWrappable, target: __qaShape.target, sentinel: true }) }); } });');
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

  /** tailwind content 的入链集 L(r7:显式文件列表,与传给 --content 的绝对路径一一对应)。 */
  function tailwindContentFiles() {
    return tailwindContentSet(repoRoot, comp);
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

  return {
    spec, comp, repoRoot, demoDir, R, D, manifest, assetsDir, bundleOut, cssOut,
    sentinel: manifest.entrySentinel,
    // checkOnly(write:false)时 esbuild 把产物留在内存里 —— 供可信侧复算 bundle 字节
    outputFiles: buildResult.outputFiles ?? null,
  };
}

/**
 * 可信侧复算 **esbuild 全部产物字节**(r5 #1c 第一层 → r7 条目 3 升级)。
 *
 * r5 只复算 JS bundle 字节(computeExpectedBundleSha),而组件真实 `import hero.png` 时
 * esbuild 的 file loader 会把资产落成 `assets/hero-XMUUP4P7.png` 这类**派生产物**。
 * 审核人实测的 P0:把该 PNG **原地覆盖成另一张图但保留原文件名** —— JS 里引用的还是同一个
 * 名字,所以 bundle 字节仍全等;`inputHashes.assets` 是对攻击后的当前字节现算的,天然自洽;
 * 文件名里的 `[hash]` 只是 esbuild 的内容指纹、**不是密码学校验**,改内容不改名照样过。
 * 结果:verify exit 0、pr-block exit 0,仍贴「真组件直渲」。
 *
 * 修法(不变式 I-ESBUILD):磁盘上 bundle + 所有 file-loader 产物的「路径 → 字节」映射,
 * 必须等于 canonical write:false 现算映射。缺失 / 字节不等 / 换名一律门红。
 *
 * @returns {{bundle: string, outputs: {path: string, sha256: string, bytes: number}[]}}
 *   path 一律是**相对 demoDir 的 posix 路径**(产物都落在 demo 内)。
 */
export async function computeExpectedEsbuildOutputs(demoDir) {
  const { outputFiles, bundleOut, comp } = await computeComponentBuild({ demoDir, checkOnly: true });
  if (!outputFiles || !outputFiles.length) fail('可信侧复算未产出任何 esbuild 输出文件(write:false 无 outputFiles)', 1);
  const demoReal = realpathish(demoDir);
  const demoPlain = resolve(demoDir);
  /* demo 相对路径:macOS 的 /var → /private/var symlink 会让同一个文件有两种绝对路径,
     两种基准都要试,否则会算出一串 ../../.. 的假路径(实测踩过)。 */
  const relToDemo = (p) => {
    for (const base of [demoReal, demoPlain]) {
      for (const abs of [resolve(p), realpathish(p)]) {
        if (abs === base || abs.startsWith(base + sep)) return toPosix(relative(base, abs));
      }
    }
    return null;
  };
  const outputs = [];
  for (const f of outputFiles) {
    // 产物必须落在 demo 内 —— 落到别处说明 spec 把输出路径指到了 demo 之外,不许当作可信产物
    const rel = relToDemo(f.path);
    if (rel === null) fail(`esbuild 产物落在 demo 目录之外,拒绝:${f.path}`, 2);
    outputs.push({
      path: rel,
      sha256: createHash('sha256').update(Buffer.from(f.contents)).digest('hex'),
      bytes: f.contents.length,
    });
  }
  outputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bundleRel = relToDemo(bundleOut);
  if (!outputs.some((o) => o.path === bundleRel))
    fail(`可信侧复算的产物集合里没有声明的 bundle(${bundleRel}):${outputs.map((o) => o.path).join(', ')}`, 1);
  return { bundle: comp.bundle ?? 'assets/component.bundle.js', outputs };
}

/** @deprecated r7 起用 computeExpectedEsbuildOutputs;保留一层薄封装供只关心 JS 字节的调用方。 */
export async function computeExpectedBundleSha(demoDir) {
  const { bundle, outputs } = await computeExpectedEsbuildOutputs(demoDir);
  const hit = outputs.find((o) => o.path === bundle) ?? outputs.find((o) => o.path.endsWith('.js'));
  return { bundle, sha256: hit.sha256, bytes: hit.bytes };
}
function realpathish(p) { try { return realpathSync(p); } catch { return resolve(p); } }

/* ── CLI:--check-inputs(只复算,不落产物)。skill 侧复算与薄壳 build.mjs 共用。 ── */
const invokedDirectly = process.argv[1] && real0(process.argv[1]) === real0(fileURLToPath(import.meta.url));
function real0(p) { try { return realpathSync(p); } catch { return resolve(p); } }
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const wantInputs = argv.includes('--check-inputs');
  const wantBundle = argv.includes('--check-bundle') || argv.includes('--check-outputs');
  const wantCss = argv.includes('--check-css');
  const suggestIdx = argv.indexOf('--suggest-content');
  if (!wantInputs && !wantBundle && !wantCss && suggestIdx === -1) {
    process.stderr.write('用法: node component-build-core.mjs --check-inputs|--check-outputs(=--check-bundle)|--check-css|--suggest-content <glob...> [--demo <demoDir>]\n');
    process.exit(2);
  }
  const i = argv.indexOf('--demo');
  const demoDir = i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : process.cwd();
  try {
    /* ── 生成器:旧 glob → 建议的显式清单(r7 条目 2 的迁移便利,不参与验收) ──
       用 expandRepoGlob(仓内自研展开)只是为了「列个候选给人看」,不承担任何安全职责:
       它的输出必须由作者过目并抄进 spec.json,运行期读到的永远是那份显式列表。 */
    if (suggestIdx !== -1) {
      const globs = argv.slice(suggestIdx + 1).filter((a) => !a.startsWith('--'));
      if (!globs.length) { process.stderr.write('--suggest-content 需要至少一个 glob\n'); process.exit(2); }
      const repoRoot = findRepoRoot(demoDir);
      const { expandRepoGlob } = await import('./repo-glob.mjs');
      const out = new Set();
      const skipped = [];
      for (const g of globs) {
        for (const rel of expandRepoGlob(repoRoot, g)) {
          if (!existsSync(join(repoRoot, rel))) continue;
          // 生成器不许产出定稿会被拒的条目 —— 否则作者抄进去还要再返工一轮
          if (explicitContentFileProblem(rel)) { skipped.push(rel); continue; }
          out.add(rel);
        }
      }
      process.stdout.write(`${JSON.stringify({
        note: '把 content 抄进 spec.json 的 component.css.content;运行期不做展开,定稿必须是显式列表',
        repoRoot,
        content: [...out].sort(),
        skipped: skipped.sort(),
        skippedNote: skipped.length ? '这些命中项不能作为显式 content(含元字符/在 node_modules 或 .git 下),需人工处理' : null,
      }, null, 2)}\n`);
      process.exit(0);
    }
    if (wantCss) {
      process.stdout.write(`${JSON.stringify(await computeExpectedCssSha(demoDir), null, 2)}\n`);
      process.exit(0);
    }
    if (wantBundle) {
      // r7 条目 3:输出的是**全部产物**的路径→字节映射(不再只有 JS bundle 的 sha256)
      process.stdout.write(`${JSON.stringify(await computeExpectedEsbuildOutputs(demoDir), null, 2)}\n`);
      process.exit(0);
    }
    const { manifest } = await computeComponentBuild({ demoDir, checkOnly: true });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message ?? err) }, null, 2)}\n`);
    process.exit(err instanceof ComponentBuildError ? err.code : 1);
  }
}
