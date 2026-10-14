// 周报定时器的单测：假 setTimeout + 可推进的假时钟，不真的等时间。
// 重点：未启用不跑、到点/错过才跑、结果先落 lastRunAt、抛错不炸、stop 清定时。
import { describe, expect, it } from "vitest";
import { createWeeklyScheduler } from "./schedule.js";

const FRI = (h, m = 0, d = 16) => new Date(2026, 9, d, h, m, 0, 0).getTime();
const WED = new Date(2026, 9, 14, 10, 0, 0).getTime();
const SAT = new Date(2026, 9, 17, 9, 0, 0).getTime();
const POLICY = { enabled: true, weekday: 5, hour: 17, minute: 0 };

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
      tasks.splice(tasks.indexOf(task), 1);
      await task.fn();
    },
  };
}

function harness({ policy = POLICY, state = {}, generate, nowMs = WED } = {}) {
  const timers = fakeTimers();
  let current = nowMs;
  const saved = { state: { ...state }, generated: 0, notified: [] };
  const scheduler = createWeeklyScheduler({
    now: () => current,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    loadPolicy: async () => policy,
    loadState: async () => saved.state,
    saveState: async (next) => {
      saved.state = next;
    },
    generate: generate || (async () => {
      saved.generated += 1;
      return { ok: true, text: "draft", range: { label: "本周" } };
    }),
    notify: async (summary) => {
      saved.notified.push(summary);
    },
  });
  return { scheduler, timers, saved, setNow: (v) => (current = v) };
}

describe("周报定时", () => {
  it("未启用：tick 返回 null 且不生成", async () => {
    const { scheduler, saved } = harness({ policy: { ...POLICY, enabled: false } });
    expect(await scheduler.tick("auto")).toBeNull();
    expect(saved.generated).toBe(0);
  });

  it("到点：跑一次并落 lastRunAt，然后 notify", async () => {
    const { scheduler, saved } = harness({ state: { lastRunAt: FRI(17, 0, 9) }, nowMs: FRI(17) });
    const summary = await scheduler.tick("auto");
    expect(summary.ok).toBe(true);
    expect(saved.generated).toBe(1);
    expect(saved.state.lastRunAt).toBe(FRI(17));
    expect(saved.notified).toHaveLength(1);
  });

  it("补跑只在错过时发生：没到点不跑", async () => {
    const { scheduler, saved } = harness({ state: { lastRunAt: FRI(17, 0, 9) }, nowMs: WED });
    expect(await scheduler.tick("catchup")).toBeNull();
    expect(saved.generated).toBe(0);
  });

  it("补跑只在错过时发生：已错过（周五之后）才跑", async () => {
    const { scheduler, saved } = harness({ state: { lastRunAt: FRI(17, 0, 9) }, nowMs: SAT });
    const summary = await scheduler.tick("catchup");
    expect(summary.ok).toBe(true);
    expect(saved.generated).toBe(1);
  });

  it("本周已跑过：同一周晚些时候不再生成", async () => {
    const { scheduler, saved } = harness({ state: { lastRunAt: FRI(17) }, nowMs: SAT });
    expect(await scheduler.tick("auto")).toBeNull();
    expect(saved.generated).toBe(0);
  });

  it("无素材（generate 不 ok）不落 lastRunAt，本轮返回失败原因", async () => {
    const { scheduler, saved } = harness({
      state: { lastRunAt: FRI(17, 0, 9) },
      nowMs: FRI(17),
      generate: async () => ({ ok: false, reason: "no-material" }),
    });
    const summary = await scheduler.tick("auto");
    expect(summary.ok).toBe(false);
    expect(summary.reason).toBe("no-material");
    expect(saved.state.lastRunAt).toBe(FRI(17, 0, 9)); // 未推进
  });

  it("generate 抛异常不冒泡：定时任务里没人接异常", async () => {
    const { scheduler } = harness({
      state: { lastRunAt: FRI(17, 0, 9) },
      nowMs: FRI(17),
      generate: async () => {
        throw new Error("存储读不出来");
      },
    });
    const summary = await scheduler.tick("auto");
    expect(summary.error).toContain("存储读不出来");
    expect(summary.ok).toBe(false);
  });

  it("start：先挂补跑定时器，兑现后补跑并排下一次", async () => {
    const { scheduler, timers, saved } = harness({ state: { lastRunAt: FRI(17, 0, 9) }, nowMs: WED });
    await scheduler.start({ catchupDelayMs: 4000 });
    expect(timers.tasks).toHaveLength(1);
    expect(timers.tasks[0].ms).toBe(4000);
    await timers.fire(timers.tasks[0].id);
    expect(saved.generated).toBe(0); // 周中没到点，不补跑
    expect(timers.tasks).toHaveLength(1); // 但已排下一次（本周五）
  });

  it("stop 清掉挂着的定时器", async () => {
    const { scheduler, timers } = harness();
    await scheduler.start({ catchupDelayMs: 0 });
    expect(timers.tasks).toHaveLength(1);
    scheduler.stop();
    expect(timers.tasks).toHaveLength(0);
  });

  it("nextDelayFor：未启用 null；启用后指向下一次触发点（clamp 到上限内）", async () => {
    const off = harness({ policy: { ...POLICY, enabled: false } });
    expect(await off.scheduler.nextDelayFor()).toBeNull();

    const on = harness({ nowMs: WED });
    const delay = await on.scheduler.nextDelayFor();
    expect(delay).toBe(FRI(17) - WED);
    expect(delay).toBeLessThanOrEqual(2147483647);
    expect(delay).toBeGreaterThanOrEqual(1000);
  });

  it("重复 tick 复用同一在途 Promise，不生成两次", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { scheduler } = harness({
      state: { lastRunAt: FRI(17, 0, 9) },
      nowMs: FRI(17),
      generate: async () => {
        calls += 1;
        await gate;
        return { ok: true, text: "x" };
      },
    });
    const a = scheduler.tick("auto");
    const b = scheduler.tick("auto");
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});
