// 编排层的单测。
//
// 两条核心不变量在这里钉死：
// 1. 描述文件填错时**一次请求都不能发出去**；
// 2. 同一天不会因为「自动 + 手动撞车」而签两次。
import { describe, expect, it } from "vitest";
import { OUTCOME } from "./classify.js";
import { createCheckInRunner, TRIGGER } from "./runner.js";

const T10 = new Date(2026, 8, 30, 10, 0, 0, 0).getTime();

function harness({ responses, now = T10 } = {}) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [];
  const runner = createCheckInRunner({
    now: () => now,
    request: async (req) => {
      calls.push(req);
      const next = queue.length ? queue.shift() : { ok: true, status: 200, text: "{}", error: "", retryAfterMs: 0 };
      return next;
    },
  });
  return { runner, calls };
}

const ok = (body = { data: { checkedToday: true } }) => ({ ok: true, status: 200, text: JSON.stringify(body), error: "", retryAfterMs: 0 });
const notSignedYet = (body = { data: { checkedToday: false } }) => ({ ok: true, status: 200, text: JSON.stringify(body), error: "", retryAfterMs: 0 });
const httpErr = (status) => ({ ok: false, status, text: "", error: "", retryAfterMs: 0 });

const SITE = {
  key: "wb",
  label: "WorkBuddy",
  baseUrl: "https://api.example.com",
  checkin: { method: "POST", path: "/v1/do", headers: [["Cookie", "sid=1"]] },
  read: { checkedIn: "data.checkedToday", points: "data.points", message: "message", code: "", successCodes: null },
};

const SITE_WITH_STATUS = {
  ...SITE,
  status: { method: "GET", path: "/v1/status", headers: [] },
};

describe("描述文件无效时", () => {
  it("不发任何请求，直接 bad-descriptor", async () => {
    const { runner, calls } = harness();
    const result = await runner.runSite({ ...SITE, baseUrl: "http://insecure.example.com" }, {}, { trigger: TRIGGER.MANUAL });
    expect(result.outcome).toBe(OUTCOME.BAD_DESCRIPTOR);
    expect(calls).toHaveLength(0);
  });

  it("错误明细带字段名，能直接定位", async () => {
    const { runner } = harness();
    const result = await runner.runSite({ ...SITE, read: {} }, {}, { trigger: TRIGGER.MANUAL });
    expect(result.outcome).toBe(OUTCOME.BAD_DESCRIPTOR);
    expect(result.error).toContain("read.checkedIn");
  });

  it("runAll 里无效站点不阻断其它站点", async () => {
    const { runner, calls } = harness({ responses: [ok()] });
    const { results } = await runner.runAll([{ ...SITE, key: "bad", baseUrl: "" }, SITE], {}, { trigger: TRIGGER.MANUAL });
    expect(results.map((r) => r.outcome)).toEqual([OUTCOME.BAD_DESCRIPTOR, OUTCOME.OK]);
    expect(calls).toHaveLength(1);
  });
});

describe("单次签到", () => {
  it("成功：拼 URL、带 header、拿到积分", async () => {
    const { runner, calls } = harness({ responses: [ok({ data: { checkedToday: true, points: 100 } })] });
    const result = await runner.runSite(SITE, {}, { trigger: TRIGGER.MANUAL });
    expect(result.outcome).toBe(OUTCOME.OK);
    expect(result.points).toBe(100);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.example.com/v1/do", headers: [["Cookie", "sid=1"]] });
  });

  it("GET 动作与 POST 动作分开，不会把签到请求打到状态端点上", async () => {
    const { runner, calls } = harness({ responses: [notSignedYet(), ok()] });
    await runner.runSite(SITE_WITH_STATUS, {}, { trigger: TRIGGER.MANUAL });
    expect(calls.map((c) => c.url)).toEqual(["https://api.example.com/v1/status", "https://api.example.com/v1/do"]);
  });

  it("查状态发现已签 → 不发签到请求（省一次调用，也不至于被判定为重复）", async () => {
    const { runner, calls } = harness({ responses: [ok({ data: { checkedToday: true } })] });
    const result = await runner.runSite(SITE_WITH_STATUS, {}, { trigger: TRIGGER.MANUAL });
    expect(result.outcome).toBe(OUTCOME.ALREADY);
    expect(calls).toHaveLength(1);
  });

  it("查状态失败（鉴权）也照样尝试签到——不少签到端点不依赖状态端点", async () => {
    const { runner, calls } = harness({ responses: [httpErr(401), ok()] });
    const result = await runner.runSite(SITE_WITH_STATUS, {}, { trigger: TRIGGER.MANUAL });
    expect(result.outcome).toBe(OUTCOME.OK);
    expect(calls).toHaveLength(2);
  });

  it("已签过的记录在自动触发下直接跳过，不发请求", async () => {
    const { runner, calls } = harness();
    const state = { lastDay: "2026-09-30", lastOutcome: OUTCOME.OK };
    const result = await runner.runSite(SITE, state, { trigger: TRIGGER.AUTO, policy: { enabled: true, at: "09:10" } });
    expect(result.outcome).toBe(OUTCOME.SKIPPED);
    expect(result.error).toBe("done-today");
    expect(calls).toHaveLength(0);
  });

  it("手动触发无视当日记录（用户想重试是他的权利）", async () => {
    const { runner, calls } = harness({ responses: [ok()] });
    const state = { lastDay: "2026-09-30", lastOutcome: OUTCOME.OK };
    const result = await runner.runSite(SITE, state, { trigger: TRIGGER.MANUAL });
    expect(result.outcome).toBe(OUTCOME.OK);
    expect(calls).toHaveLength(1);
  });

  it("停用的站点：自动任务跳过，手动仍可跑", async () => {
    const { runner, calls } = harness({ responses: [ok()] });
    const off = { ...SITE, enabled: false };
    const auto = await runner.runSite(off, {}, { trigger: TRIGGER.AUTO, policy: { enabled: true, at: "09:10" } });
    expect(auto.outcome).toBe(OUTCOME.SKIPPED);
    expect(calls).toHaveLength(0);
    const manual = await runner.runSite(off, {}, { trigger: TRIGGER.MANUAL });
    expect(manual.outcome).toBe(OUTCOME.OK);
    expect(calls).toHaveLength(1);
  });
});

