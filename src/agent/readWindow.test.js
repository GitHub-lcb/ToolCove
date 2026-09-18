import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW,
  MAX_WINDOW,
  createReadWindow,
  findKeyword,
  missNote,
  readSpillResult,
  readWindowResult,
  windowNote,
} from "./readWindow.js";

const text = "line1\nline2\nline3\nline4";

describe("createReadWindow", () => {
  it("returns the whole text when it fits", () => {
    const meta = createReadWindow(text, {});
    expect(meta.text).toBe(text);
    expect(meta.hasMore).toBe(false);
    expect(meta.nextOffset).toBe(null);
    expect(meta.offset).toBe(0);
    expect(meta.end).toBe(text.length);
    expect(meta.totalLines).toBe(4);
  });

  it("slices by offset and reports how to continue", () => {
    const meta = createReadWindow(text, { offset: 6, limit: 5 });
    expect(meta.text).toBe("line2");
    expect(meta.hasMore).toBe(true);
    expect(meta.nextOffset).toBe(11);
    expect(meta.windowLine).toBe(2);
    expect(meta.overLimit).toBe(true);
  });

  it("clamps nonsense offsets and limits instead of throwing", () => {
    expect(createReadWindow(text, { offset: -5 }).offset).toBe(0);
    expect(createReadWindow(text, { offset: 9999 }).offset).toBe(text.length);
    expect(createReadWindow(text, { offset: 9999 }).text).toBe("");
    expect(createReadWindow(text, { offset: 0, limit: 10 ** 9 }).limit).toBe(MAX_WINDOW);
    expect(createReadWindow(text, { offset: "abc", limit: "abc" }).limit).toBe(DEFAULT_WINDOW);
  });

  it("documents offset as a 0-based character position", () => {
    // nextOffset 可直接回填，所以口径必须是 0 基；这里把它钉住，避免以后被改成 1 基。
    expect(createReadWindow(text, { offset: 1, limit: 5 }).text).toBe("ine1\n");
  });

  it("counts lines without an extra line for a trailing newline", () => {
    expect(createReadWindow("a\nb\n", {}).totalLines).toBe(2);
    expect(createReadWindow("", {}).totalLines).toBe(0);
  });

  it("survives non-string sources", () => {
    expect(createReadWindow({ a: 1 }, {}).text).toBe("[object Object]");
    expect(createReadWindow(null, {}).text).toBe("");
  });
});

describe("windowNote", () => {
  it("stays quiet when nothing was cut", () => {
    expect(windowNote({ hasMore: false })).toBe("");
  });

  it("tells the model the exact next offset", () => {
    const meta = createReadWindow(text, { offset: 0, limit: 6 });
    const note = windowNote(meta);
    expect(note).toContain("offset=6");
    expect(note).toContain(`共 ${text.length} 字符`);
  });

  it("works on the readWindowResult shape", () => {
    const result = readWindowResult(text, { offset: 0, limit: 6 });
    expect(result.note).toBe(windowNote(result));
    expect(result.text).toBe("line1\n");
  });
});

describe("findKeyword", () => {
  it("locates hits with line numbers and context", () => {
    const hits = findKeyword(text, "line3");
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
    expect(hits[0].context).toContain("line3");
  });

  it("is case-insensitive and caps the number of hits", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Row ${i} ERROR`).join("\n");
    const hits = findKeyword(many, "error", { limit: 3 });
    expect(hits).toHaveLength(3);
    expect(hits[0].line).toBe(1);
  });

  it("returns nothing for an empty or missing keyword", () => {
    expect(findKeyword(text, "")).toEqual([]);
    expect(findKeyword(text, "   ")).toEqual([]);
    expect(findKeyword(text, "nope")).toEqual([]);
  });
});

describe("readSpillResult", () => {
  it("reads a window by default", () => {
    const out = readSpillResult(text, { offset: 0, limit: 5 });
    expect(out.mode).toBe("window");
    expect(out.text).toBe("line1");
    expect(out.nextOffset).toBe(5);
  });

  it("prefers keyword search when one is given", () => {
    const out = readSpillResult(text, { keyword: "line4" });
    expect(out.mode).toBe("keyword");
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].line).toBe(4);
  });

  it("explains a miss instead of just failing", () => {
    const out = readSpillResult(text, { keyword: "zzz" });
    expect(out.hits).toEqual([]);
    expect(out.note).toBe(missNote("zzz", { totalChars: text.length }));
    expect(out.note).toContain("分段读取");
  });
});
