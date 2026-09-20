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
import { resolveTypeSafeTransport } from "../typesafe.js";
import { spillStore } from "./spillStoreInstance.js";
import { extractSkill } from "./skills.js";
import { loadSkills, removeSkill, saveSkills, upsertSkill } from "./skillStore.js";
import { invoke } from "../platform/invoke.js";
import { buildTextDiff } from "../textDiff.js";
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
  skills: [],
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

/** 载入运行历史 / Agent 配置 / 技能库 / AI 就绪态。视图重建时只刷新配置，不覆盖内存里的 runs。 */
export async function initAgentSession() {
  if (agentSession.ready) return refreshAgentConfig();
  const [runs, cfg, aiReady, skills] = await Promise.all([
    loadToolbox(RUNS_KEY, []),
    loadAgentConfig(),
    isAIConfigured().catch(() => false),
    loadSkills().catch(() => []),
  ]);
  agentSession.runs = Array.isArray(runs) ? runs.slice(0, RUNS_MAX) : [];
  agentSession.cfg = cfg;
  agentSession.aiReady = aiReady;
  agentSession.skills = Array.isArray(skills) ? skills : [];
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

// runtime 的两处确认调用点：
//   工具确认 → 传 (message, {action, tool, decision, id})，回答是布尔；
//   ask_user → 传 (question, action)，回答是**文本**（模型问的是「哪两个文件」这类内容）。
// 用 meta.tool 区分：有 tool 就是工具确认。两处都返回 Promise，由视图侧的卡片解决。
// callId 进 pending：批准卡的审计事件（approval_asked/approval_decided）都要能指回具体这一次调用。
// preview：runtime 在写类工具上先跑一次预览（diff），人要看着 diff 才能决定放不放行。
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
      preview: isTool && meta?.preview ? sanitizeRun(meta.preview) : null,
      resolve,
    };
    agentSession.status = "waiting";
  });
}

/**
 * ask_user 的回答入口。runtime 要的是文本（见 runtime 的说明：布尔会让模型「同意了但什么都没说」），
 * 所以这里单独一条路径，而不是复用 resolvePending(approved)。
 */
export function answerPending(text) {
  const pending = agentSession.pending;
  if (!pending || pending.kind !== "ask") return false;
  const answer = String(text ?? "").trim();
  if (!answer) return false; // 空回答等于没回答：让 UI 提示用户，而不是把空串回灌给模型
  agentSession.pending = null;
  agentSession.status = "running";
  pushEvent({ type: "confirmation", kind: "ask", question: pending.question, answer });
  pending.resolve(answer);
  return true;
}

/** runtime 的 askUser 钩子：把问题挂成 pending，等 answerPending 送入文本。 */
function handleAskUser(question, action) {
  return handleConfirm(String(question ?? ""), { ...(action || {}), question: String(question ?? "") });
}

/**
 * 写前预览钩子：把「先 preview_write 再 write」这条纪律从模型手里拿回来。
 * 失败（文件不存在、读不了、无桌面能力）返回 null——没有 diff 也要让人能做决定。
 * 导出仅为单测（会话级链路：pending.preview 是否真的拿到 diff）。
 */
