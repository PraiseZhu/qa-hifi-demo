import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const TOOL_VERSION = 'qa-hifi-demo@2026-07-30-gate-e-sync-v2';

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

const GLOB_SKIP_DIRS = new Set(['.git', 'node_modules']);

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

/**
 * component 模式的代码层防伪链:产品组件源文件 + bundle 产物逐一 sha256。
 * 源文件改了而 demo 没重构建 → hash 变 → 旧 report 被 pr-block 拒。
 * 缺失文件记 MISSING、glob 零命中记 NO_MATCH(源集消失同样要让 hash 变)。
 */
export function buildComponentHashes(demoDir, component) {
  const repoRoot = findGitRepoRoot(demoDir);
  const out = { sources: {}, bundle: {} };
  const patterns = Array.isArray(component?.sources) ? component.sources : [];
  const entry = typeof component?.entry === 'string' && component.entry ? [component.entry] : [];
  if (!repoRoot) {
    out.repoRoot = 'UNRESOLVED';
    for (const p of [...entry, ...patterns]) out.sources[p] = 'UNRESOLVED';
  } else {
    for (const pattern of [...entry, ...patterns]) {
      const matched = expandRepoGlob(repoRoot, pattern);
      if (matched.length === 0) { out.sources[pattern] = 'NO_MATCH'; continue; }
      for (const rel of matched) {
        const abs = join(repoRoot, rel);
        out.sources[rel] = existsSync(abs) && statSync(abs).isFile() ? hashFile(abs) : 'MISSING';
      }
    }
  }
  const bundle = typeof component?.bundle === 'string' && component.bundle ? component.bundle : null;
  if (bundle) {
    const abs = join(demoDir, bundle);
    out.bundle[bundle] = existsSync(abs) ? hashFile(abs) : 'MISSING';
  }
  return out;
}

export function buildInputHashes(demoDir, spec = null) {
  const files = ['spec.json', 'truth.json', 'index.html'];
  const hashes = {};
  for (const name of files) hashes[name] = hashFile(join(demoDir, name));
  hashes.baselines = buildBaselineManifest(demoDir, spec);
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
