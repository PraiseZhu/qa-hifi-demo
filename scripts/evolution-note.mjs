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
// 两层台账(r14 起):
//   - case 层:用户在对话里 case by case 指出的每个具体问题,**原样记录、不去重、当场记**。
//     落 <SKILL_ROOT>/evolution/cases/<YYYY-MM-DD>-<session>.md,**本地私有、不入公开仓**
//     (.gitignore 挡住)——case 正文常含未发布产品细节(文案/间距/状态),不得暴露公网。
//   - 根因层:从 case 归纳出的可复用根因,即下面的 ledger.json + EVOLUTION.md,入公开仓。
//   为什么要两层:收尾批量复盘会把对话中间的具体 case 压缩掉(十三轮攻防的 20 条根因就是
//   压缩产物,中间细节已丢);而只记 case 又无法复用。两层各管一头。
//
// 子命令:
//   add        --fingerprint <slug> --tier <by-design|proposal|auto> --title "…"
//              [--detail "…"] [--proposal "…"] [--commit <sha>] [--no-sync]
//   set-status --fingerprint <slug> --status <open|landed|adopted|rejected|tracked> [--note "…"] [--no-sync]
//   case       --session <id> --quote "用户原话" --did "agent 当时怎么做的"
//              --why "为什么第一次没做对" --why-class <info-gap|misjudged|spec-unread|tool-limit>
//              --fix "修法" [--verified] [--fingerprint <slug> 若已能归到根因]
//   gate       --session <id> [--declare-none --reason "…"]
//              交付前硬门:该 session 若无 case 记录且无「本轮无 case」的显式声明 → ok:false。
//              agent 不能沉默跳过——要么记 case,要么显式声明(声明本身也留痕)。
//   list
//
// why-class 四分类是「迭代方向」的关键,四类的应对完全不同:
//   info-gap    我没问清 → 要改的是提问习惯(该问的时候问)
//   misjudged   我想错了 → 要改的是判断方式(哪一步推理跳了)
//   spec-unread 有规范我没查 → 要改的是读规范的时机(动手前查)
//   tool-limit  工具做不到 → 才是工具缺口,归根因层 auto/proposal
//
// 自动回推:add / set-status 写盘后把 ledger.json + EVOLUTION.md 提交并推送本仓 main
// (只 add 台账两个文件,不裹挟其他改动)。同步 best-effort:失败不影响台账写入,结果在
// 输出 sync 字段;--no-sync 跳过(测试/本地调试用)。
//
// 纪律:台账正文不写 token、凭证、内部绝对路径或敏感命中原文;PR 只写号码。
// 测试隔离:环境变量 QA_HIFI_SKILL_ROOT 可重定向台账根目录(测试写临时目录,不污染真台账)。

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/* ── case 层(本地私有,不入公开仓)────────────────────────────────────────── */
const CASES_DIR = join(LEDGER_DIR, 'cases');
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 为什么第一次没做对——四类的应对完全不同,所以必须分类而不是自由文本。 */
const WHY_CLASSES = {
  'info-gap': '信息不足(我没问清)→ 改提问习惯',
  misjudged: '判断错误(我想错了)→ 改判断方式',
  'spec-unread': '规范没读(有规范我没查)→ 改读规范的时机',
  'tool-limit': '工具限制(工具真做不到)→ 归根因层 auto/proposal',
};

const caseFileFor = (session) => join(CASES_DIR, `${new Date().toISOString().slice(0, 10)}-${session}.md`);

