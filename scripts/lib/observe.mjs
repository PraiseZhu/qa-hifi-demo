// observe.mjs — 不可变观察对象(I-OBSERVE)的唯一实现处:整树快照 / 双向 manifest /
// 独立 output root / 可信脚本副本。verify.mjs 与 pixel-compare.mjs **共用这一份**。
//
// r8 条目 A(审核人可执行 PoC):r7 的快照带一张排除表(整个 `verify-artifacts/`、
// `pixel-artifacts/`、三个 report*.json),而没有任何东西禁止页面引用被排除的路径。
// PoC:`index.html` 加 `<script src="pixel-artifacts/late.js">`,该脚本把门 D 绑定的 `.box`
// 从正确的 16px 改成 99px → snapshot 里那个文件 404(门 D 在快照上量到 16px,绿),
// 交付原地却真的加载它(computed width = 99px);`snapshotDrift()` 只从快照一侧单向遍历,
// 看不见被排除目录、也看不见运行期新增 → `"none"`;`buildInputHashes` 同样不覆盖这两个目录。
// 结果:verify exit 0 / gateD.pass=true / pr-block exit 0 可出块,而**被验页面 ≠ 交付页面**。
//
// 修法不是「再加一条检查去挡引用」,而是把盲区本身消掉:
//   ① 快照 = **整树**。唯一跳过的是 `node_modules`(前置门已无条件拒,不可能存在)与 `.git`
//      (不属交付产物,部署侧同样排除)—— 二者都**不是页面可达的交付字节**,所以不构成盲区。
//   ② 工具自己的运行期输出(失败截图、可信脚本副本)一律改写到 **demo 之外的 output root**,
//      不再靠目录名排除。demo 树里因此不再有「需要豁免」的运行期写入。
//   ③ 快照 ⟷ 磁盘用**双向 manifest** 比对:disk→snapshot(新增)与 snapshot→disk(删除/改写)
//      都遍历。单向 walk 看不见新增文件,这正是 PoC 能全链自洽的一环。

import { cpSync, mkdirSync, mkdtempSync, readdirSync, lstatSync, readlinkSync, copyFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { hashFile } from './fs-utils.mjs';
import { findDemoSymlinks } from './repo-glob.mjs';

/* 快照唯一跳过的顶层目录。**不是**「豁免清单」——这两项都不是页面可达的交付字节:
   node_modules 由 checkDemoNoNodeModules 无条件拒(存在即 fail-fast,快照阶段不可能遇到),
   .git 不属于交付产物(部署侧同样排除)。除此之外 demo 树里的一切都进快照,包括上一轮遗留的
   report*.json 与 pixel-artifacts —— 它们页面可达,就必须与交付字节一致。 */
export const SNAPSHOT_SKIP_TOP = ['node_modules', '.git'];

/** rel 是否落在跳过的顶层目录里(仅顶层;嵌套同名一律进快照)。 */
export function isSkippedRel(rel) {
  const segs = String(rel).split(/[\\/]/).filter((s) => s && s !== '.');
  return segs.length > 0 && SNAPSHOT_SKIP_TOP.includes(segs[0]);
}

/** demo 验证输入的**整树**不可变快照(demo 之外的临时目录)。失败即抛 —— 拿不到不可变观察对象不许继续。 */
export function makeObservationSnapshot(demoDir, { prefix = 'qa-hifi-snapshot-' } = {}) {
  const root = resolve(demoDir);
  /* r9 P0 纵深:symlink 由前置门(fs-utils.checkDemoNoSymlinks)在**建快照之前**拒,这里再拦一次
     是为了让「任何调用方都不可能拿到一份 dereference 过的快照」成为本函数自身的不变式 ——
     dereference:true 把仓外链接目标复制成快照内的普通文件(观察侧 200),交付原地 server 却
     realpath 后判 403,观察对象由此 ≠ 交付对象。
     实测坑(Node v24.13):`cpSync` 只在**同时传了 `filter`** 时才真的按 `dereference: true` 走
     跟随分支;不传 filter 时 symlink 会被原样保留(即使 dereference:true)。本函数正好传了
     filter,所以这里的 dereference 是**真生效**的 —— P0 因此成立。复现该形态的回归测试必须
     照样带 filter,否则测不出分叉。 */
  const links = findDemoSymlinks(root, { limit: 5 });
  if (links.length)
    throw new Error(
      'demo 输入树含 symlink,拒绝建立观察快照(dereference 会把它变成快照内的普通文件,'
      + `而交付侧 realpath 判 403 —— 观察对象 ≠ 交付对象):${links.map((l) => `${l.path} -> ${l.target}`).join('、')}`,
    );
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(root, dir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const abs = resolve(src);
      if (abs === root) return true;
      return !isSkippedRel(abs.slice(root.length + 1));
    },
  });
  return dir;
}

/** 工具运行期输出的独立根(失败截图 / 可信脚本副本):在 demo 之外,页面不可能引用到。 */
export function makeOutputRoot({ prefix = 'qa-hifi-out-' } = {}) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 整树文件相对路径集合;跳过的顶层目录整棵不进遍历。
    r9:改用 **lstat**(不跟随 symlink)—— statSync 会把「指向目录的 symlink」当目录走进去、
    把「指向文件的 symlink」当普通文件收录,两种情况下条目本身的 symlink 身份都被抹掉。
    lstat 之下 symlink 一律作为叶子条目收录,类型由 entryKind() 给出。 */
