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
  // arcade 与 game 不合并：game 组是给**别人的游戏**做推理的辅助器，arcade 组自带玩法。
  { key: "arcade", labelKey: "toolbox.registry.groupArcade", icon: "target", descKey: "toolbox.registry.groupArcadeDesc" },];

export const TOOLBOX_TOOLS = [
  { key: "convert", labelKey: "toolbox.registry.toolConvert", icon: "repeat", category: "data", descKey: "toolbox.registry.toolConvertDesc", keywordsKey: "toolbox.registry.kwConvert", ready: true },
  { key: "table", labelKey: "toolbox.registry.toolTable", icon: "table", category: "data", descKey: "toolbox.registry.toolTableDesc", keywordsKey: "toolbox.registry.kwTable", ready: true },
  { key: "markdown", labelKey: "toolbox.registry.toolMarkdown", icon: "note", category: "data", descKey: "toolbox.registry.toolMarkdownDesc", keywordsKey: "toolbox.registry.kwMarkdown", ready: true },
  { key: "xml", labelKey: "toolbox.registry.toolXml", icon: "layers", category: "data", descKey: "toolbox.registry.toolXmlDesc", keywordsKey: "toolbox.registry.kwXml", ready: true },
  { key: "diff", labelKey: "toolbox.registry.toolDiff", icon: "text", category: "data", descKey: "toolbox.registry.toolDiffDesc", keywordsKey: "toolbox.registry.kwDiff", ready: true },
  { key: "schema", labelKey: "toolbox.registry.toolSchema", icon: "layout", category: "data", descKey: "toolbox.registry.toolSchemaDesc", keywordsKey: "toolbox.registry.kwSchema", ready: true },
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
  { key: "crypto", labelKey: "toolbox.registry.toolCrypto", icon: "shield", category: "development", descKey: "toolbox.registry.toolCryptoDesc", keywordsKey: "toolbox.registry.kwCrypto", ready: true },
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
  // 截图独占桌面的硬理由：全局热键、整屏捕获、置顶贴图窗都是 Windows 原生能力，
  // 浏览器/手机端没有对等物（网页拿不到整屏，也钉不住悬浮窗）。
  {
    key: "screenshot",
    labelKey: "toolbox.registry.toolScreenshot",
    icon: "crop",
    category: "file",
    descKey: "toolbox.registry.toolScreenshotDesc",
    keywordsKey: "toolbox.registry.kwScreenshot",
    ready: true,
    desktopOnly: true,
    window: { width: 860, height: 660, minWidth: 640, minHeight: 460 },
  },
  // 磁盘分析独占桌面的硬理由：浏览器/手机端拿不到目录树，而整盘几十万目录的
  // 遍历与体积聚合必须在原生侧做（放 WebView 里会把渲染线程卡死）。
  {
    key: "disk",
    labelKey: "toolbox.registry.toolDisk",
    icon: "hard-drive",
    category: "file",
    descKey: "toolbox.registry.toolDiskDesc",
    keywordsKey: "toolbox.registry.kwDisk",
    ready: true,
    desktopOnly: true,
    window: { width: 1160, height: 760, minWidth: 900, minHeight: 560 },
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
  { key: "downloader", labelKey: "toolbox.registry.toolDownloader", icon: "download", category: "network", descKey: "toolbox.registry.toolDownloaderDesc", keywordsKey: "toolbox.registry.kwDownloader", ready: true, desktopOnly: true },
  { key: "db", labelKey: "toolbox.registry.toolDb", icon: "database", category: "development", descKey: "toolbox.registry.toolDbDesc", keywordsKey: "toolbox.registry.kwDb", ready: true, desktopOnly: true },
  {
    key: "chat",
    labelKey: "toolbox.registry.toolChat",
    icon: "chat",
    category: "ai",
    descKey: "toolbox.registry.toolChatDesc",
    keywordsKey: "toolbox.registry.kwChat",
    ready: true,
  },
  // 自动签到桌面独占有两条硬理由，都不是「懒得做」：
  // 1. 签到请求要带 Cookie / Token，这些接口不开 CORS——浏览器端会被同源策略拦掉，
  //    而桌面端走 Rust reqwest 原生发出，不受 CORS 约束；
  // 2. 常驻定时依赖托盘与开机自启，浏览器页面关掉就没了，定时也就没了。
  // （注释放在对象外：手机端那条测试用「key 到 desktopOnly 不超过 300 字符」的正则核对
  //   桌面端确实标了 desktopOnly，注释放中间会把这条守卫撑爆。）
  {
    key: "checkin",
    labelKey: "toolbox.registry.toolCheckin",
    icon: "check",
    category: "ai",
    descKey: "toolbox.registry.toolCheckinDesc",
    keywordsKey: "toolbox.registry.kwCheckin",
    ready: true,
    desktopOnly: true,
    window: { width: 880, height: 640, minWidth: 620, minHeight: 460 },
  },
  {
    key: "netcapture",
    labelKey: "toolbox.registry.toolNetcapture",
    icon: "search",
    category: "network",
    descKey: "toolbox.registry.toolNetcaptureDesc",
    keywordsKey: "toolbox.registry.kwNetcapture",
    ready: true,
    desktopOnly: true,
    window: { width: 960, height: 700, minWidth: 680, minHeight: 480 },
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
  {
    key: "interview",
    labelKey: "toolbox.registry.toolInterview",
    icon: "book-open",
    category: "arcade",
    descKey: "toolbox.registry.toolInterviewDesc",
    keywordsKey: "toolbox.registry.kwInterview",
    ready: true,
    // 题库、检索、进度与导入解析全是纯前端模块（interviewBank/Progress/Import.js），
    // 浏览器端与手机端照常可刷，所以不标 desktopOnly——通勤路上刷两题正是它的目标场景。
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
