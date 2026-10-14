#!/usr/bin/env node
// ToolCove 企业服务器（零依赖：node:http + node:crypto + node:fs）
//
// 为「企业版桌面客户端」提供工作数据存储、令牌鉴权与成员/席位管理。客户端契约写在
// src/platform/remoteStore.js 的文件头注释里，这里是它的服务端实现，两者必须一致：
//
//   POST /v1/auth/ping            Authorization: Bearer <token>
//     → 200 { ok: true, name, role }   name 为成员显示名，role 为 admin | member
//     → 401                            令牌缺失或无效
//
//   GET  /v1/kv/<key>             Authorization: Bearer <token>
//     → 200 { data }               键存在
//     → 404                        键不存在（客户端映射为 load_data 的空值约定 []）
//     → 401                        令牌无效
//
//   PUT  /v1/kv/<key>             Authorization: Bearer <token>，Content-Type: application/json
//     Body: { data }
//     → 200 { ok: true }
//     → 401                        令牌无效
//     → 413                        数据超过体积上限
//
//   GET    /v1/members            Authorization: Bearer <token>（admin）
//     → 200 { members: [{ id, name, role, createdAt }] }
//     → 401                        令牌无效
//     → 403                        非 admin
//
//   POST   /v1/members            Authorization: Bearer <token>（admin），Body: { name, role? }
//     → 201 { member: { id, name, role, createdAt }, token }   令牌只在此刻返回一次
//     → 400                        name 缺失
//     → 401 / 403
//     → 409 { ok: false, error: "seat_limit" }  超过席位配额
//
//   DELETE /v1/members/<id>       Authorization: Bearer <token>（admin）
//     → 200 { ok: true }
//     → 400 { ok: false, error: "cannot_revoke_self" }  试图删除自己
//     → 401 / 403
//     → 404                        成员不存在
//
// 成员落 members.json（默认 <data-dir>/members.json）：{ members: [{ id, name, role, tokenHash, createdAt }] }。
// tokenHash 是令牌的 sha256——服务端不存明文令牌，令牌只在创建响应里出现一次，之后不可取回。
// 旧版 tokens.json 会在启动时自动迁移成 members.json（保留原文件不动），两者都没有时首次启动
// 签发一个管理员成员并打印令牌——私有化部署时把它填进客户端设置页。
//
// 启动：node server/enterprise-server.js [--port 8787] [--data-dir ./enterprise-data] [--host 0.0.0.0] [--seats 0]
// 生产要求 HTTPS 反向代理（内网部署同理），见 server/README.md。

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------- 常量 ----------
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 单键体积上限（客户端 413 契约的服务端侧）
const BODY_READ_LIMIT = 16 * 1024 * 1024; // 读请求体的硬上限，防止超大 body 撑爆内存
const RATE_LIMIT = 600; // 每个成员的窗口内请求上限
const RATE_WINDOW_MS = 60 * 1000;
const TOKEN_BYTES = 24;
const DEFAULT_SEATS = 0; // 席位上限，0 = 不限
const MEMBER_BODY_LIMIT = 64 * 1024; // 成员创建请求体很小，单独设上限，避免为大 body 白白缓冲内存

const now = () => Date.now();
const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** 读 JSON 文件；缺失/损坏一律当作 null（调用方各自决定回退策略）。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------- 存储 ----------
// 每个键一个文件：文件名用 sha256(key)，避免键里的特殊字符/路径穿越落到文件系统上。
// 文档内保留原始 key，便于排查（键名可读，但从不参与路径拼接）。
class KvStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.writes = Promise.resolve();
  }
  file(key) { return path.join(this.dir, sha256Hex(key) + ".json"); }
  read(key) {
    try {
      return JSON.parse(fs.readFileSync(this.file(key), "utf8"));
    } catch {
      return null;
    }
  }
  /** 原子写：写临时文件再 rename，避免读到半截 JSON（与 sync-server 同一套路）。 */
  write(key, data) {
    const doc = { key, data, updatedAt: now() };
    const tmp = this.file(key) + ".tmp";
    const final = this.file(key);
    const write = this.writes.then(() => new Promise((resolve, reject) => {
      fs.writeFile(tmp, JSON.stringify(doc), (err) => {
        if (err) return reject(err);
        fs.rename(tmp, final, (err2) => (err2 ? reject(err2) : resolve()));
      });
    }));
    // 写链必须吃掉这次失败：否则一次磁盘错误之后 this.writes 永久 rejected，后续写入全被顶替。
    this.writes = write.catch(() => {});
    return write;
  }
}

