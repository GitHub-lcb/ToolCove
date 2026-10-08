// 定时器的单测：假 setTimeout + 假时钟，不真的等时间。
//
// 重点测三件容易出错的事：
// - 补签只做一次，且结果先落盘再排下一次（否则明天醒来发现今天没记录，会重签）；
// - 重复调用 start 不会排出一串定时器；
// - 唤醒后是**重算**而不是「上次 + 24h」，跨天与时钟回拨才不会跑偏。
import { describe, expect, it } from "vitest";
import { createScheduler, isTodayDone } from "./schedule.js";

const T10 = new Date(2026, 8, 30, 10, 0, 0, 0).getTime();
const POLICY = { enabled: true, at: "09:10" };

function fakeTimers() {
  const tasks = [];
  let seq = 0;
  return {
    tasks,
    setTimeout: (fn, ms) => {
      seq += 1;
      tasks.push({ id: seq, fn, ms });
      return seq;
    },
    clearTimeout: (id) => {
      const i = tasks.findIndex((t) => t.id === id);
      if (i >= 0) tasks.splice(i, 1);
    },
    fire: async (id) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) return;
      const i = tasks.indexOf(task);
      tasks.splice(i, 1);
      await task.fn();
    },
  };
}

function harness({ policy = POLICY, sites = [{ key: "wb" }], states = {}, runDue } = {}) {
  const timers = fakeTimers();
  const saved = { states: { ...states }, runs: [] };
  const scheduler = createScheduler({
    now: () => T10,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    loadPolicy: async () => policy,
    loadSites: async () => sites,
    loadStates: async () => saved.states,
    saveStates: async (next) => {
      saved.states = next;
    },
    runDue: runDue || (async (list, state) => {
      saved.runs.push({ list: list.map((s) => s.key), state });
      const results = list.map((s) => ({ key: s.key, outcome: "ok" }));
      const next = { ...state };
      for (const r of results) next[r.key] = { ...(next[r.key] || {}), lastDay: "2026-09-30", lastOutcome: "ok", points: 100, lastAt: T10, history: [] };
      return { results, states: next };
    }),
  });
  return { scheduler, timers, saved };
}

describe("启动补签", () => {
  it("延迟一段时间后跑一轮 catchup，并落盘", async () => {
    const { scheduler, timers, saved } = harness();
    await scheduler.start({ catchupDelayMs: 4000 });
    expect(timers.tasks).toHaveLength(1);
    await timers.fire(timers.tasks[0].id);
    expect(saved.runs).toHaveLength(1);
    expect(saved.states.wb.lastOutcome).toBe("ok");
  });

  it("catchupDelayMs 为 0 时立刻跑", async () => {
    const { scheduler, saved } = harness();
    await scheduler.start({ catchupDelayMs: 0 });
    expect(saved.runs).toHaveLength(1);
  });

  it("跑完才排下一次定时（顺序不能反，否则会用旧状态算时间）", async () => {
    const { scheduler, timers, saved } = harness();
    await scheduler.start({ catchupDelayMs: 0 });
    expect(saved.runs).toHaveLength(1);
    // 补签已记为今天完成 → 下一次是明天 09:10，不是今天
    expect(timers.tasks).toHaveLength(1);
    expect(timers.tasks[0].ms).toBeGreaterThan(20 * 60 * 60 * 1000);
  });

  it("定时关闭时不排下一次（别再打扰用户）", async () => {
    const { scheduler, timers } = harness({ policy: { ...POLICY, enabled: false } });
    await scheduler.start({ catchupDelayMs: 0 });
    expect(timers.tasks).toHaveLength(0);
  });

  it("runDue 抛异常不冒泡：定时任务里没人接异常", async () => {
    const { scheduler, saved } = harness({ runDue: async () => { throw new Error("存储读不出来"); } });
    const summary = await scheduler.tick("auto");
    expect(summary.error).toContain("存储读不出来");
    expect(saved.runs).toHaveLength(0);
  });

  it("重复 tick 复用同一个在途 Promise，不会签两次", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { scheduler } = harness({
      runDue: async () => {
        calls += 1;
        await gate;
        return { results: [], states: {} };
      },
    });
    const a = scheduler.tick("auto");
    const b = scheduler.tick("auto");
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

describe("每日定时", () => {
  it("到点触发一轮，然后重排下一次", async () => {
    const { scheduler, timers, saved } = harness();
    await scheduler.start({ catchupDelayMs: 0 });
    const first = timers.tasks[0].id;
    await timers.fire(first);
    expect(saved.runs).toHaveLength(2);
    expect(timers.tasks).toHaveLength(1);
  });

  it("停用后清掉挂着的定时器", async () => {
    const { scheduler, timers } = harness();
    await scheduler.start({ catchupDelayMs: 0 });
    expect(timers.tasks).toHaveLength(1);
    scheduler.stop();
    expect(timers.tasks).toHaveLength(0);
  });

  it("start 两次不会排出一串定时器", async () => {
    const { scheduler, timers } = harness();
    await scheduler.start({ catchupDelayMs: 0 });
    await scheduler.start({ catchupDelayMs: 0 });
    expect(timers.tasks).toHaveLength(1);
  });

  it("延时被夹在 setTimeout 上限内（超过 24.8 天会立刻触发）", async () => {
    const { scheduler, timers } = harness();
    await scheduler.start({ catchupDelayMs: 0 });
    for (const task of timers.tasks) expect(task.ms).toBeLessThanOrEqual(2147483647);
  });

  it("今天还没签时 nextDelayFor 约为 0（立刻就该跑）", async () => {
    const { scheduler } = harness();
    expect(await scheduler.nextDelayFor()).toBeLessThanOrEqual(1000);
  });

  it("今天已签后 nextDelayFor 指向明天同一时刻", async () => {
    const { scheduler } = harness({ states: { wb: { lastDay: "2026-09-30", lastOutcome: "ok" } } });
    expect(await scheduler.nextDelayFor()).toBeGreaterThan(20 * 60 * 60 * 1000);
  });

  it("没有启用站点时没有下一次", async () => {
    const { scheduler } = harness({ sites: [] });
    expect(await scheduler.nextDelayFor()).toBeNull();
  });
});

describe("今日已签判定（界面徽章用）", () => {
  it("成功与「本来就已签」都算已签", () => {
    expect(isTodayDone({ lastDay: "2026-09-30", lastOutcome: "ok" }, T10)).toBe(true);
    expect(isTodayDone({ lastDay: "2026-09-30", lastOutcome: "already" }, T10)).toBe(true);
  });

  it("失败不算已签（徽章不能给绿）", () => {
    expect(isTodayDone({ lastDay: "2026-09-30", lastOutcome: "failed" }, T10)).toBe(false);
    expect(isTodayDone({ lastDay: "2026-09-30", lastOutcome: "network" }, T10)).toBe(false);
  });

  it("昨天的记录不算", () => {
    expect(isTodayDone({ lastDay: "2026-09-29", lastOutcome: "ok" }, T10)).toBe(false);
    expect(isTodayDone(null, T10)).toBe(false);
  });
});
