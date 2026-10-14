// 数据转换工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据（描述/风险/参数 Schema）在同一包的 ./contract.js —— 一个工具一个包，两者同源。
//
// 编解码纯逻辑在 ./logic.js（Base64/URL/Unicode/Hex/JSON 字符串/JWT），三端共用同一份。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { decodeBase64, encodeBase64 } from "./logic.js";

export default {
  "base64.encode": { execute: ({ text }) => encodeBase64(text) },
  "base64.decode": { execute: ({ text }) => decodeBase64(text) },
};
