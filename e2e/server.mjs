// E2E 静态服务器：只用 node:http 提供 dist/ 静态文件（不引第三方依赖）。
// 为什么不用 vite preview：E2E 的 webServer 直接 spawn 这个脚本更可控（端口固定、日志可读），
// 也避免 preview 在 CI 上多起一个 vite 进程。
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(process.argv[2] || "dist");
const PORT = Number(process.env.E2E_PORT || 4321);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** 把请求路径映射到磁盘路径；越界（../）一律拒绝。 */
function resolveTarget(urlPath) {
  const clean = decodeURIComponent(String(urlPath).split("?")[0].split("#")[0]);
  const rel = normalize(clean).replace(/^([/\\])+/, "");
  const target = join(ROOT, rel);
  if (!target.startsWith(ROOT)) return null;
  return target;
}

const server = createServer(async (req, res) => {
  try {
    let target = resolveTarget(req.url || "/");
    if (!target) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      target = join(target, "index.html");
      info = await stat(target).catch(() => null);
    }
    if (!info?.isFile()) {
      // SPA：未知路径回落到 index.html（应用是单页 + 哈希/状态导航）
      target = join(ROOT, "index.html");
      info = await stat(target).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
      // wasm 走 fetch 时需要正确的 MIME，qpdf-wasm 才有机会被流式编译
      "cross-origin-opener-policy": "same-origin",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500).end(String(error?.message || error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[e2e-server] http://127.0.0.1:${PORT} 服务 ${ROOT}`);
});
