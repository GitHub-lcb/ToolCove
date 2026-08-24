// streamJson.js 单测：增量 JSON 补全解析边界矩阵
import { describe, it, expect } from "vitest";
import { parsePartialJson } from "./streamJson.js";

describe("parsePartialJson", () => {
  it("parses complete JSON as-is", () => {
    expect(parsePartialJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePartialJson('{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(parsePartialJson('{"a":1,"b":[true,null],"c":"x"}')).toEqual({
      ok: true,
      value: { a: 1, b: [true, null], c: "x" },
    });
  });

  it("prefix completion: objects", () => {
    expect(parsePartialJson("{")).toEqual({ ok: true, value: {} });
    expect(parsePartialJson('{"a"')).toEqual({ ok: true, value: { a: "" } });
    expect(parsePartialJson('{"a":')).toEqual({ ok: true, value: { a: "" } });
    expect(parsePartialJson('{"a":"\u5f20')).toEqual({ ok: true, value: { a: "\u5f20" } });
    expect(parsePartialJson('{"a":1')).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePartialJson('{"a":1,')).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePartialJson('{"a":1,"b"')).toEqual({ ok: true, value: { a: 1, b: "" } });
  });

  it("prefix completion: arrays and nesting", () => {
    expect(parsePartialJson("[")).toEqual({ ok: true, value: [] });
    expect(parsePartialJson("[1")).toEqual({ ok: true, value: [1] });
    expect(parsePartialJson("[1,")).toEqual({ ok: true, value: [1] });
    expect(parsePartialJson('[1,"ab')).toEqual({ ok: true, value: [1, "ab"] });
    expect(parsePartialJson('{"a":[')).toEqual({ ok: true, value: { a: [] } });
    expect(parsePartialJson('{"a":{"b":')).toEqual({ ok: true, value: { a: { b: "" } } });
  });

  it("tolerates truncated string escapes", () => {
    expect(parsePartialJson('{"a":"x\\\\')).toEqual({ ok: true, value: { a: "x\\" } });
    expect(parsePartialJson('{"a":"x\\"')).toEqual({ ok: true, value: { a: 'x"' } }); // 转义引号 + 补闭合引号
    expect(parsePartialJson('{"a":"x\\')).toEqual({ ok: false, reason: "bad_json" }); // 单反斜杠结尾
    expect(parsePartialJson('{"a":"\\u4e0')).toEqual({ ok: false, reason: "bad_value" }); // \u 不完整
  });

  it("invalid input returns ok:false", () => {
    expect(parsePartialJson("")).toEqual({ ok: false, reason: "empty" });
    expect(parsePartialJson(null)).toEqual({ ok: false, reason: "not_string" });
    expect(parsePartialJson(123)).toEqual({ ok: false, reason: "not_string" });
    expect(parsePartialJson("abc")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson('{"a":}')).toEqual({ ok: false, reason: "bad_value" }); // empty slot
    expect(parsePartialJson("// \u6ce8\u91ca")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson('{"a":1}x')).toEqual({ ok: false, reason: "bad_value" }); // trailing junk
    expect(parsePartialJson("123abc")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson('{"a":1,000}')).toEqual({ ok: false, reason: "bad_value" }); // thousands separators
    expect(parsePartialJson('{"a":1,}')).toEqual({ ok: false, reason: "bad_value" }); // trailing comma
    expect(parsePartialJson("[1,]")).toEqual({ ok: false, reason: "bad_value" }); // trailing comma
  });

  it("rejects invalid number shapes", () => {
    expect(parsePartialJson("-")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson(".5")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson("+1")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson("1.")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson("1e")).toEqual({ ok: false, reason: "not_json" });
  });

  it("tolerates whitespace", () => {
    expect(parsePartialJson('{ "a" : 1 , "b" : [ true , null ] }')).toEqual({
      ok: true,
      value: { a: 1, b: [true, null] },
    });
    expect(parsePartialJson('{\n  "a": 1,\n  "b": "\u5f20')).toEqual({
      ok: true,
      value: { a: 1, b: "\u5f20" },
    });
  });

  it("top-level non-object/array prefixes", () => {
    expect(parsePartialJson('"str')).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson("12")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson("true")).toEqual({ ok: false, reason: "not_json" });
  });
});
