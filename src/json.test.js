import { describe, it, expect } from "vitest";
import { formatJson, minifyJson, escapeJson, unescapeJson, locateJsonError, jsonStats, maskJson, maskJsonText } from "./json.js";

describe("formatJson", () => {
  it("formats objects with indent 2 by default", () => {
    const r = formatJson('{"a":1,"b":[2,3]}', 2);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    expect(r.error).toBe(null);
  });
  it("supports indent 4", () => {
    const r = formatJson('{"a":1}', 4);
    expect(r.output).toBe('{\n    "a": 1\n}');
  });
  it("keeps non-ASCII chars (no \\uXXXX escaping)", () => {
    // {"名":"值"} written as unicode escapes to keep source pure ASCII
    const r = formatJson('{"\u540d":"\u503c"}', 2);
    expect(r.output).toBe('{\n  "\u540d": "\u503c"\n}');
  });
  it("empty input is treated as failure with an error", () => {
    const r = formatJson("", 2);
    expect(r.ok).toBe(false);
    expect(r.output).toBe("");
    expect(r.error).not.toBe(null);
  });
  it("invalid JSON returns ok:false with line/column (missing comma)", () => {
    const r = formatJson('{\n  "a": 1\n  "b": 2\n}', 2);
    expect(r.ok).toBe(false);
    expect(r.error.line).toBeGreaterThan(0);
  });
});

describe("minifyJson", () => {
  it("minifies into a single line", () => {
    const r = minifyJson('{\n  "a": 1,\n  "b": [2, 3]\n}');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('{"a":1,"b":[2,3]}');
  });
  it("format then minify round-trips to the same object", () => {
    const src = '{"x":[1,2,{"y":true}],"z":null}';
    const formatted = formatJson(src, 2).output;
    const min = minifyJson(formatted).output;
    expect(JSON.parse(min)).toEqual(JSON.parse(src));
  });
});

describe("escapeJson / unescapeJson", () => {
  it("escapes quotes, newlines, backslashes and CJK", () => {
    // 他说"你好"\n第二行\结束 kept as unicode escapes
    const r = escapeJson('\u4ed6\u8bf4"\u4f60\u597d"\n\u7b2c\u4e8c\u884c\\\u7ed3\u675f');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('\u4ed6\u8bf4\\"\u4f60\u597d\\"\\n\u7b2c\u4e8c\u884c\\\\\u7ed3\u675f');
  });
  it("escape never fails", () => {
    expect(escapeJson("").ok).toBe(true);
  });
  it("escape then unescape round-trips", () => {
    // '{"a":"b"}\n\t含"引号"和\反斜杠' kept as unicode escapes
    const original = '{"a":"b"}\n\t\u542b"\u5f15\u53f7"\u548c\\\u53cd\u659c\u6760';
    const escaped = escapeJson(original).output;
    const back = unescapeJson(escaped);
    expect(back.ok).toBe(true);
    expect(back.output).toBe(original);
  });
  it("unescape fails on invalid escape sequences", () => {
    const r = unescapeJson('bad\\x');
    expect(r.ok).toBe(false);
    expect(r.error).not.toBe(null);
    expect(r.error.line).toBe(0);
  });
});

describe("locateJsonError", () => {
  it("returns null for valid JSON", () => {
    expect(locateJsonError('{"a":1}')).toBe(null);
  });
  it("returns line/column/message for invalid JSON", () => {
    const e = locateJsonError('{\n  "a": 1\n  "b": 2\n}');
    expect(e).not.toBe(null);
    expect(e.line).toBeGreaterThan(0);
    expect(typeof e.message).toBe("string");
  });
  it("falls back to 0/0 when the engine message has no position", () => {
    // empty input usually has no position info, so line/column should be 0
    const e = locateJsonError("");
    expect(e).not.toBe(null);
    expect(e.line).toBe(0);
    expect(e.column).toBe(0);
  });
});

describe("jsonStats", () => {
  it("counts depth, containers and keys", () => {
    const s = jsonStats({ code: 200, data: { user: { skills: ["Vue", "Rust"] } }, msg: "ok" });
    expect(s.depth).toBe(4); // root(1)->data(2)->user(3)->skills(4)
    expect(s.objects).toBe(3);
    expect(s.arrays).toBe(1);
    expect(s.keys).toBe(5); // root 3(code/data/msg) + data 1(user) + user 1(skills)
  });
  it("scalar roots are all zero; empty containers have depth 1", () => {
    expect(jsonStats("str")).toEqual({ depth: 0, objects: 0, arrays: 0, keys: 0 });
    expect(jsonStats(null)).toEqual({ depth: 0, objects: 0, arrays: 0, keys: 0 });
    expect(jsonStats([])).toEqual({ depth: 1, objects: 0, arrays: 1, keys: 0 });
    expect(jsonStats({})).toEqual({ depth: 1, objects: 1, arrays: 0, keys: 0 });
  });
});

describe("maskJson", () => {
  it("masks string values under sensitive keys, keeping head/tail", () => {
    // name value 张三 kept as unicode escapes
    const { value, count } = maskJson({ name: "\u5f20\u4e09", password: "MyP@ssw0rd123", token: "abcdef123456" });
    expect(value.name).toBe("\u5f20\u4e09"); // non-sensitive keys untouched
    expect(value.password).not.toBe("MyP@ssw0rd123");
    expect(value.password.startsWith("My")).toBe(true);
    expect(value.password).toContain("*");
    expect(count).toBe(2);
  });
  it("zeroes numbers under sensitive keys", () => {
    const { value } = maskJson({ salary: 25000, age: 30 });
    expect(value.salary).toBe(0);
    expect(value.age).toBe(30);
  });
  it("masks phone/email/id-card by value shape when key names miss", () => {
    const { value } = maskJson({ a: "13812345678", b: "user@example.com", c: "110101199001011234" });
    expect(value.a).toBe("138****5678");
    expect(value.b).toBe("u**r@example.com");
    expect(value.c).toBe("1101**********1234");
  });
  it("plain strings and numbers are untouched", () => {
    // title value 需求评审 kept as unicode escapes
    const { value, count } = maskJson({ title: "\u9700\u6c42\u8bc4\u5ba1", total: 3, done: true });
    expect(value).toEqual({ title: "\u9700\u6c42\u8bc4\u5ba1", total: 3, done: true });
    expect(count).toBe(0);
  });
  it("recurses into arrays and nested objects", () => {
    const { value, count } = maskJson({ users: [{ phone: "13800001111" }, { phone: "13800002222" }] });
    expect(value.users[0].phone).toBe("138****1111");
    expect(value.users[1].phone).toBe("138****2222");
    expect(count).toBe(2);
  });
  it("maskJsonText returns an error for invalid JSON", () => {
    const r = maskJsonText("{bad}", 2);
    expect(r.ok).toBe(false);
    expect(r.error).not.toBe(null);
  });
  it("maskJsonText returns formatted text and count for valid input", () => {
    const r = maskJsonText('{"phone":"13812345678"}', 2);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.output).toContain("138****5678");
  });
});
