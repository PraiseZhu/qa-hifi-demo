import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInputHashes, isPlainObject, sameInputHashes, TOOL_VERSION } from './fs-utils.mjs';

export function summarizeGate(gate) {
  if (!gate || typeof gate !== 'object') return { ok: false, reason: 'missing gate' };
  const failures = gate.failures ?? [];
  const pass = gate.pass === true && (!Array.isArray(failures) || failures.length === 0);
  if (typeof gate.total === 'number' && typeof gate.passed === 'number' && gate.total !== gate.passed + failures.length)
    return { ok: false, reason: 'pass/total/failures mismatch' };
  return { ok: pass, reason: pass ? '' : gate.detail ?? JSON.stringify(failures).slice(0, 300) };
}

export function validateReportIntegrity(demoDir, spec, report) {
  const problems = [];
  if (!report || typeof report !== 'object') return ['report 必须是 object'];
  if (report.toolVersion !== TOOL_VERSION) problems.push(`report.toolVersion 缺失或不匹配:${report.toolVersion ?? '(missing)'}`);
  // 增量运行(--gate/--case/--state)产物只用于调试:门/组合有缺,不代表全量绿——一律拒收
  if (report.partial === true) problems.push('report 是增量运行(partial)产物——定稿必须全量重跑 verify(不带 --gate/--case/--state)');
  const actualHashes = buildInputHashes(demoDir, spec);
  if (!report.inputHashes) problems.push('report 缺 inputHashes');
  else if (!sameInputHashes(report.inputHashes, actualHashes)) problems.push('report 输入 hash 与当前 spec/truth/index/baselines/customGates 不一致,请重跑 verify/pixel');
  for (const key of ['gateA', 'gateB', 'gateC', 'gateD', 'gateF', 'gateX']) {
    const s = summarizeGate(report[key]);
    if (!s.ok) problems.push(`${key} 未通过或统计不一致:${s.reason}`);
  }
  if (!Array.isArray(report.coverage?.cases) || report.coverage.cases.length === 0) problems.push('report 缺实际执行 coverage.cases');
  if (report.ok !== true) problems.push('report.ok 不是 true');
  return problems;
}

export function validatePixelForPr(demoDir, spec = null) {
  const pixelPath = join(demoDir, 'report-pixel.json');
  const declaredBaselines = Array.isArray(spec?.baselines) ? spec.baselines.length : 0;
  if (!existsSync(pixelPath)) {
    // 声明了 baseline 却没跑门 E = 硬阻断(codex 复审新 P0-A:原来只 warning 就放行)
    if (declaredBaselines > 0)
      return { present: false, problems: [`spec 声明了 ${declaredBaselines} 个 baseline,但缺 report-pixel.json——门 E 未运行,不得附贴 PR(先跑 pixel-compare)`], report: null };
    return { present: false, problems: [], report: null };
  }
  const problems = [];
  let report;
  try {
    report = JSON.parse(readFileSync(pixelPath, 'utf8'));
  } catch (err) {
    return { present: true, problems: [`pixel report 不是合法 JSON:${err.message}`], report: null };
  }
  if (!isPlainObject(report)) return { present: true, problems: ['pixel report 必须是 object'], report: null };
  if (report.toolVersion !== TOOL_VERSION) problems.push('pixel report toolVersion 缺失或不匹配');
  if (!report.inputHashes) problems.push('pixel report 缺 inputHashes');
  else if (!sameInputHashes(report.inputHashes, buildInputHashes(demoDir, spec))) problems.push('pixel report 输入 hash 与当前 spec/truth/index/baselines 不一致,请重跑 pixel-compare');
  if (report.ok !== true) problems.push('pixel report.ok 不是 true');
  // report-pixel 存在但 skipped(声明了 baseline 却没图匹配上)= 阻断,不是「未验证」放行
  if (report.skipped === true && declaredBaselines > 0)
    problems.push(`spec 声明了 ${declaredBaselines} 个 baseline 但 pixel report 为 skipped——门 E 实际未比对,不得附贴`);
  const statuses = report.results?.map((r) => r.status) ?? [];
  if (statuses.includes('WARN')) {
    for (const r of report.results.filter((x) => x.status === 'WARN')) {
      // WARN 必须有人工裁决 artifact 且三张图(baseline/demo/diff)实际存在(codex 复审 P1:裁决/图删改后 stale 仍过)
      if (!r.adjudication || r.adjudication.ok !== true) { problems.push(`pixel WARN ${r.key} 缺人工裁决 artifact`); continue; }
      for (const kind of ['baseline', 'demo', 'diff']) {
        const p = r.artifacts?.[kind];
        if (!p || !existsSync(join(demoDir, p))) problems.push(`pixel WARN ${r.key} 缺 ${kind} artifact 图(裁决无凭据)`);
      }
    }
  }
  if (statuses.some((s) => ['ERROR', 'MISSING', 'FAIL'].includes(s))) problems.push('pixel report 含 ERROR/MISSING/FAIL');
  return { present: true, problems, report };
}
