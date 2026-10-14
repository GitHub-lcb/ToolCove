// XML 工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 自研解析/序列化纯逻辑在 ./logic.js（零依赖、三端共用）。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { formatXml, validateXml, xmlToJson } from "./logic.js";

export default {
  "xml.format": { execute: ({ text, indent = 2 }) => formatXml(text, { indent }) },
  "xml.to_json": { execute: ({ text, alwaysArray = false }) => xmlToJson(text, { alwaysArray }) },
  "xml.validate": {
    execute: ({ text }) => {
      const errors = validateXml(text);
      return { valid: errors.length === 0, errors };
    },
  },
};
