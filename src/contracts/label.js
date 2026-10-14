// 标签打印工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "label",
  ui: {
    labelKey: "toolbox.registry.toolLabel",
    icon: "printer",
    category: "file",
    descKey: "toolbox.registry.toolLabelDesc",
    keywordsKey: "toolbox.registry.kwLabel",
    ready: true,
    desktopOnly: true,
  },
  // 与 docs/agent-architecture.md 一致：物理副作用，要人核对介质与打印机——刻意豁免。
  agentExempt: "物理副作用：打印消耗介质，需人核对打印机与纸张（刻意豁免）",
};
