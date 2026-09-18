// 技能库：把一次成功的运行沉淀成「下次自动带上」的经验。
//
// 为什么需要它：24 个内置工具是静态的、只能减不能加，模型每次都从零开始推导同一个目标。
// 用户自己的成功路径（用什么工具、按什么顺序、参数长什么样）是最便宜也最贴身的扩展点。
//
// 设计取舍（对标 DSH 的技能目录）：
//  - **目录只投 name + description**：正文只有在命中时才进 prompt。否则每次运行都要把全部技能
//    正文塞进上下文，token 立刻失控。
//  - 技能是**提示**不是强制：它写进 prompt 的是「上次这么做成了」，模型仍按当前情况判断。
//  - 关键词匹配优先用**用户自己的话**（目标原文、工具名、参数键），不依赖 i18n 文案——
//    否则中英切换会让匹配结果变样。
//
// 纯函数、不 import Vue / Tauri：node 环境可直接单测。持久化在 skillStore.js。
import { safeJsonSize } from "./resultBudget.js";

/** 技能条数上限（落盘治理，与 skillStore 共用）。 */
export const SKILL_MAX_ITEMS = 50;
/** 单条技能上限（含名称/关键词/工具名等元信息的整体预算）。 */
export const SKILL_MAX_CHARS = 8000;
/** 正文留出的余量：名称、描述、关键词、工具名也要占整体预算，不留余量会导致「截断后仍超上限」。 */
const INSTRUCTIONS_RESERVE = 200;
/** 一次运行最多注入几条技能（宁少勿滥，挤掉的是任务上下文）。 */
export const SKILL_MATCH_LIMIT = 3;
/** 注入正文的总预算。 */
export const SKILL_PROMPT_BUDGET = 2000;
/** 低于这个分不算命中：乱带技能比不带更糟。 */
export const SKILL_MIN_SCORE = 3;
/** 名称/描述上限（目录里每行都占 token）。 */
const NAME_LIMIT = 40;
const DESC_LIMIT = 120;
const KEYWORD_LIMIT = 12;
/** 单个关键词/工具名的字符上限：整体预算有限，元信息不能无限长。 */
const KEYWORD_CHARS = 24;
const NAME_CHARS = 40;
const TOOL_NAME_LIMIT = 24;
const STEP_LINE_LIMIT = 160;

/** 中文停用词：这些词在任何目标里都出现，拿来做匹配等于没匹配。 */
const STOPWORDS = new Set([
  "的", "了", "和", "与", "把", "被", "在", "是", "我", "你", "他", "它", "们", "这", "那", "个", "些",
  "请", "帮", "给", "从", "到", "对", "为", "并", "就", "都", "也", "还", "要", "会", "能", "可以",
  "然后", "接着", "一下", "一个", "这个", "那个", "什么", "怎么", "如何", "以及", "或者", "但是",
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was", "were",
  "please", "then", "than", "them", "they", "have", "has", "had", "will", "would", "should", "could",
  "can", "may", "might", "must", "not", "but", "all", "any", "our", "its", "use", "using", "get",
]);

const text = (value) => (typeof value === "string" ? value : "");
const flat = (value) => text(value).replace(/\s+/g, " ").trim();

