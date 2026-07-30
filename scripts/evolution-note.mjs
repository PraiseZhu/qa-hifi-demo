#!/usr/bin/env node
// evolution-note.mjs — qa-hifi-demo 自进化台账的唯一读写通道(对应 SKILL P7 节)。
// 设计对齐 review-pr skill 的同名机制(fingerprint 去重 / tier 三档 / md 再生成 / 自动回推)。
//
// 台账是 Skill 知识的一部分,随 Skill 仓库走:
//   - <SKILL_ROOT>/evolution/ledger.json :结构化台账(唯一事实源,只经本脚本读写);
//   - <SKILL_ROOT>/EVOLUTION.md          :由 ledger 全量再生成的人类可读视图(手改会被覆盖)。
//
// 条目按 fingerprint(根因 slug)去重:同一根因再次出现只自增 occurrences 和 lastSeen——
// 主 agent 拿到 isNew=false 就不必再花 token 重新分析同一件事。
//
// tier 三档(qa-hifi 语义):
//   - by-design :设计上就该人来的(像素 WARN 人工裁决、产品口径拍板、真沙盒采集授权),只计数;
//   - proposal  :**任何放宽验收口径的改动**——提高容差/阈值、跳过某道门、扩 URL 白名单、
//                 弱化 partial 拒收……一律等维护者拍板,永不自动落地;
//   - auto      :不放宽口径的工具缺口/文档缺口修复,可当轮直接改 Skill 落地(带 --commit 记 landed)。
//
// 子命令:
//   add        --fingerprint <slug> --tier <by-design|proposal|auto> --title "…"
//              [--detail "…"] [--proposal "…"] [--commit <sha>] [--no-sync]
//   set-status --fingerprint <slug> --status <open|landed|adopted|rejected|tracked> [--note "…"] [--no-sync]
//   list
//
// 自动回推:add / set-status 写盘后把 ledger.json + EVOLUTION.md 提交并推送本仓 main
// (只 add 台账两个文件,不裹挟其他改动)。同步 best-effort:失败不影响台账写入,结果在
// 输出 sync 字段;--no-sync 跳过(测试/本地调试用)。
//
// 纪律:台账正文不写 token、凭证、内部绝对路径或敏感命中原文;PR 只写号码。
// 测试隔离:环境变量 QA_HIFI_SKILL_ROOT 可重定向台账根目录(测试写临时目录,不污染真台账)。

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = process.env.QA_HIFI_SKILL_ROOT
  ? resolve(process.env.QA_HIFI_SKILL_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_DIR = join(SKILL_ROOT, 'evolution');
const LEDGER_FILE = join(LEDGER_DIR, 'ledger.json');
const MD_FILE = join(SKILL_ROOT, 'EVOLUTION.md');

const FINGERPRINT_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TIERS = ['by-design', 'proposal', 'auto'];
const STATUSES = ['open', 'landed', 'adopted', 'rejected', 'tracked'];

const print = (obj) => console.log(JSON.stringify(obj, null, 2));
const fail = (e) => {
  console.error(String(e?.message || e));
  process.exit(1);
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
}

function readLedger() {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] }; // 不存在/损坏按空台账起步
  }
}

function writeLedger(ledger) {
  mkdirSync(LEDGER_DIR, { recursive: true });
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2) + '\n');
  writeFileSync(MD_FILE, renderMd(ledger));
}

/** 台账写盘后的自动提交推送(--no-sync 跳过)。只 add 台账两个文件,绝不裹挟其他改动。 */
function syncLedger(message) {
  if (process.argv.includes('--no-sync')) return { skipped: 'no-sync' };
  const git = (a) => execFileSync('git', ['-C', SKILL_ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['rev-parse', '--is-inside-work-tree']);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (branch !== 'main' && branch !== 'master') return { ok: false, reason: `非 main 分支:${branch},不自动推送` };
    git(['add', '--', 'evolution/ledger.json', 'EVOLUTION.md']);
    const status = git(['status', '--porcelain', '--', 'evolution/ledger.json', 'EVOLUTION.md']).trim();
    if (!status) return { ok: true, skipped: 'no-change' };
    git(['commit', '-m', message, '--', 'evolution/ledger.json', 'EVOLUTION.md']);
    try {
      git(['push', 'origin', branch]);
      return { ok: true, committed: true, pushed: true };
    } catch (e) {
      return { ok: true, committed: true, pushed: false, pushError: String(e?.stderr || e?.message || e).slice(0, 200) };
    }
  } catch (e) {
    return { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 300) };
  }
}

const fmtDate = (iso) => (iso ?? '').slice(0, 10);

