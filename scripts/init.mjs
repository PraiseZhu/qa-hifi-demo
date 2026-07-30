#!/usr/bin/env node
// init.mjs — 新 demo 脚手架:一条命令生成四件套骨架,demo 起步不再从空白页手搓。
//
//   node init.mjs --dir <demo-dir> --name <name> [--pr <n>]
//   node init.mjs --dir <demo-dir> --name <name> --mode component --entry <组件入口(相对 repoRoot)>
//   node init.mjs --dir <demo-dir> --update-chrome    # 只把 index.html 里的 chrome 换成当前模板版
//   node init.mjs --dir <demo-dir> --update-adapter   # 同上,换组件模式 adapter 标记段
//
// 生成(经典模式,手写 HTML 复刻界面):
//   spec.json           最小合法骨架(matrix/states/verify;作者按功能填实)
//   extract.mjs         用 extract-helpers 的提取器样板(repoRoot 走 git,禁目录深度)
//   extract-helpers.mjs 从 skill lib 拷贝(demo 自包含,随 PR 入产品仓,不依赖 skill 安装位置)
//   index.html          demo-shell 模板 + 内联标准 qa-chrome 运行时(__qa 合约的唯一标准实现)
//
// 额外生成(--mode component,真组件直渲;界面不手写,esbuild 打真实产品组件):
//   spec.json           多一个 component 段(entry/shims/packageRoots/themeVars/fixtures/driver)
//   build.mjs           组件构建器(esbuild bundle + 图片落 assets/ + 可选 tailwind CSS)
//   src/bootstrap.tsx   装配入口:import 真组件,经 window.__qaDemo.inject(driver) 交给 adapter
//   shims/              替身层骨架(README 硬规 + _template.ts 空骨架)
//   index.html          组件壳:内联 adapter 标记段 + <script src="assets/component.bundle.js">
//
// 安全:已存在的文件一律拒绝覆盖(--update-chrome / --update-adapter 除外,它们只替换标记段)。

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
const updateAdapter = args.includes('--update-adapter');

const chromeJs = readFileSync(join(SKILL_ROOT, 'templates/qa-chrome.js'), 'utf8');
const adapterJs = readFileSync(join(SKILL_ROOT, 'templates/qa-component-adapter.js'), 'utf8');

/** 只替换 index.html 里某个标记段(chrome / adapter 共用一套语义)。 */
function replaceMarkedBlock(marker, code, flag) {
  const indexPath = join(dir, 'index.html');
  if (!existsSync(indexPath)) failJson(`${flag} 需要已存在的 index.html:${indexPath}`);
  const html = readFileSync(indexPath, 'utf8');
  const re = new RegExp(`(\\/\\* ${marker}_BEGIN[\\s\\S]*?\\*\\/\\n)[\\s\\S]*?(\\n\\/\\* ${marker}_END \\*\\/)`);
  if (!re.test(html)) failJson(`index.html 缺 ${marker}_BEGIN/END 标记段——不是 init.mjs 生成的结构(或不是组件模式 demo),手动升级`);
  writeFileSync(indexPath, html.replace(re, `$1${code}$2`));
  console.log(JSON.stringify({ ok: true, updated: indexPath, block: marker }));
  process.exit(0);
}

if (updateChrome) replaceMarkedBlock('QA_CHROME', chromeJs, '--update-chrome');
if (updateAdapter) replaceMarkedBlock('QA_COMPONENT_ADAPTER', adapterJs, '--update-adapter');

const name = argOf('--name');
if (!name || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) failJson('缺 --name <slug>(小写字母/数字/连字符)');
const pr = argOf('--pr');

const mode = argOf('--mode') ?? 'classic';
if (!['classic', 'component'].includes(mode)) failJson(`--mode 只能是 classic | component(当前 "${mode}")`);
const isComponent = mode === 'component';
const entry = argOf('--entry');
if (isComponent && !entry) failJson('--mode component 必须给 --entry <组件入口(相对 repoRoot 的路径)>');
if (!isComponent && entry) failJson('--entry 只在 --mode component 下有意义');

