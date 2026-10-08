// 架构决策验证（第 2 版）：网页上下文能否用 **WebSocket** 连上 CDP。
//
// 上一版已经确认：页面用 fetch 访问 CDP 的 HTTP 端点会被 CORS 挡死（Failed to fetch），
// 即使启动时加了 --remote-allow-origins=*。所以 target 清单必须由 Rust 侧查好再传给前端。
//
// 现在只剩最后一个未知数：WebSocket 能不能连。这决定了抓包逻辑放前端还是搬去 Rust。
// 方法：Node（无 Origin 限制）先查到页面 target 的 ws 地址，注入页面，页面自己连。
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PAGE_PORT = 39202;
const DEBUG_PORT = 39402;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pageHtml = "";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(pageHtml);
});
await new Promise((r) => server.listen(PAGE_PORT, "127.0.0.1", r));

const profile = mkdtempSync(path.join(tmpdir(), "cdp-ws-"));
const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--remote-allow-origins=*",   // 没有这个，带 Origin 的 WS 会被拒
  `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

let result = null;
try {
  // 等调试端口就绪
  let targets = [];
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      if (targets.length) break;
    } catch {}
  }
  const t = targets.find((x) => x.type === "page");
  if (!t) throw new Error("没有 page target");
  console.log(`Node 侧查到的 target: ${t.id}`);

  // 页面：只做一件事——用带 Origin 的 WebSocket 连 CDP
  pageHtml = `<!doctype html><meta charset="utf-8"><script>
window.__wsResult = (async () => {
  const out = { origin: location.origin, wsUrl: '${t.webSocketDebuggerUrl}' };
  try {
    const ws = new WebSocket(out.wsUrl);
    out.state = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 8000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve('open'); }, {once:true});
      ws.addEventListener('error', () => { clearTimeout(timer); resolve('error'); }, {once:true});
      ws.addEventListener('close', () => { clearTimeout(timer); resolve('closed'); }, {once:true});
    });
    if (out.state !== 'open') return out;
    ws.send(JSON.stringify({id:1, method:'Network.enable', params:{}}));
    out.networkEnable = await new Promise((resolve) => {
      const t2 = setTimeout(() => resolve('timeout'), 8000);
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(String(e.data));
        if (m.id === 1) { clearTimeout(t2); resolve(m.error ? 'err: ' + m.error.message : 'ok'); }
      });
    });
    ws.close();
  } catch (e) { out.state = 'throw: ' + String(e); }
  return out;
})();
</script>`;

  // 让页面加载刚才那份 HTML
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?http://127.0.0.1:${PAGE_PORT}/page`, { method: "PUT" }).catch(() => {});
  await sleep(5000);

  // 读页面结果
  targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const pageTarget = targets.find((x) => x.url.includes(`:${PAGE_PORT}`));
  if (!pageTarget) throw new Error("页面 target 未出现");
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, {once:true}); ws.addEventListener("error", rej, {once:true}); });
  ws.send(JSON.stringify({ id: 99, method: "Runtime.evaluate", params: { expression: "window.__wsResult", awaitPromise: true, returnByValue: true } }));
  const raw = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 12000);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id === 99) { clearTimeout(timer); resolve(m.result?.result?.value); }
    });
  });
  ws.close();
  result = raw ?? null;   // returnByValue:true 直接给对象，不要再 JSON.parse
} catch (err) {
  result = { error: err.message };
} finally {
  try { proc.kill(); } catch {}
  server.close();
}

console.log("=== 页面内 WebSocket 连 CDP 的结果 ===");
console.log(JSON.stringify(result, null, 2));
const ok = result && result.state === "open" && result.networkEnable === "ok";
console.log(`\n结论: ${ok
  ? "✅ WebSocket 可用 → 抓包逻辑放前端；target 清单由 Rust 侧查好传入即可"
  : "❌ WebSocket 受限 → 抓包需整体搬到 Rust 侧"}`);
process.exit(ok ? 0 : 1);