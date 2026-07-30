#!/usr/bin/env node
// states.mjs — spec.json 严格 schema + 状态机声明完备性校验。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { failJson, failProblems } from './lib/fs-utils.mjs';
import { validateSpec } from './lib/schema.mjs';

const args = process.argv.slice(2);
const demoIdx = args.indexOf('--demo');
if (demoIdx === -1 || !args[demoIdx + 1]) failJson('缺 --demo <dir>');
const demoDir = resolve(args[demoIdx + 1]);
const specPath = join(demoDir, 'spec.json');
if (!existsSync(specPath)) failJson(`spec.json 不存在:${specPath}`);

let spec;
try {
  spec = JSON.parse(readFileSync(specPath, 'utf8'));
} catch (err) {
  failProblems([`spec.json 不是合法 JSON:${err.message}`]);
}

const problems = validateSpec(spec);
if (problems.length) failProblems(problems);

const states = spec.states;
const summary = {
  total: states.length,
  viaReachable: states.filter((s) => Array.isArray(s.via)).length,
  tabOnly: states.filter((s) => s.via === null && s.tab === '状态补齐').length,
};
console.log(JSON.stringify({ ok: true, summary }, null, 2));
