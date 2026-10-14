// JSON Schema 工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, text } from "./kit.js";

export default {
  key: "schema",
  ui: {
    labelKey: "toolbox.registry.toolSchema",
    icon: "layout",
    category: "data",
    descKey: "toolbox.registry.toolSchemaDesc",
    keywordsKey: "toolbox.registry.kwSchema",
    ready: true,
  },
  actions: [
    {
      name: "schema.infer",
      description: "从一段 JSON 文本推断 JSON Schema（输入是 JSON 文本，不是已解析的对象）",
      descriptionKey: "agent.toolSchemaInfer",
      toolKey: "schema",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text, required: { type: "boolean" } }, ["text"]),
    },
    {
      name: "schema.validate",
      description: "用 JSON Schema 校验 JSON 文本，返回 valid 与全部错误路径（value 与 schemaText 都是 JSON 文本）",
      descriptionKey: "agent.toolSchemaValidate",
      toolKey: "schema",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ value: text, schemaText: text }, ["value", "schemaText"]),
    },
  ],
};
