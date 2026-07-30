// extract-helpers.mjs — extract.mjs 作者的共享工具函数。
//
// 诞生背景(2026-07-29 login-all-hifi 事故):每个 demo 的 extract.mjs 手写 repoRoot
// 定位(`../../..` 数目录层级),demo 从 _tmp/ 迁到 docs/design-previews/ 后路径全断,
// 一天连修 3 个 bug(repoRoot 深度、provenance 前缀、truth 相对路径)。本库把这些
// 「每个 demo 都要做且都做错过」的事收敛为一次实现:
//   - findRepoRoot():git 定位仓库根,与目录深度彻底解耦——demo 随便搬家;
//   - makeLeaf():provenance 工厂,source 相对路径 / hash / locatorPattern 一次做对;
//   - importTsModule():esbuild 临时编译 TS 纯函数后 import(门 F oracle 用产品公式本身);
//   - extractThemeVars():主题桥——从产品 themes/colors.ts 的 registerColor 全表提取
//     light/dark 双态色值,每个值都是带 provenance 的 truth 叶子(组件模式 adapter 复刻
//     主题变量时用它,而不是手抄一份色表——手抄两边同错就是假绿)。
//
// 使用方式:init.mjs 会把本文件拷贝进 demo 目录(extract-helpers.mjs),extract.mjs
// `import { findRepoRoot, makeLeaf } from './extract-helpers.mjs'`——demo 自包含,
// 随 PR 入产品仓后不依赖 skill 安装位置。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * 定位产品仓库根。优先 `git rev-parse --show-toplevel`(worktree/submodule 都正确),
 * 降级为向上找 .git。**禁止**用 `../../..` 数目录层级——那是 2026-07-29 三连 bug 的根因。
 */
export function findRepoRoot(startDir = process.cwd()) {
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
    if (next === cur) break;
    cur = next;
  }
  throw new Error(`findRepoRoot: 从 ${startDir} 向上找不到 git 仓库根——extract 必须在产品仓内运行,或显式传 startDir`);
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * truth 叶子工厂:{ value, provenance: { source, locator, hash[, locatorPattern] } }。
 * source 自动写成「相对 demo 目录」的路径(truth.mjs 以 cwd=demoDir 跑 extract,
 * 校验器 validateProvenance 也按 demoDir 解析)——搬家后重跑 extract 即自动修正,
 * 不再出现「provenance 前缀硬编码旧目录深度」(obs 16371)。
 *
 * @param value 提取到的值(界面文案/几何/色值等)
 * @param sourceFile 源文件绝对路径(或相对 demoDir 的路径)
 * @param opts.locator 必填:一句话说明该值在源文件中的定位方式(人读)
 * @param opts.locatorPattern 可选:恰含一个捕获组的正则(writeback 机械写回的锚,regex 模式)
 * @param opts.keyPath 可选:源文件中该值的完整对象路径(writeback 机械写回的锚,AST 模式;
 *   从顶层变量名/export default/JSON 根起,如 'loginDesignTokens.hero.size';记进
 *   provenance.locatorKeyPath,由 writeback 用产品仓 typescript 在 AST 上定位)
 * @param opts.demoDir 默认 process.cwd()(truth.mjs 保证 = demo 目录)
 */
