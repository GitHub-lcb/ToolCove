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

export async function relaunch() {
  if (!isDesktop) {
    window.location.reload();
    return;
  }
  const { relaunch: tauriRelaunch } = await import("@tauri-apps/plugin-process");
  return tauriRelaunch();
}
