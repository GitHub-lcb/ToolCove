// 接口调试工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, str } from "../../contracts/kit.js";

export default {
  key: "request",
  order: 180,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolRequest",
    icon: "send",
    category: "network",
    descKey: "toolbox.registry.toolRequestDesc",
    keywordsKey: "toolbox.registry.kwRequest",
    ready: true,
  },
  actions: [
    {
      name: "http.request",
      description: "发送 HTTP 请求并返回状态码、响应头与响应体（浏览器端受 CORS 限制）",
      descriptionKey: "agent.toolHttpRequest",
      toolKey: "request",
      risk: "write",
      retryable: false,
      inputSchema: schema(
        {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
          url: str(2048),
          headers: { type: "array", maxItems: 50, items: schema({ name: str(256), value: str(8192) }, ["name", "value"]) },
          body: str(64000),
          timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
        },
        ["method", "url"]
      ),
    },
  ],
};
