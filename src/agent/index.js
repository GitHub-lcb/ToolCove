import { aiComplete } from "../ai.js";
import { runAgent } from "./runtime.js";
import { createBuiltinRegistry } from "./builtins.js";
import { createRun, appendStep, canResume, addUsage } from "./runStore.js";

function parseAction(text) {
  const raw = String(text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  return JSON.parse(raw);
}

export function createAIPlanner(options = {}) {
  const modelOptions = options.modelOptions || {};
  return async ({ input, history, tools }) => {
    const prompt = [
      "你是 ToolCove 本地开发智能体。只能从工具列表中选择工具。",
      "每次只返回一个 JSON 动作，不要 Markdown：tool_call {type,id,tool,args}、final {type,answer} 或 ask_user {type,question}。",
      `目标：${input}`,
      `工具：${JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, risk: t.risk, inputSchema: t.inputSchema })))}`,
      `历史：${JSON.stringify(history.slice(-8))}`,
    ].join("\n");
    const callOptions = typeof options.onUsage === "function" ? { ...modelOptions, onUsage: options.onUsage } : modelOptions;
    return parseAction(await aiComplete(prompt, callOptions));
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
  return save().then(() => runAgent(input, { ...options, onEvent, registry, planner, history: run.history })).then(async result => { run.status = result.status === 'completed' ? 'success' : result.status; run.error = result.error || ''; run.finishedAt = Date.now(); run.history = result.history || run.history; await save(); return { ...result, run }; });
}

export { createToolRegistry, runAgent } from "./runtime.js";
export { createBuiltinRegistry } from "./builtins.js";
