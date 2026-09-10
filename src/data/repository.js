// 业务数据唯一读写入口：视图与 Agent 数据工具共用，避免各自 invoke 整表覆盖。
//
// - 落盘走平台层 invoke：桌面 = Rust JSON 文件（内容哈希修订号，见 load_data_versioned/
//   save_data_versioned）；浏览器 = IndexedDB（platform/invoke.js 同名实现）。
// - 写前读最新 + 修订号校验 + 冲突重放：并发方（另一窗口 / Agent / 云同步）先写入时，
//   本次写入基于新数据重放，而不是用内存旧快照覆盖。
// - 写后广播 data-changed（视图据此刷新），sync 类 kind 额外入队云同步并支持墓碑删除。
import { invoke } from "../platform/invoke.js";

export const KINDS = Object.freeze({
  snippets: { key: "snippets", shape: "array", sync: true },
  problems: { key: "problems", shape: "array", sync: true },
  iterations: { key: "iterations", shape: "array", sync: false },
  domains: { key: "domains", shape: "array", sync: false },
  pools: { key: "pools", shape: "array", sync: false },
  releases: { key: "release-pools", shape: "object", sync: false },
});

const CACHE_TTL_MS = 1000;
const WRITE_RETRIES = 2;
const SEARCH_FIELDS = ["title", "name", "content", "note", "goal", "resolution", "version", "code", "path"];

const cache = new Map(); // kind -> { data, at }

function specOf(kind) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`未知数据类别：${kind}`);
  return spec;
}

/** 归一化读到的原始值：array 类保证拿到数组，object 类保证拿到含 active/archived 的对象 */
function normalizeValue(spec, raw) {
  if (spec.shape === "array") return Array.isArray(raw) ? raw : [];
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    ...o,
    active: Array.isArray(o.active) ? o.active : [],
    archived: Array.isArray(o.archived) ? o.archived : [],
  };
}

/** 展开为记录数组（object 类把 active/archived 拍平，归档项带 archivedAt 自证） */
function toRecords(spec, value) {
  if (spec.shape === "array") return value;
  return [...(value.active || []), ...(value.archived || [])];
}

function arrayKeyOf(spec, value, id) {
  if (spec.shape === "array") return value;
  if ((value.active || []).some((r) => r && r.id === id)) return value.active;
  if ((value.archived || []).some((r) => r && r.id === id)) return value.archived;
  return value.active;
}

/** 深拷贝：读到的数据与缓存/调用方隔离，就地改动不得相互污染 */
function cloneData(value) {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch { /* 含不可克隆值时退回 JSON 路径 */ }
  return JSON.parse(JSON.stringify(value));
}

/**
 * updatedAt 归一化为毫秒时间戳：视图写 Date.now()（数字），tasks.js 写 ISO 字符串，
 * 两种写法必须可比，否则 Number(ISO) = NaN → 0 会被判成"更旧"而丢改动。
 */
function tsOf(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

async function readVersioned(key) {
  try {
    const r = await invoke("load_data_versioned", { key });
    if (r && typeof r === "object" && !Array.isArray(r) && Object.hasOwn(r, "data")) {
      return { data: cloneData(r.data), revision: String(r.revision ?? "") };
    }
  } catch {
    // 命令缺失或平台未实现：降级为无修订读写（revision = null 表示不做版本校验）
  }
  return { data: cloneData(await invoke("load_data", { key })), revision: null };
}

function persistValue(key, data, revision) {
  if (revision === null) return invoke("save_data", { key, data });
  return invoke("save_data_versioned", { key, data, expected_revision: revision });
}

/** 总是读磁盘最新（写路径与云同步推送使用；读工具走 1s 缓存） */
export async function load(kind) {
  const spec = specOf(kind);
  const { data } = await readVersioned(spec.key);
  const value = normalizeValue(spec, data);
  cache.set(kind, { data: cloneData(value), at: Date.now() });
  return value;
}

async function loadCached(kind) {
  const hit = cache.get(kind);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return cloneData(hit.data);
  return load(kind);
}

function invalidate(kind, value) {
  if (value === undefined) cache.delete(kind);
  else cache.set(kind, { data: cloneData(value), at: Date.now() });
}

function emitChanged(kind, ids, source) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  if (typeof CustomEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("data-changed", { detail: { kind, ids: ids || [], source: source || "" } }));
}

