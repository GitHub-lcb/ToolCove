// 数据生成工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 标识符生成纯逻辑在 ./logic.js（零依赖，三端共用）。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { generateIdentifiers } from "./logic.js";

export default {
  "id.generate": { execute: ({ type, count = 1 }) => generateIdentifiers(type, count) },
};
