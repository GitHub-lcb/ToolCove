import { describe, expect, it } from "vitest";
import {
  IMPORTANT_WEIGHT,
  KEEP_TAIL,
  SUMMARY_BUDGET,
  buildHistoryView,
  historyPromptText,
  stepWeight,
  summarizeStep,
} from "./history.js";

const call = (tool, args = {}, extra = {}) => ({ action: { type: "tool_call", tool, args }, result: "ok", ...extra });
const failed = (tool, error, args = {}) => ({ action: { type: "tool_call", tool, args }, error });
const long = (n) => "x".repeat(n);

describe("summarizeStep", () => {
  it("工具调用摘要带工具名、参数与结果", () => {
    const text = summarizeStep(call("json.parse", { text: "{}" }));
    expect(text).toContain("调用 json.parse");
    expect(text).toContain("参数");
    expect(text).toContain("结果");
  });

  it("失败步骤保留错误原文（这是模型纠错的唯一依据）", () => {
    const text = summarizeStep(failed("file.write_text", "写入前需先读取该文件：a.txt"));
    expect(text).toContain("失败");
    expect(text).toContain("写入前需先读取该文件");
  });

  it("数组结果给条数而不是整段内容，对象给字段名", () => {
    expect(summarizeStep(call("db.query_readonly", {}, { result: [1, 2, 3] }))).toContain("数组 3 项");
    expect(summarizeStep(call("t", {}, { result: { a: 1, b: 2 } }))).toContain("{a, b}");
  });

  it("协议错误 / final / ask_user 各有形态，未知类型返回空（不占预算）", () => {
    expect(summarizeStep({ action: { type: "protocol_error" }, error: "不是合法 JSON" })).toContain("协议错误");
    expect(summarizeStep({ action: { type: "final", answer: "完成" } })).toContain("最终答复");
    expect(summarizeStep({ action: { type: "ask_user", question: "继续？" } })).toContain("询问用户");
    expect(summarizeStep({ action: { type: "mystery" } })).toBe("");
    expect(summarizeStep(null)).toBe("");
  });

  it("超长字段被压成一行并截断（换行不留在摘要里）", () => {
    const text = summarizeStep(call("t", { text: `a\n\nb${long(500)}` }));
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThan(600);
  });
});

describe("stepWeight", () => {
  it("错误与写类步骤权重更高", () => {
    expect(stepWeight(failed("t", "boom"))).toBe(IMPORTANT_WEIGHT);
    expect(stepWeight(call("file.write_text", {}, { risk: "write" }))).toBe(IMPORTANT_WEIGHT);
    expect(stepWeight(call("json.parse"))).toBe(1);
  });
});

describe("buildHistoryView", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => call("t" + i, { i }));

  it("历史不超过 keepTail 时不折叠", () => {
    const view = buildHistoryView(many(KEEP_TAIL));
    expect(view.folded).toBe("");
    expect(view.note).toBe("");
    expect(view.recent).toHaveLength(KEEP_TAIL);
    expect(view.foldedCount).toBe(0);
  });

  it("超过 keepTail 时早期步骤折叠、最近若干步原样保留", () => {
    const view = buildHistoryView(many(20));
    expect(view.foldedCount).toBe(20 - KEEP_TAIL);
    expect(view.recent).toHaveLength(KEEP_TAIL);
    expect(view.recent[0].action.tool).toBe("t12");
    expect(view.folded).toContain("调用 t0");
    expect(view.note).toContain("已折叠");
  });

  it("折叠说明明说「字段被截断」，避免模型把摘要当完整结果", () => {
    const view = buildHistoryView(many(30));
    expect(view.note).toContain("摘要");
    expect(view.note).toContain("原文");
  });

  it("预算有限时先保早期错误，不先保成功行的细节", () => {
    const history = [
      ...many(10),
      failed("file.write_text", "失败原因：目标目录不存在，请先创建目录目录目录目录目录"),
      ...many(10),
    ];
    const view = buildHistoryView(history, { summaryBudget: 400 });
    expect(view.folded).toContain("失败原因");
    expect(view.folded.length).toBeLessThanOrEqual(400 + 2); // 每行截断会各留一个省略号
  });

  it("摘要段整体不超预算", () => {
    const history = Array.from({ length: 60 }, (_, i) => call("tool" + i, { text: long(500) }, { result: long(500) }));
    const view = buildHistoryView(history, { summaryBudget: SUMMARY_BUDGET });
    expect(view.folded.length).toBeLessThanOrEqual(SUMMARY_BUDGET * 1.2);
  });

  it("容忍坏输入", () => {
    expect(buildHistoryView(null)).toEqual({ folded: "", recent: [], note: "", foldedCount: 0 });
    expect(buildHistoryView([null, 7])).toMatchObject({ folded: "", recent: [null, 7] });
    expect(buildHistoryView(many(12), { keepTail: 0 }).recent).toEqual([]);
    expect(buildHistoryView(many(12), { keepTail: -3, summaryBudget: 0 }).foldedCount).toBe(12 - KEEP_TAIL);
  });
});

describe("historyPromptText", () => {
  it("不折叠时就是原文 JSON", () => {
    const text = historyPromptText([call("t", { a: 1 })]);
    expect(JSON.parse(text)).toHaveLength(1);
  });

  it("折叠时先给说明、再给摘要、再给最近原文", () => {
    const text = historyPromptText(Array.from({ length: 12 }, (_, i) => call("t" + i)));
    expect(text.indexOf("已折叠")).toBeLessThan(text.indexOf("调用 t0"));
    expect(text).toContain("最近 8 步原文");
    expect(text).toContain("t11");
  });
});
