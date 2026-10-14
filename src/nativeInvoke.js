// 原生命令中立桥（中立共享层）：桌面扩展命令的统一执行入口 —— 非桌面平台抛 DESKTOP_ONLY，
// 失败包装成 TAURI_COMMAND_FAILED。
//
// 为什么住在根级、而不是 platform/ 或某个工具包里：
// - 放 platform/ 不行：platform/ 是最底层（importBoundaries.test.js 守着），而这里封装的是
//   「桌面独占工具的调用入口」这一上层语义（isDesktop 判定 + DESKTOP_ONLY 错误码），放进去会把
//   工具语义沉到平台层。
// - 放 tools/<key>/ 也不行：多个桌面独占工具的 executor 共用它，且 agent/transport.js 要保留既有
//   对外出口——放包里会让 agent 反向依赖某个工具包。
// - 这正是「同一份逻辑被 agent 与工具包共用」的既定做法（与 nativeBinary.js / yaml.js 同理）：
//   包内 executor 直接 import 本文件，就不会形成 tools → agent 的反向边。
// agent/transport.js 保留 desktopInvoke 这个既有出口（re-export），既有 import 无需改动。
import { invoke } from "./platform/invoke.js";
import { isDesktop, desktopOnly } from "./platform/env.js";

export { isDesktop };

/** 桌面扩展命令调用：非桌面平台抛 DESKTOP_ONLY，失败包装成带命令名的 TAURI_COMMAND_FAILED。 */
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
