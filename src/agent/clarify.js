// 运行前歧义预判：这个目标是否缺了「只有用户能补」的信息。
//
// 为什么需要它：Agent 最贵的错误不是报错，而是**替用户假设**——
// 「把上个月的订单导出」没说是哪个库、哪种格式，模型会挑一个看起来合理的走下去，
// 跑完十几步交付一份用户没要的东西。LLM 自己也会问，但它没有稳定口径：
// 同一个目标，问不问常常取决于措辞运气。
//
// 这一问给的是**把握**而不是决定：达门槛时在提示里加一句「先问清再动手」，
// 问不问、怎么问仍由模型决定（问句要贴着用户的语境，那正是 System One 不做的事）。
// 门槛给到 0.8（见 CLARIFY_HINT_AT）：宁可漏报也不能把每次运行都变成被反问，
// 与本项目「宁少勿滥」的取向一致。
//
// 为什么不单独发一次请求：问句只依赖 state.goal，与技能匹配的那几问是同一份 state 上的
// 独立判断（文档：并行问不额外增延迟、不互相影响答案）。多一次往返等于给每次运行加一段
// 用户能感觉到的等待，换来的只是职责上的一点整洁——不划算。所以问题定义在这里，
// 发请求与解析由 skillSuggest.js 的运行前那一次调用完成。
//
// 纯函数，不 import Vue / Tauri：node 环境可直接单测。

/** 默认模型别名（与 typesafe.js / skillSuggest.js 同值）。 */
export const CLARIFY_MODEL = "jev-latest";
/** 歧义概率高于它才提示「先问」：漏报比误报好，被无端反问的用户会关掉整个功能。 */
export const CLARIFY_HINT_AT = 0.8;
/** 「其实不缺信息」这个出口：Choice 必须有退路，否则模型永远会挑一项。 */
export const CLARIFY_NOTHING = "nothing beyond what is stated";
/** 问句 id 前缀（与技能匹配、gate 问句共用一次请求，靠前缀区分）。 */
export const CLARIFY_PREFIX = "clarify::";

const AMBIGUOUS_INSTRUCTIONS =
  "Does the request in `state.goal` leave out something that only the user can supply, such that any " +
  "guess about it could produce the wrong result? Answer no if the missing detail can be found with " +
  "tools, if it is already stated, or if an ordinary default would satisfy the user.";

const BLOCKER_INSTRUCTIONS =
  "Which single piece of information, obtainable only from the user, most blocks carrying out the " +
  "request in `state.goal`? Judge from what the request literally says; answer \"" +
  CLARIFY_NOTHING +
  "\" when nothing is actually missing.";

/** 最常卡住人的几类缺口。键是 ASCII，值进 criteria 说明；模型答回来的是键。 */
export const CLARIFY_BLOCKERS = {
  "target object": "which file, table, record or artifact to act on is not stated",
  "time range": "which dates or period is meant is not stated",
  "output format": "what format or destination the result should take is not stated",
  "data source": "which connection, environment or account to read from is not stated",
  "scope": "how wide the change should reach (one item or many) is not stated",
  [CLARIFY_NOTHING]: "the request states enough to proceed",
};

const text = (value) => (typeof value === "string" ? value : "");
const flat = (value) => text(value).replace(/\s+/g, " ").trim();

/** 这次要不要带上歧义预判：只依赖目标，因此可以并进任何一次带 goal 的 System One 请求。 */
export function buildClarifyQuestions() {
  return {
    [`${CLARIFY_PREFIX}ambiguous`]: { type: "noul", instructions: AMBIGUOUS_INSTRUCTIONS },
    [`${CLARIFY_PREFIX}blocker`]: { type: "choice", instructions: BLOCKER_INSTRUCTIONS, criteria: { ...CLARIFY_BLOCKERS } },
  };
}

/**
 * 从响应里读出歧义预判。缺问句或缺答案都算「没判」，不当成「不歧义」也不当成「歧义」。
 * 返回 { assessed, ambiguous, blocker, hint }
 */
export function parseClarify(response, options = {}) {
  const answers = response && response.answers;
  if (!answers || typeof answers !== "object") return { assessed: false, ambiguous: null, blocker: "", hint: false };
  const ambiguous = Number(answers[`${CLARIFY_PREFIX}ambiguous`]?.noul);
  if (!Number.isFinite(ambiguous)) return { assessed: false, ambiguous: null, blocker: "", hint: false };
  const at = Number.isFinite(options.threshold) ? options.threshold : CLARIFY_HINT_AT;
  // 缺什么：只在确实判为歧义时才读，否则「没缺口」与「没读」会被混成一谈
  let blocker = "";
  if (ambiguous >= at) {
    const picked = flat(answers[`${CLARIFY_PREFIX}blocker`]?.choice);
    if (picked && picked !== CLARIFY_NOTHING && picked in CLARIFY_BLOCKERS) blocker = picked;
  }
  return { assessed: true, ambiguous, blocker, hint: ambiguous >= at };
}

/**
 * 提示文本（进 planner 的提示里，不是界面文案，所以与 index.js 的提示同为中文、不走 i18n）。
 * 只给方向不给措辞：具体怎么问要贴着用户自己的说法，那是语言模型该做的判断。
 */
export function clarifyPromptLine(clarify) {
  if (!clarify || !clarify.hint) return "";
  const blocker = clarify.blocker ? `（最可能缺的是：${clarify.blocker}）` : "";
  return `语义预判：这次目标里似乎有只有用户能确定的信息${blocker}。若无法用工具查明，请先用 ask_user 问清再动手，不要替用户假设具体值。`;
}
