// 文件工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 五个动作都是桌面独占，经**中立原生 IPC 桥** src/nativeInvoke.js 调用原生命令。
// preview_write 的逐行 diff 走**中立共享层** src/textDiff.js；
// read_text 的分页窗口走**中立共享层** src/readWindow.js（与引擎 spill.read 共用同一份）。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { desktopInvoke } from "../../nativeInvoke.js";
import { buildTextDiff } from "../../textDiff.js";
import { readWindowResult } from "../../readWindow.js";

/** 取出 invoke 回来的文本字段（Rust 侧返回对象 { text, encoding, ... }）。 */
const textOf = (result) => (typeof result === "string" ? result : result?.text ?? result?.content ?? "");

/** 把窗口结果贴回原文的元信息对象，保留 encoding/hasBom/lossy 等字段。 */
function withWindow(result, offset, limit) {
  const source = textOf(result);
  const window = readWindowResult(source, { offset, limit });
  const base = result && typeof result === "object" ? result : {};
  return { ...base, text: window.text, totalChars: window.totalChars, totalLines: window.totalLines, windowLine: window.windowLine, hasMore: window.hasMore, nextOffset: window.nextOffset, note: window.note };
}

export default {
  "file.inspect": { execute: ({ paths }) => desktopInvoke("file_tool_inspect", { paths }) },
  "file.read_text": { execute: async ({ path, encoding = "AUTO", offset, limit }) => withWindow(await desktopInvoke("file_tool_read_text", { path, encoding }), offset, limit) },
  "file.write_text": { execute: ({ path, text }) => desktopInvoke("file_tool_write_text", { path, text, encoding: "UTF-8", bom: false }) },
  "file.preview_write": {
    execute: async ({ path, text }) => {
      const old = await desktopInvoke("file_tool_read_text", { path, encoding: "UTF-8" });
      return { path, diff: buildTextDiff(textOf(old), text), oldText: textOf(old), newText: text };
    },
  },
  "file.list_directory": { execute: ({ path }) => desktopInvoke("file_tool_list_directory", { path }) },
};