/** 订阅数据变更（视图挂载时调用），返回取消订阅函数 */
export function onDataChanged(handler) {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const wrapped = (e) => handler(e?.detail || {});
  window.addEventListener("data-changed", wrapped);
  return () => window.removeEventListener("data-changed", wrapped);
}

let syncModule = null;
function sync() {
  syncModule = syncModule || import("../sync/index.js").catch(() => null);
  return syncModule;
}
function enqueue(kind) {
  sync().then((m) => m?.enqueueSync?.([kind])).catch(() => {});
}

const idsOf = (spec, value) => toRecords(spec, value).map((r) => r && r.id).filter(Boolean);

/**
 * 读最新 → 变换 → 带修订号写回；写失败且磁盘已变（他人先写）时重读重放。
 * fn(fresh) 可就地修改并返回 undefined，也可返回新值；必须可重复执行。
 */
export async function mutate(kind, fn, options = {}) {
  const spec = specOf(kind);
  let lastError = null;
  for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
    const { data, revision } = await readVersioned(spec.key);
    const fresh = normalizeValue(spec, data);
    const next = (await fn(fresh)) ?? fresh;
    // 视图传进来的记录可能是响应式代理（structuredClone / IPC 都不接受代理）：落盘前统一深拷贝
    const normalized = cloneData(normalizeValue(spec, next));
    try {
      await persistValue(spec.key, normalized, revision);
    } catch (e) {
      lastError = e;
      if (attempt >= WRITE_RETRIES) break;
      const after = await readVersioned(spec.key).catch(() => null);
      // 修订号未变 = 真实写失败（IO/权限），重放无意义；变了 = 并发写，重读重放
      if (!after || String(after.revision) === String(revision)) break;
      continue;
    }
    invalidate(kind, normalized);
    emitChanged(kind, idsOf(spec, normalized), options.source);
    if (options.enqueue !== false && spec.sync) enqueue(kind);
    return normalized;
  }
  throw lastError || new Error("保存失败");
}

// ------- 记录级操作（Agent 数据工具与视图共用） -------

export async function list(kind, { keyword, tag, status, ids, limit = 20 } = {}) {
  const spec = specOf(kind);
  const records = toRecords(spec, await loadCached(kind));
  const kw = String(keyword || "").trim().toLowerCase();
  const matched = records.filter((r) => {
    if (!r || typeof r !== "object") return false;
    if (Array.isArray(ids) && ids.length && !ids.includes(r.id)) return false;
    if (status && String(r.status || "") !== status) return false;
    if (tag) {
      const tags = Array.isArray(r.tags) ? r.tags : [];
      if (!tags.includes(tag) && String(r.category || "") !== tag) return false;
    }
    if (kw) {
      const hay = SEARCH_FIELDS.map((f) => r[f]).filter((v) => typeof v === "string").join("\n")
        + "\n" + (Array.isArray(r.tags) ? r.tags.join(" ") : "");
      if (!hay.toLowerCase().includes(kw)) return false;
    }
    return true;
  });
  matched.sort((a, b) => tsOf(b.updatedAt) - tsOf(a.updatedAt));
  const capped = Number.isFinite(limit) && limit >= 0 ? matched.slice(0, limit) : matched;
  return { total: matched.length, items: capped };
}

export async function get(kind, id) {
  const spec = specOf(kind);
  const records = toRecords(spec, await loadCached(kind));
  return records.find((r) => r && r.id === id) || null;
}

export async function create(kind, draft, options = {}) {
  const spec = specOf(kind);
  const input = draft && typeof draft === "object" && !Array.isArray(draft) ? { ...draft } : {};
  delete input.createdAt;
  delete input.updatedAt;
  const now = Date.now();
  const record = { ...input, id: typeof input.id === "string" && input.id ? input.id : crypto.randomUUID(), createdAt: now, updatedAt: now };
  await mutate(kind, (value) => {
    arrayKeyOf(spec, value, record.id).unshift(record);
    return value;
  }, options);
  return record;
}

