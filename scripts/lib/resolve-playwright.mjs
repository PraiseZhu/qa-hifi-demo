import { createRequire } from 'node:module';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { findGitRepoRoot, findPackageRoot } from './fs-utils.mjs';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function requireFrom(startDir) {
  const root = findPackageRoot(startDir) ?? resolve(startDir);
  return createRequire(join(root, 'package.json'));
}

function ancestors(startDir) {
  const out = [];
  let cur = resolve(startDir);
  while (true) {
    out.push(cur);
    const next = dirname(cur);
    if (next === cur) return out;
    cur = next;
  }
}

function workspaceSiblingRoots(startDir) {
  const out = [];
  for (const base of ancestors(startDir)) {
    const projects = join(base, 'projects');
    if (!existsSync(projects)) continue;
    let names = [];
    try { names = readdirSync(projects); } catch { continue; }
    for (const name of names) {
      const candidate = join(projects, name);
      try {
        if (statSync(candidate).isDirectory() && existsSync(join(candidate, 'package.json'))) out.push(candidate);
      } catch {}
    }
  }
  return out;
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const inside = (root, abs) => abs === root || abs.startsWith(root + sep);
const SELF_DIR = import.meta.dirname;

/**
 * startDir 作为「不可信 demo 子树」的判定范围。
 * 若 skill 自身就在 startDir 里面,那它是 skill/工作区根(内部调用与自测的用法),
 * 不是 demo 目录 —— 不施加子树排除,否则会把 skill 自己的依赖也排掉。
 */
function demoScope(startDir) {
  if (!startDir) return null;
  const r = real(startDir);
  return inside(r, real(SELF_DIR)) ? null : r;
}

/**
 * demo 的产品仓根——仅当它是 demo 目录的**严格祖先**时才算可信根。
 * demo 自己就是一个 git 仓时(toplevel === demoDir)一律不采用:那等于把
 * 不可信目录重新塞回解析候选。
 */
function trustedRepoRoot(demoDir) {
  const root = findGitRepoRoot(demoDir);
  if (!root) return null;
  const rootReal = real(root);
  const demoReal = real(demoDir);
  return rootReal !== demoReal && inside(rootReal, demoReal) ? root : null;
}

/* ── 解析候选只许放**不受 demo 目录内容左右**的根(r5 P0-2 CRITICAL) ──
   r4 之前 candidateDirs 把 startDir(= demoDir)排在最前,还兜了 process.cwd() 与
   INIT_CWD。requireFrom 从这些目录找 package.json,loadPlaywrightApi 随后 await import()
   解析出来的路径 —— CJS 顶层代码在 import 时同步执行。于是
   `<demo>/node_modules/playwright/index.js` 里写 execSync 就是 verify 进程内的 RCE,
   而且因为 demoDir 排候选第一,它还**优先于**机器上真实的 Playwright。
   node_modules 既不入哈希链、也不在 checkDemoBuilderIntegrity 的具名文件表里。
   与 component-build-core 的 resolveFrom('esbuild', [QA_HIFI_MODULE_ROOT, repoRoot])
   同一模式:env 显式给定的根、git toplevel 得到的产品仓根、skill 自身位置,仅此三类。 */
function candidateDirs(startDir) {
  const demoReal = demoScope(startDir);
  const roots = [
    process.env.QA_HIFI_MODULE_ROOT,
    process.env.PLAYWRIGHT_MODULE_ROOT,
    startDir ? trustedRepoRoot(startDir) : null,
    import.meta.dirname,
  ].filter(Boolean);
  const out = [];
  const seen = new Set();
  const add = (dir) => {
    const abs = resolve(dir);
    // 任何落在 demo 子树里的候选一律不加(env 被指到 demo 里也不行)
    if (demoReal && inside(demoReal, real(abs))) return;
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  };
  for (const root of roots) {
    add(root);
    const packageRoot = findPackageRoot(root);
    if (packageRoot) add(packageRoot);
    for (const sibling of workspaceSiblingRoots(root)) add(sibling);
  }
  return out;
}

export function resolveModule(name, startDir = null) {
  const demoReal = demoScope(startDir);
  // 兜底纵深:即使某个可信根经 symlink 绕回 demo 子树,解析结果也一律拒收
  const guard = (modPath) => {
    if (demoReal && inside(demoReal, real(modPath)))
      throw new Error(
        `拒绝加载 ${name}:解析到了 demo 目录内的模块(${modPath})。`
        + '\ndemo 自身不装依赖——demo 侧的 node_modules 是把不可信代码送进校验进程的侧路。',
      );
    return modPath;
  };
  const attempts = [];
  for (const dir of candidateDirs(startDir)) {
    let resolved;
    try {
      resolved = requireFrom(dir).resolve(name);
    } catch (err) {
      attempts.push(`${dir}: ${err.message}`);
      continue;
    }
    return guard(resolved);
  }
  const ownReq = createRequire(import.meta.url);
  try {
    return guard(ownReq.resolve(name));
  } catch (err) {
    attempts.push(err.message);
  }
  const e = new Error(`无法解析模块 ${name}\n${attempts.join('\n')}`);
  e.attempts = attempts;
  throw e;
}

export async function loadPlaywrightApi(startDir = null) {
  let modPath;
  let mod;
  try {
    modPath = resolveModule('playwright', startDir);
    mod = await import(modPath);
  } catch {
    modPath = resolveModule('playwright-core', startDir);
    mod = await import(modPath);
  }
  const api = mod.chromium ? mod : (mod.default ?? mod);
  return { api, modulePath: modPath };
}

export async function loadChromium(startDir = null) {
  const { api, modulePath: modPath } = await loadPlaywrightApi(startDir);
  const chromium = api.chromium;
  if (!chromium) throw new Error(`模块 ${modPath} 未导出 chromium`);
  let executablePath = null;
  try {
    const candidate = chromium.executablePath?.();
    if (candidate && existsSync(candidate)) executablePath = candidate;
  } catch {}
  if (!executablePath) executablePath = CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
  if (!executablePath) {
    throw new Error(
      '找不到可用 Chromium/Chrome。请安装 Playwright 浏览器(npx playwright install chromium),或设置 CHROME_PATH 指向本机 Chrome。',
    );
  }
  return { chromium, executablePath, modulePath: modPath };
}

export async function launchChromium(startDir, options = {}) {
  const { chromium, executablePath, modulePath } = await loadChromium(startDir);
  const browser = await chromium.launch({ executablePath, ...options });
  return { browser, executablePath, modulePath };
}
