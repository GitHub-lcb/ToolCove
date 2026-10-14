// 磁盘分析工具契约：UI 元数据 + Agent 豁免声明，单一真相源（聚合见 index.js）。
export default {
  key: "disk",
  order: 150,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolDisk",
    icon: "hard-drive",
    category: "file",
    descKey: "toolbox.registry.toolDiskDesc",
    keywordsKey: "toolbox.registry.kwDisk",
    ready: true,
    desktopOnly: true,
    window: { width: 1160, height: 760, minWidth: 900, minHeight: 560 },
  },
  // 全盘扫描以分钟计，远超单步执行预算（上限 120s）；要接需要先有一步多动作与
  // 进度流协议（见 docs/agent-dsh-borrow.md P1-5），不是简单包一层命令。
  agentExempt: "扫描体量超过单步执行预算，需进度流协议先行（P1-5 后再评估）",
};
