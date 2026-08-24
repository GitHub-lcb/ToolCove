// 设置页辅助逻辑。Coding 系列配置函数不随 ToolCove 迁移，此处仅保留侧边栏模块隐藏列表归一。

// 侧边栏模块展示/隐藏：只保留当前存在的模块 key，去重且保持顺序
export function normalizeHiddenModules(allKeys, hidden) {
  const keys = Array.isArray(allKeys) ? allKeys.filter((k) => typeof k === "string") : [];
  const list = Array.isArray(hidden) ? hidden : [];
  const seen = new Set();
  const result = [];
  for (const key of list) {
    if (!keys.includes(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}
