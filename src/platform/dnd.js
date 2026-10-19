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
  // Tauri 的 event 插件把注销入口挂在 window.__TAURI_EVENT_PLUGIN_INTERNALS__ 上。
  // 缺这个对象时 onDragDropEvent 仍能注册，但卸载时四个内部监听会各自抛一次
  // "reading 'unregisterListener' of undefined"，而且是 async 里抛的，外层 try/catch 兜不住
  // （实测：e2e 的桌面 IPC 替身不注入 internals，视图一销毁就冒 4 个未处理异常）。
  // 这种环境干脆不注册：拖放是增强能力，宁可不生效，也不能让视图销毁时炸掉。
  const canUnlisten =
    typeof window !== "undefined" &&
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ &&
    typeof window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener === "function";
  if (!canUnlisten) return null;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event?.payload;
      if (payload?.type === "enter") onActive?.(true);
      else if (payload?.type === "leave") onActive?.(false);
      else if (payload?.type === "drop") {
        onActive?.(false);
        const paths = Array.isArray(payload.paths) ? payload.paths : [];
        if (paths.length) onFiles?.(paths);
      }
    });
    // 注销失败不该打断组件销毁：event 插件的 internals 在测试替身 / 非完整壳里可能缺字段，
    // 真实的 unlisten 抛错也只会让监听多留一会儿，比在 onBeforeUnmount 里炸掉整个视图好。
    return () => {
      try {
        unlisten?.();
      } catch {
        /* 忽略：见上 */
      }
    };
  } catch {
    return null;
  }
}
