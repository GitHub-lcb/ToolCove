// 接口抓包工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "netcapture",
  order: 240,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolNetcapture",
    icon: "search",
    category: "network",
    descKey: "toolbox.registry.toolNetcaptureDesc",
    keywordsKey: "toolbox.registry.kwNetcapture",
    ready: true,
    desktopOnly: true,
    window: { width: 960, height: 700, minWidth: 680, minHeight: 480 },
  },
  // 会话式观察工具：要人挑选目标应用、拉起调试端口并盯实时时间线，
  // 抓包会话的生命周期不在单步动作模型内。
  agentExempt: "会话式观察：目标选择与实时盯盘是人的环节",
};
