// 工具预填交接：Agent 把产物路径一次性带给要打开的工具。
// Tauri 工具窗口是独立 JS realm 但同源（共享 localStorage）；内嵌降级路径（工具箱模块）
// 更同源——所以 localStorage 是跨窗口最简交接通道，不必引入事件桥。
const PREFIX = "tc.toolPrefill.";

/** 写入预填载荷。隐私模式写不进去就静默放弃：预填只是增强，丢了退回「打开空工具」。 */
export function setToolPrefill(toolKey, payload) {
  try {
    localStorage.setItem(PREFIX + toolKey, JSON.stringify(payload));
  } catch {
    /* 见上 */
  }
}

/** 读取并立刻删除：一次性交接，避免下次手动开同一个工具时误复活旧路径。解析失败按「没有预填」处理。 */
export function consumeToolPrefill(toolKey) {
  try {
    const raw = localStorage.getItem(PREFIX + toolKey);
    if (raw == null) return null;
    localStorage.removeItem(PREFIX + toolKey);
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}
