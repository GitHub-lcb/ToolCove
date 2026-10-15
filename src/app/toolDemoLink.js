// 演示脚本的投递通道：主窗口（对话）→ 工具侧，以及回程（ready / done 回执）。
//
// 两条路各有分工，缺一不可：
//   · 冷启动——工具**还没开**：脚本先落到存储（platform/kv，桌面/浏览器/移动端都能用），
//     新窗口打开后在自己的 onMounted 里消费。这正是 toolPrefill 的形态。
//   · 热路径——工具**已经开着**：只走存储会没人来读（视图早就挂载过了，不会重新 onMounted），
//     所以再补一条实时通道：内嵌视图走同进程订阅，桌面独立窗口走 Tauri 事件（emitTo 那个窗口）。
//     「AI 打开工具却打在旧状态上」这个坑就是这么来的，这里把它封掉。
//
// 回程（ready/done）同理：桌面 emitTo("main")，内嵌走同进程订阅。
import { kvDelete, kvGet, kvSet } from "../platform/kv.js";
import { emitTo, listen } from "../platform/events.js";
import { isDesktop } from "../platform/env.js";

const PREFIX = "tc.toolDemo.";
/** 主窗口 → 工具窗口（桌面独立窗口用；事件名不带工具 key，由 payload.toolKey 分发） */
const DEMO_EVENT = "agent-demo";
/** 工具窗口 → 主窗口：{ kind: "ready" | "done", … } */
const SIGNAL_EVENT = "agent-demo-signal";

/** 主窗口 label（见 src-tauri/capabilities/default.json 的 windows） */
export const MAIN_WINDOW = "main";

const toolSubs = new Map(); // toolKey -> Set<handler>
const signalSubs = new Set();
let desktopWired = false;

export const toolWindowLabel = (toolKey) => "tool-" + toolKey;

function fire(subs, payload) {
  for (const handler of [...subs]) {
    try {
      handler(payload);
    } catch (error) {
      // 单个订阅者出错不该影响其它订阅者（也绝不该冒到调用方：投递是增强，不是主流程）
      console.error("toolDemo subscriber failed", error);
    }
  }
}

/** 桌面端的全局监听只装一次：各自 ready 后再按 toolKey / kind 分发 */
function wireDesktop() {
  if (desktopWired || !isDesktop) return;
  desktopWired = true;
  listen(DEMO_EVENT, (event) => {
    const payload = event && event.payload;
    if (payload && payload.toolKey) fire(toolSubs.get(payload.toolKey) || [], payload);
  }).catch(() => {});
  listen(SIGNAL_EVENT, (event) => {
    const payload = event && event.payload;
    if (payload) fire(signalSubs, payload);
  }).catch(() => {});
}

/**
 * 把脚本送到工具侧。调用方（AgentView）已经算好 script（见 app/toolDemo.js），
 * 这里只负责投递——不在这里生成脚本，避免两处各算一份。
 */
export async function sendDemo({ toolKey, action, runId, script }) {
  if (!toolKey || !Array.isArray(script) || !script.length) return false;
  const payload = { toolKey, action: action || "", runId: runId || "", script, at: Date.now() };
  let stored = true;
  try {
    await kvSet(PREFIX + toolKey, payload);
  } catch {
    // 存储写不进去（隐私模式等）：热路径仍可能送达，不因此放弃整次投递
    stored = false;
  }
  fire(toolSubs.get(toolKey) || [], payload);
  if (isDesktop) emitTo(toolWindowLabel(toolKey), DEMO_EVENT, payload).catch(() => {});
  return stored;
}

/** 工具侧冷启动消费：读取即删除（一次性交接，避免下次手动开同一个工具时复活旧脚本） */
export async function takeDemo(toolKey) {
  if (!toolKey) return null;
  try {
    const payload = await kvGet(PREFIX + toolKey);
    if (!payload) return null;
    await kvDelete(PREFIX + toolKey);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/** 工具侧订阅实时投递（工具已挂载时走这条）；返回取消函数 */
export function subscribeDemo(toolKey, handler) {
  if (!toolKey || typeof handler !== "function") return () => {};
  wireDesktop();
  const subs = toolSubs.get(toolKey) || new Set();
  subs.add(handler);
  toolSubs.set(toolKey, subs);
  return () => {
    subs.delete(handler);
    if (!subs.size) toolSubs.delete(toolKey);
  };
}

/** 工具侧回程：ready = 组件挂载完成、可以开播；done = 演示结束（带步数与是否被跳过） */
export function notifySignal(kind, payload) {
  if (kind !== "ready" && kind !== "done") return;
  const body = { kind, ...(payload || {}) };
  fire(signalSubs, body);
  if (isDesktop) emitTo(MAIN_WINDOW, SIGNAL_EVENT, body).catch(() => {});
}

/** 主窗口订阅回执（AgentView 用它把「已在你面前演示过」写回工具卡） */
export function onDemoSignal(handler) {
  if (typeof handler !== "function") return () => {};
  wireDesktop();
  signalSubs.add(handler);
  return () => signalSubs.delete(handler);
}

/** 仅测试用：清掉内部订阅表，避免用例互相污染 */
export function resetDemoLinkForTest() {
  toolSubs.clear();
  signalSubs.clear();
}
