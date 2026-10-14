// 装配层：把真实实现（storage / AI / 通知）接到 scheduler 上，并对外提供「生成一份草稿」。
//
// 单独的必要性：scheduler 是 deps 注入的纯逻辑，单测里塞假实现就行；真实接线集中在这里，
// 避免 App.vue 与界面各写一份「怎么生成周报」。生成逻辑刻意与 TaskView 手动生成共用
// ../report/material.js，保证定时草稿与手动生成的素材一致。
import { invoke } from "../platform/invoke.js";
import { isDesktop } from "../platform/env.js";
import { i18n } from "../i18n/index.js";
import { load as loadRecords, create as createRecord } from "../data/repository.js";
import { collectDayLogs } from "../shared/hours.js";
import { aiComplete, isAIConfigured } from "../ai.js";
import { buildReportSystem, upsertReport } from "../weeklyReport.js";
import { weekRange, buildReportMaterial } from "./material.js";
import { createWeeklyScheduler } from "./schedule.js";
import { WEEKLY_KEY, normalizeWeeklyPolicy } from "./weeklyPolicy.js";

const t = (key, params) => i18n.global.t(key, params);

// 调度状态（上次运行时间）单独一个 key：与策略分开，界面保存策略时不会顺手把它覆盖掉。
export const WEEKLY_STATE_KEY = "reportScheduleState";

export async function loadWeeklyPolicy() {
  try {
    return normalizeWeeklyPolicy((await invoke("load_data", { key: WEEKLY_KEY })) || {});
  } catch {
    return normalizeWeeklyPolicy({});
  }
}

export async function saveWeeklyPolicy(policy) {
  await invoke("save_data", { key: WEEKLY_KEY, data: normalizeWeeklyPolicy(policy) });
}

async function loadWeeklyState() {
  try {
    const value = await invoke("load_data", { key: WEEKLY_STATE_KEY });
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function saveWeeklyState(state) {
  await invoke("save_data", { key: WEEKLY_STATE_KEY, data: state });
}

/**
 * 生成一份「本周」周报草稿并落盘（状态：新建），供定时器与界面「立即生成」共用。
 * 返回 { ok, text, range } 或 { ok:false, reason }（reason: no-material / no-ai）。
 * 无素材、未配置 AI 都算「这轮不生成」，由调用方决定提示或跳过。
 */
export async function generateWeeklyDraft() {
  const [iterations, problems, settings, prefs, reports] = await Promise.all([
    loadRecords("iterations"),
    loadRecords("problems"),
    invoke("load_data", { key: "settings" }).catch(() => null),
    invoke("load_data", { key: "reportPrefs" }).catch(() => null),
    invoke("load_data", { key: "reports" }).catch(() => null),
  ]);
  const userName = (settings && settings.displayName) || "";
  const dayLogs = collectDayLogs(iterations, problems, userName);
  const range = weekRange("this", t);
  const material = buildReportMaterial({ dayLogs, iterations }, range, t);
  if (!material.hasLogs) return { ok: false, reason: "no-material" };
  if (!(await isAIConfigured())) return { ok: false, reason: "no-ai" };

  const text = ((await aiComplete(material.text, { system: buildReportSystem(prefs || {}) })) || "").trim();
  if (!text) return { ok: false, reason: "no-material" };
  // 与 TaskView 手动保存同一口径：range 用 "this"，同 range 的既有草稿直接更新（不重复新增）
  const { list } = upsertReport(reports || [], { range: "this", rangeLabel: range.label, text });
  await invoke("save_data", { key: "reports", data: list });
  return { ok: true, text, range };
}

/**
 * 把一份周报归档为速记（复用 records 的 snippets）。
 * 复用 repository 的 create：自动带乐观锁、广播、云同步入队，无需另造数据模型。
 */
export async function archiveDraftToSnippet(report) {
  if (!report) return null;
  return createRecord(
    "snippets",
    { title: `${report.rangeLabel || ""} 周报`.trim(), content: report.text || "", tags: ["周报"], pinned: false },
    { source: "report" }
  );
}

/**
 * 定时生成成功后的桌面通知。失败静默——与 checkin 同语气：
 * 通知只是「顺便提一句」，用户打开界面能看到草稿，不该因通知失败反过来打断定时任务。
 */
async function notifyWeekly(summary) {
  if (!isDesktop || !summary?.ok) return;
  const label = summary.range?.label || "";
  try {
    await invoke("notify", { title: t("task.weeklyNotifyTitle"), body: t("task.weeklyNotifyBody", { label }) });
  } catch {
    /* 通知失败不影响周报生成结果 */
  }
}

let scheduler = null;

/** 取得（必要时创建）全局调度器。必须在主窗口调用。 */
export function getWeeklyScheduler() {
  if (!scheduler) {
    scheduler = createWeeklyScheduler({
      loadPolicy: loadWeeklyPolicy,
      loadState: loadWeeklyState,
      saveState: saveWeeklyState,
      generate: generateWeeklyDraft,
      notify: notifyWeekly,
    });
  }
  return scheduler;
}

export function startWeeklyScheduler(options) {
  return getWeeklyScheduler().start(options);
}

export function stopWeeklyScheduler() {
  scheduler?.stop();
}

export { WEEKLY_KEY };
