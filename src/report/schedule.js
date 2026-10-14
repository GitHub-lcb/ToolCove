// 周报定时器：应用开着时到点自动生成周报草稿，另有启动补跑。
//
// 与 checkin/schedule.js 同构（deps 全部注入的纯逻辑，单测塞假实现即可）。沿用同一套纪律：
//  - 必须待在**主窗口**里跑（工具是独立 WebviewWindow，关掉工具窗口定时器就没了），
//    所以只由 App.vue 在非 toolMode 时启动一次；
//  - setTimeout 上限 2^31-1 ms，且每次醒来后**重算**下一次而不是沿用旧时间戳
//    （机器休眠/时钟跳变后剩余时间可能算成负数或超大值）；
//  - 结果先落盘（saveState）再排下一次，否则下次醒来会按旧状态重跑。
import { isDueSince, nextWeeklyAt, normalizeWeeklyPolicy } from "./weeklyPolicy.js";

const MAX_DELAY = 2147483647;
export const WEEKLY_STATUS_EVENT = "weekly-report-status";

export function createWeeklyScheduler(deps) {
  const now = deps.now || (() => Date.now());
  const setTimer = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout || ((id) => clearTimeout(id));
  let handle = null;
  let stopped = false;
  let running = false;

  function emit(detail) {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    window.dispatchEvent(new CustomEvent(WEEKLY_STATUS_EVENT, { detail }));
  }

  /** 跑一轮：读策略 → 判定是否该跑 → 生成草稿 → 成功才落 lastRunAt → 通知。重复调用复用同一在途。 */
  async function tick(trigger) {
    if (running) return null;
    running = true;
    try {
      const policy = normalizeWeeklyPolicy(await deps.loadPolicy());
      if (!policy.enabled) return null;
      const state = (await deps.loadState()) || {};
      // 未到点且没错过 → 不跑。到点（含启动补跑）时 isDueSince 为真，两条路径共用这一个判据。
      if (!isDueSince(policy, state.lastRunAt, now())) return null;
      const result = await deps.generate();
      if (!result?.ok) {
        // 无素材/未配置 AI：不落 lastRunAt，让下一次（或下次启动）仍有机会生成，但本轮不再重试。
        return { trigger, at: now(), ok: false, reason: result?.reason || "failed" };
      }
      await deps.saveState({ ...state, lastRunAt: now() });
      const summary = { trigger, at: now(), ok: true, text: result.text, range: result.range };
      emit(summary);
      await deps.notify?.(summary);
      return summary;
    } catch (error) {
      // 定时任务里抛出的异常没人接：吞掉并广播，让界面能显示失败而不是静默。
      const summary = { trigger, at: now(), ok: false, error: String(error?.message || error) };
      emit(summary);
      return summary;
    } finally {
      running = false;
    }
  }

  /** 到下一次唤醒还有多少毫秒；关掉定时返回 null。 */
  async function delayFor() {
    const policy = normalizeWeeklyPolicy(await deps.loadPolicy());
    if (!policy.enabled) return null;
    const at = nextWeeklyAt(policy, now());
    if (at == null) return null;
    return Math.min(Math.max(at - now(), 1000), MAX_DELAY);
  }

  /**
   * 挂下一次唤醒。**返回的 promise 兑现即代表定时器已就绪**（照搬 checkin 的这条纪律：
   * 早先写成内部 .then 链、start 不等它时，测试里 start 刚返回 timers 还是空的，
   * 生产含义是「start 兑现 ≠ 定时已就绪」，那是个没人会发现却会漏跑的坑）。
   */
  async function schedule() {
    if (stopped) return;
    if (handle != null) clearTimer(handle);
    handle = null;
    let delay = null;
    try {
      delay = await delayFor();
    } catch {
      delay = null; // 读配置失败就退避，不排立即触发的定时器
    }
    if (stopped || delay == null) return;
    handle = setTimer(async () => {
      handle = null;
      await tick("auto");
      // 用重算而不是「上次 + 7 天」：跨周、时钟回拨、休眠唤醒都不会跑偏
      await schedule();
    }, delay);
  }

  return {
    /**
     * 启动：先延迟补跑一次（避开首屏 IO 与界面首绘），再排下一次。
     * 补跑用的那个定时器就是「第一次唤醒」，所以期间不再另排一个定时——
     * 否则刚启动时两者都会因为「该跑」而立刻触发，白跑一轮。
     */
    async start({ catchupDelayMs = 4000 } = {}) {
      stopped = false;
      if (catchupDelayMs > 0) {
        setTimer(async () => {
          await tick("catchup");
          await schedule();
        }, catchupDelayMs);
        return;
      }
      await tick("catchup");
      await schedule();
    },
    stop() {
      stopped = true;
      if (handle != null) clearTimer(handle);
      handle = null;
    },
    reschedule: schedule,
    tick,
    isRunning: () => running,
    nextDelayFor: delayFor,
  };
}
