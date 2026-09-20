// JSON Schema 工具的纯逻辑：按 Schema 校验、从 JSON 推断 Schema、按 Schema 造样例、解读 Schema。
//
// 为什么**自己写校验器**而不是引 ajv：
//   1. 单测跑在 node 环境，引第三方库会让"校验语义"变成别人的实现，出错时只能读它源码；
//   2. 工具层一直是零依赖的纯函数（与 xmlTool / tableTool 一致），三端行为完全一致；
//   3. 可以**精确控制错误定位**（JSON Pointer 路径 + 关键字 + 参数），这是这个工具的核心价值。
//
// 支持的关键字（**是子集，界面上如实标注**）：
//   type（含类型数组与 integer 区分）、enum、const、nullable
//   properties / required / additionalProperties / minProperties / maxProperties
//   items（单 Schema 与元组两种写法）/ minItems / maxItems / uniqueItems
//   minLength / maxLength / pattern / format（email、date、date-time、uri、uuid、ipv4）
//   minimum / maximum / exclusiveMinimum / exclusiveMaximum / multipleOf
//   allOf / anyOf / oneOf / not
//   $ref（本地引用：#/definitions/... 与 #/$defs/...，支持嵌套路径，带环检测）
// 不支持：远程 $ref、$dynamicRef、if/then/else、dependentSchemas、unevaluated* 等。

/** 单个 JSON 值的类型名（与 JSON Schema 的 type 取值对齐）。 */
export function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "object") return "object";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "unknown";
}

/** 实际类型是否满足声明的类型（integer 也满足 number）。 */
function matchesType(actual, expected) {
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

/** JSON Pointer 路径拼接（`/items/0/name`）。 */
function childPath(path, key) {
  const token = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${token}`;
}

/** 解析本地 $ref（`#/definitions/x` / `#/$defs/x` / 更深路径）。 */
export function resolveRef(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#")) return null;
  const pointer = ref.slice(1);
  if (pointer === "" || pointer === "/") return root;
  if (!pointer.startsWith("/")) return null;
  let current = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current == null || typeof current !== "object") return null;
    current = Array.isArray(current) ? current[Number(token)] : current[token];
  }
  return current ?? null;
}

/** 浮点安全的倍数判断（`0.1` 的倍数不能用 `%` 直接判）。 */
function isMultipleOf(value, divisor) {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor === 0) return false;
  const ratio = value / divisor;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
}

const FORMAT_CHECKS = {
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  date: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)),
  "date-time": (value) => !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value),
  uri: (value) => /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value) || /^[a-z][a-z0-9+.-]*:\S+$/i.test(value),
  uuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  ipv4: (value) => /^(\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split(".").every((part) => Number(part) <= 255),
};

/**
 * 按 Schema 校验一个 JSON 值。
 *
 * @returns {{ valid: boolean, errors: Array<{ path, keyword, params }> }}
 *   错误用**关键字 + 参数**表达（界面按语言渲染），path 是 JSON Pointer。
 */
