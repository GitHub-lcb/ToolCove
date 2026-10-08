// 端到端：用工具自己的代码，从**两条**真实抓到的请求合并出完整配置。
// 这是用户点「生成」时实际走的路径（标记查状态请求 + 选中领取请求）。
// 全程不打印 token。
import { validateDescriptor } from "../src/checkin/descriptor.js";
import { startCapture } from "../src/tools/netcapture/cdp.js";
import { combineRequests } from "../src/tools/netcapture/combine.js";
import { buildDescriptor, guessReadPaths } from "../src/tools/netcapture/descriptor.js";

const PORT = 9222;
const step = (m) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`);

const captured = [];
const cap = await startCapture({
  port: PORT,
  probe: async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()),
  captureBodies: true,
  onRequest: (r) => captured.push(r),
});
step(`附加 ${cap.targetCount} 个 target`);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const iframe = targets.find((t) => t.type === "iframe" && /activity/.test(t.url || ""));
if (!iframe) { step("弹窗没开，无法抓包"); process.exit(1); }
const ws = new WebSocket(iframe.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "location.reload()" } }));
await new Promise((r) => setTimeout(r, 12000));
cap.stop();
try { ws.close(); } catch { /* 忽略 */ }

const api = captured.filter((r) => /\/sash\/api\//.test(r.path));
const statusRec = api.find((r) => r.method === "GET" && /campaigns$/.test(r.path));
const claimRec = api.find((r) => /\/claim$/.test(r.path));
step(`查状态请求: ${statusRec ? statusRec.path : "没抓到"}`);
step(`领取请求:   ${claimRec ? claimRec.path : "没抓到"}`);
if (!statusRec || !claimRec) { step("两条没凑齐"); process.exit(1); }

const single = buildDescriptor(claimRec);
step(`\n单看领取请求: valid=${single.valid}  错误=${single.errors.map((e) => e.code).join(",") || "无"}`);

const out = combineRequests(claimRec, statusRec, { buildDescriptor, guessReadPaths });
step(`\n合并后 valid=${out.valid}`);
step("警告：");
for (const w of out.warnings) step(`   - ${w}`);
step("\n生成的配置（凭据值已省略）：");
const redacted = JSON.parse(JSON.stringify(out.descriptor));
for (const action of ["status", "checkin"]) {
  if (redacted[action]?.headers) {
    redacted[action].headers = redacted[action].headers.map(([n, v]) => [n, /authorization|cookie/i.test(n) ? `<${String(v).length} 字符的真值>` : v]);
  }
}
console.log(JSON.stringify(redacted, null, 2));

const { ok, errors } = validateDescriptor(out.descriptor, { existingKeys: [] });
step(`\n通过签到校验: ${ok}${ok ? "" : `  错误: ${errors.map((e) => `${e.field}:${e.code}`).join(", ")}`}`);
step(ok ? "\n✅ 两条请求合并出的配置可直接用，无需手改。" : "\n❌ 仍需手改。");
process.exit(0);