function renderMd(ledger) {
  const groups = [
    ['proposal', '## 待维护者拍板(放宽验收口径类提案,永不自动落地)', (e) => e.status !== 'rejected'],
    ['auto', '## 已自动落地(工具/文档缺口修复,不放宽口径)', () => true],
    ['by-design', '## 无法自动化(by-design,只计数观察)', () => true],
  ];
  const rejected = ledger.entries.filter((e) => e.tier === 'proposal' && e.status === 'rejected');
  let md = '# qa-hifi-demo 自进化台账\n\n';
  md += '自动生成:由 `scripts/evolution-note.mjs` 从 `evolution/ledger.json` 再生成,**手改本文件会被覆盖**。\n';
  md += '条目按根因 fingerprint 去重;分类与落地规则见 SKILL.md「P7 自进化复盘」。\n';
  md += '外部使用者欢迎把自己的台账条目以 PR 形式回流(只动 `evolution/ledger.json`,经脚本 add 生成)。\n';
  for (const [tier, heading, keep] of groups) {
    const entries = ledger.entries.filter((e) => e.tier === tier && keep(e));
    if (!entries.length) continue;
    md += `\n${heading}\n\n`;
    for (const e of entries.slice().sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))) {
      md += `- \`${e.fingerprint}\` **${e.title}** — 出现 ${e.occurrences} 次,首见 ${fmtDate(e.firstSeen)},最近 ${fmtDate(e.lastSeen)},status: ${e.status}${e.commit ? `,commit \`${e.commit}\`` : ''}\n`;
      if (e.detail) md += `  - 现象:${e.detail}\n`;
      if (e.proposal) md += `  - 提案:${e.proposal}\n`;
      if (e.note) md += `  - 备注:${e.note}\n`;
    }
  }
  if (rejected.length) {
    md += '\n## 已否决的提案(留档防止重复提出)\n\n';
    for (const e of rejected) {
      md += `- \`${e.fingerprint}\` ${e.title}${e.note ? ` — ${e.note}` : ''}\n`;
    }
  }
  return md;
}

try {
  const cmd = process.argv[2];
  const ledger = readLedger();

  if (cmd === 'list') {
    print({ ok: true, ledgerFile: LEDGER_FILE, mdFile: MD_FILE, count: ledger.entries.length, entries: ledger.entries });
    process.exit(0);
  }

  const fingerprint = arg('fingerprint');
  if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
    throw new Error('缺少或不合法的 --fingerprint(根因 slug:小写字母/数字/连字符,3-64 位,如 repo-root-depth-assumption)');
  }

  if (cmd === 'add') {
    const tier = arg('tier');
    const title = arg('title');
    if (!TIERS.includes(tier)) throw new Error(`--tier 必须是 ${TIERS.join('|')}`);
    if (!title) throw new Error('缺少 --title(一句话根因)');
    const detail = arg('detail');
    const proposal = arg('proposal');
    const commit = arg('commit');
    const now = new Date().toISOString();

    let entry = ledger.entries.find((e) => e.fingerprint === fingerprint);
    const isNew = !entry;
    if (isNew) {
      entry = {
        fingerprint,
        tier,
        title,
        detail: detail ?? null,
        proposal: proposal ?? null,
        status: tier === 'auto' ? (commit ? 'landed' : 'open') : tier === 'proposal' ? 'open' : 'tracked',
        commit: commit ?? null,
        note: null,
        occurrences: 1,
        firstSeen: now,
        lastSeen: now,
      };
      ledger.entries.push(entry);
    } else {
      entry.occurrences += 1;
      entry.lastSeen = now;
      // 复现时允许补充/修正信息,但不允许悄悄降级安全档:proposal 一旦是 proposal 永远是 proposal
      if (detail) entry.detail = detail;
      if (proposal) entry.proposal = proposal;
      if (commit) { entry.commit = commit; if (entry.tier === 'auto') entry.status = 'landed'; }
      if (tier && tier !== entry.tier && entry.tier !== 'proposal') entry.tier = tier;
    }
    writeLedger(ledger);
    const sync = syncLedger(`evo: ledger ${fingerprint}`);
    print({ ok: true, isNew, entry, sync, ledgerFile: LEDGER_FILE, mdFile: MD_FILE, note: isNew ? '新根因:在收尾摘要「自进化」组里向用户报告' : '已知根因(去重命中):只自增计数,不必重复分析与报告' });
    process.exit(0);
  }

  if (cmd === 'set-status') {
    const status = arg('status');
    if (!STATUSES.includes(status)) throw new Error(`--status 必须是 ${STATUSES.join('|')}`);
    const entry = ledger.entries.find((e) => e.fingerprint === fingerprint);
    if (!entry) throw new Error(`台账中没有 fingerprint=${fingerprint} 的条目`);
    entry.status = status;
    const note = arg('note');
    if (note) entry.note = note;
    writeLedger(ledger);
    const sync = syncLedger(`evo: ledger ${fingerprint} status=${status}`);
    print({ ok: true, entry, sync, ledgerFile: LEDGER_FILE, mdFile: MD_FILE });
    process.exit(0);
  }

  throw new Error('用法:evolution-note.mjs <add|set-status|list> …(见文件头注释)');
} catch (e) {
  fail(e);
}
