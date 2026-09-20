// 技能语义匹配：用 TypeSafe 的 System One 判断「这次目标该不该带上哪条沉淀经验」。
//
// 为什么需要它：skills.js 的关键词打分只看字面重合（「导出 csv」命中「导出 csv」），
// 换个说法就失效——「把订单表另存成表格文件」与「读取 order.json 导出 CSV」没有任何共同词，
// 但它们是同一件事。语义判断正是普通代码做不了、而 System One 擅长的那部分。
//
// 关键词匹配仍然保留为兜底：TypeSafe 未配置、超时、限流时退回字面匹配。
// 一个可选增强不该让 Agent 变哑。
//
// 设计取舍（对齐 TypeSafe 的 skill_suggestion cookbook）：
//  - **一次请求**：Choice 排全部技能 + 三个 gate Noul 判断「这次到底要不要经验」。
//    cookbook 用两次请求是因为它有 182 条技能、正文塞不下；本项目技能上限 50 条，
//    一次请求装得下，省一次往返（文档也说明批量提问几乎不增加响应时间）。
//  - **选项里带「都不合适」**：Choice 的概率总和恒为 1，不给出口模型就永远会选一个，
//    「没有相关经验」这个最常见的正确答案反而表达不出来（文档明确建议加 none 项）。
//    这比「按概率设阈值」更可靠，也更贴合本项目「宁少勿滥」的取向。
//  - **gate 问句只依赖 state**：同一请求里的问句互相看不见对方的 criteria，
//    所以问句不能引用技能列表，只能问「这个请求本身是不是在要一次具体操作」。
//  - 问句指令用英文：Jev 的母语是英文，CJK 准确率偏低（见文档 Models#language-support）。
//    技能正文仍是用户自己的语言，那部分进 state，不翻译。
//
// 纯函数 + 注入式传输层：node 环境可直接单测，不 import Vue / Tauri。传输层见 typesafe.js。
import { matchSkills, SKILL_MATCH_LIMIT } from "./skills.js";

/** 默认模型别名（跟随 TypeSafe 的旗舰模型，不写死版本号）。 */
export const SKILL_SUGGEST_MODEL = "jev-latest";
/** 「都不合适」这个选项的名字。技能 id 一律是 skill-*，不会与之撞名。 */
export const NO_SKILL = "none of these fit";
/** gate 均值低于它就不带任何技能。cookbook 的起点值，应按自己的数据复测。 */
export const SKILL_SUGGEST_GATE = 0.3;
/** 单条技能概率低于它就不带（挡长尾）。模型明确选中的那条不受此限。 */
export const SKILL_SUGGEST_FLOOR = 0.15;
/** gate 问句的 id 前缀。 */
const GATE_PREFIX = "gate::";

const CHOICE_INSTRUCTIONS =
  "Which of these recorded procedures, if any, is the right one to follow for the request?";

/**
 * gate 问句：判断「这次请求要不要一条现成的操作路径」。
 * 三句都只描述请求本身（不看技能列表），其中一句反向计分。
 * 问的是「要不要动手」而不是「属于什么主题」——主题问句分不出
 * 「解释一下什么是 CSV」和「把数据导出成 CSV」，两者都是软件话题。
 */
const GATE_QUESTIONS = {
  "gate::acts_on_data":
    "Is the assistant being asked to carry out a concrete task on data — reading, transforming, querying, or writing it — rather than only to explain or advise?",
  "gate::follows_recorded_procedure":
    "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
  "gate::prose_suffices":
    "Could a knowledgeable generalist fully satisfy this request in prose, with no tools and no access to the user's files or data?",
};
/** 反向计分的 gate：这一句越像「是」，越不需要经验。 */
const INVERTED_GATES = new Set(["gate::prose_suffices"]);

const text = (value) => (typeof value === "string" ? value : "");
const flat = (value) => text(value).replace(/\s+/g, " ").trim();

/** 技能在选项里的说明文字：名称 + 描述 + 工具链，够模型分辨相似的两条。 */
function describeSkill(skill) {
  const parts = [flat(skill.name)];
  if (flat(skill.description)) parts.push(flat(skill.description));
  const tools = (Array.isArray(skill.toolNames) ? skill.toolNames : []).map(flat).filter(Boolean);
  if (tools.length) parts.push(`tools: ${tools.join(" → ")}`);
  return parts.join(" | ");
}

/**
 * 选项键：用技能名（模型读得懂），重名时补序号。
 * 不能直接用 id 当键——那样模型读到的选项名是一串随机串，分辨力全压在说明文字上。
 * 也不能不管重名——同名技能会在 criteria 这个 map 里互相覆盖，等于有一条永远选不中。
 */
