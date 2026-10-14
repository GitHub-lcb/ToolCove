// 桌面专属工具的执行入口（对外出口）：实现已抽到中立共享层 src/nativeInvoke.js（re-export）。
//
// 为什么抽走：包模型下桌面独占工具的 executor 住在 src/tools/<key>/ 里，若它们直接 import 本文件
// （src/agent/）就会形成 tools → agent 的反向边。抽到根级后，包内 executor 走 src/nativeInvoke.js。
// 这里保留 desktopInvoke / isDesktop 两个既有出口，既有调用方（如 src/nativeBinary.js）无需改动。
export { desktopInvoke, isDesktop } from "../nativeInvoke.js";
