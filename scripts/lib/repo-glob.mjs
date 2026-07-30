// repo-glob.mjs — 仓内 glob 展开(最小实现,零依赖)。
//
// 原本内嵌在 lib/fs-utils.mjs 里,r3 抽成独立模块的原因:component 构建核心
// (lib/component-build-core.mjs)也要用它(r6 之前用于展开 tailwind content;r7 起 content
// 改成显式文件列表,这里只留 explicitContentFileProblem 的格式校验),
// 而该核心会随模板拷进 demo 目录、不能反向 import 整个 fs-utils(会拖进 git/hash 全套)。
// 两处共享同一份实现,避免「两套 glob 语义」漂移。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const GLOB_SKIP_DIRS = new Set(['.git', 'node_modules']);

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

/* ══ tailwind content 的**显式文件路径**校验(r7 条目 2,破坏性接口变更)══

   自研 glob 语义已被证伪四次(字符类 `[ab]` / `content.relative` 基准错位 / node_modules
   非对称扫描 / `***` 形态);r6 改成复用 fast-glob 后仍留三条残余:relative 靠静态文本扫描
   推断、我们解析到的 fast-glob 未必与 tailwind 内部那份同源、config 的 plugin/preset 不递归
   入链。而 Tailwind v3 **没有公开稳定的 API/CLI 能导出真实 file set**(3.4.19 无 verbose/files
   输出;parseCandidateFiles 是包内私有 API,不是升级稳定契约)。

   结论:收回语义解释权 —— component.css.content 只接受**显式的 repo-relative 普通文件路径**,
   完全禁止 glob 与目录。构建时转成绝对路径传给 Tailwind `--content`,此时 config.content 与
   config.content.relative 都不再决定集合(实测:绝对文件路径在 parseCandidateFiles 里
   glob === null,扫描集就是那些文件本身)。

   不变式 S ⊆ E = L(实扫集 ⊆ 期望集 = 入链集)由**参数结构**保证,不靠事后猜测。

   作者便利性:component-build-core 提供 `--suggest-content <glob...>` 生成器,把旧 glob 展成
   建议清单;但**定稿输入必须是显式列表**,生成器产出要落进 spec 而不是运行时展开。 */
const CONTENT_META = ['*', '?', '[', ']', '{', '}', '!', '(', ')', '+', '@', ',', '|', '^', '$', '\\'];

/**
 * component.css.content 的单项格式校验(纯函数,不碰文件系统)。
 * 文件系统层面的校验(存在、regular file、realpath 在仓内)见
 * component-build-core.resolveContentFiles —— 两层都必须过。
 * @returns {string|null} 问题描述;null = 通过。
 */
export function explicitContentFileProblem(entry) {
  const migrate =
    '\ncomponent.css.content 自 r7 起只接受**显式的仓内相对普通文件路径**(不再支持 glob/目录):'
    + '\n  旧:["src/**/*.tsx"]   新:["src/App.tsx", "src/Panel.tsx", ...]'
    + '\n迁移:跑 node scripts/lib/component-build-core.mjs --suggest-content "src/**/*.tsx" --demo <dir>'
    + '(生成器,把旧 glob 展成建议清单),把结果抄进 spec.json;运行期不再做任何展开。'
    + '\n原因:自研/复用的 glob 展开与 Tailwind 实扫集的语义差异已被证伪四次,'
    + '而 Tailwind v3 没有公开稳定 API 能导出真实 file set —— 只有显式列表能让'
    + '「实扫集 ⊆ 期望集 = 入链集」由参数结构保证。';
  if (typeof entry !== 'string' || !entry.trim()) return `必须是非空 string(仓内相对文件路径)${migrate}`;
  if (entry !== entry.trim()) return `"${entry}" 首尾有空白${migrate}`;
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) return `不允许绝对路径:${entry}${migrate}`;
  if (entry.includes('\\')) return `不允许反斜杠(一律用 posix 分隔符):${entry}${migrate}`;
  if (entry.split('/').includes('..')) return `不允许 ".." 越狱:${entry}${migrate}`;
  const meta = [...new Set([...entry].filter((c) => CONTENT_META.includes(c)))];
  if (meta.length)
    return (
      `"${entry}" 含 glob/元字符 ${meta.map((c) => JSON.stringify(c)).join(' ')} —— content 只接受显式文件路径`
      + `${migrate}`
    );
  const segs = entry.split('/');
  if (segs.some((s) => !s)) return `路径含空段(重复或首尾斜杠):${entry}${migrate}`;
  if (segs.includes('node_modules')) return `默认拒绝 node_modules 下的路径:${entry}(第三方文件不该作为 demo 的样式源;真需要请先在产品侧把它复制/导出到仓内源码目录)`;
  if (segs.includes('.git')) return `默认拒绝 .git 下的路径:${entry}`;
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

/* r7 条目 2:content 的 fast-glob 展开(expandTailwindContent / tailwindContentRelative /
   resolveFastGlob)已整段下线 —— content 改成显式文件路径列表后不再需要任何展开语义,
   保留它只会留下「还能走 glob」的错觉。校验入口是上面的 explicitContentFileProblem,
   文件系统层解析在 component-build-core.resolveContentFiles。
   expandRepoGlob 仍在(assets 清单 / component.sources 等其它用途),不受本轮影响。 */
