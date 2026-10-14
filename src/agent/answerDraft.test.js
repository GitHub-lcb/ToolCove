// Agent 结论写回记录的纯函数单测：答复正文 → 速记/问题草稿的字段映射。
// 字段形状必须与 SnippetView / ProblemView 的手动新建一致，否则写回记录在现有界面打不开。
import { describe, it, expect } from "vitest";
import { answerSummary, answerToSnippetDraft, answerToProblemDraft } from "./answerDraft.js";

describe("answerSummary", () => {
  it("跳过 Markdown 标题，取第一条正文", () => {
    expect(answerSummary("# 结论\n\n已经修复了导出的问题")).toBe("已经修复了导出的问题");
  });

  it("剥掉列表 / 引用 / 有序列表前缀", () => {
    expect(answerSummary("## 概述\n- 先读文件\n- 再写回")).toBe("先读文件");
    expect(answerSummary("> 这就是答案")).toBe("这就是答案");
    expect(answerSummary("1. 第一步")).toBe("第一步");
  });

  it("超长截断补省略号", () => {
    expect(answerSummary("a".repeat(80), 10)).toBe("a".repeat(10) + "…");
  });

  it("全是标题时退回正文前缀（不返回空）", () => {
    expect(answerSummary("# 只有标题")).toContain("只有标题");
  });

  it("空内容返回空串", () => {
    expect(answerSummary("")).toBe("");
    expect(answerSummary(null)).toBe("");
  });
});

describe("answerToSnippetDraft", () => {
  it("按 SnippetView 的字段形状产出速记草稿，正文完整保留", () => {
    const draft = answerToSnippetDraft("# 结论\n导出成功");
    expect(draft).toEqual({
      title: "导出成功",
      category: "",
      content: "# 结论\n导出成功",
      fields: [],
      images: [],
      pinned: false,
    });
  });
});

describe("answerToProblemDraft", () => {
  it("按 ProblemView 的字段形状产出问题草稿，正文进 note", () => {
    const draft = answerToProblemDraft("# 结论\n导出成功");
    expect(draft).toEqual({
      title: "导出成功",
      type: "other",
      status: "open",
      note: "# 结论\n导出成功",
      tags: [],
      logs: [],
    });
  });
});
