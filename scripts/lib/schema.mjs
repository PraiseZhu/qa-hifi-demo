import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { hashFile, isPlainObject } from './fs-utils.mjs';

// 门 E 分端基准(gate-e-v2):baselines[].platform 允许值。
// 分端是「采集/存储」维度的命名空间,不是比对维度的白名单——不同 platform 的基准永不互比。
export const BASELINE_PLATFORMS = ['web', 'electron-mac', 'electron-win', 'ios', 'android'];

const PREF_KEYS = ['plat', 'region', 'os', 'mode', 'lang'];
const MATRIX_REQUIRED = {
  plat: ['platforms'],
  region: ['regions'],
  os: ['systems', 'os'],
  mode: ['themes', 'modes'],
  lang: ['langs', 'languages'],
};
const MATRIX_FIELDS = [
  ['platforms', 'plat'],
  ['regions', 'region'],
  ['systems', 'os'],
  ['os', 'os'],
  ['themes', 'mode'],
  ['modes', 'mode'],
  ['langs', 'lang'],
  ['languages', 'lang'],
];

export function normalizeHash(hash) {
  return String(hash ?? '').replace(/^sha256:/, '');
}

export function validateStep(step, where, stateIds = null) {
  const problems = [];
  if (!isPlainObject(step)) return [`${where}: step 必须是 object`];
  const kinds = ['click', 'type', 'waitMs', 'expect'].filter((k) => Object.hasOwn(step, k));
  if (kinds.length !== 1) problems.push(`${where}:每步恰含 click/type/waitMs/expect 之一`);
  if (Object.hasOwn(step, 'click') && typeof step.click !== 'string') problems.push(`${where}.click 必须是 selector string`);
  if (Object.hasOwn(step, 'type')) {
    if (!isPlainObject(step.type)) problems.push(`${where}.type 必须是 object`);
    else {
      if (typeof step.type.sel !== 'string') problems.push(`${where}.type.sel 必须是 selector string`);
      if (typeof step.type.text !== 'string' || step.type.text.length === 0) problems.push(`${where}.type.text 必须是非空 string`);
      if (step.type.delayMs !== undefined && (!Number.isFinite(Number(step.type.delayMs)) || Number(step.type.delayMs) < 0))
        problems.push(`${where}.type.delayMs 必须是非负数`);
    }
  }
  if (Object.hasOwn(step, 'waitMs') && (!Number.isFinite(Number(step.waitMs)) || Number(step.waitMs) < 0))
    problems.push(`${where}.waitMs 必须是非负数`);
  if (Object.hasOwn(step, 'expect')) {
    if (typeof step.expect !== 'string') problems.push(`${where}.expect 必须是 state id string`);
    else if (stateIds && !stateIds.has(step.expect)) problems.push(`${where}.expect 指向未声明状态 "${step.expect}"`);
  }
  return problems;
}

function validatePrefsObject(prefs, where, { requireAll = true } = {}) {
  const problems = [];
  if (!isPlainObject(prefs)) return [`${where} 必须是 object`];
  for (const key of PREF_KEYS) {
    if (prefs[key] === undefined) {
      if (requireAll) problems.push(`${where}.${key} 必须是 string`);
      continue;
    }
    if (typeof prefs[key] !== 'string' || !prefs[key]) problems.push(`${where}.${key} 必须是非空 string`);
  }
  for (const key of Object.keys(prefs)) {
    if (!PREF_KEYS.includes(key)) problems.push(`${where}.${key} 不是支持的 prefs key`);
  }
  return problems;
}

