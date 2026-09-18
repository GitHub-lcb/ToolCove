import { describe, expect, it } from "vitest";
import { COLLAPSE_AT, DISPLAY_CLIP, clipText, foldTimeline, hasRunning, payloadText } from "./timeline.js";

const start = (id, tool, attempt = 1, args = {}) => ({ type: "tool_start", id, tool, args, attempt, ts: attempt });
const retry = (id, tool, attempt, error) => ({ type: "tool_retry", id, tool, error, attempt, ts: attempt });
const ok = (id, tool, result, attempt = 1) => ({ type: "tool_result", id, tool, result, attempt, ts: attempt });
const bad = (id, tool, error, code = "") => ({ type: "tool_error", id, tool, error, code, ts: 9 });

describe("foldTimeline 工具卡折叠", () => {
  it("start → result 收成一张卡一次尝试", () => {
    const items = foldTimeline([start("a", "json.format"), ok("a", "json.format", { output: "{}" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", id: "a", tool: "json.format" });
    expect(items[0].attempts).toEqual([{ n: 1, args: {}, status: "ok", result: { output: "{}" }, error: "", code: "", ts: 1 }]);
  });

  it("重试不新开卡：tool_retry 标记当前尝试，下一次 start 追加新尝试", () => {
    const items = foldTimeline([
      start("a", "text.diff", 1, { left: "x" }),
      retry("a", "text.diff", 1, "boom"),
      start("a", "text.diff", 2, { left: "x" }),
      ok("a", "text.diff", "same", 2),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].attempts).toHaveLength(2);
    expect(items[0].attempts[0]).toMatchObject({ n: 1, status: "retry", error: "boom" });
    expect(items[0].attempts[1]).toMatchObject({ n: 2, status: "ok", result: "same" });
  });

  it("tool_error 收尾为 error 并保留错误码", () => {
    const items = foldTimeline([start("a", "file.write_text"), bad("a", "file.write_text", "需要 Pro 授权", "FORBIDDEN")]);
    expect(items[0].attempts[0]).toMatchObject({ status: "error", error: "需要 Pro 授权", code: "FORBIDDEN" });
  });

  it("没有 start 的 result / error 也建卡，不丢事件", () => {
    const items = foldTimeline([ok("z", "json.parse", 1), bad("y", "db.query_readonly", "拒绝写入 SQL")]);
    expect(items.map((i) => i.id)).toEqual(["z", "y"]);
    expect(items[0].attempts[0].status).toBe("ok");
    expect(items[1].attempts[0].status).toBe("error");
  });

  it("孤立的 tool_retry 不建卡：视图要取最后一次尝试渲染徽标，空数组会崩", () => {
    expect(foldTimeline([retry("ghost", "text.diff", 1, "boom")])).toEqual([]);
    const items = foldTimeline([retry("ghost", "text.diff", 1, "boom"), start("a", "text.diff")]);
    expect(items).toHaveLength(1);
    expect(items.every((i) => i.kind !== "tool" || i.attempts.length > 0)).toBe(true);
  });

  it("不同 id 各自成卡并保持出现顺序", () => {
    const items = foldTimeline([start("a", "t1"), start("b", "t2"), ok("a", "t1", 1), ok("b", "t2", 2)]);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(items.every((i) => i.attempts[0].status === "ok")).toBe(true);
  });

  it("result 事件补齐 start 缺失的 args", () => {
    const items = foldTimeline([{ type: "tool_result", id: "a", tool: "t", args: { text: "hi" }, result: "ok", ts: 3 }]);
    expect(items[0].attempts[0].args).toEqual({ text: "hi" });
  });
});

describe("foldTimeline 非工具事件", () => {
  it("final / confirmation / notice 各占一行且保序", () => {
    const items = foldTimeline([
      { type: "confirmation", tool: "file.write_text", question: "", answer: true, ts: 1 },
      { type: "notice", code: "max_steps", text: "", ts: 2 },
      { type: "final", answer: "完成", ts: 3 },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["confirm", "notice", "final"]);
    expect(items[0]).toMatchObject({ tool: "file.write_text", answer: true });
    expect(items[1]).toMatchObject({ code: "max_steps" });
    expect(items[2]).toMatchObject({ answer: "完成" });
  });

  it("planning / waiting checkpoint 与未知类型不占时间线", () => {
    const items = foldTimeline([
      { type: "checkpoint", phase: "planning", ts: 1 },
      { type: "waiting", question: "?", ts: 2 },
      { type: "mystery", ts: 3 },
      start("a", "t"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("tool");
  });

  it("容忍非数组与空条目", () => {
    expect(foldTimeline()).toEqual([]);
    expect(foldTimeline(null)).toEqual([]);
    expect(foldTimeline([null, 7, "x", undefined])).toEqual([]);
  });

  it("结果分层保留的两类事件各占一行，参数带上便于文案说明省略了多少", () => {
    const items = foldTimeline([
      start("a", "db.query_readonly"),
      { type: "tool_clip", tool: "db.query_readonly", originalChars: 90000, retainedChars: 8000, omittedChars: 82000, ts: 5 },
      { type: "tool_spill", tool: "db.query_readonly", key: "spill:db-query-readonly-ab12", chars: 90000, ts: 6 },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["tool", "notice", "notice"]);
    expect(items[0].tool).toBe("db.query_readonly");
    expect(items[1]).toMatchObject({ kind: "notice", code: "tool_clip", tool: "db.query_readonly", omittedChars: 82000 });
    expect(items[2]).toMatchObject({ kind: "notice", code: "tool_spill", text: "spill:db-query-readonly-ab12", chars: 90000 });
  });

  it("写前预览随 approval_asked 一起进条目（确认卡要渲染 diff）", () => {
    const items = foldTimeline([
      { type: "approval_asked", id: "c1", tool: "file.write_text", reason: "risky-write", args: { path: "a.txt" }, preview: { path: "a.txt", diff: { hasChanges: true } }, ts: 1 },
    ]);
    expect(items[0].preview.diff).toEqual({ hasChanges: true });
  });

  it("缺失参数的分层事件不让视图拿到 undefined", () => {
    const items = foldTimeline([{ type: "tool_clip", tool: "t", ts: 1 }, { type: "tool_spill", ts: 2 }]);
    expect(items[0]).toMatchObject({ omittedChars: 0, originalChars: 0, retainedChars: 0 });
    expect(items[1]).toMatchObject({ text: "", chars: 0, tool: "" });
  });
});

describe("hasRunning", () => {
  it("仍有未收尾尝试时为 true", () => {
    expect(hasRunning(foldTimeline([start("a", "t")]))).toBe(true);
    expect(hasRunning(foldTimeline([start("a", "t"), ok("a", "t", 1)]))).toBe(false);
    expect(hasRunning([])).toBe(false);
  });
});

describe("文本裁剪", () => {
  it("超长文本截断并加省略号", () => {
    const long = "x".repeat(DISPLAY_CLIP + 10);
    const clipped = clipText(long);
    expect(clipped.length).toBe(DISPLAY_CLIP + 1);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipText("short")).toBe("short");
    expect(clipText(null)).toBe("");
  });

  it("payloadText 对对象美化、对字符串原样、对 null 返回空", () => {
    expect(payloadText(null)).toBe("");
    expect(payloadText("plain")).toBe("plain");
    expect(payloadText({ a: 1 })).toBe('{\n  "a": 1\n}');
    // 循环引用不至于抛错
    const cyclic = {};
    cyclic.self = cyclic;
    expect(typeof payloadText(cyclic)).toBe("string");
  });

  it("折叠阈值小于截断阈值", () => {
    expect(COLLAPSE_AT).toBeLessThan(DISPLAY_CLIP);
  });
});
