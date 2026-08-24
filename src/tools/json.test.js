import { describe, it, expect } from "vitest";
import { formatJson, minifyJson, escapeJson, unescapeJson, locateJsonError, jsonStats, maskJson, maskJsonText } from "./json.js";

describe("formatJson", () => {
  it("格式化对象，默认缩进 2", () => {
    const r = formatJson('{"a":1,"b":[2,3]}', 2);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    expect(r.error).toBe(null);
  });
  it("支持缩进 4", () => {
    const r = formatJson('{"a":1}', 4);
    expect(r.output).toBe('{\n    "a": 1\n}');
  });
  it("保留非 ASCII 字符（不转 \\uXXXX）", () => {
    const r = formatJson('{"名":"值"}', 2);
    expect(r.output).toBe('{\n  "名": "值"\n}');
  });
  it("空字符串输入视为失败并给出错误", () => {
    const r = formatJson("", 2);
    expect(r.ok).toBe(false);
    expect(r.output).toBe("");
    expect(r.error).not.toBe(null);
  });
  it("非法 JSON 返回 ok:false 且带行列（缺逗号）", () => {
    const r = formatJson('{\n  "a": 1\n  "b": 2\n}', 2);
    expect(r.ok).toBe(false);
    expect(r.error.line).toBeGreaterThan(0);
  });
});

describe("minifyJson", () => {
  it("压成一行", () => {
    const r = minifyJson('{\n  "a": 1,\n  "b": [2, 3]\n}');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('{"a":1,"b":[2,3]}');
  });
  it("format 后 minify 与原对象等价（往返）", () => {
    const src = '{"x":[1,2,{"y":true}],"z":null}';
    const formatted = formatJson(src, 2).output;
    const min = minifyJson(formatted).output;
    expect(JSON.parse(min)).toEqual(JSON.parse(src));
  });
});

describe("escapeJson / unescapeJson", () => {
  it("转义含引号/换行/反斜杠/中文", () => {
    const r = escapeJson('他说"你好"\n第二行\\结束');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('他说\\"你好\\"\\n第二行\\\\结束');
  });
  it("escape 永不失败", () => {
    expect(escapeJson("").ok).toBe(true);
  });
  it("escape 后 unescape 还原（往返）", () => {
    const original = '{"a":"b"}\n\t含"引号"和\\反斜杠';
    const escaped = escapeJson(original).output;
    const back = unescapeJson(escaped);
    expect(back.ok).toBe(true);
    expect(back.output).toBe(original);
  });
  it("非法转义序列 unescape 失败", () => {
    const r = unescapeJson('bad\\x');
    expect(r.ok).toBe(false);
    expect(r.error).not.toBe(null);
    expect(r.error.line).toBe(0);
  });
});

describe("locateJsonError", () => {
  it("合法 JSON 返回 null", () => {
    expect(locateJsonError('{"a":1}')).toBe(null);
  });
  it("非法 JSON 返回行列与信息", () => {
    const e = locateJsonError('{\n  "a": 1\n  "b": 2\n}');
    expect(e).not.toBe(null);
    expect(e.line).toBeGreaterThan(0);
    expect(typeof e.message).toBe("string");
  });
  it("引擎错误信息无位置时兜底为 0/0", () => {
    // 直接验证兜底：空输入通常无 position，行列应为 0
    const e = locateJsonError("");
    expect(e).not.toBe(null);
    expect(e.line).toBe(0);
    expect(e.column).toBe(0);
  });
});

describe("jsonStats", () => {
  it("统计深度与容器/键数量", () => {
    const s = jsonStats({ code: 200, data: { user: { skills: ["Vue", "Rust"] } }, msg: "ok" });
    expect(s.depth).toBe(4); // 根(1)→data(2)→user(3)→skills(4)
    expect(s.objects).toBe(3);
    expect(s.arrays).toBe(1);
    expect(s.keys).toBe(5); // 根 3(code/data/msg) + data 1(user) + user 1(skills)
  });
  it("标量根返回全 0，空容器深度为 1", () => {
    expect(jsonStats("str")).toEqual({ depth: 0, objects: 0, arrays: 0, keys: 0 });
    expect(jsonStats(null)).toEqual({ depth: 0, objects: 0, arrays: 0, keys: 0 });
    expect(jsonStats([])).toEqual({ depth: 1, objects: 0, arrays: 1, keys: 0 });
    expect(jsonStats({})).toEqual({ depth: 1, objects: 1, arrays: 0, keys: 0 });
  });
});

describe("maskJson", () => {
  it("按敏感键名脱敏字符串值，保留首尾", () => {
    const { value, count } = maskJson({ name: "张三", password: "MyP@ssw0rd123", token: "abcdef123456" });
    expect(value.name).toBe("张三"); // 非敏感键不动
    expect(value.password).not.toBe("MyP@ssw0rd123");
    expect(value.password.startsWith("My")).toBe(true);
    expect(value.password).toContain("*");
    expect(count).toBe(2);
  });
  it("敏感键的数字值置 0", () => {
    const { value } = maskJson({ salary: 25000, age: 30 });
    expect(value.salary).toBe(0);
    expect(value.age).toBe(30);
  });
  it("按值形态脱敏手机/邮箱/身份证（键名未命中）", () => {
    const { value } = maskJson({ a: "13812345678", b: "user@example.com", c: "110101199001011234" });
    expect(value.a).toBe("138****5678");
    expect(value.b).toBe("u**r@example.com");
    expect(value.c).toBe("1101**********1234");
  });
  it("普通字符串与数字不受影响", () => {
    const { value, count } = maskJson({ title: "需求评审", total: 3, done: true });
    expect(value).toEqual({ title: "需求评审", total: 3, done: true });
    expect(count).toBe(0);
  });
  it("递归数组与嵌套对象", () => {
    const { value, count } = maskJson({ users: [{ phone: "13800001111" }, { phone: "13800002222" }] });
    expect(value.users[0].phone).toBe("138****1111");
    expect(value.users[1].phone).toBe("138****2222");
    expect(count).toBe(2);
  });
  it("maskJsonText 非法 JSON 返回错误", () => {
    const r = maskJsonText("{bad}", 2);
    expect(r.ok).toBe(false);
    expect(r.error).not.toBe(null);
  });
  it("maskJsonText 合法输入返回格式化文本与计数", () => {
    const r = maskJsonText('{"phone":"13812345678"}', 2);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.output).toContain("138****5678");
  });
});
