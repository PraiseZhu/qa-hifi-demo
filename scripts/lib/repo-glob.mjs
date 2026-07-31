// repo-glob.mjs — 仓内 glob 展开(最小实现,零依赖)。
//
// 原本内嵌在 lib/fs-utils.mjs 里,r3 抽成独立模块的原因:component 构建核心
// (lib/component-build-core.mjs)也要用它(r6 之前用于展开 tailwind content;r7 起 content
// 改成显式文件列表,这里只留 explicitContentFileProblem 的格式校验),
// 而该核心会随模板拷进 demo 目录、不能反向 import 整个 fs-utils(会拖进 git/hash 全套)。
// 两处共享同一份实现,避免「两套 glob 语义」漂移。

import { existsSync, readdirSync, readlinkSync, statSync } from 'node:fs';
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

/* ── demo 输入树里的 symlink 探测(r9 P0:观察对象 ≠ 交付对象) ──
   为什么整类拒:同一条 symlink 在三个地方语义不同。
     · 快照侧:makeObservationSnapshot 用 cpSync(dereference:true),链接目标的字节被复制成
       快照内的**普通文件** → snapshot safe-server 返回 200,可信侧观察得到它;
     · 交付/原地侧:safe-server 对 target 做 realpathSync 后要求落在根内,指向仓外的链接 → **403**;
     · manifest 侧(r9 之前):只比「跟随 symlink 后的文件 hash」,快照里的普通文件与磁盘上的
       symlink 被判全等 → snapshotDrift = "none"。
   三者叠起来就是审核人 PoC:linked.js 是指向仓外的 symlink,把绑定元素改成正确值 →
   可信侧量到正确值判绿放行,而交付页面上该资源 403、渲染的是错误值。方向与 r8 的 late.js
   PoC 相反(那次是「交付比观察多」,这次是「观察比交付多」)。
   demo 内部指向 demo 内的 symlink 一并拒:dereference 后同样变成普通文件、manifest 同样判不出
   差异,且部署侧对 symlink 的处理不确定(可能 dereference、可能直接失效),原地/快照/部署三处
   语义仍不一致 —— 这是 fail-closed,不是「按目标位置分情况放行」。
   跳过 .git(不属交付产物,部署侧同样排除);node_modules 由 findDemoNodeModules 无条件拒,
   不在本函数重复报(命中即另一道门 fail-fast)。
   @returns {Array<{path: string, target: string}>} path 为 demo 相对路径,target 为 readlink 原值。 */
