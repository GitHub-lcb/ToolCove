// 自动签到工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "checkin",
  ui: {
    labelKey: "toolbox.registry.toolCheckin",
    icon: "check",
    category: "ai",
    descKey: "toolbox.registry.toolCheckinDesc",
    keywordsKey: "toolbox.registry.kwCheckin",
    ready: true,
    desktopOnly: true,
    window: { width: 880, height: 640, minWidth: 620, minHeight: 460 },
  },
  // 每日签到已由托盘调度自动完成；手动补签是人在工具里点一下的事。
  // 接入要复用 runner 的依赖装配（凭据/状态落盘），收益低而成本高——暂不豁免解除。
  agentExempt: "调度已覆盖：每日签到由托盘自动跑，手动补签是人的明确意图",
};