/** 取一步的工具名（技能正文里就是这些名字在提示模型「上次走了这条路」）。 */
export function toolNamesOf(run) {
  const steps = Array.isArray(run?.history) ? run.history : [];
  const names = [];
  for (const step of steps) {
    if (step?.action?.type !== "tool_call") continue;
    const name = flat(step.action.tool);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** 名称：取目标首行截断。太长会让技能目录本身变成噪音。 */
export function skillNameOf(goal) {
  const first = flat(text(goal).split("\n")[0]);
  if (!first) return "";
  return first.length > NAME_LIMIT ? `${first.slice(0, NAME_LIMIT - 1)}…` : first;
}

/** 描述：一句话说清「这条技能是干嘛的」，目录里只用它。 */
export function skillDescriptionOf(run) {
  const tools = toolNamesOf(run);
  const chain = tools.slice(0, 4).join(" → ");
  const more = tools.length > 4 ? ` → …(+${tools.length - 4})` : "";
  if (!chain) return "";
  const desc = `${flat(run?.input).slice(0, 40)}｜${chain}${more}`;
  return desc.length > DESC_LIMIT ? `${desc.slice(0, DESC_LIMIT - 1)}…` : desc;
}

/** 关键词：拉丁词（≥3 字母）+ 中文二元组，去停用词、去重、限量。 */
export function keywordsOf(source) {
  const value = flat(source);
  if (!value) return [];
  const found = new Set();
  for (const word of value.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || []) {
    if (!STOPWORDS.has(word)) found.add(word);
  }
  for (const chunk of value.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i + 2 <= chunk.length; i++) {
      const pair = chunk.slice(i, i + 2);
      if (!STOPWORDS.has(pair)) found.add(pair);
    }
  }
  return [...found].slice(0, KEYWORD_LIMIT);
}

/** 一步的结果摘要（与 history.js 同思路，但更短）。 */
function resultHint(step) {
  if (flat(step?.error)) return `失败：${flat(step.error).slice(0, 80)}`;
  const value = step?.result;
  if (value == null) return "";
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === "object") return Object.keys(value).slice(0, 5).join(", ");
  return flat(value).slice(0, 60);
}

/** 正文：目标 + 工具链 + 关键参数/结果 + 收尾纪律。 */
export function buildInstructions(run) {
  const goal = flat(run?.input);
  const steps = Array.isArray(run?.history) ? run.history : [];
  const lines = [`目标：${goal}`];
  const used = [];
  for (const step of steps) {
    if (step?.action?.type !== "tool_call") continue;
    const name = flat(step.action.tool);
    if (!name) continue;
    const args = step.action.args && typeof step.action.args === "object" ? Object.keys(step.action.args).slice(0, 6).join(", ") : "";
    const hint = resultHint(step);
    const line = `- ${name}${args ? `（参数：${args}）` : ""}${hint ? ` → ${hint}` : ""}`;
    lines.push(line.length > STEP_LINE_LIMIT ? `${line.slice(0, STEP_LINE_LIMIT)}…` : line);
    used.push(name);
  }
  if (used.length) lines.push(`用到的工具：${[...new Set(used)].join(", ")}`);
  lines.push("按这条路径执行时仍需按当前实际情况判断；参数要重新核对，不要照抄上次的具体值。");
  const body = lines.join("\n");
  return body.length > SKILL_MAX_CHARS - INSTRUCTIONS_RESERVE ? `${body.slice(0, SKILL_MAX_CHARS - INSTRUCTIONS_RESERVE - 1)}…` : body;
}

/**
 * 从一次运行提取技能。返回 null 表示这次运行不值得沉淀：
 * 失败/取消的运行、没有工具调用的运行（纯问答不构成技能）、目标为空、正文太小。
 */
