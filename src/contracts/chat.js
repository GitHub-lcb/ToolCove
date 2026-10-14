// AI 对话工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "chat",
  order: 210,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolChat",
    icon: "chat",
    category: "ai",
    descKey: "toolbox.registry.toolChatDesc",
    keywordsKey: "toolbox.registry.kwChat",
    ready: true,
  },
  // Agent 运行本身就是与模型对话；工具内的多轮会话是人与模型的直接交互。
  agentExempt: "对话即本体：Agent 运行已是对话，工具内会话是人的直接交互",
};
