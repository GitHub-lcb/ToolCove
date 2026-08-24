// snippets.js 纯函数单测：字段拼接快照 / 字段模式判断 / 字段取值
import { describe, it, expect } from "vitest";
import { fieldsToContent, hasFields, fieldValue } from "./snippets.js";

describe("fieldsToContent", () => {
  it("空数组与非数组返回空串", () => {
    expect(fieldsToContent([])).toBe("");
    expect(fieldsToContent(null)).toBe("");
    expect(fieldsToContent(undefined)).toBe("");
  });

  it("按「标签: 值」每行拼接", () => {
    const out = fieldsToContent([
      { label: "账号", value: "zhangsan" },
      { label: "密码", value: "p@ss123" },
    ]);
    expect(out).toBe("账号: zhangsan\n密码: p@ss123");
  });

  it("无标签字段只输出值", () => {
    expect(fieldsToContent([{ label: "", value: "http://x" }])).toBe("http://x");
  });

  it("空值字段与全空字段跳过", () => {
    const out = fieldsToContent([
      { label: "账号", value: "zhangsan" },
      { label: "密码", value: "" },
      { label: "", value: "" },
    ]);
    expect(out).toBe("账号: zhangsan");
  });

  it("值内换行拍平成空格，保证一行一个字段", () => {
    const out = fieldsToContent([{ label: "证书", value: "line1\nline2" }]);
    expect(out).toBe("证书: line1 line2");
  });

  it("标签与值都做 trim", () => {
    const out = fieldsToContent([{ label: " 账号 ", value: "  zhangsan  " }]);
    expect(out).toBe("账号: zhangsan");
  });
});

describe("hasFields", () => {
  it("fields 非空视为字段模式", () => {
    expect(hasFields({ fields: [{ label: "账号", value: "a" }] })).toBe(true);
  });

  it("无 fields / 空数组 / 非对象返回 false", () => {
    expect(hasFields({})).toBe(false);
    expect(hasFields({ fields: [] })).toBe(false);
    expect(hasFields(null)).toBe(false);
  });
});

describe("fieldValue", () => {
  it("返回 trim 后的字符串值", () => {
    expect(fieldValue({ value: "  abc  " })).toBe("abc");
  });

  it("空值 / 缺字段返回空串", () => {
    expect(fieldValue({ value: "" })).toBe("");
    expect(fieldValue({ value: null })).toBe("");
    expect(fieldValue(undefined)).toBe("");
  });
});