export function listFilesRel(root) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(rel ? join(root, rel) : root)) {
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, childRel));
      if (st.isDirectory()) {
        if (!isSkippedRel(`${childRel}/x`)) walk(childRel);
      } else if (!isSkippedRel(childRel)) out.push(childRel);
    }
  };
  walk('');
  return out;
}

/**
 * 一条相对路径在某棵树里的**身份**(r9 P0 纵深)。
 * r8 的 manifest 只比「跟随 symlink 之后的文件 hash」,于是「快照里的普通文件」与
 * 「磁盘上指向仓外的 symlink」被判全等 —— 审核人 PoC 里 snapshotDrift 因此报 "none"。
 * symlink 现已被前置门整类拒,这里仍记录 type + linkTarget:万一将来某条路径绕过了前置检查,
 * manifest 不能继续瞎。
 * @returns {{type: 'file'|'symlink'|'dir'|'other'|'missing', linkTarget: string|null, sha256: string|null}}
 */
export function entryKind(root, rel) {
  const abs = join(root, rel);
  let st;
  try { st = lstatSync(abs); } catch { return { type: 'missing', linkTarget: null, sha256: null }; }
  if (st.isSymbolicLink()) {
    let target = null;
    try { target = readlinkSync(abs); } catch { /* 悬空链接:target 记 null,type 仍是 symlink */ }
    return { type: 'symlink', linkTarget: target, sha256: null };
  }
  if (st.isDirectory()) return { type: 'dir', linkTarget: null, sha256: null };
  if (!st.isFile()) return { type: 'other', linkTarget: null, sha256: null };
  return { type: 'file', linkTarget: null, sha256: hashFile(abs) };
}

/**
 * 快照 ⟷ 磁盘的**双向**文件 manifest 比对。
 * 返回 { added, removed, changed, all }(all = 人可读的合并列表)。
 * 单向 walk(r7)只能发现 removed/changed;`added` 这一整类(验收期间新增页面可达文件)
 * 看不见 —— 而「加一个 late.js 进来」正是 PoC 的手法。
 */
export function snapshotManifestDiff(snapshotDir, demoDir) {
  const snap = listFilesRel(snapshotDir);
  const disk = new Set(listFilesRel(demoDir));
  const removed = [];
  const changed = [];
  /** 类型/链接目标不一致(r9):与「字节被改写」分开报,因为它说的是另一件事 ——
      同一路径在两棵树里连**身份**都不同(一边普通文件、一边 symlink),这正是 dereference
      造出「观察对象 ≠ 交付对象」时的形态,而按 hash 比对完全看不出来。 */
  const retyped = [];
  for (const rel of snap) {
    if (!disk.has(rel)) { removed.push(rel); continue; }
    const a = entryKind(snapshotDir, rel);
    const b = entryKind(demoDir, rel);
    if (a.type !== b.type || a.linkTarget !== b.linkTarget) {
      retyped.push({ path: rel, snapshot: a.type, disk: b.type, snapshotTarget: a.linkTarget, diskTarget: b.linkTarget });
      continue;                       // 身份都不同,再比 hash 无意义(且对 symlink 会跟随)
    }
    if (a.type === 'file' && a.sha256 !== b.sha256) changed.push(rel);
  }
  const snapSet = new Set(snap);
  const added = [...disk].filter((rel) => !snapSet.has(rel)).sort();
  const all = [
    ...added.map((r) => `${r}(验收期间新增)`),
    ...removed.map((r) => `${r}(验收期间被删除)`),
    ...changed.map((r) => `${r}(字节被改写)`),
    ...retyped.map((r) => `${r.path}(条目类型不一致:快照=${r.snapshot}${r.snapshotTarget ? `->${r.snapshotTarget}` : ''}`
      + `,磁盘=${r.disk}${r.diskTarget ? `->${r.diskTarget}` : ''})`),
  ];
  return { added, removed, changed, retyped, all };
}

/**
 * r8 条目 C:把**已 hash 的那份字节**复制到 output root 后执行副本,而不是 hash 完再按同一路径
 * spawn。后者中间存在窄 check/use 竞态:hash 与 spawn 之间同步的外部写入者可以换掉文件,
 * 于是「精确 hash 的字节被执行」这句话不成立。返回 { sha256, exec } —— exec 是要执行的副本路径。
 * 副本住在 demo 之外,被审方的后置脚本改不到它。
 */
export function trustedScriptCopy(scriptAbs, outputRoot, { subdir = 'trusted-scripts' } = {}) {
  if (!existsSync(scriptAbs)) return { sha256: null, exec: scriptAbs };
  const sha = hashFile(scriptAbs);
  const dir = join(outputRoot, subdir);
  mkdirSync(dir, { recursive: true });
  const exec = join(dir, `${sha.slice(0, 12)}-${basename(scriptAbs)}`);
  copyFileSync(scriptAbs, exec);
  /* 复制后再算一次副本的 hash:确认「我们要执行的这份字节」确实等于「我们声称 hash 过的那份」。
     源文件在 hash 与 copy 之间被换掉时,这里会不等 → 返回 mismatch,调用方 fail-closed。 */
  const copySha = hashFile(exec);
  return { sha256: sha, exec, copySha256: copySha, mismatch: copySha !== sha };
}