export async function previewWrite(tool, args) {
  if (tool?.name !== "file.write_text" || !args?.path) return null;
  try {
    const old = await invoke("file_tool_read_text", { path: String(args.path), encoding: "UTF-8" });
    const before = typeof old === "string" ? old : old?.text ?? old?.content ?? "";
    const after = String(args.text ?? "");
    return { path: String(args.path), before, after, diff: buildTextDiff(before, after), isNew: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 「读不到」最常见的原因是文件还不存在（新建），这对人是有用信息，所以照样给一张预览卡。
    return { path: String(args.path), before: "", after: String(args.text ?? ""), diff: buildTextDiff("", String(args.text ?? "")), isNew: true, readError: message };
  }
}

/**
 * spill 钩子：runtime 把超大工具结果交给这里落盘（走 toolboxStore，双端一致，不动 Rust IPC）。
 * 返回 null 表示落盘失败，runtime 会降级成裁剪。
 */
async function spillLargeResult({ tool, text: body, size }) {
  return spillStore.save(body, { tool });
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

  // 注册表与技能库都在**运行开始前**才准备：工具实现层是动态加载的（首屏不带 luxon/js-yaml 等），
  // 技能库读取失败不该拦住运行。
  const [registry, skills, typesafeTransport] = await Promise.all([
    buildAgentRegistry(agentSession.cfg),
    agentSession.skills?.length ? Promise.resolve(agentSession.skills) : loadSkills().catch(() => []),
    // TypeSafe 语义匹配是**可选增强**：没配就是 null，规划器据此退回关键词匹配。
    // 解析本身失败（设置读不到等）也退回 null——一个可选的增强不该拦住整次运行。
    resolveTypeSafeTransport().catch(() => null),
  ]);
  const runOptions = resolveRunOptions(agentSession.cfg);
  // 技能：命中者的正文进 prompt（目录不进）。设置里关掉的技能在这里就被排除，
  // 不会出现「关掉了却还在悄悄生效」。
  agentSession.skills = skills;
  const skillOptions = { skills, disabledSkills: agentSession.cfg?.disabledSkills || [], typesafeTransport };
  // 逐次批准策略：存活期就是本次运行。批准只对「这一次调用」有效（同工具同参数折叠为一次）。
  const approvalPolicy = createApprovalPolicy({ mode: runOptions.requireConfirmation });
  let run = null;
  try {
    const result = await runAIAgent(goal, {
      registry,
      ...runOptions,
      ...skillOptions,
      approvalPolicy,
      ...(resumeRun ? { resume: resumeRun } : {}),
      confirm: handleConfirm,
      // ask_user 要的是文本答案（路径、SQL、口令…），走单独入口，不复用布尔确认
      askUser: handleAskUser,
      preview: previewWrite,
      spill: spillLargeResult,
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
  // 有 pending 确认时直接判否，比等 50ms 轮询更早收尾。
  // 提问卡（ask）也走这条：拒绝回答即结束整个目标（与 runtime 的 cancelled 语义一致）。
  const pending = agentSession.pending;
  if (pending) {
    agentSession.pending = null;
    agentSession.status = "running";
    pending.resolve(pending.kind === "ask" ? null : false);
  }
  return true;
}

/**
 * 内联确认卡的允许/拒绝。运行时只为 ask_user 发 confirmation 事件，
 * 工具确认的人类决定要自己记进时间线，否则历史里看不出是谁放行的。
 * 只处理工具确认（kind === "tool"）：提问卡的回答走 answerPending（文本）。
 */
export function resolvePending(approved) {
  const pending = agentSession.pending;
  if (!pending || pending.kind !== "tool") return false;
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

/**
 * 把一次成功的运行沉淀成技能（技能库的入口）。
 * 返回 { ok, skill?, updated?, reason? }——reason 交给 UI 映射 i18n，UI 不猜引擎为什么拒绝。
 */
export async function promoteRunToSkill(runId) {
  const id = String(runId || agentSession.currentRunId || "");
  const run = agentSession.runs.find((r) => r.id === id);
  if (!run) return { ok: false, reason: "run_not_found" };
  const draft = extractSkill(run);
  if (!draft) return { ok: false, reason: "run_not_skillable" };
  const result = upsertSkill(agentSession.skills, draft);
  if (!result) return { ok: false, reason: "invalid" };
  agentSession.skills = result.list;
  await saveSkills(result.list);
  return { ok: true, skill: result.skill, updated: result.updated };
}

/** 删除一条技能。返回是否真的删掉了。 */
export async function deleteSkill(id) {
  const next = removeSkill(agentSession.skills, id);
  if (next.length === agentSession.skills.length) return false;
  agentSession.skills = next;
  await saveSkills(next);
  return true;
}

/**
 * 清空溢出结果区（大结果落盘的正文）。
 * 桌面端没有「按 key 删文件」的命令，这里只能把索引清空 + 把正文覆写成空值；
 * 因此返回的是「清掉了多少条」而不是「删除了多少文件」，UI 文案也要照此措辞。
 */
export async function clearSpills() {
  return spillStore.clear();
}

/**
 * 开关一条技能。复用 disabledSkills 清单（与 disabledTools 同一惯例：停用清单，默认全开）。
 * 关掉最后一条技能不报错——技能是可选增强，不是可执行能力。
 */
export async function setSkillEnabled(id, enabled) {
  const target = String(id || "");
  if (!target) return agentSession.cfg;
  const disabled = new Set(Array.isArray(agentSession.cfg?.disabledSkills) ? agentSession.cfg.disabledSkills : []);
  if (enabled) disabled.delete(target);
  else disabled.add(target);
  const saved = await saveAgentConfig({ disabledSkills: [...disabled] });
  agentSession.cfg = saved;
  return saved;
}

export function clearTimeline() {
  resetTimeline();
}

/** 供测试 beforeEach 清理，避免跨用例状态泄漏 */
export function __resetAgentSession() {
  stopFlag = false;
  Object.assign(agentSession, INITIAL());
}
