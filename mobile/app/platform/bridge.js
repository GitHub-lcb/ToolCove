// 手机端原生桥：把安卓侧注入的 `window.ToolCove` 适配成统一的 `{ invoke(cmd, args) }`。
//
// 为什么要有这一层（而不是让业务代码直接调 window.ToolCove）：
//  1) 命令名与桌面端**完全同名**——`src/data/repository.js`、`src/sync/*` 一行都不用改；
//  2) 安卓侧只需要实现原生能力，纯 Web 能做的（存储、下载）继续走 platform/invoke 的浏览器实现；
//  3) **可在浏览器里独立测试**：桥不存在时就是普通网页（IndexedDB 存储 + fetch），
//     所以移动视口的 E2E 不必等 APK 就能跑（见 e2e/specs/30-mobile-shell.spec.js）。
//
// 安卓侧约定（Kotlin 里用 @JavascriptInterface 暴露同名方法，参数为 JSON 字符串）：
//   window.ToolCove.invoke(cmd, argsJson) -> 返回 JSON 字符串；抛错时返回 {"__error": "..."}
//   window.ToolCove.isMobile === true
import { setMobileBridge, hasMobileBridge } from "@/src/platform/invoke.js";

/** 安卓原生桥是否存在（浏览器里跑移动端前端时为 false）。 */
export function nativeAvailable() {
  return typeof window !== "undefined" && !!window.ToolCove && window.ToolCove.isMobile === true;
}

/**
 * 把原生桥接上。返回是否接上——没接上时前端按「浏览器形态」运行，
 * 存储落 IndexedDB、AI 直连 fetch，功能受限但可用（这正是 E2E 能覆盖它的原因）。
 */
export function installNativeBridge() {
  if (!nativeAvailable()) return false;
  const native = window.ToolCove;
  setMobileBridge({
    async invoke(command, args = {}) {
      const raw = await native.invoke(String(command), JSON.stringify(args ?? {}));
      if (raw == null || raw === "") return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // 原生侧返回了非 JSON：当成字符串结果，不静默吞掉
        return raw;
      }
      if (parsed && typeof parsed === "object" && typeof parsed.__error === "string") {
        throw Object.assign(new Error(parsed.__error), { code: parsed.__code || "NATIVE_ERROR", command });
      }
      return parsed;
    },
  });
  return true;
}

/**
 * Android WebView 的返回键：网页内入栈历史，原生侧检测 `canGoBack()` 后退，
 * 到栈底才交给系统退出。这里提供一个统一的「返回」入口给页面用（面包屑/工具返回）。
 */
export function onSystemBack(handler) {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener("toolcove:back", listener);
  return () => window.removeEventListener("toolcove:back", listener);
}

export { hasMobileBridge };
