// 侧边栏「会话列表为主体」的纯投影函数（三期导航重构，见 docs/agent-workspace-plan.md）。
// 与 navConfig.js 同一约束：纯数据 + 纯函数 + 单测覆盖——App.vue / AgentSidePanel.vue
// 只消费结果，不在组件里重算，保证「会话行长什么样、怎么分组」有一处可测的真相源。
//
// 为什么从「任务列表」改叫「会话列表」：一次 run 是**一轮**执行，而人心里的一条历史是
// 「我跟它说过的那件事」。列表仍是 runs 的投影（引擎没有会话模型），但对外只承诺
// 「一行 = 一次历史运行」，标题、分组、搜索三件事都在这里定死，将来引擎真长出会话
// 模型时替换的也只是这一层。

/** 侧边栏会话列表一次最多展示的条数（runs 全量最多 30 条，侧边栏只给一屏） */
export const TASK_LIST_LIMIT = 20;

/** 标题字符上限。超长在此截断并补省略号，完整目标仍走 title 属性。 */
export const TITLE_MAX = 42;

/**
 * 目标原文 → 一行标题。
 *
 * 为什么不能直接把 input 丢进行里（旧实现的做法）：目标往往是一段带换行的长描述，
 * 两行截断之后每条看起来都像同一句话的开头，列表失去可扫读性；而主流 agent 产品
 * 的历史行给的都是**主题**（Qoder/ChatGPT/Claude 自动起题，Zed 还能改名重生成）。
 * 我们没有一次额外的模型调用可以拿来起题，所以退到「本地可算的最好版本」：
 *   1. 换行/连续空白压成单空格——多行目标只留首行语义；
 *   2. 去掉结尾的句号/问号等收尾标点，标题不该以标点结束；
 *   3. 超过 TITLE_MAX 时**优先在断句处切**（。！？；.?!; 或空格），切不动才硬截。
 * 与「截断首条消息」的弱实现（Cursor）的区别就在第 3 步：断句处切出来的是短语，
 * 硬截出来的是半句话。
 */
export function conversationTitle(input, { max = TITLE_MAX } = {}) {
  const text = typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  const cap = Number.isInteger(max) && max > 0 ? max : TITLE_MAX;
  const trimmed = text.length > cap ? cutAtBoundary(text, cap) : text;
  return trimmed.replace(/[。．.！!？?；;，,、：:\s]+$/, "") || trimmed;
}

/**
 * 在预算内挑一个最靠后的断句点切；找不到断句点再退回硬截。
 * 断句点必须落在 max 之后的一半以上，否则「你好。」这种开头就断的会切出一个字的标题。
 */
function cutAtBoundary(text, max) {
  const window = text.slice(0, max + 1);
  const floor = Math.floor(max / 2);
  let cut = -1;
  for (let i = window.length - 1; i >= floor; i--) {
    if (/[。．.！!？?；;，,、\s]/.test(window[i])) {
      cut = i;
      break;
    }
  }
  return cut > 0 ? window.slice(0, cut) : text.slice(0, max) + "…";
}

/** 行标题：用户重命名优先，否则用目标派生主题。 */
function titleOf(rec) {
  const custom = typeof rec?.title === "string" ? rec.title.replace(/\s+/g, " ").trim() : "";
  return custom || conversationTitle(rec?.input);
}

/**
 * agentSession.runs → 侧边栏会话行（当前列表：不含已归档）。
 * runs 已是最新在前（session.js 用 unshift 落记录），这里只截前 limit 条、不重排，
 * 避免侧边栏与引擎落盘顺序出现两套真相。
 * 只带渲染所需字段；now 是时间基准注入点（测试可固定），当前行数据不派生时间文本——
 * 相对时间在组件侧渲染（要随界面语言走，见 shared/dates.js 的 relativeTime）。
 */
export function buildTaskItems(runs, { limit = TASK_LIST_LIMIT, now = Date.now() } = {}) {
  void now; // 预留：行内若将来要派生「进行中时长」等时间文本，从这里取基准
  if (!Array.isArray(runs)) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 0;
  return runs
    .filter((rec) => rec && !rec.archived)
    .slice(0, cap)
    .map((rec) => ({
      id: rec && rec.id ? String(rec.id) : "",
      status: rec && typeof rec.status === "string" ? rec.status : "",
      // 目标原文（搜索要匹配它，行内 title 属性也给全文）
      input: rec && typeof rec.input === "string" ? rec.input : "",
      // 行内显示的主题：用户重命名优先，否则目标派生
      title: titleOf(rec),
      pinned: rec?.pinned === true,
      // 模型快照：只进 title/tooltip，不占列表行的视觉空间
      model: rec && typeof rec.model === "string" ? rec.model : "",
      updatedAt: Number(rec?.updatedAt || rec?.createdAt) || 0,
    }));
}