export function validateSchema(value, schema, options = {}) {
  const errors = [];
  const root = schema;
  const maxDepth = options.maxDepth ?? 64;

  const check = (data, node, path, depth) => {
    if (errors.length >= (options.maxErrors ?? 100)) return;
    if (depth > maxDepth) return;
    if (!node || typeof node !== "object") return;

    // $ref：解析后继续用被引用的 Schema 校验
    if (typeof node.$ref === "string") {
      const target = resolveRef(root, node.$ref);
      if (target == null) {
        errors.push({ path, keyword: "unresolvedRef", params: { ref: node.$ref } });
        return;
      }
      check(data, target, path, depth + 1);
      // $ref 与其它关键字并存时，其它关键字也要生效（2020-12 语义）
    }

    const actual = typeOf(data);

    // nullable 是 OpenAPI 风格扩展，实际报文里很常见，支持它比只认 null 类型更实用
    if (data === null && node.nullable === true) {
      // 只跳过类型相关检查，其它约束（enum/const）仍然适用
    } else if (node.type !== undefined) {
      const declared = Array.isArray(node.type) ? node.type : [node.type];
      if (!declared.some((item) => matchesType(actual, item))) {
        errors.push({ path, keyword: "type", params: { expected: declared.join(" | "), actual } });
        return; // 类型不符时后面的检查没有意义（会产生一堆噪声错误）
      }
    }

    if (node.const !== undefined && !deepEqual(data, node.const)) {
      errors.push({ path, keyword: "const", params: { expected: JSON.stringify(node.const) } });
    }
    if (Array.isArray(node.enum) && !node.enum.some((item) => deepEqual(data, item))) {
      errors.push({ path, keyword: "enum", params: { allowed: node.enum.map((item) => JSON.stringify(item)).join(", ") } });
    }

    if (actual === "string") {
      checkString(data, node, path);
    } else if (actual === "number" || actual === "integer") {
      checkNumber(data, actual, node, path);
    } else if (actual === "array") {
      checkArray(data, node, path, depth);
    } else if (actual === "object") {
      checkObject(data, node, path, depth);
    }

    // 组合关键字
    if (Array.isArray(node.allOf)) {
      // allOf 的失败信息本身就是具体原因，直接展开即可，不需要额外再补一条"allOf 失败"
      for (const sub of node.allOf) check(data, sub, path, depth + 1);
    }
    if (Array.isArray(node.anyOf) && !node.anyOf.some((sub) => passes(data, sub, depth))) {
      errors.push({ path, keyword: "anyOf", params: { count: node.anyOf.length } });
    }
    if (Array.isArray(node.oneOf)) {
      const matched = node.oneOf.filter((sub) => passes(data, sub, depth)).length;
      if (matched !== 1) errors.push({ path, keyword: "oneOf", params: { matched, count: node.oneOf.length } });
    }
    if (node.not && passes(data, node.not, depth)) {
      errors.push({ path, keyword: "not", params: {} });
    }
  };

  /**
   * 试跑一个子 Schema，只关心是否通过（用于 anyOf / oneOf / not）。
   *
   * ⚠️ 必须把试跑产生的错误**收起来再还原**：这些子 Schema 的失败不是最终结论
   * （anyOf 只要有一个通过就算通过），直接留在 errors 里会报出一堆假错误。
   */
  const passes = (data, sub, depth) => {
    const saved = errors.slice();
    errors.length = 0;
    check(data, sub, "", depth + 1);
    const ok = errors.length === 0;
    errors.length = 0;
    errors.push(...saved);
    return ok;
  };

  const checkString = (data, node, path) => {
    const length = Array.from(data).length; // 按码点算，中文才不会被算成两倍
    if (node.minLength !== undefined && length < node.minLength) {
      errors.push({ path, keyword: "minLength", params: { min: node.minLength, actual: length } });
    }
    if (node.maxLength !== undefined && length > node.maxLength) {
      errors.push({ path, keyword: "maxLength", params: { max: node.maxLength, actual: length } });
    }
    if (typeof node.pattern === "string") {
      let ok = false;
      try {
        ok = new RegExp(node.pattern, "u").test(data);
      } catch {
        errors.push({ path, keyword: "badPattern", params: { pattern: node.pattern } });
        return;
      }
      if (!ok) errors.push({ path, keyword: "pattern", params: { pattern: node.pattern } });
    }
    if (typeof node.format === "string") {
      const checker = FORMAT_CHECKS[node.format];
      // 不认识的 format 不报错（标准允许忽略未知 format，报错会误伤）
      if (checker && !checker(data)) errors.push({ path, keyword: "format", params: { format: node.format } });
    }
  };

  const checkNumber = (data, actual, node, path) => {
    if (node.minimum !== undefined && data < node.minimum) {
      errors.push({ path, keyword: "minimum", params: { min: node.minimum, actual: data } });
    }
    if (node.maximum !== undefined && data > node.maximum) {
      errors.push({ path, keyword: "maximum", params: { max: node.maximum, actual: data } });
    }
    // 4.0 起 exclusiveMinimum/Maximum 是数值（旧版是布尔，这里按新版处理并兼容布尔写法）
    if (typeof node.exclusiveMinimum === "number" && data <= node.exclusiveMinimum) {
      errors.push({ path, keyword: "exclusiveMinimum", params: { min: node.exclusiveMinimum, actual: data } });
    }
    if (typeof node.exclusiveMaximum === "number" && data >= node.exclusiveMaximum) {
      errors.push({ path, keyword: "exclusiveMaximum", params: { max: node.exclusiveMaximum, actual: data } });
    }
    if (node.multipleOf !== undefined && !isMultipleOf(data, node.multipleOf)) {
      errors.push({ path, keyword: "multipleOf", params: { divisor: node.multipleOf, actual: data } });
    }
    void actual;
  };

  const checkArray = (data, node, path, depth) => {
    if (node.minItems !== undefined && data.length < node.minItems) {
      errors.push({ path, keyword: "minItems", params: { min: node.minItems, actual: data.length } });
    }
    if (node.maxItems !== undefined && data.length > node.maxItems) {
      errors.push({ path, keyword: "maxItems", params: { max: node.maxItems, actual: data.length } });
    }
    if (node.uniqueItems === true) {
      const seen = new Set();
      data.forEach((item, index) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) errors.push({ path: childPath(path, index), keyword: "uniqueItems", params: {} });
        seen.add(key);
      });
    }
    if (Array.isArray(node.items)) {
      // 元组写法：按位置逐个校验
      data.forEach((item, index) => {
        const sub = node.items[index];
        if (sub) check(item, sub, childPath(path, index), depth + 1);
        else if (node.additionalItems === false) {
          errors.push({ path: childPath(path, index), keyword: "additionalItems", params: {} });
        } else if (node.additionalItems && typeof node.additionalItems === "object") {
          check(item, node.additionalItems, childPath(path, index), depth + 1);
        }
      });
    } else if (node.items && typeof node.items === "object") {
      data.forEach((item, index) => check(item, node.items, childPath(path, index), depth + 1));
    }
  };

  const checkObject = (data, node, path, depth) => {
    const keys = Object.keys(data);
    if (node.minProperties !== undefined && keys.length < node.minProperties) {
      errors.push({ path, keyword: "minProperties", params: { min: node.minProperties, actual: keys.length } });
    }
    if (node.maxProperties !== undefined && keys.length > node.maxProperties) {
      errors.push({ path, keyword: "maxProperties", params: { max: node.maxProperties, actual: keys.length } });
    }
    if (Array.isArray(node.required)) {
      for (const key of node.required) {
        if (!(key in data)) errors.push({ path, keyword: "required", params: { field: key } });
      }
    }
    const properties = node.properties && typeof node.properties === "object" ? node.properties : {};
    for (const [key, sub] of Object.entries(properties)) {
      if (key in data) check(data[key], sub, childPath(path, key), depth + 1);
    }
    // 未声明的字段
    for (const key of keys) {
      if (key in properties) continue;
      if (node.additionalProperties === false) {
        errors.push({ path: childPath(path, key), keyword: "additionalProperties", params: { field: key } });
      } else if (node.additionalProperties && typeof node.additionalProperties === "object") {
        check(data[key], node.additionalProperties, childPath(path, key), depth + 1);
      }
    }
  };

  check(value, schema, "", 0);
  return { valid: errors.length === 0, errors };
}

