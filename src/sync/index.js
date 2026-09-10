// 云同步单例装配：把 engine 接到真实依赖（http_request 传输 / DPAPI 密钥 / 数据源 / 墓碑持久化）。
// 数据源 = 数据访问层（data/repository.js）：同步前从磁盘读最新（refreshSources），拉取结果写回磁盘
// 并广播 data-changed。因此推送/拉取不依赖任何视图是否打开；视图只订阅 data-changed 刷新自己。
// SettingsView 通过本模块做 创建/加入/重生成/吊销 等元操作，并订阅状态事件。
import { invoke } from "../platform/invoke.js";
import { createSyncEngine } from "./engine.js";
import { normalizeSync } from "../settingsConfig.js";
import { encryptValue, decryptValue } from "../secure.js";
import { cachedDerive, newSalt } from "./crypto.js";
import { KINDS, load as loadKind, applyRemote } from "../data/repository.js";

const TOMBSTONE_KEY = "sync-tombstones";
const SYNC_KINDS = Object.keys(KINDS).filter((kind) => KINDS[kind].sync);
const mirrors = new Map(); // kind -> 记录数组（引擎取数用，同步前刷新）

let engine = null;
let enginePromise = null;
let configCache = null;
const tombCache = { map: null };

/** 从磁盘刷新推送镜像（同步前 / 变更入队前调用） */
async function refreshSources(kinds = SYNC_KINDS) {
  await Promise.all(
    kinds.map(async (kind) => {
      try {
        const value = await loadKind(kind);
        mirrors.set(kind, Array.isArray(value) ? value : []);
      } catch {
        // 读失败保留上次镜像：宁可推送旧数据，也不因为一次读失败丢失本次同步
      }
    })
  );
}

function sourceList() {
  return SYNC_KINDS.map((key) => ({
    key,
    get: () => mirrors.get(key) || [],
    apply: (ops) => applyRemote(key, ops),
  }));
}

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
  // 配对/加入集合与设置页开关都会改写 enabled：引擎状态机需要立即跟随，
  // 否则「刚配对好」的进程要等重启才会真正开始同步。
  engine?.refreshEnabled?.();
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
  // 并发守卫：repository 入队（fire-and-forget）与调用方可能同时触发创建，
  // 无守卫会各建一个引擎：一个在干活、另一个被拿去做状态查询，表现为「同步没反应」。
  if (!enginePromise) {
    enginePromise = buildEngine().catch((e) => {
      enginePromise = null;
      throw e;
    });
  }
  return enginePromise;
}

async function buildEngine() {
  let cfg = await readSyncConfig();
  // deviceId 先持久化（engine 创建时固定）
  if (!cfg.deviceId) {
    const fresh = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "dev-" + Math.random().toString(36).slice(2);
    await writeSyncConfig({ deviceId: fresh });
    cfg = await readSyncConfig();
  }
  engine = createSyncEngine({
    transport,
    // 引擎按契约同步读配置（构造时即取 .enabled/.cursor 等字段）：这里回进程内快照。
    // 快照由 readSyncConfig/writeSyncConfig 维护，getEngine 创建引擎前已 await 加载完毕。
    // 若传 async 函数会返回 Promise —— 引擎读到的字段全是 undefined，同步将整体停摆。
    getConfig: () => configCache,
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
    sourceProvider: sourceList,
    refreshSources: () => refreshSources(),
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

/** 数据变更后调用（repository 写成功后自动调用）。kinds 省略 = 全部同步类别。 */
export async function enqueueSync(kinds) {
  const e = await getEngine().catch(() => null);
  if (!e) return;
  const wanted = Array.isArray(kinds) && kinds.length ? kinds.filter((k) => SYNC_KINDS.includes(k)) : SYNC_KINDS;
  if (!wanted.length) return;
  await refreshSources(wanted);
  const records = wanted.flatMap((k) => mirrors.get(k) || []);
  e.enqueue(records);
  // 删除记录后本地已无记录可入队（dirty 为空），但墓碑需要推送，故显式请求一次同步
  e.requestSync();
}

/** 记录删除：写墓碑（时间戳），跨端据此传播删除 */
export async function markTombstone(id, ts) {
  if (!id) return;
  const map = await loadTombstones();
  map[id] = Number(ts) || Date.now();
  saveTombstones(map);
}

/** 撤销删除/恢复记录：清掉墓碑，避免跨端仍按删除处理 */
export async function clearTombstone(id) {
  const map = await loadTombstones();
  if (!Object.hasOwn(map, id)) return;
  delete map[id];
  saveTombstones(map);
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
