// 截图工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "screenshot",
  order: 140,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolScreenshot",
    icon: "crop",
    category: "file",
    descKey: "toolbox.registry.toolScreenshotDesc",
    keywordsKey: "toolbox.registry.kwScreenshot",
    ready: true,
    desktopOnly: true,
    window: { width: 860, height: 660, minWidth: 640, minHeight: 460 },
  },
  // 与 README 的刻意例外一致：框选、标注、贴图都是人的操作，不是 Agent 缺失。
  agentExempt: "human-in-the-loop：框选/标注/贴图是人的操作（刻意豁免）",
};
