// style-convert.mjs — CSS 声明 → React Native style 对象的白名单换算核心。
//
// 硬原则(宁缺毋滥):属性 ∈ RN 合法样式集 ∧ 值通过分类校验,才进 mechanical;
// 其余一律进 rejected 并给出人读原因,交 agent 双改——机械通道宁可拒转,绝不写出
// 「语法上写进了 RN、运行时静默无效」的值(门 A/D 只管 demo 侧,RN 渲染层无机械门)。
//
// 已知 passthrough 陷阱(css-to-react-native 原样放行、RN 实际不认识的值)全部拒转:
//   1rem / 1em / 1vh 等非 px 单位、calc()/var()/url()/env()、boxShadow/filter 字符串
//   (后两者依 RN 版本支持,需人工确认)、CSS grid/float/sticky 等 RN 无对应语义。
//
// shorthand(padding/margin/border/font/textShadow/transform…)是原子单位:展开后任一片段
// 不过校验,整个 shorthand 进 rejected——避免「半边机械写回、半边漂移」。

import { getStylesForProperty } from 'css-to-react-native';

// ---- RN 合法样式属性集(自 React Native 官方文档 curated;未知属性一律拒) ----
const COLOR_PROPS = new Set([
  'backgroundColor', 'color', 'tintColor', 'overlayColor',
  'borderColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
  'borderStartColor', 'borderEndColor', 'shadowColor', 'textShadowColor', 'textDecorationColor',
]);

// 纯数字属性:css-to-react-native 已把 '8px' → 8;其余形态一概拒
const NUMBER_PROPS = new Set([
  'aspectRatio', 'elevation', 'flex', 'flexGrow', 'flexShrink', 'opacity', 'zIndex',
  'rowGap', 'columnGap', 'gap',
  'borderWidth', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderStartWidth', 'borderEndWidth',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius',
  'borderBottomRightRadius', 'borderTopStartRadius', 'borderTopEndRadius',
  'borderBottomStartRadius', 'borderBottomEndRadius',
  'fontSize', 'letterSpacing', 'lineHeight',
  'shadowOpacity', 'shadowRadius', 'textShadowRadius',
]);

// 尺寸属性:数字之外还合法接受百分比('50%')与/或 'auto'
const DIMENSION_PROPS = new Set([
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'top', 'bottom', 'left', 'right', 'start', 'end',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'marginHorizontal', 'marginVertical', 'marginStart', 'marginEnd',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'paddingHorizontal', 'paddingVertical', 'paddingStart', 'paddingEnd',
  'flexBasis',
]);
const PERCENT_OK = new Set([...DIMENSION_PROPS]);
const AUTO_OK = new Set(['width', 'height', 'flexBasis', 'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginHorizontal', 'marginVertical', 'marginStart', 'marginEnd']);

const ENUM_PROPS = {
  display: ['flex', 'none'],
  position: ['absolute', 'relative'],
  overflow: ['visible', 'hidden', 'scroll'],
  direction: ['inherit', 'ltr', 'rtl'],
  flexDirection: ['row', 'row-reverse', 'column', 'column-reverse'],
  flexWrap: ['wrap', 'nowrap', 'wrap-reverse'],
  justifyContent: ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'],
  alignItems: ['flex-start', 'flex-end', 'center', 'stretch', 'baseline'],
  alignContent: ['flex-start', 'flex-end', 'center', 'stretch', 'space-between', 'space-around'],
  alignSelf: ['auto', 'flex-start', 'flex-end', 'center', 'stretch', 'baseline'],
  backfaceVisibility: ['visible', 'hidden'],
  borderStyle: ['solid', 'dashed', 'dotted'],
  fontStyle: ['normal', 'italic'],
  fontWeight: ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'],
  textAlign: ['auto', 'left', 'right', 'center', 'justify'],
  textAlignVertical: ['auto', 'top', 'bottom', 'center'],
  textDecorationLine: ['none', 'underline', 'line-through', 'underline line-through'],
  textDecorationStyle: ['solid', 'double', 'dotted', 'dashed'],
  textTransform: ['none', 'uppercase', 'lowercase', 'capitalize'],
  writingDirection: ['auto', 'ltr', 'rtl'],
  resizeMode: ['cover', 'contain', 'stretch', 'repeat', 'center'],
  objectFit: ['cover', 'contain', 'fill', 'scale-down', 'none'],
  userSelect: ['auto', 'text', 'none', 'contain', 'all'],
};

const FONT_VARIANT_VALUES = new Set([
  'small-caps', 'oldstyle-nums', 'lining-nums', 'tabular-nums', 'proportional-nums',
]);
const TRANSFORM_KEYS = {
  perspective: 'number', scale: 'number', scaleX: 'number', scaleY: 'number',
  translateX: 'number|percent', translateY: 'number|percent',
  rotate: 'angle', rotateX: 'angle', rotateY: 'angle', rotateZ: 'angle',
  skewX: 'angle', skewY: 'angle',
};

// CSS 颜色关键字(RN 全量支持;小集合按 CSS Color Level 4 收录)
const CSS_COLOR_KEYWORDS = new Set((
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
  'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
  'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
  'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
  'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
  'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
  'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
  'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
  'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
  'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
  'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
  'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
  'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
  'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
  'teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen'
).split(' '));

const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN_RE = /^(?:rgba?|hsla?)\(\s*[-\d.]+%?\s*,\s*[-\d.]+%?\s*,\s*[-\d.]+%?\s*(?:,\s*[-\d.]+%?\s*)?\)$/i;
export function isColorValue(v) {
  return typeof v === 'string' && (COLOR_RE.test(v) || COLOR_FN_RE.test(v) || CSS_COLOR_KEYWORDS.has(v.toLowerCase()));
}

