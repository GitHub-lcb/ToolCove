import { describe, expect, it } from "vitest";
import { formatYaml, jsonToYaml, lintYaml, parseYaml, yamlToJson } from "./yaml.js";

describe("parseYaml", () => {
  it("解析基本键值、嵌套结构与数组", () => {
    const r = parseYaml("server:\n  hosts:\n    - a\n    - b\n  port: 80\nenabled: true");
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ server: { hosts: ["a", "b"], port: 80 }, enabled: true });
    expect(r.documentCount).toBe(1);
  });

  it("区分空来源和显式 null 文档", () => {
    expect(parseYaml("").documentCount).toBe(0);
    expect(parseYaml("# 只有注释\n").documentCount).toBe(0);
    const explicitNull = parseYaml("null");
    expect(explicitNull.documentCount).toBe(1);
    expect(explicitNull.value).toBe(null);
  });

  it("多文档返回数组并保留文档数量", () => {
    const r = parseYaml("a: 1\n---\nb: 2\n");
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r.documentCount).toBe(2);
    expect(r.multiple).toBe(true);
  });

  it("支持工程配置中常见的合并键", () => {
    const r = parseYaml("defaults: &defaults\n  retries: 3\nservice:\n  <<: *defaults\n  name: api");
    expect(r.ok).toBe(true);
    expect(r.value.service).toEqual({ retries: 3, name: "api" });
  });

  it("重复键、制表符缩进和危险标签均报错", () => {
    expect(parseYaml("a: 1\na: 2").ok).toBe(false);
    expect(parseYaml("a:\n\tb: 1").ok).toBe(false);
    expect(parseYaml("fn: !!js/function 'function(){}'").ok).toBe(false);
  });

  it("语法错误带 1 起算的行列", () => {
    const r = parseYaml("a: 1\nb: [1, 2\nc: 3");
    expect(r.ok).toBe(false);
    expect(r.error.line).toBeGreaterThan(0);
    expect(r.error.column).toBeGreaterThan(0);
  });

  it("限制单文档中的别名数量", () => {
    const refs = Array.from({ length: 60 }, () => "*base").join(", ");
    const r = parseYaml(`base: &base value\nrefs: [${refs}]`);
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain("别名");
  });
});

describe("yamlToJson", () => {
  it("转换为格式化 JSON", () => {
    const r = yamlToJson("name: x\nlist:\n  - 1\n  - 2", 2);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.output)).toEqual({ name: "x", list: [1, 2] });
    expect(r.value).toEqual({ name: "x", list: [1, 2] });
  });

  it("空来源返回 empty，显式 null 输出 null", () => {
    expect(yamlToJson("  \n").empty).toBe(true);
    expect(yamlToJson("null").output).toBe("null");
  });

  it("合法循环锚点只阻止转换，不影响语法解析", () => {
    const source = "node: &node\n  self: *node";
    expect(parseYaml(source).ok).toBe(true);
    const r = yamlToJson(source);
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe("conversion");
    expect(r.error.message).toContain("循环引用");
  });

  it("在别名展开结果过大前停止转换", () => {
    let source = "a0: &a0 [x]\n";
    for (let i = 1; i <= 8; i++) {
      source += `a${i}: &a${i} [*a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}]\n`;
    }
    const r = yamlToJson(source);
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe("conversion");
    expect(r.error.message).toContain("过大");
  });

  it("拒绝 JSON 无法表达的非有限数字", () => {
    const r = yamlToJson("limit: .inf");
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain("非有限数字");
  });
});

describe("formatYaml / jsonToYaml", () => {
  it("格式化 YAML 后数据保持等价", () => {
    const r = formatYaml("server: {port: 80, enabled: true}\n");
    expect(r.ok).toBe(true);
    expect(parseYaml(r.output).value).toEqual({ server: { port: 80, enabled: true } });
  });

  it("格式化时保留多文档边界", () => {
    const r = formatYaml("a: 1\n---\nb: 2");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("---");
    expect(parseYaml(r.output).documentCount).toBe(2);
  });

  it("JSON 可以转换为 YAML，非法 JSON 返回原始行列错误", () => {
    const r = jsonToYaml('{"name":"api","ports":[80,443]}');
    expect(r.ok).toBe(true);
    expect(parseYaml(r.output).value).toEqual({ name: "api", ports: [80, 443] });

    const bad = jsonToYaml('{"a":1 "b":2}');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  });
});

describe("lintYaml", () => {
  it("提示高置信度的输入和兼容性问题", () => {
    const warnings = lintYaml("server  : 80\nflag: ON\nname: value  \n　child: 1\nport： 80");
    expect(warnings.some((x) => x.message.includes("冒号之间"))).toBe(true);
    expect(warnings.some((x) => x.message.includes("YAML 1.1"))).toBe(true);
    expect(warnings.some((x) => x.message.includes("行尾"))).toBe(true);
    expect(warnings.some((x) => x.message.includes("全角空格"))).toBe(true);
    expect(warnings.some((x) => x.message.includes("全角冒号"))).toBe(true);
  });

  it("True/False 在当前 schema 下是布尔值，不提示为字符串", () => {
    expect(lintYaml("enabled: True\ndisabled: FALSE").filter((x) => x.message.includes("布尔"))).toEqual([]);
  });

  it("不误报行内注释、已引用键、列表对象、多文档和块标量", () => {
    const source = [
      "name: test # 行内注释",
      '"display name": Alice',
      "items:",
      "  - name: a",
      "  - name: b",
      "---",
      "items:",
      "  - name: c",
      "message: |",
      "  path:C:\\work",
      "  中文：说明",
    ].join("\n");
    expect(parseYaml(source).ok).toBe(true);
    expect(lintYaml(source)).toEqual([]);
  });

  it("普通 URL 和 Windows 路径标量不做键值猜测", () => {
    expect(lintYaml("http://example.com/a:b\n---\nC:\\work")).toEqual([]);
  });
});
