import { describe, it, expect } from "vitest";
import {
  FREE_DAILY_RUNS,
  FREE_DAILY_STEPS,
  todayStr,
  emptyQuota,
  emptyUsage,
  normalizeQuota,
  consume,
  remaining,
  canStartRun,
  isExhausted,
  addUsage,
} from "./quota.js";

const NOW = new Date("2026-09-09T10:00:00Z");
const DAY = "2026-09-09";
const FREE = { dailyRuns: FREE_DAILY_RUNS, dailySteps: FREE_DAILY_STEPS };
const PRO = { dailyRuns: Infinity, dailySteps: Infinity };

describe("todayStr / emptyQuota", () => {
  it("按 UTC 取日期，空配额三计数归零", () => {
    expect(todayStr(NOW)).toBe(DAY);
    expect(emptyQuota(DAY)).toEqual({ day: DAY, runs: 0, steps: 0, tokens: 0 });
    expect(emptyUsage()).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 });
  });
});

describe("normalizeQuota（旧数据兼容 + 日切）", () => {
  it("日期不符即归零：昨天的计数不带进今天", () => {
    expect(normalizeQuota({ day: "2000-01-01", runs: 99, steps: 999, tokens: 999 }, NOW)).toEqual(emptyQuota(DAY));
  });

  it("缺失/非对象输入归零", () => {
    expect(normalizeQuota(undefined, NOW)).toEqual(emptyQuota(DAY));
    expect(normalizeQuota(null, NOW)).toEqual(emptyQuota(DAY));
    expect(normalizeQuota("x", NOW)).toEqual(emptyQuota(DAY));
    expect(normalizeQuota([], NOW)).toEqual(emptyQuota(DAY));
  });

  it("非法计数归零、字符串数字接受、超上限熔断", () => {
    const q = normalizeQuota({ day: DAY, runs: -5, steps: "7", tokens: 1e12 }, NOW);
    expect(q).toEqual({ day: DAY, runs: 0, steps: 7, tokens: 1_000_000_000 });
    expect(normalizeQuota({ day: DAY, runs: NaN, steps: Infinity }, NOW).steps).toBe(0);
  });
});

describe("consume", () => {
  it("返回新对象且不修改入参", () => {
    const before = emptyQuota(DAY);
    const after = consume(before, { runs: 1, steps: 3, tokens: 120 }, NOW);
    expect(before).toEqual(emptyQuota(DAY));
    expect(after).not.toBe(before);
    expect(after).toEqual({ day: DAY, runs: 1, steps: 3, tokens: 120 });
  });

  it("累加而非覆盖，缺项按 0", () => {
    const q = consume(consume(emptyQuota(DAY), { runs: 1, steps: 2 }, NOW), { steps: 5 }, NOW);
    expect(q).toEqual({ day: DAY, runs: 1, steps: 7, tokens: 0 });
  });

  it("跨天后从新的一天重新计数", () => {
    const yesterday = { day: "2026-09-08", runs: 8, steps: 60, tokens: 500 };
    expect(consume(yesterday, { runs: 1 }, NOW)).toEqual({ day: DAY, runs: 1, steps: 0, tokens: 0 });
  });
});

describe("remaining / canStartRun / isExhausted", () => {
  it("Pro 的 Infinity 上限返回 null 表示无限制", () => {
    const full = { day: DAY, runs: 999, steps: 999, tokens: 0 };
    expect(remaining(full, PRO, NOW)).toEqual({ runs: null, steps: null });
    expect(canStartRun(full, PRO, NOW)).toEqual({ ok: true });
    expect(isExhausted(full, PRO, NOW)).toBe(false);
  });

  it("免费档：有余量时可开跑，剩余量按上限递减", () => {
    expect(remaining(emptyQuota(DAY), FREE, NOW)).toEqual({ runs: FREE_DAILY_RUNS, steps: FREE_DAILY_STEPS });
    expect(canStartRun(consume(emptyQuota(DAY), { runs: 3, steps: 10 }, NOW), FREE, NOW)).toEqual({ ok: true });
  });

  it("免费档：次数用尽报 runs，步数用尽报 steps", () => {
    expect(canStartRun({ day: DAY, runs: FREE_DAILY_RUNS, steps: 0, tokens: 0 }, FREE, NOW)).toEqual({ ok: false, reason: "runs" });
    expect(canStartRun({ day: DAY, runs: 0, steps: FREE_DAILY_STEPS, tokens: 0 }, FREE, NOW)).toEqual({ ok: false, reason: "steps" });
    expect(isExhausted({ day: DAY, runs: FREE_DAILY_RUNS, steps: 0, tokens: 0 }, FREE, NOW)).toBe(true);
    // 剩余量不会变负数
    expect(remaining({ day: DAY, runs: FREE_DAILY_RUNS + 5, steps: 0, tokens: 0 }, FREE, NOW)).toEqual({ runs: 0, steps: FREE_DAILY_STEPS });
  });

  it("limits 缺失或非法时按无限制处理（不因数据损坏把用户锁死）", () => {
    expect(remaining(emptyQuota(DAY), undefined, NOW)).toEqual({ runs: null, steps: null });
    expect(canStartRun({ day: DAY, runs: 99, steps: 99, tokens: 0 }, {}, NOW)).toEqual({ ok: true });
  });
});

describe("addUsage", () => {
  it("累加 token 并给 calls +1", () => {
    const u = addUsage(emptyUsage(), { promptTokens: 100, completionTokens: 40, totalTokens: 140 });
    expect(u).toEqual({ promptTokens: 100, completionTokens: 40, totalTokens: 140, calls: 1 });
    expect(addUsage(u, { promptTokens: 10, completionTokens: 5, totalTokens: 15 }))
      .toEqual({ promptTokens: 110, completionTokens: 45, totalTokens: 155, calls: 2 });
  });

  it("旧 run 没有 usage 字段也能累加，非法字段按 0", () => {
    expect(addUsage(undefined, { promptTokens: 7, totalTokens: 7 })).toEqual({ promptTokens: 7, completionTokens: 0, totalTokens: 7, calls: 1 });
    // 非法 token 字段归零，但这次调用本身仍计数
    expect(addUsage(emptyUsage(), { promptTokens: -3, totalTokens: "x" })).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 1 });
    expect(addUsage(emptyUsage(), null).calls).toBe(1);
  });
});
