// 时间转换工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 时间戳换算纯逻辑在 ./logic.js（基于 Luxon / cron-parser，惰性加载）。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { parseTimestamp } from "./logic.js";

export default {
  "time.timestamp": { execute: ({ text, unit = "auto" }) => parseTimestamp(text, unit) },
};