// ---------- 成员 ----------
/**
 * 成员表：<data-dir>/members.json，形如
 *   { members: [{ id, name, role, tokenHash, createdAt, lastSeenAt? }] }。
 * 只落 tokenHash（令牌的 sha256），不落明文——令牌仅在创建响应里出现一次，之后不可取回；
 * 即便 members.json 泄露也无法反推令牌。file 为 null 时是纯内存实例（单测用，不落盘）。
 */
class MembersStore {
  constructor(file, members = []) {
    this.file = file;
    this.members = members;
    this.writes = Promise.resolve(); // 与 KvStore 同一套路：写串行化，一次失败不毒化后续写
    this.lastTouchSave = 0;
  }
  /** 原子写：tmp + rename；与 KvStore/增删共用同一写队列，避免并发写互相覆盖。 */
  save() {
    if (!this.file) return Promise.resolve();
    const tmp = this.file + ".tmp";
    const final = this.file;
    const write = this.writes.then(() => new Promise((resolve, reject) => {
      // 在队列里即时序列化：写入的一定是提交那一刻的最新成员表（touch/add/remove 都走这条链）
      fs.mkdirSync(path.dirname(final), { recursive: true });
      fs.writeFile(tmp, JSON.stringify({ members: this.members }, null, 2), (err) => {
        if (err) return reject(err);
        fs.rename(tmp, final, (err2) => (err2 ? reject(err2) : resolve()));
      });
    }));
    this.writes = write.catch(() => {});
    return write;
  }
  /** 命中令牌后记录 lastSeenAt。高频 ping 不必每次都落盘：合并成 ≤1 次/秒的写（走同一队列）。 */
  touch(member) {
    if (!member) return;
    member.lastSeenAt = now();
    if (now() - this.lastTouchSave < 1000) return;
    this.lastTouchSave = now();
    this.save().catch(() => {});
  }
}

const toMemberView = (m) => ({ id: m.id, name: m.name, role: m.role, createdAt: m.createdAt });

/** 归一化单条成员记录（容错缺失字段，并强约束 role 取值）。 */
function normalizeMember(raw) {
  const member = {
    id: String(raw?.id || "") || crypto.randomUUID(),
    name: String(raw?.name || "workspace"),
    role: raw?.role === "admin" ? "admin" : "member",
    tokenHash: String(raw?.tokenHash || ""),
    createdAt: Number(raw?.createdAt) || now(),
  };
  if (raw?.lastSeenAt) member.lastSeenAt = Number(raw.lastSeenAt);
  return member;
}

/** 把内存数组归一化成成员表；兼容带明文 token 的条目（工厂单测便利），自动转成 tokenHash。 */
function normalizeMembers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => {
      if (!m) return null;
      const tokenHash = m.tokenHash ? String(m.tokenHash) : (m.token ? sha256Hex(String(m.token)) : "");
      return tokenHash ? normalizeMember({ ...m, tokenHash }) : null;
    })
    .filter(Boolean);
}

/**
 * 加载成员表，返回 { store, created, membersFile, migrated }。
 * 迁移/回退顺序（members.json 与 tokens.json 并存时以 members.json 为准）：
 *   1. members.json 有 ≥1 条有效成员 → 直接用，忽略 tokens.json。
 *   2. 否则 tokens.json 有 ≥1 条旧令牌 → 迁移成 members.json（明文 token → tokenHash，
 *      id 用 randomUUID，createdAt 用当前时间）；**保留 tokens.json 不动**——那是用户文件，
 *      迁移异常或需要回滚时还能兜底，只在日志里说明。
 *   3. 两者都没有 → 签发一个 admin 成员并待落盘，返回 created（用于打印令牌）。
 */
function loadMembers(dataDir) {
  const membersFile = path.join(dataDir, "members.json");
  const tokensFile = path.join(dataDir, "tokens.json");

  const parsedMembers = readJson(membersFile);
  const members = Array.isArray(parsedMembers?.members)
    ? parsedMembers.members.filter((m) => m && m.tokenHash).map(normalizeMember)
    : [];
  if (members.length) return { store: new MembersStore(membersFile, members), created: null, membersFile, migrated: 0 };

  const parsedTokens = readJson(tokensFile);
  const legacy = Array.isArray(parsedTokens?.tokens)
    ? parsedTokens.tokens.filter((t) => t && typeof t.token === "string" && t.token)
    : [];
  if (legacy.length) {
    const migratedMembers = legacy.map((t) => ({
      id: crypto.randomUUID(),
      name: String(t.name || "workspace"),
      role: t.role === "admin" ? "admin" : "member",
      tokenHash: sha256Hex(t.token),
      createdAt: now(),
    }));
    return { store: new MembersStore(membersFile, migratedMembers), created: null, membersFile, migrated: migratedMembers.length };
  }

  const token = genToken();
  const member = { id: crypto.randomUUID(), name: "默认工作区", role: "admin", tokenHash: sha256Hex(token), createdAt: now() };
  return { store: new MembersStore(membersFile, [member]), created: { ...member, token }, membersFile, migrated: 0 };
}

