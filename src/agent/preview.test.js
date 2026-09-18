import { describe, expect, it } from "vitest";
import { buildTextDiff } from "../textDiff.js";
import { PREVIEW_CONTEXT, PREVIEW_MAX_ROWS, describePreview, rowKind, rowText, summarizePreviewRows } from "./preview.js";

const diffOf = (left, right) => buildTextDiff(left, right);

describe("summarizePreviewRows", () => {
  it("小 diff 整体显示", () => {
    const summary = summarizePreviewRows(diffOf("a\nb", "a\nc"));
    expect(summary.mode).toBe("full");
    expect(summary.rows.length).toBe(summary.total);
    expect(summary.hidden).toBe(0);
  });

  it("大 diff 只显示改动附近的上下文，并说明还有多少行没显示", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[200] = "CHANGED IN THE MIDDLE";
    const summary = summarizePreviewRows(diffOf(lines.join("\n"), changed.join("\n")));
    expect(summary.mode).toBe("changes");
    expect(summary.rows.length).toBeLessThan(summary.total);
    expect(summary.hidden).toBeGreaterThan(0);
    // 关键：改动在文件中部也必须看得见（只截前 N 行的实现会漏掉它）
    expect(summary.rows.map(rowText).join("\n")).toContain("CHANGED IN THE MIDDLE");
  });

  it("上下文行数可调，且改动多于上限时按上限截断", () => {
    const left = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
    const right = Array.from({ length: 100 }, (_, i) => (i % 2 ? `l${i}` : `x${i}`)).join("\n");
    const wide = summarizePreviewRows(diffOf(left, right), { maxRows: 10, context: 0 });
    expect(wide.rows.length).toBeLessThanOrEqual(10);
    const narrow = summarizePreviewRows(diffOf("a\nb\nc", "a\nX\nc"), { context: 0 });
    expect(narrow.mode).toBe("full");
    expect(PREVIEW_CONTEXT).toBe(1);
    expect(PREVIEW_MAX_ROWS).toBeGreaterThan(10);
  });

  it("空 diff 与坏输入都不抛错", () => {
    expect(summarizePreviewRows(null)).toEqual({ rows: [], shown: 0, total: 0, hidden: 0, mode: "empty" });
    expect(summarizePreviewRows({ rows: [] }).mode).toBe("empty");
    expect(summarizePreviewRows({ rows: "nope" }).mode).toBe("empty");
  });
});

describe("describePreview", () => {
  it("汇总路径、增删行数与节选信息", () => {
    const preview = { path: "a.txt", before: "old", after: "new", diff: diffOf("old", "new") };
    const described = describePreview(preview);
    expect(described.path).toBe("a.txt");
    expect(described.isNew).toBe(false);
    expect(described.hasChanges).toBe(true);
    expect(described.rows.length).toBeGreaterThan(0);
    // 单行替换算 modified（textDiff 的三分类：modified / added / removed）
    expect(described.modified).toBe(1);
    expect(described.rows[0].type).toBe("modified");
  });

  it("纯新增与纯删除分别计入 added / removed", () => {
    const added = describePreview({ path: "a.txt", diff: diffOf("one", "one\ntwo") });
    expect(added.added).toBe(1);
    expect(added.removed).toBe(0);
    const removed = describePreview({ path: "a.txt", diff: diffOf("one\ntwo", "one") });
    expect(removed.removed).toBe(1);
    expect(removed.added).toBe(0);
  });

  it("新建文件（读不到旧内容）照样给得出预览", () => {
    const described = describePreview({ path: "new.txt", before: "", after: "hi", isNew: true, readError: "无法读取文件", diff: diffOf("", "hi") });
    expect(described.isNew).toBe(true);
    expect(described.readError).toContain("无法读取");
    expect(described.rows.length).toBeGreaterThan(0);
  });

  it("内容没变时 hasChanges 为假（UI 可以明说「没有变化」）", () => {
    const described = describePreview({ path: "a.txt", before: "same", after: "same", diff: diffOf("same", "same") });
    expect(described.hasChanges).toBe(false);
  });

  it("认不出 diff 形状时不假装「没有变化」，而是标出来让人反馈", () => {
    // 例如引擎换了输出结构：hasChanges 为真却一行都取不出来
    const described = describePreview({ path: "a.txt", diff: { hasChanges: true, changes: [1, 2, 3] } });
    expect(described.schemaUnsupported).toBe(true);
    expect(described.rows).toEqual([]);
    // 「本来就没有变化」不该被标成 schema 问题
    expect(describePreview({ path: "a.txt", diff: { hasChanges: false } }).schemaUnsupported).toBe(false);
  });

  it("兼容 { lines } 形状的 diff（不只认 { rows }）", () => {
    const described = describePreview({
      path: "a.txt",
      diff: { hasChanges: true, lines: [{ type: "added", right: { number: 1, text: "hello" } }] },
    });
    expect(described.schemaUnsupported).toBe(false);
    expect(described.rows).toHaveLength(1);
    expect(rowText(described.rows[0])).toBe("hello");
  });

  it("没有预览时返回 null，UI 退回只显示参数", () => {
    expect(describePreview(null)).toBe(null);
    expect(describePreview("nope")).toBe(null);
  });

  it("带出文件总行数，便于文案说明这是节选", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n");
    const described = describePreview({ path: "big.txt", diff: diffOf(lines, `${lines}\nextra`) });
    expect(described.fileLines).toBeGreaterThan(300);
  });
});

describe("rowText / rowKind", () => {
  it("优先显示新值，其次旧值", () => {
    expect(rowText({ left: { text: "old" }, right: { text: "new" } })).toBe("new");
    expect(rowText({ left: { text: "old" }, right: null })).toBe("old");
    expect(rowText(null)).toBe("");
  });

  it("类型归一成三种底色", () => {
    expect(rowKind({ type: "added" })).toBe("added");
    expect(rowKind({ type: "removed" })).toBe("removed");
    expect(rowKind({ type: "modified" })).toBe("changed");
    expect(rowKind({ type: "equal" })).toBe("equal");
    expect(rowKind({})).toBe("equal");
  });
});
