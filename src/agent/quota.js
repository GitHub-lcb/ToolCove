// Agent 免费额度的纯计数逻辑。不 import invoke —— 保持 node 环境可单测（vite.config.js 无 jsdom）。
//
// 这是本地优先产品：配额是转化杠杆而非成本控制（token 账单由用户自付），所以不做任何加固——
// 改系统时钟过日切、删改 toolbox-agentQuota.json、还原每日备份都能重置它。README/EULA 里照实写。

export const FREE_DAILY_RUNS = 8;
export const FREE_DAILY_STEPS = 60;

// 熔断上限，防止计数器因损坏数据无限增长；token 用更大的独立上限，重度 Pro 用户单日可超百万
const MAX_COUNT = 1_000_000;
const MAX_TOKENS = 1_000_000_000;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

const count = (v, max) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(Math.trunc(Number(v)), max) : 0);

// 非有限值（Infinity）→ null 表示无限制
const limitOf = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

export const todayStr = (now = new Date()) => now.toISOString().slice(0, 10);

export const emptyQuota = (day = todayStr()) => ({ day, runs: 0, steps: 0, tokens: 0 });

export const emptyUsage = () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 });

// 日期不符即视为跨天，归零重算（与 telemetry.js 的日预算同款语义）
export function normalizeQuota(raw, now = new Date()) {
  const day = todayStr(now);
  if (!isObj(raw) || raw.day !== day) return emptyQuota(day);
  return {
    day,
    runs: count(raw.runs, MAX_COUNT),
    steps: count(raw.steps, MAX_COUNT),
    tokens: count(raw.tokens, MAX_TOKENS),
  };
}

// 返回新对象，不改入参
export function consume(quota, delta = {}, now = new Date()) {
  const q = normalizeQuota(quota, now);
  const d = isObj(delta) ? delta : {};
  return {
    day: q.day,
    runs: Math.min(q.runs + count(d.runs, MAX_COUNT), MAX_COUNT),
    steps: Math.min(q.steps + count(d.steps, MAX_COUNT), MAX_COUNT),
    tokens: Math.min(q.tokens + count(d.tokens, MAX_TOKENS), MAX_TOKENS),
  };
}

export function remaining(quota, limits = {}, now = new Date()) {
  const q = normalizeQuota(quota, now);
  const l = isObj(limits) ? limits : {};
  const runs = limitOf(l.dailyRuns);
  const steps = limitOf(l.dailySteps);
  return {
    runs: runs === null ? null : Math.max(runs - q.runs, 0),
    steps: steps === null ? null : Math.max(steps - q.steps, 0),
  };
}

export function canStartRun(quota, limits = {}, now = new Date()) {
  const r = remaining(quota, limits, now);
  if (r.runs !== null && r.runs <= 0) return { ok: false, reason: "runs" };
  if (r.steps !== null && r.steps <= 0) return { ok: false, reason: "steps" };
  return { ok: true };
}

export function isExhausted(quota, limits = {}, now = new Date()) {
  return canStartRun(quota, limits, now).ok === false;
}

// 累加一次模型调用的用量；缺失或非法字段按 0 处理，calls 每次 +1
export function addUsage(usage, delta = {}) {
  const u = isObj(usage) ? usage : emptyUsage();
  const d = isObj(delta) ? delta : {};
  return {
    promptTokens: Math.min(count(u.promptTokens, MAX_TOKENS) + count(d.promptTokens, MAX_TOKENS), MAX_TOKENS),
    completionTokens: Math.min(count(u.completionTokens, MAX_TOKENS) + count(d.completionTokens, MAX_TOKENS), MAX_TOKENS),
    totalTokens: Math.min(count(u.totalTokens, MAX_TOKENS) + count(d.totalTokens, MAX_TOKENS), MAX_TOKENS),
    calls: Math.min(count(u.calls, MAX_COUNT) + 1, MAX_COUNT),
  };
}
