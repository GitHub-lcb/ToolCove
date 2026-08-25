// 本地任务/工时数据层（纯函数，可单测）
// 数据落在 iterations.json（versionedData 版本化保存，与迭代/需求/发布共用同一数据源）：
//   iteration   = { id, title, status: "plan"|"dev"|"done", releaseDate, version, items: [requirement], updatedAt }
//   requirement = { id, name, done, subtasks: [subtask] }
//   subtask     = { id, name, hours, date, done, logs: [{ date, hours, name }] }
// 「子任务即工时」：hours 为累计工时；logs 为逐日登记明细（有明细时按明细逐日统计，支持跨天拆分）
// 所有修改函数返回新数组（不原地改），由调用方负责持久化。

const pad = (n) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const nowIso = () => new Date().toISOString();
const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `t${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

export function newIteration({ title, releaseDate = "", version = "", status = "plan" } = {}) {
  return { id: uid(), title: String(title || "").trim(), status, releaseDate, version, items: [], updatedAt: nowIso() };
}

export function newRequirement({ name } = {}) {
  return { id: uid(), name: String(name || "").trim(), done: false, subtasks: [] };
}

// 单条子任务：date 缺省为今天；hours 为累计工时，logs 为空时按 hours+date 统计
export function newSubTask({ name, hours = 0, date = today() } = {}) {
  return { id: uid(), name: String(name || "").trim(), hours: Math.max(0, Number(hours) || 0), date, done: false, logs: [] };
}

export function addIteration(iterations, iteration) {
  return [...(Array.isArray(iterations) ? iterations : []), iteration];
}

export function updateIteration(iterations, iterationId, patch) {
  return (Array.isArray(iterations) ? iterations : []).map((it) =>
    it.id === iterationId ? { ...it, ...patch, updatedAt: nowIso() } : it
  );
}

export function removeIteration(iterations, iterationId) {
  return (Array.isArray(iterations) ? iterations : []).filter((it) => it.id !== iterationId);
}

export function addRequirement(iterations, iterationId, requirement) {
  return updateIteration(iterations, iterationId, {
    items: [...(findIteration(iterations, iterationId)?.items || []), requirement],
  });
}

export function updateRequirement(iterations, iterationId, requirementId, patch) {
  return (Array.isArray(iterations) ? iterations : []).map((it) => {
    if (it.id !== iterationId) return it;
    return {
      ...it,
      items: (it.items || []).map((r) => (r.id === requirementId ? { ...r, ...patch } : r)),
      updatedAt: nowIso(),
    };
  });
}

export function removeRequirement(iterations, iterationId, requirementId) {
  return (Array.isArray(iterations) ? iterations : []).map((it) => {
    if (it.id !== iterationId) return it;
    return { ...it, items: (it.items || []).filter((r) => r.id !== requirementId), updatedAt: nowIso() };
  });
}

export function addSubTask(iterations, iterationId, requirementId, subtask) {
  return (Array.isArray(iterations) ? iterations : []).map((it) => {
    if (it.id !== iterationId) return it;
    return {
      ...it,
      items: (it.items || []).map((r) =>
        r.id === requirementId ? { ...r, subtasks: [...(r.subtasks || []), subtask] } : r
      ),
      updatedAt: nowIso(),
    };
  });
}

export function updateSubTask(iterations, iterationId, requirementId, subtaskId, patch) {
  return (Array.isArray(iterations) ? iterations : []).map((it) => {
    if (it.id !== iterationId) return it;
    return {
      ...it,
      items: (it.items || []).map((r) => {
        if (r.id !== requirementId) return r;
        return {
          ...r,
          subtasks: (r.subtasks || []).map((s) => (s.id === subtaskId ? { ...s, ...patch } : s)),
        };
      }),
      updatedAt: nowIso(),
    };
  });
}

export function removeSubTask(iterations, iterationId, requirementId, subtaskId) {
  return (Array.isArray(iterations) ? iterations : []).map((it) => {
    if (it.id !== iterationId) return it;
    return {
      ...it,
      items: (it.items || []).map((r) => {
        if (r.id !== requirementId) return r;
        return { ...r, subtasks: (r.subtasks || []).filter((s) => s.id !== subtaskId) };
      }),
      updatedAt: nowIso(),
    };
  });
}

export function findIteration(iterations, iterationId) {
  return (Array.isArray(iterations) ? iterations : []).find((it) => it.id === iterationId) || null;
}

export function findRequirement(iterations, iterationId, requirementId) {
  const it = findIteration(iterations, iterationId);
  return it ? (it.items || []).find((r) => r.id === requirementId) || null : null;
}

export function findSubTask(iterations, iterationId, requirementId, subtaskId) {
  const r = findRequirement(iterations, iterationId, requirementId);
  return r ? (r.subtasks || []).find((s) => s.id === subtaskId) || null : null;
}

// 统计某迭代的需求/子任务总工时（logs 明细优先，回退 hours）
export function iterationHours(iteration) {
  if (!iteration) return 0;
  let total = 0;
  (iteration.items || []).forEach((r) => {
    (r.subtasks || []).forEach((s) => {
      if (Array.isArray(s.logs) && s.logs.length) {
        s.logs.forEach((l) => {
          total += Number(l.hours) || 0;
        });
      } else {
        total += Number(s.hours) || 0;
      }
    });
  });
  return Math.round(total * 100) / 100;
}