const EVAL_TRAP_RE = /(?:^|[^\w-])(?:calc|var|url|env|attr|min|max|clamp)\(/i;
const NON_PX_UNIT_RE = /^-?[\d.]+(?:rem|em|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc)$/i;
const PERCENT_RE = /^-?\d+(?:\.\d+)?%$/;
const ANGLE_RE = /^-?\d+(?:\.\d+)?(?:deg|rad)$/;

/** 单条 RN 样式条目校验;通过返回 null,拒绝返回人读原因。 */
export function validateEntry(prop, value) {
  // boxShadow/filter:css-to-react-native 原样透传字符串,RN 侧支持依版本而定——拒转交人工
  if (prop === 'boxShadow' || prop === 'filter') {
    return `${prop} 依 RN 版本支持情况不一(透传字符串无法静态保证),请人工确认`;
  }
  if (prop === 'transform') {
    if (!Array.isArray(value)) return 'transform 不是数组形态';
    for (const entry of value) {
      const keys = Object.keys(entry ?? {});
      if (keys.length !== 1 || !(keys[0] in TRANSFORM_KEYS)) return `transform 含未知片段:${JSON.stringify(entry)}`;
      const v = entry[keys[0]];
      const spec = TRANSFORM_KEYS[keys[0]];
      const ok =
        (spec === 'number' && typeof v === 'number' && Number.isFinite(v)) ||
        (spec === 'number|percent' && ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && PERCENT_RE.test(v)))) ||
        (spec === 'angle' && typeof v === 'string' && ANGLE_RE.test(v));
      if (!ok) return `transform.${keys[0]} 值 ${JSON.stringify(v)} 不符合 ${spec}`;
    }
    return null;
  }
  if (prop === 'fontVariant') {
    if (!Array.isArray(value) || value.some((v) => !FONT_VARIANT_VALUES.has(v))) {
      return `fontVariant 含 RN 不支持的值:${JSON.stringify(value)}`;
    }
    return null;
  }
  if (prop === 'shadowOffset' || prop === 'textShadowOffset') {
    const ok = value && typeof value === 'object' &&
      typeof value.width === 'number' && typeof value.height === 'number';
    return ok ? null : `${prop} 必须是 {width:number, height:number}`;
  }
  if (prop === 'fontFamily') {
    if (typeof value !== 'string' || !value.trim() || /[()]/.test(value)) {
      return `fontFamily 值 ${JSON.stringify(value)} 不是合法字体名`;
    }
    return null;
  }
  if (prop === 'includeFontPadding') {
    return typeof value === 'boolean' ? null : 'includeFontPadding 必须是 boolean';
  }
  if (COLOR_PROPS.has(prop)) {
    return isColorValue(value) ? null : `值 ${JSON.stringify(value)} 不是 RN 可识别的颜色`;
  }
  if (ENUM_PROPS[prop]) {
    return ENUM_PROPS[prop].includes(value) ? null : `值 ${JSON.stringify(value)} 不在 ${prop} 的 RN 枚举内(${ENUM_PROPS[prop].join('|')})`;
  }
  if (NUMBER_PROPS.has(prop)) {
    return typeof value === 'number' && Number.isFinite(value)
      ? null
      : `值 ${JSON.stringify(value)} 不是 number(px 已自动换算,其他单位拒绝)`;
  }
  if (DIMENSION_PROPS.has(prop)) {
    if (typeof value === 'number' && Number.isFinite(value)) return null;
    if (typeof value === 'string' && PERCENT_RE.test(value) && PERCENT_OK.has(prop)) return null;
    if (value === 'auto' && AUTO_OK.has(prop)) return null;
    return `值 ${JSON.stringify(value)} 不是 number/合法百分比/auto`;
  }
  return `属性 ${prop} 不在 RN 合法样式集`;
}

/** 字符串值的通用陷阱网:不可静态求值的表达式与非 px 单位一律拒。 */
function stringTrap(prop, value) {
  if (typeof value !== 'string') return null;
  if (EVAL_TRAP_RE.test(value)) return `含 calc()/var()/url() 等不可静态求值表达式`;
  if (NON_PX_UNIT_RE.test(value)) return `非 px 单位(${value})在 RN 无对应`;
  return null;
}

const camelize = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * 把一组 CSS 声明换算成 { mechanical, rejected }。
 * @param decls [{ prop, value, important? }]
 * @returns { mechanical: Record<string, unknown>, rejected: [{prop, value, reason}] }
 */
export function convertDeclarations(decls) {
  const mechanical = Object.create(null);   // r12:CSS/RN 属性名为 key,同一形状
  const rejected = [];
  for (const { prop, value } of decls) {
    const p = String(prop ?? '').trim();
    const v = String(value ?? '').trim();
    if (!p || !v) continue;
    let styles;
    try {
      styles = getStylesForProperty(p, v);
    } catch (err) {
      rejected.push({ prop: p, value: v, reason: `shorthand 解析失败:${err.message}` });
      continue;
    }
    // shorthand 原子校验:任一片段不过 → 整条声明进 rejected
    const bad = [];
    for (const [k, val] of Object.entries(styles)) {
      const reason = stringTrap(k, val) ?? validateEntry(k, val);
      if (reason) bad.push(`${k}=${JSON.stringify(val)}: ${reason}`);
    }
    const firstBad = bad[0];
    if (firstBad) {
      rejected.push({ prop: p, value: v, reason: firstBad });
      continue;
    }
    Object.assign(mechanical, styles);
  }
  return { mechanical, rejected };
}
