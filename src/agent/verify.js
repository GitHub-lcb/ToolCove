// 结果核验：Agent 说「已完成」之后，用 System One 回头问一句「工具真的做了吗」。
//
// 为什么需要它：runtime 只能判断**协议**对不对（有没有返回合法 JSON、工具调没报错），
// 判不了**语义**——模型完全可以调了一个返回 0 行的查询，然后答「已找到 12 条重复记录」。
// 这类「声称与证据不符」是本地智能体最伤信任的失败模式，而它恰好是普通代码写不出的判断：
// 「这段话是不是被那些返回值支持」既不是字符串比对，也不是规则能穷举的。
//
// 三个检查各问一件事（文档的 verify-and-escalate 形状）：
//  - executed：是真做了，还是只在**描述**要怎么做
//  - grounded：答案里的具体数字/路径/名字，是否真出现在工具返回里
//  - complete：目标的每一部分是否都有对应的观察
// 每条都是 Noul，同一份 state 上并行问，一次请求拿全（文档说明批量不额外增延迟）。
//
// 核验**不改答案也不拦运行**：它只在时间线上留一行「哪几项没把握、需要人看」。
// 理由是本项目对个人数据的处置原则——自动改结论比标出疑点更危险。
//
// 纯函数 + 注入式传输层：不 import Vue / Tauri，node 环境可直接单测。网络在 typesafe.js。

/** 默认模型别名（与 typesafe.js / skillSuggest.js 同值）。 */
export const VERIFY_MODEL = "jev-latest";
/** 三项里最低的那一项低于它，就提示人工复核（对「已声称完成」的结论要给紧的口径）。 */
export const VERIFY_REVIEW_BELOW = 0.5;
/** 最多带几步观察：核验看的是「有没有做过」，最后几步足够，全带只是付 token。 */
const VERIFY_MAX_STEPS = 8;
/** 单步观察的字符上限（工具结果可能是整个文件）。 */
const VERIFY_STEP_CHARS = 600;
/** 检查问句的 id 前缀。 */
const CHECK_PREFIX = "check::";

/** 三项检查：id → 问句。id 是给代码用的，不会送进模型。 */
export const VERIFY_CHECKS = {
  executed:
    "Do the observations in `state.observations` show that the assistant actually carried out the task in `state.goal`, rather than only planning or describing how it would be done?",
  grounded:
    "Is every concrete value stated in `state.answer` (numbers, counts, file paths, names, identifiers) present in or directly derivable from `state.observations`?",
  complete:
    "Does `state.observations` cover every part of what `state.goal` asks for, with nothing left silently skipped?",
};

const text = (value) => (typeof value === "string" ? value : "");
const flat = (value) => text(value).replace(/\s+/g, " ").trim();

/** 一步观察：工具名 + 成败 + 结果摘要（摘要保留结构，模型要靠它对上答案里的数字）。 */
function observationOf(step) {
  const tool = flat(step?.action?.tool) || "unknown";
  const error = flat(step?.error);
  if (error) return `${tool} 失败：${error.slice(0, 200)}`;
  const result = step?.result;
  if (result == null) return `${tool}：无返回值`;
  const digest = typeof result === "string" ? result : safeJson(result);
  return `${tool}：${digest.length > VERIFY_STEP_CHARS ? `${digest.slice(0, VERIFY_STEP_CHARS - 1)}…` : digest}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 把运行历史压成观察列表（只留工具调用，倒序的最后 VERIFY_MAX_STEPS 步）。 */
export function observationsOf(history) {
  const steps = (Array.isArray(history) ? history : []).filter((step) => step?.action?.type === "tool_call");
  return steps.slice(-VERIFY_MAX_STEPS).map(observationOf);
}

/**
 * 组装一次核验请求。返回 null 表示「没什么可核验的」：
 * 没有观察（纯问答的运行不核验）、或没有答案。
 */
export function buildVerifyRequest({ goal, answer, history, model } = {}) {
  const target = flat(goal);
  const claim = flat(answer);
  const observations = observationsOf(history);
  if (!target || !claim || !observations.length) return null;
  const questions = {};
  for (const [id, instructions] of Object.entries(VERIFY_CHECKS)) {
    questions[`${CHECK_PREFIX}${id}`] = { type: "noul", instructions };
  }
  return {
    body: {
      model: flat(model) || VERIFY_MODEL,
      state: { goal: target, answer: claim.slice(0, 4000), observations },
      questions,
    },
    checks: Object.keys(VERIFY_CHECKS),
  };
}

/**
 * 解析核验结果：{ scores, weakest }。没有的答案不进 scores，
 * 全部缺失时 weakest 为 null —— 那是「没核成」，不等于「不可信」。
 */
export function parseVerifyResponse(response) {
  const answers = response && response.answers;
  const scores = {};
  if (answers && typeof answers === "object") {
    for (const id of Object.keys(VERIFY_CHECKS)) {
      const value = Number(answers[`${CHECK_PREFIX}${id}`]?.noul);
      if (Number.isFinite(value)) scores[id] = value;
    }
  }
  const values = Object.values(scores);
  return { scores, weakest: values.length ? Math.min(...values) : null };
}

/**
 * 核验一次「已完成」。永远不抛错：核验失败就当没核验，不能因此让已经产出的答案消失。
 * 返回 { verified, scores, weakest, needsReview, reason }
 */
export async function verifyOutcome({ goal, answer, history, transport, threshold } = {}) {
  const built = buildVerifyRequest({ goal, answer, history });
  if (!built) return { verified: false, reason: "nothing-to-verify", scores: {}, weakest: null, needsReview: false };
  if (typeof transport !== "function") return { verified: false, reason: "not-configured", scores: {}, weakest: null, needsReview: false };
  let response;
  try {
    response = await transport(built.body);
  } catch (error) {
    return { verified: false, reason: "transport-error", error: text(error?.message), scores: {}, weakest: null, needsReview: false };
  }
  const { scores, weakest } = parseVerifyResponse(response);
  const limit = Number.isFinite(threshold) ? threshold : VERIFY_REVIEW_BELOW;
  return {
    verified: weakest !== null,
    scores,
    weakest,
    // 缺分数不拦（缺证据不等于反证据），有分数且低于口径才要求人工复核
    needsReview: weakest !== null && weakest < limit,
    reviewOf: weakest === null ? [] : Object.entries(scores).filter(([, value]) => value < limit).map(([key]) => key),
    usage: response && typeof response.usage === "object" ? response.usage : null,
  };
}
