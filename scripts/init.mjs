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
//   spec.json           多一个 component 段(mode/entry/shims/packageRoots/themeVars/fixtures)
//   component.inputs.json  由 build.mjs 生成(esbuild metafile 规范化输入清单,防伪链真相源)
//   build.mjs           组件构建器(esbuild bundle + 图片落 assets/ + 可选 tailwind CSS)
//   src/bootstrap.tsx   装配入口:import 真组件,Object.assign(window.__qaDemo, {states,mount,inject,onPrefs})
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

/* 内联进 <script> 的代码里出现裸的 `</script` 会被 HTML 分词器提前截断脚本
   (2026-07-30 集成实测:adapter 头注释里的一处结束标签让整段 adapter 报
   SyntaxError,页面只剩 chrome 抛「renderApp 必填」)。统一在内联时转义。 */
const inlineSafe = (code) => code.replaceAll('</script', '<\\/script');
const chromeJs = inlineSafe(readFileSync(join(SKILL_ROOT, 'templates/qa-chrome.js'), 'utf8'));
const adapterJs = inlineSafe(readFileSync(join(SKILL_ROOT, 'templates/qa-component-adapter.js'), 'utf8'));

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
// 目标组件导出名(可选):不给就在 spec 里留 TODO,作者填完才可能拿到「真组件直渲」结论
const entryExport = argOf('--entry-export');
if (!isComponent && entryExport) failJson('--entry-export 只在 --mode component 下有意义');

mkdirSync(dir, { recursive: true });
const files = ['spec.json', 'extract.mjs', 'extract-helpers.mjs', 'index.html'];
if (isComponent) files.push('build.mjs', 'component-build-core.mjs', 'repo-glob.mjs', 'src/bootstrap.tsx', 'shims/README.md', 'shims/_template.ts');
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
          { id: 'desktop-cn-light', prefs: { plat: 'desktop', region: 'cn', os: 'mac', mode: 'light', lang: 'zh-CN' } },
          { id: 'desktop-cn-dark', prefs: { plat: 'desktop', region: 'cn', os: 'mac', mode: 'dark', lang: 'zh-CN' } },
        ]
      : [
          { id: 'desktop-cn-light', prefs: { plat: 'desktop', region: 'cn', os: 'mac', mode: 'light', lang: 'zh-CN' } },
          { id: 'mobile-cn-dark', prefs: { plat: 'mobile', region: 'cn', os: 'mac', mode: 'dark', lang: 'zh-CN' }, viewport: { w: 390, h: 844, dpr: 3 } },
        ],
    noClip: ['.frame'],
  },
  bindings: [],
};

// component 段:组件模式的全部构建/驱动配置(build.mjs 与 adapter 都只读这里)
if (isComponent) {
  spec.component = {
    // 组件模式标记(schema 硬校验;adapter 也校验 __qaDemo.mode)
    mode: 'component',
    // 真组件入口(相对 repoRoot):必须是 bootstrap 真正 import 渲染的那个组件——
    // build.mjs 会用 esbuild metafile 核对,它不在 bundle 真实输入里就直接构建失败。
    entry,
    // 目标组件导出名:运行期哨兵只给这个导出算「被渲染」,是拿到 PR 结论「真组件直渲」
    // 的**唯一**途径(默认导出写 "default")。不声明 → 结论一律降级为「需人工审查」;
    // 声明了但 entry 里没这个导出 → build.mjs 直接 exit 2(错误声明不许静默降级)。
    // (只有 --entry-export 给了才写这一行:塞占位值会让 build 直接 exit 2)
    ...(entryExport ? { export: entryExport } : {}),
    // 可选的人读声明(相对 repoRoot 的路径/glob)。**代码层防伪链不看这里**:
    // 真相源是 build.mjs 落下的 component.inputs.json(bundle 真实输入逐文件 sha256)。
    // 写了就必须 ⊆ 真实输入,否则 report fail-closed 拒绝出块。默认留空即可。
    sources: [],
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
    // 主题桥:色值 token 由 extract.mjs 提到 truth.<truthPath>,adapter 运行时应用
    // (adapter 当前固定读 truth.themeVars,改这里的 truthPath 也要同步 adapter)
    themeVars: { truthPath: 'themeVars' },
    // 只在服务端响应里存在的数据:如实声明为 fixture,不许塞进 truth 冒充源码真值
    fixtures: [
      // { "id": "providers", "why": "登录方式配置来自服务端,源码里没有", "shape": "ProviderConfig" }
    ],
  };
  // 状态怎么被驱动:写在 states[].driver('inject' = adapter 调 __qaDemo.inject(id) 直达;
  // 'via' = 组件局部 useState,只能真实交互到达)。组件模式默认给 entry 标 inject。
  spec.states = [{ id: 'entry', driver: 'inject', via: [{ expect: 'entry' }] }];
}
writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');

