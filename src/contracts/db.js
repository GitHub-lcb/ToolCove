// 数据库工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, str } from "./kit.js";

export default {
  key: "db",
  order: 200,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolDb",
    icon: "database",
    category: "development",
    descKey: "toolbox.registry.toolDbDesc",
    keywordsKey: "toolbox.registry.kwDb",
    ready: true,
    desktopOnly: true,
  },
  actions: [
    {
      name: "db.query_readonly",
      description: "执行数据库只读查询，禁止写入",
      descriptionKey: "agent.toolDbQueryReadonly",
      toolKey: "db",
      risk: "database",
      retryable: false,
      desktopOnly: true,
      inputSchema: schema({ connId: str(128), sql: str(16000) }, ["connId", "sql"]),
    },
  ],
};
