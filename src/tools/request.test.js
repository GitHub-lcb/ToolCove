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
  it("拆分 base 与查询参数（含解码）", () => {
    const r = splitUrl("https://api.example.com/users?page=1&size=10&q=hello%20world");
    expect(r.base).toBe("https://api.example.com/users");
    expect(r.query).toEqual([
      { key: "page", value: "1", on: true },
      { key: "size", value: "10", on: true },
      { key: "q", value: "hello world", on: true },
    ]);
  });
  it("无查询串时 query 为空", () => {
    expect(splitUrl("https://a.com/x").query).toEqual([]);
  });
  it("忽略 hash 片段", () => {
    expect(splitUrl("https://a.com/x?a=1#frag").query).toEqual([{ key: "a", value: "1", on: true }]);
  });
});

describe("buildUrl", () => {
  it("拼接开启的参数并编码", () => {
    const url = buildUrl("https://a.com/x", [
      { key: "q", value: "a b", on: true },
      { key: "skip", value: "1", on: false },
      { key: "", value: "x", on: true },
    ]);
    expect(url).toBe("https://a.com/x?q=a%20b");
  });
  it("base 已含 ? 时用 & 续接", () => {
    expect(buildUrl("https://a.com/x?fixed=1", [{ key: "a", value: "2", on: true }])).toBe("https://a.com/x?fixed=1&a=2");
  });
  it("无有效参数返回原 base", () => {
    expect(buildUrl("https://a.com", [])).toBe("https://a.com");
  });
});

describe("headersToPairs / findHeader", () => {
  it("过滤关闭项与空键", () => {
    const pairs = headersToPairs([
      { key: "Accept", value: "application/json", on: true },
      { key: "X-Off", value: "1", on: false },
      { key: "", value: "y", on: true },
    ]);
    expect(pairs).toEqual([["Accept", "application/json"]]);
  });
  it("忽略大小写查响应头", () => {
    const pairs = [["Content-Type", "application/json"]];
    expect(findHeader(pairs, "content-type")).toBe("application/json");
    expect(findHeader(pairs, "missing")).toBe("");
  });
});

describe("detectBodyLang", () => {
  it("优先按 content-type", () => {
    expect(detectBodyLang("application/json; charset=utf-8", "")).toBe("json");
    expect(detectBodyLang("text/html", "")).toBe("html");
    expect(detectBodyLang("application/xml", "")).toBe("xml");
  });
  it("无 content-type 时按内容嗅探", () => {
    expect(detectBodyLang("", '{"a":1}')).toBe("json");
    expect(detectBodyLang("", "<!DOCTYPE html><html></html>")).toBe("html");
    expect(detectBodyLang("", "<?xml version=\"1.0\"?><a/>")).toBe("xml");
    expect(detectBodyLang("", "plain text")).toBe("text");
  });
});

describe("prettyBody", () => {
  it("JSON 美化，非法 JSON 原样", () => {
    expect(prettyBody('{"a":1}', "json")).toBe('{\n  "a": 1\n}');
    expect(prettyBody("{bad}", "json")).toBe("{bad}");
    expect(prettyBody("<html>", "html")).toBe("<html>");
  });
});

describe("sizeText / statusClass", () => {
  it("字节可读化", () => {
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(2048)).toBe("2.00 KB");
    expect(sizeText(3 * 1024 * 1024)).toBe("3.00 MB");
  });
  it("状态码归类", () => {
    expect(statusClass(200)).toBe("ok");
    expect(statusClass(301)).toBe("redirect");
    expect(statusClass(404)).toBe("client");
    expect(statusClass(500)).toBe("server");
    expect(statusClass(0)).toBe("other");
  });
});

describe("parseCurl", () => {
  it("解析方法 / URL / 头 / 体", () => {
    const r = parseCurl(`curl -X POST 'https://api.example.com/users' -H 'Content-Type: application/json' -H 'Authorization: Bearer t' -d '{"name":"张三"}'`);
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.example.com/users");
    expect(r.headers).toEqual([
      { key: "Content-Type", value: "application/json", on: true },
      { key: "Authorization", value: "Bearer t", on: true },
    ]);
    expect(r.body).toBe('{"name":"张三"}');
  });
  it("有 data 无 -X 时默认 POST", () => {
    expect(parseCurl("curl https://a.com -d 'x=1'").method).toBe("POST");
  });
  it("纯 URL 默认 GET，支持跨行续行符", () => {
    const r = parseCurl("curl \\\n  https://a.com/x?a=1 \\\n  -H 'Accept: */*'");
    expect(r.method).toBe("GET");
    expect(r.url).toBe("https://a.com/x?a=1");
    expect(r.headers).toEqual([{ key: "Accept", value: "*/*", on: true }]);
  });
  it("-u 转 Basic Auth 头", () => {
    const r = parseCurl("curl https://a.com -u user:pass");
    expect(r.headers[0].key).toBe("Authorization");
    expect(r.headers[0].value).toBe("Basic " + btoa("user:pass"));
  });
  it("非 curl 命令抛错", () => {
    expect(() => parseCurl("wget https://a.com")).toThrow();
  });
});

