// 原生二进制桥（中立共享层）：按路径读写本地文件字节，走 Tauri IPC 的 Base64 命令。
//
// 为什么住在根级、而不是 platform/ 或某个工具包里：
// - 放 platform/ 不行：它要调 agent/transport.js 的 desktopInvoke（原生 IPC），
//   而 platform/ 是最底层、不许向上依赖（importBoundaries.test.js 守着）。
// - 放 tools/<key>/ 也不行：agent/ 引用它会造出 agent → tools 的跨区边。
// - 这正是「同一份逻辑被 agent 与工具包共用」的既定做法（与 yaml.js / json.js 同理）。
import { desktopInvoke } from "./agent/transport.js";

const B64_CHUNK = 0x8000;

/** Uint8Array → Base64（分块避免栈溢出；浏览器与 Node 都有 btoa/atob）。 */
export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  return btoa(bin);
}

/** Base64 → Uint8Array。 */
export function base64ToBytes(base64) {
  const bin = atob(String(base64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 原生 Base64 桥：读本地二进制文件（≤20MB，原生侧限制）。 */
export async function readBinary(path) {
  const p = String(path || "").trim();
  if (!p) throw Error("缺少文件路径");
  const res = await desktopInvoke("file_tool_read_base64", { path: p });
  return base64ToBytes(res?.base64);
}

/** 原生 Base64 桥：写本地二进制文件，返回写入字节数。 */
export async function writeBinary(path, bytes) {
  const p = String(path || "").trim();
  if (!p) throw Error("缺少输出路径");
  return desktopInvoke("file_tool_write_base64", { path: p, content: bytesToBase64(bytes) });
}
