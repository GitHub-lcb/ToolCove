// snippets.js 纯函数单测：字段拼接快照 / 字段模式判断 / 字段取值
import { describe, it, expect } from "vitest";
import { fieldsToContent, hasFields, fieldValue } from "./snippets.js";

describe("fieldsToContent", () => {
  it("empty or non-array input returns empty string", () => {
    expect(fieldsToContent([])).toBe("");
    expect(fieldsToContent(null)).toBe("");
    expect(fieldsToContent(undefined)).toBe("");
  });

  it("joins fields as one 'label: value' per line", () => {
    const out = fieldsToContent([
      { label: "account", value: "zhangsan" },
      { label: "password", value: "p@ss123" },
    ]);
    expect(out).toBe("account: zhangsan\npassword: p@ss123");
  });

  it("field without label outputs value only", () => {
    expect(fieldsToContent([{ label: "", value: "http://x" }])).toBe("http://x");
  });

  it("skips empty-value fields and all-empty fields", () => {
    const out = fieldsToContent([
      { label: "account", value: "zhangsan" },
      { label: "password", value: "" },
      { label: "", value: "" },
    ]);
    expect(out).toBe("account: zhangsan");
  });

  it("flattens newlines in values to spaces, one field per line", () => {
    const out = fieldsToContent([{ label: "cert", value: "line1\nline2" }]);
    expect(out).toBe("cert: line1 line2");
  });

  it("trims both label and value", () => {
    const out = fieldsToContent([{ label: " account ", value: "  zhangsan  " }]);
    expect(out).toBe("account: zhangsan");
  });
});

describe("hasFields", () => {
  it("non-empty fields means field-mode snippet", () => {
    expect(hasFields({ fields: [{ label: "account", value: "a" }] })).toBe(true);
  });

  it("no fields / empty array / non-object returns false", () => {
    expect(hasFields({})).toBe(false);
    expect(hasFields({ fields: [] })).toBe(false);
    expect(hasFields(null)).toBe(false);
  });
});

describe("fieldValue", () => {
  it("returns trimmed string value", () => {
    expect(fieldValue({ value: "  abc  " })).toBe("abc");
  });

  it("empty value / missing field returns empty string", () => {
    expect(fieldValue({ value: "" })).toBe("");
    expect(fieldValue({ value: null })).toBe("");
    expect(fieldValue(undefined)).toBe("");
  });
});
