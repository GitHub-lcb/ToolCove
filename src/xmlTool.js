// XML / 报文工具的纯逻辑：解析、校验、格式化、转 JSON、XPath 子集查询、统计。
//
// 为什么**自己写解析器**而不是用 `DOMParser`：
//   1. 单测跑在 node 环境（这个项目刻意不用 jsdom），`DOMParser` 不存在——用它就等于把
//      解析逻辑排除在单测之外，而这正是最容易错的地方；
//   2. `DOMParser` 把错误塞进 `<parsererror>` 文档里，拿不到**行号**；自研可以精确报位置；
//   3. 三端（桌面/网页/手机）行为完全一致，不依赖各平台 WebView 的实现差异。
//
// 与相邻工具的边界：不做 JSON 语法校验（那是 json 工具）、不做通用文本处理（那是 text 工具）。
// 这里只做"XML 报文 ⇄ 结构化数据"与围绕它的处理。
//
// 全部纯函数、零依赖，所以三端共用且可单测。

/** 预定义实体 + 数字实体。 */
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** 解析错误：带行号与原因（原因用错误码，界面按语言渲染）。 */
class XmlError extends Error {
  constructor(code, line, column, params = {}) {
    super(`${code}@${line}:${column}`);
    this.code = code;
    this.line = line;
    this.column = column;
    this.params = params;
  }
}

/** 位置 → 行列（解析过程中按字符偏移换算）。 */
function positionOf(text, offset) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/**
 * 解析 XML 为节点树。
 *
 * 节点形状：
 *   { type: "element", name, attrs: [{name, value}], children: [], line }
 *   { type: "text", value }
 *   { type: "comment", value }
 *   { type: "cdata", value }
 *   { type: "pi", value }        // `<?xml ...?>` 与其它处理指令
 *   { type: "doctype", value }
 *
 * 失败时抛 [XmlError]（带 code / line / column），由调用方翻成可读提示。
 */
export function parseXml(input) {
  // 去 BOM：不去掉的话第一个标签名会带上一个看不见的字符
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  const root = { type: "root", children: [] };
  const stack = [root];
  let index = 0;

  const top = () => stack[stack.length - 1];
  const fail = (code, params) => {
    const { line, column } = positionOf(text, index);
    throw new XmlError(code, line, column, params);
  };

  while (index < text.length) {
    const lt = text.indexOf("<", index);
    if (lt < 0) {
      // 剩余全是文本
      pushText(top(), text.slice(index), text, index);
      break;
    }
    if (lt > index) pushText(top(), text.slice(index, lt), text, index);
    index = lt;

    // 注释
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      if (end < 0) fail("unclosedComment");
      top().children.push({ type: "comment", value: text.slice(index + 4, end) });
      index = end + 3;
      continue;
    }
    // CDATA（内容不解析，原样保留）
    if (text.startsWith("<![CDATA[", index)) {
      const end = text.indexOf("]]>", index + 9);
      if (end < 0) fail("unclosedCdata");
      top().children.push({ type: "cdata", value: text.slice(index + 9, end) });
      index = end + 3;
      continue;
    }
    // DOCTYPE
    if (text.startsWith("<!DOCTYPE", index) || text.startsWith("<!doctype", index)) {
      const end = text.indexOf(">", index);
      if (end < 0) fail("unclosedDoctype");
      top().children.push({ type: "doctype", value: text.slice(index + 9, end).trim() });
      index = end + 1;
      continue;
    }
    // 处理指令（含 XML 声明）
    if (text.startsWith("<?", index)) {
      const end = text.indexOf("?>", index + 2);
      if (end < 0) fail("unclosedPi");
      top().children.push({ type: "pi", value: text.slice(index + 2, end).trim() });
      index = end + 2;
      continue;
    }
    // 结束标签
    if (text.startsWith("</", index)) {
      const end = text.indexOf(">", index);
      if (end < 0) fail("unclosedTag");
      const name = text.slice(index + 2, end).trim();
      const current = top();
      if (current === root) fail("strayEndTag", { name });
      if (current.name !== name) fail("mismatchedTag", { expected: current.name, actual: name });
      current.endLine = positionOf(text, index).line;
      stack.pop();
      index = end + 1;
      continue;
    }
    // 开始标签
    // `<` 后面紧跟**空白或 `=`** 时，一定是文本里没转义的尖括号（`1 < 2`、`a <= b`）——
    // 标签不可能以空白或等号开头。报"标签名为空"会把人引到错误方向，所以单独识别。
    // 注意不能把"数字开头"也归到这里：`<1a/>` 是**标签名非法**，报 ltInText 会误导。
    if (/[\s=]/.test(text[index + 1] ?? "")) {
      fail("ltInText");
    }
    const parsed = parseStartTag(text, index, fail);
    const node = {
      type: "element",
      name: parsed.name,
      attrs: parsed.attrs,
      children: [],
      line: positionOf(text, index).line,
      selfClosing: parsed.selfClosing,
    };
    top().children.push(node);
    index = parsed.end;
    // 自闭合不入栈
    if (!parsed.selfClosing) stack.push(node);
  }

  if (stack.length > 1) {
    const unclosed = stack[stack.length - 1];
    index = text.length;
    fail("unclosedElement", { name: unclosed.name });
  }
  // 只允许一个根元素（忽略声明/注释/DOCTYPE）
  const elements = root.children.filter((node) => node.type === "element");
  if (elements.length > 1) {
    index = text.length;
    fail("multipleRoots", { names: elements.map((node) => node.name).slice(0, 3).join(", ") });
  }
  return { root: elements[0] || null, children: root.children };
}

