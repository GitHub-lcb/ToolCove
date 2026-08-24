import { describe, it, expect } from "vitest";
import { highlightLine, highlightLines } from "./jsonHighlight.js";

describe("highlightLine", () => {
  it("colors keys and string values differently", () => {
    // value 研发小助手 kept as unicode escapes
    const toks = highlightLine('  "name": "\u7814\u53d1\u5c0f\u52a9\u624b",');
    expect(toks.find((t) => t.t === '"name"').c).toBe("key");
    expect(toks.find((t) => t.t === '"\u7814\u53d1\u5c0f\u52a9\u624b"').c).toBe("str");
    expect(toks.filter((t) => t.c === "punct").map((t) => t.t)).toEqual([":", ","]);
  });

  it("classifies numbers, booleans and null", () => {
    expect(highlightLine('"id": -1.5e3').find((t) => t.c === "num").t).toBe("-1.5e3");
    expect(highlightLine('"on": true').find((t) => t.c === "bool").t).toBe("true");
    expect(highlightLine('"off": false').find((t) => t.c === "bool").t).toBe("false");
    expect(highlightLine('"v": null').find((t) => t.c === "null").t).toBe("null");
  });

  it("escaped quotes and colons inside strings do not break tokenizing", () => {
    const toks = highlightLine('"a\\"b": "x:y"');
    expect(toks[0]).toEqual({ t: '"a\\"b"', c: "key" });
    expect(toks.find((t) => t.t === '"x:y"').c).toBe("str");
  });

  it("concatenated tokens match the original line (nothing lost)", () => {
    const line = '  { "k": [1, true, null, "s"] },';
    expect(highlightLine(line).map((t) => t.t).join("")).toBe(line);
  });
});

describe("highlightLines", () => {
  it("splits by line and is safe for empty input", () => {
    expect(highlightLines('{\n  "a": 1\n}')).toHaveLength(3);
    expect(highlightLines("")).toEqual([[]]);
    expect(highlightLines(null)).toEqual([[]]);
  });
});
