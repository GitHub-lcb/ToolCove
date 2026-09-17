// Agent 运行态单例。
//
// 为什么必须是模块级 reactive 而不是 AgentView 的 ref：App.vue 用 :key="activeModule" 渲染视图，
// 切模块会销毁视图。而首启用户必然要「跑到一半去设置页补 API Key」——运行态若挂在组件里就会当场死掉。
// 异步 chunk 一旦加载模块就常驻，于是运行、pending 确认 Promise、时间线都能活过视图切换。
// 先例：src/confirm.js、src/sync/index.js。
import { reactive } from "vue";
import { loadToolbox, saveToolbox, saveToolboxNow } from "../toolboxStore.js";
import { cloneJsonData } from "../jsonData.js";
import { isAIConfigured } from "../ai.js";
import { loadAgentConfig, saveAgentConfig } from "./config.js";
import { createApprovalPolicy } from "./approval.js";
import { buildAgentRegistry, listAgentTools, resolveRunOptions } from "./tools.js";
import { runAIAgent } from "./index.js";
import { accumulateUsage, emptyUsage, sanitizeRun } from "./runStore.js";

export const RUNS_KEY = "agentRuns";
export const RUNS_MAX = 30;

const INITIAL = () => ({
  ready: false,
  aiReady: false,
  status: "idle", // idle | running | waiting
  goal: "",
  steps: [], // 已脱敏的事件流；折叠由 timeline.js 负责
  answer: "",
  error: "",
  errorCode: "",
  runStatus: "", // completed | failed | cancelled | max_steps
  stopReason: "", // "" | user
  usage: emptyUsage(),
  currentRunId: "",
  runs: [],
  cfg: null,
  pending: null, // { kind:"tool"|"ask", tool, risk, question, args, resolve }
});

export const agentSession = reactive(INITIAL());

// 非响应式的运行内部状态：停止标志不进 UI，registry 也不需要触发渲染
let stopFlag = false;

const persistRuns = () => saveToolbox(RUNS_KEY, cloneJsonData(agentSession.runs));

// 本地事件：不进 runtime，只进时间线。code 交给视图映射 i18n 键，text 是无键时的兜底原文。
function pushNotice(code, text = "") {
  agentSession.steps.push({ type: "notice", code, text, ts: Date.now() });
}

// 显示也要脱敏：runStore.appendStep 只处理持久化副本，实时路径否则会把用户粘进来的
// 密码在 DOM 里留整个会话。
function pushEvent(event) {
  if (!event || typeof event !== "object") return;
  agentSession.steps.push(Object.assign(sanitizeRun(event), { ts: Date.now() }));
}

function resetTimeline() {
  agentSession.steps = [];
  agentSession.answer = "";
  agentSession.error = "";
  agentSession.errorCode = "";
  agentSession.runStatus = "";
  agentSession.stopReason = "";
  agentSession.usage = emptyUsage();
  agentSession.currentRunId = "";
}

function upsertRun(run) {
  if (!run?.id) return;
  const index = agentSession.runs.findIndex((r) => r.id === run.id);
  if (index >= 0) agentSession.runs.splice(index, 1, run);
  else agentSession.runs.unshift(run);
  if (agentSession.runs.length > RUNS_MAX) agentSession.runs.length = RUNS_MAX;
}

/** 载入运行历史 / Agent 配置 / AI 就绪态。视图重建时只刷新配置，不覆盖内存里的 runs。 */
export async function initAgentSession() {
  if (agentSession.ready) return refreshAgentConfig();
  const [runs, cfg, aiReady] = await Promise.all([
    loadToolbox(RUNS_KEY, []),
    loadAgentConfig(),
    isAIConfigured().catch(() => false),
  ]);
  agentSession.runs = Array.isArray(runs) ? runs.slice(0, RUNS_MAX) : [];
  agentSession.cfg = cfg;
  agentSession.aiReady = aiReady;
  agentSession.ready = true;
}

/** 设置页变更后重算配置与 AI 就绪态。不动进行中的运行。 */
export async function refreshAgentConfig() {
  const [cfg, aiReady] = await Promise.all([loadAgentConfig(), isAIConfigured().catch(() => false)]);
  agentSession.cfg = cfg;
  agentSession.aiReady = aiReady;
}

/**
 * 能力面板的工具开关。落盘失败会抛给调用方提示——静默吞掉会造成「开关看着关了、重启又打开」。
 * 关掉最后一个可用工具时抛 ALL_DISABLED：那会让 registry 为空，之后每次工具调用都只报 Unknown tool。
 */
export async function setToolEnabled(name, enabled) {
  const cfg = agentSession.cfg || { disabledTools: [] };
  const disabled = new Set(Array.isArray(cfg.disabledTools) ? cfg.disabledTools : []);
  if (enabled) {
    disabled.delete(name);
  } else {
    const usable = listAgentTools(cfg).filter((x) => x.enabled);
    if (usable.length <= 1 && usable.some((x) => x.name === name)) {
      throw Object.assign(new Error("至少保留一个可用工具"), { code: "ALL_DISABLED" });
    }
    disabled.add(name);
  }
  const saved = await saveAgentConfig({ disabledTools: [...disabled] });
  agentSession.cfg = saved;
  return saved;
}

