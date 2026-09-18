import { describe, expect, it } from "vitest";
import * as json from "../../../src/json.js";
import * as convert from "../../../src/convert.js";

/**
 * 这两个模块是**共享层**（桌面端与手机端同一份），手机端工具视图直接依赖它们的返回契约。
 *
 * 为什么值得单测：「谁返回什么」光看名字看不出来——
 *   · json.js 的几个函数返回 `{ ok, output, error }` **不抛异常**；
 *   · convert.js 的成功路径返回**字符串**、失败才抛。
 * 这两套约定混用会让视图把错误当成结果渲染（踩过一次：把整个 {ok:false} 对象显示成"结果"）。
 * 这里把契约钉住，改共享层时立刻能发现。
 */
describe("json.js 的返回契约（ok/error，不抛）", () => {
  it("formatJson：成功给 output，失败给带行列的 error", () => {
    const ok = json.formatJson('{"a":[1,2]}', 2);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("\n  ");
    expect(ok.error).toBe(null);

    const bad = json.formatJson('{"a":1,}', 2);
    expect(bad.ok).toBe(false);
    expect(bad.output).toBe("");
    expect(bad.error.line).toBe(1);
    expect(bad.error.column).toBeGreaterThan(0);
    expect(typeof bad.error.message).toBe("string");
  });

  it("minifyJson：成功去掉所有空白", () => {
    expect(json.minifyJson('{ "a" : [1, 2] }')).toMatchObject({ ok: true, output: '{"a":[1,2]}' });
    expect(json.minifyJson("{").ok).toBe(false);
  });

  it("parseJson：成功给 value（供树视图/统计使用）", () => {
    expect(json.parseJson('{"a":1}')).toMatchObject({ ok: true, value: { a: 1 } });
    expect(json.parseJson("{").ok).toBe(false);
  });

  it("escapeJson / unescapeJson：互为逆运算，且从不失败", () => {
    const escaped = json.escapeJson("a\nb");
    expect(escaped.ok).toBe(true);
    expect(escaped.output).not.toContain('"'); // 字面量内层内容，不含首尾引号
    expect(json.unescapeJson(escaped.output).output).toBe("a\nb");
  });

  it("maskJsonText：给 count，视图据此说明「脱敏了几处」", () => {
    const result = json.maskJsonText('{"password":"secret","name":"lcb"}', 2);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.output).toContain("se**et");
    expect(result.output).toContain("lcb"); // 非敏感字段保持原样
  });

  it("jsonStats：{depth, objects, arrays, keys}（没有 type/size，视图要自己补）", () => {
    expect(json.jsonStats({ a: { b: 1 } })).toEqual({ depth: 2, objects: 2, arrays: 0, keys: 2 });
    expect(json.jsonStats({ a: [1, 2] })).toEqual({ depth: 2, objects: 1, arrays: 1, keys: 1 });
  });
});

describe("convert.js 的返回契约（成功给字符串，失败抛）", () => {
  it("Base64 往返（UTF-8）", () => {
    const encoded = convert.encodeBase64("你好");
    expect(typeof encoded).toBe("string");
    expect(convert.decodeBase64(encoded)).toBe("你好");
    expect(() => convert.decodeBase64("!!!not base64!!!")).toThrow();
  });

  it("URL / Unicode / Hex 往返", () => {
    expect(convert.encodeUrl("a b&c")).toBe("a%20b%26c");
    expect(convert.decodeUrl("a%20b%26c")).toBe("a b&c");
    expect(convert.encodeUnicode("中a")).toBe("\\u4e2da");
    expect(convert.decodeUnicode("\\u4e2da")).toBe("中a");
    expect(convert.encodeHex("hi")).toBe("68 69");
    expect(convert.decodeHex("68 69")).toBe("hi");
  });

  it("JSON 字符串转义：解码非转义内容会抛（视图要 catch 并显示原因）", () => {
    expect(convert.encodeJsonString('a"b')).toBe('a\\"b');
    expect(() => convert.decodeJsonString('"a"')).toThrow();
  });
});
