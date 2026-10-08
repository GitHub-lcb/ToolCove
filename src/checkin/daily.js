// 每日调度：判断「现在该不该签」「下次什么时候签」。
//
// 全部是纯函数，因为这部分最容易出「一天多签」或「永远不签」这种错，
// 而这类错只有在跨零点、时钟回拨、限流重试的场景下才暴露，单测里能直接钉住。
//
// 时区：默认用**本机本地时区**。用户说「每天 9 点签到」，指的就是他坐在哪台机器前几点。
// 需要固定时区（如公司统一用 UTC+8 而本机时区会变）才填 policy.offsetMinutes。
import { DONE_OUTCOMES, OUTCOME, RETRYABLE_OUTCOMES } from "./classify.js";

export const DEFAULT_POLICY = Object.freeze({
  enabled: false, // 默认不开：自动往外部发请求这件事得用户自己点头
  at: "09:10",
  maxRunsPerDay: 3, // 同一天最多自动尝试三次，防止对着接口死磕
  retryDelayMs: 30 * 60 * 1000,
  offsetMinutes: null,
});

const pad = (n) => String(n).padStart(2, "0");

/**
 * 本地日期键（YYYY-MM-DD）。用 Date 的本地字段而不是 toISOString()——
 * 后者在 UTC+8 的凌晨 8 点前会算成「昨天」，于是 0 点刚过的补签会被误判成「今天已签」。
 */
