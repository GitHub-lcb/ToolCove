// AI 识图任务模块：全局单任务（模块级内存，跨视图存活）+ 订阅通知 + owner 注册表。
// 任务状态由 aiExtract*Stream 的回调推进；取消与错误是两条独立路径（cancel 不走 onError）。
import {
  aiExtractStream,
  aiExtractManyStream,
  aiExtractGroupsStream,
} from "./ai.js";
import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

let task = null;
const listeners = new Set();
const owners = new Set(); // 当前挂载中的 AiExtract 实例 id

export const TASK_LABELS = {
  running: (seconds) => t("extract.taskRunning", { seconds }),
  done: (count) => t("extract.taskDone", { count }),
  get error() {
    return t("extract.taskError");
  },
};

export function registerOwner(id) {
  owners.add(id);
}
export function unregisterOwner(id) {
  owners.delete(id);
}
export function isOwnerMounted(id) {
  return owners.has(id);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) {
    try {
      fn(task);
    } catch {
      /* 订阅者异常不影响其他订阅者 */
    }
  }
}

export function getExtractTask() {
  return task;
}

// 状态机：idle → running → done | error | cancelled；非法流转静默忽略
export function transition(t, event) {
  if (!t) return t;
  if (t.status === "running") {
    if (event.type === "done") t.status = "done";
    else if (event.type === "error") t.status = "error";
    else if (event.type === "cancel") t.status = "cancelled";
  } else if (t.status === "idle" && event.type === "start") {
    t.status = "running";
  }
  return t;
}

// 启动识别任务：已有任务（任意状态）先取消；总是返回新任务
export function startExtractTask(config) {
  if (task && task.status === "running") {
    transition(task, { type: "cancel" });
    try {
      task.stop?.();
    } catch {
      /* 忽略 */
    }
  }
  let stopHandle = null;
  const t = {
    id: crypto.randomUUID(),
    mode: config.mode,
    ownerId: config.ownerId,
    imageUrl: config.imageUrl || "",
    status: "running",
    partial: null,
    result: null,
    error: null,
    elapsed: 0,
    fields: config.fields || [],
    groups: config.groups || [],
    stop: () => stopHandle?.(),
  };
  task = t;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (task === t && t.status === "running") {
      t.elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
      notify();
    }
  }, 200);
  const finishTimer = () => {
    if (timer) clearInterval(timer);
  };
  const countOf = (value) => {
    if (t.mode === "groups") {
      return (t.groups || []).reduce((n, g) => n + ((value && value[g.key]) || []).length, 0);
    }
    return Array.isArray(value) ? value.length : 1;
  };
  const handlers = {
    onPartial: (v) => {
      if (task !== t || t.status !== "running") return;
      t.partial = v;
      notify();
    },
    onDone: (v) => {
      if (task !== t) return;
      t.result = v;
      t.partial = null;
      t.elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
      transition(t, { type: "done" });
      finishTimer();
      notify();
    },
    onError: (e) => {
      if (task !== t) return;
      t.error = e instanceof Error ? e : new Error(String(e));
      t.partial = null;
      transition(t, { type: "error" });
      finishTimer();
      notify();
    },
  };
  const run = () => {
    const opts = { hint: config.hint || "" };
    if (t.mode === "groups") {
      stopHandle = aiExtractGroupsStream(config.images, config.groups, opts, handlers);
    } else if (t.mode === "many") {
      stopHandle = aiExtractManyStream(config.images, config.fields, opts, handlers);
    } else {
      stopHandle = aiExtractStream(config.images, config.fields, opts, handlers);
    }
  };
  try {
    run();
  } catch (e) {
    t.error = e instanceof Error ? e : new Error(String(e));
    transition(t, { type: "error" });
    finishTimer();
  }
  notify();
  return t;
}

// 取消：不走 onError（channel.close 后端静默返回）
export function cancelExtractTask() {
  if (!task) return;
  if (task.status === "running") {
    try {
      task.stop?.();
    } catch {
      /* 忽略 */
    }
    transition(task, { type: "cancel" });
  } else {
    transition(task, { type: "cancel" });
  }
  notify();
}

// 结果已交付（apply 成功后）清除任务
export function clearExtractTask() {
  task = null;
  notify();
}
