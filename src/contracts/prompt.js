// 提示词工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "prompt",
  order: 230,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolPrompt",
    icon: "wand",
    category: "ai",
    descKey: "toolbox.registry.toolPromptDesc",
    keywordsKey: "toolbox.registry.kwPrompt",
    ready: true,
    desktopOnly: true,
    window: { width: 1180, height: 780, minWidth: 960, minHeight: 620 },
  },
  // 生图/生视频要连用户已配置的 ComfyUI 或云端点（配置缺失时动作注定失败），
  // 且单次生成以分钟计、超过单步执行预算；提示词库本身已由 data.* 动作读写。
  agentExempt: "依赖外部配置且生成时长超单步预算；提示词库已由 data.* 覆盖",
};
