// 数据转换工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, text } from "./kit.js";

export default {
  key: "convert",
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolConvert",
    icon: "repeat",
    category: "data",
    descKey: "toolbox.registry.toolConvertDesc",
    keywordsKey: "toolbox.registry.kwConvert",
    ready: true,
  },
  actions: [
    {
      name: "base64.encode",
      description: "UTF-8 文本转 Base64",
      descriptionKey: "agent.toolBase64Encode",
      toolKey: "convert",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text }, ["text"]),
    },
    {
      name: "base64.decode",
      description: "Base64 转 UTF-8 文本",
      descriptionKey: "agent.toolBase64Decode",
      toolKey: "convert",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text }, ["text"]),
    },
  ],
};
