import { describe, expect, it } from "vitest";
import { formatYaml, jsonToYaml, lintYaml, parseYaml, yamlToJson } from "./yaml.js";

describe("parseYaml", () => {
  it("parses basic key/values, nested structures and arrays", () => {
    const r = parseYaml("server:\n  hosts:\n    - a\n    - b\n  port: 80\nenabled: true");
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ server: { hosts: ["a", "b"], port: 80 }, enabled: true });
    expect(r.documentCount).toBe(1);
  });

  it("distinguishes empty sources from explicit null documents", () => {
    expect(parseYaml("").documentCount).toBe(0);
    // comment 只有注释 kept as unicode escapes
    expect(parseYaml("# \u53ea\u6709\u6ce8\u91ca\n").documentCount).toBe(0);
    const explicitNull = parseYaml("null");
    expect(explicitNull.documentCount).toBe(1);
    expect(explicitNull.value).toBe(null);
  });

  it("multi-document sources return arrays and keep the document count", () => {
    const r = parseYaml("a: 1\n---\nb: 2\n");
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r.documentCount).toBe(2);
    expect(r.multiple).toBe(true);
  });

  it("supports merge keys common in engineering configs", () => {
    const r = parseYaml("defaults: &defaults\n  retries: 3\nservice:\n  <<: *defaults\n  name: api");
    expect(r.ok).toBe(true);
    expect(r.value.service).toEqual({ retries: 3, name: "api" });
  });

  it("duplicate keys, tab indentation and unsafe tags all fail", () => {
    expect(parseYaml("a: 1\na: 2").ok).toBe(false);
    expect(parseYaml("a:\n\tb: 1").ok).toBe(false);
    expect(parseYaml("fn: !!js/function 'function(){}'").ok).toBe(false);
  });

  it("syntax errors carry 1-based line/column", () => {
    const r = parseYaml("a: 1\nb: [1, 2\nc: 3");
    expect(r.ok).toBe(false);
    expect(r.error.line).toBeGreaterThan(0);
    expect(r.error.column).toBeGreaterThan(0);
  });

  it("limits the alias count per document", () => {
    const refs = Array.from({ length: 60 }, () => "*base").join(", ");
    const r = parseYaml(`base: &base value\nrefs: [${refs}]`);
    expect(r.ok).toBe(false);
    // zh message contains 别名 (alias)
    expect(r.error.message).toContain("\u522b\u540d");
  });
});

describe("yamlToJson", () => {
  it("converts to pretty-printed JSON", () => {
    const r = yamlToJson("name: x\nlist:\n  - 1\n  - 2", 2);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.output)).toEqual({ name: "x", list: [1, 2] });
    expect(r.value).toEqual({ name: "x", list: [1, 2] });
  });

  it("empty sources return empty; explicit null outputs null", () => {
    expect(yamlToJson("  \n").empty).toBe(true);
    expect(yamlToJson("null").output).toBe("null");
  });

  it("legal circular anchors block conversion only, not syntax parsing", () => {
    const source = "node: &node\n  self: *node";
    expect(parseYaml(source).ok).toBe(true);
    const r = yamlToJson(source);
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe("conversion");
    // zh message contains 循环引用 (circular reference)
    expect(r.error.message).toContain("\u5faa\u73af\u5f15\u7528");
  });

  it("stops conversion before alias expansion grows too large", () => {
    let source = "a0: &a0 [x]\n";
    for (let i = 1; i <= 8; i++) {
      source += `a${i}: &a${i} [*a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}]\n`;
    }
    const r = yamlToJson(source);
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe("conversion");
    // zh message contains 过大 (too large)
    expect(r.error.message).toContain("\u8fc7\u5927");
  });

  it("rejects non-finite numbers JSON cannot express", () => {
    const r = yamlToJson("limit: .inf");
    expect(r.ok).toBe(false);
    // zh message contains 非有限数字 (non-finite number)
    expect(r.error.message).toContain("\u975e\u6709\u9650\u6570\u5b57");
  });
});

describe("formatYaml / jsonToYaml", () => {
  it("formatting YAML keeps data equivalent", () => {
    const r = formatYaml("server: {port: 80, enabled: true}\n");
    expect(r.ok).toBe(true);
    expect(parseYaml(r.output).value).toEqual({ server: { port: 80, enabled: true } });
  });

  it("formatting preserves multi-document boundaries", () => {
    const r = formatYaml("a: 1\n---\nb: 2");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("---");
    expect(parseYaml(r.output).documentCount).toBe(2);
  });

  it("JSON converts to YAML; invalid JSON returns the original line/column error", () => {
    const r = jsonToYaml('{"name":"api","ports":[80,443]}');
    expect(r.ok).toBe(true);
    expect(parseYaml(r.output).value).toEqual({ name: "api", ports: [80, 443] });

    const bad = jsonToYaml('{"a":1 "b":2}');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  });
});

describe("lintYaml", () => {
  it("reports high-confidence input and compatibility problems", () => {
    const warnings = lintYaml("server  : 80\nflag: ON\nname: value  \n\u3000child: 1\nport\uff1a 80");
    // assertion fragments match the zh dictionary texts
    expect(warnings.some((x) => x.message.includes("\u5192\u53f7\u4e4b\u95f4"))).toBe(true);
    expect(warnings.some((x) => x.message.includes("YAML 1.1"))).toBe(true);
    expect(warnings.some((x) => x.message.includes("\u884c\u5c3e"))).toBe(true);
    expect(warnings.some((x) => x.message.includes("\u5168\u89d2\u7a7a\u683c"))).toBe(true);
    expect(warnings.some((x) => x.message.includes("\u5168\u89d2\u5192\u53f7"))).toBe(true);
  });

  it("True/False are booleans under the current schema and not flagged as strings", () => {
    expect(lintYaml("enabled: True\ndisabled: FALSE").filter((x) => x.message.includes("\u5e03\u5c14"))).toEqual([]);
  });

  it("does not false-alarm on inline comments, quoted keys, list objects, multi-docs and block scalars", () => {
    const source = [
      // inline comment 行内注释 and 中文：说明 kept as unicode escapes
      "name: test # \u884c\u5185\u6ce8\u91ca",
      '"display name": Alice',
      "items:",
      "  - name: a",
      "  - name: b",
      "---",
      "items:",
      "  - name: c",
      "message: |",
      "  path:C:\\work",
      "  \u4e2d\u6587\uff1a\u8bf4\u660e",
    ].join("\n");
    expect(parseYaml(source).ok).toBe(true);
    expect(lintYaml(source)).toEqual([]);
  });

  it("plain URLs and Windows path scalars get no key/value guessing", () => {
    expect(lintYaml("http://example.com/a:b\n---\nC:\\work")).toEqual([]);
  });
});