export function extractSkill(run, options = {}) {
  if (!run || typeof run !== "object") return null;
  if (run.status !== "success") return null;
  const goal = flat(run.input);
  if (goal.length < 4) return null;
  const tools = toolNamesOf(run);
  if (!tools.length) return null;
  const instructions = buildInstructions(run);
  if (instructions.length < 40) return null;
  const name = skillNameOf(goal);
  if (!name) return null;
  return {
    id: text(options.id) || `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description: skillDescriptionOf(run),
    instructions,
    keywords: keywordsOf(`${goal} ${tools.join(" ")}`),
    toolNames: tools,
    sourceRunId: text(run.id),
    createdAt: Number(options.now) || Date.now(),
  };
}

/** 一条技能在同一目标下的得分。 */
export function scoreSkill(skill, goal) {
  const value = flat(goal).toLowerCase();
  if (!value || !skill) return 0;
  let score = 0;
  for (const keyword of Array.isArray(skill.keywords) ? skill.keywords : []) {
    const word = flat(keyword).toLowerCase();
    if (word && value.includes(word)) score += 2;
  }
  const name = flat(skill.name).toLowerCase();
  if (name && value.includes(name)) score += 3;
  const description = flat(skill.description).toLowerCase();
  if (description && value.includes(description)) score += 3;
  // 工具名出现在目标里（「用 sql 查一下」）也算弱证据
  for (const tool of Array.isArray(skill.toolNames) ? skill.toolNames : []) {
    const short = flat(tool).toLowerCase().split(".").pop();
    if (short && short.length >= 4 && value.includes(short)) score += 1;
  }
  return score;
}

/**
 * 挑出与目标相关的技能。返回按分数倒序的 { skill, score }，低于阈值的直接丢掉。
 * disabled 里的 id 一律跳过——用户关掉的技能不该悄悄生效。
 */
export function matchSkills(skills, goal, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : SKILL_MATCH_LIMIT;
  const minScore = Number.isFinite(options.minScore) ? options.minScore : SKILL_MIN_SCORE;
  const disabled = new Set(Array.isArray(options.disabled) ? options.disabled : []);
  const list = Array.isArray(skills) ? skills : [];
  return list
    .filter((skill) => skill && !disabled.has(skill.id))
    .map((skill) => ({ skill, score: scoreSkill(skill, goal) }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || (Number(b.skill.createdAt) || 0) - (Number(a.skill.createdAt) || 0))
    .slice(0, limit);
}

/**
 * 命中技能进 prompt 的段落。目录（未命中的技能）刻意不进——那是每次运行都要付的 token。
 * 预算裁的是正文而不是条目：宁可少带一条，也不要一条只带半句。
 */
export function skillsPromptSection(matches, options = {}) {
  const budget = Number.isInteger(options.budget) && options.budget > 0 ? options.budget : SKILL_PROMPT_BUDGET;
  const list = Array.isArray(matches) ? matches.filter((item) => item?.skill) : [];
  if (!list.length) return "";
  const blocks = [];
  let used = 0;
  for (const { skill } of list) {
    const block = `【技能】${flat(skill.name)}\n${flat(skill.instructions)}`;
    if (used + block.length > budget) break;
    blocks.push(block);
    used += block.length;
  }
  if (!blocks.length) return "";
  return [
    "下面是你（或用户）此前成功跑过的做法，仅供参考：按当前实际情况判断，参数必须重新核对。",
    ...blocks,
  ].join("\n");
}

/** 落盘前的体检：坏数据不进库（与 repository 的「写入边界拒绝脏值」同一惯例）。 */
export function validateSkill(skill) {
  if (!skill || typeof skill !== "object") return null;
  const name = flat(skill.name);
  const instructions = text(skill.instructions);
  if (!name || instructions.length < 20) return null;
  const clean = {
    id: text(skill.id) || `skill-${Math.random().toString(36).slice(2, 10)}`,
    name: name.slice(0, NAME_LIMIT),
    description: flat(skill.description).slice(0, DESC_LIMIT),
    instructions: instructions.slice(0, SKILL_MAX_CHARS - INSTRUCTIONS_RESERVE),
    keywords: (Array.isArray(skill.keywords) ? skill.keywords : []).map((word) => flat(word).slice(0, KEYWORD_CHARS)).filter(Boolean).slice(0, KEYWORD_LIMIT),
    toolNames: (Array.isArray(skill.toolNames) ? skill.toolNames : []).map((tool) => flat(tool).slice(0, NAME_CHARS)).filter(Boolean).slice(0, TOOL_NAME_LIMIT),
    sourceRunId: text(skill.sourceRunId),
    createdAt: Number(skill.createdAt) || Date.now(),
  };
  // 体量收口放在**归一之后**，而且是「先砍最便宜的元信息（工具名 → 关键词 → 正文），
  // 直到整条真的落进预算」——JSON 转义与键名也要占字节，靠估算留余量迟早会有漏网的组合。
  // 超长正文不该让整条技能作废：截断保住的部分，比丢掉用户刚沉淀的经验更有价值。
  while (safeJsonSize(clean) > SKILL_MAX_CHARS) {
    if (clean.toolNames.length > 4) clean.toolNames = clean.toolNames.slice(0, Math.max(4, clean.toolNames.length - 4));
    else if (clean.keywords.length > 4) clean.keywords = clean.keywords.slice(0, Math.max(4, clean.keywords.length - 4));
    else if (clean.instructions.length > 400) clean.instructions = clean.instructions.slice(0, clean.instructions.length - 400);
    else return null;
  }
  return clean;
}
