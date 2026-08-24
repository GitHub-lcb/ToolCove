import { describe, expect, it } from "vitest";
import {
  decodeBase64,
  decodeHex,
  decodeJsonString,
  decodeUnicode,
  decodeUrl,
  encodeBase64,
  encodeHex,
  encodeJsonString,
  encodeUnicode,
  encodeUrl,
  parseJwt,
} from "./convert.js";

describe("Base64 转换", () => {
  it("按 UTF-8 编解码中文和 emoji", () => {
    const source = "研发工具台 OK";
    expect(decodeBase64(encodeBase64(source))).toBe(source);
  });

  it("解码时兼容 Base64URL 与缺失的填充", () => {
    expect(decodeBase64("5Lit5paH8J-YgA")).toBe("中文😀");
  });

  it("拒绝非法 Base64", () => {
    expect(() => decodeBase64("%%%")).toThrow("Base64");
    expect(() => decodeBase64("==")).toThrow("Base64");
  });
});

describe("URL 转换", () => {
  it("使用 URL 组件语义编解码", () => {
    const source = "研发 工具?a=1&b=中文";
    expect(encodeUrl(source)).toBe("%E7%A0%94%E5%8F%91%20%E5%B7%A5%E5%85%B7%3Fa%3D1%26b%3D%E4%B8%AD%E6%96%87");
    expect(decodeUrl(encodeUrl(source))).toBe(source);
  });

  it("解码表单参数中的加号为空格", () => {
    expect(decodeUrl("hello+world%21")).toBe("hello world!");
  });
});

describe("Unicode 转义", () => {
  it("转义非 ASCII 字符并正确处理代理对", () => {
    expect(encodeUnicode("A中文😀")).toBe("A\\u4e2d\\u6587\\ud83d\\ude00");
    expect(decodeUnicode("A\\u4e2d\\u6587\\ud83d\\ude00")).toBe("A中文😀");
  });

  it("解码常用 JavaScript 转义字符", () => {
    expect(decodeUnicode("line1\\nline2\\tend\\\\")).toBe("line1\nline2\tend\\");
  });

  it("拒绝不完整的 Unicode 转义", () => {
    expect(() => decodeUnicode("\\u12G4")).toThrow("Unicode");
  });
});

describe("Hex 转换", () => {
  it("按 UTF-8 输出十六进制并兼容空白分隔", () => {
    expect(encodeHex("A中")).toBe("41 e4 b8 ad");
    expect(decodeHex("41  e4\nb8-ad")).toBe("A中");
  });

  it("拒绝奇数长度与非法字符", () => {
    expect(() => decodeHex("abc")).toThrow("偶数");
    expect(() => decodeHex("zz")).toThrow("Hex");
  });
});

describe("JSON 字符串转义", () => {
  it("输出不含外层引号的 JSON 字符串内容", () => {
    const source = "第一行\n\"第二行\"\\end";
    const encoded = encodeJsonString(source);
    expect(encoded).toBe("第一行\\n\\\"第二行\\\"\\\\end");
    expect(decodeJsonString(encoded)).toBe(source);
  });

  it("拒绝非法 JSON 转义", () => {
    expect(() => decodeJsonString("\\x41")).toThrow("JSON");
  });
});

describe("JWT 解析", () => {
  it("解析 Header、Payload 和签名且不验证签名", () => {
    const jwt = [
      encodeBase64(JSON.stringify({ alg: "HS256", typ: "JWT" }), true),
      encodeBase64(JSON.stringify({ sub: "user-1", name: "张三", exp: 2000000000 }), true),
      "signature",
    ].join(".");
    const parsed = parseJwt(jwt);
    expect(parsed.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(parsed.payload).toEqual({ sub: "user-1", name: "张三", exp: 2000000000 });
    expect(parsed.signature).toBe("signature");
    expect(parsed.hasSignature).toBe(true);
  });

  it("拒绝段数错误或非 JSON 数据", () => {
    expect(() => parseJwt("only-one-part")).toThrow("三段");
    expect(() => parseJwt("bm90LWpzb24.e30.sig")).toThrow("Header");
  });
});