export function validateSpec(spec) {
  const problems = [];
  if (!isPlainObject(spec)) return ['spec 顶层必须是 plain object'];
  if (spec.meta !== undefined) {
    if (!isPlainObject(spec.meta)) problems.push('meta 必须是 object');
    else {
      if (spec.meta.name !== undefined && typeof spec.meta.name !== 'string') problems.push('meta.name 必须是 string');
      if (spec.meta.summary !== undefined) {
        if (!isPlainObject(spec.meta.summary)) problems.push('meta.summary 必须是 object');
        else for (const key of ['what', 'how', 'accept']) {
          if (typeof spec.meta.summary[key] !== 'string' || !spec.meta.summary[key])
            problems.push(`meta.summary.${key} 必须是非空 string`);
        }
      }
    }
  }
  if (!isPlainObject(spec.matrix)) problems.push('matrix 必须是 object');
  else {
    for (const [field] of MATRIX_FIELDS) {
      if (spec.matrix[field] === undefined) continue;
      if (!Array.isArray(spec.matrix[field]) || spec.matrix[field].length === 0 || spec.matrix[field].some((v) => typeof v !== 'string' || v.length === 0))
        problems.push(`matrix.${field} 必须是非空 string 数组`);
    }
    for (const [key, aliases] of Object.entries(MATRIX_REQUIRED)) {
      if (!aliases.some((field) => Array.isArray(spec.matrix[field]) && spec.matrix[field].length > 0))
        problems.push(`matrix 缺少 ${key} 维度(${aliases.join('/')})`);
    }
  }
  if (!Array.isArray(spec.states) || spec.states.length === 0) problems.push('states 必须是非空数组');
  const ids = new Set();
  for (const [i, st] of (Array.isArray(spec.states) ? spec.states : []).entries()) {
    const where = `states[${i}]`;
    if (!isPlainObject(st)) { problems.push(`${where} 必须是 object`); continue; }
    if (typeof st.id !== 'string' || st.id.length === 0) problems.push(`${where}.id 必须是非空 string`);
    else if (ids.has(st.id)) problems.push(`${where}.id 重复:${st.id}`);
    else ids.add(st.id);
  }
  for (const [i, st] of (Array.isArray(spec.states) ? spec.states : []).entries()) {
    if (!isPlainObject(st)) continue;
    const where = `states[${i}](${st.id ?? 'no-id'})`;
    const hasVia = Array.isArray(st.via);
    const tabOnly = st.via === null && st.tab === '状态补齐';
    if (hasVia && st.tab) problems.push(`${where}:via 与 tab 二选一`);
    if (!hasVia && !tabOnly) problems.push(`${where}:必须有 via 数组,或 via:null + tab:"状态补齐"`);
    if (tabOnly && !(typeof st.note === 'string' && st.note.trim())) problems.push(`${where}:状态补齐必须写 note`);
    if (hasVia) {
      if (st.via.length === 0) problems.push(`${where}.via 不能为空`);
      for (const [j, step] of st.via.entries()) problems.push(...validateStep(step, `${where}.via[${j}]`, ids));
      const last = st.via.at(-1);
      if (!last || !Object.hasOwn(last, 'expect')) problems.push(`${where}.via 最后一步必须是 expect`);
    }
  }
  const v = spec.verify;
  if (v !== undefined) {
    if (!isPlainObject(v)) problems.push('verify 必须是 object');
    else {
      if (!Array.isArray(v.noClip) || v.noClip.length === 0 || v.noClip.some((s) => typeof s !== 'string' || !s))
        problems.push('verify.noClip 必须是非空 selector 数组');
      if (v.inputs !== undefined && !Array.isArray(v.inputs)) problems.push('verify.inputs 必须是数组');
      for (const [i, inp] of (Array.isArray(v.inputs) ? v.inputs : []).entries()) {
        const where = `verify.inputs[${i}]`;
        if (!isPlainObject(inp)) { problems.push(`${where} 必须是 object`); continue; }
        if (typeof inp.sel !== 'string' || !inp.sel) problems.push(`${where}.sel 必须是 selector string`);
        if (typeof inp.text !== 'string' || inp.text.length === 0) problems.push(`${where}.text 必须是非空 string`);
        if (!Number.isFinite(Number(inp.tickMs)) || Number(inp.tickMs) <= 0) problems.push(`${where}.tickMs 必须是正数`);
        if (inp.via !== undefined) {
          if (!Array.isArray(inp.via)) problems.push(`${where}.via 必须是 step 数组`);
          else inp.via.forEach((s, j) => problems.push(...validateStep(s, `${where}.via[${j}]`, ids)));
        }
        if (typeof inp.tickWitness !== 'string' || !inp.tickWitness) problems.push(`${where}.tickWitness 必须是可观察 DOM selector`);
      }
      if (v.persistence !== undefined) {
        const p = v.persistence;
        if (!isPlainObject(p)) problems.push('verify.persistence 必须是 object');
        else {
          problems.push(...validatePrefsObject(p.expected, 'verify.persistence.expected'));
          if (typeof p.storageKey !== 'string' || !p.storageKey) problems.push('verify.persistence.storageKey 必须是 localStorage key');
          if (!Number.isInteger(Number(p.reloads)) || Number(p.reloads) < 1) problems.push('verify.persistence.reloads 必须 >= 1');
          if (!Array.isArray(p.via) || p.via.length === 0) problems.push('verify.persistence.via 必须是非空 step 数组');
          else p.via.forEach((s, j) => problems.push(...validateStep(s, `verify.persistence.via[${j}]`, ids)));
          if (p.initialState !== undefined && (typeof p.initialState !== 'string' || !ids.has(p.initialState)))
            problems.push('verify.persistence.initialState 必须指向已声明 state');
        }
      }
      if (v.cases !== undefined && !Array.isArray(v.cases)) problems.push('verify.cases 必须是数组');
      for (const [i, c] of (Array.isArray(v.cases) ? v.cases : []).entries()) {
        if (!isPlainObject(c)) { problems.push(`verify.cases[${i}] 必须是 object`); continue; }
        if (c.id !== undefined && (typeof c.id !== 'string' || !c.id)) problems.push(`verify.cases[${i}].id 必须是非空 string`);
        problems.push(...validatePrefsObject(c.prefs, `verify.cases[${i}].prefs`));
        // case prefs 的每个取值必须属于 matrix 声明(codex 复审 P1:显式 cases 可写未声明值致语义漂移)
        if (isPlainObject(c.prefs) && isPlainObject(spec.matrix)) {
          for (const [key, val] of Object.entries(c.prefs)) {
            // pref key(plat/region/os/mode/lang)→ 该键对应的所有 matrix 字段的并集
            const fields = MATRIX_FIELDS.filter(([, k]) => k === key).map(([f]) => f);
            const allowed = fields.flatMap((f) => (Array.isArray(spec.matrix[f]) ? spec.matrix[f] : []));
            if (allowed.length > 0 && !allowed.includes(val)) problems.push(`verify.cases[${i}].prefs.${key}=${val} 不在 matrix 声明内`);
          }
        }
        if (c.via !== undefined) {
          if (!Array.isArray(c.via)) problems.push(`verify.cases[${i}].via 必须是 step 数组`);
          else c.via.forEach((s, j) => problems.push(...validateStep(s, `verify.cases[${i}].via[${j}]`, ids)));
        }
        // per-case viewport:移动端 case 必须在移动端视口下验(否则门 C/F 结论对 mobile 不成立)
        if (c.viewport !== undefined) {
          if (!isPlainObject(c.viewport)) problems.push(`verify.cases[${i}].viewport 必须是 object`);
          else {
            for (const key of ['w', 'h']) {
              if (!Number.isFinite(Number(c.viewport[key])) || Number(c.viewport[key]) <= 0)
                problems.push(`verify.cases[${i}].viewport.${key} 必须是正数`);
            }
            if (c.viewport.dpr !== undefined && (!Number.isFinite(Number(c.viewport.dpr)) || Number(c.viewport.dpr) <= 0))
              problems.push(`verify.cases[${i}].viewport.dpr 必须是正数`);
            for (const key of Object.keys(c.viewport)) {
              if (!['w', 'h', 'dpr'].includes(key)) problems.push(`verify.cases[${i}].viewport.${key} 不是支持的字段(w/h/dpr)`);
            }
          }
        }
      }
    }
  } else {
    problems.push('verify 必须配置(noClip/inputs/persistence/cases)');
  }
  for (const [i, b] of (Array.isArray(spec.bindings) ? spec.bindings : []).entries()) {
    if (!isPlainObject(b)) { problems.push(`bindings[${i}] 必须是 object`); continue; }
    if (typeof b.sel !== 'string' || !b.sel) problems.push(`bindings[${i}].sel 必须是 selector string`);
    if (typeof b.prop !== 'string' || !b.prop) problems.push(`bindings[${i}].prop 必须是 CSS property string`);
    if (typeof b.truth !== 'string' || !b.truth) problems.push(`bindings[${i}].truth 必须是 truth path`);
    if (b.kind !== undefined && !['color', 'length', 'text', 'asset-sha'].includes(b.kind)) problems.push(`bindings[${i}].kind 非法`);
    if (b.pseudo !== undefined && !['::before', '::after', '::placeholder'].includes(b.pseudo)) problems.push(`bindings[${i}].pseudo 非法`);
    if (b.scaled !== undefined && typeof b.scaled !== 'boolean') problems.push(`bindings[${i}].scaled 必须是 boolean`);
    if (b.tolerancePx !== undefined && (!Number.isFinite(Number(b.tolerancePx)) || Number(b.tolerancePx) < 0))
      problems.push(`bindings[${i}].tolerancePx 必须是非负数`);
    if (b.via !== undefined) {
      if (!Array.isArray(b.via)) problems.push(`bindings[${i}].via 必须是 step 数组`);
      else b.via.forEach((s, j) => problems.push(...validateStep(s, `bindings[${i}].via[${j}]`, ids)));
    }
  }
  if (spec.baselineThreshold !== undefined) {
    const n = Number(spec.baselineThreshold);
    if (!Number.isFinite(n) || n < 0 || n > 0.2) problems.push('baselineThreshold 必须在 [0,0.2] 内');
  }
  for (const key of ['pixelmatchThreshold', 'maxMaskRatio', 'minUnmaskedRatio']) {
    if (spec[key] === undefined) continue;
    const n = Number(spec[key]);
    if (!Number.isFinite(n) || n < 0 || n > 1) problems.push(`${key} 必须在 [0,1] 内`);
  }
  if (spec.baselineDpr !== undefined && (!Number.isFinite(Number(spec.baselineDpr)) || Number(spec.baselineDpr) <= 0))
    problems.push('baselineDpr 必须是正数');
  if (spec.baselineFrameSel !== undefined && (typeof spec.baselineFrameSel !== 'string' || !spec.baselineFrameSel))
    problems.push('baselineFrameSel 必须是 selector string');
  const baselineKeys = new Set();
  for (const [i, b] of (Array.isArray(spec.baselines) ? spec.baselines : []).entries()) {
    if (!isPlainObject(b)) { problems.push(`baselines[${i}] 必须是 object`); continue; }
    // key 直接拼进 baselines/<key>.png 与 pixel-artifacts/<key>.*——必须限安全 basename,
    // 否则 ../../ 可读写 demo 外文件(codex 复审新 P0-B:路径穿越)。
    if (typeof b.key !== 'string' || !b.key) problems.push(`baselines[${i}].key 必须是 string`);
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(b.key) || b.key.includes('..')) problems.push(`baselines[${i}].key 只允许 [A-Za-z0-9._-] 且不含 "..":${b.key}`);
    // platform(分端基准,gate-e-v2):声明后基准路径 = baselines/<platform>/<key>.png;
    // 未声明 = 兼容旧 baselines/<key>.png。不同 platform 的基准永不互比(各存各的、各比各的)。
    else {
      if (b.platform !== undefined && !BASELINE_PLATFORMS.includes(b.platform))
        problems.push(`baselines[${i}].platform 必须是 ${BASELINE_PLATFORMS.join('/')} 之一:${b.platform}`);
      // 唯一性按 platform+key 组合:同一 key 可跨端各存一份(如 ios/login 与 android/login)
      const composite = `${b.platform ?? ''} ${b.key}`;
      if (baselineKeys.has(composite)) problems.push(`baselines[${i}] 的 platform+key 组合重复:${b.platform ? `${b.platform}/` : ''}${b.key}`);
      else baselineKeys.add(composite);
    }
    if (b.frameSel !== undefined && (typeof b.frameSel !== 'string' || !b.frameSel)) problems.push(`baselines[${i}].frameSel 必须是 selector string`);
    for (const key of ['maxMaskRatio', 'minUnmaskedRatio']) {
      if (b[key] === undefined) continue;
      const n = Number(b[key]);
      if (!Number.isFinite(n) || n < 0 || n > 1) problems.push(`baselines[${i}].${key} 必须在 [0,1] 内`);
    }
    if (b.via !== undefined) {
      if (!Array.isArray(b.via)) problems.push(`baselines[${i}].via 必须是 step 数组`);
      else b.via.forEach((s, j) => problems.push(...validateStep(s, `baselines[${i}].via[${j}]`, ids)));
    }
    if (b.mask !== undefined) {
      if (!Array.isArray(b.mask)) problems.push(`baselines[${i}].mask 必须是矩形数组`);
      else b.mask.forEach((rect, j) => {
        if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => !Number.isFinite(Number(n)) || Number(n) < 0))
          problems.push(`baselines[${i}].mask[${j}] 必须是 [x,y,w,h] 非负数`);
      });
    }
  }
  // customGates:demo 专属的体外验收脚本注册——不注册的体外脚本游离于防伪链之外
  if (spec.customGates !== undefined) {
    if (!Array.isArray(spec.customGates)) problems.push('customGates 必须是数组');
    else {
      const gateIds = new Set();
      for (const [i, g] of spec.customGates.entries()) {
        if (!isPlainObject(g)) { problems.push(`customGates[${i}] 必须是 object`); continue; }
        if (typeof g.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(g.id)) problems.push(`customGates[${i}].id 必须是 slug(小写字母/数字/连字符)`);
        else if (gateIds.has(g.id)) problems.push(`customGates[${i}].id 重复:${g.id}`);
        else gateIds.add(g.id);
        // script 限 demo 目录内相对路径:拼进 execFile 与 hash 链,禁止越狱
        if (typeof g.script !== 'string' || !g.script) problems.push(`customGates[${i}].script 必须是相对路径 string`);
        else if (g.script.includes('..') || g.script.startsWith('/') || g.script.includes('\\'))
          problems.push(`customGates[${i}].script 只允许 demo 目录内相对路径(不含 ".."/绝对路径):${g.script}`);
        if (g.description !== undefined && typeof g.description !== 'string') problems.push(`customGates[${i}].description 必须是 string`);
        if (g.timeoutMs !== undefined && (!Number.isFinite(Number(g.timeoutMs)) || Number(g.timeoutMs) <= 0))
          problems.push(`customGates[${i}].timeoutMs 必须是正数`);
      }
    }
  }
  if (spec.adaptive !== undefined) {
    const ad = spec.adaptive;
    if (!isPlainObject(ad)) problems.push('adaptive 必须是 object');
    else {
      if (!isPlainObject(ad.min)) problems.push('adaptive.min 必须是 object');
      else for (const key of ['w', 'h']) {
        if (!Number.isFinite(Number(ad.min[key])) || Number(ad.min[key]) <= 0) problems.push(`adaptive.min.${key} 必须是正数`);
      }
      if (!Array.isArray(ad.sampleSizes) || ad.sampleSizes.length === 0) problems.push('adaptive.sampleSizes 必须是非空数组');
      else ad.sampleSizes.forEach((size, i) => {
        if (!Array.isArray(size) || size.length !== 2 || size.some((n) => !Number.isFinite(Number(n)) || Number(n) <= 0))
          problems.push(`adaptive.sampleSizes[${i}] 必须是 [w,h] 正数`);
      });
      if (!Array.isArray(ad.probes)) problems.push('adaptive.probes 必须是数组');
      else ad.probes.forEach((p, i) => {
        if (!isPlainObject(p)) { problems.push(`adaptive.probes[${i}] 必须是 object`); return; }
        if (typeof p.id !== 'string' || !p.id) problems.push(`adaptive.probes[${i}].id 必须是 string`);
        if (typeof p.sel !== 'string' || !p.sel) problems.push(`adaptive.probes[${i}].sel 必须是 selector string`);
      });
      if (ad.tolerancePx !== undefined && (!Number.isFinite(Number(ad.tolerancePx)) || Number(ad.tolerancePx) < 0))
        problems.push('adaptive.tolerancePx 必须是非负数');
    }
  }
  return problems;
}

