// JSON Schema 工具的纯逻辑单测。
//
// 校验器是自己写的，所以它本身是最大的风险点：错误定位、组合关键字、$ref 环、
// 浮点倍数、以及"造出来的样例自己是否合法"，都必须逐条钉住。
import { describe, expect, it } from "vitest";
import {
  deepEqual,
  detectFormat,
  inferSchema,
  mergeSchemas,
  resolveRef,
  sampleFromSchema,
  summarizeSchema,
  typeOf,
  validateSchema,
} from "./jsonSchema.js";

/** 取第一条错误的 keyword（多数用例只关心"报了哪类错"）。 */
const kw = (value, schema) => validateSchema(value, schema).errors[0]?.keyword;

describe("类型判定", () => {
  it("区分 integer 与 number（JSON Schema 里这是两回事）", () => {
    expect(typeOf(1)).toBe("integer");
    expect(typeOf(1.5)).toBe("number");
    expect(typeOf("1")).toBe("string");
    expect(typeOf(null)).toBe("null");
    expect(typeOf([])).toBe("array");
    expect(typeOf({})).toBe("object");
    expect(typeOf(true)).toBe("boolean");
  });
});

describe("type 校验", () => {
  it("基本类型", () => {
    expect(validateSchema("x", { type: "string" }).valid).toBe(true);
    expect(validateSchema(1, { type: "string" }).valid).toBe(false);
    expect(kw(1, { type: "string" })).toBe("type");
  });

  it("integer 满足 number，但 number 不满足 integer", () => {
    expect(validateSchema(1, { type: "number" }).valid).toBe(true);
    expect(validateSchema(1.5, { type: "integer" }).valid).toBe(false);
  });

  it("类型数组：任一匹配即可", () => {
    expect(validateSchema("x", { type: ["string", "null"] }).valid).toBe(true);
    expect(validateSchema(null, { type: ["string", "null"] }).valid).toBe(true);
    expect(validateSchema(1, { type: ["string", "null"] }).valid).toBe(false);
  });

  it("类型不符时不再报后续错误（避免一堆噪声）", () => {
    const result = validateSchema(123, { type: "string", minLength: 5, pattern: "^a" });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].keyword).toBe("type");
  });

  it("nullable 让 null 通过（OpenAPI 风格扩展）", () => {
    expect(validateSchema(null, { type: "string", nullable: true }).valid).toBe(true);
    expect(validateSchema(null, { type: "string" }).valid).toBe(false);
  });
});

describe("字符串约束", () => {
  it("长度按码点算（中文不能被算成两倍）", () => {
    // 「中文」是 2 个字符，不是 4 个
    expect(validateSchema("中文", { type: "string", maxLength: 2 }).valid).toBe(true);
    expect(validateSchema("中文", { type: "string", minLength: 3 }).valid).toBe(false);
  });

  it("pattern", () => {
    expect(validateSchema("abc123", { type: "string", pattern: "^[a-z]+\\d+$" }).valid).toBe(true);
    expect(kw("ABC", { type: "string", pattern: "^[a-z]+$" })).toBe("pattern");
  });

  it("非法正则明确报错（而不是静默通过）", () => {
    expect(kw("x", { type: "string", pattern: "[" })).toBe("badPattern");
  });

  it("format：认识的才校验，不认识的忽略（标准允许）", () => {
    expect(validateSchema("a@b.com", { type: "string", format: "email" }).valid).toBe(true);
    expect(kw("not-an-email", { type: "string", format: "email" })).toBe("format");
    expect(validateSchema("随便什么", { type: "string", format: "unknown-format" }).valid).toBe(true);
  });

  it("format：日期与时间", () => {
    expect(validateSchema("2026-01-01", { type: "string", format: "date" }).valid).toBe(true);
    expect(validateSchema("2026-13-45", { type: "string", format: "date" }).valid).toBe(false);
    expect(validateSchema("2026-01-01T10:00:00Z", { type: "string", format: "date-time" }).valid).toBe(true);
  });

  it("format：uuid 与 ipv4", () => {
    expect(validateSchema("00000000-0000-4000-8000-000000000000", { type: "string", format: "uuid" }).valid).toBe(true);
    expect(validateSchema("127.0.0.1", { type: "string", format: "ipv4" }).valid).toBe(true);
    expect(validateSchema("999.1.1.1", { type: "string", format: "ipv4" }).valid).toBe(false);
  });
});

