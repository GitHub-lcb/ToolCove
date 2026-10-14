// 文本对比工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, text } from "./kit.js";

export default {
  key: "diff",
  ui: {
    labelKey: "toolbox.registry.toolDiff",
    icon: "text",
    category: "data",
    descKey: "toolbox.registry.toolDiffDesc",
    keywordsKey: "toolbox.registry.kwDiff",
    ready: true,
  },
  actions: [
    {
      name: "text.diff",
      description: "逐行比较两段文本，返回变更行与统计",
      descriptionKey: "agent.toolTextDiff",
      toolKey: "diff",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ left: text, right: text }, ["left", "right"]),
    },
  ],
};
