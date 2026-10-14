// 周报定时策略：纯函数，与 checkin/daily.js 同构。
//
// 把「什么时候该生成」「错过了要不要补跑」算清楚——这部分最容易出
// 「一周多跑一次」或「永远不跑」这种错，而它们只有在跨周、时钟跳变、休眠唤醒时才暴露，
// 单测里直接钉住比在生产上排查便宜得多。
//
// 时区：默认用**本机本地时区**。用户说「周五 17 点生成周报」，指的就是他坐在哪台机器前几点。

// 配置落 invoke load_data/save_data 的这个 key（独立的 reportSchedule.json）
export const WEEKLY_KEY = "reportSchedule";

// weekday 按 JS Date.getDay() 口径：0=周日 … 6=周六。默认周五 17:00。
export const DEFAULT_WEEKLY_POLICY = Object.freeze({ enabled: false, weekday: 5, hour: 17, minute: 0 });

// 整数兜底：非法/空值回退默认，其余取整并钳制到区间。
// 挡掉 null / "" / 非数字（Number("") 是 0、Number("abc") 是 NaN，都会静默改写用户意图）。
function clampInt(value, min, max, fallback) {
  if (value == null || value === "") return fallback;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export function normalizeWeeklyPolicy(raw) {
  // 显式挡掉 null / 非对象：默认参数只对 undefined 生效，不能指望它兜住 null
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: !!input.enabled,
    weekday: clampInt(input.weekday, 0, 6, DEFAULT_WEEKLY_POLICY.weekday),
    hour: clampInt(input.hour, 0, 23, DEFAULT_WEEKLY_POLICY.hour),
    minute: clampInt(input.minute, 0, 59, DEFAULT_WEEKLY_POLICY.minute),
  };
}

// 下一次触发的时间戳：严格晚于 nowMs 的最近一个「weekday + hour:minute」本地时刻。
// 最多向后找 7 天（含今天这个 weekday 的下一周），必然命中。
export function nextWeeklyAt(policy, nowMs = Date.now()) {
  const p = normalizeWeeklyPolicy(policy);
  const base = new Date(nowMs);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    d.setHours(p.hour, p.minute, 0, 0);
    if (d.getDay() === p.weekday && d.getTime() > nowMs) return d.getTime();
  }
  return null;
}

// 是否需要（补）跑：把「上次跑过之后的下一次触发点」算出来，若已 ≤ nowMs 说明那个点被错过了。
// lastRunAt 为空视为「从没跑过」——同样按需补跑一次，避免刚开启就一直空等到下个周期。
// 用途：启动补跑判定（否则应用在触发点没开着时，这一周就空跑了）。
export function isDueSince(policy, lastRunAt, nowMs = Date.now()) {
  const p = normalizeWeeklyPolicy(policy);
  if (!p.enabled) return false;
  const base = Number.isFinite(lastRunAt) && lastRunAt > 0 ? Number(lastRunAt) : null;
  if (base == null) return true;
  const at = nextWeeklyAt(p, base);
  return at != null && at <= nowMs;
}
