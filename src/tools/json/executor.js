// JSON / YAML 工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据（描述/风险/参数 Schema）在同一包的 ./contract.js —— 一个工具一个包，两者同源。
//
// 解析/格式化/序列化的纯逻辑在**中立共享层** src/json.js 与 src/yaml.js：
// agent 引擎与手机端对齐测试也用同一份实现（importBoundaries.test.js 守着「JSON 只有一份实现」）。
// 解开 { ok, value/output } 结果的 unwrap 来自中立共享层 src/shared/toolResult.js。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { parseJson, formatJson } from "../../json.js";
import { yamlToJson } from "../../yaml.js";
import { unwrap } from "../../shared/toolResult.js";

export default {
  "json.parse": { execute: ({ text }) => unwrap(parseJson(text), "value") },
  "json.format": { execute: ({ text, indent = 2 }) => unwrap(formatJson(text, indent), "output") },
  "yaml.to_json": { execute: ({ text }) => unwrap(yamlToJson(text), "output") },
};