/** 深比较（JSON 语义）。 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  if (a && typeof a === "object") {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * 从 JSON 值**推断** Schema。
 *
 * 数组会把所有元素的 Schema 合并（类型取并集、required 取交集）——
 * 这是推断里最容易做错的地方：只看第一个元素会把后续元素的字段漏掉。
 */
export function inferSchema(value, options = {}) {
  const required = options.required !== false;
  const depth = options.depth ?? 0;

  const build = (data, level) => {
    const type = typeOf(data);
    if (type === "array") {
      if (!data.length) return { type: "array", items: {} };
      const itemSchemas = data.map((item) => build(item, level + 1));
      return { type: "array", items: mergeSchemas(itemSchemas) };
    }
    if (type === "object") {
      const properties = {};
      const keys = Object.keys(data);
      for (const key of keys) properties[key] = build(data[key], level + 1);
      const schema = { type: "object", properties };
      // required 取所有同名对象的交集：只有每个对象都有这个字段时才算必填
      if (required) schema.required = keys;
      return schema;
    }
    if (type === "string") {
      const schema = { type: "string" };
      const format = detectFormat(data);
      if (format) schema.format = format;
      return schema;
    }
    if (type === "integer") return { type: "integer" };
    return { type };
  };

  const schema = build(value, depth);
  // 对象数组的 required 要按交集收紧
  return tightenRequired(schema, value);
}

/** 对象数组里，required 取所有元素的交集。 */
function tightenRequired(schema, value) {
  if (typeOf(value) !== "array" || !value.length) return schema;
  const objects = value.filter((item) => typeOf(item) === "object");
  if (objects.length !== value.length) return schema;
  const common = Object.keys(objects[0]).filter((key) => objects.every((item) => key in item));
  const items = { ...(schema.items || {}) };
  if (items.type === "object" && Array.isArray(items.required)) {
    items.required = common;
    // 数组里可能没有公共字段，那就不该有 required
    if (!common.length) delete items.required;
  }
  return { ...schema, items };
}