// ---------- 令牌 ----------
function genToken() {
  return "tc_" + crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * 常数时间比对：presented 先 sha256，再与各成员的 tokenHash 逐字节 timingSafeEqual 比对。
 * 遍历全部成员不提前返回——让"命中了第 0 个"和"没命中"耗时接近。脏数据（长度不是 64 位
 * 十六进制的 tokenHash）无法进 timingSafeEqual，跳过但仍参与遍历。
 */
function matchToken(members, presented) {
  const target = Buffer.from(sha256Hex(String(presented || "")), "hex"); // sha256 → 32 字节
  let matched = null;
  for (const m of members) {
    const hex = String(m.tokenHash || "");
    if (!/^[0-9a-f]{64}$/.test(hex)) continue;
    if (crypto.timingSafeEqual(Buffer.from(hex, "hex"), target)) matched = m;
  }
  return matched;
}

// ---------- HTTP ----------
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 创建企业服务器实例（不监听端口）：{ handler, kv, members, store }。
 * 拆出工厂是为了单测能直接拿到 handler 或用随机端口起服务。
 * members 可传数组（单测便利，会归一化成内存成员表）或 MembersStore 实例。
 */
export function createEnterpriseServer({ dataDir, members, maxBytes = DEFAULT_MAX_BYTES, seats = DEFAULT_SEATS } = {}) {
  const kv = new KvStore(path.join(dataDir, "kv"));
  const store = members instanceof MembersStore ? members : new MembersStore(null, normalizeMembers(members));
  const memberList = store.members;
  const rates = new Map(); // 成员 id -> { count, since }

  function rateLimited(id) {
    const hit = rates.get(id);
    if (!hit || now() - hit.since > RATE_WINDOW_MS) {
      rates.set(id, { count: 1, since: now() });
      return false;
    }
    hit.count += 1;
    return hit.count > RATE_LIMIT;
  }

  // 鉴权：命中即顺带记 lastSeenAt（走成员表写队列，不阻塞请求）
  const auth = (req) => {
    const header = String(req.headers.authorization || "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const member = matchToken(memberList, bearer);
    if (member) store.touch(member);
    return member;
  };

  async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/v1/auth/ping" && req.method === "POST") {
      const entry = auth(req);
      if (!entry) return sendJson(res, 401, { ok: false, error: "unauthorized" });
      return sendJson(res, 200, { ok: true, name: entry.name, role: entry.role });
    }

    // 成员/席位管理：仅 admin。先 401（无/错令牌）再 403（非 admin），避免用 403 泄露令牌有效性。
    if (pathname === "/v1/members" || pathname.startsWith("/v1/members/")) {
      const me = auth(req);
      if (!me) return sendJson(res, 401, { ok: false, error: "unauthorized" });
      if (me.role !== "admin") return sendJson(res, 403, { ok: false, error: "forbidden" });

      if (pathname === "/v1/members") {
        if (req.method === "GET") {
          // 列表只回 id/name/role/createdAt，绝不回 tokenHash（令牌不可取回）
          return sendJson(res, 200, { members: memberList.map(toMemberView) });
        }
        if (req.method === "POST") {
          let raw;
          try {
            raw = await readBody(req, MEMBER_BODY_LIMIT);
          } catch (error) {
            if (error?.code === "TOO_LARGE") return sendJson(res, 413, { ok: false, error: "too_large" });
            return sendJson(res, 400, { ok: false, error: "bad_request" });
          }
          let parsed;
          try {
            parsed = JSON.parse(raw || "null");
          } catch {
            return sendJson(res, 400, { ok: false, error: "invalid_json" });
          }
          const name = parsed && typeof parsed.name === "string" ? parsed.name.trim() : "";
          if (!name) return sendJson(res, 400, { ok: false, error: "missing_name" });
          // 席位语义：约束全部成员总数（含 admin）。admin 也占一个真实席位——
          // 把"我能管几个人"和"实际几个人在用"对齐，避免出现 admin 不计数导致的账实不符。
          if (seats > 0 && memberList.length >= seats) return sendJson(res, 409, { ok: false, error: "seat_limit" });

          const token = genToken();
          const member = {
            id: crypto.randomUUID(),
            name,
            role: parsed.role === "admin" ? "admin" : "member", // 默认 member
            tokenHash: sha256Hex(token),
            createdAt: now(),
          };
          memberList.push(member);
          try {
            await store.save();
          } catch {
            memberList.pop(); // 没落盘成功就别留在内存里，保证内存态与磁盘态一致
            return sendJson(res, 500, { ok: false, error: "write_failed" });
          }
          // 令牌只在此刻返回一次，之后任何接口都不再提供
          return sendJson(res, 201, { member: toMemberView(member), token });
        }
        return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      }

      // /v1/members/<id>：仅 DELETE
      if (req.method !== "DELETE") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      const id = decodeURIComponent(pathname.slice("/v1/members/".length));
      if (id === me.id) return sendJson(res, 400, { ok: false, error: "cannot_revoke_self" });
      const idx = memberList.findIndex((m) => m.id === id);
      if (idx < 0) return sendJson(res, 404, { ok: false, error: "not_found" });
      const [removed] = memberList.splice(idx, 1);
      try {
        await store.save();
      } catch {
        memberList.splice(idx, 0, removed); // 落盘失败则回滚，避免成员"假删除"
        return sendJson(res, 500, { ok: false, error: "write_failed" });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (pathname.startsWith("/v1/kv/")) {
      const entry = auth(req);
      if (!entry) return sendJson(res, 401, { ok: false, error: "unauthorized" });
      if (rateLimited(entry.id)) return sendJson(res, 429, { ok: false, error: "rate_limited" });
      const key = decodeURIComponent(pathname.slice("/v1/kv/".length));
      if (!key) return sendJson(res, 400, { ok: false, error: "missing_key" });

      if (req.method === "GET") {
        const doc = kv.read(key);
        if (!doc) return sendJson(res, 404, { ok: false, error: "not_found" });
        return sendJson(res, 200, { data: doc.data });
      }

      if (req.method === "PUT") {
        let raw;
        try {
          raw = await readBody(req, Math.min(BODY_READ_LIMIT, maxBytes + 4096));
        } catch (error) {
          if (error?.code === "TOO_LARGE") return sendJson(res, 413, { ok: false, error: "too_large" });
          return sendJson(res, 400, { ok: false, error: "bad_request" });
        }
        let parsed;
        try {
          parsed = JSON.parse(raw || "null");
        } catch {
          return sendJson(res, 400, { ok: false, error: "invalid_json" });
        }
        const data = parsed && typeof parsed === "object" && Object.hasOwn(parsed, "data") ? parsed.data : null;
        const bytes = Buffer.byteLength(JSON.stringify(data ?? null));
        if (bytes > maxBytes) return sendJson(res, 413, { ok: false, error: "too_large" });
        try {
          await kv.write(key, data ?? null);
        } catch {
          return sendJson(res, 500, { ok: false, error: "write_failed" });
        }
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  }

  return { handler, kv, members: memberList, store };
}

// ---------- 启动 ----------
function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, dataDir: path.resolve("enterprise-data"), host: "0.0.0.0", maxBytes: DEFAULT_MAX_BYTES, seats: DEFAULT_SEATS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") args.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (argv[i] === "--data-dir") args.dataDir = path.resolve(argv[++i]);
    else if (argv[i] === "--host") args.host = argv[++i];
    else if (argv[i] === "--max-bytes") args.maxBytes = Number(argv[++i]) || DEFAULT_MAX_BYTES;
    else if (argv[i] === "--seats") args.seats = Number(argv[++i]) || 0; // 显式负值/非法一律按"不限"处理
  }
  return args;
}

export function startEnterpriseServer({ dataDir, port, host, maxBytes, seats } = {}) {
  const { store, created, membersFile, migrated } = loadMembers(dataDir);
  const server = http.createServer(createEnterpriseServer({ dataDir, members: store, maxBytes, seats }).handler);
  return (async () => {
    // 先把初始成员表落盘（新建/迁移），再开始监听：避免首批请求命中尚未持久化的内存态
    await store.save().catch(() => {});
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        if (migrated) {
          console.log(`已从旧令牌表（tokens.json）迁移 ${migrated} 条成员到成员表；原文件保留未改动：\n  ${membersFile}`);
        }
        if (created) {
          console.log(`已签发管理员令牌（请填入客户端设置页的「企业服务器」令牌栏）：\n  ${created.token}\n成员表：${membersFile}`);
        }
        resolve({ server, port: server.address().port, membersFile, members: store.members, store, created, migrated });
      });
    });
  })();
}

// 直接执行时启动（被 import 时不自动监听，方便单测拿到工厂）
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const args = parseArgs(process.argv.slice(2));
  startEnterpriseServer(args).then(({ port }) => {
    console.log(`ToolCove 企业服务器已启动：http://localhost:${port}`);
    console.log(`数据目录：${args.dataDir}`);
  });
}
