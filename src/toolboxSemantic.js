// 自然语言找工具：把「我想把订单表另存成表格文件」这种说法，认回「表格处理」这个工具。
//
// 为什么需要它：toolboxTools.js 的检索是**子串包含**（haystack.includes(keyword)），
// 单不成句的关键词能用，一整句诉求就失效——那句话和工具名/描述里任何字段都没有共同子串。
// 这正是「普通代码写不出、而 System One 擅长」的那半句：判断一段自然语言与一个能力是否对应。
//
// 与技能匹配（agent/skillSuggest.js）同一套形状与理由，但刻意**不共用代码**：
//  - 这里没有「这次到底要不要用工具」这一问（用户已经在找工具了），所以没有 gate 问句；
//  - 候选是一行的能力说明，不是几千字的流程正文，所以没有正文预算与预筛；
//  - 两边各自演化比强行抽一个「什么都能排」的框架更省——抽象要等第三个使用者出现。
//
// 注入式传输层：纯函数不 import Vue/Tauri，node 环境可直接单测。网络在 typesafe.js。

/** 默认模型别名（与 typesafe.js / skillSuggest.js 同值，跟随旗舰模型）。 */
export const TOOL_SUGGEST_MODEL = "jev-latest";
/** 一次最多推荐几个工具。 */
export const TOOL_SUGGEST_LIMIT = 3;
/** 单条工具说明的字符上限：名称 + 描述 + 关键词，超了就是在为噪声付 token。 */
const TOOL_NOTE_CHARS = 260;
/** 适用概率低于它就不推荐（宁缺勿滥：推错工具比推不出更伤信任）。 */
export const TOOL_SUGGEST_FLOOR = 0.35;
/** 最高那条低于它就不信任这次判断（Noul 没有 confidence 字段，用最高概率当把握）。 */
export const TOOL_SUGGEST_CONF_LOW = 0.35;
/** 逐条 Noul 问句的 id 前缀。 */
const APPLICABLE_PREFIX = "applicable::";

const text = (value) => (typeof value === "string" ? value : "");
const flat = (value) => text(value).replace(/\s+/g, " ").trim();

const num = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

/**
 * 工具在 state 里的一条说明：名称 + 描述 + 关键词。
 * 关键词是注册表里的（用户语言），不翻译——Jev 读得懂 CJK 内容，只是**问句**要用英文更准。
 */
function describeTool(tool, translate) {
  const parts = [flat(translate(tool.labelKey))];
  const desc = flat(translate(tool.descKey));
  if (desc) parts.push(desc);
  const keywords = Array.isArray(tool.keywords) ? tool.keywords.map(flat).filter(Boolean) : [];
  if (keywords.length) parts.push(`keywords: ${keywords.join(", ")}`);
  const note = parts.join(" | ");
  return note.length > TOOL_NOTE_CHARS ? `${note.slice(0, TOOL_NOTE_CHARS - 1)}…` : note;
}

/**
 * 组装一次请求。返回 null 表示「没什么可问的」：没有可用工具、或这句话不值得问
 * （单个词用子串检索就够且更准，为它发网络请求是亏的）。
 * 值不值得问默认交给 isSemanticWorthy；传 minChars 可改成纯长度门槛。
 */
export function buildToolRankRequest(tools, query, options = {}) {
  const request = flat(query);
  const minChars = Number(options.minChars);
  const worthy = Number.isFinite(minChars)
    ? request.length >= Math.min(Math.max(minChars, 1), 40)
    : isSemanticWorthy(request);
  if (!worthy) return null;
  const usable = (Array.isArray(tools) ? tools : []).filter(
    (tool) => tool && typeof tool === "object" && flat(tool.key),
  );
  if (!usable.length) return null;
  const translate = typeof options.translate === "function" ? options.translate : () => "";
  const notes = {};
  const questions = {};
  for (const tool of usable) {
    const key = tool.key;
    notes[key] = describeTool(tool, translate);
    questions[`${APPLICABLE_PREFIX}${key}`] = {
      type: "noul",
      instructions:
        `Does the tool whose capability is described as \`state.tools["${key}"]\` do what the ` +
        "user asks for in `state.request`? Answer yes only if this is the tool they should open " +
        "for that task; a tool that merely shares words with the request is a no.",
    };
  }
  return {
    body: {
      model: flat(options.model) || TOOL_SUGGEST_MODEL,
      state: { request, tools: notes },
      questions,
    },
    tools: usable,
  };
}