export function todayKey(now = Date.now(), offsetMinutes = null) {
  const date = new Date(now);
  if (offsetMinutes == null) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  const shifted = new Date(now + offsetMinutes * 60000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** 解析 "HH:mm" → {hour, minute}；非法返回 null。 */
export function parseAt(at) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(at ?? "").trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** 某个时刻在「今天」的绝对时间戳；offsetMinutes 为空时按本地时间构造。 */
export function atTimeOfDay(now, at, offsetMinutes = null) {
  const parsed = parseAt(at);
  if (!parsed) return null;
  if (offsetMinutes == null) {
    const date = new Date(now);
    date.setHours(parsed.hour, parsed.minute, 0, 0);
    return date.getTime();
  }
  // 固定时区：先用 UTC 字段拼出目标日的 00:00，再加偏移，最后减回去
  const local = new Date(now + offsetMinutes * 60000);
  const midnightUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return midnightUtc + (parsed.hour * 60 + parsed.minute) * 60000 - offsetMinutes * 60000;
}

/**
 * 数字兜底：只有「真的是数字」才用它。
 *
 * 踩过的坑：Number(null) 是 0、Number(undefined) 是 NaN、Number("") 是 0。
 * 直接 `Number(x) || 默认值` 会把 null 变成 0（偏移量=UTC，整点偏 8 小时），
 * 而 `Number.isFinite(Number(x))` 更隐蔽——它对 null 返回 true，于是「未指定 → 本地时区」
 * 被静默改写成「UTC」。两者都要显式挡掉 null / undefined / 空串。
 */
function numOr(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizePolicy(input = {}) {
  const parsed = parseAt(input.at);
  const offset = input.offsetMinutes == null || input.offsetMinutes === "" ? null : numOr(input.offsetMinutes, null);
  return {
    enabled: !!input.enabled,
    at: parsed ? String(input.at).trim() : DEFAULT_POLICY.at,
    maxRunsPerDay: Math.min(Math.max(numOr(input.maxRunsPerDay, DEFAULT_POLICY.maxRunsPerDay), 1), 20),
    retryDelayMs: Math.min(Math.max(numOr(input.retryDelayMs, DEFAULT_POLICY.retryDelayMs), 60000), 6 * 60 * 60 * 1000),
    offsetMinutes: offset == null ? null : Math.min(Math.max(offset, -14 * 60), 14 * 60),
  };
}

function stateOf(state) {
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

/**
 * 调度判定。
 *
 * 返回 { due, reason, at }。reason 是给人看的，也是单测的断言点：
 *   disabled / done-today / attempts-exhausted / rate-limited / too-early / due
 *
 * 顺序要紧：先判「今天已完成」，再判「尝试次数」，最后才看时刻。
 * 反过来的话，一天里第三次失败后会把「次数用完」误报成「太早」。
 */
export function planDailyRun(siteState, policyInput, now = Date.now()) {
  const policy = normalizePolicy(policyInput);
  const state = stateOf(siteState);
  const day = todayKey(now, policy.offsetMinutes);

  if (!policy.enabled) return { due: false, reason: "disabled", at: null, day };

  // 「今天已完成」只认 ok / already。失败过的那天不算完成——第二天要继续签。
  if (state.lastDay === day && DONE_OUTCOMES.has(state.lastOutcome)) {
    return { due: false, reason: "done-today", at: null, day };
  }
  // 兼容只写了 lastDay 没写 outcome 的旧记录：既然标记成今天签过，就当已完成。
  if (state.lastDay === day && state.lastOutcome == null) {
    return { due: false, reason: "done-today", at: null, day };
  }

  const attempts = state.attempts && state.attempts.day === day ? Number(state.attempts.count) || 0 : 0;
  if (attempts >= policy.maxRunsPerDay) {
    return { due: false, reason: "attempts-exhausted", at: null, day };
  }

  if (Number(state.retryAfterAt) > now) {
    return { due: false, reason: "rate-limited", at: Number(state.retryAfterAt), day };
  }

  const at = atTimeOfDay(now, policy.at, policy.offsetMinutes);
  if (at == null) return { due: false, reason: "disabled", at: null, day };
  if (now < at) return { due: false, reason: "too-early", at, day };

  return { due: true, reason: "due", at, day };
}

/**
 * 下次唤醒的时间戳。计划不可跑时给出「值得再算一次」的那个时刻：
 * done-today → 明天同一时刻；rate-limited → retryAfterAt；次数用完 → 明天同一时刻。
 */
export function nextRunAt(siteState, policyInput, now = Date.now()) {
  const policy = normalizePolicy(policyInput);
  const plan = planDailyRun(siteState, policy, now);
  if (plan.due) return now;
  if (plan.at != null) return plan.at;
  if (plan.reason === "done-today" || plan.reason === "attempts-exhausted") {
    // 「明天同一时刻」：把 now 推到下一个本地日再取 at，避免手算跨月/跨年。
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const next = atTimeOfDay(tomorrow.getTime(), policy.at, policy.offsetMinutes);
    return next == null ? now + 3600000 : Math.max(next, now + 60000);
  }
  if (!policy.enabled) return null;
  return now + 3600000; // 兜底：一小时后重算，别把定时器停死
}

/**
 * 把一次结果并进状态，返回新的站点状态对象（不改原对象，方便单测比对）。
 *
 * 三个必须记住的点：
 * - 只有 ok / already 才推进 lastDay。失败了却推进，第二天就不会再签——这是最恶心的 bug；
 * - 每次真实发出请求都要记 attempts，限流与网络抖动也要退避（否则 3 次额度会被瞬间烧完）；
 * - 积分只在读到数字时覆盖，读不到就保留上次值（别用 undefined 把已有积分抹掉）。
 */
export function applyResult(siteState, outcome, { now = Date.now(), offsetMinutes = null, detail = "" } = {}) {
  const prev = siteState && typeof siteState === "object" ? siteState : {};
  const day = todayKey(now, offsetMinutes);
  const next = { ...prev, lastOutcome: outcome, lastAt: now, lastError: detail || "" };

  if (DONE_OUTCOMES.has(outcome)) next.lastDay = day;

  const count = prev.attempts && prev.attempts.day === day ? Number(prev.attempts.count) || 0 : 0;
  next.attempts = { day, count: count + 1 };

  if (outcome === OUTCOME.RATE_LIMITED) {
    // 服务端说了多久就等多久（Retry-After 已在 http 层解析过则用它），否则用本地退避。
    next.retryAfterAt = Math.max(Number(prev.retryAfterAt) || 0, now + 30 * 60 * 1000);
  } else if (RETRYABLE_OUTCOMES.has(outcome)) {
    next.retryAfterAt = now + 30 * 60 * 1000;
  } else {
    // 鉴权/描述文件错误/已签到都不该退避：重试没有任何意义，还会白白烧掉当日次数。
    next.retryAfterAt = 0;
  }

  return next;
}

/** 记录本次读到的积分；读不到不动旧值。 */
export function withPoints(siteState, points) {
  if (points === undefined || points === null || !Number.isFinite(points)) return siteState;
  return { ...siteState, points };
}

export function appendHistory(siteState, entry, limit = 30) {
  const history = Array.isArray(siteState?.history) ? siteState.history : [];
  const next = [entry, ...history].slice(0, Math.max(1, limit));
  return { ...siteState, history: next };
}