function optionKeys(names) {
  const taken = new Set();
  return names.map((name) => {
    let key = name;
    let n = 2;
    while (taken.has(key)) key = `${name} (${n++})`;
    taken.add(key);
    return key;
  });
}

/** gate 均值：反向问句先翻正，再取平均。一个 gate 都没答时返回 1（不拿缺失数据拦人）。 */
function gateValue(response) {
  const answers = response && response.answers;
  if (!answers || typeof answers !== "object") return 1;
  let sum = 0;
  let count = 0;
  for (const [id, answer] of Object.entries(answers)) {
    if (!id.startsWith(GATE_PREFIX)) continue;
    const noul = Number(answer && answer.noul);
    if (!Number.isFinite(noul)) continue;
    sum += INVERTED_GATES.has(id) ? 1 - noul : noul;
    count++;
  }
  return count ? sum / count : 1;
}

/**
 * 组装一次 TypeSafe 请求。返回 null 表示「没什么可问的」：没有可用技能、或目标为空。
 * 返回 { body, picks }：body 原样进 HTTP，picks 是「选项键 → 技能」的映射，只给解析用。
 * 分开是因为 body 要干净地进网络，而映射是本地的事，不该混进请求体。
 */
export function buildSuggestRequest(skills, goal, options = {}) {
  const target = flat(goal);
  if (!target) return null;
  const disabled = new Set(Array.isArray(options.disabled) ? options.disabled : []);
  const usable = (Array.isArray(skills) ? skills : []).filter(
    (skill) => skill && typeof skill === "object" && flat(skill.id) && flat(skill.name) && !disabled.has(skill.id),
  );
  if (!usable.length) return null;
  const keys = optionKeys(usable.map((skill) => flat(skill.name)));
  const picks = usable.map((skill, index) => ({ key: keys[index], skill }));
  const criteria = {};
  for (const { key, skill } of picks) criteria[key] = describeSkill(skill);
  criteria[NO_SKILL] = "None of the recorded procedures above is the right one for this request.";
  const questions = { pick: { type: "choice", instructions: CHOICE_INSTRUCTIONS, criteria } };
  for (const [id, instructions] of Object.entries(GATE_QUESTIONS)) {
    questions[id] = { type: "noul", instructions };
  }
  return {
    body: { model: flat(options.model) || SKILL_SUGGEST_MODEL, state: { goal: target }, questions },
    picks,
  };
}

/**
 * 把响应翻译成与 matchSkills 同形的 { skill, score } 列表（score 即概率），
 * 这样 skillsPromptSection 不用改一行就能吃下两种来源。
 * 任何坏数据都退化成空列表：解析失败不该抛错，更不该把没把握的技能塞进 prompt。
 */
export function parseSuggestResponse(picks, response, options = {}) {
  const list = Array.isArray(picks) ? picks.filter((pick) => pick && pick.skill) : [];
  const answer = response && response.answers && response.answers.pick;
  if (!list.length || !answer || typeof answer !== "object") return [];
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return [];
  const threshold = Number.isFinite(options.gate) ? options.gate : SKILL_SUGGEST_GATE;
  if (gateValue(response) < threshold) return [];
  const choice = flat(answer.choice);
  if (choice === NO_SKILL) return [];
  const floor = Number.isFinite(options.floor) ? options.floor : SKILL_SUGGEST_FLOOR;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : SKILL_MATCH_LIMIT;
  const matched = [];
  for (const { key, skill } of list) {
    const value = Number(probabilities[key]);
    const probability = Number.isFinite(value) ? value : 0;
    // 模型明确选中的那条即使概率为 0 也保留：选择本身就是证据
    if (key !== choice && probability < floor) continue;
    matched.push({ skill, score: probability });
  }
  return matched.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * 挑出该注入 prompt 的技能：先问 TypeSafe，问不到就退回关键词匹配。
 * options：
 *  - transport(body, options) → 响应；不传即视为未配置 TypeSafe
 *  - fallback: false 关掉兜底（失败即空手而归，不静默降级）
 *  - 其余透传：disabled / limit / gate / floor / model / minScore
 */
export async function suggestSkills(skills, goal, options = {}) {
  const built = buildSuggestRequest(skills, goal, options);
  if (!built) return [];
  const fallback = () => (options.fallback === false ? [] : matchSkills(skills, goal, options));
  if (typeof options.transport !== "function") return fallback();
  try {
    return parseSuggestResponse(built.picks, await options.transport(built.body, options), options);
  } catch {
    return fallback();
  }
}
