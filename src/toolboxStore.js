// 工具箱数据资产化存储：从 WebView localStorage 迁到 <应用数据目录>/<key>.json（load_data/save_data），
// 与主数据（problems.json 等）同级，参与每日自动备份；首次读取时自动迁移旧 localStorage 数据并清除。
// 落盘统一用 { v: value } 包装，与「load_data 对不存在的文件返回 []」区分（避免类型歧义）。
// 写路径带防抖（合并高频草稿写入，避免每次输入都触发磁盘原子写）+ 按 key 串行队列（保证读写顺序）；
// 读路径先冲刷待写值，保证读到最新。
import { invoke } from "@tauri-apps/api/core";

const DELAY = 200;
const PREFIX = "toolbox-";
const timers = new Map();
const pending = new Map(); // fullKey -> { value, onError }
const chains = new Map();

function isTauri() {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

function fullKey(key) {
  return PREFIX + key;
}

function notify(onError, detail) {
  try {
    onError?.(detail);
  } catch {
    // 调用方提示失败不应影响存储队列。
  }
}

function enqueue(key, task) {
  const previous = chains.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  chains.set(key, next);
  return next;
}

async function writeTauri(key, item) {
  try {
    await invoke("save_data", { key, data: { v: item.value } });
    return { ok: true };
  } catch (error) {
    notify(item.onError, { key, phase: "save", error });
    return { ok: false, error };
  }
}

function flushKey(key) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  const item = pending.get(key);
  if (!item) return Promise.resolve({ ok: true, skipped: true });
  pending.delete(key);
  return enqueue(key, () => writeTauri(key, item));
}

/**
 * 防抖写。连续写同一个 key 时，值与错误回调都以最后一次调用为准。
 * 非 Tauri 预览保持同步 localStorage 行为。
 */
export function saveToolbox(key, value, { onError } = {}) {
  const full = fullKey(key);
  if (!isTauri()) {
    try {
      localStorage.setItem(full, JSON.stringify(value));
    } catch (error) {
      notify(onError, { key: full, phase: "save", error });
    }
    return;
  }
  pending.set(full, { value, onError });
  clearTimeout(timers.get(full));
  timers.set(full, setTimeout(() => flushKey(full), DELAY));
}

/** 立即冲刷待写数据；保持旧语义：写失败也返回结果而不 reject。 */
export function flushToolbox(key) {
  if (key) return flushKey(fullKey(key));
  return Promise.all([...timers.keys()].map((full) => flushKey(full)));
}

/**
 * 立即写入并返回确定结果。先取消同 key 尚未入队的防抖值，再进入相同串行队列，
 * 因此更早的 pending 值不会在本次写入后覆盖它。
 */
export function saveToolboxNow(key, value) {
  const full = fullKey(key);
  clearTimeout(timers.get(full));
  timers.delete(full);
  pending.delete(full);

  if (!isTauri()) {
    try {
      localStorage.setItem(full, JSON.stringify(value));
      return Promise.resolve({ ok: true });
    } catch (error) {
      return Promise.resolve({ ok: false, error });
    }
  }
  return enqueue(full, () => writeTauri(full, { value, onError: null }));
}

/**
 * 读取工具箱数据：优先后端资产，不存在时迁移旧 localStorage。
 * options.onError 接收 { key, phase: "load" | "save", error }。
 */
export async function loadToolbox(key, fallback, { onError } = {}) {
  const full = fullKey(key);
  let legacy = null;
  try {
    legacy = localStorage.getItem(full);
  } catch (error) {
    notify(onError, { key: full, phase: "load", error });
  }

  if (!isTauri()) {
    if (legacy === null) return fallback;
    try {
      return JSON.parse(legacy);
    } catch (error) {
      notify(onError, { key: full, phase: "load", error });
      return fallback;
    }
  }

  await flushKey(full);
  let data;
  try {
    data = await enqueue(full, () => invoke("load_data", { key: full }));
  } catch (error) {
    notify(onError, { key: full, phase: "load", error });
    return fallback;
  }
  if (data && typeof data === "object" && !Array.isArray(data) && "v" in data) {
    return data.v;
  }
  if (legacy === null) return fallback;

  let value;
  try {
    value = JSON.parse(legacy);
  } catch (error) {
    notify(onError, { key: full, phase: "load", error });
    return fallback;
  }

  const saved = await saveToolboxNow(key, value);
  if (!saved.ok) {
    notify(onError, { key: full, phase: "save", error: saved.error });
    return value;
  }
  try {
    localStorage.removeItem(full);
  } catch {
    // 资产已写入，清理旧值失败不影响本次读取。
  }
  return value;
}
