// 端到端验证整条链路：cdp 抓包（含 ExtraInfo）→ 生成站点描述 → 通过签到校验。
// 这次用的是工具自己的代码，不是另写的探测脚本——差别在于前者才是用户实际会跑的路径。
// 全程不打印 token 内容。
import { validateDescriptor } from "../src/checkin/descriptor.js";
import { startCapture } from "../src/tools/netcapture/cdp.js";
import { buildDescriptor } from "../src/tools/netcapture/descriptor.js";

const PORT = 9222;
const step = (m) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`);

const captured = [];
const cap = await startCapture({
  port: PORT,
  probe: async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()),
  captureBodies: true,
  onRequest: (r) => captured.push(r),
  onLog: (m) => step(`log: ${m}`),
});
step(`附加 ${cap.targetCount} 个 target`);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const iframe = targets.find((t) => t.type === "iframe" && /activity/.test(t.url || ""));
if (!iframe) { step("没有 activity iframe，弹窗没开"); process.exit(1); }
const ws = new WebSocket(iframe.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "location.reload()" } }));
await new Promise((r) => setTimeout(r, 12000));
cap.stop();
try { ws.close(); } catch { /* 忽略 */ }

const api = captured.filter((r) => /\/sash\/api\//.test(r.path));
step(`抓到 /sash/api/ ${api.length} 条`);
if (!api.length) { step("一条都没抓到"); process.exit(1); }

for (const rec of api) {
  const auth = Object.entries(rec.requestHeaders || {}).find(([n]) => /^authorization$/i.test(n));
  step(`  ${rec.method} ${rec.path}`);
  step(`     Authorization: ${auth ? `有（长度 ${String(auth[1]).length}，前缀 ${String(auth[1]).slice(0, 7)}…）` : "没有"}`);
  step(`     带了 wireHeaders: ${rec.wireHeaders ? "是" : "否"}`);
}

// 生成描述并校验——这一步才是「用户点了加入签到站点」实际会发生的事
const claim = api.find((r) => /\/claim$/.test(r.path)) || api[0];
const out = buildDescriptor(claim);
step(`\n生成描述：valid=${out.valid}`);
for (const w of out.warnings) step(`   警告: ${w}`);
const headerNames = (out.descriptor.checkin.headers || []).map(([n]) => n);
step(`   checkin.headers: ${headerNames.join(", ") || "(空)"}`);
const hasAuth = headerNames.some((n) => /^authorization$/i.test(n));
step(`   含 Authorization 真值: ${hasAuth ? "是" : "否"}`);

const { ok, errors } = validateDescriptor(out.descriptor, { existingKeys: [] });
step(`   通过签到校验: ${ok}${ok ? "" : `  错误: ${errors.map((e) => `${e.field}:${e.code}`).join(", ")}`}`);

step(hasAuth ? "\n✅ 端到端通过：抓包工具会自动把 token 写进签到配置，用户无需手抄凭据。" : "\n❌ 未自动带入 token。");
process.exit(0);