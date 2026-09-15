// 工具箱首页的纯状态计算：快捷工具排序与分类展开状态。
// 抽成纯函数便于单测（Vitest node 环境不跑组件），视图只负责渲染与持久化。

/**
 * 组装首页「常用工具」快捷区：收藏 → 最近使用 → 注册表顺序，去重后按需补位。
 * 未开放的占位工具（ready === false）不进入快捷区，避免点了没反应。
 */
export function buildToolboxQuickList(tools = [], pinnedKeys = [], recent = [], max = 6) {
  const byKey = new Map(tools.map((tool) => [tool.key, tool]));
  const seen = new Set();
  const result = [];

  const add = (key) => {
    if (result.length >= max || seen.has(key) || !byKey.has(key) || byKey.get(key).ready === false) return;
    seen.add(key);
    result.push(byKey.get(key));
  };

  for (const key of Array.isArray(pinnedKeys) ? pinnedKeys : []) add(key);
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
