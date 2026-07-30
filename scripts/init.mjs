#!/usr/bin/env node
// init.mjs — 新 demo 脚手架:一条命令生成四件套骨架,demo 起步不再从空白页手搓。
//
//   node init.mjs --dir <demo-dir> --name <name> [--pr <n>]
//   node init.mjs --dir <demo-dir> --update-chrome   # 只把 index.html 里的 chrome 换成当前模板版
//
// 生成:
//   spec.json           最小合法骨架(matrix/states/verify;作者按功能填实)
//   extract.mjs         用 extract-helpers 的提取器样板(repoRoot 走 git,禁目录深度)
//   extract-helpers.mjs 从 skill lib 拷贝(demo 自包含,随 PR 入产品仓,不依赖 skill 安装位置)
//   index.html          demo-shell 模板 + 内联标准 qa-chrome 运行时(__qa 合约的唯一标准实现)
//
// 安全:已存在的文件一律拒绝覆盖(--update-chrome 除外,它只替换 chrome 标记段)。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failJson } from './lib/fs-utils.mjs';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const dir = argOf('--dir') ? resolve(argOf('--dir')) : null;
if (!dir) failJson('缺 --dir <demo-dir>');
const updateChrome = args.includes('--update-chrome');

const chromeJs = readFileSync(join(SKILL_ROOT, 'templates/qa-chrome.js'), 'utf8');

if (updateChrome) {
  const indexPath = join(dir, 'index.html');
  if (!existsSync(indexPath)) failJson(`--update-chrome 需要已存在的 index.html:${indexPath}`);
  const html = readFileSync(indexPath, 'utf8');
  const re = /(\/\* QA_CHROME_BEGIN[\s\S]*?\*\/\n)[\s\S]*?(\n\/\* QA_CHROME_END \*\/)/;
  if (!re.test(html)) failJson('index.html 缺 QA_CHROME_BEGIN/END 标记段——不是 init.mjs 生成的结构,手动升级');
  writeFileSync(indexPath, html.replace(re, `$1${chromeJs}$2`));
  console.log(JSON.stringify({ ok: true, updated: indexPath }));
  process.exit(0);
}

const name = argOf('--name');
if (!name || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) failJson('缺 --name <slug>(小写字母/数字/连字符)');
const pr = argOf('--pr');

mkdirSync(dir, { recursive: true });
const files = ['spec.json', 'extract.mjs', 'extract-helpers.mjs', 'index.html'];
const clash = files.filter((f) => existsSync(join(dir, f)));
if (clash.length) failJson(`拒绝覆盖已存在文件:${clash.join(', ')}(init 只用于全新 demo)`);

// spec.json 骨架:与 demo-shell 的 __qaDemo 配置对齐(entry 状态 + 全维 matrix)
const spec = {
  meta: {
    name,
    ...(pr ? { pr: Number(pr) } : {}),
    summary: {
      what: 'TODO:做了什么(≤2 行)',
      how: 'TODO:怎么做的(≤2 行)',
      accept: 'TODO:怎么验收(≤2 行)',
    },
  },
  matrix: {
    platforms: ['desktop', 'mobile'],
    regions: ['cn', 'global'],
    systems: ['mac', 'win'],
    themes: ['light', 'dark'],
    langs: ['zh-CN', 'en'],
  },
  states: [{ id: 'entry', via: [{ expect: 'entry' }] }],
  verify: {
    cases: [
      { id: 'desktop-cn-light', prefs: { plat: 'desktop', region: 'cn', os: 'mac', mode: 'light', lang: 'zh-CN' }, via: [] },
      { id: 'mobile-cn-dark', prefs: { plat: 'mobile', region: 'cn', os: 'mac', mode: 'dark', lang: 'zh-CN' }, via: [], viewport: { w: 390, h: 844, dpr: 3 } },
    ],
    noClip: ['.frame'],
  },
  bindings: [],
};
writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');

// extract.mjs 样板:repoRoot 走 git(2026-07-29 三连 bug 的固化修正),provenance 走工厂
const extractSrc = `#!/usr/bin/env node
// extract.mjs — ${name} 真值提取器(P1)。stdout 输出 truth JSON,只准由产品源码算出。
//
// 规则:
//   1. repoRoot 用 findRepoRoot()(git 定位)——禁止 '../../..' 数目录层级,demo 搬家会断;
//   2. 每个叶子用 makeLeaf()/extractByPattern() 构造,provenance 自动带 source+hash;
//   3. 预期会被用户改的参数写 locatorPattern(恰一个捕获组),writeback 才能机械写回。
import { findRepoRoot, makeLeaf, extractByPattern, readJson, importTsModule } from './extract-helpers.mjs';
import { join } from 'node:path';

const repoRoot = findRepoRoot();

// TODO:从产品源码提取真值。示例:
// const layout = join(repoRoot, 'apps/desktop/src/renderer/loginSkinLayout.ts');
// const truth = {
//   geometry: {
//     panelWidth: extractByPattern(layout, 'panelWidth:\\\\s*(\\\\d+)', { locator: 'panelWidth 常量' }),
//   },
//   copy: {
//     title: makeLeaf(readJson(join(repoRoot, 'i18n/zh-CN/common.json')).login.title,
//       join(repoRoot, 'i18n/zh-CN/common.json'), { locator: 'login.title' }),
//   },
// };
const truth = {};

process.stdout.write(JSON.stringify(truth));
`;
writeFileSync(join(dir, 'extract.mjs'), extractSrc);
copyFileSync(join(SKILL_ROOT, 'scripts/lib/extract-helpers.mjs'), join(dir, 'extract-helpers.mjs'));

// index.html:shell 模板 + 内联 chrome
const shell = readFileSync(join(SKILL_ROOT, 'templates/demo-shell.html'), 'utf8')
  .replaceAll('{{NAME}}', name)
  .replaceAll('{{PR}}', pr ? String(Number(pr)) : 'null')
  .replace('{{QA_CHROME}}', chromeJs);
writeFileSync(join(dir, 'index.html'), shell);

console.log(JSON.stringify({
  ok: true,
  dir,
  files,
  next: [
    '1. 写 extract.mjs(P1 真值提取),跑 truth.mjs --demo <dir> --embed',
    '2. 填 spec.json states/verify + index.html __qaDemo 配置与 renderApp(P2)',
    '3. node scripts/states.mjs && node scripts/verify.mjs 验收(P3)',
  ],
}, null, 2));
