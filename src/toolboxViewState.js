// 工具箱首页的纯状态计算：快捷工具排序与分类展开状态。
// 抽成纯函数便于单测（Vitest node 环境不跑组件），视图只负责渲染与持久化。

/**
 * 组装首页「常用工具」快捷区：收藏 → 常用（使用次数 ≥2）→ 最近使用 → 注册表顺序，去重后按需补位。
 * 未开放的占位工具（ready === false）不进入快捷区，避免点了没反应。
 *
 * 频率单独用 usage 传（而不是从 recent 里数）：「最近使用」只留 8 条，
 * 用得最多但最近没用过的工具会被挤出那份列表，从 recent 里数它永远成不了"常用"。
 */
export function buildToolboxQuickList(tools = [], pinnedKeys = [], recent = [], max = 6, usage = {}) {
  const byKey = new Map(tools.map((tool) => [tool.key, tool]));
  const seen = new Set();
  const result = [];

  const add = (key) => {
    if (result.length >= max || seen.has(key) || !byKey.has(key) || byKey.get(key).ready === false) return;
    seen.add(key);
    result.push(byKey.get(key));
  };

  for (const key of Array.isArray(pinnedKeys) ? pinnedKeys : []) add(key);

  const stats = usage && typeof usage === "object" ? usage : {};
  const frequent = Object.entries(stats)
    .filter(([, stat]) => Number(stat?.count) >= 2)
    .sort((a, b) => Number(b[1].count) - Number(a[1].count) || Number(b[1].ts || 0) - Number(a[1].ts || 0))
    .map(([key]) => key);
  for (const key of frequent) add(key);

  for (const item of Array.isArray(recent) ? recent : []) add(item?.key);
  for (const tool of tools) add(tool.key);
  return result;
}

/** 切换某个大类的展开状态（允许同时展开多个大类）。 */
export function toggleExpandedGroup(keys = [], key = "") {
  if (!key) return Array.isArray(keys) ? [...keys] : [];
  const current = Array.isArray(keys) ? [...keys] : [];
  const index = current.indexOf(key);
  if (index >= 0) current.splice(index, 1);
  else current.push(key);
  return current;
}

/** 读取持久化的展开状态：过滤重复项与注册表里已不存在的大类。 */
export function normalizeExpandedGroups(keys = [], groups = []) {
  const valid = new Set(groups.map((group) => group.key));
  return [...new Set((Array.isArray(keys) ? keys : []).filter((key) => valid.has(key)))];
}
