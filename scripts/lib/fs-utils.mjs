import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_BUILD_FILES } from './component-build-core.mjs';
import { expandRepoGlob } from './repo-glob.mjs';

export const TOOL_VERSION = 'qa-hifi-demo@2026-07-30-component-mode-r5';

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value), null, 2) + '\n';
}

export function safeJsonForScript(value) {
  return JSON.stringify(canonicalize(value))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function hashFile(file) {
  return sha256Buffer(readFileSync(file));
}

export function fileHashRecord(file, root = dirname(file)) {
  const abs = resolve(file);
  return { path: abs.startsWith(root) ? abs.slice(root.length + 1) : abs, sha256: hashFile(abs) };
}

export function readJsonFile(file, label = file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, problems: [`${label} 不是合法 JSON:${err.message}`] };
  }
}

export function findPackageRoot(startDir) {
  let cur = resolve(startDir);
  while (true) {
    if (existsSync(join(cur, 'package.json'))) return cur;
    const next = dirname(cur);
    if (next === cur) return null;
    cur = next;
  }
}

export function buildBaselineManifest(demoDir, spec = null) {
  const dir = join(demoDir, 'baselines');
  // declared 与 files 同构:分端基准(gate-e-v2)统一写成 <platform>/<key>,旧式平铺仍是 <key>
  const declared = Array.isArray(spec?.baselines)
    ? spec.baselines.map((b) => (b?.platform ? `${b.platform}/${b.key}` : b?.key))
    : [];
  const found = [];
  if (existsSync(dir)) {
    // 平铺 baselines/<key>.png 与分端 baselines/<platform>/<key>.png 混合扫描,仅下钻一层
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isFile() && name.endsWith('.png')) found.push({ rel: name, abs });
      else if (statSync(abs).isDirectory()) {
        for (const sub of readdirSync(abs).sort()) {
          const subAbs = join(abs, sub);
          if (statSync(subAbs).isFile() && sub.endsWith('.png')) found.push({ rel: `${name}/${sub}`, abs: subAbs });
        }
      }
    }
  }
  const records = found.map(({ rel, abs }) => ({
    key: rel.replace(/\.png$/, ''),
    file: `baselines/${rel}`,
    sha256: hashFile(abs),
    size: statSync(abs).size,
  }));
  return { declared, files: records };
}

/**
 * 定位 demo 所在的产品仓根(component 模式下 spec.component.entry/sources 的解析基准)。
 * 与 extract-helpers.findRepoRoot 同思路(git 优先、向上找 .git 降级),但**独立实现**——
 * lib/fs-utils 是最底层模块,反向 import extract-helpers 会成环。
 */
