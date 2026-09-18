import { aiComplete } from "../ai.js";
import { runAgent } from "./runtime.js";
import { createBuiltinRegistry } from "./builtins.js";
import { createRun, appendStep, canResume, addUsage } from "./runStore.js";
import { historyPromptText } from "./history.js";
import { matchSkills, skillsPromptSection } from "./skills.js";

// 模型响应修复预算：解析失败时把错误原文回灌给模型自我修正，最多这么多次，之后按失败收尾。
// 必须有界——无上限会烧 token；每次修复都会在时间线上留一条 model_repair 事件。
export const MAX_REPAIR_ATTEMPTS = 2;
const REPAIR_HISTORY_LIMIT = 3;

/**
 * 宽松解析模型返回的动作 JSON：剥 ```json 围栏、截取最外层 {...}，再 JSON.parse。
 * 只做「去噪」不做「猜语义」——截取的是最外层花括号，不是用正则去猜字段。
 * 不复用 ai.js 的 parseJSONLoose：那个抛的是 i18n 文案错误（进不了回灌提示），且错误信息对模型无用。
 */
export function parseAction(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw Error("模型返回了空内容");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const candidates = [body];
  const open = body.indexOf("{");
  const close = body.lastIndexOf("}");
  if (open >= 0 && close > open) candidates.push(body.slice(open, close + 1));
  let lastError;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("动作必须是 JSON 对象");
      return value;
    } catch (error) {
      lastError = error;
    }
  }
  throw Error(lastError?.message || "不是合法 JSON");
}

function buildPrompt(input, history, tools, repairs, options = {}) {
  const lines = [
    "你是 ToolCove 本地开发智能体。只能从工具列表中选择工具。",
    "每次只返回一个 JSON 动作，不要 Markdown：tool_call {type,id,tool,args}、final {type,answer} 或 ask_user {type,question}。",
    `目标：${input}`,
    `工具：${JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, risk: t.risk, inputSchema: t.inputSchema })))}`,
  ];
  // 技能：只把**命中**的正文放进来，目录（未命中的技能）刻意不进 prompt——
  // 否则每次运行都要为全部技能付 token（见 skills.js 的设计取舍）。
  const matches = options.skills ? matchSkills(options.skills, input, { disabled: options.disabledSkills }) : [];
  const skillSection = skillsPromptSection(matches);
  if (skillSection) lines.push(skillSection);
  // 早期步骤折叠成摘要而不是直接丢弃：长任务里模型反复重试同一件事，
  // 往往就是因为第 3 步的失败原因已经被 slice(-8) 丢掉了（见 history.js）。
  lines.push(`历史：${historyPromptText(history, options.historyOptions || {})}`);
  if (repairs.length) {
    lines.push(
      "注意：你上几次的回复无法解析为 JSON 动作，错误如下。请只返回一个合法 JSON 对象，不要解释文字，不要 Markdown 围栏。",
      ...repairs.map((r) => `- ${r}`)
    );
  }
  return lines.join("\n");
}

export function createAIPlanner(options = {}) {
  const modelOptions = options.modelOptions || {};
  const plannerOptions = {
    skills: Array.isArray(options.skills) ? options.skills : null,
    disabledSkills: Array.isArray(options.disabledSkills) ? options.disabledSkills : [],
    historyOptions: { keepTail: options.keepTail, summaryBudget: options.summaryBudget },
  };
  return async ({ input, history, tools, repairs = [] }) => {
    const prompt = buildPrompt(input, history, tools, repairs, plannerOptions);
    const callOptions = typeof options.onUsage === "function" ? { ...modelOptions, onUsage: options.onUsage } : modelOptions;
    return parseAction(await aiComplete(prompt, callOptions));
  };
}

/**
 * 把规划器包一层「解析失败 → 回灌错误 → 重试」。
 * 为什么放在协议层而不是 runtime：runtime 只应看到合法的动作对象。runtime 里的模型重试管的是
 * 「请求失败」（限流/5xx/断网），这里管的是「模型没按协议说话」，两者是不同故障。
 * 带 code 的错误（传输层、超时、配置）直接上抛，交给 runtime 的分类重试处理。
 */
export function createRepairingPlanner(planner, options = {}) {
  const limit = Number.isInteger(options.maxRepairAttempts) ? Math.max(options.maxRepairAttempts, 0) : MAX_REPAIR_ATTEMPTS;
  const onRepair = options.onRepair;
  return async (context) => {
    const repairs = [];
    const history = Array.isArray(context.history) ? context.history : [];
    for (let attempt = 0; attempt <= limit; attempt++) {
      try {
        return await planner({ ...context, repairs });
      } catch (error) {
        const message = error?.message || String(error);
        if (error?.code || attempt >= limit) throw error;
        repairs.push(message);
        if (repairs.length > REPAIR_HISTORY_LIMIT) repairs.shift();
        await onRepair?.({ attempt: attempt + 1, error: message });
        // 写进历史：模型下一轮能看到自己上次错在哪（与「工具结果永久可回溯」同一动机）
        history.push({ action: { type: "protocol_error" }, error: message });
      }
    }
    throw Error("模型未返回有效动作");
  };
}

export function runAIAgent(input, options = {}) {
  const registry = options.registry || createBuiltinRegistry();
  if (options.resume && !canResume(options.resume, registry)) return Promise.reject(Error('该任务包含脱敏信息或副作用步骤，无法安全恢复'));
  const run = createRun(input);
  if (options.resume) { run.parentId = options.resume.id; run.history = structuredClone(options.resume.history || []); }
  const save = async () => { await options.onRun?.(structuredClone(run)); };
  const onEvent = async (event) => { appendStep(run, { ...event, status: event.type === 'final' ? 'success' : event.type === 'tool_error' ? 'failed' : 'running' }); run.history = structuredClone(run.history || []); await save(); await options.onEvent?.(event, run); };
  // 计量既落到 run 上，也透传给调用方做配额计数。持久化失败只丢一次计数，不该中断运行。
  const onUsage = (usage) => { addUsage(run, usage); save().catch(() => {}); options.onUsage?.(usage, run); };
  const planner = options.planner || createAIPlanner({ ...options, onUsage });
  const repairing = createRepairingPlanner(planner, {
    maxRepairAttempts: options.maxRepairAttempts,
    onRepair: (info) => onEvent({ type: 'model_repair', attempt: info.attempt, error: info.error }),
  });
  return save().then(() => runAgent(input, { ...options, onEvent, registry, planner: repairing, history: run.history })).then(async result => { run.status = result.status === 'completed' ? 'success' : result.status; run.error = result.error || ''; run.finishedAt = Date.now(); run.history = result.history || run.history; await save(); return { ...result, run }; });
}

export { createToolRegistry, runAgent } from "./runtime.js";
export { createBuiltinRegistry } from "./builtins.js";
