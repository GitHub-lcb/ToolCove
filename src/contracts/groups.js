// 工具箱分组：画廊与全局搜索共用的分组元数据（纯数据，零依赖）。
// 与工具契约同层：分组是工具的归属维度，单一真相源自然放在一起。
export const TOOLBOX_GROUPS = [
  { key: "data", labelKey: "toolbox.registry.groupData", icon: "braces", descKey: "toolbox.registry.groupDataDesc" },
  { key: "network", labelKey: "toolbox.registry.groupNetwork", icon: "network", descKey: "toolbox.registry.groupNetworkDesc" },
  { key: "file", labelKey: "toolbox.registry.groupFile", icon: "folder", descKey: "toolbox.registry.groupFileDesc" },
  { key: "development", labelKey: "toolbox.registry.groupDevelopment", icon: "wrench", descKey: "toolbox.registry.groupDevelopmentDesc" },
  { key: "ai", labelKey: "toolbox.registry.groupAi", icon: "sparkles", descKey: "toolbox.registry.groupAiDesc" },
  { key: "game", labelKey: "toolbox.registry.groupGame", icon: "train", descKey: "toolbox.registry.groupGameDesc" },
  // arcade 与 game 不合并：game 组是给**别人的游戏**做推理的辅助器，arcade 组自带玩法。
  { key: "arcade", labelKey: "toolbox.registry.groupArcade", icon: "target", descKey: "toolbox.registry.groupArcadeDesc" },
];
