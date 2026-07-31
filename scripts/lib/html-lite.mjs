// html-lite.mjs — 轻量 HTML 解析(demo 单文件专用,零依赖)。
//
// 边界(诚实声明):这不是浏览器级 parser——不实现 HTML5 容错规范(隐式闭合 p/li、
// tbody 补全等)。输入是我们自己 init.mjs 生成的、结构规整的单文件 demo,规整输入下
// 输出是确定的;遇到不成对标签等畸形输入直接抛 ParseError 带位置,调用方(dom-ops)
// 如实失败并把比对交还 agent,绝不默默猜。
//
// 处理规则:
//   - script/style 是 raw-text 元素:内部不解析,整体作为一个 text 子节点
//     (qa-truth 内嵌块因此被当作纯文本,不会被误当 DOM 结构比对);
//   - void 元素(area base br col embed hr img input link meta source track wbr)无结束标签;
//   - 文本与属性值解码 5 个常用实体(&amp; &lt; &gt; &quot; &#39;),其余实体原样保留。

export class ParseError extends Error {
  constructor(message, position) {
    super(`${message}(位置 ${position})`);
    this.name = 'ParseError';
    this.position = position;
  }
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

const ENTITY_MAP = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
export function decodeEntities(text) {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITY_MAP[m] ?? m);
}

const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function element(tag, attrs = {}) {
  return { type: 'element', tag, attrs, children: [], parent: null };
}

/** 解析 HTML 文本为树:{ type:'root', children: [...] };畸形输入抛 ParseError。 */
export function parseHtml(html) {
  const root = { type: 'root', children: [], parent: null };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  const pushText = (text) => {
    if (text) top().children.push({ type: 'text', text: decodeEntities(text), parent: top() });
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) throw new ParseError('注释未闭合', lt);
      i = end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt + 2);
      if (end === -1) throw new ParseError('声明未闭合', lt);
      i = end + 1;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt + 2);
      if (end === -1) throw new ParseError('结束标签未闭合', lt);
      const name = html.slice(lt + 2, end).trim().toLowerCase();
      // 弹栈到匹配元素;找不到 = 标签不成对,抛错
      let found = -1;
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === name) { found = s; break; }
      }
      if (found === -1) throw new ParseError(`结束标签 </${name}> 没有对应的开始标签`, lt);
      stack.length = found;
      i = end + 1;
      continue;
    }
    // 开始标签:找 '>'(尊重引号)
    if (!/[a-zA-Z]/.test(html[lt + 1] ?? '')) { pushText('<'); i = lt + 1; continue; }
    let j = lt + 1;
    let quote = null;
    while (j < html.length) {
      const ch = html[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j++;
    }
    if (j >= html.length) throw new ParseError('开始标签未闭合', lt);
    const inner = html.slice(lt + 1, j);
    const selfClosing = /\/\s*$/.test(inner);
    const nameMatch = /^([a-zA-Z][^\s/>]*)/.exec(inner);
    if (!nameMatch) throw new ParseError('无法解析标签名', lt);
    const tag = nameMatch[1].toLowerCase();
    const attrs = Object.create(null);   // r12:属性名由页面控制,可能是 __proto__
    ATTR_RE.lastIndex = nameMatch[0].length;
    let m;
    while ((m = ATTR_RE.exec(inner))) {
      attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    const node = element(tag, attrs);
    node.parent = top();
    top().children.push(node);
    i = j + 1;

    if (RAW_TEXT_ELEMENTS.has(tag) && !selfClosing) {
      // raw-text:原样吃到对应的结束标签(不解析内部)
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const close = closeRe.exec(rest);
      if (!close) throw new ParseError(`<${tag}> 缺少结束标签`, lt);
      if (close.index > 0) node.children.push({ type: 'text', text: rest.slice(0, close.index), parent: node });
      i += close.index + close[0].length;
      continue;
    }
    if (!selfClosing && !VOID_ELEMENTS.has(tag)) stack.push(node);
  }
  if (stack.length !== 1) {
    const unclosed = stack.slice(1).map((n) => `<${n.tag}>`).join(', ');
    throw new ParseError(`文档结束仍有未闭合元素:${unclosed}`, html.length);
  }
  return root;
}

/** 序列化(用于 unanchored 比对与摘录);anchored 子树可折叠成占位符。 */
export function serialize(node, { foldAnchored = false, cap = Infinity } = {}) {
  let out = '';
  const walk = (n) => {
    if (out.length > cap) return;
    if (n.type === 'text') { out += n.text; return; }
    if (n.type === 'root') { n.children.forEach(walk); return; }
    if (foldAnchored && n.attrs?.['data-node-id']) {
      out += `<${n.tag} data-node-id="${n.attrs['data-node-id']}">…</${n.tag}>`;
      return;
    }
    const attrs = Object.entries(n.attrs ?? {}).map(([k, v]) => (v === '' ? k : `${k}="${v}"`)).join(' ');
    out += `<${n.tag}${attrs ? ' ' + attrs : ''}>`;
    (n.children ?? []).forEach(walk);
    if (!VOID_ELEMENTS.has(n.tag)) out += `</${n.tag}>`;
  };
  walk(node);
  return cap < Infinity ? out.slice(0, cap) : out;
}

/** 元素的直接文本(仅直接 text 子节点拼接,空白折叠)。 */
export function directText(node) {
  return (node.children ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