/** customGates 脚本存在性检查(schema 静态校验之外的文件系统检查;verify/pr-block 前置调用)。 */
export function validateCustomGateFiles(spec, demoDir) {
  const problems = [];
  for (const g of Array.isArray(spec?.customGates) ? spec.customGates : []) {
    if (g && typeof g.script === 'string' && g.script && !existsSync(resolve(demoDir, g.script)))
      problems.push(`customGates 脚本不存在:${g.script}`);
  }
  return problems;
}

export function validateTruth(truth, { demoDir = process.cwd(), requireProvenance = true } = {}) {
  const problems = [];
  if (!isPlainObject(truth)) return ['truth 顶层必须是 plain object'];
  function visit(value, path) {
    // adaptive.samples 是 extract 用产品布局公式算出的期望几何表(纯数值 x/y/w/h),不逐坐标要
    // provenance——其完整性由门 A 的 extractor-drift 检查覆盖(跑 extract.mjs 现算 ≡ truth.json)。
    if (path === 'adaptive.samples') return;
    if (isPlainObject(value) && Object.hasOwn(value, 'value')) {
      if (requireProvenance) validateProvenance(value.provenance, path, demoDir, problems);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k);
      return;
    }
    problems.push(`${path || '(root)'}: truth 叶子必须包装为 {value, provenance}`);
  }
  visit(truth, '');
  return problems;
}

