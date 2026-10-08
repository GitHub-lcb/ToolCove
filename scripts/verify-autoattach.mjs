// 自己造一个子 iframe，验证 autoAttach 是否真的能在**创建瞬间**附加到它。
//
// 为什么必须验这一步：轮询方案的失败点就是「创建到首次请求之间只有约 200ms」。
// setAutoAttach 被接受 ≠ 它会为新建的 iframe 触发 attachedToTarget。
// 不验就上线，等于把一个没验证的机制当成修好了。
const PORT = 9222;
const step = (m) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && /qoder-cn-app:/.test(t.url || ""));
step(`主窗口: ${page.url.slice(0, 45)}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });

let nextId = 1;
const pending = new Map();
const attached = [];
const requests = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id !== undefined && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
    return;
  }
  if (m.method === "Target.attachedToTarget") {
    attached.push({ type: m.params.targetInfo.type, url: m.params.targetInfo.url, sessionId: m.params.sessionId });
    // 真实实现就是在这一步对子会话开 Network 域——必须一起验，
    // 否则「附加上了但收不到请求」会被误判成成功。
    const sid = m.params.sessionId;
    const id = nextId++;
    ws.send(JSON.stringify({ id, method: "Network.enable", params: { maxTotalBufferSize: 33554432 }, sessionId: sid }));
  }
  if (m.method === "Network.requestWillBeSent" && m.sessionId) {
    requests.push({ url: m.params.request.url.slice(0, 70), sessionId: m.sessionId });
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  const env = { id, method, params };
  if (sessionId) env.sessionId = sessionId;
  ws.send(JSON.stringify(env));
  setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} 超时`)); }, 8000);
});

await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
step("已开启 autoAttach，注入一个子 iframe…");

const inject = `(() => {
  const f = document.createElement('iframe');
  f.id = '__nc_probe_iframe';
  f.src = 'https://openapi.qoder.com.cn/growth-page/activity-iframe';
  f.style.cssText = 'position:fixed;left:-9999px;width:320px;height:200px';
  document.body.appendChild(f);
  return 'injected';
})()`;
const r = await send("Runtime.evaluate", { expression: inject, returnByValue: true });
step(`注入结果: ${r.result?.value}`);

await new Promise((res) => setTimeout(res, 9000));

step(`\nautoAttach 收到的子目标 ${attached.length} 个：`);
for (const a of attached) step(`   [${a.type}] ${(a.url || "").slice(0, 60)}`);

// 子会话上的网络事件能不能收到——这才是「不漏掉第一个请求」的关键
const subReqs = requests.filter((q) => attached.some((a) => a.sessionId === q.sessionId));
step(`\n子会话上收到的网络请求 ${subReqs.length} 条：`);
for (const q of subReqs.slice(0, 8)) step(`   ${q.url}`);

// 清理：把注入的 iframe 摘掉，别留在用户界面里
await send("Runtime.evaluate", { expression: "document.getElementById('__nc_probe_iframe')?.remove()" });
step("\n已清理注入的 iframe");

const okAttach = attached.some((a) => a.type === "iframe");
step(okAttach ? "✅ autoAttach 能在创建瞬间附加到新建 iframe" : "❌ autoAttach 没有为新建 iframe 触发");
ws.close();
process.exit(okAttach ? 0 : 1);