/** 该 session 今日 case 文件里已记的条目数与声明状态(gate 用)。 */
function readCaseState(session) {
  const file = caseFileFor(session);
  if (!existsSync(file)) return { file, exists: false, cases: 0, declaredNone: false };
  const text = readFileSync(file, 'utf8');
  return {
    file,
    exists: true,
    cases: (text.match(/^## case /gm) ?? []).length,
    declaredNone: /^> DECLARED-NONE /m.test(text),
  };
}

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

  /* case / gate 不以 fingerprint 为必填,必须排在下面那道强校验之前。 */
  if (cmd === 'case' || cmd === 'gate') {
    const session = arg('session');
    if (!session || !SESSION_RE.test(session)) {
      throw new Error('缺少或不合法的 --session(会话标识:字母/数字/点/下划线/连字符,1-64 位)');
    }

    if (cmd === 'gate') {
      const st = readCaseState(session);
      if (arg('reason') != null || process.argv.includes('--declare-none')) {
        const reason = arg('reason');
        if (!reason) throw new Error('--declare-none 必须带 --reason(为什么本轮没有 case)');
        mkdirSync(CASES_DIR, { recursive: true });
        appendFileSync(st.file, `\n> DECLARED-NONE ${new Date().toISOString()} — ${reason}\n`);
        print({ ok: true, session, declaredNone: true, caseFile: st.file, note: '已记录「本轮无 case」声明;声明本身留痕,不是沉默跳过' });
        process.exit(0);
      }
      const ok = st.cases > 0 || st.declaredNone;
      print({
        ok,
        session,
        caseFile: st.file,
        cases: st.cases,
        declaredNone: st.declaredNone,
        ...(ok
          ? { note: st.cases > 0 ? `本轮已记 ${st.cases} 条 case` : '本轮已显式声明无 case' }
          : {
              hint: '交付前硬门未过:本轮既没有 case 记录、也没有「无 case」声明。' +
                '用户在对话里指出过的每个问题都必须先 `case` 入账(含「为什么第一次没做对」);' +
                '若本轮确实无人指出问题,跑 `gate --session <id> --declare-none --reason "…"` 显式声明。',
            }),
      });
      process.exit(ok ? 0 : 2);
    }

    // cmd === 'case'
    const quote = arg('quote');
    const did = arg('did');
    const why = arg('why');
    const whyClass = arg('why-class');
    const fix = arg('fix');
    if (!quote) throw new Error('缺少 --quote(用户原话,不许改写成 agent 的话)');
    if (!did) throw new Error('缺少 --did(agent 当时怎么做的)');
    if (!why) throw new Error('缺少 --why(为什么第一次没做对)');
    if (!WHY_CLASSES[whyClass]) throw new Error(`--why-class 必须是 ${Object.keys(WHY_CLASSES).join('|')}`);
    if (!fix) throw new Error('缺少 --fix(修法)');
    const fp = arg('fingerprint');
    if (fp && !FINGERPRINT_RE.test(fp)) throw new Error('--fingerprint 不合法(可选;能归到根因时才填)');

    mkdirSync(CASES_DIR, { recursive: true });
    const st = readCaseState(session);
    const seq = st.cases + 1;
    const verified = process.argv.includes('--verified');
    if (!st.exists) {
      appendFileSync(
        st.file,
        `# case 台账 — session ${session}\n\n` +
          '本文件**本地私有、不入公开仓**(.gitignore 挡住):正文常含未发布产品细节。\n' +
          '收尾时把这些 case 归纳成根因层条目(`add --fingerprint …`),归纳后的条目才入公开仓。\n',
      );
    }
    appendFileSync(
      st.file,
      `\n## case ${seq} — ${new Date().toISOString()}\n\n` +
        `- **用户原话**:${quote}\n` +
        `- **agent 当时的做法**:${did}\n` +
        `- **为什么第一次没做对**:${why}\n` +
        `- **归类**:\`${whyClass}\` — ${WHY_CLASSES[whyClass]}\n` +
        `- **修法**:${fix}\n` +
        `- **已验证**:${verified ? '是' : '否(未验证,不许当完成)'}\n` +
        (fp ? `- **归到根因**:\`${fp}\`\n` : '- **归到根因**:待收尾归纳\n'),
    );
    print({
      ok: true,
      session,
      caseFile: st.file,
      seq,
      whyClass,
      whyClassMeaning: WHY_CLASSES[whyClass],
      verified,
      fingerprint: fp ?? null,
      note: 'case 已记(本地私有)。收尾时用 add 把它归纳成根因层条目;根因层才入公开仓',
    });
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

  throw new Error('用法:evolution-note.mjs <add|set-status|case|gate|list> …(见文件头注释)');
} catch (e) {
  fail(e);
}
