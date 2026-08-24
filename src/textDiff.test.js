import { describe, expect, it } from "vitest";
import { buildTextDiff, createUnifiedDiff, splitTextLines } from "./textDiff.js";

describe("splitTextLines", () => {
  it("统一换行符且忽略文件末尾换行差异", () => {
    expect(splitTextLines("第一行\r\n第二行\r\n")).toEqual(["第一行", "第二行"]);
    expect(splitTextLines("")).toEqual([]);
  });
});

describe("buildTextDiff", () => {
  it("将相邻删除与新增配对为修改行", () => {
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

  it("保留纯删除行及两侧真实行号", () => {
    const result = buildTextDiff("one\ntwo\nthree", "one\nthree");

    expect(result.rows[1]).toEqual({
      type: "removed",
      left: { number: 2, text: "two" },
      right: null,
    });
    expect(result.rows[2].left.number).toBe(3);
    expect(result.rows[2].right.number).toBe(2);
  });

  it("可忽略行首尾空白和大小写，展示仍保留原文", () => {
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

  it("正确处理左右空文本", () => {
    expect(buildTextDiff("", "新增").rows).toEqual([{
      type: "added",
      left: null,
      right: { number: 1, text: "新增" },
    }]);
    expect(buildTextDiff("", "").rows).toEqual([]);
  });
});

describe("createUnifiedDiff", () => {
  it("生成可复制的 unified diff", () => {
    const patch = createUnifiedDiff("old\nkeep", "new\nkeep");

    expect(patch).toContain("--- 原始文本");
    expect(patch).toContain("+++ 新文本");
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
  });

  it("无有效差异时返回空串", () => {
    expect(createUnifiedDiff(" Hello ", "hello", {
      ignoreWhitespace: true,
      ignoreCase: true,
    })).toBe("");
  });

  it("存在真实差异时，补丁仍忽略仅大小写变化", () => {
    const patch = createUnifiedDiff("Hello\nold", "hello\nnew", { ignoreCase: true });
    expect(patch).not.toContain("-Hello");
    expect(patch).not.toContain("+hello");
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
  });
});
