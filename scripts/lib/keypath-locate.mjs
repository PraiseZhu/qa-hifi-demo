// keypath-locate.mjs — 用 TypeScript Compiler API 在源文件 AST 里定位 keyPath 的字面量。
//
// 定位语义（与 SKILL.md P2.5 的约定一致）：
//   keyPath = 从顶层变量名（或 export default / JSON 根对象）起的完整对象路径，
//   段为属性名或数组下标（数字），如 'loginDesignTokens.hero.size'、'providers.social.0'。
//
// 防盲写设计：本模块只做「找 + 分类」，不做写。任何不确定一律抛 LocateError 拒转——
// 找不到（NOT_FOUND）/ 多处定义（AMBIGUOUS）/ 值不是字面量（NON_LITERAL，如函数调用、
// 标识符引用、条件表达式、模板插值）/ 计算属性或 spread 导致无法静态解析时同样拒转。
// writeback.mjs 捕获后按「走 agent 双改」处理，绝不猜测落笔位置。
//
// typescript 不打包进本 skill：由调用方 resolveFrom 产品仓 node_modules 后注入（零新增依赖）。

export class LocateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocateError';
    this.code = code; // NOT_FOUND | AMBIGUOUS | NON_LITERAL | BAD_KEYPATH | UNSUPPORTED_FILE
    this.details = details;
  }
}

export function parseKeyPath(keyPath) {
  if (typeof keyPath !== 'string' || !keyPath.trim()) {
    throw new LocateError('BAD_KEYPATH', `locatorKeyPath 必须是非空 string:${JSON.stringify(keyPath)}`);
  }
  const segments = keyPath.split('.');
  if (segments.some((s) => !s || /\s/.test(s))) {
    throw new LocateError('BAD_KEYPATH', `locatorKeyPath 含空段或空白字符:${keyPath}`);
  }
  return segments;
}

const JSON_KIND_EXTS = new Set(['.json']);

function scriptKindFor(ts, fileName) {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.ts': return ts.ScriptKind.TS;
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    case '.json': return ts.ScriptKind.JS; // 内容包一层括号后按 JS 解析
    default: throw new LocateError('UNSUPPORTED_FILE', `不支持的源文件类型:${ext}(仅 ts/tsx/js/jsx/mjs/cjs/json)`);
  }
}

/**
 * 在源文件中定位 keyPath 指向的字面量。
 * @param ts 产品仓的 typescript 模块（调用方注入）
 * @param opts.fileName 源文件路径（仅用于推断 ScriptKind 与报错）
 * @param opts.content 源文件文本
 * @param opts.keyPath 完整对象路径（见文件头约定）
 * @returns { start, end, kind, currentValue, quoteChar }
 *   start/end 为可替换区间（相对原始 content）；kind ∈ string|number|boolean；
 *   currentValue 为当前值的可比较字符串（string 去引号、number 原文、boolean true/false）；
 *   quoteChar 仅 string 时有值（'、" 或 `），写回时保持原引号风格。
 */