export function makeLeaf(value, sourceFile, { locator, locatorPattern, keyPath, demoDir = process.cwd() } = {}) {
  if (!locator || typeof locator !== 'string') {
    throw new Error(`makeLeaf(${JSON.stringify(value)}): 必须写 locator——一句话说明该值在源文件里怎么定位`);
  }
  const abs = isAbsolute(sourceFile) ? sourceFile : resolve(demoDir, sourceFile);
  if (!existsSync(abs)) throw new Error(`makeLeaf: 源文件不存在:${abs}`);
  if (locatorPattern !== undefined) {
    let groups;
    try {
      groups = new RegExp(`${locatorPattern}|`).exec('').length - 1;
    } catch (err) {
      throw new Error(`makeLeaf: locatorPattern 不是合法正则:${err.message}`);
    }
    if (groups !== 1) throw new Error(`makeLeaf: locatorPattern 必须恰含一个捕获组(当前 ${groups} 个):${locatorPattern}`);
  }
  if (keyPath !== undefined) {
    if (typeof keyPath !== 'string' || !keyPath.trim() || keyPath.split('.').some((s) => !s || /\s/.test(s))) {
      throw new Error(`makeLeaf: keyPath 必须是「段.段.段」非空路径(段不含空白):${JSON.stringify(keyPath)}`);
    }
  }
  const provenance = { source: relative(demoDir, abs), locator, hash: sha256File(abs) };
  if (locatorPattern !== undefined) provenance.locatorPattern = locatorPattern;
  if (keyPath !== undefined) provenance.locatorKeyPath = keyPath;
  return { value, provenance };
}

/**
 * 服务端驱动数据的叶子工厂:值来自**录制的服务端响应**(providers 配置、account
 * memberships 等源码里没有字面量的数据)。产出 provenance.sourceKind='fixture',
 * 并强制 capturedFrom——诚实声明"这不是源码溯源",而不是假装是。
 *
 * 硬约束(与 validateProvenance 同口径,这里提前抛以便 extract 作者立刻看到):
 *   - capturedFrom 必填:一句话说清什么时候从哪个环境的哪个接口录的;
 *   - fixtureFile 必须存在,且落在 demo 内 `fixtures/` 下(随 PR 走、reviewer 能打开)。
 *
 * @param value 从 fixture 里读出的值
 * @param fixtureFile fixture 文件路径(绝对或相对 demoDir),须为 demo 内 fixtures/<name>.json
 * @param opts.locator 必填:该值在 fixture 中的定位方式(如 'data.providers[0].id')
 * @param opts.capturedFrom 必填:录制来源声明(如 '2026-07-30 公司沙盒 /api/providers 响应')
 * @param opts.demoDir 默认 process.cwd()
 */
export function makeFixtureLeaf(value, fixtureFile, { locator, capturedFrom, demoDir = process.cwd() } = {}) {
  if (!locator || typeof locator !== 'string') {
    throw new Error(`makeFixtureLeaf(${JSON.stringify(value)}): 必须写 locator——该值在 fixture 里怎么定位`);
  }
  if (!capturedFrom || typeof capturedFrom !== 'string' || !capturedFrom.trim()) {
    throw new Error(
      `makeFixtureLeaf(${JSON.stringify(value)}): 必须写 capturedFrom——一句话声明录制来源,` +
        '如 "2026-07-30 公司沙盒 /api/providers 响应"。没有来源声明的 fixture 等于手抄',
    );
  }
  const abs = isAbsolute(fixtureFile) ? fixtureFile : resolve(demoDir, fixtureFile);
  if (!existsSync(abs)) throw new Error(`makeFixtureLeaf: fixture 文件不存在:${abs}`);
  const rel = relative(demoDir, abs).split('\\').join('/');
  if (!rel || rel === '..' || rel.startsWith('../')) {
    throw new Error(`makeFixtureLeaf: fixture 必须放 demo 目录内(当前 ${abs} 在 demo 外,随 PR 走不了)`);
  }
  if (!rel.startsWith('fixtures/')) {
    throw new Error(`makeFixtureLeaf: fixture 必须放 demo 内 fixtures/ 下(当前 ${rel})`);
  }
  return {
    value,
    provenance: { source: rel, sourceKind: 'fixture', locator, capturedFrom: capturedFrom.trim(), hash: sha256File(abs) },
  };
}

