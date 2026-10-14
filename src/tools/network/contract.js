// 网络诊断工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, str } from "../../contracts/kit.js";

export default {
  key: "network",
  order: 90,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolNetwork",
    icon: "network",
    category: "network",
    descKey: "toolbox.registry.toolNetworkDesc",
    keywordsKey: "toolbox.registry.kwNetwork",
    ready: true,
    desktopOnly: true,
  },
  actions: [
    {
      name: "network.ping",
      description: "Ping 目标主机（仅桌面版）",
      descriptionKey: "agent.toolNetworkPing",
      toolKey: "network",
      risk: "read",
      retryable: false,
      desktopOnly: true,
      inputSchema: schema({ target: str(255), count: { type: "integer", minimum: 1, maximum: 10 } }, ["target"]),
    },
    {
      name: "network.trace",
      description: "路由跟踪目标主机（仅桌面版，最多 10 跳）",
      descriptionKey: "agent.toolNetworkTrace",
      toolKey: "network",
      risk: "read",
      retryable: false,
      desktopOnly: true,
      inputSchema: schema({ target: str(255), maxHops: { type: "integer", minimum: 1, maximum: 30 } }, ["target"]),
    },
    {
      name: "network.dns",
      description: "查询主机的 DNS 解析地址（仅桌面版）",
      descriptionKey: "agent.toolNetworkDns",
      toolKey: "network",
      risk: "read",
      retryable: false,
      desktopOnly: true,
      inputSchema: schema({ host: str(255) }, ["host"]),
    },
    {
      name: "network.tcp_check",
      description: "检测目标主机端口是否可连接（仅桌面版）",
      descriptionKey: "agent.toolNetworkTcpCheck",
      toolKey: "network",
      risk: "read",
      retryable: false,
      desktopOnly: true,
      inputSchema: schema({ host: str(255), port: { type: "integer", minimum: 1, maximum: 65535 } }, ["host", "port"]),
    },
  ],
};