/**
 * 解析成 { tool, score } 列表。坏响应一律退化成空列表：
 * 猜错工具会把用户带到别的窗口去，比不猜更糟。
 */
export function parseToolRankResponse(tools, response, options = {}) {
  const list = Array.isArray(tools) ? tools.filter((tool) => tool && flat(tool.key)) : [];
  const answers = response && response.answers;
  if (!list.length || !answers || typeof answers !== "object") return [];
  const floor = num(options.floor, TOOL_SUGGEST_FLOOR, 0, 1);
  const limit = num(options.limit, TOOL_SUGGEST_LIMIT, 1, 10);
  const hits = [];
  for (const tool of list) {
    const value = Number(answers[`${APPLICABLE_PREFIX}${tool.key}`]?.noul);
    if (!Number.isFinite(value) || value < floor) continue;
    hits.push({ tool, score: value });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 这次判断的把握：最高那条的适用概率；一条都没答就没有这个信号（返回 null，不是 0）。 */
export function toolRankCertainty(tools, response) {
  const answers = response && response.answers;
  if (!answers || typeof answers !== "object") return null;
  let top = null;
  for (const tool of Array.isArray(tools) ? tools : []) {
    const value = Number(answers[`${APPLICABLE_PREFIX}${tool?.key}`]?.noul);
    if (Number.isFinite(value) && (top === null || value > top)) top = value;
  }
  return top;
}

/**
 * 推荐该打开的工具：先问 TypeSafe，问不到就**不推荐**（与技能匹配不同，这里没有字面兜底——
 * 字面检索调用方已经在做了，兜一层只会把同一件事算两遍）。
 * options：transport(body) → 响应；onResult(info) 拿诊断；limit / floor / model / minChars / translate
 */
export async function suggestTools(tools, query, options = {}) {
  const report = (info) => {
    try {
      options.onResult?.(info);
    } catch {
      // 诊断回调出错不影响推荐结果
    }
  };
  const built = buildToolRankRequest(tools, query, options);
  if (!built) {
    report({ matcher: "none", reason: "not-worth-asking", hits: [] });
    return [];
  }
  const bail = (reason, error) => {
    report({ matcher: "none", reason, error: text(error?.message), hits: [] });
    return [];
  };
  if (typeof options.transport !== "function") return bail("not-configured");
  const startedAt = Date.now();
  try {
    const response = await options.transport(built.body, options);
    const certainty = toolRankCertainty(built.tools, response);
    const confLow = num(options.confidenceLow, TOOL_SUGGEST_CONF_LOW, 0, 1);
    if (certainty !== null && certainty < confLow) return bail("low-confidence");
    const hits = parseToolRankResponse(built.tools, response, options);
    report({
      matcher: "typesafe",
      hits: hits.map((hit) => hit.tool.key),
      candidates: built.tools.length,
      certainty,
      latencyMs: Date.now() - startedAt,
      usage: response && typeof response.usage === "object" ? response.usage : null,
    });
    return hits;
  } catch (error) {
    return bail("transport-error", error);
  }
}

/**
 * 这句话值不值得拿去问模型：给 UI 用的门槛，避免每敲一个字就打一次网络。
 * 判据是**信息量**而不是长度——单个词（「json」「base64」）子串检索就够且更准，
 * 而成句的诉求（「把这个表另存一份」）才会掉进字面检索的空隙里。
 */
export function isSemanticWorthy(query) {
  const value = flat(query);
  // CJK 两个字就构成一个概念，门槛可以低一些
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(value)) return value.length >= 5;
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean).length >= 3;
}