// 组件模式额外的 extract TODO:主题桥色值必须从产品 token 源提取(带 provenance),
// 不许在 bootstrap 里手写色值——那等于把「手抄漂移」搬进组件模式
const THEME_VARS_TODO = `// TODO(主题桥,组件模式必做):把产品 token 源里的色值提成 truth.themeVars。
//   用 extractThemeVars()——它逐个 token 产出带 provenance 的叶子(token 优先形状
//   { '<token>': { light: <leaf>, dark: <leaf> } }),正是 adapter 认的形状之一;
//   不要手写色值,也不要自己拼 CSS 变量串(串起来就没有逐 token provenance 了)。
//   运行时由内联 adapter 复刻产品 applyTheme 语义(重写 style#theme-vars + 切 html.dark),
//   bootstrap 不碰主题。
//   提取数量要有下界断言(如 < 50 个 token 直接抛错),防正则改版后静默提空。
// const themeVars = extractThemeVars(join(repoRoot, '<产品 colors.ts>'), { prefix: undefined });
// if (Object.keys(themeVars).length < 50) throw new Error('themeVars 提取异常(< 50 token)');
// truth.themeVars = themeVars;`;

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
  // build.mjs 是薄壳,构建规范正本在 component-build-core.mjs;两份都必须与 skill
  // canonical 逐字节一致(门 A 会 hash 比对,改写即 fail-closed「自定义构建器」)
  copyFileSync(join(SKILL_ROOT, 'templates/component-build.mjs'), join(dir, 'build.mjs'));
  copyFileSync(join(SKILL_ROOT, 'scripts/lib/component-build-core.mjs'), join(dir, 'component-build-core.mjs'));
  // 构建核心 import 的仓内 glob 实现(tailwind content 展开用)
  copyFileSync(join(SKILL_ROOT, 'scripts/lib/repo-glob.mjs'), join(dir, 'repo-glob.mjs'));
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
        '1. 填 spec.json component 段(rendererRoot/packageRoots/shims/css),写 shims/*(sources 可留空)',
        '1.5 填 spec.json component.export = 目标组件导出名(默认导出写 "default")——不填的话 PR 附贴块'
        + '拿不到「真组件直渲」结论,只会写「已打包,是否为 UI 组件需人工审查」;填错(entry 里没这个导出)build 直接 exit 2',
        '2. 写 src/bootstrap.tsx(import 真组件,Object.assign 出 states/mount/inject),node build.mjs 出 bundle',
        '3. 写 extract.mjs(含 extractThemeVars 主题桥),跑 truth.mjs --demo <dir> --embed',
        '4. spec.states[].driver 与 bootstrap 的 __qaDemo.states 键集一致,node scripts/states.mjs && verify.mjs',
      ]
    : [
        '1. 写 extract.mjs(P1 真值提取),跑 truth.mjs --demo <dir> --embed',
        '2. 填 spec.json states/verify + index.html __qaDemo 配置与 renderApp(P2)',
        '3. node scripts/states.mjs && node scripts/verify.mjs 验收(P3)',
      ],
}, null, 2));
