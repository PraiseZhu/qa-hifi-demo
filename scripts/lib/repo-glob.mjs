// repo-glob.mjs — 仓内 glob 展开(最小实现,零依赖)。
//
// 原本内嵌在 lib/fs-utils.mjs 里,r3 抽成独立模块的原因:component 构建核心
// (lib/component-build-core.mjs)也要用它展开 tailwind content(审核 #2c-b),
// 而该核心会随模板拷进 demo 目录、不能反向 import 整个 fs-utils(会拖进 git/hash 全套)。
// 两处共享同一份实现,避免「两套 glob 语义」漂移。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const GLOB_SKIP_DIRS = new Set(['.git', 'node_modules']);

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

function walkFiles(rootAbs, relDir, out) {
  const abs = relDir ? join(rootAbs, relDir) : rootAbs;
  if (!existsSync(abs)) return out;
  if (!statSync(abs).isDirectory()) { out.push(relDir); return out; }
  for (const name of readdirSync(abs).sort()) {
    if (GLOB_SKIP_DIRS.has(name)) continue;
    const childRel = relDir ? `${relDir}/${name}` : name;
    const childAbs = join(rootAbs, childRel);
    if (statSync(childAbs).isDirectory()) walkFiles(rootAbs, childRel, out);
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