// runtime 的两处 confirm 调用点：ask_user 传 (question, action)，工具确认传 (message, {action, tool, decision, id})。
// 用 meta.tool 区分，返回 Promise<boolean>；不返回 true 的缺省实现会让「从不确认」策略退化成拒绝。
// callId 进 pending：批准卡的审计事件（approval_asked/approval_decided）都要能指回具体这一次调用。
function handleConfirm(message, meta) {
  return new Promise((resolve) => {
    const isTool = !!meta?.tool;
    agentSession.pending = {
      kind: isTool ? "tool" : "ask",
      callId: isTool ? String(meta?.id || "") : "",
      tool: isTool ? meta.tool.name || "" : "",
      risk: isTool ? meta.tool.risk || "" : "",
      question: isTool ? "" : String(meta?.question || message || ""),
      args: isTool ? sanitizeRun(meta.action?.args ?? {}) : null,
      resolve,
    };
    agentSession.status = "waiting";
  });
}

function handleUsage(usage) {
  agentSession.usage = accumulateUsage(agentSession.usage, usage);
}

async function handleRun(run) {
  if (!run?.id) return;
  agentSession.currentRunId = run.id;
  upsertRun(run);
  persistRuns();
}

/** 预检 + 起运行。返回 false 表示未启动（空目标或已有运行在进行）。 */
async function launch(input, resumeRun) {
  const goal = String(input ?? "").trim();
  if (!goal || agentSession.status !== "idle") return false;
  if (!agentSession.ready) await initAgentSession();

  agentSession.goal = goal;
  resetTimeline();
  agentSession.status = "running";
  stopFlag = false;

  const registry = buildAgentRegistry(agentSession.cfg);
  const runOptions = resolveRunOptions(agentSession.cfg);
  // 逐次批准策略：存活期就是本次运行。批准只对「这一次调用」有效（同工具同参数折叠为一次）。
  const approvalPolicy = createApprovalPolicy({ mode: runOptions.requireConfirmation });
  let run = null;
  try {
    const result = await runAIAgent(goal, {
      registry,
      ...runOptions,
      approvalPolicy,
      ...(resumeRun ? { resume: resumeRun } : {}),
      confirm: handleConfirm,
      shouldStop: () => stopFlag,
      onUsage: handleUsage,
      onEvent: (event, r) => {
        pushEvent(event);
        if (r?.id) agentSession.currentRunId = r.id;
      },
      onRun: handleRun,
    });
    run = result.run || null;
    agentSession.answer = result.answer || "";
    agentSession.error = result.error || "";
    agentSession.errorCode = result.errorCode || "";
    agentSession.runStatus = result.status || "";
    if (result.status === "max_steps") pushNotice("max_steps");
    else if (result.status === "cancelled") {
      // 一步都没走、也没产出答案就取消 = 用户在第一个确认卡上就拒绝了，等于放弃本次目标；
      // 走了若干步之后才取消则区分不出「用户点停止」与「模型连续被拒」，只按已取消记。
      if (!agentSession.stopReason && !result.history?.length) agentSession.stopReason = "denied";
      pushNotice("stopped");
    } else if (result.status === "failed") pushNotice("failed", result.error || "");
  } catch (error) {
    // runAIAgent 只在续跑守卫与持久化失败时 reject
    agentSession.runStatus = "failed";
    agentSession.errorCode = error?.code || "";
    agentSession.error = error?.message || String(error);
    pushNotice("failed", agentSession.error);
  } finally {
    // 停止原因落到 run 上，历史列表才能显示「用户停止」而非笼统的已取消
    if (run && agentSession.stopReason && run.stopReason !== agentSession.stopReason) {
      run.stopReason = agentSession.stopReason;
      upsertRun(run);
    }
    agentSession.pending = null;
    agentSession.status = "idle";
    stopFlag = false;
    // 立即冲刷历史，避免运行刚结束就关窗丢记录
    await saveToolboxNow(RUNS_KEY, cloneJsonData(agentSession.runs));
  }
  return true;
}

export async function startAgentRun(goal) {
  return launch(goal, null);
}

export async function resumeAgentRun(run) {
  if (!run?.input) return false;
  return launch(run.input, run);
}

/** 请求停止。run 上记为 "user"，历史列表据此区分「停止」与「取消」。 */
export function stopAgentRun(reason = "user") {
  if (agentSession.status === "idle") return false;
  stopFlag = true;
  if (!agentSession.stopReason) agentSession.stopReason = reason;
  // 有 pending 确认时直接判否，比等 50ms 轮询更早收尾
  const pending = agentSession.pending;
  if (pending) {
    agentSession.pending = null;
    agentSession.status = "running";
    pending.resolve(false);
  }
  return true;
}

/**
 * 内联确认卡的允许/拒绝。运行时只为 ask_user 发 confirmation 事件，
 * 工具确认的人类决定要自己记进时间线，否则历史里看不出是谁放行的。
 */
export function resolvePending(approved) {
  const pending = agentSession.pending;
  if (!pending) return false;
  agentSession.pending = null;
  agentSession.status = "running";
  pushEvent({
    type: "confirmation",
    kind: pending.kind,
    tool: pending.tool,
    question: pending.question,
    answer: !!approved,
  });
  pending.resolve(!!approved);
  return true;
}

export function discardRun(id) {
  agentSession.runs = agentSession.runs.filter((r) => r.id !== id);
  persistRuns();
}

export function clearTimeline() {
  resetTimeline();
}

/** 供测试 beforeEach 清理，避免跨用例状态泄漏 */
export function __resetAgentSession() {
  stopFlag = false;
  Object.assign(agentSession, INITIAL());
}