describe("数值约束", () => {
  it("minimum / maximum", () => {
    expect(validateSchema(5, { type: "integer", minimum: 5 }).valid).toBe(true);
    expect(kw(4, { type: "integer", minimum: 5 })).toBe("minimum");
    expect(kw(11, { type: "integer", maximum: 10 })).toBe("maximum");
  });

  it("exclusiveMinimum / exclusiveMaximum（4.0 起的数值写法）", () => {
    expect(validateSchema(6, { type: "integer", exclusiveMinimum: 5 }).valid).toBe(true);
    expect(kw(5, { type: "integer", exclusiveMinimum: 5 })).toBe("exclusiveMinimum");
    expect(kw(10, { type: "integer", exclusiveMaximum: 10 })).toBe("exclusiveMaximum");
  });

  it("multipleOf 对小数也要正确（0.1 的倍数不能用 % 直接判）", () => {
    expect(validateSchema(0.3, { type: "number", multipleOf: 0.1 }).valid).toBe(true);
    expect(validateSchema(1.5, { type: "number", multipleOf: 0.5 }).valid).toBe(true);
    expect(kw(0.35, { type: "number", multipleOf: 0.1 })).toBe("multipleOf");
  });
});

describe("数组约束", () => {
  it("items 单 Schema：逐元素校验并给出下标路径", () => {
    const result = validateSchema(["a", 1, "c"], { type: "array", items: { type: "string" } });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe("/1");
  });

  it("items 元组写法 + additionalItems:false", () => {
    const schema = { type: "array", items: [{ type: "string" }, { type: "integer" }], additionalItems: false };
    expect(validateSchema(["a", 1], schema).valid).toBe(true);
    expect(validateSchema(["a", 1, "extra"], schema).valid).toBe(false);
    expect(kw(["a", 1, "extra"], schema)).toBe("additionalItems");
  });

  it("minItems / maxItems", () => {
    expect(validateSchema([1], { type: "array", minItems: 2 }).valid).toBe(false);
    expect(validateSchema([1, 2, 3], { type: "array", maxItems: 2 }).valid).toBe(false);
  });

  it("uniqueItems：重复元素报出重复项的下标", () => {
    const result = validateSchema([1, 2, 1], { type: "array", uniqueItems: true });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe("/2");
  });

  it("uniqueItems 对对象元素也有效", () => {
    expect(validateSchema([{ a: 1 }, { a: 1 }], { type: "array", uniqueItems: true }).valid).toBe(false);
    expect(validateSchema([{ a: 1 }, { a: 2 }], { type: "array", uniqueItems: true }).valid).toBe(true);
  });
});