export async function update(kind, id, patch, options = {}) {
  const spec = specOf(kind);
  const input = patch && typeof patch === "object" && !Array.isArray(patch) ? { ...patch } : {};
  delete input.id;
  delete input.createdAt;
  if (Array.isArray(options.fields)) {
    for (const key of Object.keys(input)) {
      if (!options.fields.includes(key)) throw new Error(`不可修改字段：${key}`);
    }
  }
  let updated = null;
  await mutate(kind, (value) => {
    const target = arrayKeyOf(spec, value, id).find((r) => r && r.id === id);
    if (!target) throw new Error(options.notFound || "记录不存在或已被删除");
    Object.assign(target, input, { updatedAt: Date.now() });
    updated = target;
    return value;
  }, options);
  return updated;
}

/** 硬删 + 墓碑（sync 类 kind 的跨端删除据此传播） */
export async function remove(kind, id, options = {}) {
  const spec = specOf(kind);
  let removed = null;
  if (spec.sync) {
    const m = await sync();
    await m?.markTombstone?.(id, Date.now());
  }
  await mutate(kind, (value) => {
    const arr = arrayKeyOf(spec, value, id);
    const idx = arr.findIndex((r) => r && r.id === id);
    if (idx < 0) throw new Error(options.notFound || "记录不存在或已被删除");
    removed = arr[idx];
    arr.splice(idx, 1);
    return value;
  }, options);
  return removed;
}

/** 撤销删除/恢复历史记录：保留原 id 整条写回，并清掉墓碑（否则跨端仍按删除处理） */
export async function restore(kind, record, options = {}) {
  const spec = specOf(kind);
  if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id) throw new Error("恢复记录缺少 id");
  if (spec.sync) {
    const m = await sync();
    await m?.clearTombstone?.(record.id);
  }
  const restored = { ...record, updatedAt: Date.now() };
  await mutate(kind, (value) => {
    const arr = arrayKeyOf(spec, value, record.id);
    const idx = arr.findIndex((r) => r && r.id === record.id);
    if (idx >= 0) arr[idx] = restored;
    else arr.unshift(restored);
    return value;
  }, options);
  return restored;
}

/**
 * 应用云同步下发的合并结果（merge.js 的 ops）。
 * 数据来自服务端，不再入队推送（enqueue: false），避免推-拉回环；仅落盘并广播刷新。
 */
export async function applyRemote(kind, ops) {
  const spec = specOf(kind);
  if (spec.shape !== "array" || !Array.isArray(ops) || !ops.length) return null;
  return mutate(kind, (records) => {
    for (const op of ops || []) {
      const id = op?.record?.id;
      if (!id) continue;
      const idx = records.findIndex((r) => r && r.id === id);
      if (op.type === "delete") {
        if (idx >= 0) records.splice(idx, 1);
      } else if (idx >= 0) {
        records[idx] = op.record;
      } else {
        records.push(op.record);
      }
    }
    return records;
  }, { source: "sync", enqueue: false });
}

/**
 * 视图整表写入的安全合并：磁盘最新为底，本地新记录补入，同名记录按 updatedAt 新者胜、
 * 相同则本地胜（用户正在改的那份）。删除必须走 remove（本地缺记录不代表要删）。
 */
export function mergeRecords(fresh, local) {
  const next = Array.isArray(fresh) ? [...fresh] : [];
  const index = new Map(next.map((r, i) => [r && r.id, i]));
  for (const record of local || []) {
    if (!record || typeof record.id !== "string") continue;
    const i = index.get(record.id);
    if (i === undefined) {
      next.push(record);
      continue;
    }
    const freshTs = tsOf(next[i].updatedAt);
    const localTs = tsOf(record.updatedAt);
    if (localTs >= freshTs) next[i] = record;
  }
  return next;
}
