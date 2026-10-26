// 桌面端拖放的「路径 → File」：Tauri 把系统拖文件拦成原生事件，只给真实路径（见 dnd.js），
// 而图片管线（createImageBitmap / FileReader / file.arrayBuffer）只认 File/Blob。
// 这里用 file_tool_read_base64 取回字节再包成 File，mime 由文件名推断（与下载共用同一张表）。
import { invoke } from "./invoke.js";
import { mimeFromName } from "./download.js";

/** base64 → 字节；不依赖 Buffer，浏览器 / Node 都能跑 */
export function base64Bytes(value) {
  const binary = atob(String(value || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** file_tool_read_base64 的返回值 → File（name 决定 mime，未知扩展名落回 octet-stream） */
export function fileFromBase64Result(result) {
  const name = String(result?.name || "dropped");
  return new File([base64Bytes(result?.base64)], name, { type: mimeFromName(name) });
}

/**
 * 拖放的路径数组 → { files, errors }。
 * 单个路径读不到（目录、超过 file_tool 的 20 MB 上限、无权限）就跳过，
 * 不让整批一起消失；但**原因要带回去**——全都读不到时界面要如实说为什么，
 * 不能统一显示成"没检测到图片"（那会把"文件太大"说成"你拖错了"）。
 */
export async function filesFromPaths(paths) {
  const files = [];
  const errors = [];
  for (const path of paths || []) {
    try {
      files.push(fileFromBase64Result(await invoke("file_tool_read_base64", { path })));
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }
  return { files, errors };
}
