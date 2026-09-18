import { describe, expect, it } from "vitest";
import {
  EVENT_PAYLOAD_LIMIT,
  MIN_BUDGET,
  assertWithinBudget,
  budgetEvent,
  clipNote,
  clipToBudget,
  finalizeResult,
  fitPayload,
  planResult,
  safeJsonSize,
  spillNote,
  toBudgetText,
} from "./resultBudget.js";

describe("safeJsonSize", () => {
  it("measures JSON payloads", () => {
    expect(safeJsonSize("abcdef")).toBe(8); // 含引号
    expect(safeJsonSize({ a: 1 })).toBe(7);
    expect(safeJsonSize(null)).toBe(4);
  });

  it("never throws on values JSON.stringify cannot handle", () => {
    // undefined：stringify(undefined ?? null) → "null"
    expect(safeJsonSize(undefined)).toBe(4);
    expect(safeJsonSize(() => {})).toBe(8); // String(() => {}) === "() => {}"
    // BigInt / 循环引用：stringify 直接抛错——量长度不该让一次成功的工具调用变成失败
    expect(() => safeJsonSize(10n)).not.toThrow();
    expect(safeJsonSize(10n)).toBe(2); // String(10n) === "10"
    const cyclic = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => safeJsonSize(cyclic)).not.toThrow();
  });
});