/** 已归档会话：与当前列表同一投影，单独成区（默认折叠）。 */
export function buildArchivedItems(runs, { limit = TASK_LIST_LIMIT } = {}) {
  if (!Array.isArray(runs)) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 0;
  return runs
    .filter((rec) => rec && rec.archived)
    .slice(0, cap)
    .map((rec) => ({
      id: rec && rec.id ? String(rec.id) : "",
      status: rec && typeof rec.status === "string" ? rec.status : "",
      input: rec && typeof rec.input === "string" ? rec.input : "",
      title: titleOf(rec),
      pinned: rec?.pinned === true,
      model: rec && typeof rec.model === "string" ? rec.model : "",
      updatedAt: Number(rec?.updatedAt || rec?.createdAt) || 0,
    }));
}

/** 搜索结果上限：搜索是「找回某一条」，不是第二份完整列表。 */
export const SEARCH_LIMIT = 30;

/**
 * 关键词过滤。匹配**标题与目标全文**两个字段——旧实现只匹配 input，
 * 而标题是压过空白的，用户按标题里看到的词去搜必须能搜到（主流的搜索也都覆盖
 * 用户消息与模型回复，见 Qoder 的「搜索任务标题或会话内容」）。
 * 大小写不敏感；空查询原样返回（调用方据此决定要不要显示分组头）。
 */
export function filterTaskItems(items, query, { limit = SEARCH_LIMIT } = {}) {
  const list = Array.isArray(items) ? items : [];
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q) return list;
  const cap = Number.isInteger(limit) && limit > 0 ? limit : list.length;
  return list.filter((item) => `${item?.title || ""}\n${item?.input || ""}`.toLowerCase().includes(q)).slice(0, cap);
}

/** 分组顺序即渲染顺序；key 只做 i18n 查表，中文标签在词条里。 */
export const HISTORY_GROUPS = Object.freeze(["pinned", "running", "today", "yesterday", "week", "older"]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地自然日的零点（相对时间用毫秒差，分组必须用日历天——23:59 与 00:01 差 2 分钟却跨组）。 */
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 相差几个日历天。用两个本地零点之差再取整，而不是 `(now - ts) / DAY_MS`：
 * 夏令时切换那天两个零点相隔 23 或 25 小时，直接相除会算出 0.958 天这种值，
 * 「昨天」就会漏判。取整把 ±1 小时的漂移吸收掉，跨时区/跨夏令时都对。
 */
function dayDiff(ts, now) {
  return Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
}

/** 一条记录落到哪个分组。置顶优先；运行中/等待中的单独成组——它们最需要被看见。 */
export function groupKeyFor(item, now = Date.now()) {
  if (item?.pinned) return "pinned";
  const status = item?.status || "";
  if (status === "running" || status === "pending") return "running";
  const ts = Number(item?.updatedAt) || 0;
  if (!ts) return "older";
  const days = dayDiff(ts, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 7) return "week";
  return "older";
}

/**
 * 按时间分组，空组不出现（组件直接 v-for，不必再判空）。
 * 组内保持 runs 的原顺序（最新在前）。
 */
export function groupTaskItems(items, { now = Date.now() } = {}) {
  const list = Array.isArray(items) ? items : [];
  const buckets = new Map(HISTORY_GROUPS.map((key) => [key, []]));
  for (const item of list) buckets.get(groupKeyFor(item, now))?.push(item);
  return HISTORY_GROUPS.map((key) => ({ key, items: buckets.get(key) })).filter((group) => group.items.length);
}

/**
 * 「工作面」分组：一级模块里挑出可收进分组的项，再按用户的 hiddenModules 过滤。
 * agent 永不入组、也永不可隐藏——导航重构后侧边栏没有 agent 按钮：它是默认主区，
 * 会话列表就是它的历史。即使 hiddenKeys 里残留 "agent"（v9 迁移前的历史脏值）也剔除，
 * 否则「隐藏 agent」会把默认主区弄丢。
 */
export function groupNavModules(modules, hiddenKeys) {
  const hidden = new Set(Array.isArray(hiddenKeys) ? hiddenKeys : []);
  hidden.delete("agent");
  return (Array.isArray(modules) ? modules : []).filter((m) => m && m.key !== "agent" && !hidden.has(m.key));
}