export function findGitRepoRoot(startDir) {
  try {
    const out = execFileSync('git', ['-C', startDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {}
  let cur = resolve(startDir);
  while (true) {
    if (existsSync(join(cur, '.git'))) return cur;
    const next = dirname(cur);
    if (next === cur) return null;
    cur = next;
  }
}

// glob 展开实现搬到 lib/repo-glob.mjs(component 构建核心也要用同一份语义,见该文件头注)。
// 这里保留同名再导出,历史 import 点不受影响。
export { expandRepoGlob };

// 组件模式 bundle 输入清单(由 build.mjs 从 esbuild metafile 生成)。
// 「声明源」(spec.component.entry/sources)与「bundle 真实输入」必须机械绑定:
// 真相源是这份 manifest,不是作者的自报。
export const COMPONENT_INPUTS_FILE = 'component.inputs.json';

const relSafe = (v) => typeof v === 'string' && v && !v.startsWith('/') && !v.includes('\\') && !v.split('/').includes('..');

/**
 * 读 component.inputs.json。结构不合法(非 object / productInputs 不是非空字符串数组)
 * 一律视为「没有 manifest」——宁可 fail-closed,不接受半张清单当真相源。
 */
export function readComponentInputsManifest(demoDir) {
  const file = join(demoDir, COMPONENT_INPUTS_FILE);
  if (!existsSync(file)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!isPlainObject(parsed)) return null;
  if (!Array.isArray(parsed.productInputs) || parsed.productInputs.length === 0) return null;
  if (parsed.demoInputs !== undefined && !Array.isArray(parsed.demoInputs)) return null;
  if (parsed.buildInputs !== undefined) {
    const b = parsed.buildInputs;
    if (!isPlainObject(b) || !Array.isArray(b.demo) || !Array.isArray(b.product)) return null;
  }
  return parsed;
}

/* ── demo 侧构建期文件 ⟷ skill canonical 的对照表(审核 #2c-a) ──
   demo 目录里的 build.mjs / component-build-core.mjs / extract-helpers.mjs / repo-glob.mjs
   都是 init.mjs 从 skill 仓逐字节拷过去的。它们的 sha256 必须与 canonical 全等:
   「换一份更宽松的构建器」在 r3 起不只是让 hash 变(那只拦旧 report),而是直接被门 A
   fail-closed 拒收。canonical 路径从本文件位置推,skill 装在哪都不受影响。 */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const CANONICAL_BUILD_FILES = {
  'build.mjs': join(LIB_DIR, '../../templates/component-build.mjs'),
  'component-build-core.mjs': join(LIB_DIR, 'component-build-core.mjs'),
  'extract-helpers.mjs': join(LIB_DIR, 'extract-helpers.mjs'),
  'repo-glob.mjs': join(LIB_DIR, 'repo-glob.mjs'),
};

/**
 * demo 里的构建期文件必须逐字节等于 skill canonical——不等就是自定义构建器。
 * 返回 problems(空 = 全等)。
 */
/**
 * demo 目录(含任意子目录)里出现的 node_modules —— 返回相对路径列表(空 = 干净)。
 * 只找目录名,不下钻进 node_modules 内部(命中即停,别把整棵依赖树走一遍)。
 */
/* r5(#2c-a):去掉 depth>8 的静默停止 —— 声明是「任意子目录出现 node_modules 即拒」,
   而 8 层上限让 demo/d0/../d8/node_modules 直接逃过检查,声明与实现不符。
   现在完整遍历(普通 symlink 不跟随、命中 node_modules 即停、跳过 .git),
   limit 只截断**报文里列举的条数**,不影响「是否命中」的判定。 */
function findDemoNodeModules(demoDir, { limit = 5 } = {}) {
  const hits = [];
  const walk = (dir, rel) => {
    if (hits.length >= limit) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) {
        // symlink 到依赖目录同样能被 module resolution 命中,一并算
        if (e.isSymbolicLink() && e.name === 'node_modules') hits.push(rel ? `${rel}/${e.name}` : e.name);
        continue;
      }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules') { hits.push(childRel); continue; }
      if (e.name === '.git') continue;
      walk(join(dir, e.name), childRel);
    }
  };
  walk(demoDir, '');
  return hits;
}

/* ── fail-closed:demo 自身不装依赖(r5 P0-2 把它前移成无条件 fail-fast) ──
   构建期文件的具名 hash 表只钉死 4 个文件,node_modules 既不入哈希链也不在表里。
   而模块解析是另一条能把 demo 侧代码送进本进程的侧路:只要某个候选目录解析到
   `<demo>/node_modules/<pkg>`,随后的 import 就会同步执行它的顶层代码
   (playwright 就是这么被利用的,见 lib/resolve-playwright.mjs 头注)。
   r4 只把这道检查挂在**组件模式**的 recheckComponentInputs 上,而且命中后只置
   gateA.pass=false 就继续跑到 launchChromium —— 经典模式 demo 完全不设防,
   组件模式也在「标红之后」才去启动浏览器,恶意依赖照样被加载。
   r5:任何 demo(不限模式)在 verify/pr-block 做任何动态 import、启动浏览器、
   执行 demo 侧代码**之前**无条件跑这一道,命中即退出。 */
export function checkDemoNoNodeModules(demoDir) {
  const nodeModules = findDemoNodeModules(demoDir);
  if (!nodeModules.length) return [];
  return [
    `demo 目录不应自带 node_modules,检测到依赖目录,拒绝——demo 自身不装依赖:${nodeModules.join(', ')}`
    + '\n模块解析是把 demo 侧代码送进校验进程的侧路:解析到 <demo>/node_modules/<pkg> 后'
    + '随后的 import 会同步执行它的顶层代码(任意代码执行)。这些目录既不进哈希链、'
    + '也不在构建期文件对照表里。'
    + '\n修法:删掉 demo 里的 node_modules(以及 package.json 里多余的 dependencies),'
    + '需要宿主依赖时设 QA_HIFI_MODULE_ROOT 指向装了依赖的仓。',
  ];
}

export function checkDemoBuilderIntegrity(demoDir) {
  const problems = [...checkDemoNoNodeModules(demoDir)];
  for (const name of DEMO_BUILD_FILES) {
    const demoFile = join(demoDir, name);
    const canonical = CANONICAL_BUILD_FILES[name];
    if (!canonical || !existsSync(canonical)) continue; // skill 自身残缺:别把锅算到 demo 头上
    if (!existsSync(demoFile)) {
      problems.push(`缺 ${name}——组件模式 demo 必须带 skill 下发的原版构建期文件才能独立复算 ${COMPONENT_INPUTS_FILE}(重跑 init.mjs --mode component)`);
      continue;
    }
    if (hashFile(demoFile) !== hashFile(canonical))
      problems.push(
        `检测到自定义构建器,需人工审查:${name} 与本工具 canonical 版本不一致(sha256 不等)。`
        + '\n组件模式的构建规范不许 demo 侧改写——改了就无法判断清单/产物是按什么规则生成的。'
        + `\n修法:用 skill 原版覆盖(重跑 init.mjs --mode component),真需要改构建规范请改 skill 仓 ${name === 'build.mjs' ? 'templates/component-build.mjs' : `scripts/lib/${name}`} 并走 review。`,
      );
  }
  return problems;
}

/**
 * 独立复算 bundle 输入图(审核 #2c):用 **skill 仓自己那份构建核心**
 * (`scripts/lib/component-build-core.mjs --check-inputs`)现算一遍 esbuild 输入图,
 * 与 demo 内 component.inputs.json 做全等比对。
 *
 * 为什么必须复算:manifest 是一份可手改的 JSON。「先缩 manifest,再只重跑 verify」——
 * verify 若直接把 manifest 当真相源,缩完的窄链照样算出一致 hash,链就白锁了。
 *
 * 为什么 oracle 必须是 skill 侧的(r3,审核 #2c-a):r2 复算跑的是
 * `node <demo>/build.mjs --check-inputs` —— oracle 自己就在被审对象里。终审实证把
 * demo/build.mjs 换成「--check-inputs 时原样打印现有 component.inputs.json」的脚本,
 * 缩链后 verify/pr-block 全绿。r3 起复算路径上**不执行 demo 目录里的任何代码**,
 * 另外用 checkDemoBuilderIntegrity 把 demo 侧拷贝钉死在 canonical 上。
 *
 * 返回 { status, problems }:
 *   'ok'          — 复算结果与 manifest 全等;
 *   'mismatch'    — 不等(problems 含 diff 摘要);
 *   'bad-builder' — demo 侧构建器缺失或被改写(fail-closed,不做复算比对);
 *   'error'       — 复算本身跑不起来(缺 esbuild / 构建报错),fail-closed 记 problem。
 */
export function recheckComponentInputs(demoDir) {
  const declared = readComponentInputsManifest(demoDir);
  if (!declared) return { status: 'no-manifest', problems: [] }; // 由 NO_MANIFEST 那条单独阻断
  const builderProblems = checkDemoBuilderIntegrity(demoDir);
  if (builderProblems.length) return { status: 'bad-builder', problems: builderProblems };
  let fresh;
  try {
    // cwd 必须是 demoDir:esbuild metafile 的 key 相对 cwd,换 cwd 会改整份清单的规范化结果
    const out = execFileSync(process.execPath, [CANONICAL_BUILD_FILES['component-build-core.mjs'], '--check-inputs', '--demo', demoDir], {
      cwd: demoDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    fresh = JSON.parse(out);
  } catch (err) {
    return {
      status: 'error',
      problems: [`独立复算 bundle 输入图失败(skill 侧 component-build-core --check-inputs):${String(err.stdout || err.stderr || err.message).slice(0, 400)}`],
    };
  }
  if (sameInputHashes(fresh, declared)) return { status: 'ok', problems: [] };
  const diff = [];
  const listDiff = (label, a, b) => {
    const A = new Set(Array.isArray(a) ? a : []);
    const B = new Set(Array.isArray(b) ? b : []);
    const only = (x, y) => [...x].filter((v) => !y.has(v));
    const missing = only(A, B);
    const extra = only(B, A);
    if (missing.length) diff.push(`${label} 清单里少了 ${missing.length} 项(现算有、清单无):${missing.slice(0, 5).join(', ')}`);
    if (extra.length) diff.push(`${label} 清单里多了 ${extra.length} 项(清单有、现算无):${extra.slice(0, 5).join(', ')}`);
  };
  listDiff('productInputs', fresh.productInputs, declared.productInputs);
  listDiff('demoInputs', fresh.demoInputs, declared.demoInputs);
  listDiff('buildInputs.demo', fresh.buildInputs?.demo, declared.buildInputs?.demo);
  listDiff('buildInputs.product', fresh.buildInputs?.product, declared.buildInputs?.product);
  for (const key of ['generator', 'entry', 'entryExport', 'entrySentinel', 'skippedExternal']) {
    if (JSON.stringify(fresh[key]) !== JSON.stringify(declared[key]))
      diff.push(`${key} 不一致:现算 ${JSON.stringify(fresh[key])} vs 清单 ${JSON.stringify(declared[key])}`);
  }
  return {
    status: 'mismatch',
    problems: [
      `${COMPONENT_INPUTS_FILE} 与 esbuild 独立复算结果不一致——清单被手改过(或改了 spec/源码后没重跑 build)。`
      + `${diff.length ? `\n  ${diff.join('\n  ')}` : ''}`
      + '\n修法:node build.mjs 重生清单,再重跑 verify。',
    ],
  };
}

/**
 * component 模式的代码层防伪链:**bundle 真实输入**逐一 sha256(真相源 = manifest)。
 *   sources     — manifest.productInputs(产品仓内相对路径)逐文件 sha256
 *   demoInputs  — manifest.demoInputs(demo 内相对路径,bootstrap/shims 等)逐文件 sha256
 *   manifest    — manifest 文件自身 sha256(改清单本身同样让链失效)
 *   bundle      — 构建产物 sha256
 * 缺 manifest → manifest:'NO_MANIFEST'(report fail-closed);路径越狱 → 'INVALID_PATH';
 * 仓根不可解析 → repoRoot:'UNRESOLVED' 且产品输入全记 UNRESOLVED;文件不在 → 'MISSING'。
 * spec.component.sources 不再参与 hash——它降级为可选的人读声明,由
 * checkDeclaredComponentSources 校验必须 ⊆ manifest 真实输入。
 */
export function buildComponentHashes(demoDir, component) {
  const repoRoot = findGitRepoRoot(demoDir);
  const out = { manifest: 'NO_MANIFEST', sources: {}, demoInputs: {}, bundle: {} };
  const manifest = readComponentInputsManifest(demoDir);
  if (manifest) out.manifest = hashFile(join(demoDir, COMPONENT_INPUTS_FILE));
  if (!repoRoot) out.repoRoot = 'UNRESOLVED';
  for (const rel of manifest?.productInputs ?? []) {
    if (!relSafe(rel)) { out.sources[String(rel)] = 'INVALID_PATH'; continue; }
    if (!repoRoot) { out.sources[rel] = 'UNRESOLVED'; continue; }
    const abs = join(repoRoot, rel);
    out.sources[rel] = existsSync(abs) && statSync(abs).isFile() ? hashFile(abs) : 'MISSING';
  }
  for (const rel of manifest?.demoInputs ?? []) {
    if (!relSafe(rel)) { out.demoInputs[String(rel)] = 'INVALID_PATH'; continue; }
    const abs = join(demoDir, rel);
    out.demoInputs[rel] = existsSync(abs) && statSync(abs).isFile() ? hashFile(abs) : 'MISSING';
  }
  // 构建期输入(build.mjs 自身 / tailwind config / alias 插件读过的 package.json):
  // 它们不在 bundle 的 metafile inputs 里,但改任一项都能改整张图或整份 CSS——
  // 不入链就等于给「换一份宽松构建器 / 改 tailwind 主题」留后门(审核 #2c-3)。
  out.buildInputs = { demo: {}, product: {} };
  for (const [group, base, list] of [
    ['demo', demoDir, manifest?.buildInputs?.demo],
    ['product', repoRoot, manifest?.buildInputs?.product],
  ]) {
    for (const rel of Array.isArray(list) ? list : []) {
      if (!relSafe(rel)) { out.buildInputs[group][String(rel)] = 'INVALID_PATH'; continue; }
      if (!base) { out.buildInputs[group][rel] = 'UNRESOLVED'; continue; }
      const abs = join(base, rel);
      out.buildInputs[group][rel] = existsSync(abs) && statSync(abs).isFile() ? hashFile(abs) : 'MISSING';
    }
  }
  const bundle = typeof component?.bundle === 'string' && component.bundle ? component.bundle : null;
  if (bundle) {
    const abs = join(demoDir, bundle);
    out.bundle[bundle] = existsSync(abs) ? hashFile(abs) : 'MISSING';
  }
  return out;
}

/**
 * 声明层与真实输入的一致性校验(report fail-closed 调用,不入 hash):
 *   1. component.entry 必须出现在 manifest.productInputs —— 否则 bootstrap 根本没
 *      import 声明的入口(hash 真组件、bundle 全是手写货);
 *   2. component.sources(可选人读声明)展开后必须 ⊆ manifest.productInputs ——
 *      声明了却没被 bundle 读到的源文件属于误导性声明。
 * 返回 problems 字符串数组(空 = 通过)。
 */
export function checkDeclaredComponentSources(demoDir, component) {
  const problems = [];
  const manifest = readComponentInputsManifest(demoDir);
  if (!manifest) return problems; // 缺 manifest 由 NO_MANIFEST 那条单独阻断,不重复报
  const real = new Set(manifest.productInputs.filter((p) => typeof p === 'string'));
  const entry = typeof component?.entry === 'string' ? component.entry : '';
  if (entry && !real.has(entry))
    problems.push(`component.entry "${entry}" 不在 bundle 真实输入里(component.inputs.json)——bootstrap 没有 import 它,「真组件直渲」不成立;重跑 build.mjs 会直接失败并给出修法`);
  const repoRoot = findGitRepoRoot(demoDir);
  const patterns = Array.isArray(component?.sources) ? component.sources : [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern) continue;
    const matched = repoRoot ? expandRepoGlob(repoRoot, pattern) : [];
    const stray = matched.filter((rel) => !real.has(rel));
    if (matched.length === 0)
      problems.push(`component.sources "${pattern}" 在产品仓内零命中——删掉或修正(sources 只是人读声明,真相源是 component.inputs.json)`);
    else if (stray.length)
      problems.push(`component.sources "${pattern}" 声明了未被 bundle 读到的源文件:${stray.slice(0, 5).join(', ')}${stray.length > 5 ? ` 等 ${stray.length} 个` : ''}——声明必须 ⊆ bundle 真实输入`);
  }
  return problems;
}

// assets/ 清单(递归,路径为 demo 相对 posix 路径,按路径稳定排序)。
// 组件模式把 hero 图/组件 bundle 落成独立文件后,这些字节同样是 demo 的一部分:
// 既供 assets-manifest.mjs 做体积闸门,也进 inputHashes 防伪链(换图不重跑 = 旧 report 失效)。
export function buildAssetsManifest(demoDir) {
  const dir = join(demoDir, 'assets');
  const files = [];
  if (!existsSync(dir)) return { files };
  const walk = (cur, prefix) => {
    for (const name of readdirSync(cur).sort()) {
      const abs = join(cur, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) files.push({ path: `assets/${rel}`, sha256: hashFile(abs), size: st.size });
    }
  };
  walk(dir, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}

export function buildInputHashes(demoDir, spec = null) {
  const files = ['spec.json', 'truth.json', 'index.html'];
  const hashes = {};
  for (const name of files) hashes[name] = hashFile(join(demoDir, name));
  hashes.baselines = buildBaselineManifest(demoDir, spec);
  // assets/ 逐文件 sha 进防伪链;没有 assets 目录则整段省略——旧 demo 的 report 结构不变、不受影响
  if (existsSync(join(demoDir, 'assets'))) hashes.assets = buildAssetsManifest(demoDir).files;
  // 自定义门脚本进防伪链:verify 后改脚本(或换一份宽松实现)会导致 hash 不一致,
  // pr-block 拒绝出块——体外 gate 不再游离于 report 完整性校验之外
  const customGates = Array.isArray(spec?.customGates) ? spec.customGates : [];
  if (customGates.length) {
    hashes.customGates = {};
    for (const g of customGates) {
      if (g && typeof g.script === 'string' && g.script) {
        const file = join(demoDir, g.script);
        hashes.customGates[g.script] = existsSync(file) ? hashFile(file) : 'MISSING';
      }
    }
  }
  // 组件模式:防伪链从数据层延伸到代码层(产品组件源码 + bundle 产物)
  if (isPlainObject(spec?.component) && spec.component.mode === 'component') {
    hashes.componentSources = buildComponentHashes(demoDir, spec.component);
  }
  return hashes;
}

export function sameInputHashes(a, b) {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

export function failJson(message, code = 1, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(code);
}

export function failProblems(problems, code = 2) {
  console.log(JSON.stringify({ ok: false, problems }, null, 2));
  process.exit(code);
}
