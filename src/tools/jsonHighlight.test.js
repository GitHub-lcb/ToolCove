import { describe, it, expect } from "vitest";
import { highlightLine, highlightLines } from "./jsonHighlight.js";

describe("highlightLine", () => {
  it("键与字符串值区分着色", () => {
    const toks = highlightLine('  "name": "研发小助手",');
    expect(toks.find((t) => t.t === '"name"').c).toBe("key");
    expect(toks.find((t) => t.t === '"研发小助手"').c).toBe("str");
    expect(toks.filter((t) => t.c === "punct").map((t) => t.t)).toEqual([":", ","]);
  });

  it("数字、布尔、null 各归其类", () => {
    expect(highlightLine('"id": -1.5e3').find((t) => t.c === "num").t).toBe("-1.5e3");
    expect(highlightLine('"on": true').find((t) => t.c === "bool").t).toBe("true");
    expect(highlightLine('"off": false').find((t) => t.c === "bool").t).toBe("false");
    expect(highlightLine('"v": null').find((t) => t.c === "null").t).toBe("null");
  });

  it("字符串含转义引号与冒号不破坏分词", () => {
    const toks = highlightLine('"a\\"b": "x:y"');
    expect(toks[0]).toEqual({ t: '"a\\"b"', c: "key" });
    expect(toks.find((t) => t.t === '"x:y"').c).toBe("str");
  });

  it("拼接结果与原行一致（无丢字）", () => {
    const line = '  { "k": [1, true, null, "s"] },';
    expect(highlightLine(line).map((t) => t.t).join("")).toBe(line);
  });
});

describe("highlightLines", () => {
  it("按行切分且空输入安全", () => {
    expect(highlightLines('{\n  "a": 1\n}')).toHaveLength(3);
    expect(highlightLines("")).toEqual([[]]);
    expect(highlightLines(null)).toEqual([[]]);
  });
});