/** 解析开始标签（标签名 + 属性 + 是否自闭合）。 */
function parseStartTag(text, start, fail) {
  let index = start + 1;
  const nameMatch = /^[^\s/>]+/.exec(text.slice(index));
  if (!nameMatch) {
    index = start;
    fail("emptyTagName");
  }
  const name = nameMatch[0];
  // 标签名合法性：不能以数字或标点开头
  if (!/^[A-Za-z_:][\w.:-]*$/.test(name)) {
    index = start;
    fail("invalidTagName", { name });
  }
  index += name.length;
  const attrs = [];

  while (index < text.length) {
    // 跳过空白
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] === "/" && text[index + 1] === ">") return { name, attrs, selfClosing: true, end: index + 2 };
    if (text[index] === ">") return { name, attrs, selfClosing: false, end: index + 1 };
    if (index >= text.length) break;

    const attrMatch = /^[^\s=/>]+/.exec(text.slice(index));
    if (!attrMatch) {
      fail("invalidAttribute");
    }
    const attrName = attrMatch[0];
    index += attrName.length;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] !== "=") {
      // 没有值的属性（HTML 允许，XML 不允许）
      fail("attributeWithoutValue", { name: attrName });
    }
    index += 1;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    const quote = text[index];
    if (quote !== '"' && quote !== "'") {
      fail("attributeNotQuoted", { name: attrName });
    }
    const close = text.indexOf(quote, index + 1);
    if (close < 0) {
      fail("unclosedAttribute", { name: attrName });
    }
    const rawValue = text.slice(index + 1, close);
    // 属性值里的 `<` 是非法字符（容易被忽略的一类错误）
    if (rawValue.includes("<")) fail("ltInAttribute", { name: attrName });
    attrs.push({ name: attrName, value: decodeEntities(rawValue) });
    index = close + 1;
  }
  fail("unclosedTag");
  return null; // 不会到达
}

/** 文本节点：解码实体；纯空白保留（混合内容里可能有意义）。 */
function pushText(parent, raw, text, offset) {
  if (!raw) return;
  if (raw.includes("<")) {
    // 文本里出现裸 `<` 说明有未转义的尖括号
    const { line, column } = positionOf(text, offset + raw.indexOf("<"));
    throw new XmlError("ltInText", line, column);
  }
  parent.children.push({ type: "text", value: decodeEntities(raw) });
}

