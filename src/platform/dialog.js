// 系统对话框：桌面端用 Tauri 插件；浏览器端 open 返回 null（文件选择需调用方按 File API 自行处理），
// save 返回建议文件名 —— 后续 invoke("export_file"/"export_file_b64") 会转成浏览器下载。
import { open as tauriOpen, save as tauriSave } from "@tauri-apps/plugin-dialog";
import { isDesktop } from "./env.js";
import { fileNameFrom } from "./download.js";

export async function open(options = {}) {
  if (!isDesktop) return null;
  return tauriOpen(options);
}

export async function save(options = {}) {
  if (isDesktop) return tauriSave(options);
  return fileNameFrom(options.defaultPath, "download");
}
