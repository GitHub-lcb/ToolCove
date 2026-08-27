#!/usr/bin/env node
// ToolCove 云同步服务端（零依赖：node:http + node:crypto + node:fs）
//
// 零知识存储：只保存密文、混淆ID与时间戳；永不接触明文。协议见
// docs/superpowers/specs/2026-08-27-cloud-sync-design.md（V2）。
//
// 启动：node server/sync-server.js [--port 8080] [--data-dir ./data] [--host 0.0.0.0]
// 生产要求 HTTPS 反向代理（宝塔/Caddy/nginx，见 server/README.md）。

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 常量 ----------
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去 0 O 1 l I
const CODE_LENGTH = 8;
const CODE_TTL_MS = 15 * 60 * 1000; // 配对码 15 分钟
const FAIL_LIMIT = 5;
const LOCK_MS = 15 * 60 * 1000; // 失败冷却
const MAX_BATCH = 200;
const MAX_BATCH_BYTES = 5 * 1024 * 1024;
const MAX_ITEM_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const RATE_LIMIT = 300;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const TOKEN_BYTES = 32;
const ID_RE = /^[a-f0-9]{64}$/i; // 客户端 HMAC-SHA256 输出（真实 uuid 不上云）

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = () => Date.now();

// ---------- 存储（原子写 + 写锁链） ----------
class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();
    this.writes = Promise.resolve();
  }
  file(cid) { return path.join(this.dir, cid + ".json"); }
  load(cid) {
    if (this.cache.has(cid)) return this.cache.get(cid);
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(this.file(cid), "utf8")); } catch { return null; }
    this.cache.set(cid, doc);
    return doc;
  }
  create(cid, doc) { this.cache.set(cid, doc); return this.persist(cid); }
  persist(cid) {
    const doc = this.cache.get(cid);
    if (!doc) return Promise.resolve();
    const tmp = this.file(cid) + ".tmp";
    const final = this.file(cid);
    this.writes = this.writes.then(() => new Promise((resolve, reject) => {
      fs.writeFile(tmp, JSON.stringify(doc), (err) => {
        if (err) return reject(err);
        fs.rename(tmp, final, (err2) => (err2 ? reject(err2) : resolve()));
      });
    }));
    return this.writes;
  }
  /** 服务重启后缓存未加载的集合：遍历目录补齐（token 鉴权需跨集合查） */
  ensureAllLoaded() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")); } catch { return; }
    for (const f of files) this.load(f.slice(0, -5));
  }
}

// ---------- 工具 ----------
function genCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error("body-too-large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("bad-json")); }
    });
    req.on("error", reject);
  });
}

function makeRateLimiter(limit, windowMs) {
  const buckets = new Map();
  return function allow(ip) {
    const t = now();
    const b = buckets.get(ip) || { count: 0, start: t };
    if (t - b.start > windowMs) { b.count = 0; b.start = t; }
    b.count += 1;
    buckets.set(ip, b);
    if (buckets.size > 10000) buckets.clear();
    return b.count <= limit;
  };
}

