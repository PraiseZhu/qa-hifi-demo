// repo-glob.mjs — 仓内 glob 展开(最小实现,零依赖)。
//
// 原本内嵌在 lib/fs-utils.mjs 里,r3 抽成独立模块的原因:component 构建核心
// (lib/component-build-core.mjs)也要用它展开 tailwind content(审核 #2c-b),
// 而该核心会随模板拷进 demo 目录、不能反向 import 整个 fs-utils(会拖进 git/hash 全套)。
// 两处共享同一份实现,避免「两套 glob 语义」漂移。

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative as relativePath, resolve, sep } from 'node:path';

const GLOB_SKIP_DIRS = new Set(['.git', 'node_modules']);
/** Tailwind 的 fastGlob.sync 不带 ignore —— 与它对齐时一个目录都不跳(r6 条目 4)。 */
const EMPTY_SKIP = new Set();

/* ── demo 自带 node_modules 的探测(r6:实现从 fs-utils 移到本模块) ──
   为什么搬家:构建核心(component-build-core.mjs)在 r6 起会**执行产品仓的
   tailwind config**(可信侧复算 CSS 字节),按审核裁定这一步必须排在
   「demo node_modules 前置门」之后。而构建核心不能反向 import 整个 fs-utils
   (会把 git/hash 全套拖进 demo 拷贝),于是把探测实现放进 repo-glob ——
   它本来就是构建核心与 fs-utils 共用、且随模板拷进 demo 的零依赖模块。
   fs-utils.checkDemoNoNodeModules 改为复用本函数,**只有一份实现**,不会漂移。 */
