// 工具箱注册表：工具画廊、全局搜索等入口共用，避免名称和能力描述漂移。
// desktopOnly 标记桌面独占工具（浏览器端无对应原生能力），可见列表按平台过滤。
import { i18n } from "./i18n/index.js";
import { isDesktop } from "./platform/env.js";

const t = (key, params) => i18n.global.t(key, params);

// t() 不支持数组消息，kw* 关键词数组需直读字典（当前 locale 缺键时回退 en-US）
function readDictArray(key) {
  const path = key.split(".");
  const read = (dict) => path.reduce((o, k) => (o ? o[k] : undefined), dict);
  const local = read(i18n.global.messages.value[i18n.global.locale.value]);
  return local !== undefined ? local : read(i18n.global.messages.value[i18n.global.fallbackLocale.value]);
}

export const TOOLBOX_GROUPS = [
  { key: "data", labelKey: "toolbox.registry.groupData", icon: "braces", descKey: "toolbox.registry.groupDataDesc" },
  { key: "network", labelKey: "toolbox.registry.groupNetwork", icon: "network", descKey: "toolbox.registry.groupNetworkDesc" },
  { key: "file", labelKey: "toolbox.registry.groupFile", icon: "folder", descKey: "toolbox.registry.groupFileDesc" },
  { key: "development", labelKey: "toolbox.registry.groupDevelopment", icon: "wrench", descKey: "toolbox.registry.groupDevelopmentDesc" },
  { key: "ai", labelKey: "toolbox.registry.groupAi", icon: "sparkles", descKey: "toolbox.registry.groupAiDesc" },
  { key: "game", labelKey: "toolbox.registry.groupGame", icon: "train", descKey: "toolbox.registry.groupGameDesc" },
];