describe("对象约束", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name"],
    additionalProperties: false,
  };

  it("required 缺失报出字段名", () => {
    const result = validateSchema({ age: 1 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe("required");
    expect(result.errors[0].params.field).toBe("name");
  });

  it("未声明字段被 additionalProperties:false 拦住，路径精确到字段", () => {
    const result = validateSchema({ name: "a", extra: 1 }, schema);
    expect(result.errors[0].keyword).toBe("additionalProperties");
    expect(result.errors[0].path).toBe("/extra");
  });

  it("嵌套字段的错误路径是完整指针", () => {
    const nested = { type: "object", properties: { user: { type: "object", properties: { age: { type: "integer" } } } } };
    const result = validateSchema({ user: { age: "x" } }, nested);
    expect(result.errors[0].path).toBe("/user/age");
  });

  it("additionalProperties 是 Schema 时校验额外字段", () => {
    const withSchema = { type: "object", additionalProperties: { type: "integer" } };
    expect(validateSchema({ any: 1 }, withSchema).valid).toBe(true);
    expect(validateSchema({ any: "x" }, withSchema).valid).toBe(false);
  });

  it("minProperties / maxProperties", () => {
    expect(validateSchema({}, { type: "object", minProperties: 1 }).valid).toBe(false);
    expect(validateSchema({ a: 1, b: 2 }, { type: "object", maxProperties: 1 }).valid).toBe(false);
  });

  it("字段名里的 / 与 ~ 在路径里被转义（JSON Pointer 规范）", () => {
    const result = validateSchema({ "a/b": 1 }, { type: "object", properties: { "a/b": { type: "string" } } });
    expect(result.errors[0].path).toBe("/a~1b");
  });
});

describe("enum 与 const", () => {
  it("enum", () => {
    expect(validateSchema("a", { enum: ["a", "b"] }).valid).toBe(true);
    expect(kw("c", { enum: ["a", "b"] })).toBe("enum");
  });

  it("const", () => {
    expect(validateSchema("v1", { const: "v1" }).valid).toBe(true);
    expect(kw("v2", { const: "v1" })).toBe("const");
  });

  it("deepEqual 按 JSON 语义比较", () => {
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
  });
});

describe("$ref", () => {
  const schema = {
    type: "object",
    properties: { user: { $ref: "#/$defs/User" } },
    $defs: {
      User: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  };

  it("本地引用能解析并校验", () => {
    expect(validateSchema({ user: { name: "a" } }, schema).valid).toBe(true);
    const result = validateSchema({ user: {} }, schema);
    expect(result.valid).toBe(false);
    // 路径要指到实际位置（而不是 $defs 里）
    expect(result.errors[0].path).toBe("/user");
  });

  it("resolveRef 支持 definitions 与深层路径", () => {
    const doc = { definitions: { a: { b: { type: "string" } } } };
    expect(resolveRef(doc, "#/definitions/a/b")).toEqual({ type: "string" });
    expect(resolveRef(doc, "#/definitions/nope")).toBeNull();
    expect(resolveRef(doc, "http://remote/x")).toBeNull();
  });

  it("指向不存在的引用要报错（而不是静默通过）", () => {
    expect(kw({}, { $ref: "#/$defs/Missing" })).toBe("unresolvedRef");
  });

  it("循环引用不会无限递归", () => {
    const cyclic = {
      type: "object",
      properties: { self: { $ref: "#" } },
    };
    const value = { self: { self: {} } };
    const result = validateSchema(value, cyclic);
    expect(result.valid).toBe(true); // 不崩、不死循环
  });

  it("$ref 与其它关键字并存时都生效", () => {
    const mixed = {
      $defs: { S: { type: "string" } },
      properties: { a: { $ref: "#/$defs/S", minLength: 3 } },
      type: "object",
    };
    expect(validateSchema({ a: "abc" }, mixed).valid).toBe(true);
    expect(validateSchema({ a: "ab" }, mixed).valid).toBe(false);
  });
});

describe("组合关键字", () => {
  it("allOf：全部满足才行，失败信息是具体原因", () => {
    const schema = { allOf: [{ type: "string" }, { minLength: 3 }] };
    expect(validateSchema("abc", schema).valid).toBe(true);
    const result = validateSchema("ab", schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe("minLength");
  });

  it("anyOf：任一满足即可，且不残留失败分支的错误", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "integer" }] };
    expect(validateSchema("x", schema).valid).toBe(true);
    expect(validateSchema(1, schema).valid).toBe(true);
    expect(validateSchema([], schema).valid).toBe(false);
    // 关键：通过时不能留下任何错误
    expect(validateSchema("x", schema).errors).toHaveLength(0);
  });

  it("oneOf：恰好一个满足", () => {
    const schema = { oneOf: [{ type: "integer" }, { minimum: 5 }] };
    expect(validateSchema(3, schema).valid).toBe(true); // 只满足 integer
    expect(validateSchema(7, schema).valid).toBe(false); // 两个都满足
    const result = validateSchema(7, schema);
    expect(result.errors[0].keyword).toBe("oneOf");
    expect(result.errors[0].params.matched).toBe(2);
  });

  it("not：不能匹配", () => {
    expect(validateSchema("x", { not: { type: "integer" } }).valid).toBe(true);
    expect(kw(1, { not: { type: "integer" } })).toBe("not");
  });
});

