// 每日调度的单测。
//
// 时间全部用显式时间戳构造，不依赖「现在几点」——否则这套测试过了午夜就会红。
// 本机时区假设在断言里体现为 todayKey 的结果，所以无论在哪台机器上跑都一致。
import { describe, expect, it } from "vitest";
import { appendHistory, applyResult, atTimeOfDay, nextRunAt, normalizePolicy, parseAt, planDailyRun, todayKey, withPoints } from "./daily.js";
import { OUTCOME } from "./classify.js";

const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
const T8 = at(2026, 9, 30, 8, 0);
const T10 = at(2026, 9, 30, 10, 0);
const T2359 = at(2026, 9, 30, 23, 59);
const POLICY = { enabled: true, at: "09:10", maxRunsPerDay: 3, retryDelayMs: 1800000 };

describe("日期键", () => {
  it("用本地日期而不是 UTC：UTC+8 的凌晨 8 点前 toISOString 会算成昨天", () => {
    const earlyMorning = at(2026, 9, 30, 0, 30);
    expect(todayKey(earlyMorning)).toBe("2026-09-30");
  });

  it("跨月跨年正确", () => {
    expect(todayKey(at(2026, 1, 1, 12))).toBe("2026-01-01");
    expect(todayKey(at(2026, 12, 31, 12))).toBe("2026-12-31");
  });

  it("指定时区偏移时按该偏移计算", () => {
    // UTC 2026-09-30T23:00Z 在 UTC+8 是 10-01
    const utcLate = Date.UTC(2026, 8, 30, 23, 0);
    expect(todayKey(utcLate, 480)).toBe("2026-10-01");
    expect(todayKey(utcLate, 0)).toBe("2026-09-30");
  });
});

describe("时刻解析", () => {
  it("接受 HH:mm / H:mm", () => {
    expect(parseAt("09:10")).toEqual({ hour: 9, minute: 10 });
    expect(parseAt("9:10")).toEqual({ hour: 9, minute: 10 });
  });

  it("拒绝非法时刻", () => {
    for (const bad of ["24:00", "9:60", "0910", "", "abc", "9:5x"]) expect(parseAt(bad)).toBeNull();
  });

  it("非法时刻归一化后回落到默认值，而不是让调度器瘫掉", () => {
    expect(normalizePolicy({ at: "99:99" }).at).toBe("09:10");
  });

  it("atTimeOfDay 落在当天该时刻", () => {
    expect(atTimeOfDay(T8, "09:10")).toBe(at(2026, 9, 30, 9, 10));
    expect(atTimeOfDay(T10, "09:10")).toBe(at(2026, 9, 30, 9, 10));
  });
});

