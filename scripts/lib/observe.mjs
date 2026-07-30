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

import { cpSync, mkdirSync, mkdtempSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { hashFile } from './fs-utils.mjs';

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

/** 整树文件相对路径集合;跳过的顶层目录整棵不进遍历。 */
export function listFilesRel(root) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(rel ? join(root, rel) : root)) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (statSync(join(root, childRel)).isDirectory()) {
        if (!isSkippedRel(`${childRel}/x`)) walk(childRel);
      } else if (!isSkippedRel(childRel)) out.push(childRel);
    }
  };
  walk('');
  return out;
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
  for (const rel of snap) {
    if (!disk.has(rel)) { removed.push(rel); continue; }
    if (hashFile(join(snapshotDir, rel)) !== hashFile(join(demoDir, rel))) changed.push(rel);
  }
  const snapSet = new Set(snap);
  const added = [...disk].filter((rel) => !snapSet.has(rel)).sort();
  const all = [
    ...added.map((r) => `${r}(验收期间新增)`),
    ...removed.map((r) => `${r}(验收期间被删除)`),
    ...changed.map((r) => `${r}(字节被改写)`),
  ];
  return { added, removed, changed, all };
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