// ---------- 路由 ----------
export function createSyncServer({ dataDir = "./data", rate = RATE_LIMIT } = {}) {
  const store = new Store(dataDir);
  const allow = makeRateLimiter(rate, RATE_WINDOW_MS);

  function auth(req) {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!token) return null;
    return { hash: sha256(token), token };
  }

  // tokenHash -> {cid, doc}；缓存未命中时补齐目录加载
  function findSession(hash) {
    store.ensureAllLoaded();
    for (const [cid, doc] of store.cache) {
      const d = doc.devices && doc.devices[hash];
      if (d && !d.revoked) return { cid, doc, device: d };
    }
    return null;
  }

  function tokenTail(token) {
    return token.slice(-8);
  }

  async function handle(req, res, ip) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const method = req.method || "";
    if (!allow(ip)) return json(res, 429, { error: "rate-limited" });

    // 创建集合：配对码仅响应一次（服务端只存 HMAC 验算所需字段，无法重新查询）
    if (method === "POST" && p === "/v1/collection") {
      const cid = crypto.randomUUID();
      const code = genCode();
      const codeSalt = crypto.randomBytes(16).toString("base64url");
      const salt = crypto.randomBytes(16).toString("base64url");
      const doc = {
        meta: { createdAt: now(), salt },
        pair: { codeHash: sha256(code + codeSalt), codeSalt, expiresAt: now() + CODE_TTL_MS, fails: 0 },
        devices: {},
        seq: 0,
        items: {},
      };
      await store.create(cid, doc);
      return json(res, 200, { collectionId: cid, pairingCode: code, expiresAt: doc.pair.expiresAt, salt });
    }

    if (method === "POST" && p === "/v1/pair") {
      const body = await readJsonBody(req, 64 * 1024);
      const { collectionId, code, deviceName } = body || {};
      const doc = collectionId && /^[a-f0-9-]{36}$/i.test(collectionId) ? store.load(collectionId) : null;
      if (!doc || !doc.pair) return json(res, 404, { error: "not-found" });
      const pair = doc.pair;
      if (pair.lockedUntil && now() < pair.lockedUntil) return json(res, 429, { error: "locked", lockedUntil: pair.lockedUntil });
      const name = typeof deviceName === "string" && deviceName.trim() ? deviceName.trim().slice(0, 64) : "device";
      if (typeof code === "string" && sha256(code + pair.codeSalt) === pair.codeHash && now() <= pair.expiresAt) {
        const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
        const tokenHash = sha256(token);
        doc.devices[tokenHash] = { name, tokenTail: tokenTail(token), createdAt: now(), lastSeen: now(), revoked: false };
        // 配对码保留至过期（多设备共用）；持有者可另行重新生成（POST /v1/pairing-code）
        await store.persist(collectionId);
        return json(res, 200, { token, salt: doc.meta.salt });
      }
      pair.fails += 1;
      if (pair.fails >= FAIL_LIMIT) pair.lockedUntil = now() + LOCK_MS;
      await store.persist(collectionId);
      return json(res, 401, { error: "bad-code", lockedUntil: pair.lockedUntil || null });
    }

    // ---- 以下需要 Bearer ----
    const session = auth(req);
    if (!session) return json(res, 401, { error: "unauthorized" });
    const found = findSession(session.hash);
    if (!found) return json(res, 401, { error: "unauthorized" });
    const { cid, doc, device } = found;
    device.lastSeen = now();

    if (method === "POST" && p === "/v1/pairing-code") {
      // 重新生成配对码：作废旧 code（新 salt/新 code/重置失败计数），旧码立即失效
      const code = genCode();
      const codeSalt = crypto.randomBytes(16).toString("base64url");
      doc.pair = { codeHash: sha256(code + codeSalt), codeSalt, expiresAt: now() + CODE_TTL_MS, fails: 0 };
      await store.persist(cid);
      return json(res, 200, { pairingCode: code, expiresAt: doc.pair.expiresAt });
    }

    if (method === "GET" && p === "/v1/items") {
      const since = Math.max(0, Number(url.searchParams.get("since") || 0) || 0);
      let limit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT) || DEFAULT_LIMIT;
      limit = Math.min(Math.max(1, limit), MAX_LIMIT);
      const entries = Object.values(doc.items)
        .filter((v) => v.seq > since)
        .sort((a, b) => a.seq - b.seq)
        .map((v) => ({ id: v.id, updatedAt: v.updatedAt, deviceId: v.deviceId || "", data: v.data, tombstone: !!v.tombstone, seq: v.seq }));
      const page = entries.slice(0, limit);
      const hasMore = entries.length > limit;
      const nextSeq = page.length ? page[page.length - 1].seq : since;
      return json(res, 200, { items: page, hasMore, nextSeq, serverTime: now() });
    }

    if (method === "PUT" && p === "/v1/items") {
      const body = await readJsonBody(req, MAX_BATCH_BYTES);
      const list = Array.isArray(body && body.items) ? body.items : null;
      if (!list || list.length === 0) return json(res, 400, { error: "empty-items" });
      if (list.length > MAX_BATCH) return json(res, 413, { error: "batch-too-large" });
      const rejected = [];
      let accepted = 0;
      for (const it of list) {
        if (!it || typeof it.id !== "string" || !ID_RE.test(it.id)) { rejected.push({ id: it && it.id, reason: "bad-id" }); continue; }
        const updatedAt = Number(it.updatedAt);
        if (!Number.isFinite(updatedAt)) { rejected.push({ id: it.id, reason: "bad-ts" }); continue; }
        const tombstone = it.tombstone === true;
        const data = typeof it.data === "string" ? it.data : "";
        if (!tombstone && (!data || Buffer.byteLength(data, "utf8") > MAX_ITEM_BYTES)) {
          rejected.push({ id: it.id, reason: "item-too-large" });
          continue;
        }
        const deviceId = typeof it.deviceId === "string" && it.deviceId.length <= 64 ? it.deviceId : "";
        const existing = doc.items[it.id];
        if (existing) {
          // 幂等：同 ts/同 deviceId/同 data → 无变化，不占新 seq
          if (existing.updatedAt === updatedAt && existing.deviceId === deviceId && existing.data === data && !!existing.tombstone === tombstone) {
            continue;
          }
          // 全序陈旧拒绝：(ts, deviceId) 与客户端 LWW 规则一致；旧版本不受理，杜绝双端推push干扰
          if (updatedAt < existing.updatedAt || (updatedAt === existing.updatedAt && deviceId <= existing.deviceId)) {
            rejected.push({ id: it.id, reason: "stale" });
            continue;
          }
        }
        doc.seq += 1;
        doc.items[it.id] = { id: it.id, updatedAt, deviceId, data, tombstone, seq: doc.seq };
        accepted += 1;
      }
      if (accepted > 0) await store.persist(cid);
      return json(res, 200, { accepted, rejected });
    }

    if (method === "GET" && p === "/v1/devices") {
      const list = Object.entries(doc.devices)
        .filter(([, d]) => !d.revoked)
        .map(([hash, d]) => ({
          tokenHash: hash,
          tokenTail: d.tokenTail,
          name: d.name,
          createdAt: d.createdAt,
          lastSeen: d.lastSeen,
          self: hash === session.hash,
        }));
      return json(res, 200, { devices: list });
    }

    if (method === "DELETE" && p === "/v1/device") {
      // 参数 tokenHash（服务端设备索引键，与信封内 deviceId 客户端 UUID 区分）
      const target = url.searchParams.get("tokenHash") || "";
      if (target && doc.devices[target]) {
        doc.devices[target].revoked = true; // 吊销（含自身：注销离场）
      }
      await store.persist(cid);
      // 被吊销设备之后的任何请求由 findSession 过滤 → 401（服务端行为，评审 P3-3）
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "not-found" });
  }

  const server = http.createServer((req, res) => {
    const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    handle(req, res, ip).catch((e) => {
      if (e && e.message === "body-too-large") return json(res, 413, { error: "body-too-large" });
      if (e && e.message === "bad-json") return json(res, 400, { error: "bad-json" });
      json(res, 500, { error: "internal" });
    });
  });
  return server;
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = { port: 8080, host: "0.0.0.0", dataDir: path.join(__dirname, "data") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = Number(argv[i + 1]);
    if (argv[i] === "--host") out.host = argv[i + 1];
    if (argv[i] === "--data-dir") out.dataDir = argv[i + 1];
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const cfg = parseArgs(process.argv.slice(2));
  const server = createSyncServer({ dataDir: cfg.dataDir });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`ToolCove sync server listening on http://${cfg.host}:${cfg.port} (data: ${cfg.dataDir})`);
    console.log("请务必通过 HTTPS 反向代理暴露（宝塔/Caddy/nginx），详见 server/README.md");
  });
}