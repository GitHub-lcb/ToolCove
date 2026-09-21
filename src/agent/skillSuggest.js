// 技能语义匹配：用 TypeSafe 的 System One 判断「这次目标该不该带上哪条沉淀经验」。
//
// 为什么需要它：skills.js 的关键词打分只看字面重合（「导出 csv」命中「导出 csv」），
// 换个说法就失效——「把订单表另存成表格文件」与「读取 order.json 导出 CSV」没有任何共同词，
// 但它们是同一件事。语义判断正是普通代码做不了、而 System One 擅长的那部分。
//
// 关键词匹配仍然保留为兜底：TypeSafe 未配置、超时、限流、或模型自己置信度过低时退回字面匹配。
// 一个可选增强不该让 Agent 变哑。
//
// 设计取舍（对齐 TypeSafe 的 skill_suggestion cookbook）：
//  - **正文进 state**：判断「哪条流程是对的」必须读到流程本身。只把名称/描述放进 criteria 时，
//    模型是在凭目录猜，而本项目技能正文最长 8000 字、恰恰是唯一有区分度的部分（文档明确
//    要求给问句足够的 state，criteria 只放判断口径）。正文按总预算截断，见 skillBodies。
//  - **默认形状是 rerank（逐条 Noul）**：一个 Choice 打 51 个选项时，近义技能会在 softmax 里
//    互相抢概率——分布被摊平，于是不得不加「选中的即使概率 0 也保留」这类补丁。
//    改成每条一个 Noul「这条流程是否适用于本次请求」后，每条的概率独立可用，
//    「都不合适」由 floor 自然表达，不再需要特殊出口（文档 rerank 配方同一形状）。
//    代价是必须先预筛候选（见 shortlistSkills），否则 token 随库大小线性增长。
//    Choice 形状保留着（shape: "choice"），因为换形状是否更好要用标注集实测，不能靠推断。
//  - **一次请求**：候选的 Noul + 三个 gate Noul 一次问完。
//    cookbook 用两次请求是因为它有 182 条技能、正文塞不下；本项目技能上限 50 条，
//    一次请求装得下，省一次往返（文档也说明批量提问几乎不增加响应时间）。
//  - **选项里带「都不合适」**（仅 Choice 形状需要）：Choice 的概率总和恒为 1，不给出口
//    模型就永远会选一个，「没有相关经验」这个最常见的正确答案反而表达不出来。
//  - **置信度分档**：Choice 的 confidence 是分布集中度，rerank 用最高那条的适用概率，
//    两者都表示「这次判断有多可信」，用它把没把握的请求退回关键词而不是硬注入。
//    注入是低代价可逆动作，所以只有极不确定才拦（见 CONF_LOW）。
//  - **gate 问句只依赖 state**：同一请求里的问句互相看不见对方的 criteria，
//    所以问句不能引用技能列表，只能问「这个请求本身是不是在要一次具体操作」。
//  - 问句指令用英文：Jev 的母语是英文，CJK 准确率偏低（见文档 Models#language-support）。
//    技能正文仍是用户自己的语言，那部分进 state，不翻译。
//
// 纯函数 + 注入式传输层：node 环境可直接单测，不 import Vue / Tauri。传输层见 typesafe.js。
import { buildClarifyQuestions, parseClarify } from "./clarify.js";
import { keywordsOf, matchSkills, scoreSkill, SKILL_MATCH_LIMIT, SKILL_MAX_ITEMS } from "./skills.js";

/** 默认模型别名（跟随 TypeSafe 的旗舰模型，不写死版本号）。 */
export const SKILL_SUGGEST_MODEL = "jev-latest";
/** 「都不合适」这个选项的名字。技能 id 一律是 skill-*，不会与之撞名。 */
export const NO_SKILL = "none of these fit";
/** gate 均值低于它就不带任何技能。cookbook 的起点值，应按自己的数据复测。 */
export const SKILL_SUGGEST_GATE = 0.3;
/** 单条技能概率低于它就不带（挡长尾）。模型明确选中的那条不受此限。 */
export const SKILL_SUGGEST_FLOOR = 0.15;
/** 单条技能正文进 state 的长度上限（技能正文里步骤行就这个量级，400 字够读完链路）。 */
export const SKILL_SUGGEST_BODY_CHARS = 400;
/** 单条正文可配上限：正文本身最长 SKILL_MAX_CHARS，再往上给没有意义。 */
const SKILL_MAX_BODY_CAP = 4000;
/** 正文再低也不值得发的下限：低到这条不如退回只带标签，否则是在为无意义的截断付 token。 */
const SKILL_SUGGEST_BODY_MIN = 80;
/** 全部技能正文进 state 的总预算。超预算先按比例压每条长度，压到地板就整体退回只带标签。 */
export const SKILL_SUGGEST_STATE_BUDGET = 12000;
/** pick 置信度高于它才认为语义判断可用（安静注入）。 */
export const SKILL_SUGGEST_CONF_HIGH = 0.6;
/** pick 置信度低于它就不信任语义结果，退回关键词匹配。 */
export const SKILL_SUGGEST_CONF_LOW = 0.35;
/**
 * 默认匹配形状。rerank=每条技能一个 Noul（概率独立、无 softmax 互扰），choice=一次多选一。
 * 换形状的收益要用 eval/skill-match 的标注集实测：`node scripts/eval-skill-match.mjs --mode=live --shape=both`
 * 会把两条路同一批用例上的 precision/recall 并排打出来。
 */
