// 可选遥测：opt-in、只聚合功能使用次数，不上传任何内容数据。
// - 默认关闭；首启询问一次（shouldPrompt / mergePromptDecision 为纯函数可单测）；
//   同意/拒绝立即 save_data 落盘（与设置表单保存路径分离，失败不阻断启动）。
// - 计数聚合到内存 Map，持久化到 localStorage（跨会话保留未发送计数）；
//   flush 经 Rust 命令 telemetry_submit 发送——端点默认留空 = 只聚合本地、不实际发送。
// - 失败静默：单日重试上限 + 不打扰用户。
import { invoke } from "./platform/invoke.js";
import { normalizeTelemetry } from "./settingsConfig.js";

const PENDING_KEY = "tc.telemetry.pending";
const RETRY_KEY = "tc.telemetry.retryDay";
const MAX_COUNT_PER_KEY = 1_000_000; // 单键计数熔断，防异常爆炸
const MAX_DAILY_RETRY = 5;

let counts = new Map(); // key -> number
let loaded = false;
let configCache = null;

/** 生成匿名 installId（本地随机 UUID，不关联任何账号） */
export function newInstallId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* 降级 */ }
  return "anon-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** 是否应询问遥测授权（纯函数：undefined 视为未询问过） */
export function shouldPrompt(settings) {
  return !settings || !settings.telemetry || !settings.telemetry.prompted;
}

/** 合并授权决定（纯函数）：返回新的 settings 对象，不修改入参 */
export function mergePromptDecision(settings, allow, installId) {
  const base = settings && typeof settings === "object" ? settings : {};
  return {
    ...base,
    telemetry: {
      ...(base.telemetry || {}),
      enabled: !!allow,
      prompted: true,
      installId: installId || base.telemetry?.installId || newInstallId(),
    },
  };
}

async function loadSettings() {
  if (!isDesktop()) return null;
  try {
    const s = await invoke("load_data", { key: "settings" });
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

function isDesktop() {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

/** 读取当前遥测配置（缓存；settings-saved 后需 invalidate） */
export async function getConfig() {
  if (!isDesktop()) return { enabled: false, prompted: false, installId: null };
  if (configCache) return configCache;
  const s = await loadSettings();
  configCache = normalizeTelemetry(s.telemetry);
  return configCache;
}

/** 使配置缓存失效（设置页保存后调用） */
export function invalidateConfigCache() {
  configCache = null;
}

/** 当前是否已授权开启（含缓存失效钩子说明） */
export async function isEnabled() {
  const cfg = await getConfig();
  return !!cfg.enabled;
}

/** 记录一次使用（聚合计数；未开启时仍可计，flush 时才按开关决定是否发送） */
export function track(key) {
  if (!key || typeof key !== "string") return;
  const cur = counts.get(key) || 0;
  if (cur >= MAX_COUNT_PER_KEY) return; // 熔断
  counts.set(key, cur + 1);
  loaded = true;
}

/** 当前待发送的事件（副本） */
export function pendingSnapshot() {
  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

function persistPending() {
  if (typeof localStorage === "undefined") return;
  const snap = pendingSnapshot();
  if (snap.length === 0) {
    localStorage.removeItem(PENDING_KEY);
    return;
  }
  localStorage.setItem(PENDING_KEY, JSON.stringify(snap));
}

function loadPending() {
  if (loaded || typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw) {
      for (const e of JSON.parse(raw)) {
        if (e && typeof e.key === "string" && Number.isFinite(e.count)) {
          counts.set(e.key, (counts.get(e.key) || 0) + e.count);
        }
      }
    }
  } catch { /* 损坏的本地缓冲直接丢弃 */ }
  loaded = true;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function retryBudgetUsed() {
  if (typeof localStorage === "undefined") return MAX_DAILY_RETRY;
  try {
    const raw = localStorage.getItem(RETRY_KEY);
    if (!raw) return 0;
    const [day, count] = raw.split(":");
    return day === todayStr() ? Number(count) || 0 : 0;
  } catch {
    return MAX_DAILY_RETRY;
  }
}

function markRetry() {
  if (typeof localStorage === "undefined") return;
  const used = retryBudgetUsed() + 1;
  localStorage.setItem(RETRY_KEY, todayStr() + ":" + used);
}

/** 发送待发计数。端点未配置/未授权/重试超限时静默跳过；成功清空本地缓冲 */
export async function flush() {
  loadPending();
  if (!isDesktop()) return;
  const cfg = await getConfig();
  if (!cfg.enabled) return;
  const snap = pendingSnapshot();
  if (snap.length === 0) return;
  if (retryBudgetUsed() >= MAX_DAILY_RETRY) return;
  try {
    await invoke("telemetry_submit", {
      events: snap.map((e) => ({ ...e, ts: Date.now() })),
    });
    counts.clear();
    persistPending();
  } catch {
    markRetry(); // 静默失败：仅消耗当日重试预算
  }
}

/** 用户同意/拒绝（首启询问或设置页开关）：立即落盘，不阻塞调用方 */
export async function consent(allow) {
  if (!isDesktop()) return;
  const s = await loadSettings();
  const cfg = normalizeTelemetry(s.telemetry || {});
  const next = mergePromptDecision(s, allow, cfg.installId || undefined);
  try {
    await invoke("save_data", { key: "settings", data: next });
  } catch {
    /* 写回失败不阻断启动 */
  }
  invalidateConfigCache();
}
