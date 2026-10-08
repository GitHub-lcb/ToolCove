// 验证 Node 侧挂钩能不能抓到 WorkBuddy **主进程**的请求。
//
// 这是整个方案的成败点：CDP 抓不到主进程（实测渲染进程 16 条启动请求全抓到、
// /billing/ 一条没有）。如果挂钩也抓不到，说明这条路的假设也是错的，
// 那就该老老实实说「这个应用抓不了」，而不是继续加代码。
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const step = (m) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`);

const dir = join(tmpdir(), "toolcove-netcapture");
mkdirSync(dir, { recursive: true });
const hookPath = join(dir, "node-hook.cjs");
const outPath = join(dir, "node-capture.ndjson");
copyFileSync("src/tools/netcapture/node-hook.cjs", hookPath);
writeFileSync(outPath, "");
step(`挂钩: ${hookPath}`);
step(`输出: ${outPath}`);

step("关闭现有 WorkBuddy…");
try { execFileSync("taskkill", ["/IM", "WorkBuddy.exe", "/F"], { stdio: "ignore" }); } catch { /* 本来就没开 */ }
await new Promise((r) => setTimeout(r, 3000));

const env = {
  ...process.env,
  NODE_OPTIONS: `--require "${hookPath}"`,
  NETCAPTURE_OUT: outPath,
  WORKBUDDY_REMOTE_DEBUGGING_PORT: "9226",
};
delete env.ELECTRON_RUN_AS_NODE;
step("带 NODE_OPTIONS 挂钩启动…");
spawn("E:\\develop-lcb\\apps\\workbuddy\\WorkBuddy.exe", [], { env, detached: true, stdio: "ignore" }).unref();

step("等 75 秒，让应用把启动请求发完…");
await new Promise((r) => setTimeout(r, 75000));

if (!existsSync(outPath)) { step("❌ 捕获文件不存在——挂钩没被加载"); process.exit(1); }
const lines = readFileSync(outPath, "utf8").split("\n").filter(Boolean);
step(`\n挂钩文件里有 ${lines.length} 行记录`);

if (!lines.length) {
  step("❌ 一条都没有：挂钩要么没加载，要么应用不用 Node 的 http/fetch");
  process.exit(1);
}

const records = [];
for (const line of lines) {
  try { records.push(JSON.parse(line)); } catch { /* 读到半行，跳过 */ }
}

step("\n抓到的请求（按主机归类）：");
const byHost = {};
for (const r of records) {
  let host = "(无法解析)";
  try { host = new URL(r.url).host; } catch { /* 忽略 */ }
  byHost[host] = (byHost[host] || 0) + 1;
}
for (const [h, n] of Object.entries(byHost).sort((a, b) => b[1] - a[1])) step(`  ${n}  ${h}`);

const billing = records.filter((r) => /billing|checkin/i.test(r.url || ""));
step(`\n其中 billing/checkin 相关 ${billing.length} 条：`);
for (const r of billing) {
  console.log(`\n${"=".repeat(60)}\n${r.method} ${r.url}`);
  for (const [k, v] of Object.entries(r.requestHeaders || {})) {
    const sensitive = /token|authorization|cookie|secret/i.test(k);
    console.log(`  ${k}: ${sensitive ? `${String(v).slice(0, 6)}…（长度 ${String(v).length}）` : String(v).slice(0, 60)}`);
  }
  console.log(`  请求体: ${JSON.stringify(r.requestBody)}`);
  console.log(`  响应体: ${JSON.stringify(r.responseBody)?.slice(0, 700)}`);
}

step(billing.length
  ? "\n✅ 挂钩抓到了主进程请求——CDP 抓不到的那部分，这条路能补上。"
  : "\n⚠️ 挂钩加载了、也抓到了别的请求，但没有 billing。看上面的主机归类判断它到底走哪条路。");
process.exit(0);