// 桌面专属工具的执行入口：非桌面平台统一抛 DESKTOP_ONLY。
// 平台判定复用 src/platform/env.js，避免各处重复实现。
import { invoke } from "../platform/invoke.js";
import { isDesktop, desktopOnly } from "../platform/env.js";

export { isDesktop };

export async function desktopInvoke(command, args = {}) {
  if (!isDesktop) throw desktopOnly(command);
  try {
    return await invoke(command, args);
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : String(error));
    wrapped.code = "TAURI_COMMAND_FAILED";
    wrapped.command = command;
    throw wrapped;
  }
}
