import { describe, it, expect } from "vitest";
import {
  splitUrl,
  buildUrl,
  headersToPairs,
  findHeader,
  detectBodyLang,
  prettyBody,
  sizeText,
  statusClass,
  parseCurl,
  envVarsToMap,
  substituteVars,
  extractVars,
  formEncode,
  parseFormText,
  dispositionName,
  suggestFileName,
  describeContentType,
} from "./request.js";

describe("splitUrl", () => {
  it("splits base and query params (decoding values)", () => {
    const r = splitUrl("https://api.example.com/users?page=1&size=10&q=hello%20world");
    expect(r.base).toBe("https://api.example.com/users");
    expect(r.query).toEqual([
      { key: "page", value: "1", on: true },
      { key: "size", value: "10", on: true },
      { key: "q", value: "hello world", on: true },
    ]);
  });
  it("query is empty without a query string", () => {
    expect(splitUrl("https://a.com/x").query).toEqual([]);
  });
  it("ignores the hash fragment", () => {
    expect(splitUrl("https://a.com/x?a=1#frag").query).toEqual([{ key: "a", value: "1", on: true }]);
  });
});

describe("buildUrl", () => {
  it("joins enabled params with encoding", () => {
    const url = buildUrl("https://a.com/x", [
      { key: "q", value: "a b", on: true },
      { key: "skip", value: "1", on: false },
      { key: "", value: "x", on: true },
    ]);
    expect(url).toBe("https://a.com/x?q=a%20b");
  });
  it("appends with & when base already has ?", () => {
    expect(buildUrl("https://a.com/x?fixed=1", [{ key: "a", value: "2", on: true }])).toBe("https://a.com/x?fixed=1&a=2");
  });
  it("returns the original base without valid params", () => {
    expect(buildUrl("https://a.com", [])).toBe("https://a.com");
  });
});

describe("headersToPairs / findHeader", () => {
  it("filters disabled entries and empty keys", () => {
    const pairs = headersToPairs([
      { key: "Accept", value: "application/json", on: true },
      { key: "X-Off", value: "1", on: false },
      { key: "", value: "y", on: true },
    ]);
    expect(pairs).toEqual([["Accept", "application/json"]]);
  });
  it("looks up headers case-insensitively", () => {
    const pairs = [["Content-Type", "application/json"]];
    expect(findHeader(pairs, "content-type")).toBe("application/json");
    expect(findHeader(pairs, "missing")).toBe("");
  });
});

describe("detectBodyLang", () => {
  it("prefers content-type", () => {
    expect(detectBodyLang("application/json; charset=utf-8", "")).toBe("json");
    expect(detectBodyLang("text/html", "")).toBe("html");
    expect(detectBodyLang("application/xml", "")).toBe("xml");
  });
  it("sniffs by content when content-type is missing", () => {
    expect(detectBodyLang("", '{"a":1}')).toBe("json");
    expect(detectBodyLang("", "<!DOCTYPE html><html></html>")).toBe("html");
    expect(detectBodyLang("", "<?xml version=\"1.0\"?><a/>")).toBe("xml");
    expect(detectBodyLang("", "plain text")).toBe("text");
  });
});

describe("prettyBody", () => {
  it("pretty-prints JSON, keeps invalid JSON as-is", () => {
    expect(prettyBody('{"a":1}', "json")).toBe('{\n  "a": 1\n}');
    expect(prettyBody("{bad}", "json")).toBe("{bad}");
    expect(prettyBody("<html>", "html")).toBe("<html>");
  });
});

describe("sizeText / statusClass", () => {
  it("human-readable byte sizes", () => {
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(2048)).toBe("2.00 KB");
    expect(sizeText(3 * 1024 * 1024)).toBe("3.00 MB");
  });
  it("status code classes", () => {
    expect(statusClass(200)).toBe("ok");
    expect(statusClass(301)).toBe("redirect");
    expect(statusClass(404)).toBe("client");
    expect(statusClass(500)).toBe("server");
    expect(statusClass(0)).toBe("other");
  });
});

