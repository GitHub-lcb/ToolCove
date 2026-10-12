// 桌面端文件拖放：Tauri 默认把「从系统拖文件进窗口」拦成原生事件（HTML5 的 File 对象拿不到本地路径），
// 所以桌面端走 webview 的 drag-drop 事件拿真实路径，交给 Rust 侧按路径处理；
// 浏览器 / 手机端仍用原生 drop 事件，不经过这里。
import { isDesktop } from "./env.js";

/**
 * 注册窗口级文件拖放（组件 onMounted 里调用，onBeforeUnmount 里注销）。
 * 拖放是增强能力：注册失败一律静默，不能因为它拖垮主流程。
 *
 * @param {{ onFiles?: (paths: string[]) => void, onActive?: (active: boolean) => void }} handlers
 *   onActive 对应 enter/leave，用于点亮页面上的拖放区（兑现「拖到这里」的文案承诺）。
 * @returns {Promise<(() => void) | null>} 取消注册函数；非桌面端返回 null。
 */
export async function watchFileDrop({ onFiles, onActive } = {}) {
  if (!isDesktop) return null;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event?.payload;
      if (payload?.type === "enter") onActive?.(true);
      else if (payload?.type === "leave") onActive?.(false);
      else if (payload?.type === "drop") {
        onActive?.(false);
        const paths = Array.isArray(payload.paths) ? payload.paths : [];
        if (paths.length) onFiles?.(paths);
      }
    });
  } catch {
    return null;
  }
}