/** 合并多个 Schema（数组元素推断用）：类型取并集、属性合并、required 取交集。 */
export function mergeSchemas(schemas) {
  const list = (schemas || []).filter((item) => item && typeof item === "object");
  if (!list.length) return {};
  if (list.length === 1) return list[0];

  const types = [...new Set(list.map((item) => item.type).filter(Boolean))];
  const merged = types.length === 1 ? { type: types[0] } : { type: types };

  // 都是对象：合并 properties，required 取交集
  if (types.length === 1 && types[0] === "object") {
    const properties = {};
    const allKeys = [...new Set(list.flatMap((item) => Object.keys(item.properties || {})))];
    for (const key of allKeys) {
      const candidates = list.map((item) => item.properties?.[key]).filter(Boolean);
      properties[key] = mergeSchemas(candidates);
    }
    merged.properties = properties;
    const required = list
      .map((item) => item.required || [])
      .reduce((acc, cur) => acc.filter((key) => cur.includes(key)), allKeys);
    if (required.length) merged.required = required;
  }
  // 都是数组：合并 items
  if (types.length === 1 && types[0] === "array") {
    merged.items = mergeSchemas(list.map((item) => item.items).filter(Boolean));
  }
  // 字符串：format 只有在**所有**元素都一致时才保留。
  // 若其中一个不像日期，就不能断言是日期——否则推断出的 Schema 会拒绝真实存在的数据
  // （`["2026-01-01", "hello"]` 推出 format:date 的话，"hello" 就"不合法"了，这显然错了）。
  const formats = list.map((item) => item.format || "");
  if (formats.length && formats.every((item) => item && item === formats[0])) merged.format = formats[0];
  return merged;
}

/** 按值猜 format（只在**明显**匹配时给，避免误报）。 */
export function detectFormat(value) {
  if (typeof value !== "string" || !value) return "";
  if (FORMAT_CHECKS.uuid(value)) return "uuid";
  if (FORMAT_CHECKS["date-time"](value)) return "date-time";
  if (FORMAT_CHECKS.date(value)) return "date";
  if (FORMAT_CHECKS.email(value)) return "email";
  if (FORMAT_CHECKS.ipv4(value)) return "ipv4";
  if (FORMAT_CHECKS.uri(value)) return "uri";
  return "";
}

/**
 * 按 Schema 造一个满足它的样例值（用于"拿样例去试接口"）。
 *
 * 优先用 Schema 里的 `default` 与 `examples`——那是作者明确给的值，比猜出来的有意义。
 */
export function sampleFromSchema(schema, options = {}) {
  const root = schema;
  const depth = options.depth ?? 0;
  if (depth > 16) return null;

  const build = (node, level) => {
    if (!node || typeof node !== "object") return null;
    if (node.default !== undefined) return node.default;
    if (Array.isArray(node.examples) && node.examples.length) return node.examples[0];
    if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
    if (node.const !== undefined) return node.const;
    if (typeof node.$ref === "string") {
      const target = resolveRef(root, node.$ref);
      return target ? build(target, level + 1) : null;
    }
    if (Array.isArray(node.allOf)) {
      // allOf：把各分支合并成一个对象样例
      const parts = node.allOf.map((sub) => build(sub, level + 1)).filter((item) => item && typeof item === "object");
      if (parts.length) return Object.assign({}, ...parts);
    }
    if (Array.isArray(node.oneOf) && node.oneOf.length) return build(node.oneOf[0], level + 1);
    if (Array.isArray(node.anyOf) && node.anyOf.length) return build(node.anyOf[0], level + 1);

    const type = Array.isArray(node.type) ? node.type[0] : node.type;
    switch (type) {
      case "object": {
        const out = {};
        for (const [key, sub] of Object.entries(node.properties || {})) out[key] = build(sub, level + 1);
        // additionalProperties 是对象时给一个示例字段，便于看出"这里可以放自定义键"
        if (node.additionalProperties && typeof node.additionalProperties === "object") {
          out.extra = build(node.additionalProperties, level + 1);
        }
        return out;
      }
      case "array": {
        const count = Math.max(1, Math.min(node.minItems ?? 1, 3));
        const itemSchema = Array.isArray(node.items) ? node.items[0] : node.items;
        return Array.from({ length: count }, () => build(itemSchema, level + 1));
      }
      case "string": {
        if (node.format === "email") return "user@example.com";
        if (node.format === "date") return "2026-01-01";
        if (node.format === "date-time") return "2026-01-01T00:00:00Z";
        if (node.format === "uri") return "https://example.com";
        if (node.format === "uuid") return "00000000-0000-4000-8000-000000000000";
        if (node.format === "ipv4") return "127.0.0.1";
        const base = "string";
        // 满足 minLength/maxLength（否则造出来的样例自己就不合法）
        const min = node.minLength ?? 0;
        return base.padEnd(Math.max(min, base.length), "x").slice(0, node.maxLength ?? undefined);
      }
      case "integer":
        return clampNumber(node, 1);
      case "number":
        return clampNumber(node, 1.5);
      case "boolean":
        return true;
      case "null":
        return null;
      default:
        return null;
    }
  };

  const clampNumber = (node, fallback) => {
    let value = fallback;
    if (typeof node.minimum === "number") value = Math.max(value, node.minimum);
    if (typeof node.exclusiveMinimum === "number") value = Math.max(value, node.exclusiveMinimum + 1);
    if (typeof node.maximum === "number") value = Math.min(value, node.maximum);
    if (typeof node.exclusiveMaximum === "number") value = Math.min(value, node.exclusiveMaximum - 1);
    if (typeof node.multipleOf === "number" && node.multipleOf > 0) {
      value = Math.ceil(value / node.multipleOf) * node.multipleOf;
    }
    return node.type === "integer" ? Math.round(value) : value;
  };

  return build(schema, 0);
}

