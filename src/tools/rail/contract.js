// 铁路大亨辅助工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "rail",
  order: 260,
  scope: "personal",
  ui: {
    labelKey: "toolbox.registry.toolRail",
    icon: "train",
    category: "game",
    descKey: "toolbox.registry.toolRailDesc",
    keywordsKey: "toolbox.registry.kwRail",
    ready: true,
    window: { width: 760, height: 340, minWidth: 560, minHeight: 250 },
  },
  // 游戏辅助：站点推断的结论要人对着游戏画面验证，操作本身也是人在玩。
  agentExempt: "human-in-the-loop：游戏判断与操作是人的环节",
};
