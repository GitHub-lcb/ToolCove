// 面试刷题工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "interview",
  scope: "personal",
  ui: {
    labelKey: "toolbox.registry.toolInterview",
    icon: "book-open",
    category: "arcade",
    descKey: "toolbox.registry.toolInterviewDesc",
    keywordsKey: "toolbox.registry.kwInterview",
    ready: true,
  },
  // 刷题的意义在于人亲自作答与自评；Agent 代答违背工具目的。
  agentExempt: "human-in-the-loop：学习环节，人必须亲自作答",
};
