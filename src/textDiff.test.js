import { describe, expect, it } from "vitest";
import { i18n } from "./i18n/index.js";
import { buildTextDiff, createUnifiedDiff, splitTextLines } from "./textDiff.js";

describe("splitTextLines", () => {
  it("normalizes line breaks and ignores trailing newline diff", () => {
    expect(splitTextLines("line-a\r\nline-b\r\n")).toEqual(["line-a", "line-b"]);
    expect(splitTextLines("")).toEqual([]);
  });
});

describe("buildTextDiff", () => {
  it("pairs adjacent removal and addition as modified rows", () => {
    const result = buildTextDiff("one\ntwo\nthree", "one\nTWO\nfour\nthree");

    expect(result.rows.map((row) => row.type)).toEqual(["equal", "modified", "added", "equal"]);
    expect(result.rows[1]).toMatchObject({
      left: { number: 2, text: "two" },
      right: { number: 2, text: "TWO" },
    });
    expect(result.rows[2]).toMatchObject({
      left: null,
      right: { number: 3, text: "four" },
    });
    expect(result.stats).toEqual({ added: 1, removed: 0, modified: 1, unchanged: 2 });
  });

  it("keeps pure removal rows with real line numbers on both sides", () => {
    const result = buildTextDiff("one\ntwo\nthree", "one\nthree");

    expect(result.rows[1]).toEqual({
      type: "removed",
      left: { number: 2, text: "two" },
      right: null,
    });
    expect(result.rows[2].left.number).toBe(3);
    expect(result.rows[2].right.number).toBe(2);
  });

  it("can ignore whitespace and case while display keeps original text", () => {
    const result = buildTextDiff("  Hello World  ", "hello world", {
      ignoreWhitespace: true,
      ignoreCase: true,
    });

    expect(result.rows).toEqual([{
      type: "equal",
      left: { number: 1, text: "  Hello World  " },
      right: { number: 1, text: "hello world" },
    }]);
    expect(result.hasChanges).toBe(false);
  });

  it("handles empty left/right text", () => {
    expect(buildTextDiff("", "added").rows).toEqual([{
      type: "added",
      left: null,
      right: { number: 1, text: "added" },
    }]);
    expect(buildTextDiff("", "").rows).toEqual([]);
  });
});

describe("createUnifiedDiff", () => {
  it("produces a copyable unified diff", () => {
    const patch = createUnifiedDiff("old\nkeep", "new\nkeep");

    expect(patch).toContain(`--- ${i18n.global.t("toolbox.diff.leftName")}`);
    expect(patch).toContain(`+++ ${i18n.global.t("toolbox.diff.rightName")}`);
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
  });

  it("returns empty string when no effective diff", () => {
    expect(createUnifiedDiff(" Hello ", "hello", {
      ignoreWhitespace: true,
      ignoreCase: true,
    })).toBe("");
  });

  it("with real diffs, patch still ignores case-only changes", () => {
    const patch = createUnifiedDiff("Hello\nold", "hello\nnew", { ignoreCase: true });
    expect(patch).not.toContain("-Hello");
    expect(patch).not.toContain("+hello");
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
  });
});
