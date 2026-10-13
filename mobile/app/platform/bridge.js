// 手机端原生桥：把安卓侧注入的 `window.ToolCove` 适配成统一的 `{ invoke(cmd, args) }`。
//
// 为什么要有这一层（而不是让业务代码直接调 window.ToolCove）：
//  1) 命令名与桌面端**完全同名**——`src/data/repository.js`、`src/sync/*` 一行都不用改；
//  2) 安卓侧只需要实现原生能力，纯 Web 能做的（存储、下载）继续走 platform/invoke 的浏览器实现；
//  3) **可在浏览器里独立测试**：桥不存在时就是普通网页（IndexedDB 存储 + fetch），
//     所以移动视口的 E2E 不必等 APK 就能跑（见 e2e/specs/30-mobile-shell.spec.js）。
//
// 安卓侧约定（Kotlin 里用 @JavascriptInterface 暴露方法，参数为 JSON 字符串）：
//   window.ToolCove.invoke(cmd, argsJson) -> 返回 JSON 字符串；抛错时返回 {"__error": "..."}
import { invoke } from "../../../src/platform/invoke.js";
import { detectNativeBridge } from "../../../src/platform/env.js";
import { setMobileBridge, hasMobileBridge } from "../../../src/platform/backends/mobile.js";

/**
 * 安卓原生桥是否存在。
 *
 * ⚠️ 判据是 `invoke` 是个**函数**——不要判某个布尔属性（如过去的 `isMobile === true`）。
 * 真机教训（1.3.1 及以前）：Kotlin 的 `@get:JavascriptInterface val isMobile` 经 WebView
 * 注入后在 JS 里是一个**方法**而不是布尔属性，`=== true` 恒为假——于是桥被静默判为
 * "不存在"，整个 App 一直在跑浏览器降级路径（检查更新报 CORS 的 Failed to fetch、
 * 密钥不加密、HTTP 走 fetch 受跨域限制），而所有测试都看不见：E2E 的桥替身恰好种了
 * `isMobile: true` 这个**真机上不存在**的形状。现在替身已改成真机形状（只有 invoke）。
 */
export function nativeAvailable() {
  return detectNativeBridge();
}

/**
 * 弹系统文件选择器，返回授权 URI（空串表示用户取消）。
 *
 * 走的是桥的 `file_pick` 命令：原生侧挂起等待用户操作，超时或取消都返回空串。
 * 所以这里**不需要**处理"选择器停住了"——它会自己结束，前端把空串当取消即可。
 * 浏览器形态下没有选择器，抛一句能读懂的话，由调用方决定怎么提示。
 */
export async function pickFile(mimeType = "*/*") {
  if (!nativeAvailable()) throw new Error("浏览器预览下没有系统文件选择器");
  const result = await invoke("file_pick", { mimeType });
  return String(result?.uri || "");
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
