// 导航分层：4 个一级模块（侧边栏）+ 设置；模块内再分 Tab。
// 纯数据 + 纯函数（App.vue / SettingsView.vue / migrate.js / GlobalSearch 共用一份真相，单测覆盖）。
// 旧十视图 key（home/domain/.../snippet）仅作为深链与设置迁移的输入保留在 LEGACY_VIEW_TARGET。

/** 侧边栏模块（数组顺序即展示顺序；设置不进列表，走 openSettings） */
export const NAV_MODULES = Object.freeze([
  { key: "agent", labelKey: "nav.agent", icon: "sparkles" },
  { key: "work", labelKey: "nav.work", icon: "layers" },
  { key: "records", labelKey: "nav.records", icon: "copy" },
  { key: "toolbox", labelKey: "nav.toolbox", icon: "wrench" },
]);

/** 模块内 Tab（数组顺序即 Tab 栏顺序）；无 Tab 的模块不出现在这里 */
export const MODULE_TABS = Object.freeze({
  work: Object.freeze([
    { key: "overview", labelKey: "nav.overview", icon: "home" },
    { key: "domain", labelKey: "nav.domain", icon: "layers" },
    { key: "iteration", labelKey: "nav.iteration", icon: "git-branch" },
    { key: "requirement", labelKey: "nav.requirement", icon: "bar-chart" },
    { key: "release", labelKey: "nav.release", icon: "upload" },
    { key: "task", labelKey: "nav.task", icon: "repeat" },
  ]),
  records: Object.freeze([
    { key: "snippet", labelKey: "nav.snippet", icon: "copy" },
    { key: "problem", labelKey: "nav.problem", icon: "alert" },
  ]),
});

/** 进入模块（或深链缺 tab）时的默认 Tab */
export const MODULE_HOME_TAB = Object.freeze({ work: "overview", records: "snippet" });

/** 旧视图 key → 新坐标。深链解析与 hiddenModules 迁移共用同一张表 */
export const LEGACY_VIEW_TARGET = Object.freeze({
  home: { module: "work", tab: "overview" },
  domain: { module: "work", tab: "domain" },
  iteration: { module: "work", tab: "iteration" },
  requirement: { module: "work", tab: "requirement" },
  release: { module: "work", tab: "release" },
  task: { module: "work", tab: "task" },
  snippet: { module: "records", tab: "snippet" },
  problem: { module: "records", tab: "problem" },
});

/** 合法的一级模块 key（含不进侧边栏的设置） */
export const NAV_MODULE_KEYS = Object.freeze(NAV_MODULES.map((m) => m.key).concat("settings"));

/**
 * 解析导航目标：接受旧视图 key（{module:'iteration'}）与新坐标（{module:'work', tab:'iteration'}）。
 * 返回 {module, tab}（无 Tab 的模块 tab 为 null）；无法识别返回 null（调用方忽略该次跳转）。
 */
export function resolveNavTarget(input) {
  const module = input && typeof input.module === "string" ? input.module : "";
  const tab = input && typeof input.tab === "string" ? input.tab : "";
  const legacy = LEGACY_VIEW_TARGET[module];
  if (legacy) return { module: legacy.module, tab: legacy.tab };
  if (!NAV_MODULE_KEYS.includes(module)) return null;
  const tabs = MODULE_TABS[module];
  if (!tabs) return { module, tab: null };
  return { module, tab: tabs.some((x) => x.key === tab) ? tab : MODULE_HOME_TAB[module] };
}

/**
 * 隐藏模块迁移（schema v7→v8）：旧十视图 key 归并到新四模块，去重保序。
 * 幂等：已是新 key 的值原样保留；无法识别（含历史脏值）丢弃。
 */
export function migrateHiddenModulesV1(hidden) {
  if (!Array.isArray(hidden)) return hidden;
  const out = [];
  for (const key of hidden) {
    const target = LEGACY_VIEW_TARGET[key]?.module || (NAV_MODULE_KEYS.includes(key) ? key : null);
    if (!target || out.includes(target)) continue;
    out.push(target);
  }
  return out;
}
