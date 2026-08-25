export const DEFAULT_DAY_HOURS = 8;

export const REQUIREMENT_SIZES = {
  small: { key: "small", label: "小需求" },
  medium: { key: "medium", label: "中需求" },
  large: { key: "large", label: "大需求" },
  unestimated: { key: "unestimated", label: "未评估" },
};

function round(value) {
  return Math.round(value * 100) / 100;
}

export function normalizeEstimateDays(value) {
  if (value === "" || value == null) return null;
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? round(days) : null;
}

export function subtaskActualHours(task) {
  const logs = Array.isArray(task?.logs) ? task.logs : [];
  if (logs.length) return round(logs.reduce((sum, log) => sum + Math.max(0, Number(log.hours) || 0), 0));
  return round(Math.max(0, Number(task?.hours) || 0));
}

function requirementLegacyHours(requirement) {
  return round((requirement?.logs || []).reduce((sum, log) => sum + Math.max(0, Number(log.hours) || 0), 0));
}

export function requirementActualHours(requirement) {
  const subtaskHours = (requirement?.subtasks || []).reduce((sum, task) => sum + subtaskActualHours(task), 0);
  return round(subtaskHours + requirementLegacyHours(requirement));
}

export function requirementCompletedHours(requirement) {
  const subtaskHours = (requirement?.subtasks || []).reduce((sum, task) => sum + (task.done ? subtaskActualHours(task) : 0), 0);
  return round(subtaskHours + (requirement?.done ? requirementLegacyHours(requirement) : 0));
}

export function sizeByDays(days) {
  const value = Number(days) || 0;
  if (value <= 0) return REQUIREMENT_SIZES.unestimated;
  if (value < 10) return REQUIREMENT_SIZES.small;
  if (value < 30) return REQUIREMENT_SIZES.medium;
  return REQUIREMENT_SIZES.large;
}

export function requirementMetrics(requirement, dayHours = DEFAULT_DAY_HOURS) {
  const normalizedDayHours = Number(dayHours) > 0 ? Number(dayHours) : DEFAULT_DAY_HOURS;
  const estimateDays = normalizeEstimateDays(requirement?.estimateDays);
  const estimateHours = estimateDays == null ? null : round(estimateDays * normalizedDayHours);
  const actualHours = requirementActualHours(requirement);
  const actualDays = round(actualHours / normalizedDayHours);
  const completedHours = requirementCompletedHours(requirement);
  const completedDays = round(completedHours / normalizedDayHours);
  const sizeSource = estimateDays == null ? (actualDays > 0 ? "actual" : "none") : "estimate";
  const sizeDays = estimateDays == null ? actualDays : estimateDays;
  const overHours = estimateHours == null ? 0 : round(Math.max(0, actualHours - estimateHours));

  return {
    estimateDays,
    estimateHours,
    actualHours,
    actualDays,
    completedHours,
    completedDays,
    size: sizeByDays(sizeDays),
    sizeSource,
    overrun: overHours > 0,
    overHours,
    utilization: estimateHours ? Math.round((actualHours / estimateHours) * 100) : null,
  };
}

// 新建需求条目：构造完整默认形状；name 为空返回 null；estimateDays 经 normalizeEstimateDays 规范化（落库值以此为准）
export function createRequirementItem({ name, url = "", estimateDays = null }) {
  const n = String(name ?? "").trim();
  if (!n) return null;
  return {
    id: crypto.randomUUID(),
    name: n,
    url: String(url ?? "").trim(),
    estimateDays: normalizeEstimateDays(estimateDays),
    note: "",
    done: false,
    subtasks: [],
    logs: [],
  };
}

// 预估天数输入门禁：表单持有原始字符串，先经此校验，再交给 createRequirementItem 规范化
export function parseEstimateInput(value) {
  const s = String(value ?? "").trim();
  if (s === "") return { valid: true, value: null };
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return { valid: true, value: s };
  return { valid: false };
}
