// Markdown 工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 规范化与检查是零依赖纯函数，落在 ./logic.js，三端共用。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { lint as lintMarkdown, normalize as normalizeMarkdown } from "./logic.js";

export default {
  "markdown.normalize": { execute: ({ text }) => normalizeMarkdown(text) },
  "markdown.lint": {
    execute: ({ text }) => {
      const issues = lintMarkdown(text);
      return { count: issues.length, issues };
    },
  },
};