export function locateKeyPathLiteral(ts, { fileName, content, keyPath }) {
  const segments = parseKeyPath(keyPath);
  const kind = scriptKindFor(ts, fileName);
  const isJson = JSON_KIND_EXTS.has(fileName.slice(fileName.lastIndexOf('.')).toLowerCase());
  // JSON 不是合法 JS 语句（顶层对象字面量会被当块），包一层括号按表达式解析，位置整体偏移 2
  const offset = isJson ? 2 : 0;
  const text = isJson ? `(\n${content}\n)` : content;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, kind);
  if (isJson && sf.statements.length === 0) {
    throw new LocateError('UNSUPPORTED_FILE', `${fileName} 内容为空或不是对象字面量 JSON`);
  }

  const pathEq = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);
  const keyNameOf = (propName) =>
    ts.isIdentifier(propName) || ts.isStringLiteral(propName) || ts.isNumericLiteral(propName)
      ? propName.text
      : undefined; // 计算属性名不可静态解析
  const unwrap = (node) => {
    let n = node;
    while (
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)) ||
      ts.isNonNullExpression(n)
    ) n = n.expression;
    return n;
  };

  const matches = [];
  let sawSpread = false;
  const visitValue = (node, path) => {
    const n = unwrap(node);
    if (!n) return;
    if (ts.isObjectLiteralExpression(n)) {
      for (const prop of n.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const name = keyNameOf(prop.name);
          if (name === undefined) continue;
          const p = [...path, name];
          if (pathEq(p, segments)) matches.push({ valueNode: prop.initializer, nameNode: prop.name });
          visitValue(prop.initializer, p);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          const p = [...path, prop.name.text];
          // shorthand 的值是标识符引用，不是字面量——命中也按 NON_LITERAL 拒转
          if (pathEq(p, segments)) matches.push({ valueNode: null, shorthandOf: prop.name.text, nameNode: prop.name });
        } else if (ts.isSpreadAssignment(prop)) {
          sawSpread = true;
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(n)) {
      n.elements.forEach((el, i) => visitValue(el, [...path, String(i)]));
      return;
    }
  };
  const visitTop = (node, path) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) visitValue(decl.initializer, [...path, decl.name.text]);
      }
      return;
    }
    // export default {…} / (JSON 包装产生的) 表达式语句:根对象不带变量名段
    if (ts.isExportAssignment(node)) { visitValue(node.expression, path); return; }
    if (ts.isExpressionStatement(node)) { visitValue(node.expression, path); return; }
    ts.forEachChild(node, (child) => visitTop(child, path));
  };
  visitTop(sf, []);

  const posOf = (node) => {
    const lc = sf.getLineAndCharacterOfPosition(node.getStart());
    return `${lc.line + 1}:${lc.character + 1}`;
  };
  if (matches.length === 0) {
    throw new LocateError(
      'NOT_FOUND',
      `keyPath "${keyPath}" 在 ${fileName} 中未命中` +
        (sawSpread ? '(文件含 spread 展开,该路径可能来自展开对象——无法静态解析)' : ''),
    );
  }
  if (matches.length > 1) {
    throw new LocateError(
      'AMBIGUOUS',
      `keyPath "${keyPath}" 在 ${fileName} 命中 ${matches.length} 处(${matches.map((m) => posOf(m.nameNode)).join(', ')})——多处定义,写回位置不确定`,
      { locations: matches.map((m) => posOf(m.nameNode)) },
    );
  }

  const { valueNode, shorthandOf } = matches[0];
  if (!valueNode) {
    throw new LocateError('NON_LITERAL', `keyPath "${keyPath}" 是 shorthand 属性(引用标识符 ${shorthandOf}),不是字面量`);
  }
  const init = unwrap(valueNode);
  const start = init.getStart() - offset;
  const end = init.getEnd() - offset;

  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
    const quoteChar = text[init.getStart()];
    return { start, end, kind: 'string', currentValue: init.text, quoteChar };
  }
  if (ts.isNumericLiteral(init)) {
    return { start, end, kind: 'number', currentValue: init.text };
  }
  if (
    ts.isPrefixUnaryExpression(init) &&
    init.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(init.operand)
  ) {
    return { start, end, kind: 'number', currentValue: `-${init.operand.text}` };
  }
  if (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword) {
    return { start, end, kind: 'boolean', currentValue: init.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'false' };
  }
  throw new LocateError(
    'NON_LITERAL',
    `keyPath "${keyPath}" 的初始化式不是字面量(${ts.SyntaxKind[init.kind]})——函数调用/标识符引用/条件表达式等须走 agent 双改`,
  );
}

/** 按定位结果构造替换文本；新值不合法时抛 LocateError(NON_LITERAL) 拒转。 */
export function buildReplacement(loc, newValue) {
  if (loc.kind === 'string') {
    if (newValue.includes(loc.quoteChar) || /[\\\n\r]/.test(newValue)) {
      throw new LocateError('NON_LITERAL', `新值含引号(${loc.quoteChar})/反斜杠/换行,机械写回拒绝(走 agent)`);
    }
    return `${loc.quoteChar}${newValue}${loc.quoteChar}`;
  }
  if (loc.kind === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(newValue)) {
      throw new LocateError('NON_LITERAL', `新值 "${newValue}" 不是合法数字字面量(目标是 number 属性)`);
    }
    return newValue;
  }
  if (loc.kind === 'boolean') {
    if (newValue !== 'true' && newValue !== 'false') {
      throw new LocateError('NON_LITERAL', `新值 "${newValue}" 不是 true/false(目标是 boolean 属性)`);
    }
    return newValue;
  }
  throw new LocateError('NON_LITERAL', `未知字面量类型:${loc.kind}`);
}