describe("同站点并发去重", () => {
  it("自动与手动同时触发只发一次请求", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    const runner = createCheckInRunner({
      now: () => T10,
      request: async (req) => {
        calls.push(req);
        await gate;
        return ok({ data: { checkedToday: true } });
      },
    });
    const first = runner.runSite(SITE, {}, { trigger: TRIGGER.MANUAL });
    const second = runner.runSite(SITE, {}, { trigger: TRIGGER.AUTO, policy: { enabled: true, at: "09:10" } });
    release();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    // 第二次拿到的是同一个在途结果，不会重复提交
    expect((await second).outcome).toBe(OUTCOME.OK);
  });
});

describe("runAll", () => {
  it("顺序执行，不并发", async () => {
    const order = [];
    const runner = createCheckInRunner({
      now: () => T10,
      request: async (req) => {
        order.push(req.url);
        return ok({ data: { checkedToday: true } });
      },
    });
    await runner.runAll([{ ...SITE, key: "a" }, { ...SITE, key: "b" }], {}, { trigger: TRIGGER.MANUAL });
    expect(order).toEqual(["https://api.example.com/v1/do", "https://api.example.com/v1/do"]);
  });

  it("跳过未启用的自动任务但不改动其状态", async () => {
    const { runner } = harness();
    const { results, states } = await runner.runAll([SITE], { wb: { lastDay: "2026-09-30", lastOutcome: OUTCOME.OK } }, { trigger: TRIGGER.AUTO, policy: { enabled: true, at: "09:10" } });
    expect(results[0].skipped).toBe(true);
    expect(states.wb).toEqual({ lastDay: "2026-09-30", lastOutcome: OUTCOME.OK });
  });

  it("查状态发现已签时推进 lastDay（否则明天还会再查一次）", async () => {
    const { runner } = harness({ responses: [ok({ data: { checkedToday: true } })] });
    const { states } = await runner.runAll([SITE_WITH_STATUS], {}, { trigger: TRIGGER.MANUAL });
    expect(states.wb.lastDay).toBe("2026-09-30");
    expect(states.wb.lastOutcome).toBe(OUTCOME.ALREADY);
  });

  it("失败不推进 lastDay，且当日次数 +1", async () => {
    const { runner } = harness({ responses: [httpErr(500)] });
    const { states } = await runner.runAll([SITE], {}, { trigger: TRIGGER.MANUAL });
    expect(states.wb.lastDay).toBeUndefined();
    expect(states.wb.attempts).toEqual({ day: "2026-09-30", count: 1 });
    expect(states.wb.lastError).toBe("HTTP 500");
  });

  it("只保留本次涉及的站点状态，不误伤别人", async () => {
    const { runner } = harness({ responses: [ok()] });
    const { states } = await runner.runAll([SITE], { other: { points: 7 } }, { trigger: TRIGGER.MANUAL });
    expect(states.other).toEqual({ points: 7 });
  });

  it("历史记录最新在前", async () => {
    const { runner } = harness({ responses: [ok({ data: { checkedToday: true, points: 1 } }), ok({ data: { checkedToday: true, points: 2 } })] });
    const first = await runner.runAll([SITE], {}, { trigger: TRIGGER.MANUAL });
    const second = await runner.runAll([SITE], first.states, { trigger: TRIGGER.MANUAL });
    expect(second.states.wb.history.map((h) => h.points)).toEqual([2, 1]);
    expect(second.states.wb.points).toBe(2);
  });
});
