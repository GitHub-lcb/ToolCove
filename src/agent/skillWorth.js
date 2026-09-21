// 技能沉淀准入：这次运行值不值得存成「下次自动带上」的经验。
//
// 为什么要拦：技能库是 Agent 唯一会自己变长的部分，而它同时是语义匹配的候选池——
// 一条「查一下今天的天气」被存下来，之后每次相似目标都会把它带进 prompt。
// 库被一次性任务污染是**复利式**的损害：匹配变差 → 用户更懒得整理 → 更脏。
//
// 现有门槛（skills.js 的 extractSkill）只看结构：运行成功、至少调过一次工具、正文不太短。
// 但「结构完整」不等于「值得复用」，而后者正是代码写不出的判断：
// 它取决于这次的目标是不是只在当下这一刻成立（特定的日期、某一个文件名、临时起意的问题）。
//
// 两项检查（文档的 verify-and-escalate 形状，两项都只依赖 state）：
//  - reusable：换个时间、换个文件，这条流程还值得再走一遍吗
//  - transferable：把里面的具体值换成同类任务的其他值，步骤还成立吗
// 第二项刻意与第一项分开问：一条流程可以「将来还会用到」但「换个参数就不对了」
// （例如「核对某个具体下载包的摘要」——动作可复用，路径是一次性的）。
//
// 这是**建议性**门槛：判否也不锁死用户，界面可以「仍要沉淀」（见 session.promoteRunToSkill 的 force）。
// 没配 TypeSafe 时完全不发声，保持现有行为。
//
// 纯函数 + 注入式传输层：不 import Vue / Tauri，node 环境可直接单测。

/** 默认模型别名（与 typesafe.js / skillSuggest.js 同值）。 */
export const SKILL_WORTH_MODEL = "jev-latest";
/** 两项里最低的那一项低于它，就建议不沉淀（沉淀的代价是长期污染候选池，口径要给严）。 */
export const SKILL_WORTH_MIN = 0.5;
/** 检查问句的 id 前缀。 */
const CHECK_PREFIX = "worth::";

/** 两项检查：id → 问句。问的是这条运行本身，不引用别的问句的答案。 */
export const SKILL_WORTH_CHECKS = {
  reusable:
    "Would following this recorded procedure be worth doing again for a *similar future* request, " +
    "rather than only for this one occasion (a particular date, one specific file, or an ad-hoc question)?",
  transferable:
    "If the concrete values in `state.steps` (file names, numbers, dates, identifiers) were replaced " +
    "with different ones from a similar task, would the recorded steps still make sense?",
};

const text = (value) => (typeof value === "string" ? value : "");
const flat = (value) => text(value).replace(/\s+/g, " ").trim();
/** 一步的骨架：工具名 + 参数键（不带参数值——值是一次性的，正是我们要判断的东西）。 */
function stepOf(step) {
  const tool = flat(step?.action?.tool);
  if (!tool) return "";
  const keys = step?.action?.args && typeof step.action.args === "object" ? Object.keys(step.action.args).slice(0, 6) : [];
  return `${tool}(${keys.join(", ")})`;
}

/**
 * 组装一次准入判断请求。返回 null 表示「没什么可判的」：
 * 没有工具调用（结构门槛都过不了，轮不到语义判断）或目标为空。
 */
export function buildWorthRequest(run, options = {}) {
  const goal = flat(run?.input);
  const steps = (Array.isArray(run?.history) ? run.history : []).map(stepOf).filter(Boolean);
  if (!goal || !steps.length) return null;
  const questions = {};
  for (const [id, instructions] of Object.entries(SKILL_WORTH_CHECKS)) {
    questions[`${CHECK_PREFIX}${id}`] = { type: "noul", instructions };
  }
  return {
    body: {
      model: flat(options.model) || SKILL_WORTH_MODEL,
      state: {
        goal,
        // 只给骨架与最终答复：具体值留在观察里会诱导模型认为「这条就是为这个值做的」
        steps: steps.slice(0, 12),
        outcome: flat(run?.answer || run?.finalAnswer).slice(0, 600),
      },
      questions,
    },
    checks: Object.keys(SKILL_WORTH_CHECKS),
  };
}

/** 分数表 + 最低项。全部缺失时 weakest 为 null（那是「没判成」，不是「不值得」）。 */
export function parseWorthResponse(response) {
  const answers = response && response.answers;
  const scores = {};
  if (answers && typeof answers === "object") {
    for (const id of Object.keys(SKILL_WORTH_CHECKS)) {
      const value = Number(answers[`${CHECK_PREFIX}${id}`]?.noul);
      if (Number.isFinite(value)) scores[id] = value;
    }
  }
  const values = Object.values(scores);
  return { scores, weakest: values.length ? Math.min(...values) : null };
}

/**
 * 判断这条运行值不值得沉淀。永不抛错：准入判断失败就当作「没判」，按现有结构门槛放行——
 * 一个可选的增强不该让用户点「沉淀为技能」却没反应。
 * 返回 { assessed, reusable, weakest, low }
 */
export async function assessSkillWorth({ run, transport, model, threshold } = {}) {
  const built = buildWorthRequest(run, { model });
  if (!built) return { assessed: false, reason: "nothing-to-judge", reusable: true, weakest: null, low: [] };
  if (typeof transport !== "function") return { assessed: false, reason: "not-configured", reusable: true, weakest: null, low: [] };
  let response;
  try {
    response = await transport(built.body);
  } catch (error) {
    return { assessed: false, reason: "transport-error", error: text(error?.message), reusable: true, weakest: null, low: [] };
  }
  const { scores, weakest } = parseWorthResponse(response);
  const limit = Number.isFinite(threshold) ? threshold : SKILL_WORTH_MIN;
  const low = Object.entries(scores).filter(([, value]) => value < limit).map(([key]) => key);
  return {
    assessed: weakest !== null,
    reusable: weakest === null || weakest >= limit,
    weakest,
    low,
    scores,
  };
}
