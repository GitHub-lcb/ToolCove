// JSON 树视图纯逻辑层（无 Vue、无 IO，便于单测）。
// 把解析后的 JS 值构建成节点树，并提供搜索、扁平化（按展开集）、默认展开集等纯函数。

// 值类型：object | array | string | number | boolean | null
export function valueType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // object | string | number | boolean
}

// 叶子节点的可搜索/可显示文本
export function primitivePreview(node) {
  if (node.type === "string") return node.value;
  if (node.type === "null") return "null";
  return String(node.value); // number | boolean
}

// 类型标签（用于树视图“显示类型”）：容器带子项数，基础类型显示中文名。
export function typeLabel(type, size = 0) {
  switch (type) {
    case "object": return `对象 (${size})`;
    case "array": return `数组 (${size})`;
    case "string": return "字符串";
    case "number": return "数字";
    case "boolean": return "布尔";
    case "null": return "null";
    default: return type;
  }
}

// 构建节点树。节点：{ id, key, type, value?, children[], size }
// key：父级中的键（对象为字符串键，数组为下标数字，根为 null）。
export function buildTree(value) {
  const ctx = { id: 0 };
  return makeNode(ctx, null, value);
}

function makeNode(ctx, key, value) {
  const type = valueType(value);
  const node = { id: ctx.id++, key, type, children: [], size: 0 };
  if (type === "object") {
    const keys = Object.keys(value);
    node.size = keys.length;
    node.children = keys.map((k) => makeNode(ctx, k, value[k]));
  } else if (type === "array") {
    node.size = value.length;
    node.children = value.map((item, i) => makeNode(ctx, i, item));
  } else {
    node.value = value;
  }
  return node;
}

// 搜索：命中键或叶子值（大小写不敏感）。
// 返回 { matched:Set<id>, expand:Set<id>, order:id[] }
// expand 为所有命中节点的祖先 id（用于自动展开）；order 为命中节点的先序序列（用于上一个/下一个）。
export function searchTree(root, query) {
  const matched = new Set();
  const expand = new Set();
  const order = [];
  const q = String(query || "").toLowerCase();
  if (!q || !root) return { matched, expand, order };

  walk(root, []);
  function walk(node, ancestors) {
    const keyHit = node.key !== null && String(node.key).toLowerCase().includes(q);
    const isLeaf = node.type !== "object" && node.type !== "array";
    const valHit = isLeaf && primitivePreview(node).toLowerCase().includes(q);
    if (keyHit || valHit) {
      matched.add(node.id);
      order.push(node.id);
      ancestors.forEach((a) => expand.add(a.id));
    }
    const next = ancestors.concat(node);
    node.children.forEach((c) => walk(c, next));
  }
  return { matched, expand, order };
}

// 按展开集把树先序扁平化为可渲染行列表（仅包含可见节点）。
// 行：{ id, depth, key, type, value, expandable, isOpen, size }
export function flattenTree(root, expandedSet) {
  const rows = [];
  if (!root) return rows;
  walk(root, 0);
  function walk(node, depth) {
    const expandable = node.children.length > 0;
    const isOpen = expandable && expandedSet.has(node.id);
    rows.push({
      id: node.id,
      depth,
      key: node.key,
      type: node.type,
      value: node.value,
      expandable,
      isOpen,
      size: node.size,
    });
    if (isOpen) node.children.forEach((c) => walk(c, depth + 1));
  }
  return rows;
}

// 默认展开集：展开深度 <= maxDepth 的容器节点（根 depth=0）。
export function defaultExpanded(root, maxDepth = 1) {
  const set = new Set();
  if (!root) return set;
  walk(root, 0);
  function walk(node, depth) {
    if (node.children.length > 0 && depth <= maxDepth) {
      set.add(node.id);
      node.children.forEach((c) => walk(c, depth + 1));
    }
  }
  return set;
}

// 所有容器节点 id（用于展开全部）。
export function allContainerIds(root) {
  const set = new Set();
  if (!root) return set;
  walk(root);
  function walk(node) {
    if (node.children.length > 0) {
      set.add(node.id);
      node.children.forEach(walk);
    }
  }
  return set;
}