/**
 * 解读 Schema：列出字段路径与类型（"这份 Schema 要求什么"）。
 * 用于界面上的结构视图——直接看 JSON 原文很难快速知道有哪些字段。
 */
export function summarizeSchema(schema, options = {}) {
  const root = schema;
  const rows = [];
  const maxDepth = options.maxDepth ?? 8;
  // 同一路径只保留一行，但**允许后来者替换**：
  //   · 先推的是带注解的父级行（required/format），后来叶子节点的空注解不该覆盖它；
  //   · 先推的是空注解（比如 $ref 子节点），后来解析出「↻ 递归」标记时应当替换上来。
  // 所以规则是"信息更全者胜"，而不是简单的先到先得（两种都试过，都会丢信息）。
  const byPath = new Map();
  const push = (row) => {
    const existing = byPath.get(row.path);
    if (!existing) {
      byPath.set(row.path, row);
      rows.push(row);
      return;
    }
    const better = (!existing.note && row.note) || (!existing.type && row.type);
    if (!better) return;
    byPath.set(row.path, row);
    rows[rows.indexOf(existing)] = row;
  };

  const walk = (node, path, depth, seen) => {
    if (!node || typeof node !== "object" || depth > maxDepth) return;
    if (typeof node.$ref === "string") {
      if (seen.has(node.$ref)) {
        push({ path, type: `↻ ${node.$ref}`, note: "recursive" });
        return;
      }
      const target = resolveRef(root, node.$ref);
      if (target) {
        const nextSeen = new Set(seen);
        nextSeen.add(node.$ref);
        walk(target, path, depth, nextSeen);
      }
      return;
    }
    const type = Array.isArray(node.type) ? node.type.join("|") : node.type || "";
    if (node.type === "object" || node.properties) {
      const required = new Set(node.required || []);
      for (const [key, sub] of Object.entries(node.properties || {})) {
        const childType = Array.isArray(sub.type) ? sub.type.join("|") : sub.type || "";
        const extras = [];
        if (required.has(key)) extras.push("required");
        if (sub.format) extras.push(`format=${sub.format}`);
        if (sub.enum) extras.push(`enum(${sub.enum.length})`);
        if (sub.nullable) extras.push("nullable");
        const child = childPath(path, key);
        push({ path: child, type: childType, note: extras.join(" ") });
        walk(sub, child, depth + 1, seen);
      }
      if (node.additionalProperties === false) push({ path: `${path}/*`, type: "—", note: "no extra fields" });
      return;
    }
    if (node.type === "array" || node.items) {
      const itemSchema = Array.isArray(node.items) ? node.items[0] : node.items;
      const itemType = itemSchema ? (Array.isArray(itemSchema.type) ? itemSchema.type.join("|") : itemSchema.type || "") : "";
      const itemPath = `${path}[]`;
      push({ path: itemPath, type: itemType || "any", note: "" });
      if (itemSchema) walk(itemSchema, itemPath, depth + 1, seen);
      return;
    }
    if (type) push({ path: path || "(root)", type, note: "" });
  };

  walk(schema, "", 0, new Set());
  return rows;
}
