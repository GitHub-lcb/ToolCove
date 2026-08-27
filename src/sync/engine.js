// 云同步引擎（状态机）：配对/拉取/推送/队列/退避。
// - transport 注入：生产 = 包一层 invoke("http_request") 的适配器；测试 = 内存 mock。
// - 加密在引擎内完成（masterKeyProvider 注入）。
// - 状态：disabled | idle | syncing | error | revoked
// - 持久化：settings 里 cursor（服务端 seq 水位）/ lastPushedAt（本地水位）；
//   启动时本地重扫 updatedAt > lastPushedAt 重建推送集（崩溃恢复，幂等重推安全）。
import { encryptEnvelope, decryptEnvelope, obfuscateId, makeEnvelope, parseEnvelope } from "./crypto.js";
import { mergeRemote, collectPushes, pruneTombstones, normalizeRemoteItem } from "./merge.js";

const DEBOUNCE_MS = 3000;
const BATCH_SIZE = 200;
const BATCH_BYTES = 4 * 1024 * 1024; // 留余量给 JSON 包装（服务端 5MB）
const MAX_ITEM_CIPHER = 2 * 1024 * 1024;
const PULL_LIMIT = 500;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const DAILY_RETRY_CAP = 20;
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

export function createSyncEngine(deps) {
  const {
    transport,            // async ({method, url, headers, body}) => ({status, json})
    getConfig,             // () => sync settings 对象（含 enabled/serverUrl/.../cursor/lastPushedAt）
    saveConfig,            // async (patch) => 合并写回 settings
    masterKeyProvider,     // async () => masterKeyB64（DPAPI 解密后）
    recordSources,         // [{ key:'snippets'|'problems', get: ()=>Array, apply: (ops)=>Array（新列表）, setAll: (records)=>void }]
    getTombstones,         // () => {id: updatedAt}
    setTombstones,         // (map) => void（持久化由调用方保证）
    deviceId,              // 本机设备 ID（settings 持久化）
    callbacks = {},        // { onStatus(status, info), onOmit(recordIds), onError(msgKey) }
    debounceMs = DEBOUNCE_MS,
  } = deps;

  let status = getConfig().enabled ? "idle" : "disabled";
  let busy = false;
  let attempts = 0;
  let lastRetryDay = "";
  let retryCountToday = 0;
  const dirty = new Map(); // id -> updatedAt（防抖合并）
  const omitted = new Set(); // 本会话内超限跳过的 id（提示一次）
  let debounceTimer = null;

  const today = () => new Date().toISOString().slice(0, 10);
  function bumpRetry() {
    if (lastRetryDay !== today()) { lastRetryDay = today(); retryCountToday = 0; }
    retryCountToday += 1;
  }

  function setStatus(next, info) {
    if (status !== next) {
      status = next;
      callbacks.onStatus && callbacks.onStatus(next, info);
    }
  }

  function serverUrl() {
    const u = (getConfig().serverUrl || "").trim().replace(/\/$/, "");
    return u;
  }

  function url(path) {
    return serverUrl() + path;
  }

  async function api(method, path, body) {
    const cfg = getConfig();
    if (!cfg.collectionId && path !== "/v1/collection") throw new Error("not-paired");
    let token = null;
    try {
      token = await deps.tokenProvider();
    } catch { token = null; }
    const headers = [];
    if (token) headers.push(["Authorization", "Bearer " + token]);
    const res = await transport({ method, url: url(path), headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && path !== "/v1/pair") {
      setStatus("revoked", { code: "unauthorized" });
      callbacks.onError && callbacks.onError("sync.errAuth");
      throw new Error("sync-auth");
    }
    return res;
  }

  // ---------- 配对等元操作 ----------
  async function createCollection() {
    const res = await transport({ method: "POST", url: url("/v1/collection"), headers: [], body: undefined });
    if (res.status !== 200) throw new Error("sync.errCreate");
    return res.json; // {collectionId, pairingCode, expiresAt, salt}
  }
  async function joinCollection(collectionId, code) {
    const cfg = getConfig();
    const res = await transport({
      method: "POST",
      url: url("/v1/pair"),
      headers: [],
      body: JSON.stringify({ collectionId, code, deviceName: cfg.deviceName || "device" }),
    });
    if (res.status !== 200) {
      const e = new Error(res.status === 429 ? "sync.errLocked" : res.status === 404 ? "sync.errNotFound" : "sync.errBadCode");
      e.code = res.status;
      throw e;
    }
    return res.json; // {token, salt}
  }
  async function regenerateCode() {
    const res = await api("POST", "/v1/pairing-code");
    if (res.status !== 200) throw new Error("sync.errRegen");
    return res.json;
  }
  async function revokeDevice(tokenHash) {
    const res = await api("DELETE", "/v1/device?tokenHash=" + encodeURIComponent(tokenHash));
    if (res.status !== 200) throw new Error("sync.errRevoke");
    return res.json;
  }
  async function listDevices() {
    const res = await api("GET", "/v1/devices");
    if (res.status !== 200) throw new Error("sync.errDevices");
    return (res.json && res.json.devices) || [];
  }

  // ---------- 变更入队（防抖） ----------
  function enqueue(records) {
    if (status === "disabled" || status === "revoked") return;
    for (const r of records || []) {
      if (r && typeof r.id === "string") dirty.set(r.id, Number(r.updatedAt) || 0);
    }
    if (dirty.size) scheduleSync();
  }

  function scheduleSync() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSync().catch(() => {});
    }, debounceMs);
  }

  // ---------- 推送 ----------
  async function pushOnce() {
    const cfg = getConfig();
    const masterKey = await masterKeyProvider();
    const tomb = pruneTombstones(getTombstones(), Date.now(), TOMBSTONE_TTL_MS);
    setTombstones(tomb);
    const pushItems = [];
    for (const src of recordSources) {
      const records = src.get() || [];
      for (const p of collectPushes(records, cfg.lastPushedAt || 0, [])) {
        pushItems.push(p);
      }
    }
    for (const t of Object.entries(tomb)) {
      if (Number(t[1]) > (cfg.lastPushedAt || 0)) pushItems.push({ tombstone: true, id: t[0], updatedAt: Number(t[1]) || 0 });
    }
    if (pushItems.length === 0) return 0;

    const payloads = [];
    for (const p of pushItems) {
      const env = p.tombstone
        ? null
        : makeEnvelope(deviceId, p.updatedAt, sanitizeForSync(p.record));
      const cipher = p.tombstone ? "" : await encryptEnvelope(masterKey, env);
      if (!p.tombstone && cipher.length > MAX_ITEM_CIPHER) {
        omitted.add(p.record.id);
        continue; // 超限整条跳过（本地保留）
      }
      payloads.push({
        id: await obfuscateId(masterKey, p.tombstone ? p.id : p.record.id),
        updatedAt: p.updatedAt,
        deviceId, // 明文（匿名安装标识，非机密）：服务端据此做与客户端一致的 LWW 陈旧拒绝
        data: cipher,
        tombstone: !!p.tombstone,
      });
    }
    if (payloads.length === 0) return 0;

    let maxPushed = cfg.lastPushedAt || 0;
    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const chunk = payloads.slice(i, i + BATCH_SIZE);
      let bytes = Buffer.byteLength(JSON.stringify(chunk), "utf8");
      // 字节超限：逐条拆分重试（单条已限 2MB，最坏 4 条/批）
      if (bytes > BATCH_BYTES) {
        for (const one of chunk) {
          const res = await api("PUT", "/v1/items", { items: [one] });
          if (res.status !== 200) throw new Error("sync.errPush");
          maxPushed = Math.max(maxPushed, Number(one.updatedAt) || 0);
        }
        continue;
      }
      const res = await api("PUT", "/v1/items", { items: chunk });
      if (res.status !== 200) throw new Error("sync.errPush");
      const j = res.json || {};
      if (Array.isArray(j.rejected) && j.rejected.length) {
        for (const rej of j.rejected) {
          if (rej && rej.reason === "item-too-large" && rej.id) omitted.add(rej.id);
        }
      }
      for (const one of chunk) maxPushed = Math.max(maxPushed, Number(one.updatedAt) || 0);
    }
    await saveConfig({ lastPushedAt: maxPushed });
    if (omitted.size) callbacks.onOmit && callbacks.onOmit([...omitted]);
    return payloads.length;
  }

  function sanitizeForSync(record) {
    // v1：问题记录剔除 images 元数据（截图对象不同步）；其余原样
    const r = { ...record };
    if (Array.isArray(r.images) && r.images.length) {
      r.images = [];
    }
    return r;
  }

  // ---------- 拉取 ----------
  async function pullOnce() {
    const cfg = getConfig();
    const masterKey = await masterKeyProvider();
    let cursor = cfg.cursor || 0;
    let total = 0;
    for (;;) {
      const res = await api("GET", "/v1/items?since=" + cursor + "&limit=" + PULL_LIMIT);
      if (res.status !== 200) throw new Error("sync.errPull");
      const j = res.json || { items: [], hasMore: false };
      const items = Array.isArray(j.items) ? j.items : [];
      if (!items.length) break;
      // 混淆 id → 真实 id 反查表（本地记录 + 墓碑表；用于墓碑条目定位删除对象）
      const idMap = new Map();
      const idSource = new Map(); // 真实 id -> 源 key（墓碑归属）
      for (const src of recordSources) {
        for (const r of src.get() || []) {
          if (r && typeof r.id === "string") {
            idMap.set(await obfuscateId(masterKey, r.id), r.id);
            idSource.set(r.id, src.key);
          }
        }
      }
      for (const tid of Object.keys(getTombstones() || {})) {
        idMap.set(await obfuscateId(masterKey, tid), tid);
      }
      const decrypted = [];
      for (const raw of items) {
        const item = normalizeRemoteItem(raw);
        if (item.tombstone) {
          const realId = idMap.get(item.id) || null;
          decrypted.push({ updatedAt: item.updatedAt, tombstone: true, envelope: null, realId, realKind: realId ? idSource.get(realId) : undefined });
          continue;
        }
        let envelope;
        try {
          envelope = parseEnvelope(await decryptEnvelope(masterKey, item.data));
        } catch {
          continue; // 坏密文跳过（不应发生；可能是旧密钥数据）
        }
        decrypted.push({ updatedAt: item.updatedAt, tombstone: false, envelope });
      }
      // 逐源合并应用
      for (const src of recordSources) {
        const local = src.get() || [];
        const kind = src.key;
        // 墓碑无信封：只要 realId 反查到本源记录就参与合并（删除由 merge 判定时间序）
        const own = decrypted.filter((d) => (d.tombstone && d.realId && d.realKind === kind) || (d.envelope && d.envelope.record));
        const { records, ops } = mergeRemote(local, own, deviceId);
        if (ops.length) src.apply(ops);
      }
      total += items.length;
      cursor = j.nextSeq || items[items.length - 1].seq;
      if (!j.hasMore) break;
    }
    await saveConfig({ cursor });
    return total;
  }

  // ---------- 同步主流程 ----------
  async function runSync() {
    if (busy) return;
    const cfg = getConfig();
    if (!cfg.enabled || status === "disabled" || status === "revoked") return;
    if (retryCountToday >= DAILY_RETRY_CAP) return;
    busy = true;
    setStatus("syncing");
    try {
      const pushed = await pushOnce();
      const pulled = await pullOnce();
      attempts = 0;
      await saveConfig({ lastSyncAt: Date.now() });
      setStatus("idle", { pushed, pulled });
    } catch (e) {
      attempts += 1;
      bumpRetry();
      const delay = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** Math.min(attempts - 1, 10));
      // 401 已置 revoked：不得再被 error 覆盖（setStatus 只在状态变化时生效，这里显式保护）
      if (status !== "revoked") setStatus("error", { message: String(e && e.message || e), delay });
      callbacks.onError && callbacks.onError(String(e && e.message || e));
      if (delay > 0) {
        setTimeout(() => { if (getConfig().enabled && status !== "revoked") runSync().catch(() => {}); }, delay);
      }
    } finally {
      busy = false;
    }
  }

  // 显式手动同步（重置退避）
  async function syncNow() {
    attempts = 0;
    retryCountToday = 0;
    await runSync();
    return status;
  }

  function currentStatus() {
    return { status, dirty: dirty.size, omitted: [...omitted] };
  }

  return {
    enqueue,
    runSync,
    syncNow,
    createCollection,
    joinCollection,
    regenerateCode,
    revokeDevice,
    listDevices,
    currentStatus,
  };
}