/** 从正则捕获组提取源文件中的值(常见「读常量」场景的一步到位封装)。 */
export function extractByPattern(sourceFile, pattern, { locator, demoDir = process.cwd(), transform } = {}) {
  const abs = isAbsolute(sourceFile) ? sourceFile : resolve(demoDir, sourceFile);
  const content = readFileSync(abs, 'utf8');
  const matches = [...content.matchAll(new RegExp(pattern, 'g'))];
  if (matches.length !== 1) throw new Error(`extractByPattern: ${pattern} 在 ${abs} 命中 ${matches.length} 次(必须恰 1 次)`);
  if (matches[0].length !== 2) throw new Error(`extractByPattern: ${pattern} 必须恰含一个捕获组`);
  const raw = matches[0][1];
  return makeLeaf(transform ? transform(raw) : raw, abs, {
    locator: locator ?? `正则 ${pattern}`,
    locatorPattern: pattern,
    demoDir,
  });
}

export function resolveFrom(name, startDirs) {
  const attempts = [];
  for (const dir of startDirs.filter(Boolean)) {
    try {
      return createRequire(join(resolve(dir), 'package.json')).resolve(name);
    } catch (err) {
      attempts.push(`${dir}: ${err.message}`);
    }
  }
  throw new Error(`无法解析模块 ${name}(在产品仓装了吗?)\n${attempts.join('\n')}`);
}

/**
 * esbuild 临时编译 TS 模块后 import——门 F 的 oracle 必须是产品布局公式本身,
 * 不许在 extract 里手抄公式(抄错两边同错 = 假绿)。esbuild 从产品仓 node_modules 解析。
 */
export async function importTsModule(tsFile, { repoRoot } = {}) {
  const abs = resolve(tsFile);
  if (!existsSync(abs)) throw new Error(`importTsModule: 文件不存在:${abs}`);
  const root = repoRoot ?? findRepoRoot(dirname(abs));
  const esbuildPath = resolveFrom('esbuild', [root, process.cwd()]);
  const esbuildMod = await import(pathToFileURL(esbuildPath).href);
  const esbuild = esbuildMod.default?.build ? esbuildMod.default : esbuildMod;
  const result = await esbuild.build({
    entryPoints: [abs],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        // 只允许打进相对导入的纯函数依赖;裸导入(react 等)一律 external——
        // oracle 应是纯计算模块,拖进 UI 依赖说明选错了提取对象
        name: 'externalize-bare',
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => (isBuiltin(args.path) ? undefined : { path: args.path, external: true }));
        },
      },
    ],
  });
  const outFile = join(mkdtempSync(join(tmpdir(), 'qa-hifi-ts-')), 'mod.mjs');
  writeFileSync(outFile, result.outputFiles[0].text);
  return import(pathToFileURL(outFile).href);
}

/* ────────────────────────────────────────────────────────────────────────────
   主题桥:registerColor 全表 → 带 provenance 的 truth 叶子

   组件模式(直接渲染产品组件)下 demo 需要一份 CSS 自定义属性表来复刻产品主题。
   spike 阶段是在 build 脚本里就地正则一把梭;产品化后必须走 truth 叶子——否则
   色值进了 demo 却不在 truth.json 里,门 A 的防伪链(provenance + extractor-drift)
   管不到它,改了产品色表也没人报警。

   语义与 themes/theme-service.ts 的 resolveThemeValue 对齐:
     · light 有值 → 用 light;
     · dark 有值 → 用 dark;dark 为 null/未写 → 回退 light(历史 :root-only token 的级联)。
   ──────────────────────────────────────────────────────────────────────────── */

const REGISTER_COLOR_HEAD = /registerColor\(\s*(['"])((?:[^'"\\]|\\.)*?)\1\s*,\s*\{/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 `{` 开始找配平的 `}`,跳过字符串/模板/注释。返回 {body, endIdx} 或 null(未配平)。 */
function scanBraceBlock(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      for (let j = i + 1; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === c) { i = j; break; }
        if (j === src.length - 1) return null;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(openIdx + 1, i), endIdx: i };
    }
  }
  return null;
}

