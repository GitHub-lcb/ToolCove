// Tauri 事件总线：浏览器端 listen/emitTo 退化为无操作，
// 使调用方（托盘事件、跨窗口消息）无需再判平台即可安全调用。
import { emit as tauriEmit, emitTo as tauriEmitTo, listen as tauriListen } from "@tauri-apps/api/event";
import { isDesktop } from "./env.js";

const NOOP_UNLISTEN = () => {};

export async function listen(event, handler, options) {
  if (!isDesktop) return NOOP_UNLISTEN;
  return tauriListen(event, handler, options);
}

/** 广播给所有窗口。跨窗口同步（如抓包工具新增站点后让签到窗口刷新）用它。 */
export async function emit(event, payload) {
  if (!isDesktop) return;
  return tauriEmit(event, payload);
}

export async function emitTo(target, event, payload) {
  if (!isDesktop) return;
  return tauriEmitTo(target, event, payload);
}