export function findDemoSymlinks(demoDir, { limit = 10 } = {}) {
  const hits = [];
  const walk = (dir, rel) => {
    if (hits.length >= limit) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (GLOB_SKIP_DIRS.has(e.name)) continue;   // .git 不属交付;node_modules(含 symlink 形态)由另一道门拒
      if (e.isSymbolicLink()) {
        let target = '(readlink 失败)';
        try { target = readlinkSync(join(dir, e.name)); } catch { /* 悬空/无权限也照样算命中 */ }
        hits.push({ path: childRel, target });
        continue;                    // 不跟随:跟随就等于自己做了一次 dereference
      }
      if (!e.isDirectory()) continue;
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

/* ══ tailwind content 的**显式文件路径**校验(r7 条目 2/5/6)══

   r7 条目 2 起 content 只接受显式文件路径。条目 5 原本要求「删掉受限字符白名单,只留路径
   安全政策」,理由是「解析权已交给 Tailwind,再留字符规则会误杀合法文件名」。
   **我实测 tailwindcss@3.4.19 后只采纳了它的一半** —— 前半(删白名单)对,后半(不拒
   `[ ] { }`)会直接击穿不变式 E = L。实测证据(`parseCandidateFiles` 的 `glob` 字段;
   非 null = 被当 glob 解释):

     声明(绝对路径,真实存在的文件)   Tailwind 的解释
     src/plain.tsx                     glob=null  ✅ 字面
     src/x y.tsx / a#b / a%b / a&b      glob=null  ✅ 字面(旧白名单**误杀**过这些)
     src/a'b / a~b / a=b / a;b / a:b    glob=null  ✅ 字面(同上)
     src/a[b.tsx / a]b / a{b / a!b      glob=null  ✅ 字面(单个字符不成对 → 不是 glob)
     src/a(b).tsx / a+b / a@b / a|b     glob=null  ✅ 字面
     src/a?b.tsx                       glob=null  ✅ 字面(实测如此)
     src/中文.tsx                       glob=null  ✅ 字面
     src/a*b.tsx                       glob="a*b.tsx"    ❌ 通配
     src/[ab].tsx                      glob="[ab].tsx"   ❌ 字符类 → 实扫 a.tsx / b.tsx
     src/{a}.tsx                       glob="{a}.tsx"    ❌ brace
     src/+(a).tsx  @( !( ?( *(          glob="+(a).tsx"   ❌ extglob
     src/\\[ab].tsx(反斜杠转义)         glob="[ab].tsx"   ❌ 转义也救不了(实测:字面文件反而扫不到,
                                                          a.tsx/b.tsx 照样被扫)

   结论:`[ab].tsx` 这类**真实存在**的文件靠「存在 + regular file」兜不住 —— 它存在、是普通
   文件,而 Tailwind 仍把它当字符类,实扫集变成 a.tsx / b.tsx(E ≠ L,正是 r5 那条 `[ab]` 绕过)。
   所以策略改成:**按 Tailwind 自己的解析行为拒收**(成对 `[...]` / `{...}` / extglob 前缀 /
   `*`),而不是按「我们实现了哪些字符」拒收。这不是第二套政策,而是 `glob === null` 的必要
   条件;每一条都由 comp-fix-r7 的实跑测试钉在 Tailwind 的真实行为上(拒收类必须 glob≠null,
   放行类必须 glob===null),Tailwind 换版本后行为若变化 → 测试红,强制显式适配。

   条目 6(逗号,transport 而非 glob):实测 `--content` 是**逗号分隔的多值串**,
   `src/a,b.tsx` 会被切成两段,该文件的 class **不进 CSS**(而 config 数组形式能正确承载它)。
   我们保留 `--content` 这条通道(它才是让 config.content / relative 失效的 override,
   且薄壳 build 与可信侧复算必须逐字节同参),因此**含逗号的路径一律拒绝,绝不静默 join**。

   `?` 的取舍(如实说明):实测它在文件名里是字面的,本可放行;仍然拒 —— 作者写 `?` 基本上
   就是想用通配,报错并给迁移提示比让它按字面找一个不存在的文件更有用。这一条标注为
   **意图信号**,不是 E = L 的必要条件。 */

/** Tailwind 会当 glob 解释的形态(实测钉死,见上表)——命中即拒。 */
const GLOB_SHAPES = [
  { re: /\*/, why: '`*` 是通配符(实测 glob="…*…")' },
  { re: /\[[^/]*\]/, why: '成对 `[...]` 被当字符类(实测 `[ab].tsx` → 实扫 a.tsx / b.tsx,连转义也救不了)' },
  { re: /\{[^/]*\}/, why: '成对 `{...}` 被当 brace 展开' },
  { re: /[+@!?*]\([^/]*\)/, why: 'extglob 前缀 `+( @( !( ?( *(` 被当扩展通配' },
  { re: /\\/, why: '反斜杠:既是 Windows 分隔符歧义,实测也无法用来转义 glob 元字符' },
];

/**
 * component.css.content 的单项校验(纯函数,不碰文件系统)。
 * 两层政策,分开写清楚:
 *   ① 路径安全:非空、无 NUL、非绝对路径、无 `..`、无空段、不在 `.git/` 或 `node_modules/` 下;
 *   ② glob/transport 形态:Tailwind 会当 glob 解释的形态(实测钉死)+ `--content` 承载不了的逗号
 *      + `?` 意图信号。
 * 文件系统层(存在 / regular file / realpath 在 repoRoot 内)见
 * component-build-core.resolveContentFiles —— 两层都必须过,报错优先给**真实信息**。
 * @returns {string|null} 问题描述;null = 通过。
 */
export function explicitContentFileProblem(entry) {
  const migrate =
    '\ncomponent.css.content 自 r7 起只接受**显式的仓内相对普通文件路径**(不再支持 glob/目录):'
    + '\n  旧:["src/**/*.tsx"]   新:["src/App.tsx", "src/Panel.tsx", ...]'
    + '\n迁移:跑 node scripts/lib/component-build-core.mjs --suggest-content "src/**/*.tsx" --demo <dir>'
    + '(生成器,把旧 glob 展成建议清单),把结果抄进 spec.json;运行期不再做任何展开。'
    + '\n原因:只有显式文件列表能让「实扫集 ⊆ 期望集 = 入链集」由参数结构保证 ——'
    + 'Tailwind 对绝对普通文件路径给出 glob===null,扫描集就是那些文件本身。';
  // ── ① 路径安全 ──
  if (typeof entry !== 'string' || !entry) return `必须是非空 string(仓内相对文件路径)${migrate}`;
  if (entry.includes('\0')) return '不允许 NUL 字符';
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) return `不允许绝对路径:${entry}${migrate}`;
  if (entry.split('/').includes('..')) return `不允许 ".." 越狱:${entry}${migrate}`;
  const segs = entry.split('/');
  if (segs.some((seg) => !seg)) return `路径含空段(重复或首尾斜杠):${entry}${migrate}`;
  if (segs.includes('node_modules')) return `默认拒绝 node_modules 下的路径:${entry}(第三方文件不该作为 demo 的样式源;真需要请先在产品侧把它复制/导出到仓内源码目录)`;
  if (segs.includes('.git')) return `默认拒绝 .git 下的路径:${entry}`;
  // ── ② glob / transport 形态 ──
  for (const shape of GLOB_SHAPES) {
    if (shape.re.test(entry))
      return (
        `"${entry}" 会被 Tailwind 当 glob 解释,不能作为显式文件声明:${shape.why}。`
        + '\n后果:实扫集 ≠ 声明集(E ≠ L)—— 被扫到的文件不入防伪链,改它们 hash 不变、旧 CSS 照过验收。'
        + (/\[|\{|\(/.test(entry)
          ? '\n如果这**真的是文件名里的字符**:Tailwind 没有可用的转义方式(实测反斜杠转义后字面文件反而扫不到),'
            + '请改文件名,或把该文件的样式改由别的入口承载。'
          : '')
        + migrate
      );
  }
  if (entry.includes(','))
    return (
      `"${entry}" 含逗号,\`--content\` 承载不了:实测 tailwind CLI 把 --content 当**逗号分隔多值串**,`
      + '该路径会被切成两段,这个文件的 class 根本不会进 CSS(静默漏扫)。'
      + '\n修法:改文件名去掉逗号。(config 数组形式能承载逗号,但我们必须用 --content override 才能'
      + '让 config.content / content.relative 失效,两条通道不能混用。)'
    );
  if (entry.includes('?'))
    return (
      `"${entry}" 含 \`?\` —— 显式列表模式下不接受通配符写法(实测 \`?\` 在文件名里是字面的,`
      + '拒它是**意图信号**:写 ? 通常是想用 glob)。'
      + '\n真是文件名里的字面 ? 请改文件名。'
      + migrate
    );
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