describe("调度判定", () => {
  it("关掉时永远不跑", () => {
    expect(planDailyRun({}, { ...POLICY, enabled: false }, T10)).toMatchObject({ due: false, reason: "disabled" });
  });

  it("到点前不跑，at 给出触发时刻", () => {
    expect(planDailyRun({}, POLICY, T8)).toMatchObject({ due: false, reason: "too-early" });
    expect(planDailyRun({}, POLICY, T8).at).toBe(at(2026, 9, 30, 9, 10));
  });

  it("到点后跑", () => {
    expect(planDailyRun({}, POLICY, T10)).toMatchObject({ due: true, reason: "due" });
  });

  it("今天已签（ok）就不再跑", () => {
    const state = { lastDay: todayKey(T10), lastOutcome: OUTCOME.OK };
    expect(planDailyRun(state, POLICY, T10)).toMatchObject({ due: false, reason: "done-today" });
  });

  it("今天查出来已签（already）同样不再跑", () => {
    const state = { lastDay: todayKey(T10), lastOutcome: OUTCOME.ALREADY };
    expect(planDailyRun(state, POLICY, T10).reason).toBe("done-today");
  });

  it("今天失败过不算完成——当天还要继续签", () => {
    const state = { lastDay: todayKey(T10), lastOutcome: OUTCOME.NETWORK, attempts: { day: todayKey(T10), count: 1 } };
    expect(planDailyRun(state, POLICY, T10)).toMatchObject({ due: true });
  });

  it("旧记录只写了 lastDay 没写 outcome 也当成已完成", () => {
    expect(planDailyRun({ lastDay: todayKey(T10) }, POLICY, T10).reason).toBe("done-today");
  });

  it("昨天的成功不影响今天", () => {
    const state = { lastDay: "2026-09-29", lastOutcome: OUTCOME.OK };
    expect(planDailyRun(state, POLICY, T10)).toMatchObject({ due: true });
  });

  it("退避窗口没过就不跑，并给出重试时刻", () => {
    const state = { retryAfterAt: T10 + 20 * 60 * 1000 };
    const plan = planDailyRun(state, POLICY, T10);
    expect(plan).toMatchObject({ due: false, reason: "rate-limited" });
    expect(plan.at).toBe(T10 + 20 * 60 * 1000);
  });

  it("当日次数用完就不再跑（防止对着接口死磕）", () => {
    const state = { attempts: { day: todayKey(T10), count: 3 } };
    expect(planDailyRun(state, POLICY, T10)).toMatchObject({ due: false, reason: "attempts-exhausted" });
  });

  it("次数跨天重置", () => {
    const state = { attempts: { day: "2026-09-29", count: 3 } };
    expect(planDailyRun(state, POLICY, T10)).toMatchObject({ due: true });
  });

  it("次数上限被夹在 1..20（传 0 也要夹到 1，不能回落默认值 3）", () => {
    expect(normalizePolicy({ maxRunsPerDay: 0 }).maxRunsPerDay).toBe(1);
    expect(normalizePolicy({ maxRunsPerDay: 999 }).maxRunsPerDay).toBe(20);
  });

  it("归一化可以反复调用而结果不变（幂等）", () => {
    // Number(null) === 0 且 Number.isFinite(0) 为真，
    // 一旦把 null 偏移量当成 0，第二次归一化就会把「本地时区」悄悄变成 UTC，整点偏 8 小时。
    const once = normalizePolicy({ enabled: true, at: "09:10" });
    expect(once.offsetMinutes).toBeNull();
    expect(normalizePolicy(once)).toEqual(once);
  });

  it("未指定时区偏移时保持 null（= 本地时区），不是 0", () => {
    for (const input of [{}, { offsetMinutes: null }, { offsetMinutes: "" }, { offsetMinutes: undefined }, { offsetMinutes: "abc" }]) {
      expect(normalizePolicy(input).offsetMinutes).toBeNull();
    }
    expect(normalizePolicy({ offsetMinutes: 0 }).offsetMinutes).toBe(0);
    expect(normalizePolicy({ offsetMinutes: 480 }).offsetMinutes).toBe(480);
    expect(normalizePolicy({ offsetMinutes: 99999 }).offsetMinutes).toBe(14 * 60);
  });
});

describe("下次唤醒", () => {
  it("该跑时立即返回 now", () => {
    expect(nextRunAt({}, POLICY, T10)).toBe(T10);
  });

  it("今天已完成 → 明天同一时刻（跨月也算得对）", () => {
    const state = { lastDay: todayKey(T2359), lastOutcome: OUTCOME.OK };
    const next = nextRunAt(state, POLICY, T2359);
    const d = new Date(next);
    expect(d.getDate()).toBe(1); // 9/30 → 10/1
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(10);
  });

  it("退避中 → 退避结束那一刻", () => {
    const until = T10 + 5 * 60 * 1000;
    expect(nextRunAt({ retryAfterAt: until }, POLICY, T10)).toBe(until);
  });

  it("定时关闭 → 不排下一次", () => {
    expect(nextRunAt({}, { ...POLICY, enabled: false }, T10)).toBeNull();
  });

  it("不会返回已经过去的时间（否则定时器立刻空转刷屏）", () => {
    // 该跑时返回 now 本身是对的（立刻执行），所以这里只断言「不早于 now」
    expect(nextRunAt({}, POLICY, T10)).toBe(T10);
    // 其余不可跑的情况必须给出一个将来的时刻
    const cases = [
      [{ lastDay: todayKey(T10), lastOutcome: OUTCOME.OK }, POLICY, T10],
      [{ attempts: { day: todayKey(T10), count: 3 } }, POLICY, T10],
      [{ retryAfterAt: T10 + 1000 }, POLICY, T10],
      [{ lastDay: todayKey(T2359), lastOutcome: OUTCOME.OK }, POLICY, T2359],
    ];
    for (const [state, policy, now] of cases) {
      expect(nextRunAt(state, policy, now)).toBeGreaterThan(now);
    }
  });
});

