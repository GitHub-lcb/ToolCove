// 工具箱注册表：工具画廊、全局搜索等入口共用，避免名称和能力描述漂移。
// desktopOnly 标记桌面独占工具（浏览器端无对应原生能力），可见列表按平台过滤；
// scope 标记版本归属（personal/enterprise/both），可见列表再按版本过滤——
// 两个维度同构，visibleToolboxTools 做「平台 × 版本」双过滤。
//
// 数据不在本文件维护——每个工具的 UI 元数据与 Agent 动作声明都住在
// src/contracts/<key>.js（单一真相源），这里只做投影与检索帮助函数。
// 分组（TOOLBOX_GROUPS）同理，住在 src/contracts/groups.js。
// 新增工具 = 在 src/contracts/ 加一个契约文件并在 index.js 登记，
// 画廊/搜索/Agent 目录会同时出现它（准入规则由 contracts.test.js 强制）。
import { i18n } from "./i18n/index.js";
import { isDesktop, inEdition } from "./platform/env.js";
import { TOOL_CONTRACTS } from "./contracts/index.js";

const t = (key, params) => i18n.global.t(key, params);

// t() 不支持数组消息，kw* 关键词数组需直读字典（当前 locale 缺键时回退 en-US）
function readDictArray(key) {
  const path = key.split(".");
  const read = (dict) => path.reduce((o, k) => (o ? o[k] : undefined), dict);
  const local = read(i18n.global.messages.value[i18n.global.locale.value]);
  return local !== undefined ? local : read(i18n.global.messages.value[i18n.global.fallbackLocale.value]);
}

export { TOOLBOX_GROUPS } from "./contracts/groups.js";
import { TOOLBOX_GROUPS } from "./contracts/groups.js";

export const TOOLBOX_TOOLS = TOOL_CONTRACTS.map((contract) => ({ key: contract.key, scope: contract.scope, ...contract.ui }));

export function findToolboxTool(key, tools = TOOLBOX_TOOLS) {
  return tools.find((tool) => tool.key === key) || null;
}

/** 当前平台与版本可用的工具箱工具：浏览器端过滤掉依赖原生能力的工具，企业版过滤掉个人版独占工具。 */
export function visibleToolboxTools(tools = TOOLBOX_TOOLS) {
  return tools.filter((tool) => (isDesktop || !tool.desktopOnly) && inEdition(tool.scope));
}

export function groupToolboxTools(tools = TOOLBOX_TOOLS, groups = TOOLBOX_GROUPS) {
  return groups
    .map((group) => ({ ...group, tools: tools.filter((tool) => tool.category === group.key) }))
    .filter((group) => group.tools.length > 0);
}

/** 工具的关键词列表（当前语言）：注册表存的是字典键，直读字典才能拿到数组。 */
export function toolKeywords(tool) {
  return tool && tool.keywordsKey ? readDictArray(tool.keywordsKey) : [];
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
