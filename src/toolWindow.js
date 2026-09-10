// 工具独立窗口：从 ToolboxView 抽出，供工具箱与 Agent 能力面板共用（同一套标签/尺寸/主题解析）。
// 浏览器预览下没有 Tauri IPC，调用方用 isTauriEnv() 自行降级为内嵌。
import { WebviewWindow } from "./platform/window.js";
import { getCurrentWindow } from "./platform/window.js";
import { isDesktop } from "./platform/env.js";
import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

export function isTauriEnv() {
  return isDesktop;
}

/** 独立窗口跟随主窗口主题：先看用户显式选择，再问系统，最后回退 prefers-color-scheme。 */
export async function resolveToolWindowTheme() {
  const mode = localStorage.getItem("themeMode") || "system";
  if (mode === "light" || mode === "dark") return mode;
  try {
    return (await getCurrentWindow().theme()) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
}

/**
 * 打开工具：Tauri 下开独立窗口（可拖动、缩放；同工具单例，已开则聚焦）。
 * 创建失败或异常时回调 onFallback（如内嵌到主窗口 / 跳到工具箱），showToast 用于提示降级。
 */
export async function openToolWindow(tool, { showToast, onFallback } = {}) {
  const label = "tool-" + tool.key;
  try {
    // Tauri v2：getByLabel 是 async（经 IPC 查询窗口），需 await 才是窗口实例
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.unminimize();
      await existing.setFocus();
      return;
    }
    const theme = await resolveToolWindowTheme();
    const win = new WebviewWindow(label, {
      url: "/index.html?tool=" + tool.key,
      title: t(tool.labelKey),
      width: 980,
      height: 720,
      minWidth: 720,
      minHeight: 520,
      decorations: false,
      center: true,
      visible: false,
      focus: false,
      theme,
      backgroundColor: theme === "dark" ? [13, 17, 23, 255] : [246, 248, 250, 255],
    });
    // 创建失败（如权限不足）：提示降级内嵌
    win.once("tauri://error", (e) => {
      console.error(t("common.toolWinFail", { err: JSON.stringify(e) }));
      onFallback?.();
      showToast?.(t("toolbox.windowFailFallback"));
    });
  } catch (e) {
    console.error(t("common.toolWinOpenFail", { err: e }));
    onFallback?.();
  }
}