describe("envVarsToMap / substituteVars / extractVars", () => {
  it("过滤关闭项与空键后构成映射", () => {
    const map = envVarsToMap([
      { key: "host", value: "api.test.com", on: true },
      { key: "token", value: "abc", on: false },
      { key: "", value: "x", on: true },
    ]);
    expect(map).toEqual({ host: "api.test.com" });
  });
  it("替换 {{name}}，未知变量原样保留", () => {
    const map = { host: "api.test.com", ver: "v2" };
    expect(substituteVars("https://{{host}}/{{ver}}/u/{{missing}}", map)).toBe("https://api.test.com/v2/u/{{missing}}");
    expect(substituteVars("{{ host }}", map)).toBe("api.test.com");
  });
  it("无 {{ 时原样返回", () => {
    expect(substituteVars("plain", { a: 1 })).toBe("plain");
  });
  it("提取引用变量名并去重", () => {
    expect(extractVars("{{a}}/{{b}}/{{a}}")).toEqual(["a", "b"]);
  });
});

describe("formEncode / parseFormText", () => {
  it("键值对编码为 urlencoded并过滤关闭项", () => {
    expect(formEncode([
      { key: "name", value: "张 三", on: true },
      { key: "skip", value: "1", on: false },
      { key: "", value: "x", on: true },
    ])).toBe("name=%E5%BC%A0%20%E4%B8%89");
  });
  it("解析 urlencoded 文本为键值对", () => {
    expect(parseFormText("a=1&b=hello%20world")).toEqual([
      { key: "a", value: "1", on: true },
      { key: "b", value: "hello world", on: true },
    ]);
  });
});

describe("dispositionName", () => {
  it("解析普通 filename", () => {
    expect(dispositionName('attachment; filename="report.pdf"')).toBe("report.pdf");
    expect(dispositionName("attachment; filename=report.pdf")).toBe("report.pdf");
  });
  it("优先解析 RFC 5987 filename*（百分号编码）", () => {
    expect(dispositionName("attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip")).toBe("中文.zip");
  });
  it("无 Content-Disposition 或空值时返回空串", () => {
    expect(dispositionName("")).toBe("");
    expect(dispositionName("inline")).toBe("");
  });
});

describe("suggestFileName", () => {
  it("Content-Disposition 优先于 URL", () => {
    const headers = [["Content-Disposition", 'attachment; filename="api.xlsx"']];
    expect(suggestFileName(headers, "https://a.com/download?id=1")).toBe("api.xlsx");
  });
  it("无响应头时取 URL 末段（解码 + 去非法字符），无末段才兜底 download", () => {
    expect(suggestFileName([], "https://a.com/files/%E5%9B%BE%E7%89%87.png")).toBe("图片.png");
    expect(suggestFileName([], "https://a.com/files/a/b")).toBe("b");
    expect(suggestFileName([], "")).toBe("download");
  });
  it("非法文件名清洗为下划线，空则兜底 download", () => {
    expect(suggestFileName([["Content-Disposition", 'attachment; filename="a/b\\c:d"']], "https://a.com")).toBe("a_b_c_d");
  });
});

describe("describeContentType", () => {
  it("常见类型映射为友好描述", () => {
    expect(describeContentType("application/pdf")).toBe("PDF 文档");
    expect(describeContentType("application/zip")).toBe("ZIP 压缩包");
    expect(describeContentType("image/png")).toBe("PNG 图片");
    expect(describeContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("Excel 表格");
  });
  it("前缀归类与默认兜底", () => {
    expect(describeContentType("image/webp; charset=utf-8")).toBe("WebP 图片");
    expect(describeContentType("audio/mpeg")).toBe("音频");
    expect(describeContentType("application/octet-stream")).toBe("二进制文件");
    expect(describeContentType("application/x-unknown")).toBe("文件");
  });
});