describe("clipToBudget", () => {
  it("keeps both ends and stays within the budget", () => {
    const source = `HEAD${"x".repeat(5000)}TAIL`;
    const clipped = clipToBudget(source, 400);
    expect(clipped.text.length).toBeLessThanOrEqual(400);
    expect(clipped.text.startsWith("HEAD")).toBe(true);
    expect(clipped.text.endsWith("TAIL")).toBe(true);
    expect(clipped.text).toContain("已省略");
    expect(clipped.originalChars).toBe(source.length);
    expect(clipped.omittedChars).toBe(source.length - clipped.retainedChars);
  });

  it("reserves room for the marker itself (DSH's byte-budget lesson)", () => {
    // 预算刚好等于「标记 + 全部内容」时，标记里的数字位数变化会让朴素实现超预算。
    for (const budget of [MIN_BUDGET, 201, 260, 400, 999, 1000, 4096]) {
      const source = "a".repeat(budget * 3);
      const clipped = clipToBudget(source, budget);
      expect(clipped.text.length, `budget=${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it("clamps a nonsense budget instead of returning an empty string", () => {
    const clipped = clipToBudget("y".repeat(4000), 1);
    expect(clipped.text.length).toBeLessThanOrEqual(MIN_BUDGET);
    expect(clipped.text.length).toBeGreaterThan(0);
  });

  it("marks small over-budget text without truncating its middle away", () => {
    const clipped = clipToBudget("hello world", 10);
    expect(clipped.text).toContain("hello world");
    expect(clipped.omittedChars).toBe(0);
  });

  it("treats a non-string payload as text", () => {
    const clipped = clipToBudget({ a: "b".repeat(2000) }, 300);
    expect(typeof clipped.text).toBe("string");
    expect(clipped.text.length).toBeLessThanOrEqual(300);
  });
});

describe("planResult", () => {
  it("keeps results inside the budget", () => {
    const plan = planResult("small", 1000);
    expect(plan.kind).toBe("keep");
    expect(plan.value).toBe("small");
  });

  it("clips results up to 4x the budget", () => {
    const plan = planResult("z".repeat(3000), 1000);
    expect(plan.kind).toBe("clip");
    expect(plan.size).toBe(3002);
  });

  it("spills results beyond 4x the budget, with text prepared", () => {
    const plan = planResult({ rows: "r".repeat(9000) }, 1000);
    expect(plan.kind).toBe("spill");
    expect(typeof plan.text).toBe("string");
    expect(plan.text).toContain("rows");
  });

  it("switches tier exactly at the boundary", () => {
    const budget = 1000;
    // JSON 字符串长度 = 内容长度 + 2（引号）
    expect(planResult("a".repeat(budget - 2), budget).kind).toBe("keep");
    expect(planResult("a".repeat(budget - 1), budget).kind).toBe("clip");
    expect(planResult("a".repeat(budget * 4 - 2), budget).kind).toBe("clip");
    expect(planResult("a".repeat(budget * 4 - 1), budget).kind).toBe("spill");
  });
});

describe("finalizeResult", () => {
  it("passes small results through untouched", () => {
    const value = { rows: [1, 2, 3] };
    expect(finalizeResult(planResult(value, 1000))).toEqual({ value, clipped: false });
  });

  it("returns a clipped string that satisfies the budget invariant", () => {
    const plan = planResult({ rows: "r".repeat(9000) }, 1000);
    const done = finalizeResult(plan);
    expect(done.clipped).toBe(true);
    expect(typeof done.value).toBe("string");
    expect(done.withinBudget).toBe(true);
    expect(assertWithinBudget(done.value, 1000)).toBe(true);
  });

  it("clips an object payload as JSON text rather than gutting the object", () => {
    const plan = planResult({ head: "H".repeat(800), tail: "T".repeat(800) }, 600);
    const done = finalizeResult(plan);
    expect(plan.kind).toBe("clip");
    expect(done.value).toContain('"head"');
    expect(done.value).toContain("已省略");
  });

  it("survives non-serializable payloads", () => {
    const cyclic = { name: "loop" };
    cyclic.self = cyclic;
    const done = finalizeResult(planResult(cyclic, 300));
    expect(typeof done.value).toBe("string");
    expect(done.withinBudget).toBe(true);
  });
});

describe("toBudgetText", () => {
  it("keeps strings as-is and pretty-prints objects", () => {
    expect(toBudgetText("plain")).toBe("plain");
    expect(toBudgetText({ a: 1 })).toContain('"a": 1');
  });
});

describe("budgetEvent", () => {
  it("returns the event untouched when every payload fits", () => {
    const event = { type: "tool_result", result: { ok: true } };
    expect(budgetEvent(event)).toBe(event);
  });

  it("trims oversized fields and flags the event", () => {
    const event = { type: "tool_result", tool: "db.query_readonly", result: { rows: "r".repeat(20000) } };
    const out = budgetEvent(event, 1000);
    expect(out).not.toBe(event);
    expect(out.payloadClipped).toBe(true);
    // 口径：字符串载荷多算两个引号（见 resultBudget 的 OVERHEAD 说明）
    expect(safeJsonSize(out.result)).toBeLessThanOrEqual(1002);
    expect(out.tool).toBe("db.query_readonly");
    // 原事件不被就地改写：调用方可能还要用它
    expect(safeJsonSize(event.result)).toBeGreaterThan(1000);
  });

  it("covers answers, previews, args, errors and questions", () => {
    for (const field of ["answer", "preview", "args", "error", "question"]) {
      const out = budgetEvent({ type: "final", [field]: "x".repeat(9000) }, 500);
      expect(out.payloadClipped, field).toBe(true);
      expect(safeJsonSize(out[field]), field).toBeLessThanOrEqual(502);
    }
  });

  it("ignores null fields and non-objects", () => {
    const event = { type: "tool_result", result: null };
    expect(budgetEvent(event)).toBe(event);
    expect(budgetEvent(null)).toBe(null);
    expect(budgetEvent("text")).toBe("text");
  });

  it("uses a smaller budget than the history", () => {
    expect(EVENT_PAYLOAD_LIMIT).toBeLessThan(32000);
  });
});

describe("fitPayload", () => {
  it("reports whether it changed anything", () => {
    expect(fitPayload("ok", 100)).toEqual({ value: "ok", clipped: false });
    const big = fitPayload("y".repeat(500), 200);
    expect(big.clipped).toBe(true);
    expect(big.originalChars).toBe(500); // 字符串载荷按字符数计（JSON 引号只影响测量，不影响裁剪）
    expect(big.value.length).toBeLessThanOrEqual(200);
  });
});

describe("notes", () => {
  it("tells the model exactly what was omitted", () => {
    expect(clipNote({ omittedChars: 120, originalChars: 4000 })).toContain("省略 120 字符");
    expect(clipNote({})).toContain("省略 0 字符");
  });

  it("tells the model how to read a spilled result back", () => {
    const note = spillNote({ key: "spill-abc", chars: 90000 });
    expect(note).toContain("spill-abc");
    expect(note).toContain("spill.read");
    expect(note).toContain("90000");
  });
});
