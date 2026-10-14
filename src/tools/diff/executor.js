// 文本对比工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 逐行 diff 的纯逻辑在**中立共享层** src/textDiff.js —— agent/session.js（引擎）也在用它，
// 搬进包内会让 agent 反向依赖某个工具包，所以按中立层路径引用。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { buildTextDiff } from "../../textDiff.js";

export default {
  "text.diff": { execute: ({ left, right }) => buildTextDiff(left, right) },
};