function validateProvenance(prov, path, demoDir, problems) {
  if (!isPlainObject(prov)) { problems.push(`${path}.provenance 缺失或不是 object`); return; }
  if (typeof prov.source !== 'string' || !prov.source) problems.push(`${path}.provenance.source 必须是文件路径`);
  if (typeof prov.locator !== 'string' || !prov.locator) problems.push(`${path}.provenance.locator 必须说明定位方式`);
  if (typeof prov.hash !== 'string' || !prov.hash) problems.push(`${path}.provenance.hash 必须是源文件 sha256`);
  // locatorPattern 可选:写了就必须是「恰含一个捕获组」的合法正则——它是 writeback 反向写回的
  // 机械定位锚,坏正则/多捕获组会让写回位置不确定
  if (prov.locatorPattern !== undefined) {
    if (typeof prov.locatorPattern !== 'string' || !prov.locatorPattern) {
      problems.push(`${path}.provenance.locatorPattern 必须是非空正则 string`);
    } else {
      try {
        const groups = new RegExp(`${prov.locatorPattern}|`).exec('').length - 1;
        if (groups !== 1) problems.push(`${path}.provenance.locatorPattern 必须恰含一个捕获组(当前 ${groups} 个)`);
      } catch (err) {
        problems.push(`${path}.provenance.locatorPattern 不是合法正则:${err.message}`);
      }
    }
  }
  // locatorKeyPath 可选:写了就必须是「段.段.段」的非空路径——writeback 的 AST 定位锚,
  // 段含空白/空段说明作者手滑,定位必然失败,这里提前拦下
  if (prov.locatorKeyPath !== undefined) {
    if (
      typeof prov.locatorKeyPath !== 'string' ||
      !prov.locatorKeyPath.trim() ||
      prov.locatorKeyPath.split('.').some((s) => !s || /\s/.test(s))
    ) {
      problems.push(`${path}.provenance.locatorKeyPath 必须是「段.段.段」非空路径(段不含空白)`);
    }
  }
  // sourceKind 可选:省略 = 'code'(源码溯源,默认)。'fixture' = 该值来自录制的服务端响应,
  // 源码里没有这个字面量(providers 配置 / account memberships 等服务端驱动数据)。
  // fixture 是**声明性降级**不是防伪豁免:文件存在性 + hash 照旧校验,另外强制两条——
  //   ① capturedFrom:一句话人读来源声明(什么时候从哪个环境的哪个接口录的),缺了直接 FAIL
  //      ——没有它,fixture 就是"来源不明的手抄数据穿了 provenance 的马甲";
  //   ② source 必须落在 demo 内 fixtures/ 下:fixture 得随 PR 走、可被 reviewer 打开,
  //      指向仓外/demo 外的路径谁都验不了,等于没有溯源。
  const sourceKind = prov.sourceKind === undefined ? 'code' : prov.sourceKind;
  if (prov.sourceKind !== undefined && sourceKind !== 'code' && sourceKind !== 'fixture') {
    problems.push(`${path}.provenance.sourceKind 只能是 'code' 或 'fixture'(省略即 code)`);
  }
  if (sourceKind === 'fixture') {
    if (typeof prov.capturedFrom !== 'string' || !prov.capturedFrom.trim()) {
      problems.push(
        `${path}.provenance.capturedFrom 必填(sourceKind=fixture):一句话声明录制来源,如「2026-07-30 公司沙盒 /api/providers 响应」`,
      );
    }
    if (typeof prov.source === 'string' && prov.source) {
      const rel = relative(demoDir, resolve(demoDir, prov.source)).split('\\').join('/');
      if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(prov.source)) {
        problems.push(`${path}.provenance.source 指向 demo 目录外:${prov.source}——fixture 必须放 demo 内 fixtures/ 下随 PR 走`);
      } else if (!rel.startsWith('fixtures/')) {
        problems.push(`${path}.provenance.source 必须是 demo 内 fixtures/<name>.json(当前 ${rel})`);
      }
    }
  }
  if (typeof prov.source === 'string' && prov.source) {
    const sourcePath = resolve(demoDir, prov.source);
    if (!existsSync(sourcePath)) problems.push(`${path}.provenance.source 不存在:${prov.source}`);
    else if (prov.hash && normalizeHash(prov.hash) !== hashFile(sourcePath))
      problems.push(`${path}.provenance.hash 与源文件不符:${prov.source}`);
  }
}