describe("从 JSON 推断 Schema", () => {
  it("基本类型", () => {
    expect(inferSchema("x")).toEqual({ type: "string" });
    expect(inferSchema(1)).toEqual({ type: "integer" });
    expect(inferSchema(1.5)).toEqual({ type: "number" });
    expect(inferSchema(true)).toEqual({ type: "boolean" });
    expect(inferSchema(null)).toEqual({ type: "null" });
  });

  it("对象：字段与 required", () => {
    const schema = inferSchema({ name: "a", age: 1 });
    expect(schema.type).toBe("object");
    expect(schema.properties.name).toEqual({ type: "string" });
    expect(schema.properties.age).toEqual({ type: "integer" });
    expect(schema.required.sort()).toEqual(["age", "name"]);
  });

  it("对象数组：required 取**交集**（只看第一个元素会漏字段）", () => {
    const schema = inferSchema([{ a: 1, b: 2 }, { a: 3 }]);
    expect(schema.type).toBe("array");
    // b 不是每个元素都有，所以不该是必填
    expect(schema.items.required).toEqual(["a"]);
    expect(Object.keys(schema.items.properties).sort()).toEqual(["a", "b"]);
  });

  it("类型不一致的元素合并成类型数组", () => {
    expect(inferSchema([1, "a"]).items.type.sort()).toEqual(["integer", "string"]);
  });

  it("空数组的 items 是空 Schema", () => {
    expect(inferSchema([])).toEqual({ type: "array", items: {} });
  });

  it("识别常见 format", () => {
    expect(inferSchema("a@b.com").format).toBe("email");
    expect(inferSchema("2026-01-01").format).toBe("date");
    expect(inferSchema("00000000-0000-4000-8000-000000000000").format).toBe("uuid");
    expect(inferSchema("普通文本").format).toBeUndefined();
  });

  it("嵌套结构", () => {
    const schema = inferSchema({ user: { tags: ["a"] } });
    expect(schema.properties.user.properties.tags.type).toBe("array");
    expect(schema.properties.user.properties.tags.items).toEqual({ type: "string" });
  });

  it("mergeSchemas：对象合并保留全部字段，required 取交集", () => {
    const merged = mergeSchemas([
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", properties: { b: { type: "integer" } }, required: ["b"] },
    ]);
    expect(Object.keys(merged.properties).sort()).toEqual(["a", "b"]);
    expect(merged.required).toBeUndefined(); // 没有公共字段
  });

  it("mergeSchemas：format 只在一致时保留", () => {
    expect(mergeSchemas([{ type: "string", format: "date" }, { type: "string", format: "date" }]).format).toBe("date");
    expect(mergeSchemas([{ type: "string", format: "date" }, { type: "string" }]).format).toBeUndefined();
  });

  it("detectFormat 只在明显匹配时给", () => {
    expect(detectFormat("")).toBe("");
    expect(detectFormat("hello")).toBe("");
    expect(detectFormat("https://example.com/x")).toBe("uri");
  });
});

