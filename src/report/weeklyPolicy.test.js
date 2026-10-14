// 周报定时策略的单测：归一化回退 + 下一次触发点 + 补跑判定。
// 时间都用 new Date(y, m, d, ...) 构造（本地时区），与实现口径一致，跨时区也稳定。
import { describe, it, expect } from "vitest";
import { DEFAULT_WEEKLY_POLICY, normalizeWeeklyPolicy, nextWeeklyAt, isDueSince } from "./weeklyPolicy.js";

// 2026-10-16 是周五
const FRI = (h, m = 0, d = 16) => new Date(2026, 9, d, h, m, 0, 0).getTime();
const POLICY = { enabled: true, weekday: 5, hour: 17, minute: 0 };

describe("normalizeWeeklyPolicy", () => {
  it("缺省回退默认（周五 17:00，默认不启用）", () => {
    expect(normalizeWeeklyPolicy()).toEqual(DEFAULT_WEEKLY_POLICY);
    expect(normalizeWeeklyPolicy(null)).toEqual(DEFAULT_WEEKLY_POLICY);
  });

  it("enabled 布尔化", () => {
    expect(normalizeWeeklyPolicy({ enabled: 1 }).enabled).toBe(true);
    expect(normalizeWeeklyPolicy({}).enabled).toBe(false);
  });

  it("weekday / hour / minute 钳制到合法区间并取整", () => {
    expect(normalizeWeeklyPolicy({ weekday: 9 }).weekday).toBe(6);
    expect(normalizeWeeklyPolicy({ weekday: -3 }).weekday).toBe(0);
    expect(normalizeWeeklyPolicy({ weekday: 3.9 }).weekday).toBe(3);
    expect(normalizeWeeklyPolicy({ hour: 30 }).hour).toBe(23);
    expect(normalizeWeeklyPolicy({ hour: -1 }).hour).toBe(0);
    expect(normalizeWeeklyPolicy({ minute: 90 }).minute).toBe(59);
  });

  it("非法值回退默认而不是 0（Number(\"\") 是 0 会静默改写意图）", () => {
    expect(normalizeWeeklyPolicy({ weekday: "abc" }).weekday).toBe(5);
    expect(normalizeWeeklyPolicy({ hour: "" }).hour).toBe(17);
    expect(normalizeWeeklyPolicy({ minute: null }).minute).toBe(0);
  });
});

describe("nextWeeklyAt", () => {
  it("周中：指向本周周五", () => {
    const wed = new Date(2026, 9, 14, 10, 0, 0).getTime();
    expect(nextWeeklyAt(POLICY, wed)).toBe(FRI(17));
  });

  it("周五触发点之前（差一秒）仍指向本周五", () => {
    expect(nextWeeklyAt(POLICY, FRI(16, 59))).toBe(FRI(17));
  });

  it("严格晚于 nowMs：正好在触发点则顺延到下周", () => {
    expect(nextWeeklyAt(POLICY, FRI(17))).toBe(FRI(17, 0, 23));
  });

  it("周五触发点之后：顺延到下周", () => {
    expect(nextWeeklyAt(POLICY, FRI(18))).toBe(FRI(17, 0, 23));
  });

  it("周日：指向下周五", () => {
    const sun = new Date(2026, 9, 18, 10, 0, 0).getTime();
    expect(nextWeeklyAt(POLICY, sun)).toBe(FRI(17, 0, 23));
  });
});

describe("isDueSince", () => {
  it("未启用一律 false", () => {
    expect(isDueSince({ ...POLICY, enabled: false }, null, FRI(18))).toBe(false);
  });

  it("从没跑过 → 需要补跑一次", () => {
    expect(isDueSince(POLICY, null, FRI(10))).toBe(true);
    expect(isDueSince(POLICY, undefined, FRI(10))).toBe(true);
  });

  it("上周跑过、还没到本周触发点 → 不补跑", () => {
    const lastFri = FRI(17, 0, 9); // 上周五
    const wed = new Date(2026, 9, 14, 10, 0, 0).getTime();
    expect(isDueSince(POLICY, lastFri, wed)).toBe(false);
  });

  it("错过本周触发点（已周五之后）→ 补跑", () => {
    const lastFri = FRI(17, 0, 9);
    expect(isDueSince(POLICY, lastFri, FRI(17))).toBe(true); // 正好在触发点
    expect(isDueSince(POLICY, lastFri, FRI(18))).toBe(true);
    const sat = new Date(2026, 9, 17, 9, 0, 0).getTime();
    expect(isDueSince(POLICY, lastFri, sat)).toBe(true);
  });

  it("本周已跑过 → 不补跑（哪怕同一周同一天晚些时候）", () => {
    const ran = FRI(17);
    expect(isDueSince(POLICY, ran, FRI(18))).toBe(false);
    const sat = new Date(2026, 9, 17, 9, 0, 0).getTime();
    expect(isDueSince(POLICY, ran, sat)).toBe(false);
  });
});
