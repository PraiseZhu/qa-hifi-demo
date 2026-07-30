// extract-helpers.mjs — extract.mjs 作者的共享工具函数。
//
// 诞生背景(2026-07-29 login-all-hifi 事故):每个 demo 的 extract.mjs 手写 repoRoot
// 定位(`../../..` 数目录层级),demo 从 _tmp/ 迁到 docs/design-previews/ 后路径全断,
// 一天连修 3 个 bug(repoRoot 深度、provenance 前缀、truth 相对路径)。本库把这些
// 「每个 demo 都要做且都做错过」的事收敛为一次实现:
//   - findRepoRoot():git 定位仓库根,与目录深度彻底解耦——demo 随便搬家;
//   - makeLeaf():provenance 工厂,source 相对路径 / hash / locatorPattern 一次做对;
//   - importTsModule():esbuild 临时编译 TS 纯函数后 import(门 F oracle 用产品公式本身)。
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
 * @param opts.locatorPattern 可选:恰含一个捕获组的正则(writeback 机械写回的锚)
 * @param opts.demoDir 默认 process.cwd()(truth.mjs 保证 = demo 目录)
 */
export function makeLeaf(value, sourceFile, { locator, locatorPattern, demoDir = process.cwd() } = {}) {
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
  const provenance = { source: relative(demoDir, abs), locator, hash: sha256File(abs) };
  if (locatorPattern !== undefined) provenance.locatorPattern = locatorPattern;
  return { value, provenance };
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

function resolveFrom(name, startDirs) {
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