export const SKILL_SUGGEST_SHAPE = "rerank";
/** 预筛送进 rerank 的候选条数。配成 ≥ 技能库大小即等于不预筛（全量送，召回最高、token 最贵）。 */
export const SKILL_SUGGEST_CANDIDATES = 10;
/** rerank 问句的 id 前缀（后面接选项键）。 */
const APPLICABLE_PREFIX = "applicable::";
/** gate 问句的 id 前缀。 */
const GATE_PREFIX = "gate::";

const CHOICE_INSTRUCTIONS =
  "Which of these recorded procedures, if any, is the right one to follow for the request? " +
  "Judge each option by its full recorded steps under `state.skill_bodies`, keyed by the option name — " +
  "the option label is only a short summary and similar procedures differ in their steps.";

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

/** 可调旋钮的取值：只认有限数并夹到区间内，坏值退回默认（配置是用户可改的 JSON）。 */
function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * 技能正文进 state 的形态：保留换行（步骤行 `- tool（参数：…） → 结果` 的结构本身就是证据），
 * 只压掉连续空行与超长行。截断时补省略号，避免模型把半句话当成完整步骤。
 */
function bodyText(value, max) {
  const cleaned = text(value).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return "";
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/**
 * 组装 state.skill_bodies：选项键 → 正文。
 * 长度收口是**两级**而不是截断了事：先按单条上限截，总量化超预算时按候选数均摊重新截一遍；
 * 均摊后每条已短到读不出流程（低于 BODY_MIN）就整体退回「只带标签」——
 * 为一条被砍成 20 字的正文付 token，不如让模型至少看到完整的目录。
 */
function skillBodies(picks, options = {}) {
  const budget = num(options.stateBudget, SKILL_SUGGEST_STATE_BUDGET, 500, 200000);
  const perCap = num(options.bodyChars, SKILL_SUGGEST_BODY_CHARS, 40, SKILL_MAX_BODY_CAP);
  let cap = perCap;
  for (let pass = 0; pass < 2; pass++) {
    const bodies = {};
    let total = 0;
    for (const { key, skill } of picks) {
      const body = bodyText(skill.instructions, cap);
      if (!body) continue;
      bodies[key] = body;
      total += body.length;
    }
    if (total <= budget) return bodies;
    if (!picks.length) return {};
    cap = Math.floor(budget / picks.length);
    if (cap < SKILL_SUGGEST_BODY_MIN) return {};
  }
  return {};
}

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

/** Choice 形状：一次多选一，选项就是技能标签，附「都不合适」出口。 */
function choiceQuestions(picks) {
  const criteria = {};
  for (const { key, skill } of picks) criteria[key] = describeSkill(skill);
  criteria[NO_SKILL] = "None of the recorded procedures above is the right one for this request.";
  return { pick: { type: "choice", instructions: CHOICE_INSTRUCTIONS, criteria } };
}

/**
 * rerank 形状：每条候选一个 Noul。问的是「照这条流程做，是否就是本次请求要做的这件事」，
 * 而不是「主题像不像」——主题相近但动作不同（读文件 vs 写文件）必须答否。
 * 每条都把正文的位置写在问句里：同一请求内的问句互相看不见，只能靠 state 定位（文档要求）。
 */
function applicableQuestions(picks) {
  const questions = {};
  for (const { key } of picks) {
    questions[`${APPLICABLE_PREFIX}${key}`] = {
      type: "noul",
      instructions:
        "Would following the recorded procedure stored as `state.skill_bodies[\"" + key + "\"]` " +
        "carry out the task asked for in `state.goal`? Answer yes only if its steps actually do " +
        "that task; a procedure on a similar topic that does something else is a no.",
    };
  }
  return questions;
}

/**
 * 词面得分：scoreSkill 之外再看**正文**里的词。
 * 预筛是召回导向的——漏掉的候选模型再也选不回来，所以宁可放宽。评测集里那些改述句
 * （「变成能看的图片」↔ base64 解码）与名称零重合，只扫名称/关键词会把它们直接筛掉。
 */
function lexicalScore(skill, goal) {
  const value = flat(goal).toLowerCase();
  if (!value) return 0;
  let score = scoreSkill(skill, goal);
  const haystack = [text(skill.instructions), text(skill.description), text(skill.name)]
    .join(" ")
    .toLowerCase();
  for (const word of keywordsOf(goal)) {
    if (word.length >= 2 && haystack.includes(word)) score += 1;
  }
  return score;
}

/**
 * 预筛出送进 rerank 的候选。两种情况直接不筛：
 *  - 库本来就 ≤ 候选数：全量送才是最高召回，筛一下只是白丢
 *  - 分数并列时按 createdAt 倒序补位：名额不能空着，「最近沉淀过」是仅次于词面重合的先验
 */
export function shortlistSkills(skills, goal, options = {}) {
  const want = num(options.candidates, SKILL_SUGGEST_CANDIDATES, 1, SKILL_MAX_ITEMS);
  const list = (Array.isArray(skills) ? skills : []).filter((skill) => skill && typeof skill === "object");
  if (list.length <= want) return list;
  return list
    .map((skill) => ({ skill, score: lexicalScore(skill, goal) }))
    .sort(
      (a, b) =>
        b.score - a.score || (Number(b.skill.createdAt) || 0) - (Number(a.skill.createdAt) || 0)
    )
    .slice(0, want)
    .map((item) => item.skill);
}

/**
 * 组装运行前的那一次 System One 请求。返回 null 表示「没什么可问的」：目标为空，
 * 或既没有可用技能、也没开启歧义预判。
 * 返回 { body, picks, shape }：body 原样进 HTTP，picks 是「选项键 → 技能」的映射，只给解析用。
 * 分开是因为 body 要干净地进网络，而映射是本地的事，不该混进请求体。
 *
 * options.clarify 为真时，歧义预判的问句（clarify.js）并进同一份请求：
 * 它只依赖 state.goal，与技能、gate 问句互不依赖，符合「同一份 state 上的独立问题一起问」。
 */
export function buildSuggestRequest(skills, goal, options = {}) {
  const target = flat(goal);
  if (!target) return null;
  const disabled = new Set(Array.isArray(options.disabled) ? options.disabled : []);
  const usable = (Array.isArray(skills) ? skills : []).filter(
    (skill) => skill && typeof skill === "object" && flat(skill.id) && flat(skill.name) && !disabled.has(skill.id),
  );
  const clarify = options.clarify === true;
  if (!usable.length && !clarify) return null;
  const keys = optionKeys(usable.map((skill) => flat(skill.name)));
  const picks = usable.map((skill, index) => ({ key: keys[index], skill }));
  const shape = options.shape === "choice" ? "choice" : SKILL_SUGGEST_SHAPE;
  const questions = picks.length ? (shape === "choice" ? choiceQuestions(picks) : applicableQuestions(picks)) : {};
  if (clarify) Object.assign(questions, buildClarifyQuestions());
  for (const [id, instructions] of Object.entries(GATE_QUESTIONS)) {
    questions[id] = { type: "noul", instructions };
  }
  if (!Object.keys(questions).length) return null;
  return {
    body: {
      model: flat(options.model) || SKILL_SUGGEST_MODEL,
      state: { goal: target, skill_bodies: skillBodies(picks, options) },
      questions,
    },
    picks,
    shape,
  };
}

/** 逐条 Noul 的概率表：选项键 → 适用概率。缺失/坏值的答案直接不进表。 */
function applicability(picks, response) {
  const answers = response && response.answers;
  if (!answers || typeof answers !== "object") return [];
  const out = [];
  for (const { key, skill } of Array.isArray(picks) ? picks : []) {
    if (!skill) continue;
    const value = Number(answers[`${APPLICABLE_PREFIX}${key}`]?.noul);
    if (Number.isFinite(value)) out.push({ skill, score: value });
  }
  return out;
}

/**
 * 这次语义判断有多可信（0-1），两种形状统一成一个数：
 *  - Choice：读 `confidence`，它是分布集中度的压缩值
 *  - rerank：Noul 没有 confidence 字段，用最高那条的适用概率当把握
 * 注意它衡量的是「判断本身的确不确信」，不是「答得对不对」（文档 Confidence 一节明确）。
 * 没有任何可用答案时返回 null，由调用方按「没有这个信号」处理而不是「信号是 0」。
 */
export function pickConfidence(response, picks) {
  const choice = Number(response?.answers?.pick?.confidence);
  if (Number.isFinite(choice)) return choice;
  const scores = applicability(picks, response).map((item) => item.score);
  return scores.length ? Math.max(...scores) : null;
}

/**
 * 把响应翻译成与 matchSkills 同形的 { skill, score } 列表（score 即概率），
 * 这样 skillsPromptSection 不用改一行就能吃下两种来源。
 * 任何坏数据都退化成空列表：解析失败不该抛错，更不该把没把握的技能塞进 prompt。
 */
export function parseSuggestResponse(picks, response, options = {}) {
  const list = Array.isArray(picks) ? picks.filter((pick) => pick && pick.skill) : [];
  if (!list.length || !response || typeof response !== "object") return [];
  const threshold = Number.isFinite(options.gate) ? options.gate : SKILL_SUGGEST_GATE;
  if (gateValue(response) < threshold) return [];
  const floor = Number.isFinite(options.floor) ? options.floor : SKILL_SUGGEST_FLOOR;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : SKILL_MATCH_LIMIT;
  const pickAnswer = response.answers && response.answers.pick;
  // Choice 形状：概率分布在 pick.probabilities 里，argmax 是模型明确选中的那条
  if (pickAnswer && typeof pickAnswer === "object") {
    const probabilities = pickAnswer.probabilities;
    if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return [];
    const choice = flat(pickAnswer.choice);
    if (choice === NO_SKILL) return [];
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
  // rerank 形状：每条一个独立概率，低于 floor 的自然落选——不再需要「都不合适」出口
  return applicability(list, response)
    .filter((item) => item.score >= floor)
    .sort((a, b) => b.score - a.score || (Number(b.skill.createdAt) || 0) - (Number(a.skill.createdAt) || 0))
    .slice(0, limit);
}

/** 时间线只关心「带了哪几条」，用名称而不是整条技能。 */
const matchedNames = (matches) =>
  Array.isArray(matches) ? matches.map((item) => flat(item?.skill?.name)) : [];

/**
 * 挑出该注入 prompt 的技能：先问 TypeSafe，问不到就退回关键词匹配。
 * options：
 *  - transport(body, options) → 响应；不传即视为未配置 TypeSafe
 *  - fallback: false 关掉兜底（失败即空手而归，不静默降级）
 *  - onResult(info)：拿到本次判定的诊断（走了哪条路、置信度、耗时、usage、退回原因）。
 *    语义匹配是**可选增强**，它静默生效或静默失效都会让人无法归因，所以每次都要有个交代。
 *  - 其余透传：disabled / limit / gate / floor / model / shape / candidates /
 *    bodyChars / stateBudget / confidenceLow / confidenceHigh / minScore
 */
export async function suggestSkills(skills, goal, options = {}) {
  const report = (info) => {
    try {
      options.onResult?.(info);
    } catch {
      // 诊断回调本身出错不该影响匹配结果
    }
  };
  const shape = options.shape === "choice" ? "choice" : SKILL_SUGGEST_SHAPE;
  // rerank 要先预筛（Choice 形状一次装得下全量，不需要）：预筛只看词面，判断交给模型
  const pool = shape === "choice" ? skills : shortlistSkills(skills, goal, options);
  const built = buildSuggestRequest(pool, goal, { ...options, shape });
  if (!built) {
    report({ matcher: "none", reason: "no-candidates", matched: [] });
    return [];
  }
  const fallback = (reason, error) => {
    const matches = options.fallback === false ? [] : matchSkills(skills, goal, options);
    report({ matcher: "keyword", reason, error: text(error?.message), matched: matchedNames(matches) });
    return matches;
  };
  if (typeof options.transport !== "function") return fallback("not-configured");
  const startedAt = Date.now();
  try {
    const response = await options.transport(built.body, options);
    const confidence = pickConfidence(response, built.picks);
    const confLow = num(options.confidenceLow, SKILL_SUGGEST_CONF_LOW, 0, 1);
    const confHigh = num(options.confidenceHigh, SKILL_SUGGEST_CONF_HIGH, 0, 1);
    // 模型自己都没把握时，语义判断并不比字面匹配更可信——退回关键词。
    // 没有置信度信号时不拦：响应形状允许缺省，缺证据不等于反证据。
    if (confidence !== null && confidence < confLow) return fallback("low-confidence");
    const matches = parseSuggestResponse(built.picks, response, options);
    report({
      matcher: "typesafe",
      shape: built.shape,
      matched: matchedNames(matches),
      candidates: built.picks.length,
      confidence,
      // 歧义预判与技能匹配共用这一次请求，结论也一起交出去（没开 clarify 时是「没判」）
      clarify: options.clarify === true ? parseClarify(response, { threshold: options.clarifyAt }) : null,
      // 分档只区分「可直接用」与「用了但值得让人看见」：带技能是可逆的低成本动作，
      // 所以这里不做「中档去问用户」，只把中档标出来。
      tier: confidence !== null && confidence >= confHigh ? "high" : "marked",
      latencyMs: Date.now() - startedAt,
      usage: response && typeof response.usage === "object" ? response.usage : null,
    });
    return matches;
  } catch (error) {
    return fallback("transport-error", error);
  }
}
