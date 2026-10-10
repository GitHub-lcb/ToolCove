// 系统外壳能力：打开链接/路径、重启应用。
// 浏览器端 openUrl 走新标签页；openPath 无对应能力（静默忽略）；relaunch 退化为刷新页面。
// 插件按需动态加载：桌面分支才真正引入 Tauri 插件，避免浏览器/单测环境加载原生插件模块。
import { isDesktop } from "./env.js";

export async function openUrl(url) {
  const target = String(url || "");
  if (!target) return;
  if (!isDesktop) {
    window.open(target, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl: tauriOpenUrl } = await import("@tauri-apps/plugin-opener");
  return tauriOpenUrl(target);
}

export async function openPath(path) {
  if (!isDesktop) return;
  const { openPath: tauriOpenPath } = await import("@tauri-apps/plugin-opener");
  return tauriOpenPath(String(path || ""));
}

/** 在系统文件管理器里定位并选中该路径（opener:default 已含 reveal 权限）。 */
export async function revealPath(path) {
  if (!isDesktop) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  return revealItemInDir(String(path || ""));
}

export async function relaunch() {
  if (!isDesktop) {
    window.location.reload();
    return;
  }
  const { relaunch: tauriRelaunch } = await import("@tauri-apps/plugin-process");
  return tauriRelaunch();
}