describe("结果并入状态", () => {
  it("成功才推进 lastDay（失败推进会让第二天不再签）", () => {
    expect(applyResult({}, OUTCOME.OK, { now: T10 }).lastDay).toBe(todayKey(T10));
    expect(applyResult({}, OUTCOME.ALREADY, { now: T10 }).lastDay).toBe(todayKey(T10));
    for (const bad of [OUTCOME.NETWORK, OUTCOME.FAILED, OUTCOME.AUTH, OUTCOME.UNKNOWN, OUTCOME.NOT_JSON]) {
      expect(applyResult({}, bad, { now: T10 }).lastDay).toBeUndefined();
    }
  });

  it("每次真实调用都记当日次数", () => {
    let state = {};
    state = applyResult(state, OUTCOME.NETWORK, { now: T10 });
    expect(state.attempts).toEqual({ day: todayKey(T10), count: 1 });
    state = applyResult(state, OUTCOME.NETWORK, { now: T10 });
    expect(state.attempts.count).toBe(2);
  });

  it("限流与网络错误安排退避；鉴权/描述错误不安排（重试无意义，还会白烧次数）", () => {
    expect(applyResult({}, OUTCOME.RATE_LIMITED, { now: T10 }).retryAfterAt).toBeGreaterThan(T10);
    expect(applyResult({}, OUTCOME.SERVER, { now: T10 }).retryAfterAt).toBeGreaterThan(T10);
    expect(applyResult({}, OUTCOME.AUTH, { now: T10 }).retryAfterAt).toBe(0);
    expect(applyResult({}, OUTCOME.BAD_DESCRIPTOR, { now: T10 }).retryAfterAt).toBe(0);
  });

  it("退避时刻单调不后退", () => {
    const first = applyResult({}, OUTCOME.RATE_LIMITED, { now: T10 });
    const later = applyResult(first, OUTCOME.RATE_LIMITED, { now: T10 + 60 * 1000 });
    expect(later.retryAfterAt).toBeGreaterThanOrEqual(first.retryAfterAt);
  });

  it("失败原因留档供界面显示", () => {
    expect(applyResult({}, OUTCOME.FAILED, { now: T10, detail: "code-mismatch" }).lastError).toBe("code-mismatch");
  });

  it("不改原对象", () => {
    const before = { lastOutcome: OUTCOME.OK };
    applyResult(before, OUTCOME.NETWORK, { now: T10 });
    expect(before.lastOutcome).toBe(OUTCOME.OK);
  });
});

describe("积分与历史", () => {
  it("读不到积分时保留旧值，不抹成 undefined", () => {
    const state = { points: 100 };
    expect(withPoints(state, undefined)).toBe(state);
    expect(withPoints(state, 0).points).toBe(0);
    expect(withPoints(state, 120).points).toBe(120);
  });

  it("历史最新在前并按上限截断", () => {
    let state = {};
    for (let i = 1; i <= 5; i += 1) state = appendHistory(state, { at: i, outcome: OUTCOME.OK });
    expect(state.history).toHaveLength(5);
    expect(state.history[0].at).toBe(5);
    const trimmed = appendHistory(state, { at: 6, outcome: OUTCOME.OK }, 3);
    expect(trimmed.history.map((h) => h.at)).toEqual([6, 5, 4]);
  });
});