describe("parseCurl", () => {
  it("parses method, URL, headers and body", () => {
    const r = parseCurl(`curl -X POST 'https://api.example.com/users' -H 'Content-Type: application/json' -H 'Authorization: Bearer t' -d '{"name":"\u5f20\u4e09"}'`);
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.example.com/users");
    expect(r.headers).toEqual([
      { key: "Content-Type", value: "application/json", on: true },
      { key: "Authorization", value: "Bearer t", on: true },
    ]);
    expect(r.body).toBe('{"name":"\u5f20\u4e09"}');
  });
  it("defaults to POST with data but no -X", () => {
    expect(parseCurl("curl https://a.com -d 'x=1'").method).toBe("POST");
  });
  it("bare URL defaults to GET, supports line continuations", () => {
    const r = parseCurl("curl \\\n  https://a.com/x?a=1 \\\n  -H 'Accept: */*'");
    expect(r.method).toBe("GET");
    expect(r.url).toBe("https://a.com/x?a=1");
    expect(r.headers).toEqual([{ key: "Accept", value: "*/*", on: true }]);
  });
  it("converts -u into a Basic Auth header", () => {
    const r = parseCurl("curl https://a.com -u user:pass");
    expect(r.headers[0].key).toBe("Authorization");
    expect(r.headers[0].value).toBe("Basic " + btoa("user:pass"));
  });
  it("throws for non-curl commands", () => {
    expect(() => parseCurl("wget https://a.com")).toThrow();
  });
});

describe("envVarsToMap / substituteVars / extractVars", () => {
  it("builds a map after filtering disabled entries", () => {
    const map = envVarsToMap([
      { key: "host", value: "api.test.com", on: true },
      { key: "token", value: "abc", on: false },
      { key: "", value: "x", on: true },
    ]);
    expect(map).toEqual({ host: "api.test.com" });
  });
  it("replaces {{name}}, keeps unknown variables", () => {
    const map = { host: "api.test.com", ver: "v2" };
    expect(substituteVars("https://{{host}}/{{ver}}/u/{{missing}}", map)).toBe("https://api.test.com/v2/u/{{missing}}");
    expect(substituteVars("{{ host }}", map)).toBe("api.test.com");
  });
 it("returns text as-is without {{", () => {
    expect(substituteVars("plain", { a: 1 })).toBe("plain");
  });
  it("extracts referenced variable names without duplicates", () => {
    expect(extractVars("{{a}}/{{b}}/{{a}}")).toEqual(["a", "b"]);
  });
});

describe("formEncode / parseFormText", () => {
  it("encodes pairs as urlencoded, filtering disabled entries", () => {
    expect(formEncode([
      { key: "name", value: "\u5f20 \u4e09", on: true },
      { key: "skip", value: "1", on: false },
      { key: "", value: "x", on: true },
    ])).toBe("name=%E5%BC%A0%20%E4%B8%89");
  });
  it("parses urlencoded text into pairs", () => {
    expect(parseFormText("a=1&b=hello%20world")).toEqual([
      { key: "a", value: "1", on: true },
      { key: "b", value: "hello world", on: true },
    ]);
  });
});

describe("dispositionName", () => {
  it("parses a plain filename", () => {
    expect(dispositionName('attachment; filename="report.pdf"')).toBe("report.pdf");
    expect(dispositionName("attachment; filename=report.pdf")).toBe("report.pdf");
  });
  it("prefers RFC 5987 filename* (percent-encoded)", () => {
    expect(dispositionName("attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip")).toBe("\u4e2d\u6587.zip");
  });
  it("returns an empty string without Content-Disposition", () => {
    expect(dispositionName("")).toBe("");
    expect(dispositionName("inline")).toBe("");
  });
});

describe("suggestFileName", () => {
  it("Content-Disposition wins over URL", () => {
    const headers = [["Content-Disposition", 'attachment; filename="api.xlsx"']];
    expect(suggestFileName(headers, "https://a.com/download?id=1")).toBe("api.xlsx");
  });
  it("falls back to the URL segment (decoded, sanitized), then download", () => {
    expect(suggestFileName([], "https://a.com/files/%E5%9B%BE%E7%89%87.png")).toBe("\u56fe\u7247.png");
    expect(suggestFileName([], "https://a.com/files/a/b")).toBe("b");
    expect(suggestFileName([], "")).toBe("download");
  });
  it("sanitizes illegal characters to underscores", () => {
    expect(suggestFileName([["Content-Disposition", 'attachment; filename="a/b\\c:d"']], "https://a.com")).toBe("a_b_c_d");
  });
});

describe("describeContentType", () => {
  it("maps common types to friendly descriptions", () => {
    expect(describeContentType("application/pdf")).toBe("PDF \u6587\u6863");
    expect(describeContentType("application/zip")).toBe("ZIP \u538b\u7f29\u5305");
    expect(describeContentType("image/png")).toBe("PNG \u56fe\u7247");
    expect(describeContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("Excel \u8868\u683c");
  });
  it("prefix grouping and default fallback", () => {
    expect(describeContentType("image/webp; charset=utf-8")).toBe("WebP \u56fe\u7247");
    expect(describeContentType("audio/mpeg")).toBe("\u97f3\u9891");
    expect(describeContentType("application/octet-stream")).toBe("\u4e8c\u8fdb\u5236\u6587\u4ef6");
    expect(describeContentType("application/x-unknown")).toBe("\u6587\u4ef6");
  });
});
