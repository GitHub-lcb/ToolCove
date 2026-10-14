// Markdown 工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, text } from "./kit.js";

export default {
  key: "markdown",
  order: 30,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolMarkdown",
    icon: "note",
    category: "data",
    descKey: "toolbox.registry.toolMarkdownDesc",
    keywordsKey: "toolbox.registry.kwMarkdown",
    ready: true,
  },
  actions: [
    {
      name: "markdown.normalize",
      description: "规范化 Markdown：全角空格转半角、列表符号统一为 -、标题前后补空行、压缩连续空行；代码块内部一律不动",
      descriptionKey: "agent.toolMarkdownNormalize",
      toolKey: "markdown",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text }, ["text"]),
    },
    {
      name: "markdown.lint",
      description: "检查 Markdown 的问题并返回错误码与行号（未闭合代码块、标题层级跳跃、表格列数不一致等）",
      descriptionKey: "agent.toolMarkdownLint",
      toolKey: "markdown",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text }, ["text"]),
    },
  ],
};