/** 解码实体：命名实体 + 十进制/十六进制数字实体；不认识的**原样保留**（不猜）。 */
export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][\w.-]*);/g, (whole, body) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** 编码实体（序列化时用）。 */
export function encodeEntities(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** 编码属性值（引号也要转义）。 */
function encodeAttr(text) {
  return encodeEntities(text).replaceAll('"', "&quot;");
}

/**
 * 序列化节点树回 XML 文本。
 *
 * `indent` 为 0 时输出紧凑形式（minify）。**混合内容不缩进**——
 * 元素里既有文本又有子元素时加换行会改变文本内容（`<b>粗</b>体` 缩进后多了空白）。
 */
export function serializeXml(children, { indent = 2, level = 0 } = {}) {
  const pad = indent > 0 ? " ".repeat(indent * level) : "";
  const out = [];
  for (const node of children) {
    if (node.type === "text") {
      // **纯空白文本节点**（标签之间的换行与缩进）不输出。
      // 否则 XML 声明与根元素之间会多出一个空行（实测踩过）。
      // 非空白的文本节点当然要保留——它可能是混合内容的一部分。
      if (node.value.trim() === "") continue;
      out.push(node.value);
      continue;
    }
    if (node.type === "comment") {
      out.push(`${pad}<!--${node.value}-->`);
      continue;
    }
    if (node.type === "cdata") {
      out.push(`${pad}<![CDATA[${node.value}]]>`);
      continue;
    }
    if (node.type === "pi") {
      out.push(`${pad}<?${node.value}?>`);
      continue;
    }
    if (node.type === "doctype") {
      out.push(`${pad}<!DOCTYPE ${node.value}>`);
      continue;
    }
    const attrs = node.attrs.map((attr) => ` ${attr.name}="${encodeAttr(attr.value)}"`).join("");
    const meaningful = node.children.filter((child) => child.type !== "text" || child.value.trim() !== "");
    const hasElementChild = node.children.some((child) => child.type !== "text");
    const hasTextChild = node.children.some((child) => child.type === "text" && child.value.trim() !== "");

    if (!node.children.length) {
      out.push(`${pad}<${node.name}${attrs}/>`);
      continue;
    }
    // 混合内容（既有文本又有子元素）：不缩进，避免改变文本
    if (hasElementChild && hasTextChild) {
      out.push(`${pad}<${node.name}${attrs}>${serializeXml(node.children, { indent: 0, level: 0 })}</${node.name}>`);
      continue;
    }
    if (indent === 0) {
      out.push(`<${node.name}${attrs}>${serializeXml(node.children, { indent: 0, level: 0 })}</${node.name}>`);
      continue;
    }
    // 只有文本：放在同一行（`<name>张三</name>` 比拆三行可读）
    if (!hasElementChild) {
      const text = meaningful.map((child) => child.value).join("");
      out.push(`${pad}<${node.name}${attrs}>${encodeEntities(text)}</${node.name}>`);
      continue;
    }
    const inner = serializeXml(node.children, { indent, level: level + 1 }).split("\n").filter((line) => line !== "");
    out.push(`${pad}<${node.name}${attrs}>`, ...inner, `${pad}</${node.name}>`);
  }
  return out.join(indent > 0 ? "\n" : "");
}

/** 格式化（美化）。解析失败时抛错，由调用方显示原因。 */
export function formatXml(input, { indent = 2 } = {}) {
  const { children } = parseXml(input);
  return serializeXml(children, { indent });
}

/** 压缩（去掉标签之间的空白与注释）。 */
export function minifyXml(input) {
  const { children } = parseXml(input);
  const strip = (nodes) =>
    nodes
      .filter((node) => node.type !== "comment" && node.type !== "pi" && node.type !== "doctype")
      .map((node) => {
        if (node.type === "text") return { ...node, value: node.value.trim() === "" ? "" : node.value };
        return { ...node, children: strip(node.children) };
      })
      .filter((node) => node.type !== "text" || node.value !== "");
  return serializeXml(strip(children), { indent: 0 });
}

/**
 * XML → JSON。
 *
 * 约定（与常见的 xml2js 风格一致，便于人读懂）：
 *   · 属性 → `@属性名`；文本 → `#text`；CDATA 也进 `#text`
 *   · 同名子元素重复出现 → 数组（出现一次时不是数组，除非 `alwaysArray`）
 *   · 纯文本无属性的元素 → 直接是字符串（`<name>张三</name>` → `"张三"`），
 *     这样最常见的报文转出来最干净
 */
export function xmlToJson(input, { attrPrefix = "@", textKey = "#text", alwaysArray = false } = {}) {
  const { root } = parseXml(input);
  if (!root) return {};
  return { [root.name]: nodeToValue(root, { attrPrefix, textKey, alwaysArray }) };
}

function nodeToValue(node, opts) {
  const { attrPrefix, textKey, alwaysArray } = opts;
  const elementChildren = node.children.filter((child) => child.type === "element");
  const text = node.children
    .filter((child) => child.type === "text" || child.type === "cdata")
    .map((child) => child.value)
    .join("")
    .trim();
  const attrs = Object.fromEntries(node.attrs.map((attr) => [`${attrPrefix}${attr.name}`, attr.value]));

  // 纯文本、无属性、无子元素 → 直接是字符串
  if (!elementChildren.length && !node.attrs.length) return text;

  const out = { ...attrs };
  if (elementChildren.length) {
    for (const child of elementChildren) {
      const value = nodeToValue(child, opts);
      if (child.name in out) {
        if (!Array.isArray(out[child.name])) out[child.name] = [out[child.name]];
        out[child.name].push(value);
      } else {
        out[child.name] = alwaysArray ? [value] : value;
      }
    }
    if (text) out[textKey] = text;
  } else if (text) {
    out[textKey] = text;
  }
  return out;
}

/** JSON → XML（xmlToJson 的逆操作，`@` 前缀与 `#text` 会被识别回来）。 */
export function jsonToXml(value, { root = "root", indent = 2, attrPrefix = "@", textKey = "#text", declaration = true } = {}) {
  // `xmlToJson` 的输出是 `{ 根名: 内容 }`。所以用户"XML → JSON → XML"时，
  // 传进来的对象外层已经带了根名——这里自动剥掉，否则会变成 `<r><r>…</r></r>`（实测踩过）。
  // 只在**恰好只有一个键且等于 root** 时剥，避免误伤真正叫 root 的子元素。
  const payload =
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && root in value
      ? value[root]
      : value;

  const build = (name, data, level) => {
    const pad = indent > 0 ? " ".repeat(indent * level) : "";
    const sep = indent > 0 ? "\n" : "";
    if (data === null || data === undefined) return `${pad}<${name}/>`;
    if (Array.isArray(data)) {
      // 数组 → 重复的同名元素
      return data.map((item) => build(name, item, level)).join(sep);
    }
    if (typeof data !== "object") {
      return `${pad}<${name}>${encodeEntities(String(data))}</${name}>`;
    }
    const attrs = Object.entries(data)
      .filter(([key]) => key.startsWith(attrPrefix))
      .map(([key, val]) => ` ${key.slice(attrPrefix.length)}="${encodeAttr(String(val ?? ""))}"`)
      .join("");
    const children = Object.entries(data).filter(([key]) => !key.startsWith(attrPrefix) && key !== textKey);
    const text = data[textKey];
    if (!children.length) {
      if (text === undefined || text === null) return `${pad}<${name}${attrs}/>`;
      return `${pad}<${name}${attrs}>${encodeEntities(String(text))}</${name}>`;
    }
    const inner = children.map(([key, val]) => build(key, val, level + 1)).join(sep);
    if (text !== undefined && text !== null) {
      // 有文本又有子元素：文本放最前，保持可读
      return `${pad}<${name}${attrs}>${encodeEntities(String(text))}${sep}${inner}${sep}${pad}</${name}>`;
    }
    return `${pad}<${name}${attrs}>${sep}${inner}${sep}${pad}</${name}>`;
  };
  const body = build(root, payload, 0);
  return declaration ? `<?xml version="1.0" encoding="UTF-8"?>\n${body}` : body;
}

/**
 * 校验：返回问题列表（错误码 + 行列），不抛错。
 * 只做**良构性**检查（well-formedness）——不做 DTD/XSD 校验（那需要 schema）。
 */
export function validateXml(input) {
  try {
    parseXml(input);
    return [];
  } catch (error) {
    if (error instanceof XmlError) {
      return [{ code: error.code, line: error.line, column: error.column, params: error.params }];
    }
    return [{ code: "unknown", line: 1, column: 1, params: { message: error?.message || String(error) } }];
  }
}

/**
 * XPath **子集**查询（不是完整 XPath 实现，界面上如实标注）。
 *
 * 支持：
 *   `/a/b`          绝对路径（第一步匹配**根元素本身**）
 *   `//b`           任意深度查找
 *   `a/b`           相对路径
 *   `@attr`         取属性值（写在末尾）
 *   `[n]`           位置（从 1 开始）
 *   `[@attr='v']`   属性条件
 *   `[child='v']`   子元素文本条件
 *   `*`             任意元素名
 * 不支持：函数、轴（ancestor:: 等）、`|` 联合、复杂布尔表达式。
 *
 * ⚠️ 位置谓词的语义**刻意简化**：`//emp[1]` 取"结果列表的第 1 个"，
 * 而标准 XPath 的含义是"每个父节点下的第 1 个 emp"。这个子集面向实际使用
 * （想取第一条记录），所以在界面上写清是子集而不是声称兼容 XPath。
 */
export function queryXPath(input, path) {
  const { root, children } = parseXml(input);
  const expression = String(path ?? "").trim();
  if (!expression || !root) return [];
  // 末尾的 @attr：取属性而不是节点
  const attrMatch = /@([\w.:-]+)$/.exec(expression);
  const wantAttr = attrMatch ? attrMatch[1] : "";
  const nodePath = wantAttr ? expression.slice(0, attrMatch.index) : expression;
  const descendant = nodePath.startsWith("//");
  const absolute = !descendant && nodePath.startsWith("/");
  const steps = nodePath.split("/").filter((step) => step !== "").map(parseStep);
  if (!steps.length) return [];

  let current;
  if (descendant) {
    const [first, ...rest] = steps;
    current = applyStep(collectDescendants(children), first);
    for (const step of rest) current = applyStep(current.flatMap(childElements), step);
  } else if (absolute) {
    // 绝对路径的第一步匹配根元素本身（不是它的子元素）——这里曾经写错，导致 /r/dept 查不到
    const [first, ...rest] = steps;
    current = first.name === "*" || first.name === root.name ? applyStep([root], first) : [];
    for (const step of rest) current = applyStep(current.flatMap(childElements), step);
  } else {
    current = [root];
    for (const step of steps) current = applyStep(current.flatMap(childElements), step);
  }

  if (wantAttr) {
    return current.map((node) => node.attrs.find((attr) => attr.name === wantAttr)?.value ?? "").filter((value) => value !== "");
  }
  return current;
}

/** 把一步（如 `emp[@id='2'][1]`）拆成名字与谓词列表。 */
function parseStep(step) {
  const nameMatch = /^([\w.:*-]+)/.exec(step);
  const name = nameMatch ? nameMatch[1] : "";
  const predicates = [];
  const re = /\[([^\]]*)\]/g;
  let match;
  while ((match = re.exec(step.slice(name.length))) !== null) {
    predicates.push(parsePredicate(match[1]));
  }
  return { name, predicates };
}

