// 云同步单例装配：把 engine 接到真实依赖（http_request 传输 / DPAPI 密钥 / 视图源 / 墓碑持久化）。
// 视图（SnippetView/ProblemView）挂载时注册数据源；变更持久化后调用 enqueue。
// SettingsView 通过本模块做 创建/加入/重生成/吊销 等元操作，并订阅状态事件。
import { invoke } from "@tauri-apps/api/core";
import { createSyncEngine } from "./engine.js";
import { normalizeSync } from "../settingsConfig.js";
import { encryptValue, decryptValue } from "../secure.js";
import { cachedDerive, newSalt } from "./crypto.js";

const TOMBSTONE_KEY = "sync-tombstones";
const sources = []; // [{key, get, apply}]

let engine = null;
let configCache = null;
const tombCache = { map: null };

function isDesktop() {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

async function loadSettings() {
  if (!isDesktop()) return {};
  try {
    const s = await invoke("load_data", { key: "settings" });
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

async function readSyncConfig() {
  if (configCache) return configCache;
  const s = await loadSettings();
  configCache = normalizeSync(s.sync);
  return configCache;
}

async function writeSyncConfig(patch) {
  const s = await loadSettings();
  const merged = normalizeSync({ ...configCache, ...patch });
  configCache = merged;
  s.sync = merged;
  await invoke("save_data", { key: "settings", data: s });
}

async function loadTombstones() {
  if (tombCache.map) return tombCache.map;
  let map = {};
  if (isDesktop()) {
    try {
      const v = await invoke("load_data", { key: TOMBSTONE_KEY });
      if (v && typeof v === "object" && !Array.isArray(v)) map = v;
    } catch { /* 首次使用 */ }
  }
  tombCache.map = map;
  return map;
}

let tombSaveTimer = null;
function saveTombstones(map) {
  if (!isDesktop()) return;
  if (tombSaveTimer) clearTimeout(tombSaveTimer);
  tombSaveTimer = setTimeout(() => {
    invoke("save_data", { key: TOMBSTONE_KEY, data: map }).catch(() => {});
  }, 500);
}

function emitStatus(status, info) {
  window.dispatchEvent(new CustomEvent("sync-status", { detail: { status, info: info || {} } }));
}

/** 生产传输：复用 Rust http_request 代理（规避 CORS、兑现外部请求经原生代理承诺） */
async function transport(req) {
  const r = await invoke("http_request", {
    method: req.method,
    url: req.url,
    headers: req.headers || [],
    body: req.body || "",
    timeout_ms: 60000,
  });
  let json = null;
  try {
    json = r && r.body ? JSON.parse(r.body) : null;
  } catch { json = null; }
  return { status: (r && r.status) || 0, json };
}

export async function getEngine() {
  if (!isDesktop()) return null;
  if (engine) return engine;
  let cfg = await readSyncConfig();
  // deviceId 先持久化（engine 创建时固定）
  if (!cfg.deviceId) {
    const fresh = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "dev-" + Math.random().toString(36).slice(2);
    await writeSyncConfig({ deviceId: fresh });
    cfg = await readSyncConfig();
  }
  engine = createSyncEngine({
    transport,
    getConfig: async () => readSyncConfig(),
    saveConfig: writeSyncConfig,
    masterKeyProvider: async () => {
      const c = await readSyncConfig();
      if (!c.keyCipher) throw new Error("sync-no-key");
      const raw = await decryptValue(c.keyCipher);
      if (!raw) throw new Error("sync-no-key");
      return raw;
    },
    tokenProvider: async () => {
      const c = await readSyncConfig();
      if (!c.tokenCipher) return null;
      return decryptValue(c.tokenCipher);
    },
    deviceId: (await readSyncConfig()).deviceId || null,
    recordSources: [],
    getTombstones: () => tombCache.map || {},
    setTombstones: (m) => saveTombstones(m),
    callbacks: {
      onStatus: (status, info) => emitStatus(status, info),
      onOmit: (ids) => emitStatus("omit", { ids }),
      onError: (msg) => emitStatus("error", { msg }),
    },
  });
  return engine;
}

/** 视图注册数据源（挂载时调用一次） */
export function registerSyncSource(key, src) {
  const existing = sources.find((s) => s.key === key);
  if (existing) existing.src = src;
  else sources.push({ key, src });
  if (engine) {
    // engine 已在用旧的 recordSources 闭包：重建成本高，采用动态读取——engine 每次 pull 前拉最新 sources
    engineRefs.sources = sources;
  }
}

// engine 需要的 recordSources 动态化：engine 内部以数组闭包引用；这里在创建后注入刷新器
const engineRefs = { sources };

/** 视图数据变更后调用（persist 成功之后） */
export async function enqueueSync(kinds) {
  const e = await getEngine().catch(() => null);
  if (!e) return;
  const records = [];
  for (const { key, src } of sources) {
    if (kinds && !kinds.includes(key)) continue;
    records.push(...(src.get() || []));
  }
  e.enqueue(records);
}

/** 创建同步集合 */
export async function createSyncCollection(serverUrl, password) {
  const cfg = await readSyncConfig();
  const urlClean = String(serverUrl || "").trim().replace(/\/$/, "");
  // 先验证服务器可达（创建集合）
  const res = await transport({ method: "POST", url: urlClean + "/v1/collection", headers: [], body: "" });
  if (res.status !== 200 || !res.json || !res.json.collectionId) throw new Error("sync.errCreate");
  const { collectionId, pairingCode, expiresAt, salt } = res.json;
  await setupKeyAndPair(password, salt, collectionId);
  const e = await getEngine();
  const paired = await e.joinCollection(collectionId, pairingCode);
  await writeSyncConfig({
    enabled: true,
    serverUrl: urlClean,
    collectionId,
    tokenCipher: await encryptValue(paired.token),
    status: "idle",
    cursor: 0,
    lastPushedAt: 0,
    lastSyncAt: 0,
  });
  return { pairingCode, expiresAt };
}

/** 加入已有集合（带集合 ID；实际入口） */
export async function joinSyncCollectionFull(serverUrl, collectionId, code, password) {
  const urlClean = String(serverUrl || "").trim().replace(/\/$/, "");
  const e = await getEngine();
  const probe = await transport({
    method: "POST",
    url: urlClean + "/v1/pair",
    headers: [],
    body: JSON.stringify({ collectionId, code, deviceName: "probe" }),
  });
  if (probe.status !== 200 || !probe.json || !probe.json.token || !probe.json.salt) {
    if (probe.status === 404) throw new Error("sync.errNotFound");
    if (probe.status === 429) throw new Error("sync.errLocked");
    throw new Error("sync.errBadCode");
  }
  const dup = await transport({
    method: "POST",
    url: urlClean + "/v1/pair",
    headers: [],
    body: JSON.stringify({ collectionId, code, deviceName: (await readSyncConfig()).deviceName || "device" }),
  });
  await setupKeyAndPair(password, probe.json.salt, collectionId);
  const cfg = await readSyncConfig();
  await writeSyncConfig({
    enabled: true,
    serverUrl: urlClean,
    collectionId,
    tokenCipher: await encryptValue(dup.json.token),
    status: "idle",
    cursor: 0,
    lastPushedAt: 0,
  });
  return true;
}

/** 用同步密码派生并 DPAPI 落盘主密钥（新设备/新密码） */
async function setupKeyAndPair(password, salt, collectionId) {
  const masterKey = await cachedDerive(password, salt);
  await writeSyncConfig({
    salt,
    keyCipher: await encryptValue(masterKey),
    collectionId,
  });
}

/** 手动同步 */
export async function syncNowManual(showToast, t) {
  const e = await getEngine();
  const before = e.currentStatus().status;
  await e.syncNow();
  const after = e.currentStatus();
  if (showToast && t) showToast(t("sync.syncNowOk", { pushed: after.pushed || 0, pulled: after.pulled || 0 }));
  return after;
}

/** 设备列表/吊销/重生成 */
export async function listDevices() {
  const e = await getEngine();
  return e.listDevices();
}
export async function revokeDevice(tokenHash, self) {
  const e = await getEngine();
  await e.revokeDevice(tokenHash);
  if (self) await writeSyncConfig({ enabled: false, status: "revoked", tokenCipher: "" });
}
export async function regeneratePairingCode() {
  const e = await getEngine();
  return e.regenerateCode();
}

export function syncStatusSignal() {
  return window.dispatchEvent(new CustomEvent("sync-status", { detail: {} }));
}
/** 设置页读取快照（已归一） */
export async function getSyncSnapshot() {
  return readSyncConfig();
}

/** 启用/停用（停用仅停 engine，不清数据） */
export async function setSyncEnabled(v) {
  const cfg = await readSyncConfig();
  await writeSyncConfig({ enabled: v === true, status: v === true ? "idle" : cfg.status });
}

/** 设置设备名（展示用；join 时上报） */
export async function setSyncDeviceName(name) {
  await writeSyncConfig({ deviceName: String(name || "").slice(0, 64) });
}
