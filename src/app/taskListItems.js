// 侧边栏「任务列表为主体」的纯投影函数（二期导航重构，见 docs/agent-workspace-plan.md）。
// 与 navConfig.js 同一约束：纯数据 + 纯函数 + 单测覆盖——App.vue / AgentSidePanel.vue
// 只消费结果，不在组件里重算，保证「任务行长什么样」有一处可测的真相源。

/** 侧边栏任务列表一次最多展示的条数（runs 全量最多 30 条，侧边栏只给一屏） */
export const TASK_LIST_LIMIT = 20;

/**
 * agentSession.runs → 侧边栏任务行。
 * runs 已是最新在前（session.js 用 unshift 落记录），这里只截前 limit 条、不重排，
 * 避免侧边栏与引擎落盘顺序出现两套真相。
 * 只带渲染所需字段；now 是时间基准注入点（测试可固定），当前行数据不派生时间文本——
 * 相对时间在组件侧渲染（要随界面语言走，见 shared/dates.js 的 relativeTime）。
 */
export function buildTaskItems(runs, { limit = TASK_LIST_LIMIT, now = Date.now() } = {}) {
  void now; // 预留：行内若将来要派生「进行中时长」等时间文本，从这里取基准
  if (!Array.isArray(runs)) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 0;
  return runs.slice(0, cap).map((rec) => ({
    id: rec && rec.id ? String(rec.id) : "",
    status: rec && typeof rec.status === "string" ? rec.status : "",
    input: rec && typeof rec.input === "string" ? rec.input : "",
    updatedAt: Number(rec?.updatedAt || rec?.createdAt) || 0,
  }));
}

/**
 * 「工作面」分组：一级模块里挑出可收进分组的项，再按用户的 hiddenModules 过滤。
 * agent 永不入组、也永不可隐藏——二期重构后侧边栏没有 agent 按钮：它是默认主区，
 * 任务列表就是它的历史。即使 hiddenKeys 里残留 "agent"（v9 迁移前的历史脏值）也剔除，
 * 否则「隐藏 agent」会把默认主区弄丢。
 */
export function groupNavModules(modules, hiddenKeys) {
  const hidden = new Set(Array.isArray(hiddenKeys) ? hiddenKeys : []);
  hidden.delete("agent");
  return (Array.isArray(modules) ? modules : []).filter((m) => m && m.key !== "agent" && !hidden.has(m.key));
}