export const TOOLBOX_TOOLS = [
  { key: "convert", labelKey: "toolbox.registry.toolConvert", icon: "repeat", category: "data", descKey: "toolbox.registry.toolConvertDesc", keywordsKey: "toolbox.registry.kwConvert", ready: true },
  { key: "table", labelKey: "toolbox.registry.toolTable", icon: "table", category: "data", descKey: "toolbox.registry.toolTableDesc", keywordsKey: "toolbox.registry.kwTable", ready: true },
  { key: "markdown", labelKey: "toolbox.registry.toolMarkdown", icon: "text", category: "data", descKey: "toolbox.registry.toolMarkdownDesc", keywordsKey: "toolbox.registry.kwMarkdown", ready: true },
  { key: "xml", labelKey: "toolbox.registry.toolXml", icon: "braces", category: "data", descKey: "toolbox.registry.toolXmlDesc", keywordsKey: "toolbox.registry.kwXml", ready: true },
  { key: "diff", labelKey: "toolbox.registry.toolDiff", icon: "text", category: "data", descKey: "toolbox.registry.toolDiffDesc", keywordsKey: "toolbox.registry.kwDiff", ready: true },
  { key: "schema", labelKey: "toolbox.registry.toolSchema", icon: "braces", category: "data", descKey: "toolbox.registry.toolSchemaDesc", keywordsKey: "toolbox.registry.kwSchema", ready: true },
  { key: "time", labelKey: "toolbox.registry.toolTime", icon: "clock", category: "data", descKey: "toolbox.registry.toolTimeDesc", keywordsKey: "toolbox.registry.kwTime", ready: true },
  {
    key: "json",
    labelKey: "toolbox.registry.toolJson",
    icon: "braces",
    category: "data",
    descKey: "toolbox.registry.toolJsonDesc",
    keywordsKey: "toolbox.registry.kwJson",
    ready: true,
  },
  { key: "network", labelKey: "toolbox.registry.toolNetwork", icon: "network", category: "network", descKey: "toolbox.registry.toolNetworkDesc", keywordsKey: "toolbox.registry.kwNetwork", ready: true, desktopOnly: true },
  { key: "crypto", labelKey: "toolbox.registry.toolCrypto", icon: "shield", category: "development", descKey: "toolbox.registry.toolCryptoDesc", ready: true },
  { key: "file", labelKey: "toolbox.registry.toolFile", icon: "folder", category: "file", descKey: "toolbox.registry.toolFileDesc", keywordsKey: "toolbox.registry.kwFile", ready: true, desktopOnly: true },
  {
    key: "image",
    labelKey: "toolbox.registry.toolImage",
    icon: "image",
    category: "file",
    descKey: "toolbox.registry.toolImageDesc",
    keywordsKey: "toolbox.registry.kwImage",
    ready: true,
  },
  {
    key: "generator",
    labelKey: "toolbox.registry.toolGenerator",
    icon: "dice",
    category: "data",
    descKey: "toolbox.registry.toolGeneratorDesc",
    keywordsKey: "toolbox.registry.kwGenerator",
    ready: true,
  },
  {
    key: "pdf",
    labelKey: "toolbox.registry.toolPdf",
    icon: "file",
    category: "file",
    descKey: "toolbox.registry.toolPdfDesc",
    keywordsKey: "toolbox.registry.kwPdf",
    ready: true,
  },
  { key: "request", labelKey: "toolbox.registry.toolRequest", icon: "send", category: "network", descKey: "toolbox.registry.toolRequestDesc", keywordsKey: "toolbox.registry.kwRequest", ready: true },
  { key: "db", labelKey: "toolbox.registry.toolDb", icon: "database", category: "development", descKey: "toolbox.registry.toolDbDesc", ready: true, desktopOnly: true },
  {
    key: "chat",
    labelKey: "toolbox.registry.toolChat",
    icon: "chat",
    category: "ai",
    descKey: "toolbox.registry.toolChatDesc",
    keywordsKey: "toolbox.registry.kwChat",
    ready: true,
  },
  {
    key: "label",
    labelKey: "toolbox.registry.toolLabel",
    icon: "printer",
    category: "file",
    descKey: "toolbox.registry.toolLabelDesc",
    keywordsKey: "toolbox.registry.kwLabel",
    ready: true,
    desktopOnly: true,
  },
  {
    key: "rail",
    labelKey: "toolbox.registry.toolRail",
    icon: "train",
    category: "game",
    descKey: "toolbox.registry.toolRailDesc",
    keywordsKey: "toolbox.registry.kwRail",
    ready: true,
    // 这个工具是「显示辅助」：要能压在游戏画面上，默认窗口矮而宽——路线行水平铺开，
    // 卡片贴合内容，窗口里不留大块空白。可在标题栏用图钉置顶。不写则用 toolWindow.js 的通用尺寸。
    // 760×340 是驾驶舱（四段式：工具栏 / 路线行 / 录入 / 提醒）实测的贴合尺寸；
    // 再窄（<620）路线行折两行、录入与提醒改竖排，由 .rail-tool 整体滚动——仍可用，但不是默认体验。
    // 版面预算见 RailTycoonTool.vue 的版面骨架注释。
    window: { width: 760, height: 340, minWidth: 560, minHeight: 250 },
  },
];

export function findToolboxTool(key, tools = TOOLBOX_TOOLS) {
  return tools.find((tool) => tool.key === key) || null;
}

/** 当前平台可用的工具箱工具：浏览器端过滤掉依赖原生能力的工具。 */
export function visibleToolboxTools(tools = TOOLBOX_TOOLS) {
  return isDesktop ? tools : tools.filter((tool) => !tool.desktopOnly);
}

export function groupToolboxTools(tools = TOOLBOX_TOOLS, groups = TOOLBOX_GROUPS) {
  return groups
    .map((group) => ({ ...group, tools: tools.filter((tool) => tool.category === group.key) }))
    .filter((group) => group.tools.length > 0);
}

export function searchToolboxTools(query, tools = TOOLBOX_TOOLS, groups = TOOLBOX_GROUPS) {
  const keyword = String(query ?? "").trim().toLowerCase();
  if (!keyword) return [];
  const groupByKey = new Map(groups.map((g) => [g.key, g]));
  return tools.filter((tool) => {
    const group = groupByKey.get(tool.category) || {};
    const haystack = [
      tool.key,
      t(tool.labelKey),
      t(group.labelKey),
      t(tool.descKey),
      ...(tool.keywordsKey ? readDictArray(tool.keywordsKey) : []),
    ];
    return haystack.some((value) => String(value ?? "").toLowerCase().includes(keyword));
  });
}