mkdirSync(dir, { recursive: true });
const files = ['spec.json', 'extract.mjs', 'extract-helpers.mjs', 'index.html'];
if (isComponent) files.push('build.mjs', 'src/bootstrap.tsx', 'shims/README.md', 'shims/_template.ts');
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
  matrix: isComponent
    ? {
        // 组件模式只覆盖桌面:RN 组件需 react-native-web,不在本方案范围(spike 结论)
        platforms: ['desktop'],
        regions: ['cn', 'global'],
        systems: ['mac', 'win'],
        themes: ['light', 'dark'],
        langs: ['zh-CN', 'en'],
      }
    : {
        platforms: ['desktop', 'mobile'],
        regions: ['cn', 'global'],
        systems: ['mac', 'win'],
        themes: ['light', 'dark'],
        langs: ['zh-CN', 'en'],
      },
  states: [{ id: 'entry', via: [{ expect: 'entry' }] }],
  verify: {
    cases: isComponent
      ? [
          { id: 'desktop-cn-light', prefs: { plat: 'desktop', region: 'cn', os: 'mac', mode: 'light', lang: 'zh-CN' }, via: [] },
          { id: 'desktop-cn-dark', prefs: { plat: 'desktop', region: 'cn', os: 'mac', mode: 'dark', lang: 'zh-CN' }, via: [] },
        ]
      : [
          { id: 'desktop-cn-light', prefs: { plat: 'desktop', region: 'cn', os: 'mac', mode: 'light', lang: 'zh-CN' }, via: [] },
          { id: 'mobile-cn-dark', prefs: { plat: 'mobile', region: 'cn', os: 'mac', mode: 'dark', lang: 'zh-CN' }, via: [], viewport: { w: 390, h: 844, dpr: 3 } },
        ],
    noClip: ['.frame'],
  },
  bindings: [],
};

// component 段:组件模式的全部构建/驱动配置(build.mjs 与 adapter 都只读这里)
if (isComponent) {
  spec.component = {
    // 真组件入口(相对 repoRoot):供人核对 + 门 A 把组件源文件 hash 计入防伪链
    entry,
    bootstrap: 'src/bootstrap.tsx',
    bundle: 'assets/component.bundle.js',
    assetsDir: 'assets',
    // '@/' 前缀 alias 的基准目录(相对 repoRoot);不用 '@/' 别名的项目留 null
    rendererRoot: 'TODO:如 apps/desktop/src/renderer(不用 @/ 别名则改成 null)',
    // monorepo workspace 包 → 源码目录(node_modules 无链接时必须显式指)
    packageRoots: {},
    // 每条替身都要写 why(理由写不出就别 shim,详见 shims/README.md)
    shims: [
      // { "spec": "@/hooks/useX", "file": "shims/useX.ts", "why": "render 期走 IPC,浏览器里无处可挂" }
    ],
    // 可选:产品 tailwind 编译(不配置则 assets/component.css 是占位空文件)
    css: null,
    // 主题桥:色值 token 由 extract.mjs 提到 truth.<truthPath>,bootstrap 运行时应用
    themeVars: { truthPath: 'themeVars' },
    // 只在服务端响应里存在的数据:如实声明为 fixture,不许塞进 truth 冒充源码真值
    fixtures: [
      // { "id": "providers", "why": "登录方式配置来自服务端,源码里没有", "shape": "ProviderConfig" }
    ],
    // driver 合约:bundle 经 window.__qaDemo.inject(driver) 交给 adapter
    driver: {
      // 只能经真实交互(via 链路)到达的状态 id——组件局部 useState 的子视图必须列这里
      viaOnlyStates: [],
    },
  };
}
writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');

