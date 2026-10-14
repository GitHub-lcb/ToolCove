// 时间转换工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, text } from "../../contracts/kit.js";

export default {
  key: "time",
  order: 70,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolTime",
    icon: "clock",
    category: "data",
    descKey: "toolbox.registry.toolTimeDesc",
    keywordsKey: "toolbox.registry.kwTime",
    ready: true,
  },
  actions: [
    {
      name: "time.timestamp",
      description: "时间戳转换为 UTC ISO 日期，明确秒或毫秒",
      descriptionKey: "agent.toolTimeTimestamp",
      toolKey: "time",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text, unit: { type: "string", enum: ["auto", "seconds", "milliseconds"] } }, ["text"]),
    },
  ],
};
