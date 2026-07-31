import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildInputHashes,
  checkDeclaredComponentSources,
  hashFile,
  COMPONENT_INPUTS_FILE,
  isPlainObject,
  recheckComponentInputs,
  sameInputHashes,
  TOOL_VERSION,
} from './fs-utils.mjs';

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
  // 组件模式代码层防伪链 fail-closed:hash 值只要不是真 sha256(缺文件/glob 零命中/仓根不可解析),
  // 这条链就没锁住任何东西——改产品源码旧 report 照样过。一律阻断,并明示怎么修。
  if (spec?.component?.mode === 'component') {
    const FIX = {
      MISSING: '文件不存在——bundle 输入清单里的文件已被删/改名,重跑 build.mjs 重生清单',
      NO_MATCH: 'glob 零命中——该 pattern 在产品仓内匹配不到任何文件,修正 spec.component.sources',
      UNRESOLVED: 'demo 所在目录不在任何 git 仓内——demo 必须位于产品 git 仓内,代码层 hash 才能锁源',
      INVALID_PATH: '清单里的路径非法(绝对路径/含 ".."/反斜杠)——component.inputs.json 被手改过?重跑 build.mjs',
      NO_MANIFEST: `缺少 bundle 输入清单 ${COMPONENT_INPUTS_FILE}(或结构非法)——它由 build.mjs 从 esbuild metafile 生成,是「bundle 真实读了哪些源文件」的唯一真相源;先跑 node build.mjs 再重跑 verify`,
    };
    const cs = actualHashes.componentSources ?? {};
    if (FIX[cs.manifest] || !cs.manifest) problems.push(`component 防伪链未锁住 bundle 输入清单(状态 ${cs.manifest ?? 'NO_MANIFEST'}):${FIX[cs.manifest] ?? FIX.NO_MANIFEST}`);
    problems.push(...checkDeclaredComponentSources(demoDir, spec.component));
    // manifest 不能自己当自己的真相源:用 esbuild 独立复算一遍输入图再全等比对
    problems.push(...recheckComponentInputs(demoDir).problems);
    for (const [group, entries] of [
      ['sources', cs.sources],
      ['demoInputs', cs.demoInputs],
      ['buildInputs.demo', cs.buildInputs?.demo],
      ['buildInputs.product', cs.buildInputs?.product],
      ['bundle', cs.bundle],
    ]) {
      for (const [name, value] of Object.entries(entries ?? {})) {
        if (FIX[value]) problems.push(`component 防伪链未锁住 ${group} "${name}"(状态 ${value}):${FIX[value]}`);
        // 任何非真 sha256 的值都不锁任何东西(手写占位/未知状态一律拒)
        else if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
          problems.push(`component 防伪链 ${group} "${name}" 的 hash 不是合法 sha256(${JSON.stringify(value)})——重跑 build.mjs + verify`);
      }
    }
    if (cs.repoRoot === 'UNRESOLVED') problems.push(`component 防伪链未锁住 repoRoot(状态 UNRESOLVED):${FIX.UNRESOLVED}`);
  }
  for (const key of ['gateA', 'gateB', 'gateC', 'gateD', 'gateF', 'gateX']) {
    const s = summarizeGate(report[key]);
    if (!s.ok) problems.push(`${key} 未通过或统计不一致:${s.reason}`);
  }
  if (!Array.isArray(report.coverage?.cases) || report.coverage.cases.length === 0) problems.push('report 缺实际执行 coverage.cases');
  if (report.ok !== true) problems.push('report.ok 不是 true');
  return problems;
}

/**
 * 读 demo 里的 report-pixel.json 并校验(**仅用于对账**,不是放行依据)。
 *
 * r6 条目 2:本函数从头到尾只做 report-pixel.json 自身的字段算术自洽(diffRatio===bad/total、
 * threshold===spec 声明值、bad<=total、engine 枚举…),**从不重新对真实图片跑 odiff/pixelmatch**。
 * 手写一份满足全部约束的 JSON(inputHashes 用可导出的 buildInputHashes 现算)就能把视觉回归
 * 伪造成 PASS。所以放行依据改由 pr-block 亲自 spawn pixel-compare 重跑得到,本函数只负责
 * 「作者那份自报是否自洽 / 是否与可信结果一致」。
 */
