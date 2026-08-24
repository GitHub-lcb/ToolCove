// 工具箱注册表：工具画廊、全局搜索等入口共用，避免名称和能力描述漂移。
import { i18n } from "./i18n/index.js";

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
];

export const TOOLBOX_TOOLS = [
  { key: "convert", labelKey: "toolbox.registry.toolConvert", icon: "repeat", category: "data", descKey: "toolbox.registry.toolConvertDesc", keywordsKey: "toolbox.registry.kwConvert", ready: true },
  { key: "diff", labelKey: "toolbox.registry.toolDiff", icon: "text", category: "data", descKey: "toolbox.registry.toolDiffDesc", keywordsKey: "toolbox.registry.kwDiff", ready: true },
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
  { key: "network", labelKey: "toolbox.registry.toolNetwork", icon: "network", category: "network", descKey: "toolbox.registry.toolNetworkDesc", keywordsKey: "toolbox.registry.kwNetwork", ready: true },
  { key: "crypto", labelKey: "toolbox.registry.toolCrypto", icon: "shield", category: "development", descKey: "toolbox.registry.toolCryptoDesc", ready: true },
  { key: "file", labelKey: "toolbox.registry.toolFile", icon: "folder", category: "file", descKey: "toolbox.registry.toolFileDesc", keywordsKey: "toolbox.registry.kwFile", ready: true },
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
  { key: "request", labelKey: "toolbox.registry.toolRequest", icon: "send", category: "network", descKey: "toolbox.registry.toolRequestDesc", keywordsKey: "toolbox.registry.kwRequest", ready: true },
  { key: "db", labelKey: "toolbox.registry.toolDb", icon: "database", category: "development", descKey: "toolbox.registry.toolDbDesc", ready: true },
  {
    key: "chat",
    labelKey: "toolbox.registry.toolChat",
    icon: "chat",
    category: "ai",
    descKey: "toolbox.registry.toolChatDesc",
    keywordsKey: "toolbox.registry.kwChat",
    ready: true,
  },
];

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
