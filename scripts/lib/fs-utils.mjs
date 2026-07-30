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
