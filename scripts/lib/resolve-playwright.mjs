import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findPackageRoot } from './fs-utils.mjs';

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

function candidateDirs(startDir) {
  const roots = [
    process.env.QA_HIFI_MODULE_ROOT,
    process.env.PLAYWRIGHT_MODULE_ROOT,
    process.env.INIT_CWD,
    startDir,
    process.cwd(),
    import.meta.dirname,
  ].filter(Boolean);
  const out = [];
  const seen = new Set();
  const add = (dir) => {
    const abs = resolve(dir);
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

export function resolveModule(name, startDir = process.cwd()) {
  const attempts = [];
  for (const dir of candidateDirs(startDir)) {
    try {
      const req = requireFrom(dir);
      return req.resolve(name);
    } catch (err) {
      attempts.push(`${dir}: ${err.message}`);
    }
  }
  const ownReq = createRequire(import.meta.url);
  try {
    return ownReq.resolve(name);
  } catch (err) {
    attempts.push(err.message);
  }
  const e = new Error(`无法解析模块 ${name}\n${attempts.join('\n')}`);
  e.attempts = attempts;
  throw e;
}

export async function loadChromium(startDir = process.cwd()) {
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
