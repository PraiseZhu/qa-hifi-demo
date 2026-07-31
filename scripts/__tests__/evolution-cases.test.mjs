/**
 * case 层台账 + 交付前硬门（r14）。
 * 现状问题：P7 原来只有「收尾批量复盘」，全靠 agent 自觉——本 skill 十三轮攻防最终只沉淀
 * 20 条根因，中间大量用户 case by case 指出的具体问题已不可回溯。本组锁住两件事：
 *   1. case 层能原样留下「用户原话 / agent 当时做法 / 为什么没做对 / 修法」四要素；
 *   2. gate 是**硬门**——没记 case 且没显式声明就 exit 2，agent 不能沉默跳过。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../evolution-note.mjs');

/** 每个用例一个隔离台账根，绝不碰真台账。 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'qa-hifi-evo-'));
  const run = (args) => {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
        env: { ...process.env, QA_HIFI_SKILL_ROOT: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, json: JSON.parse(stdout) };
    } catch (e) {
      let json = null;
      try { json = JSON.parse(String(e.stdout ?? '')); } catch { /* 非 JSON 错误输出 */ }
      return { status: e.status ?? 1, json, stderr: String(e.stderr ?? '') };
    }
  };
  const caseFile = () => {
    const dir = join(root, 'evolution', 'cases');
    if (!existsSync(dir)) return null;
    const f = readdirSync(dir)[0];
    return f ? readFileSync(join(dir, f), 'utf8') : null;
  };
  return { root, run, caseFile };
}

/** quote/did/why 三对（不含 --why-class，供需要单独指定分类的用例拼接）。 */
const THREE = [
  '--quote', '登录按钮间距不对,应该是 12 不是 16',
  '--did', '按目测估的 16px 写进 truth',
  '--why', '没查产品仓的 spacing token,直接目测估值',
];
const FOUR = [...THREE, '--why-class', 'spec-unread', '--fix', '从 tokens/spacing.ts 提取真值并加 provenance'];

test('gate 是硬门:没 case 也没声明 → exit 2,且报文告诉 agent 两条合法出路', () => {
  const { run } = sandbox();
  const r = run(['gate', '--session', 's1']);
  assert.equal(r.status, 2, 'gate 必须以非零退出阻断交付,不能只是打印警告');
  assert.equal(r.json.ok, false);
  assert.match(r.json.hint, /case/);
  assert.match(r.json.hint, /declare-none/, '报文必须给出「显式声明无 case」这条合法出路');
});

test('case 原样留下四要素:用户原话不许被改写', () => {
  const { run, caseFile } = sandbox();
  const r = run(['case', '--session', 's1', ...FOUR, '--verified']);
  assert.equal(r.status, 0);
  assert.equal(r.json.seq, 1);
  assert.equal(r.json.verified, true);
  const md = caseFile();
  assert.match(md, /登录按钮间距不对,应该是 12 不是 16/, '用户原话必须逐字留存');
  assert.match(md, /按目测估的 16px 写进 truth/);
  assert.match(md, /没查产品仓的 spacing token/);
  assert.match(md, /`spec-unread`/);
  assert.match(md, /从 tokens\/spacing\.ts 提取真值/);
  assert.match(md, /本地私有.*不入公开仓/, 'case 文件自身要写明公开边界');
});

test('why-class 必须是四类之一:自由文本会让「迭代方向」失效', () => {
  const { run } = sandbox();
  assert.equal(run(['case', '--session', 's1', ...THREE, '--why-class', 'bogus', '--fix', 'f']).status, 1);
  for (const cls of ['info-gap', 'misjudged', 'spec-unread', 'tool-limit']) {
    const r = run(['case', '--session', `s-${cls}`, ...THREE, '--why-class', cls, '--fix', 'f']);
    assert.equal(r.status, 0, `${cls} 应被接受`);
    assert.equal(r.json.whyClass, cls);
    assert.ok(r.json.whyClassMeaning, '每类都要回带「该改什么」的含义,不然分类没用');
  }
});

test('四要素缺任一即拒:未验证不许当完成', () => {
  const { run } = sandbox();
  for (const drop of ['--quote', '--did', '--why', '--fix']) {
    const args = ['case', '--session', 's1', ...FOUR];
    const i = args.indexOf(drop);
    args.splice(i, 2);
    assert.equal(run(args).status, 1, `缺 ${drop} 必须拒绝`);
  }
  const { run: run2, caseFile } = sandbox();
  run2(['case', '--session', 's1', ...FOUR]); // 不带 --verified
  assert.match(caseFile(), /已验证.*否\(未验证,不许当完成\)/);
});

test('记了 case 之后 gate 放行', () => {
  const { run } = sandbox();
  run(['case', '--session', 's1', ...FOUR]);
  const r = run(['gate', '--session', 's1']);
  assert.equal(r.status, 0);
  assert.equal(r.json.cases, 1);
});

test('declare-none 是显式声明而非沉默跳过:必须带理由且留痕', () => {
  const { run, caseFile } = sandbox();
  assert.equal(run(['gate', '--session', 's1', '--declare-none']).status, 1, '缺 --reason 必须拒绝');
  const r = run(['gate', '--session', 's1', '--declare-none', '--reason', '本轮仅跑回归,用户未指出问题']);
  assert.equal(r.status, 0);
  assert.match(caseFile(), /DECLARED-NONE/, '声明本身必须落痕,以便回查');
  assert.match(caseFile(), /本轮仅跑回归/);
  assert.equal(run(['gate', '--session', 's1']).status, 0, '声明后 gate 应放行');
});

test('case 层与根因层隔离:case 不写 ledger、不触发公开仓同步', () => {
  const { root, run } = sandbox();
  run(['case', '--session', 's1', ...FOUR]);
  assert.equal(existsSync(join(root, 'evolution', 'ledger.json')), false, 'case 不该写根因层事实源');
  assert.equal(existsSync(join(root, 'EVOLUTION.md')), false, 'case 不该触发公开视图再生成');
});

test('多条 case 顺序累加,不去重(同一问题被指出两次要都留着)', () => {
  const { run, caseFile } = sandbox();
  run(['case', '--session', 's1', ...FOUR]);
  const r2 = run(['case', '--session', 's1', ...FOUR]);
  assert.equal(r2.json.seq, 2, 'case 层不去重——重复出现本身就是信号');
  assert.equal((caseFile().match(/^## case /gm) ?? []).length, 2);
});
