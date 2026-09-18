import { describe, expect, it } from "vitest";
import * as json from "../../../src/json.js";
import * as convert from "../../../src/convert.js";
import { generatePassword, getPasswordPoolSize } from "../../../src/cryptoTool.js";

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

/**
 * 密码生成的开关键名是**静默失败**的重灾区：
 * generatePassword / getPasswordPoolSize 只认 PASSWORD_SETS 的键
 * （uppercase / lowercase / numbers / symbols），多出来的键被忽略、不报错。
 * 手机端曾经写成 upper/lower/number/symbol，表现是「开关点了没反应、池大小不变」。
 */
describe("密码生成的字符集键名（静默忽略的坑）", () => {
  const ALL = { uppercase: true, lowercase: true, numbers: true, symbols: true, excludeAmbiguous: false };

  it("关掉某一类，字符池必须变小", () => {
    const full = getPasswordPoolSize(ALL);
    for (const key of Object.keys(ALL)) {
      if (key === "excludeAmbiguous") continue;
      const without = getPasswordPoolSize({ ...ALL, [key]: false });
      expect(without, `关掉 ${key} 后池没变，说明键名没被识别`).toBeLessThan(full);
    }
  });

  it("默认就排除易混字符：想保留它们必须显式传 excludeAmbiguous:false", () => {
    // 这是共享层容易被误读的地方，实测值（别凭字符集长度推算）：
    //   {四类全开}                          → 85（默认已排除易混字符）
    //   {四类全开, excludeAmbiguous: false}  → 85
    //   {四类全开, excludeAmbiguous: true}   → 79
    // 也就是「不传」与「传 false」等价，而 true 会再砍掉 6 个。
    const all = { uppercase: true, lowercase: true, numbers: true, symbols: true };
    expect(getPasswordPoolSize(all)).toBe(85);
    expect(getPasswordPoolSize({ ...all, excludeAmbiguous: false })).toBe(85);
    expect(getPasswordPoolSize({ ...all, excludeAmbiguous: true })).toBe(79);
  });

  it("语义是「不等于 false 即启用」：只想开一类也必须把其余显式关掉", () => {
    // { numbers: true } 并不等于「只用数字」——其余三类没传，被当成启用。
    expect(getPasswordPoolSize({ numbers: true })).toBe(85);
    expect(getPasswordPoolSize({ uppercase: false, lowercase: false, numbers: true, symbols: false })).toBe(10);
    expect(getPasswordPoolSize({ uppercase: false, lowercase: false, numbers: false, symbols: false })).toBe(0);
  });

  it("错误键名会被静默忽略（所以键名必须与共享层一致）", () => {
    // 这不是期望行为，而是记录现实：写错名字不会报错，只会「没反应」
    expect(getPasswordPoolSize({ upper: false, lowercase: false, numbers: false, symbols: false })).toBeGreaterThan(0);
  });

  it("生成的密码长度可控，且只用启用的字符集", () => {
    const digitsOnly = generatePassword({ length: 12, uppercase: false, lowercase: false, numbers: true, symbols: false });
    expect(digitsOnly).toHaveLength(12);
    expect(digitsOnly).toMatch(/^[0-9]+$/);

    expect(generatePassword({ length: 20, ...ALL })).toHaveLength(20);
  });
});
