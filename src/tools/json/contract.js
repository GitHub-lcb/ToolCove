// JSON / YAML 工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, text } from "../../contracts/kit.js";

export default {
  key: "json",
  order: 80,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolJson",
    icon: "braces",
    category: "data",
    descKey: "toolbox.registry.toolJsonDesc",
    keywordsKey: "toolbox.registry.kwJson",
    ready: true,
  },
  actions: [
    {
      name: "json.parse",
      description: "解析 JSON",
      descriptionKey: "agent.toolJsonParse",
      toolKey: "json",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text }, ["text"]),
    },
    {
      name: "json.format",
      description: "格式化 JSON",
      descriptionKey: "agent.toolJsonFormat",
      toolKey: "json",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text, indent: { type: "integer", minimum: 0, maximum: 8 } }, ["text"]),
    },
    {
      name: "yaml.to_json",
      description: "YAML 转 JSON",
      descriptionKey: "agent.toolYamlToJson",
      toolKey: "json",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text }, ["text"]),
    },
  ],
};
