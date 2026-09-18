// 手机端工作台的纯逻辑：进度、工时汇总、排序、状态过滤。
//
// 复用口径（一行都没重写）：
//   · 工时与规模 → src/requirementMetrics.js（requirementMetrics / requirementActualHours）
//   · 集合增删改 → src/tasks.js（add/update/removeRequirement 等）
// 这里只补手机端需要的**汇总与排序**，因为桌面把这段算在 106KB 的 IterationView.vue 里，
// 手机端版式不同，不能照搬视图。

// 共享逻辑用相对路径引用：这样**单测（跑根 vite 配置）与手机端构建都能解析**。
// （手机端配置里另有 @root 别名，但单测不加载它——相对路径两边通用。）
import { requirementMetrics } from "../../src/requirementMetrics.js";

/** 迭代状态：与桌面端 IterationView 的取值一致（plan/dev/test/pending/live）。
 *  桌面把 label 硬编码成中文，手机端走词条（mobile.status.*），因此不依赖桌面文案。 */
export const ITERATION_STATUSES = Object.freeze(["plan", "dev", "test", "pending", "live"]);

/** 排序优先级：进行中的排前面，已上线的沉底；未知状态排在中间（不隐藏、也不插队）。 */
const STATUS_RANK = { dev: 0, test: 1, plan: 2, pending: 3, live: 9 };

const rankOf = (status) => (status in STATUS_RANK ? STATUS_RANK[status] : 5);

const itemsOf = (iteration) => (Array.isArray(iteration?.items) ? iteration.items.filter(Boolean) : []);

/**
 * 迭代汇总：需求条数、已完成条数、百分比，以及计划/实际工时。
 * 工时分母只统计**有估算**的需求（与 requirementMetrics 的 estimateHours 口径一致），
 * 否则「没估算」会被当成 0 而把利用率算爆。
 */
export function iterationSummary(iteration, dayHours) {
  const items = itemsOf(iteration);
  const total = items.length;
  const done = items.filter((item) => item.done).length;
  let estimateHours = 0;
  let actualHours = 0;
  let completedHours = 0;
  let estimated = 0;
  let overrun = 0;
  for (const item of items) {
    const metrics = requirementMetrics(item, dayHours);
    actualHours += metrics.actualHours;
    completedHours += metrics.completedHours;
    if (metrics.estimateHours != null) {
      estimateHours += metrics.estimateHours;
      estimated += 1;
      if (metrics.overrun) overrun += 1;
    }
  }
  const round1 = (n) => Math.round(n * 10) / 10;
  return {
    total,
    done,
    pct: total ? Math.round((done / total) * 100) : 0,
    estimateHours: round1(estimateHours),
    actualHours: round1(actualHours),
    completedHours: round1(completedHours),
    estimated,
    overrun,
    // 只有估算过的需求才算利用率；一条都没估算时为 null（UI 显示"—"而不是 0%）
    utilization: estimateHours > 0 ? Math.round((actualHours / estimateHours) * 100) : null,
  };
}

const dateValue = (value) => {
  const text = String(value || "").trim();
  if (!text) return Number.POSITIVE_INFINITY; // 没排期的排在有排期的后面
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

/** 迭代排序：状态优先级 → 上线日期近的在前 → 标题兜底（保证顺序稳定）。 */
export function sortIterations(iterations = []) {
  return [...iterations].filter(Boolean).sort((a, b) => {
    const rank = rankOf(a?.status) - rankOf(b?.status);
    if (rank !== 0) return rank;
    const date = dateValue(a?.releaseDate) - dateValue(b?.releaseDate);
    if (date !== 0) return date;
    return String(a?.title || "").localeCompare(String(b?.title || ""));
  });
}

/**
 * 需求过滤：active（未完成）/ done（已完成）/ all。
 * 与 records.js 的 filterByStatus 同一取舍：未知值按 all 处理，不把列表筛成空的。
 */
export function filterRequirements(items = [], filter = "active") {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (filter !== "active" && filter !== "done") return list;
  return list.filter((item) => (filter === "done" ? !!item.done : !item.done));
}

/** 需求行摘要：估算/实际/子任务完成度，手机上一行说清。 */
export function requirementLine(requirement, dayHours) {
  const m = requirementMetrics(requirement, dayHours);
  const subtasks = Array.isArray(requirement?.subtasks) ? requirement.subtasks.filter(Boolean) : [];
  return {
    id: requirement?.id || "",
    name: String(requirement?.name || "").trim(),
    done: !!requirement?.done,
    size: m.size,
    sizeSource: m.sizeSource,
    estimateDays: m.estimateDays,
    actualHours: m.actualHours,
    completedHours: m.completedHours,
    overrun: m.overrun,
    overHours: m.overHours,
    utilization: m.utilization,
    subtaskTotal: subtasks.length,
    subtaskDone: subtasks.filter((s) => s?.done).length,
  };
}

/** 工时文案：整数不带小数点，小数保留一位（手机上少占位置）。 */
export function hoursText(hours) {
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) return "0h";
  return Number.isInteger(value) ? `${value}h` : `${Math.round(value * 10) / 10}h`;
}