const JS_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

function unescapeJs(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc) => {
    if (esc[0] === 'u' || esc[0] === 'x') {
      const hex = esc[1] === '{' ? esc.slice(2, -1) : esc.slice(1);
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    return Object.hasOwn(JS_ESCAPES, esc) ? JS_ESCAPES[esc] : esc;
  });
}

/**
 * 读 defaults 对象体里某个模式键的值。返回:
 *   { kind: 'string', raw, value, quote } | { kind: 'null' } | { kind: 'absent' }
 *   | { kind: 'unresolvable' }(函数调用 / 变量 / 带插值的模板字面量 —— 静态提取不了)
 */
function readModeValue(body, key) {
  const head = new RegExp(String.raw`(?:^|[,{\s])${key}\s*:`).exec(body);
  if (!head) return { kind: 'absent' };
  let i = head.index + head[0].length;
  while (i < body.length && /\s/.test(body[i])) i++;
  const q = body[i];
  if (q === "'" || q === '"' || q === '`') {
    let raw = '';
    for (let j = i + 1; j < body.length; j++) {
      const c = body[j];
      if (c === '\\') { raw += c + (body[j + 1] ?? ''); j++; continue; }
      if (c === q) return { kind: 'string', raw, value: unescapeJs(raw), quote: q };
      // 模板插值 = 运行期求值,静态提取不了
      if (q === '`' && c === '$' && body[j + 1] === '{') return { kind: 'unresolvable' };
      raw += c;
    }
    return { kind: 'unresolvable' };
  }
  if (/^null\b/.test(body.slice(i))) return { kind: 'null' };
  return { kind: 'unresolvable' };
}

/**
 * 生成「该 token 该模式」的 writeback 定位锚:恰含一个捕获组、在整个 colors.ts 里恰命中
 * 一次的正则。`(?:(?!registerColor\()[\s\S])*?` 保证不越界到下一个 registerColor 调用。
 * 生成后自检(命中次数 + 捕获内容 == 源码原文),不达标就返回 null —— 宁可退化成
 * 「无机械写回通道」(writeback 会明确拒绝并要求 agent 双改),也不给一个会写错位置的锚。
 */
function makeModePattern(src, id, key, expectedRaw) {
  const pattern =
    String.raw`registerColor\(\s*['"]${escapeRe(id)}['"]` +
    String.raw`(?:(?!registerColor\()[\s\S])*?\b${key}\s*:\s*['"]([^'"]*)['"]`;
  let hits;
  try {
    hits = [...src.matchAll(new RegExp(pattern, 'g'))];
  } catch {
    return null;
  }
  if (hits.length !== 1 || hits[0][1] !== expectedRaw) return null;
  return pattern;
}

/**
 * 提取 `themes/colors.ts` 的 registerColor 全表为 truth 子树。
 *
 *   truth.themeVars = extractThemeVars(colorsFile, { demoDir });
 *   // → { 'surface': { light: <leaf>, dark: <leaf> }, 'surface-hsl': {...}, ... }
 *
 * 每个叶子是 makeLeaf() 的产物(value = CSS 值字符串,provenance.source = colors.ts,
 * locator 写明 token 名与模式)。light/dark 各自可机械写回时带 locatorPattern;
 * dark 回退 light 的叶子不带锚(它在源码里没有对应字面量,给锚只会写错位置)。
 *
 * 跳过的 token(light 非字面量、或 dark 是非字面量表达式)不进结果:静态提取拿不到
 * 真值,硬塞一个猜的值等于往 truth 里注假。跳过项通过 onSkip 回调交出;没给回调时
 * 打一条 stderr 汇总——不静默。
 *
 * @param colorsFile 产品 colors.ts 路径(绝对,或相对 demoDir)
 * @param opts.prefix 只要 id 以此开头的 token(如 'login-');缺省全量
 * @param opts.demoDir 默认 process.cwd()(truth.mjs 保证 = demo 目录)
 * @param opts.onSkip (skipped) => void,skipped = [{ id, mode, reason }]
 */
