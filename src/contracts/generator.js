// 数据生成工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema } from "./kit.js";

export default {
  key: "generator",
  order: 160,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolGenerator",
    icon: "dice",
    category: "data",
    descKey: "toolbox.registry.toolGeneratorDesc",
    keywordsKey: "toolbox.registry.kwGenerator",
    ready: true,
  },
  actions: [
    {
      name: "id.generate",
      description: "生成 UUID / ULID / NanoID，最多 100 个",
      descriptionKey: "agent.toolIdGenerate",
      toolKey: "generator",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ type: { type: "string", enum: ["uuid-v4", "uuid-v7", "ulid", "nanoid"] }, count: { type: "integer", minimum: 1, maximum: 100 } }, ["type"]),
    },
  ],
};
