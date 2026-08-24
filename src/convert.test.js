import { describe, expect, it } from "vitest";
import { i18n } from "./i18n/index.js";
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

describe("Base64 convert", () => {
  it("encodes/decodes ASCII and emoji as UTF-8", () => {
    const source = "ToolCove OK 😀";
    expect(decodeBase64(encodeBase64(source))).toBe(source);
  });

  it("accepts Base64URL and missing padding when decoding", () => {
    expect(decodeBase64("aGVsbG8g8J-YgA")).toBe("hello 😀");
  });

  it("rejects invalid Base64", () => {
    expect(() => decodeBase64("%%%")).toThrow("Base64");
    expect(() => decodeBase64("==")).toThrow("Base64");
  });
});

describe("URL convert", () => {
  it("encodes/decodes with URL component semantics", () => {
    const source = "tool café?a=1&b=2";
    expect(encodeUrl(source)).toBe("tool%20caf%C3%A9%3Fa%3D1%26b%3D2");
    expect(decodeUrl(encodeUrl(source))).toBe(source);
  });

  it("decodes plus signs in form params as spaces", () => {
    expect(decodeUrl("hello+world%21")).toBe("hello world!");
  });
});

describe("Unicode escape", () => {
  it("escapes non-ASCII chars and handles surrogate pairs", () => {
    expect(encodeUnicode("Acafé😀")).toBe("Acaf\\u00e9\\ud83d\\ude00");
    expect(decodeUnicode("Acaf\\u00e9\\ud83d\\ude00")).toBe("Acafé😀");
  });

  it("decodes common JavaScript escapes", () => {
    expect(decodeUnicode("line1\\nline2\\tend\\\\")).toBe("line1\nline2\tend\\");
  });

  it("rejects incomplete Unicode escapes", () => {
    expect(() => decodeUnicode("\\u12G4")).toThrow("Unicode");
  });
});

describe("Hex convert", () => {
  it("outputs UTF-8 hex and tolerates whitespace separators", () => {
    expect(encodeHex("Aé")).toBe("41 c3 a9");
    expect(decodeHex("41  c3\na9")).toBe("Aé");
  });

  it("rejects odd length and invalid characters", () => {
    expect(() => decodeHex("abc")).toThrow(i18n.global.t("toolbox.convert.errHexOdd"));
    expect(() => decodeHex("zz")).toThrow("Hex");
  });
});

describe("JSON string escape", () => {
  it("outputs JSON string content without outer quotes", () => {
    const source = "line-a\n\"line-b\"\\end";
    const encoded = encodeJsonString(source);
    expect(encoded).toBe("line-a\\n\\\"line-b\\\"\\\\end");
    expect(decodeJsonString(encoded)).toBe(source);
  });

  it("rejects invalid JSON escapes", () => {
    expect(() => decodeJsonString("\\x41")).toThrow("JSON");
  });
});

describe("JWT parse", () => {
  it("parses header, payload and signature without verifying", () => {
    const jwt = [
      encodeBase64(JSON.stringify({ alg: "HS256", typ: "JWT" }), true),
      encodeBase64(JSON.stringify({ sub: "user-1", name: "Alice", exp: 2000000000 }), true),
      "signature",
    ].join(".");
    const parsed = parseJwt(jwt);
    expect(parsed.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(parsed.payload).toEqual({ sub: "user-1", name: "Alice", exp: 2000000000 });
    expect(parsed.signature).toBe("signature");
    expect(parsed.hasSignature).toBe(true);
  });

  it("rejects wrong part count or non-JSON data", () => {
    expect(() => parseJwt("only-one-part")).toThrow(i18n.global.t("toolbox.convert.errJwtParts"));
    expect(() => parseJwt("bm90LWpzb24.e30.sig")).toThrow("Header");
  });
});
