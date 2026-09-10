// 窗口能力：桌面端为 Tauri 窗口/独立窗口；浏览器端提供无操作占位对象，
// 调用方（标题栏控制、主题同步、关闭前冲刷）无需再判平台。
import { getCurrentWindow as tauriCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow as TauriWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isDesktop } from "./env.js";

const noop = () => {};

const browserWindow = {
  label: "main",
  show: noop,
  setFocus: noop,
  minimize: noop,
  toggleMaximize: noop,
  close: noop,
  destroy: noop,
  isMaximized: async () => false,
  theme: async () => null,
  setTheme: noop,
  onResized: async () => noop,
  onCloseRequested: async () => noop,
};

export function getCurrentWindow() {
  return isDesktop ? tauriCurrentWindow() : browserWindow;
}

/** 浏览器端无独立窗口：getByLabel 恒为 null，构造抛错（调用方据此走内嵌降级）。 */
class BrowserWebviewWindow {
  static async getByLabel() {
    return null;
  }
  constructor() {
    throw new Error("浏览器端不支持独立窗口，请使用内嵌降级");
  }
}

export const WebviewWindow = isDesktop ? TauriWebviewWindow : BrowserWebviewWindow;
