// 手机端工具箱的目录：分组、可用性、后续接哪些。
//
// 桌面端有 15 个工具（`src/toolboxTools.js`）。手机端不是简单照搬：
//   · 双端通用（JSON/转换/时间/生成/请求/图片/PDF/加密/文本 diff）→ 逐个移动端化；
//   · 平台独占（文件/数据库/标签打印/网络诊断）→ 按安卓现实降级或替换（见 docs/mobile-app-plan.md §1）；
//   · 游戏辅助（铁路大亨）→ 求解逻辑在 src/tools/railTycoon.js，桌面端在用，手机端后续作为一个工具回归。
//
// `ready` 为 false 的条目在界面上**如实标注「迁移中」**，而不是画一个点不动的入口——
// 这是从旧悬浮面板学到的：看起来能用但点了没反应，比明确说没做更糟。

/** 工具分组（key 与桌面端 toolboxTools.js 的 category 同名，便于对照）。 */
export const TOOL_GROUPS = Object.freeze([
  { key: "data", labelKey: "toolbox.registry.groupData" },
  { key: "development", labelKey: "toolbox.registry.groupDevelopment" },
  { key: "network", labelKey: "toolbox.registry.groupNetwork" },
  { key: "file", labelKey: "toolbox.registry.groupFile" },
  { key: "ai", labelKey: "toolbox.registry.groupAi" },
  { key: "game", labelKey: "toolbox.registry.groupGame" },
]);

/**
 * 工具清单。
 *  - key：与桌面端工具箱同名（同一条数据，两端口径一致）；
 *  - labelKey：沿用桌面端 `toolbox.registry.tool*`，**名字永远两边一致**，不另起一套；
 *  - ready：手机端是否已可用（未迁移的在界面上显示「迁移中」）；
 *  - note：降级说明（平台独占能力要写清「为什么不能做」）。
 */
export const TOOLS = Object.freeze([
  { key: "json", group: "data", labelKey: "toolbox.registry.toolJson", ready: true },
  { key: "convert", group: "data", labelKey: "toolbox.registry.toolConvert", ready: true },
  { key: "diff", group: "data", labelKey: "toolbox.registry.toolDiff", ready: true },
  { key: "time", group: "data", labelKey: "toolbox.registry.toolTime", ready: true },
  { key: "crypto", group: "development", labelKey: "toolbox.registry.toolCrypto", ready: true },
  { key: "generator", group: "development", labelKey: "toolbox.registry.toolGenerator", ready: true },
  { key: "db", group: "development", labelKey: "toolbox.registry.toolDb", ready: true, note: "mobile.noteDb" },
  { key: "request", group: "network", labelKey: "toolbox.registry.toolRequest", ready: true },
  { key: "network", group: "network", labelKey: "toolbox.registry.toolNetwork", ready: true, note: "mobile.noteNetwork" },
  { key: "file", group: "file", labelKey: "toolbox.registry.toolFile", ready: true, note: "mobile.noteFile" },
  { key: "image", group: "file", labelKey: "toolbox.registry.toolImage", ready: true },
  { key: "pdf", group: "file", labelKey: "toolbox.registry.toolPdf", ready: true },
  { key: "label", group: "file", labelKey: "toolbox.registry.toolLabel", ready: true, note: "mobile.noteLabel" },
  { key: "chat", group: "ai", labelKey: "toolbox.registry.toolChat", ready: true },
  { key: "rail", group: "game", labelKey: "toolbox.registry.toolRail", ready: true },
]);

export const TOOL_BY_KEY = Object.freeze(Object.fromEntries(TOOLS.map((tool) => [tool.key, tool])));

/** 按分组取工具（保持清单顺序，界面因此不会每次渲染都跳序）。 */
export function toolsOfGroup(group) {
  return TOOLS.filter((tool) => tool.group === group);
}

/** 已可用 / 全部 的数量，用于给用户一个「迁移到哪了」的直观进度。 */
export function progressOf(tools = TOOLS) {
  const total = tools.length;
  const ready = tools.filter((tool) => tool.ready).length;
  return { ready, total, pct: total ? Math.round((ready / total) * 100) : 0 };
}