export function validatePixelForPr(demoDir, spec = null) {
  const pixelPath = join(demoDir, 'report-pixel.json');
  const declaredBaselines = Array.isArray(spec?.baselines) ? spec.baselines.length : 0;
  if (!existsSync(pixelPath)) {
    // 声明了 baseline 却没跑门 E = 硬阻断(codex 复审新 P0-A:原来只 warning 就放行)
    if (declaredBaselines > 0)
      return { present: false, problems: [`spec 声明了 ${declaredBaselines} 个 baseline,但缺 report-pixel.json——门 E 未运行,不得附贴 PR(先跑 pixel-compare)`], report: null };
    return { present: false, problems: [], report: null };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(pixelPath, 'utf8'));
  } catch (err) {
    return { present: true, problems: [`pixel report 不是合法 JSON:${err.message}`], report: null };
  }
  return validatePixelReport(demoDir, spec, report);
}

/**
 * 对一份**已在内存里**的门 E 报告做完整校验。pr-block 用它校验**自己重跑**产出的
 * 可信报告(放行依据),validatePixelForPr 用它校验 demo 自报(对账材料)。
 */
export function validatePixelReport(demoDir, spec, report) {
  const declaredBaselines = Array.isArray(spec?.baselines) ? spec.baselines.length : 0;
  const problems = [];
  if (!isPlainObject(report)) return { present: true, problems: ['pixel report 必须是 object'], report: null };
  if (report.toolVersion !== TOOL_VERSION) problems.push('pixel report toolVersion 缺失或不匹配');
  if (!report.inputHashes) problems.push('pixel report 缺 inputHashes');
  else if (!sameInputHashes(report.inputHashes, buildInputHashes(demoDir, spec))) problems.push('pixel report 输入 hash 与当前 spec/truth/index/baselines 不一致,请重跑 pixel-compare');
  if (report.ok !== true) problems.push('pixel report.ok 不是 true');
  // report-pixel 存在但 skipped(声明了 baseline 却没图匹配上)= 阻断,不是「未验证」放行
  if (report.skipped === true && declaredBaselines > 0)
    problems.push(`spec 声明了 ${declaredBaselines} 个 baseline 但 pixel report 为 skipped——门 E 实际未比对,不得附贴`);
  // 防伪(review finding #2):results 必须与 spec.baselines 一一对应——旧代码只查 hash/ok,
  // 手写 {ok:true,declared:N,compared:0,results:[]}+当前 hash 即可零比对出附贴块。
  // 这里重建期望复合 key 集(platform/key 或 legacy key)做数量/唯一性/集合全等校验,
  // 并对每条结果做 status 合法性、计数自洽(diffRatio≈bad/total)、engine 字段检查。
  if (report.skipped !== true) {
    const expectedKeys = Array.isArray(spec?.baselines)
      ? spec.baselines.map((b) => (b?.platform ? `${b.platform}/${b.key}` : b?.key))
      : [];
    const results = Array.isArray(report.results) ? report.results : null;
    if (report.declared !== expectedKeys.length)
      problems.push(`pixel report declared(${report.declared}) 与 spec.baselines 数量(${expectedKeys.length}) 不符`);
    if (!results) problems.push('pixel report 缺 results 数组(非 skipped 报告必须逐条列出比对结果)');
    else {
      if (results.length !== expectedKeys.length)
        problems.push(`pixel report results 数量(${results.length}) 与 spec.baselines(${expectedKeys.length}) 不一致——漏端或多端`);
      if (report.compared !== results.length)
        problems.push(`pixel report compared(${report.compared}) 与 results.length(${results.length}) 不符(计数伪造?)`);
      // 终审缺口 #2b:status 结论不得与阈值矛盾——threshold 必须等于 spec 声明值
      // (防篡改放宽),PASS 的 diffRatio 不得超阈值、WARN 的 diffRatio 必须超阈值
      // (WARN 另有人工裁决校验兜底),engine 限本工具真实产出枚举
      const expectedThreshold = spec?.baselineThreshold ?? 0.005;
      if (report.threshold !== expectedThreshold)
        problems.push(`pixel report threshold(${report.threshold}) 与 spec.baselineThreshold(${expectedThreshold}) 不符——阈值篡改?`);
      const seen = new Set();
      const LEGAL = new Set(['PASS', 'WARN', 'ERROR', 'MISSING']);
      const ENGINE_LEGAL = new Set(['odiff', 'pixelmatch', 'manual']);
      for (const [i, r] of results.entries()) {
        const ck = r?.platform ? `${r.platform}/${r.key}` : r?.key;
        if (typeof ck !== 'string' || !ck) { problems.push(`pixel results[${i}] 缺 key`); continue; }
        if (seen.has(ck)) problems.push(`pixel results[${i}] 复合 key 重复:${ck}`);
        seen.add(ck);
        if (!LEGAL.has(r?.status)) problems.push(`pixel results[${i}](${ck}) status 非法:${r?.status}`);
        if (r?.status === 'PASS' || r?.status === 'WARN') {
          if (!ENGINE_LEGAL.has(r.engine))
            problems.push(`pixel results[${i}](${ck}) engine 非法:${r.engine}(只允许 odiff/pixelmatch/manual)——非本工具产出?`);
          // 零分母绕过(终审 #2c):total=0 时旧代码跳过比例自洽 → 手写 bad:50,total:0,diffRatio:0
          // 可伪 PASS。真实比对在 mask 护栏(minUnmaskedRatio)下不可能产出 PASS/WARN 且 total=0,
          // 故 PASS/WARN 强制 total 为正整数、bad/masked 非负整数且 bad<=total,自洽校验无条件执行。
          if (!Number.isInteger(r.total) || r.total <= 0) problems.push(`pixel results[${i}](${ck}) total 必须是正整数(当前 ${r.total})——PASS/WARN 不可能零比对`);
          for (const f of ['bad', 'masked']) {
            if (!Number.isInteger(r[f]) || r[f] < 0) problems.push(`pixel results[${i}](${ck}) ${f} 必须是非负整数`);
          }
          if (Number.isInteger(r.bad) && Number.isInteger(r.total) && r.bad > r.total)
            problems.push(`pixel results[${i}](${ck}) bad(${r.bad}) > total(${r.total})——计数伪造?`);
          if (!Number.isFinite(r.diffRatio) || r.diffRatio < 0 || r.diffRatio > 1) problems.push(`pixel results[${i}](${ck}) diffRatio 必须是 [0,1] 数值`);
          else {
            if (Number.isInteger(r.bad) && Number.isInteger(r.total) && r.total > 0 && Math.abs(r.diffRatio - r.bad / r.total) > 1e-9)
              problems.push(`pixel results[${i}](${ck}) diffRatio(${r.diffRatio}) 与 bad/total(${r.bad}/${r.total}) 不一致——计数伪造?`);
            if (r.status === 'PASS' && r.diffRatio > expectedThreshold)
              problems.push(`pixel results[${i}](${ck}) 伪 PASS:diffRatio(${r.diffRatio}) 超阈值(${expectedThreshold})——高差异伪装通过?`);
            if (r.status === 'WARN' && r.diffRatio <= expectedThreshold)
              problems.push(`pixel results[${i}](${ck}) 伪 WARN:diffRatio(${r.diffRatio}) 未超阈值(${expectedThreshold})——WARN 无依据`);
          }
        }
      }
      const missing = expectedKeys.filter((k) => !seen.has(k));
      const extra = [...seen].filter((k) => !expectedKeys.includes(k));
      if (missing.length) problems.push(`pixel report 缺 spec 声明的基准结果:${missing.join(', ')}`);
      if (extra.length) problems.push(`pixel report 含 spec 未声明的结果:${extra.join(', ')}`);
    }
  }
  const statuses = report.results?.map((r) => r.status) ?? [];
  if (statuses.includes('WARN')) {
    for (const r of report.results.filter((x) => x.status === 'WARN')) {
      /* WARN 必须有人工裁决,且该裁决**绑定这一次产出的三图字节**(r7 条目 8)。
         r6 之前只查「artifact 路径存在」—— 路径可以指向后来被换掉的图,裁决绑不住任何具体
         字节;删改图后 stale 裁决照样过。现在三层都要对上:
           ① report 记了三图的 artifactHashes;
           ② 磁盘上那三张图的现算 sha256 等于 ①(pr-block 里这份 report 是可信侧重跑产出的,
              artifact 也被它覆盖过 → ① 就是可信侧字节);
           ③ 裁决文件声明的 artifactHashes 等于 ①。
         裁决本身仍是**人工声明、不是机械测量**:工具只保证「它判的图是可信侧生成的那三张」。 */
      if (!r.adjudication || r.adjudication.ok !== true) {
        problems.push(`pixel WARN ${r.key} 缺人工裁决 artifact${r.adjudicationRejected ? `(${r.adjudicationRejected.reason})` : ''}`);
        continue;
      }
      for (const field of ['reviewer', 'reason']) {
        if (typeof r.adjudication[field] !== 'string' || !r.adjudication[field].trim())
          problems.push(`pixel WARN ${r.key} 的人工裁决缺 ${field}——裁决人与理由必须署名,且会印在 PR 上`);
      }
      for (const kind of ['baseline', 'demo', 'diff']) {
        const p = r.artifacts?.[kind];
        if (!p || !existsSync(join(demoDir, p))) { problems.push(`pixel WARN ${r.key} 缺 ${kind} artifact 图(裁决无凭据)`); continue; }
        const recorded = r.artifactHashes?.[kind];
        if (typeof recorded !== 'string' || !/^[0-9a-f]{64}$/.test(recorded)) {
          problems.push(`pixel WARN ${r.key} 的 ${kind} artifact 缺 sha256 记录——裁决无法绑定字节(重跑 pixel-compare)`);
          continue;
        }
        if (hashFile(join(demoDir, p)) !== recorded)
          problems.push(`pixel WARN ${r.key} 的 ${kind} artifact 字节与 report 记录不符——比对后图被换过,裁决失去凭据`);
        if (r.adjudication.artifactHashes?.[kind] !== recorded)
          problems.push(`pixel WARN ${r.key} 的人工裁决未绑定 ${kind} 图的 sha256(声明 ${r.adjudication.artifactHashes?.[kind] ?? '(缺)'} ≠ 实际 ${recorded})——裁决判的不是这三张图`);
      }
      /* r8:除三图字节,裁决还必须声明并全等本次的 **key / diffRatio / threshold**。
         只绑三图挡得住「换图」,挡不住「换差异」——同 key 上一次小幅 WARN 的裁决,在差异变大、
         三图跟着重跑更新之后,旧裁决的语义(判的是 0.1% 还是 8%)此前无人核对。人工裁决的是
         当时那个具体差异;key 带 platform 是因为基准分端存放、永不互比,mac 的裁决不能给
         windows 的 WARN 用。校验点与 pixel-compare 采纳处保持一致(两侧都拦)。 */
      const ck = r.platform ? `${r.platform}/${r.key}` : r.key;
      for (const [field, actual] of [
        ['key', ck],
        ['diffRatio', r.diffRatio],
        ['threshold', spec?.baselineThreshold ?? 0.005],
      ]) {
        const declared = r.adjudication[field];
        if (declared === undefined || declared === null) {
          problems.push(`pixel WARN ${ck} 的人工裁决缺 ${field}——裁决必须同时声明 key / diffRatio / threshold / artifactHashes 四项,否则旧裁决可被复用到新的差异上`);
          continue;
        }
        if (declared !== actual)
          problems.push(`pixel WARN ${ck} 的人工裁决 ${field} 与本次现算不符(裁决声明 ${declared} vs 本次现算 ${actual})——旧裁决被复用?必须针对当前差异重新裁决`);
      }
    }
  }
  if (statuses.some((s) => ['ERROR', 'MISSING', 'FAIL'].includes(s))) problems.push('pixel report 含 ERROR/MISSING/FAIL');
  return { present: true, problems, report };
}