describe("按 Schema 造样例", () => {
  it("优先用 default 与 examples", () => {
    expect(sampleFromSchema({ type: "string", default: "abc" })).toBe("abc");
    expect(sampleFromSchema({ type: "string", examples: ["first", "second"] })).toBe("first");
  });

  it("enum 取第一个，const 用它本身", () => {
    expect(sampleFromSchema({ enum: ["a", "b"] })).toBe("a");
    expect(sampleFromSchema({ const: 42 })).toBe(42);
  });

  it("对象按 properties 生成", () => {
    const sample = sampleFromSchema({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" }, ok: { type: "boolean" } },
    });
    expect(Object.keys(sample)).toEqual(["name", "age", "ok"]);
    expect(typeof sample.age).toBe("number");
  });

  it("数组至少一个元素", () => {
    expect(sampleFromSchema({ type: "array", items: { type: "string" } })).toHaveLength(1);
    expect(sampleFromSchema({ type: "array", minItems: 3, items: { type: "integer" } })).toHaveLength(3);
  });

  it("数字满足上下界与倍数", () => {
    expect(sampleFromSchema({ type: "integer", minimum: 10 })).toBeGreaterThanOrEqual(10);
    expect(sampleFromSchema({ type: "integer", maximum: -5 })).toBeLessThanOrEqual(-5);
    expect(sampleFromSchema({ type: "number", multipleOf: 5 })).toBe(5);
  });

  it("字符串满足 minLength", () => {
    const sample = sampleFromSchema({ type: "string", minLength: 12 });
    expect(sample.length).toBeGreaterThanOrEqual(12);
  });

  it("format 给出可读的样例", () => {
    expect(sampleFromSchema({ type: "string", format: "email" })).toContain("@");
    expect(sampleFromSchema({ type: "string", format: "date" })).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("$ref 能解析后造样例", () => {
    const schema = { $defs: { S: { type: "string", default: "x" } }, $ref: "#/$defs/S" };
    expect(sampleFromSchema(schema)).toBe("x");
  });

  it("**造出来的样例必须自己合法**（往返自检，这是最有价值的一条）", () => {
    const schemas = [
      { type: "object", properties: { a: { type: "string" }, b: { type: "integer", minimum: 5 } }, required: ["a", "b"] },
      { type: "array", minItems: 2, items: { type: "object", properties: { x: { type: "boolean" } }, required: ["x"] } },
      { type: "string", minLength: 8 },
      { type: "integer", minimum: 10, maximum: 20 },
      { type: "number", multipleOf: 0.5 },
      { enum: ["a", "b"] },
      { allOf: [{ type: "object", properties: { a: { type: "string" } } }] },
      { oneOf: [{ type: "string" }, { type: "integer" }] },
      { type: "object", properties: { u: { $ref: "#/$defs/U" } }, required: ["u"], $defs: { U: { type: "string", format: "email" } } },
    ];
    for (const schema of schemas) {
      const sample = sampleFromSchema(schema);
      const result = validateSchema(sample, schema);
      expect(result.valid, `样例不合法：${JSON.stringify(schema)} → ${JSON.stringify(sample)} 错误=${JSON.stringify(result.errors)}`).toBe(true);
    }
  });
});

describe("解读 Schema", () => {
  it("列出字段路径、类型与标记", () => {
    const rows = summarizeSchema({
      type: "object",
      properties: { id: { type: "integer" }, name: { type: "string", format: "email" }, tags: { type: "array", items: { type: "string" } } },
      required: ["id"],
    });
    const byPath = Object.fromEntries(rows.map((row) => [row.path, row]));
    expect(byPath["/id"].note).toContain("required");
    expect(byPath["/name"].note).toContain("format=email");
    expect(byPath["/tags"].type).toBe("array");
    expect(rows.some((row) => row.path === "/tags[]")).toBe(true);
  });

  it("标注 additionalProperties:false", () => {
    const rows = summarizeSchema({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false });
    expect(rows.some((row) => row.note.includes("no extra fields"))).toBe(true);
  });

  it("循环引用标成递归而不是无限展开", () => {
    const schema = { type: "object", properties: { child: { $ref: "#" } } };
    const rows = summarizeSchema(schema);
    expect(rows.some((row) => row.note === "recursive")).toBe(true);
  });
});
