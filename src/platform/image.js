// 图片附件的显示 URL 解析：桌面端走 asset 协议让 WebView 直接读文件（不经 IPC、不做 base64），
// 浏览器/手机端落回 load_image 的 base64 data URL（IndexedDB 后端）。
// scope 见 tauri.conf.json 的 assetProtocol（$APPDATA/images/** 与 media/**）。
import { invoke } from "./invoke.js";
import { isDesktop } from "./env.js";

function mimeOf(name) {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
}

/** 文件路径 → asset URL（convertFileSrc 只在 Tauri 环境可用，调用方需保证已 isDesktop） */
export async function fileAssetUrl(path) {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}

/** 图片附件名 → 显示 URL：桌面 asset 协议 / 浏览器 base64 */
export async function imageSrc(name) {
  if (isDesktop) {
    return fileAssetUrl(await invoke("image_file_path", { name }));
  }
  const b64 = await invoke("load_image", { name });
  return `data:${mimeOf(name)};base64,${b64}`;
}
