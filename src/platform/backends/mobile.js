// 手机端原生桥（安卓）：由 App 启动时注入，形状为 `{ invoke(cmd, args) }`。
//
// 为什么用注入而不是在 src/ 里 import 安卓代码：这套前端要能**在浏览器里跑**——
// 于是移动端的平台能力可以被 Playwright（移动视口）自动化验证，而不必先有 APK 可跑。
// 注入点只有这一个，桌面端与网页端的行为完全不受影响（它们永远不会设置这个桥）。
let mobileBridge = null;

export function setMobileBridge(bridge) {
  mobileBridge = bridge && typeof bridge.invoke === "function" ? bridge : null;
  return mobileBridge;
}

export const hasMobileBridge = () => !!mobileBridge;
export const getMobileBridge = () => mobileBridge;

/**
 * 判断错误是不是"桥不认识这个命令"。
 *
 * 桥对未实现命令返回 `__code: "unsupported"`（见 mobile/android 的 Bridge.dispatch），
 * 适配层会把它翻成带 code 的 Error。只有这种才回退——回退到浏览器实现是为了让
 * 「存储/下载/图片」这类纯 Web 能力在真机上照常工作，而桥认识的命令一旦失败
 * （HTTP 超时、文件读不到），那个错误是**真实结果**，回退只会掩盖它。
 */
export function isBridgeUnsupported(error) {
  const code = error?.code || error?.cause?.code;
  if (code === "unsupported") return true;
  // 兜底：老版本桥可能没带 code，按文案判断（中文与英文两种都认）
  const message = String(error?.message || "");
  return /尚未实现|not implemented|unsupported/i.test(message);
}