function parsePredicate(condition) {
  const text = condition.trim();
  if (/^\d+$/.test(text)) return { type: "position", n: Number(text) };
  const attr = /^@([\w.:-]+)\s*=\s*['"](.*)['"]$/.exec(text);
  if (attr) return { type: "attr", name: attr[1], value: attr[2] };
  const child = /^([\w.:-]+)\s*=\s*['"](.*)['"]$/.exec(text);
  if (child) return { type: "child", name: child[1], value: child[2] };
  return { type: "unknown" };
}

/**
 * 对一组候选节点应用一步。
 * 位置谓词**作用于过滤后的列表**（不是逐节点判断）——这是它唯一说得通的语义。
 */
function applyStep(candidates, step) {
  let list = candidates.filter((node) => step.name === "*" || node.name === step.name);
  for (const predicate of step.predicates) {
    if (predicate.type === "position") {
      list = list.slice(predicate.n - 1, predicate.n);
    } else if (predicate.type === "attr") {
      list = list.filter((node) => node.attrs.some((attr) => attr.name === predicate.name && attr.value === predicate.value));
    } else if (predicate.type === "child") {
      list = list.filter((node) =>
        childElements(node).some((child) => child.name === predicate.name && textOf(child).trim() === predicate.value)
      );
    } else {
      list = [];
    }
  }
  return list;
}

function childElements(node) {
  return (node.children || []).filter((child) => child.type === "element");
}

function collectDescendants(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === "element") {
      out.push(node);
      collectDescendants(node.children, out);
    }
  }
  return out;
}

/** 元素自身的文本内容（不含子元素文本）。 */
export function textOf(node) {
  return (node?.children || [])
    .filter((child) => child.type === "text" || child.type === "cdata")
    .map((child) => child.value)
    .join("");
}

/** 统计：元素数、最大深度、属性数、不同元素名、文本长度——看报文规模用。 */
export function statsXml(input) {
  const { children } = parseXml(input);
  let elements = 0;
  let attrs = 0;
  let depth = 0;
  let textLength = 0;
  const names = new Set();
  const walk = (nodes, level) => {
    for (const node of nodes) {
      if (node.type === "text" || node.type === "cdata") {
        textLength += node.value.length;
        continue;
      }
      if (node.type !== "element") continue;
      elements += 1;
      attrs += node.attrs.length;
      names.add(node.name);
      depth = Math.max(depth, level);
      walk(node.children, level + 1);
    }
  };
  walk(children, 1);
  return { elements, attributes: attrs, depth, distinctNames: names.size, textLength, names: [...names] };
}