export function findDemoNodeModules(demoDir, { limit = 5 } = {}) {
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

/* ── 受限 glob 语法的**白名单式**校验(r5 #2c-b P0) ──
   本模块只实现 `*` / `**` / `?` 三种通配。r4 用黑名单挡 `{}()!,`,漏了字符类 `[ab]`:
   globToRegExp 把中括号**转义成字面量**,而 Tailwind 用的 fast-glob/micromatch 把它当
   字符类。于是仓里放一个字面文件名 `[ab].tsx` —— 我们这边零命中(放行/不入链),
   Tailwind 那边实扫 a.tsx / b.tsx;改 a/b 不改任何 hash,旧 CSS + 旧 report 照过验收。
   逐个补元字符是补不完的(extglob 前缀 +@!?、brace、negation、POSIX 类…),
   所以改成白名单:只有「本工具确定实现了、且 micromatch 语义一致」的字符可以出现。
   允许:A-Za-z0-9 与 `_ - . / * ?`,以及非 ASCII 字符(中文等文件名,不可能是 glob 元字符)。
   其余一律 fail-closed —— 这只会收紧,不会放宽。 */
const GLOB_ALLOWED = /^(?:[A-Za-z0-9_./*?-]|[^\x00-\x7F])*$/u;
const GLOB_META_HINT = ['[', ']', '{', '}', '!', '(', ')', '+', '@', ',', '|', '^', '$', '\\'];

/**
 * pattern 是否是本工具可解析的受限 glob。
 * @returns {string|null} 问题描述(可直接进 problems / fail 报文);null = 通过。
 */
export function restrictedGlobProblem(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return '必须是非空 string(仓内相对 glob)';
  if (pattern.startsWith('/')) return `不允许绝对路径:${pattern}`;
  if (pattern.split('/').includes('..')) return `不允许 ".." 越狱:${pattern}`;
  if (!GLOB_ALLOWED.test(pattern)) {
    const hit = [...new Set([...pattern].filter((c) => !GLOB_ALLOWED.test(c)))];
    const meta = hit.filter((c) => GLOB_META_HINT.includes(c));
    return (
      `"${pattern}" 不是本工具可解析的受限 glob:出现了未实现的字符 ${hit.map((c) => JSON.stringify(c)).join(' ')}`
      + (meta.length ? `(其中 ${meta.map((c) => JSON.stringify(c)).join(' ')} 会被 Tailwind 的 fast-glob/micromatch 当元字符解释,两边语义不一致 = 声明了却没入链)` : '')
      + '\n只支持仓内相对路径 + * / ** / ?;字符类 [ab]、brace {a,b}、否定 !、extglob +(a)/@(a)/!(a)、'
      + '括号、逗号多值、反斜杠、以及 tailwind config 里的 require()/对象形式一律不支持。'
      + '\n修法:拆成多条标准 glob(需要匹配字面中括号的文件名请改文件名)。'
    );
  }
  return null;
}

/** glob 段 → 正则源码。`**` 跨目录、`*` 段内、`?` 单字符,其余字符字面量转义。 */
function globToRegExp(pattern) {
  let src = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` 允许匹配零层目录;裸 `**` 匹配任意后缀
        if (pattern[i + 2] === '/') { src += '(?:.*/)?'; i += 2; } else { src += '.*'; i += 1; }
      } else src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`);
}

/** glob 前的静态目录前缀:只遍历这一段,避免在大仓里全量 walk。 */
function globStaticPrefix(pattern) {
  const segs = pattern.split('/');
  const out = [];
  for (const seg of segs) {
    if (/[*?]/.test(seg)) break;
    out.push(seg);
  }
  // 最后一段若是完整文件名(无通配)也会被收进来,walkFiles 对文件路径同样安全
  return out.join('/');
}

function walkFiles(rootAbs, relDir, out, { skipDirs = GLOB_SKIP_DIRS } = {}) {
  const abs = relDir ? join(rootAbs, relDir) : rootAbs;
  if (!existsSync(abs)) return out;
  if (!statSync(abs).isDirectory()) { out.push(relDir); return out; }
  for (const name of readdirSync(abs).sort()) {
    if (skipDirs.has(name)) continue;
    const childRel = relDir ? `${relDir}/${name}` : name;
    const childAbs = join(rootAbs, childRel);
    if (statSync(childAbs).isDirectory()) walkFiles(rootAbs, childRel, out, { skipDirs });
    else out.push(childRel);
  }
  return out;
}

/**
 * 按 glob 展开 repoRoot 下的文件(相对路径,已排序去重)。
 * 无通配符的模式不 walk,直接当字面路径返回(缺失与否交给调用方记 MISSING)。
 */
export function expandRepoGlob(repoRoot, pattern) {
  if (!/[*?]/.test(pattern)) return [pattern];
  const re = globToRegExp(pattern);
  const files = walkFiles(repoRoot, globStaticPrefix(pattern), []);
  return files.filter((f) => re.test(f)).sort();
}

/* ══ Tailwind content 的展开:复用 fast-glob,不再自研语义(r6 条目 3/4/5)══

   自研 glob 展开这条路已被证伪四次:
     r4  黑名单挡 `{}()!,` 漏了字符类 `[ab]`(我们当字面量、micromatch 当字符类);
     r6  content.relative:true 时 glob 基准变成 dirname(userConfigPath),而 `--content`
         CLI 参数只覆盖 config.content.files、**不覆盖 relative** —— 于是 config 在
         apps/desktop/ 时真文件 apps/desktop/src/Foo.tsx 被实扫,而我们只返回仓根诱饵
         src/Foo.tsx;两边哈的是完全不同的一组文件,且「零命中即 fail」不触发
         (matched.length===1,只是命中了错的);
     r6  GLOB_SKIP_DIRS 无条件跳 node_modules/.git,而 Tailwind 的 fastGlob.sync 不带
         ignore —— src/node_modules/vendor-widget/Widget.tsx 被实扫且生效,我们完全不返回;
     r6  `***` / `a**` 这类写法两边语义也不同。
   结论:放弃自研,改成复用**与 Tailwind 同一族**的 fast-glob。

   安全性不靠这里:靠 component-build-core.computeExpectedCssSha 的 CSS 字节复算(条目 1)。
   本函数只负责**准确性**(入链清单尽量等于 Tailwind 实扫集),算不准最坏是报错不精确,
   不会放行伪造。

   解析可信性(P0-2 原则):候选根只许放**不受 demo 目录内容左右**的目录 ——
   QA_HIFI_MODULE_ROOT / PLAYWRIGHT_MODULE_ROOT(运行者显式设置)与产品 repoRoot
   (必须是 demo 的严格祖先,由调用方保证)。**故意不放 skill 自身目录**:本模块会被
   拷进 demo,skill-self 在 demo 侧就等于 demo 目录 —— 既不可信,还会让「demo 侧 build」
   与「skill 侧复算」解析出不同引擎、算出不同清单(假阴性)。解析结果落在 demo 子树内
   一律拒收。生产环境里产品仓装了 tailwind 就一定装了 fast-glob(tailwind 的依赖),
   两侧解析到同一份,结果一致。 */
function resolveFastGlob(trustedDirs, demoRealPath) {
  for (const dir of trustedDirs.filter(Boolean)) {
    let resolved;
    try {
      const req = createRequire(join(resolve(dir), 'package.json'));
      resolved = req.resolve('fast-glob');
      if (demoRealPath && isInside(demoRealPath, realish(resolved))) continue; // 落在 demo 子树 → 拒收
      const mod = req('fast-glob');
      const fg = typeof mod?.sync === 'function' ? mod : mod?.default;
      if (typeof fg?.sync !== 'function') continue;
      let version = null;
      try { version = req('fast-glob/package.json').version ?? null; } catch {}
      return { fg, from: resolved, version };
    } catch {}
  }
  return null;
}
const realish = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const isInside = (root, abs) => abs === root || abs.startsWith(root + sep);

/**
 * Tailwind config 里 `content.relative` 的探测 —— 决定 content glob 的基准目录。
 *
 * 用**静态文本扫描**而不是 require() 那份 config:读它就要执行产品仓的 JS(以及它
 * require 的 presets/plugins),而这一步在输入清单计算路径上会被 demo 侧的 build.mjs
 * 也跑到 —— 次序护栏只在 CSS 复算那条路上成立。静态扫描零执行,基准判错最坏只是
 * 清单不精确(安全性由 CSS 字节复算兜)。
 * 已知局限(诚实标注):relative 由 preset 间接打开时扫不出来。
 */
export function tailwindContentRelative(tailwindConfigAbs) {
  try {
    const text = readFileSync(tailwindConfigAbs, 'utf8');
    return /(^|[^A-Za-z0-9_$])relative\s*:\s*true/.test(text);
  } catch {
    return false;
  }
}

/**
 * 按 Tailwind 的语义展开 content glob。
 *
 * @returns {{files: string[], engine: 'fast-glob'|'builtin', engineFrom: string|null,
 *            engineVersion: string|null, base: string, relative: boolean, notes: string[]}}
 *   files 一律是**相对 repoRoot 的 posix 路径**(仓外命中会被丢弃并记 note)。
 */
export function expandTailwindContent(repoRoot, patterns, { tailwindConfigAbs = null, demoDir = null } = {}) {
  const notes = [];
  const relative_ = tailwindConfigAbs ? tailwindContentRelative(tailwindConfigAbs) : false;
  // content.relative:true → 基准是 config 所在目录(实测 tailwindcss@3.4.19);否则仓根
  const base = relative_ && tailwindConfigAbs ? dirname(tailwindConfigAbs) : resolve(repoRoot);
  if (relative_) notes.push(`tailwind config 开启了 content.relative → glob 基准是 ${base}(不是仓根)`);

  const demoReal = demoDir ? realish(demoDir) : null;
  const resolved = resolveFastGlob([process.env.QA_HIFI_MODULE_ROOT, process.env.PLAYWRIGHT_MODULE_ROOT, repoRoot], demoReal);
  const repoReal = realish(repoRoot);
  const rel = (abs) => {
    const r = realish(abs);
    if (!isInside(repoReal, r)) { notes.push(`命中了产品仓外的文件,不入链:${abs}`); return null; }
    return relativePath(repoReal, r).split(sep).join('/');
  };

  const out = new Set();
  if (resolved) {
    // 与 Tailwind 对齐:**不带 ignore** —— node_modules 里的文件同样被它实扫并生效
    const hits = resolved.fg.sync(patterns, { cwd: base, onlyFiles: true, absolute: true, dot: false, followSymbolicLinks: true, suppressErrors: true });
    for (const abs of hits) { const r = rel(abs); if (r) out.add(r); }
    return {
      files: [...out].sort(), engine: 'fast-glob', engineFrom: resolved.from,
      engineVersion: resolved.version, base, relative: relative_, notes,
    };
  }

  /* 兜底:产品仓与环境变量都解析不到 fast-glob(生产里意味着产品仓压根没装 tailwind,
     那时 CSS 复算本身就 fail-closed 了)。仍然与 Tailwind 对齐一点:**不跳过
     node_modules/.git** —— 跳过就是条目 4 那个非对称。 */
  notes.push('解析不到 fast-glob(可信侧候选:QA_HIFI_MODULE_ROOT / PLAYWRIGHT_MODULE_ROOT / 产品仓根),'
    + '退回内建展开 —— 与 Tailwind 的 micromatch 语义可能有差异,入链清单可能不精确;'
    + '安全性仍由 CSS 字节复算兜住(条目 1)。');
  for (const pattern of patterns) {
    if (!/[*?]/.test(pattern)) {
      const abs = join(base, pattern);
      if (existsSync(abs)) { const r = rel(abs); if (r) out.add(r); }
      continue;
    }
    const re = globToRegExp(pattern);
    for (const f of walkFiles(base, globStaticPrefix(pattern), [], { skipDirs: EMPTY_SKIP })) {
      if (!re.test(f)) continue;
      const r = rel(join(base, f));
      if (r) out.add(r);
    }
  }
  return { files: [...out].sort(), engine: 'builtin', engineFrom: null, engineVersion: null, base, relative: relative_, notes };
}
