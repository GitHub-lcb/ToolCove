/* eslint-disable */
// Node 侧抓包挂钩（CommonJS，不能用 ESM —— 它要被 --require 加载进目标进程）。
//
// 为什么需要它：Electron 应用的主进程（Node 侧）发出的请求，CDP 的页面级调试
// **看不到**。实测 WorkBuddy 的积分接口就是这样：渲染进程的 16 条启动请求全抓到了，
// /billing/ 一条都没有，而它用的是 axios + undici（纯 Node 生态）。
//
// 这是 HTTP Toolkit 那一派的做法：不靠系统代理、不装根证书，而是**按运行时注入**，
// 把 http/https/fetch 挂上钩子。影响面只限于这一个进程。
//
// 三条铁律：
//   1. **绝不能弄坏目标应用**。任何一步出错都吞掉，并把原始实现原样用回去。
//   2. 只写文件，不联网、不改请求。它是观察者，不是中间人。
//   3. 写盘用追加的 NDJSON，工具那边按行增量读。
"use strict";

// 整体包在 IIFE 里：CommonJS 的模块包装器允许顶层 return，但 ESLint 按模块解析会报
// 「'return' outside of function」——解析错误不受 eslint-disable 注释约束，只能改结构。
(function () {
const fs = require("fs");
const path = require("path");

const OUT = process.env.NETCAPTURE_OUT;
if (!OUT) return;

let stream = null;
try {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  stream = fs.createWriteStream(OUT, { flags: "a" });
} catch {
  stream = null;
}

const MAX_BODY = 64 * 1024;

function truncate(text) {
  if (typeof text !== "string") return text;
  if (text.length <= MAX_BODY) return text;
  return text.slice(0, MAX_BODY) + `…（已截断，原文 ${text.length} 字符）`;
}

function emit(record) {
  if (!stream) return;
  try {
    record.at = Date.now();
    record.source = "node";
    stream.write(JSON.stringify(record) + "\n");
  } catch {
    // 写不进去就算了，绝不能因此影响目标应用
  }
}

/** 头对象里可能有数组值、Symbol 之类，统一成字符串，避免 JSON.stringify 炸掉。 */
function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  try {
    if (Array.isArray(headers)) {
      // fetch 的 Headers 实例或 [[k,v]] 数组
      const entries = typeof headers.entries === "function" ? [...headers.entries()] : headers;
      for (const [k, v] of entries) out[String(k)] = String(v);
      return out;
    }
    if (typeof headers.forEach === "function" && typeof headers.get === "function") {
      headers.forEach((v, k) => { out[String(k)] = String(v); });
      return out;
    }
    if (typeof headers.raw === "function") {
      const raw = headers.raw();
      for (const [k, v] of Object.entries(raw)) out[String(k)] = Array.isArray(v) ? v.join(", ") : String(v);
      return out;
    }
    for (const [k, v] of Object.entries(headers)) out[String(k)] = Array.isArray(v) ? v.join(", ") : String(v);
  } catch {
    // 读不出来的头直接丢掉，不影响主体信息
  }
  return out;
}

// ── 挂 http / https ─────────────────────────────────────────────────────────
function patchModule(mod, scheme) {
  if (!mod || typeof mod.request !== "function") return;
  const originalRequest = mod.request;

  function patched(...callArgs) {
    let record = null;
    try {
      // request 有两种调用形态：request(options[, cb]) 和 request(url[, options][, cb])
      let options = callArgs[0];
      const callback = callArgs.find((a) => typeof a === "function");
      if (typeof options === "string" || options instanceof URL) {
        const urlObj = new URL(String(options));
        const extra = typeof callArgs[1] === "object" && callArgs[1] ? callArgs[1] : {};
        options = { ...extra, protocol: urlObj.protocol, hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname + urlObj.search };
      }
      options = options && typeof options === "object" ? options : {};
      const host = options.hostname || options.host || "unknown";
      const port = options.port ? `:${options.port}` : "";
      const reqPath = options.path || options.pathname || "/";
      const url = `${scheme}//${host}${port}${reqPath}`;

      record = {
        method: String(options.method || "GET").toUpperCase(),
        url,
        requestHeaders: headersToObject(options.headers),
        requestBody: null,
        status: 0,
        responseHeaders: {},
        responseBody: null,
        chunks: [],
      };
    } catch {
      record = null;
    }

    const req = originalRequest.apply(this, callArgs);

    if (!record) return req;

    // 请求体：拦截 write/end，只记录不改写
    try {
      const originalWrite = req.write;
      const originalEnd = req.end;
      req.write = function (chunk, ...rest) {
        try { if (chunk) record.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)); } catch {}
        return originalWrite.apply(this, [chunk, ...rest]);
      };
      req.end = function (chunk, ...rest) {
        try { if (chunk && typeof chunk !== "function") record.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)); } catch {}
        return originalEnd.apply(this, [chunk, ...rest]);
      };
    } catch {}

    try {
      req.on("response", (res) => {
        try {
          record.status = res.statusCode || 0;
          record.responseHeaders = headersToObject(res.headers);
          const parts = [];
          res.on("data", (chunk) => {
            try { parts.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)); } catch {}
          });
          res.on("end", () => {
            try {
              record.requestBody = record.chunks.length ? truncate(record.chunks.join("")) : null;
              delete record.chunks;
              const raw = parts.join("");
              record.responseBody = truncate(raw);
              // 能当 JSON 解析就给结构化结果，工具那边好做字段推断
              try { record.responseBody = JSON.parse(raw); } catch {}
              emit(record);
            } catch {}
          });
        } catch {}
      });
      req.on("error", (err) => {
        try {
          record.error = String(err && err.message ? err.message : err);
          delete record.chunks;
          emit(record);
        } catch {}
      });
    } catch {}

    return req;
  }

  try {
    mod.request = patched;
    mod.get = function (...args) {
      const req = patched.apply(this, args);
      try { req.end(); } catch {}
      return req;
    };
  } catch {}
}

try { patchModule(require("http"), "http:"); } catch {}
try { patchModule(require("https"), "https:"); } catch {}

// ── 挂 fetch ────────────────────────────────────────────────────────────────
try {
  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      let record = null;
      try {
        const url = typeof input === "string" ? input : (input && input.url) || String(input);
        const headers = (init && init.headers) || (input && input.headers);
        record = {
          method: String((init && init.method) || (input && input.method) || "GET").toUpperCase(),
          url: /^https?:/i.test(url) ? url : null,
          requestHeaders: headersToObject(headers),
          requestBody: init && typeof init.body === "string" ? truncate(init.body) : null,
          status: 0,
          responseHeaders: {},
          responseBody: null,
        };
      } catch {
        record = null;
      }
      const promise = originalFetch.apply(this, arguments);
      if (!record || !record.url) return promise;
      return promise.then((res) => {
        try {
          record.status = res.status;
          record.responseHeaders = headersToObject(res.headers);
          // clone 一份读体，不动原来的响应
          res.clone().text().then((text) => {
            try {
              record.responseBody = truncate(text);
              try { record.responseBody = JSON.parse(text); } catch {}
            } catch {}
            emit(record);
          }).catch(() => emit(record));
        } catch {
          emit(record);
        }
        return res;
      });
    };
  }
} catch {}
})();
