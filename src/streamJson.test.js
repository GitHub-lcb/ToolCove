// streamJson.js 单测：增量 JSON 补全解析边界矩阵
import { describe, it, expect } from "vitest";
import { parsePartialJson } from "./streamJson.js";

describe("parsePartialJson", () => {
  it("完整 JSON 直接解析", () => {
    expect(parsePartialJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePartialJson('{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(parsePartialJson('{"a":1,"b":[true,null],"c":"x"}')).toEqual({
      ok: true,
      value: { a: 1, b: [true, null], c: "x" },
    });
  });

  it("前缀补全：对象", () => {
    expect(parsePartialJson("{")).toEqual({ ok: true, value: {} });
    expect(parsePartialJson('{"a"')).toEqual({ ok: true, value: { a: "" } });
    expect(parsePartialJson('{"a":')).toEqual({ ok: true, value: { a: "" } });
    expect(parsePartialJson('{"a":"张')).toEqual({ ok: true, value: { a: "张" } });
    expect(parsePartialJson('{"a":1')).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePartialJson('{"a":1,')).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePartialJson('{"a":1,"b"')).toEqual({ ok: true, value: { a: 1, b: "" } });
  });

  it("前缀补全：数组与嵌套", () => {
    expect(parsePartialJson("[")).toEqual({ ok: true, value: [] });
    expect(parsePartialJson("[1")).toEqual({ ok: true, value: [1] });
    expect(parsePartialJson("[1,")).toEqual({ ok: true, value: [1] });
    expect(parsePartialJson('[1,"ab')).toEqual({ ok: true, value: [1, "ab"] });
    expect(parsePartialJson('{"a":[')).toEqual({ ok: true, value: { a: [] } });
    expect(parsePartialJson('{"a":{"b":')).toEqual({ ok: true, value: { a: { b: "" } } });
  });

  it("字符串转义截断容忍", () => {
    expect(parsePartialJson('{"a":"x\\\\')).toEqual({ ok: true, value: { a: "x\\" } });
    expect(parsePartialJson('{"a":"x\\"')).toEqual({ ok: true, value: { a: 'x"' } }); // 转义引号 + 补闭合引号
    expect(parsePartialJson('{"a":"x\\')).toEqual({ ok: false, reason: "bad_json" }); // 单反斜杠结尾
    expect(parsePartialJson('{"a":"\\u4e0')).toEqual({ ok: false, reason: "bad_value" }); // \u 不完整
  });

  it("非法输入 ok:false", () => {
    expect(parsePartialJson("")).toEqual({ ok: false, reason: "empty" });
    expect(parsePartialJson(null)).toEqual({ ok: false, reason: "not_string" });
    expect(parsePartialJson(123)).toEqual({ ok: false, reason: "not_string" });
    expect(parsePartialJson("abc")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson('{"a":}')).toEqual({ ok: false, reason: "bad_value" }); // 空槽
    expect(parsePartialJson("// 注释")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson('{"a":1}x')).toEqual({ ok: false, reason: "bad_value" }); // 尾随垃圾
    expect(parsePartialJson("123abc")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson('{"a":1,000}')).toEqual({ ok: false, reason: "bad_value" }); // 千分位
    expect(parsePartialJson('{"a":1,}')).toEqual({ ok: false, reason: "bad_value" }); // 尾随逗号
    expect(parsePartialJson("[1,]")).toEqual({ ok: false, reason: "bad_value" }); // 尾随逗号
  });

  it("数字非法形态", () => {
    expect(parsePartialJson("-")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson(".5")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson("+1")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson("1.")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson("1e")).toEqual({ ok: false, reason: "not_json" });
  });

  it("空白容忍", () => {
    expect(parsePartialJson('{ "a" : 1 , "b" : [ true , null ] }')).toEqual({
      ok: true,
      value: { a: 1, b: [true, null] },
    });
    expect(parsePartialJson('{\n  "a": 1,\n  "b": "张')).toEqual({
      ok: true,
      value: { a: 1, b: "张" },
    });
  });

  it("顶层非对象/数组前缀", () => {
    expect(parsePartialJson('"str')).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson("12")).toEqual({ ok: false, reason: "not_json" });
    expect(parsePartialJson("true")).toEqual({ ok: false, reason: "not_json" });
  });
});
