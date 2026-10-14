#!/usr/bin/env node
// 照片存档网页版的「补头转发」：浏览器 → 这里 → 七牛。
//
// 为什么存在：七牛管理接口只认 Authorization 头（官方 SDK 唯一传法），而它的域名对浏览器
// 预检不放行。这个转发**只补头、不做签名、不落密钥**——AK/SK 留在浏览器里，页面签好后
// 把 { url, method, headers } 发过来，这里原样转发给白名单内的七牛域名。
//
// 跑法：node server/photo-relay.mjs [--port 8127]
// 部署说明与 Cloudflare Worker 版：docs/photo-relay.md
import { createServer } from "node:http";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : process.env.PORT) || 8127;

// 只转发给七牛的域名（防开放代理）；方法只放 GET/POST/HEAD
const ALLOWED_HOST = /(^|\.)qiniu(com|cs)?$|(^|\.)qbox\.me$|(^|\.)qiniuio\.com$|(^|\.)qiniucs\.com$/;
const ALLOWED_METHOD = /^(GET|POST|HEAD)$/

const server = createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, cors);
    res.end("POST only");
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let job;
    try {
      job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, cors);
      res.end("bad json");
      return;
    }
    let target;
    try {
      target = new URL(String(job.url || ""));
    } catch {
      res.writeHead(400, cors);
      res.end("bad url");
      return;
    }
    const method = String(job.method || "GET").toUpperCase();
    if (!ALLOWED_HOST.test(target.hostname) || !ALLOWED_METHOD.test(method)) {
      res.writeHead(403, cors);
      res.end("forbidden");
      return;
    }
    // 只透传这两个头：其余（Cookie 等）一律丢弃，转发器不碰任何多余信息
    const headers = {};
    for (const [name, value] of Object.entries(job.headers || {})) {
      if (/^authorization$|^content-type$/i.test(name) && value) headers[name] = value;
    }
    const upstream = fetch(target.href, { method, headers })
      .then((response) => response.text().then((body) => ({ status: response.status, body })))
      .then(({ status, body }) => {
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ status, body }));
      })
      .catch((error) => {
        res.writeHead(502, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: 502, body: String(error?.message || error) }));
      });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`photo relay listening on http://127.0.0.1:${port}`);
});