/**
 * 统计 truth 里 sourceKind='fixture' 的叶子数(PR 附贴块的诚实降级声明用)。
 * 与校验解耦:只数,不判合法性——非法的在 validateTruth 阶段已被拦下。
 */
export function countFixtureLeaves(truth) {
  let n = 0;
  const visit = (value) => {
    if (isPlainObject(value) && Object.hasOwn(value, 'value') && Object.hasOwn(value, 'provenance')) {
      if (isPlainObject(value.provenance) && value.provenance.sourceKind === 'fixture') n += 1;
      return;
    }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (isPlainObject(value)) { Object.values(value).forEach(visit); }
  };
  visit(truth);
  return n;
}

export function unwrapTruth(value) {
  if (isPlainObject(value) && Object.hasOwn(value, 'value')) return value.value;
  if (Array.isArray(value)) return value.map(unwrapTruth);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unwrapTruth(v);
    return out;
  }
  return value;
}

export function truthAt(truth, path) {
  const raw = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), truth);
  return raw === undefined ? undefined : unwrapTruth(raw);
}

export function buildVerifyCases(spec) {
  if (Array.isArray(spec.verify?.cases) && spec.verify.cases.length > 0) {
    return spec.verify.cases.map((c, i) => ({
      id: c.id ?? `case-${i + 1}`,
      prefs: { ...c.prefs },
      via: c.via ?? null,
      viewport: c.viewport ?? null,
      source: 'verify.cases',
    }));
  }
  const matrix = spec.matrix ?? {};
  const groups = [];
  const used = new Set();
  for (const [field, key] of MATRIX_FIELDS) {
    if (used.has(key)) continue;
    if (Array.isArray(matrix[field]) && matrix[field].length > 0) {
      groups.push([key, matrix[field]]);
      used.add(key);
    }
  }
  if (groups.length === 0) return [{ id: 'default', prefs: {}, via: null, source: 'default' }];
  let cases = [{ id: '', prefs: {} }];
  for (const [key, values] of groups) {
    const next = [];
    for (const c of cases) {
      for (const v of values) next.push({ id: c.id ? `${c.id}/${key}=${v}` : `${key}=${v}`, prefs: { ...c.prefs, [key]: v } });
    }
    cases = next;
  }
  return cases.map((c, i) => ({ id: c.id || `case-${i + 1}`, prefs: c.prefs, via: null, source: 'matrix' }));
}

export function prefsSubsetEqual(actual, expected) {
  for (const [k, v] of Object.entries(expected ?? {})) {
    if (actual?.[k] !== v) return false;
  }
  return true;
}

export { PREF_KEYS };
