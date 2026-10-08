// 常驻定时器：应用开着时每天到点自动签，另有启动补签。
//
// 必须待在**主窗口**里跑：工具是独立 WebviewWindow，关掉工具窗口定时器就没了。
// 所以 startCheckInScheduler 只由 App.vue 在非 toolMode 时调用一次。
//
// 两个容易被忽略的点：
// - setTimeout 的延时上限是 2^31-1 ms（约 24.8 天）。跨整年不会遇到，但机器休眠/时钟跳变后
//   剩余时间可能算成负数或超大值，所以 clamp 到上限，并在每次醒来后**重算**而不是沿用旧时间戳。
// - 每天只跑一次的判定全靠本地「今天已签」记录，所以状态必须先落盘再排下一次。
import { nextRunAt, normalizePolicy, todayKey } from "./daily.js";

const MAX_DELAY = 2147483647;
export const STATUS_EVENT = "checkin-status";

export function createScheduler(deps) {
  const now = deps.now || (() => Date.now());
  const setTimer = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout || ((id) => clearTimeout(id));
  let handle = null;
  let stopped = false;
  let running = false;

  function emit(detail) {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail }));
  }

  /** 跑一轮并把结果落盘。重复调用时复用同一个 Promise：手动点与定时撞车不该签两次。 */
  async function tick(trigger) {
    if (running) return null;
    running = true;
    try {
      const policy = normalizePolicy(await deps.loadPolicy());
      const sites = await deps.loadSites();
      const states = await deps.loadStates();
      const { results, states: nextStates } = await deps.runDue(sites, states, policy);
      await deps.saveStates(nextStates);
      const done = results.filter((r) => r.outcome === "ok" || r.outcome === "already").length;
      const summary = { trigger, at: now(), total: results.length, done, results };
      emit(summary);
      await deps.notify?.(summary);
      return summary;
    } catch (error) {
      // 定时任务里抛出的异常没人接：吞掉并广播，让界面能显示失败而不是静默。
      const summary = { trigger, at: now(), error: String(error?.message || error), results: [] };
      emit(summary);
      return summary;
    } finally {
      running = false;
    }
  }

  /** 算出到下一次唤醒还有多少毫秒；关掉定时或没有启用站点时返回 null。 */
  async function delayFor() {
    const policy = normalizePolicy(await deps.loadPolicy());
    if (!policy.enabled) return null;
    const [states, sites] = await Promise.all([deps.loadStates(), deps.loadSites()]);
    // 取所有启用站点里最早的那次唤醒
    const at = (sites || [])
      .filter((site) => site?.enabled !== false)
      .map((site) => nextRunAt(states[site.key], policy, now()))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)[0];
    if (at == null) return null;
    return Math.min(Math.max(at - now(), 1000), MAX_DELAY);
  }

  /**
   * 挂下一次唤醒。**返回的 promise 兑现即代表定时器已就绪**——
   * 早先写成「内部 .then 链、start 不等它」时，测试里 start 刚返回 timers 还是空的，
   * 生产上的含义是「start 兑现 ≠ 定时已就绪」，那是个没人会发现却会漏跑的坑。
   */
  async function schedule() {
    if (stopped) return;
    if (handle != null) clearTimer(handle);
    handle = null;
    let delay = null;
    try {
      delay = await delayFor();
    } catch {
      delay = null; // 读配置失败就退避一小时，不排立即触发的定时器
    }
    if (stopped || delay == null) return;
    handle = setTimer(async () => {
      handle = null;
      await tick("auto");
      // 用重算而不是「上次 + 24h」：跨天、时钟回拨、休眠唤醒都不会跑偏
      await schedule();
    }, delay);
  }

  return {
    /**
     * 启动：先补签一次（延迟几秒避开首屏 IO 与界面首绘），再排每日定时。
     * 补签用的那个定时器就是「第一次唤醒」，所以期间不再另排一个每日定时——
     * 否则刚启动时两者都会因为「今天该签」而立刻触发，白跑一轮。
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

/** 今天这个站点是否已签（界面上的徽章用；与调度器共用同一套日期口径）。 */
export function isTodayDone(siteState, nowMs = Date.now(), offsetMinutes = null) {
  if (!siteState) return false;
  const day = todayKey(nowMs, offsetMinutes);
  return siteState.lastDay === day && (siteState.lastOutcome === "ok" || siteState.lastOutcome === "already" || siteState.lastOutcome == null);
}
