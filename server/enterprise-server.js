#!/usr/bin/env node
// ToolCove 企业服务器（零依赖：node:http + node:crypto + node:fs）
//
// 为「企业版桌面客户端」提供工作数据存储与令牌鉴权。客户端契约写在
// src/platform/remoteStore.js 的文件头注释里，这里是它的服务端实现，两者必须一致：
//
//   POST /v1/auth/ping            Authorization: Bearer <token>
//     → 200 { ok: true, name }     name 为令牌绑定的工作区/席位显示名
//     → 401                        令牌缺失或无效
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
// 令牌从 tokens 文件读取（默认 <data-dir>/tokens.json）：[ { token, name, role } ]。
// 首次启动若文件不存在，自动签发一个管理员令牌并打印——私有化部署时把它填进客户端设置页。
//
// 启动：node server/enterprise-server.js [--port 8787] [--data-dir ./enterprise-data] [--host 0.0.0.0]
// 生产要求 HTTPS 反向代理（内网部署同理），见 server/README.md。

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------- 常量 ----------
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 单键体积上限（客户端 413 契约的服务端侧）
const BODY_READ_LIMIT = 16 * 1024 * 1024; // 读请求体的硬上限，防止超大 body 撑爆内存
const RATE_LIMIT = 600; // 每个令牌的窗口内请求上限
const RATE_WINDOW_MS = 60 * 1000;
const TOKEN_BYTES = 24;

const now = () => Date.now();
const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

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

// ---------- 令牌 ----------
function genToken() {
  return "tc_" + crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/** 读令牌表；文件不存在时签发一个管理员令牌并落盘，返回 { tokens, created }。 */
function loadTokens(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    const tokens = list
      .filter((t) => t && typeof t.token === "string" && t.token)
      .map((t) => ({ token: t.token, name: String(t.name || "workspace"), role: String(t.role || "member") }));
    if (tokens.length) return { tokens, created: null };
  } catch {
    // 文件缺失或损坏：走下面的签名路径
  }
  const token = genToken();
  const entry = { token, name: "默认工作区", role: "admin" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tokens: [entry] }, null, 2));
  return { tokens: [entry], created: entry };
}

/**
 * 常数时间比对：先各自 sha256 再 timingSafeEqual（长度固定，避免长度差异泄露信息）。
 * 遍历全部令牌不提前返回——让"命中了第 0 个"和"没命中"耗时接近。
 */
function matchToken(tokens, presented) {
  const target = sha256Hex(String(presented || ""));
  let matched = null;
  for (const entry of tokens) {
    if (crypto.timingSafeEqual(Buffer.from(target), Buffer.from(sha256Hex(entry.token)))) matched = entry;
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
 * 创建企业服务器实例（不监听端口）：{ handler, kv, tokens }。
 * 拆出工厂是为了单测能直接拿到 handler 或用随机端口起服务。
 */
export function createEnterpriseServer({ dataDir, tokens, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const kv = new KvStore(path.join(dataDir, "kv"));
  const rates = new Map(); // token -> { count, since }

  function rateLimited(token) {
    const hit = rates.get(token);
    if (!hit || now() - hit.since > RATE_WINDOW_MS) {
      rates.set(token, { count: 1, since: now() });
      return false;
    }
    hit.count += 1;
    return hit.count > RATE_LIMIT;
  }

  const auth = (req) => {
    const header = String(req.headers.authorization || "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    return matchToken(tokens, bearer);
  };

  async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/v1/auth/ping" && req.method === "POST") {
      const entry = auth(req);
      if (!entry) return sendJson(res, 401, { ok: false, error: "unauthorized" });
      return sendJson(res, 200, { ok: true, name: entry.name });
    }

    if (pathname.startsWith("/v1/kv/")) {
      const entry = auth(req);
      if (!entry) return sendJson(res, 401, { ok: false, error: "unauthorized" });
      if (rateLimited(entry.token)) return sendJson(res, 429, { ok: false, error: "rate_limited" });
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

  return { handler, kv, tokens };
}

// ---------- 启动 ----------
function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, dataDir: path.resolve("enterprise-data"), host: "0.0.0.0", maxBytes: DEFAULT_MAX_BYTES };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") args.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (argv[i] === "--data-dir") args.dataDir = path.resolve(argv[++i]);
    else if (argv[i] === "--host") args.host = argv[++i];
    else if (argv[i] === "--max-bytes") args.maxBytes = Number(argv[++i]) || DEFAULT_MAX_BYTES;
  }
  return args;
}

export function startEnterpriseServer({ dataDir, port, host, maxBytes } = {}) {
  const tokensFile = path.join(dataDir, "tokens.json");
  const { tokens, created } = loadTokens(tokensFile);
  const server = http.createServer(createEnterpriseServer({ dataDir, tokens, maxBytes }).handler);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      if (created) {
        console.log(`已签发管理员令牌（请填入客户端设置页的「企业服务器」令牌栏）：\n  ${created.token}\n令牌表：${tokensFile}`);
      }
      resolve({ server, port: server.address().port, tokensFile, tokens, created });
    });
  });
}

// 直接执行时启动（被 import 时不自动监听，方便单测拿到工厂）
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const args = parseArgs(process.argv.slice(2));
  startEnterpriseServer(args).then(({ port }) => {
    console.log(`ToolCove 企业服务器已启动：http://localhost:${port}`);
    console.log(`数据目录：${args.dataDir}`);
  });
}
