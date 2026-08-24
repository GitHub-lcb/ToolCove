// 工具箱敏感配置持久化：界面内使用明文，落盘副本中的敏感字段使用 DPAPI 加密。
import { encryptValue, decryptValue } from "./secure.js";
import { loadToolbox, saveToolbox, flushToolbox } from "./toolboxStore.js";
import { cloneJsonData } from "./jsonData.js";

const DELAY = 200;
const timers = new Map();
const pending = new Map();
const chains = new Map();

function clone(value) {
  return cloneJsonData(value);
}

function enqueue(key, task) {
  const previous = chains.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  chains.set(key, next);
  return next;
}

async function flushKey(key) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  const item = pending.get(key);
  if (item) {
    pending.delete(key);
    enqueue(key, async () => {
      const protectedValue = await item.protect(item.value);
      saveToolbox(key, protectedValue);
      await flushToolbox(key);
    }).catch((e) => item.onError?.(e));
  }
  await (chains.get(key) || Promise.resolve());
}

export function saveSecureToolbox(key, value, protect, onError) {
  pending.set(key, { value: clone(value), protect, onError });
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => flushKey(key).catch(() => {}), DELAY));
}

export async function flushSecureToolbox(key) {
  if (key) return flushKey(key);
  const keys = new Set([...timers.keys(), ...pending.keys(), ...chains.keys()]);
  await Promise.all([...keys].map(flushKey));
}

export async function loadSecureToolbox(key, fallback, restore) {
  return restore(clone(await loadToolbox(key, fallback)));
}

export function isSensitiveName(name) {
  return /(authorization|auth|cookie|token|secret|password|passwd|pwd|key)/i.test(String(name || ""));
}

async function transformRows(rows, transform) {
  return Promise.all((Array.isArray(rows) ? rows : []).map(async (row) => {
    const copy = { ...(row || {}) };
    if (isSensitiveName(copy.key)) copy.value = await transform(String(copy.value ?? ""));
    return copy;
  }));
}

async function transformRequest(request, transform) {
  const copy = { ...(request || {}) };
  copy.headers = await transformRows(copy.headers, transform);
  return copy;
}

async function transformRequestState(value, transform) {
  if (value == null) return value;
  const copy = { ...(value || {}) };
  if (Array.isArray(copy.tabs)) copy.tabs = await Promise.all(copy.tabs.map((tab) => transformRequest(tab, transform)));
  else if (copy && typeof copy === "object") Object.assign(copy, await transformRequest(copy, transform));
  return copy;
}

async function transformRequestList(value, transform) {
  if (value == null) return value;
  return Promise.all((Array.isArray(value) ? value : []).map((item) => transformRequest(item, transform)));
}

async function transformCollections(value, transform) {
  if (value == null) return value;
  return Promise.all((Array.isArray(value) ? value : []).map(async (collection) => ({
    ...(collection || {}),
    requests: await transformRequestList(collection?.requests, transform),
  })));
}

async function transformEnvs(value, transform) {
  if (value == null) return value;
  return Promise.all((Array.isArray(value) ? value : []).map(async (env) => ({
    ...(env || {}),
    vars: await transformRows(env?.vars, transform),
  })));
}

export const protectRequestState = (value) => transformRequestState(value, encryptValue);
export const restoreRequestState = (value) => transformRequestState(value, decryptValue);
export const protectRequestHistory = (value) => transformRequestList(value, encryptValue);
export const restoreRequestHistory = (value) => transformRequestList(value, decryptValue);
export const protectRequestCollections = (value) => transformCollections(value, encryptValue);
export const restoreRequestCollections = (value) => transformCollections(value, decryptValue);
export const protectRequestEnvs = (value) => transformEnvs(value, encryptValue);
export const restoreRequestEnvs = (value) => transformEnvs(value, decryptValue);

export async function protectDbConnections(value) {
  return Promise.all((Array.isArray(value) ? value : []).map(async (conn) => {
    const copy = { ...(conn || {}) };
    copy.password = copy.rememberPwd ? await encryptValue(String(copy.password || "")) : "";
    return copy;
  }));
}

export async function restoreDbConnections(value) {
  return Promise.all((Array.isArray(value) ? value : []).map(async (conn) => {
    const copy = { ...(conn || {}) };
    copy.password = copy.rememberPwd ? await decryptValue(String(copy.password || "")) : "";
    return copy;
  }));
}
