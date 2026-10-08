// CDP 抓包核心的端到端验证：起本地服务 + Chrome headless，走完整链路抓请求，
// 断言 method / url / 头 / POST 体 / 响应体 / 状态码全对得上。
//
// 两个踩过的坑都固化在注释里，别改回去：
//  1) 页面必须用 http:// 提供。data: URL 的页面是不透明源，fetch 被当跨源直接拦掉，
//     表现为 Network.loadingFailed，服务器从头到尾收不到请求，测出来是「抓到 0 条」
//     但真因是测试页自己废了。加了 servedHits 对照组专门盯这个。
//  2) 已存在的 target 必须逐个直连 WebSocket，靠浏览器级 autoAttach 补发不上。
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitForEndpoint, startCapture } from "../src/tools/netcapture/cdp.js";

const API_PORT = 39117;
const PAGE_PORT = 39118;
const DEBUG_PORT = 39411;

let servedHits = 0;
const apiServer = http.createServer((req, res) => {
  // 必须回 CORS 头：页面在 39118、接口在 39117，属于跨源。缺了会被浏览器直接拦掉
  // （POST 带 application/json 还会先发预检），表现为「服务端只收到一次 OPTIONS、
  // 真正请求根本没发出」。这里顺带把预检也答掉。
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Cookie,Authorization",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
  servedHits++;
  res.writeHead(200, { ...cors, "Content-Type": "application/json", "Set-Cookie": "sid=SHOULD_BE_REDACTED" });
  res.end(JSON.stringify({ code: 0, data: { checkedToday: true, points: 100 }, message: "ok" }));
});

// 页面不能一加载就发请求：抓包工具是在页面起来之后才连上 Network 域的，
// 内联脚本立刻 fetch 的话第一条必然抓不到（实测只抓到后面那条）。
// 改成轮询 /fire，测试端置位 fireFlag 后页面才动作，把「工具已就绪」和
// 「请求发出」的先后顺序固定住。
let fireFlag = false;

const pageHtml = `<!doctype html><meta charset="utf-8"><script>
window.__fire = async () => {
  await fetch('http://127.0.0.1:${API_PORT}/api/checkin/do', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': 'sid=SHOULD_BE_REDACTED',
      'Authorization': 'Bearer SECRET-TOKEN',
    },
    body: JSON.stringify({ date: '2026-10-01' }),
  });
  await fetch('http://127.0.0.1:${API_PORT}/api/status?tz=cn');
};
const poll = setInterval(async () => {
  try {
    const r = await fetch('/fire');
    if (r.status === 200) { clearInterval(poll); await window.__fire(); }
  } catch {}
}, 200);
</script>`;

const pageServer = http.createServer((req, res) => {
  if (req.url === "/fire") {
    if (!fireFlag) { res.writeHead(204).end(); return; }
    fireFlag = false;
    res.writeHead(200, { "Content-Type": "text/plain" }).end("fire");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(pageHtml);
});

await new Promise((r) => apiServer.listen(API_PORT, "127.0.0.1", r));
await new Promise((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", r));

const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = mkdtempSync(path.join(tmpdir(), "cdp-verify-"));
const proc = spawn(chrome, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  `http://127.0.0.1:${PAGE_PORT}/page`,
], { stdio: "ignore" });

const captured = [];
let failure = null;
try {
  const info = await waitForEndpoint(DEBUG_PORT, { timeoutMs: 30000 });
  console.log(`已连上: ${info.Browser}`);

  const cap = await startCapture({
    port: DEBUG_PORT,
    urlFilter: new RegExp(`127\\.0\\.0\\.1:${API_PORT}`),
    captureBodies: true,
    onRequest: (r) => captured.push(r),
  });

  console.log(`已附加到 ${cap.targetCount} 个 target，置位触发…`);
  fireFlag = true;

  const deadline = Date.now() + 25000;
  while (captured.length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  cap.stop();
} catch (err) {
  failure = err;
} finally {
  try { proc.kill(); } catch {}
  apiServer.close();
  pageServer.close();
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 300);
}

if (failure) {
  console.error("抓包失败:", failure.message);
  process.exit(1);
}

console.log(`对照组：接口服务器被访问 ${servedHits} 次`);
if (servedHits < 2) {
  console.error("请求没发出去，测试本身失效。");
  process.exit(1);
}

console.log(`\n抓到 ${captured.length} 条:`);
for (const r of captured) {
  console.log(`\n  ${r.method} ${r.host}${r.path} -> HTTP ${r.status} [${r.type}]`);
  console.log(`    请求头: ${JSON.stringify(r.requestHeaders)}`);
  console.log(`    响应头: ${JSON.stringify(r.responseHeaders)}`);
  console.log(`    请求体: ${JSON.stringify(r.requestBody)}`);
  console.log(`    响应体: ${JSON.stringify(r.responseBody)}`);
}

const post = captured.find((r) => r.method === "POST");
const get = captured.find((r) => r.method === "GET");

const checks = [];
const check = (name, cond) => checks.push([name, !!cond]);
check("抓到 POST", !!post);
check("POST 状态码 200", post?.status === 200);
check("POST host 正确", post?.host === `127.0.0.1:${API_PORT}`);
check("POST path 带完整路径", post?.path === "/api/checkin/do");
check("POST origin 正确", post?.origin === `http://127.0.0.1:${API_PORT}`);
check("POST 请求体解析成 JSON", post?.requestBody?.date === "2026-10-01");
check("POST 响应体解析成 JSON", post?.responseBody?.code === 0);
check("POST 响应嵌套字段可读", post?.responseBody?.data?.checkedToday === true);
// 注意 CDP 本身就不会把 Cookie / Set-Cookie 交给 Network 域（Chromium 主动剥掉的），
// 所以这里断言的是「记录里不存在明文密钥」这个真正要保证的点，而不是
// 「某个头被替换成了占位符」—— 后者在这条链路上压根不会发生。
const dumped = JSON.stringify(captured);
check("Authorization 已脱敏", post?.requestHeaders?.Authorization === "<已脱敏>");
check("Cookie 未以明文出现", !dumped.includes("SHOULD_BE_REDACTED"));
check("Authorization 令牌未以明文出现", !dumped.includes("SECRET-TOKEN"));
check("普通请求头保留原值", post?.requestHeaders?.["Content-Type"] === "application/json");
check("抓到 GET", !!get);
check("GET 含 query 的 path 完整", get?.path === "/api/status?tz=cn");
check("响应体完整保留（没被脱敏误伤）", get?.responseBody?.data?.points === 100);

console.log("\n断言:");
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) bad++;
}
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
process.exit(bad === 0 ? 0 : 1);