export function extractThemeVars(colorsFile, { prefix, demoDir = process.cwd(), onSkip } = {}) {
  const abs = isAbsolute(colorsFile) ? colorsFile : resolve(demoDir, colorsFile);
  if (!existsSync(abs)) throw new Error(`extractThemeVars: 源文件不存在:${abs}`);
  const src = readFileSync(abs, 'utf8');

  const out = {};
  const skipped = [];
  let scanned = 0;
  REGISTER_COLOR_HEAD.lastIndex = 0;
  for (const head of src.matchAll(REGISTER_COLOR_HEAD)) {
    scanned++;
    const id = unescapeJs(head[2]);
    const openIdx = head.index + head[0].length - 1;
    const block = scanBraceBlock(src, openIdx);
    if (!block) {
      skipped.push({ id, mode: 'both', reason: 'defaults 对象大括号未配平(源码语法异常?)' });
      continue;
    }
    if (prefix && !id.startsWith(prefix)) continue;
    if (Object.hasOwn(out, id)) {
      throw new Error(`extractThemeVars: token '${id}' 在 ${abs} 里注册了两次——产品侧 ColorRegistry 会直接抛错,先修源码`);
    }

    const light = readModeValue(block.body, 'light');
    const dark = readModeValue(block.body, 'dark');
    if (light.kind !== 'string') {
      skipped.push({
        id,
        mode: 'light',
        reason: light.kind === 'null' || light.kind === 'absent'
          ? 'light 为 null/未写(该 token 在 light 下无值)'
          : 'light 是非字面量表达式(函数调用/变量/模板插值),静态提取不到真值',
      });
      continue;
    }
    if (dark.kind === 'unresolvable') {
      skipped.push({ id, mode: 'dark', reason: 'dark 是非字面量表达式,静态提取不到真值(不敢回退 light,那会写进假值)' });
      continue;
    }

    const lightPattern = makeModePattern(src, id, 'light', light.raw);
    const lightLeaf = makeLeaf(light.value, abs, {
      locator: `colors.ts registerColor('${id}') 的 defaults.light`,
      ...(lightPattern ? { locatorPattern: lightPattern } : {}),
      demoDir,
    });

    let darkLeaf;
    if (dark.kind === 'string') {
      const darkPattern = makeModePattern(src, id, 'dark', dark.raw);
      darkLeaf = makeLeaf(dark.value, abs, {
        locator: `colors.ts registerColor('${id}') 的 defaults.dark`,
        ...(darkPattern ? { locatorPattern: darkPattern } : {}),
        demoDir,
      });
    } else {
      // dark: null / 未写 → theme-service.resolveThemeValue 回退 light(旧 :root-only 级联)
      darkLeaf = makeLeaf(light.value, abs, {
        locator: `colors.ts registerColor('${id}') 的 defaults.dark 为 null/未写,按 theme-service.resolveThemeValue 回退 light`,
        demoDir,
      });
    }

    out[id] = { light: lightLeaf, dark: darkLeaf };
  }

  if (scanned === 0) {
    throw new Error(`extractThemeVars: 在 ${abs} 里一个 registerColor(...) 都没匹配到——源码格式变了,先修本函数的解析再跑`);
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      `extractThemeVars: ${abs} 扫到 ${scanned} 个 registerColor,但${prefix ? ` prefix='${prefix}' 过滤后` : ''}一个可用 token 都没有`,
    );
  }
  if (skipped.length) {
    if (onSkip) onSkip(skipped);
    else console.warn(`[extractThemeVars] 跳过 ${skipped.length} 个 token:${skipped.map((s) => `${s.id}(${s.mode})`).join(', ')}`);
  }
  return out;
}