// 组件模式额外的 extract TODO:主题桥色值必须从产品 token 源提取(带 provenance),
// 不许在 bootstrap 里手写色值——那等于把「手抄漂移」搬进组件模式
const THEME_VARS_TODO = `// TODO(主题桥,组件模式必做):把产品 token 源里的色值提成 truth.themeVars。
//   要求:light/dark 两份 CSS 变量串(\`--id:value;...\`),值直取产品源码(如 themes/colors.ts
//   的 registerColor 全表),并用 makeLeaf 带上 provenance;运行时由 src/bootstrap.tsx 的
//   applyTheme 复刻产品 applyTheme 语义(重写 style#theme-vars + 切 html.dark)。
//   提取数量要有下界断言(如 < 50 个 token 直接抛错),防正则改版后静默提空。
// truth.themeVars = { light: makeLeaf(lightVars, tokenSrc, { locator: 'registerColor 全表 light' }),
//                     dark:  makeLeaf(darkVars,  tokenSrc, { locator: 'registerColor 全表 dark' }) };`;

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
${isComponent ? THEME_VARS_TODO : ''}
process.stdout.write(JSON.stringify(truth));
`;
writeFileSync(join(dir, 'extract.mjs'), extractSrc);
copyFileSync(join(SKILL_ROOT, 'scripts/lib/extract-helpers.mjs'), join(dir, 'extract-helpers.mjs'));

// index.html:shell 模板 + 内联 chrome(组件模式再内联 adapter 段)
let shell = readFileSync(join(SKILL_ROOT, isComponent ? 'templates/component-shell.html' : 'templates/demo-shell.html'), 'utf8')
  .replaceAll('{{NAME}}', name)
  .replaceAll('{{PR}}', pr ? String(Number(pr)) : 'null');
if (isComponent) shell = shell.replace('{{QA_COMPONENT_ADAPTER}}', adapterJs);
shell = shell.replace('{{QA_CHROME}}', chromeJs);
writeFileSync(join(dir, 'index.html'), shell);

// 组件模式四件套:build.mjs / src/bootstrap.tsx / shims 骨架
if (isComponent) {
  copyFileSync(join(SKILL_ROOT, 'templates/component-build.mjs'), join(dir, 'build.mjs'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src/bootstrap.tsx'),
    readFileSync(join(SKILL_ROOT, 'templates/component-bootstrap.tsx'), 'utf8').replaceAll('{{NAME}}', name),
  );
  mkdirSync(join(dir, 'shims'), { recursive: true });
  copyFileSync(join(SKILL_ROOT, 'templates/component-shims-README.md'), join(dir, 'shims/README.md'));
  copyFileSync(join(SKILL_ROOT, 'templates/component-shim-template.ts'), join(dir, 'shims/_template.ts'));
}

console.log(JSON.stringify({
  ok: true,
  dir,
  ...(isComponent ? { mode } : {}), // 经典模式输出保持逐字不变(下游脚本/测试按老格式断言)
  files,
  next: isComponent
    ? [
        '0. coupling 侦察:确认组件 render 期不碰 IPC/网络/原生能力,列出必须 shim 的依赖',
        '1. 填 spec.json component 段(rendererRoot/packageRoots/shims/css),写 shims/*',
        '2. 写 src/bootstrap.tsx(import 真组件 + driver 注入),node build.mjs 出 bundle',
        '3. 写 extract.mjs(含 themeVars 主题桥),跑 truth.mjs --demo <dir> --embed',
        '4. 填 spec.states 与 index.html __qaDemo.states(两边一致),node scripts/states.mjs && verify.mjs',
      ]
    : [
        '1. 写 extract.mjs(P1 真值提取),跑 truth.mjs --demo <dir> --embed',
        '2. 填 spec.json states/verify + index.html __qaDemo 配置与 renderApp(P2)',
        '3. node scripts/states.mjs && node scripts/verify.mjs 验收(P3)',
      ],
}, null, 2));
