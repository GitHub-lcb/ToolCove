// 发布状态推导：纯本地数据（pool.lastRelease）即时计算，无云端 CI/CD 轮询。
// lastRelease 结构：{ startedAt, steps: [{ key, label, done, at }], status: "doing" | "done" | "failed", finishedAt }
export const RELEASE_STEPS = [
  { key: "pack", label: "打包" },
  { key: "upload", label: "上传" },
  { key: "release", label: "发布" },
  { key: "verify", label: "验证" },
];

export function stepLabel(key) {
  return RELEASE_STEPS.find((s) => s.key === key)?.label || key;
}

// 当前进行中的步骤（第一个未完成）；无发布记录或已结束返回 null
export function currentStepKey(r) {
  if (!r || r.status !== "doing") return null;
  const done = new Set((r.steps || []).filter((s) => s.done).map((s) => s.key));
  return RELEASE_STEPS.find((s) => !done.has(s.key))?.key || null;
}

// 已完成步骤数（供进度展示）
export function doneStepsCount(r) {
  if (!r) return 0;
  return (r.steps || []).filter((s) => s.done).length;
}

// Pool 行角标：deploying | success | failed | null（无记录视为未发布，由调用方补 idle）
export function releaseBadge(pool) {
  const r = pool?.lastRelease;
  if (!r) return null;
  if (r.status === "done") return "success";
  if (r.status === "failed") return "failed";
  return "deploying";
}

// 行内发布详情：进行中显示步骤进度，结束后显示结果
export function releaseDetail(pool) {
  const r = pool?.lastRelease;
  if (!r) return "";
  if (r.status === "doing") {
    const done = doneStepsCount(r);
    return `${done}/${RELEASE_STEPS.length} 步完成`;
  }
  return r.status === "done" ? "已发布" : "发布失败";
}
