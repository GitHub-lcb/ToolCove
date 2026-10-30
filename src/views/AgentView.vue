<script setup>
// Agent 工作台：应用首屏。运行态在 src/agent/session.js 的模块级单例里，
// 视图被 :key="activeModule" 销毁重建也不丢运行、pending 确认与时间线。
import { ref, reactive, computed, inject, nextTick, onBeforeUnmount, onMounted, onServerPrefetch, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../ui/Icon.vue";
import MarkdownRender from "../tools/MarkdownRender.vue";
import { errText } from "../shared/errors.js";
import { buildAgentRegistry, listAgentTools } from "../agent/tools.js";
import { riskChip, riskKey } from "../agent/capabilities.js";
import { foldTimeline, payloadText, COLLAPSE_AT } from "../agent/timeline.js";
import { motionKind } from "../agent/motion.js";
import { describePreview, rowKind, rowText } from "../agent/preview.js";
import { canResume } from "../agent/runStore.js";
import { extractArtifacts } from "../agent/artifacts.js";
import { answerToProblemDraft, answerToSnippetDraft } from "../agent/answerDraft.js";
import { buildContextLine } from "../agent/context.js";
import { conversationTitle } from "../app/taskListItems.js";
import { attachmentIcon, attachmentPromptLine, normalizeAttachments } from "../agent/attachments.js";
import { loadModelChoice } from "../agent/modelPrefs.js";
import { runToMarkdown } from "../agent/runExport.js";
import { create as createRecord, load as loadRepo } from "../data/repository.js";
import { findToolboxTool, visibleToolboxTools } from "../toolboxTools.js";
import RunProgress from "./RunProgress.vue";
import ExecutionLanes from "./ExecutionLanes.vue";
import AgentComposer from "../app/AgentComposer.vue";
import { askConfirm } from "../ui/confirm.js";
import { save as saveDialog } from "../platform/dialog.js";
import { invoke } from "../platform/invoke.js";
import { openToolWindow, isTauriEnv } from "../app/toolWindow.js";
import { setToolPrefill } from "../app/toolPrefill.js";
import { actionDemo, buildDemoScript, isPlayable } from "../app/toolDemo.js";
import { onDemoSignal, sendDemo } from "../app/toolDemoLink.js";
import { track } from "../app/telemetry.js";
import {
  agentSession,
  answerPending,
  clearTimeline,
  initAgentSession,
  promoteRunToSkill,
  refreshAgentConfig,
  resolvePending,
  resumeAgentRun,
  startAgentRun,
  stopAgentRun,
} from "../agent/session.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  // App.vue 对所有模块视图统一透传这两个 prop；section 仅为契约一致，
  // jumpId 在二期接了真语义：侧边栏任务列表的 new / view 深链（见下方 watch）
  section: { type: String, default: "" },
  jumpId: { type: Object, default: null },
});
const emit = defineEmits(["navigate"]);

const { t } = useI18n();
const openSettings = inject("openSettings", null);
// 外壳帧（App.vue provide）：顶栏标题与右栏都由外壳承担，视图只投递状态。
// 单独渲染本视图（单测 / 手机端）时没有它，退化为本地状态，行为与旧版一致。
const shell = inject("shellFrame", null);

const busy = computed(() => agentSession.status !== "idle");
const goal = ref("");
// 输入框的 ref（附件 / 指令 / 模型都在 AgentComposer 里，聚焦要经过它暴露的 focus()）
const composerRef = ref(null);
// 本轮附件：只有「路径 + 元信息」，正文不进提示词（见 agent/attachments.js 的设计说明）
const attachments = ref([]);
// 模型胶囊显示的那三个值：settings.ai 的展示副本，保存后由 @model-changed 回填
const aiModel = ref({ baseUrl: "", model: "", reasoningEffort: "" });

// ------- 历史任务回看（二期导航重构：会话列表上移侧边栏，画布承接回看） -------
// viewRunId 非空时画布只读渲染该 run 落盘的 steps；运行中的真实进度由
// RunProgress 表达（不随回看切换），所以「边跑新任务边翻旧账」是安全的。
const viewRunId = ref("");
const viewRun = computed(() => agentSession.runs.find((r) => r.id === viewRunId.value) || null);

// 时间线数据源：回看 → 该 run 的 steps 快照（与实时 steps 同一事件流形状，
// foldTimeline 对缺运行时字段容错——缺什么显示什么）；否则 → 实时会话。
const sourceSteps = computed(() => {
  const viewing = viewRun.value;
  if (viewing) return Array.isArray(viewing.steps) ? viewing.steps : [];
  return agentSession.steps;
});

// payloadText 在模板里会被同一份数据反复调用，这里一次性算好挂到尝试上；
// 产物同理一并算好（extractArtifacts 是纯函数，见 agent/artifacts.js）
const timeline = computed(() =>
  foldTimeline(sourceSteps.value).map((item) =>
    item.kind === "tool"
      ? { ...item, attempts: item.attempts.map((a) => ({ ...a, argsText: payloadText(a.args), resultText: payloadText(a.result), artifacts: extractArtifacts(a.result) })) }
      : item
  )
);

// jump 深链：{ action:"new" } 开新任务；{ action:"view", runId } 回看历史。
// immediate 是因为 AgentView 按 :key="activeModule" 重建——带深链从别的模块切进来时，
// 组件出生那一刻 jumpId 就已经就位，非 immediate 的 watch 会漏掉这一拍。
watch(
  () => props.jumpId,
  async (j) => {
    if (!j || j.module !== "agent") return;
    if (j.action === "new") {
      // busy 时清时间线等于砍掉正在跑的运行现场：忽略并如实提示
      if (busy.value) return props.showToast(t("agent.busyNew"));
      viewRunId.value = "";
      goal.value = "";
      attachments.value = [];
      clearTimeline();
      nextTick(() => composerRef.value?.focus());
      return;
    }
    if (j.action === "view" && j.runId) {
      // 深链可能比首次 init 先到：先等历史就位再找记录
      if (!agentSession.ready) await initAgentSession();
      const rec = agentSession.runs.find((r) => r.id === j.runId);
      // 记录可能刚被删掉：忽略这次跳转，不把一个空 id 挂上画布
      if (rec) viewRunId.value = rec.id;
    }
  },
  { immediate: true }
);

function backToCurrent() {
  viewRunId.value = "";
  // 知会外壳清掉侧边栏的回看高亮（navigate 到 agent 不带 id：jump 置空，无其他副作用）
  emit("navigate", { module: "agent" });
}
const toolMeta = computed(() => new Map(listAgentTools(agentSession.cfg).map((x) => [x.name, x])));
// registry 只建一次：逐行调 canResume 会为 30 行历史重建 30 次 14 个工具定义。
// 它必须是 await 出来的真 registry——buildAgentRegistry 是 async（工具实现层按需加载），
// 直接把 Promise 交给 canResume 会在每次渲染历史列表时抛 "registry.get is not a function"。
// 注意：建 registry 会把整套工具实现层拉进来，所以只在真要画历史列表时才建（见下面 ensureAgentRegistry）。
const agentRegistry = ref(null);
const resumeMap = computed(() => {
  const registry = agentRegistry.value;
  const map = new Map();
  // registry 未就绪时一律按「不可续跑」处理：按钮先灰后亮，比先亮后灭更少误导
  if (!registry) return map;
  for (const rec of agentSession.runs) map.set(rec.id, !!rec.input && canResume(rec, registry));
  return map;
});

// 折叠状态：工具卡按事件 id，卡内 payload 按「卡#尝试#字段」
const openCards = reactive(new Set());
const openPayloads = reactive(new Set());
const cardKey = (item, index) => (item.kind === "tool" && item.id ? item.id : "k" + index);
const toggle = (set, key) => (set.has(key) ? set.delete(key) : set.add(key));
// 运行中新出现的工具卡默认展开；跑完后保持用户的手动设置
watch(
  () => timeline.value.length,
  () => {
    const last = timeline.value[timeline.value.length - 1];
    if (last?.kind === "tool" && last.id && busy.value) openCards.add(last.id);
  }
);
// 一轮结束时把工具卡全部收起。
// 运行中展开是有意的（「看着它干活」）；但结束后留着一屏展开的参数与结果 JSON，
// 等于把对话记录变成日志转储——主流做法是工具调用默认折叠成一行摘要、按需展开
// （Claude Code 折叠 + Ctrl+O 展开、Claude Desktop 的 Normal 模式、Cursor 的密度档）。
// 结果是可逆的：想看细节随时点开，卡片本身不会被丢弃。

// ------- 运行态的可见性：执行记录随运行自动开合 -------
// 运行中展开是「看着它干活」，结束收起是「答案优先」——两者都是设计意图。
// 之前 details 默认折叠把前半句吞掉了：用户跑完完全没看到卡片动效，演示入口也一起被藏住。
const executionEl = ref(null);
const clock = ref(Date.now());
let clockTimer = null;
// 用户在运行中手动收起过：这一轮不再强行打开，尊重他的选择
let userCollapsed = false;

function openExecution(open) {
  nextTick(() => {
    if (executionEl.value) executionEl.value.open = open;
  });
}
function onExecutionToggle() {
  if (!busy.value || !executionEl.value) return;
  userCollapsed = !executionEl.value.open;
}
function startClock() {
  if (clockTimer || typeof window === "undefined") return;
  clock.value = Date.now();
  clockTimer = window.setInterval(() => { clock.value = Date.now(); }, 1000);
}
function stopClock() {
  if (clockTimer) {
    window.clearInterval(clockTimer);
    clockTimer = null;
  }
  clock.value = Date.now();
}

// 从别的工作面切回来时组件会重建：既有的运行要接管成「展开 + 计时中」
onMounted(() => {
  if (busy.value && !viewRun.value) {
    startClock();
    openExecution(true);
  }
});
onBeforeUnmount(stopClock);

watch(busy, (now, before) => {
  if (now) startClock();
  else stopClock();
  if (before && !now) {
    openCards.clear();
    openPayloads.clear();
    userCollapsed = false;
    openExecution(false);
  }
});
// 新运行会换 details 的 key（currentRunId）、第一步会首次挂载 details：
// 这两种情况都触发一次「运行中展开」，但不覆盖用户手动收起的选择。
watch(
  [busy, viewRun, () => agentSession.currentRunId, () => sourceSteps.value.length],
  () => {
    if (busy.value && !viewRun.value && !userCollapsed) openExecution(true);
  }
);
// 进入回看时收起执行记录
watch(viewRun, (viewing) => {
  if (viewing) openExecution(false);
});

// 风险语义色 / 词条映射住在 agent/capabilities.js（设置页的工具开关矩阵用同一套，
// 各写一份会出现「时间线标红、设置页标橙」这类分裂）。

const ATTEMPT_KEY = { running: "agent.statusRunning", ok: "agent.statusSuccess", retry: "agent.stepRetry", error: "agent.stepError" };
const NOTICE_KEY = {
  stopped: "agent.stopped",
  max_steps: "agent.statusMaxSteps",
  failed: "agent.statusFailed",
  model_retry: "agent.retrying",
  model_repair: "agent.modelRepair",
  spill_failed: "agent.spillFailed",
};
// 引擎消息暂不 i18n（见 docs/agent-architecture.md 落地状态段），UI 自己产生的错误按 code 映射
const ERROR_KEY = {
  TIMEOUT: "agent.errTimeout",
  DESKTOP_ONLY: "agent.errDesktopOnly",
  ABORTED: "agent.stopped",
  // 读后写门禁的稳定错误码（见 agent/observation.js）
  OBSERVATION_REQUIRED: "agent.errObserveDenied",
};

const displayedStatus = computed(() => viewRun.value?.status || (busy.value ? agentSession.status : agentSession.runStatus));
const displayedUsage = computed(() => viewRun.value ? viewRun.value.usage || {} : agentSession.usage);
// 本轮用的模型：起跑时的快照（run.model），不是当前设置里的模型——切模型不该改写历史。
const runModelText = computed(() => {
  const run = viewRun.value || currentRun.value;
  const model = typeof run?.model === "string" ? run.model : "";
  const profile = typeof run?.modelProfile === "string" ? run.modelProfile : "";
  if (!model && !profile) return "";
  return profile && profile !== model ? `${profile} · ${model}` : model || profile;
});
const statusMeta = computed(() => {
  const status = displayedStatus.value;
  if (status === "waiting") return { cls: "st-wait", key: "agent.statusWaiting", icon: "alert" };
  if (status === "running" || status === "pending") return { cls: "st-dev", key: "agent.statusRunning", icon: "activity" };
  if (status === "completed" || status === "success") return { cls: "st-done", key: "agent.statusSuccess", icon: "check" };
  if (status === "cancelled") return { cls: "tc-neutral", key: "agent.statusCancelled", icon: "square" };
  if (status === "max_steps") return { cls: "st-pending", key: "agent.statusMaxSteps", icon: "alert" };
  if (status === "failed") return { cls: "st-fail", key: "agent.statusFailed", icon: "alert" };
  return { cls: "tc-neutral", key: "agent.statusIdle", icon: "zap" };
});
const executionTimeline = computed(() => timeline.value.filter((item) => item.kind !== "final" && item.code !== "verify_review"));
const answers = computed(() => timeline.value.filter((item) => item.kind === "final"));
const reviewNotices = computed(() => timeline.value.filter((item) => item.code === "verify_review"));
const toolCount = computed(() => timeline.value.filter((item) => item.kind === "tool").length);

// ------- 管线条：把这一轮的工具步压成一条横排，贴着画布顶（B · Pipeline 落地第一步） -------
// 它不替代对话流，而是给「现在跑到第几步、哪一步在等确认」一个常驻的入口：
// 点节点 → 展开对应的工具卡并滚到它（运行中链在长，靠滚屏找上一步很容易丢）。
const scrollEl = ref(null);
const confirmEl = ref(null);
function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
const pipelineNodes = computed(() =>
  executionTimeline.value
    .filter((item) => item.kind === "tool")
    .map((item, i) => {
      const last = item.attempts[item.attempts.length - 1] || {};
      const span = lastSpan(item);
      return {
        id: item.id,
        n: i + 1,
        tool: item.tool,
        status: last.status || "running",
        spanText: span ? fmtMs(span) : "",
      };
    })
);
const pendingTool = computed(() =>
  agentSession.pending && agentSession.pending.kind === "tool" ? agentSession.pending.tool : ""
);
function focusStep(id) {
  openExecution(true);
  if (id) openCards.add(id);
  nextTick(() => {
    const sc = scrollEl.value;
    if (!sc) return;
    const el = sc.querySelector('[data-step-id="' + id + '"]');
    if (el) el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  });
}
const selectedStepId = ref("");
const selectedStep = computed(() => {
  const id = selectedStepId.value;
  return id ? executionTimeline.value.find((item) => item.kind === "tool" && item.id === id) || null : null;
});
function selectStep(id) {
  selectedStepId.value = selectedStepId.value === id ? "" : id;
}
function focusPending() {
  openExecution(true);
  nextTick(() => {
    if (confirmEl.value) confirmEl.value.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  });
}

const errorText = computed(() => {
  const key = ERROR_KEY[agentSession.errorCode];
  return key ? t(key) : agentSession.error || "";
});
// 语义匹配退回关键词的原因：能说清是哪一条，用户才知道该去设置里改什么。
const SKILL_REASON_KEY = {
  "not-configured": "agent.skillReasonNotConfigured",
  "low-confidence": "agent.skillReasonLowConfidence",
};
const skillMatchText = (item) => {
  const skills = item.matched?.length ? item.matched.join("、") : t("agent.skillNone");
  if (item.matcher === "keyword") {
    // 传输层错误带原文：429 与「key 无效」的处理动作完全不同，折叠成一句就没了
    const reason =
      item.reason === "transport-error" && item.error
        ? item.error
        : t(SKILL_REASON_KEY[item.reason] || "agent.skillReasonUnknown");
    return t("agent.noticeSkillFallback", { reason, skills });
  }
  const confidence = Number.isFinite(item.confidence) ? item.confidence.toFixed(2) : "?";
  const key = item.tier === "high" ? "agent.noticeSkillSemantic" : "agent.noticeSkillSemanticMarked";
  // 同一次请求还回了歧义预判：达门槛就在同一行里说一句，不另开一行刷屏
  const suffix = item.clarify?.hint ? t("agent.skillClarifySuffix") : "";
  return `${t(key, { skills, confidence, ms: item.latencyMs || 0 })}${suffix}`;
};
// 核验三项的名字：时间线要说「哪一项没把握」，而不是只丢一个分数。
const VERIFY_CHECK_KEY = {
  executed: "agent.verifyCheckExecuted",
  grounded: "agent.verifyCheckGrounded",
  complete: "agent.verifyCheckComplete",
};
const verifyText = (item) => {
  const weakest = Number.isFinite(item.weakest) ? item.weakest.toFixed(2) : "?";
  if (item.code === "verify_ok") return t("agent.noticeVerifyOk", { weakest });
  const items = (item.reviewOf || []).map((key) => t(VERIFY_CHECK_KEY[key] || "agent.verifyCheckUnknown")).join("、");
  return t("agent.noticeVerifyReview", { items, weakest });
};
const noticeText = (item) => {
  // 需要参数的几类：结果被裁剪（省略了多少）、完整结果落盘（key 是什么）、语义匹配判定。
  // 模型侧看的是引擎原文，人看的是词条——两边都要能说清「这一步为什么信息变少了」。
  if (item.code === "tool_clip") return t("agent.noticeToolClip", { omitted: item.omittedChars || 0, original: item.originalChars || 0 });
  if (item.code === "tool_spill") return t("agent.noticeToolSpill", { key: item.text || "", chars: item.chars || 0 });
  if (item.code === "skill_match") return skillMatchText(item);
  if (item.code === "verify_ok" || item.code === "verify_review") return verifyText(item);
  return NOTICE_KEY[item.code] ? t(NOTICE_KEY[item.code]) : item.text || t("agent.statusFailed");
};
// 写前预览：确认卡上的 diff 摘要（长文件只显示改动附近，见 agent/preview.js）
const pendingPreview = computed(() => describePreview(agentSession.pending?.preview));
/** 时间线里的确认行：回答是文本（ask_user）还是布尔（工具批准）。 */
const isTextAnswer = (answer) => typeof answer === "string" && answer.length > 0;
const attemptText = (a) => (ERROR_KEY[a.code] ? t(ERROR_KEY[a.code]) : a.error || "");
// 审计行说明「为什么问了 / 为什么没问」——这是从 DSH 的 approval 审计对学到的：
// 只写「允许/拒绝」回答不了「这次为什么需要人点头」。
const APPROVAL_REASON_KEY = {
  "always-confirm": "agent.reasonAlwaysConfirm",
  "mode-always": "agent.reasonModeAlways",
  "risky-write": "agent.reasonRiskyWrite",
  "repeated-call": "agent.reasonRepeated",
  "denied-before": "agent.reasonDeniedBefore",
  "mode-never": "agent.reasonModeNever",
  "safe-risk": "agent.reasonSafeRisk",
};
const approvalText = (item) => (APPROVAL_REASON_KEY[item.reason] ? t(APPROVAL_REASON_KEY[item.reason]) : item.reason || t("agent.stepConfirm"));

const fmtNum = (n) => {
  const v = Number(n) || 0;
  return v >= 1000000 ? (v / 1000000).toFixed(1) + "M" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v);
};

// 每次尝试的耗时：收尾后取 endTs；运行中取时钟（1s 刷新），和 DSH 轨迹一样把时间读出来
const fmtMs = (ms) => {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1000) return Math.round(value) + "ms";
  if (value < 60000) return (value / 1000).toFixed(1) + "s";
  const m = Math.floor(value / 60000);
  const s = Math.round((value % 60000) / 1000);
  return m + "m" + String(s).padStart(2, "0") + "s";
};
const attemptSpan = (a) => {
  if (!a || !a.ts) return 0;
  const end = a.endTs || (a.status === "running" ? clock.value : 0);
  return end > a.ts ? end - a.ts : 0;
};
const lastSpan = (item) => (item?.attempts?.length ? attemptSpan(item.attempts[item.attempts.length - 1]) : 0);

// ------- 右栏轨迹：带耗时的工具行 + 搜索 -------
// 搜索匹配工具名、参数与结果文本：排障时记得的往往是路径或关键字，而不是动作名。
const trajectoryQuery = ref("");
const trajectoryRows = computed(() =>
  executionTimeline.value
    .filter((item) => item.kind === "tool")
    .map((item) => {
      const last = item.attempts[item.attempts.length - 1];
      return {
        key: item.id || `${item.tool}@${item.ts}`,
        tool: item.tool,
        status: last.status,
        attempts: item.attempts.length,
        span: lastSpan(item),
        text: [item.tool, ...item.attempts.flatMap((a) => [a.argsText, a.resultText])].join(" ").toLowerCase(),
      };
    })
);
const filteredTrajectory = computed(() => {
  const q = trajectoryQuery.value.trim().toLowerCase();
  return q ? trajectoryRows.value.filter((row) => row.text.includes(q)) : trajectoryRows.value;
});

// 右栏开关直接绑定外壳的 dockOpen：顶栏按钮、面板里的关闭按钮、以及「运行起来自动展开」
// 必须共用同一份真相，否则三个入口会各自维护一个布尔值。
const localMonitor = ref(false);
const monitorVisible = computed({
  get: () => (shell ? shell.dockOpen.value : localMonitor.value),
  set: (value) => {
    if (shell) shell.dockOpen.value = !!value;
    else localMonitor.value = !!value;
  },
});
function toggleMonitor() {
  monitorVisible.value = !monitorVisible.value;
}

// 空闲时右栏不是空仪表盘：列出 Agent 能调用的本地工具。
// 这些工具与「本地工具」目录同源（visibleToolboxTools），打开方式也一致——
// 右栏因此既是运行监控，也是「这轮它能用哪些手」的答案。
const localTools = computed(() => visibleToolboxTools().filter((tool) => tool.ready).slice(0, 6));
function openLocalTool(tool) {
  openToolWindow(tool, { showToast: props.showToast }).catch(() => {});
}

// 会话流里的「我说的那句话」。这是三期相对二期最要紧的一处：
// 二期的主区只有 Agent 的步骤时间线，用户自己的目标不出现在流里，于是它读起来像
// 「运行监视器」而不是对话——翻到一条历史，得回到顶部横幅才知道当初让它干什么。
// 一次运行 = 一轮问答，目标就是这一轮的用户消息（引擎没有多轮会话模型，见
// docs/agent-workspace-plan.md；将来真长出会话模型时，这里换成遍历 turn 即可）。
const threadGoal = computed(() => {
  const viewing = viewRun.value;
  const text = viewing ? viewing.input || "" : agentSession.goal || "";
  return typeof text === "string" ? text.trim() : "";
});
// 当前这条 run 的落盘记录：顶栏标题要读它的重命名（改名后立即反映，不必等切走再回来）
const currentRun = computed(() => agentSession.runs.find((r) => r && r.id === agentSession.currentRunId) || null);

// 这一轮附带过哪些文件：回看读 run 快照，实时读会话字段。只用来「说清当时拿到了什么」，
// 不再参与运行（运行时早把路径拼进提示词了）。
const threadAttachments = computed(() =>
  normalizeAttachments(viewRun.value ? viewRun.value.attachments : agentSession.attachments)
);

// 顶栏投递：标题 = 本轮目标，状态胶囊只在真有运行状态时出现。
// 空闲时不往顶栏塞一个恒亮的「空闲」——顶栏是导航，不是仪表盘。
watch(
  [threadGoal, statusMeta, busy, viewRun, currentRun],
  () => {
    if (!shell) return;
    // 顶栏是导航条：目标原文压成一行主题（与侧栏 conversationTitle 同一投影），
    // 用户重命名过就用自定义标题；完整输入仍在消息流首条。
    const named = viewRun.value?.title || currentRun.value?.title || "";
    shell.thread.title = named || conversationTitle(threadGoal.value);
    // 终态也要留在顶栏（已完成/已取消/失败）：`runStatus` 比 busy 活得久，clearTimeline（新任务）时才清空。
    // 只有「从没跑过」的空闲会话不显示状态——那会是一个恒亮的「空闲」。
    const hasStatus = busy.value || viewRun.value || agentSession.pending || agentSession.runStatus;
    shell.thread.status = hasStatus ? statusMeta.value : null;
  },
  { immediate: true },
);
// 视图被 :key 销毁时把外壳上的会话痕迹清掉：否则切到工作面后顶栏还挂着上一轮的目标，
// 右栏也会空着不关（内容已经随视图卸载了）。
onBeforeUnmount(() => {
  if (!shell) return;
  shell.thread.title = "";
  shell.thread.status = null;
  shell.dockOpen.value = false;
});

// 空态只在「这一轮还没有任何步骤」时出现。回看历史时一律不补空态——
// 横幅与交付清单已经说明了现状，再插一句标语是噪声。
const showEmpty = computed(() => !viewRun.value && !threadGoal.value && !busy.value && !displayedStatus.value && !timeline.value.length && !agentSession.pending);

// registry 的懒加载策略：buildAgentRegistry 会动态拉整套工具实现层
// （executors + luxon/js-yaml 等，实测约 400KB），放首屏就把工具箱的懒加载抵消掉了。
// 所以推迟到两个时机（都走同一个幂等入口）：启动约 1.2s 后若已有历史可续跑就建一次；
// 或用户真的点续跑时（onResume 里 ensure）。resumeMap 在 registry 未就绪时一律判
// 「不可续跑」（按钮先灰后亮，比先亮后灭更少误导），逻辑不变。
let registryFor = null; // 已建 registry 对应的 cfg：换了配置（如关停工具）要重建，否则续跑判定用的是旧开关
let registryBuilding = false;
async function ensureAgentRegistry() {
  const cfg = agentSession.cfg;
  if (!cfg || registryBuilding) return;
  if (agentRegistry.value && registryFor === cfg) return;
  registryBuilding = true;
  const registry = await buildAgentRegistry(cfg);
  registryBuilding = false;
  // 等待期间 cfg 又换过就不落这个结果，下一次触发会按新 cfg 重建
  if (cfg === agentSession.cfg) {
    agentRegistry.value = registry;
    registryFor = cfg;
  }
}

// 首启引导卡：纯本机 UI 状态而非用户数据，所以走 localStorage（先例：themeMode）
const HINT_KEY = "tc.agent.hint";
const hintOpen = ref(false);
try {
  hintOpen.value = localStorage.getItem(HINT_KEY) !== "1";
} catch {
  hintOpen.value = true;
}
function dismissHint() {
  hintOpen.value = false;
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    // 隐私模式写不进去，下次启动再显示一次，无副作用
  }
}

const denyBtn = ref(null);
// 提问卡的回答草稿。与 goal 分开：提问的回答常常是路径这类短文本，不该污染上一条目标。
const answerDraft = ref("");
// 提问卡的选项：点选是「快速组成回答」，不是替用户直接发送——问题和补充内容可能同时要答。
const pickedOptions = ref([]);
const askOptions = computed(() => (Array.isArray(agentSession.pending?.options) ? agentSession.pending.options : []));
const askMultiple = computed(() => agentSession.pending?.multiple === true);
const composedAnswer = computed(() => {
  const picked = pickedOptions.value.join("、");
  const text = answerDraft.value.trim();
  if (picked && text) return picked + "\n" + text;
  return picked || text;
});
function toggleOption(option) {
  const value = String(option);
  if (askMultiple.value) {
    pickedOptions.value = pickedOptions.value.includes(value)
      ? pickedOptions.value.filter((x) => x !== value)
      : [...pickedOptions.value, value];
  } else {
    pickedOptions.value = pickedOptions.value.includes(value) ? [] : [value];
  }
}
const answerBox = ref(null);
const askOptionsRef = ref(null);

onMounted(async () => {
  // 模型胶囊要在首帧显示真名：与 initAgentSession 并行读，两者互不依赖
  loadAIModel();
  await initAgentSession();
  // 有历史才值得提前建 registry（续跑按钮靠它判定）；没有就等 onResume 里 ensure
  setTimeout(() => {
    if (agentSession.runs.length) ensureAgentRegistry();
  }, 1200);
});

/** 读 settings.ai 的模型展示字段（不解密密钥，见 agent/modelPrefs.js）。 */
async function loadAIModel() {
  try {
    aiModel.value = await loadModelChoice();
  } catch {
    // 模型胶囊是展示与切换入口：读不到就保持空，下次打开仍会重试，不拦主流程
  }
}

/** 模型弹层保存成功后回填，并让会话重算 aiReady（首次在这里选模型也能立刻开始运行）。 */
function onModelChanged(saved) {
  aiModel.value = saved;
  refreshAgentConfig().catch(() => {});
}

function onComposerToast(key, params) {
  props.showToast(t(key, params));
}

// ------- 会话绑定当前工作域（三期：上下文） -------
// 领域/代码池数据在**视图**里读、在这里把 contextLine 拼好传给运行——引擎保持无数据依赖
// （session 只透传，见 src/agent/session.js）。选择本身是会话级状态（agentSession.contextDomain），
// 不落 cfg：重启回到「不指定」，一次性上下文不该变成长期默认。
const domains = ref([]);
const pools = ref([]);
// 选中领域（附代码池名）：空 id 或领域已被删都视为「未选」，绝不把失效上下文带进运行
const selectedDomain = computed(() => {
  const id = agentSession.contextDomain;
  if (!id) return null;
  const d = domains.value.find((x) => x.id === id);
  if (!d) return null;
  return { name: d.name, pools: pools.value.filter((p) => p && p.domainId === id).map((p) => p.name) };
});
// 预览行：让用户一眼看到「这次带上了什么上下文」，而不是默默生效
const domainContextText = computed(() =>
  selectedDomain.value ? t("agent.domainContext", { name: selectedDomain.value.name, n: selectedDomain.value.pools.length }) : ""
);
async function loadDomains() {
  try {
    const [ds, ps] = await Promise.all([loadRepo("domains"), loadRepo("pools")]);
    domains.value = Array.isArray(ds) ? ds : [];
    pools.value = Array.isArray(ps) ? ps : [];
  } catch {
    // 领域是可选上下文：读不到就不显示选择器，绝不拦住 Agent 主流程
  }
}
// 输入框里直接新建工作域：数据归视图持有（composer 只发草稿），建成后由 composer 发出选中事件。
// 走 repository.create 而不是整表裸写：与研发模块共用同一写入口，data.* 动作看到的也是它。
async function onCreateDomain(draft, done) {
  try {
    const record = await createRecord("domains", { name: draft.name, note: "" }, { source: "agent" });
    domains.value = [...domains.value, record];
    props.showToast(t("agent.domainCreated", { name: record.name }));
    done?.(null, record);
  } catch (e) {
    props.showToast(t("settings.saveFailed", { err: errText(e) }));
    done?.(e);
  }
}
// onMounted 是真实运行路径；onServerPrefetch 只服务 SSR 渲染测试（浏览器里是空操作），
// 让渲染测试能把假 domains 真正喂进选择器断言（SSR 的 onMounted 不跑，见 render 测试顶部注释）。
onMounted(loadDomains);
onServerPrefetch(loadDomains);

// ------- 结论写回记录（知识沉淀） -------
// 把最终答复一键存成速记/问题：字段映射在 agent/answerDraft.js（纯函数、可单测）。
// 取舍：同一条答复重复点击会创建多条——**有意为之**。速记/问题本就是「随手记」，
// 用户主动点第二次是明确意图，不该被静默去重吞掉；按钮文案保持动词原样，不显示「已保存」。
async function onSaveSnippet(answer) {
  try {
    await createRecord("snippets", answerToSnippetDraft(answer), { source: "agent" });
    props.showToast(t("agent.savedSnippet"));
  } catch (e) {
    props.showToast(t("settings.saveFailed", { err: errText(e) }));
  }
}
async function onSaveProblem(answer) {
  try {
    await createRecord("problems", answerToProblemDraft(answer), { source: "agent" });
    props.showToast(t("agent.savedProblem"));
  } catch (e) {
    props.showToast(t("settings.saveFailed", { err: errText(e) }));
  }
}

function goSettings(section) {
  if (typeof openSettings === "function") openSettings(section);
  else emit("navigate", { module: "settings" });
}

async function startRun() {
  const input = goal.value.trim();
  if (!input || busy.value) return;
  if (!agentSession.aiReady) {
    props.showToast(t("agent.errNoAI"));
    return goSettings("ai");
  }
  track("agent.run");
  // 域绑定：选中域时把领域上下文拼成一行提示，随运行透传（未选域 → 空串，提示词一字不变）
  const contextLine = selectedDomain.value ? buildContextLine(selectedDomain.value, t) : "";
  // 附件：路径清单拼成提示词里的一段，附件本身随 run 记录落盘（回看与导出日志都读它）
  const picked = normalizeAttachments(attachments.value);
  const attachmentLine = attachmentPromptLine(picked);
  goal.value = "";
  const started = await startAgentRun(input, { contextLine, attachmentLine, attachments: picked });
  if (started) {
    attachments.value = [];
    return;
  }
  // 没起来（空目标 / 已有运行）：把草稿还回去，别让用户白写一遍
  if (!goal.value) goal.value = input;
}

/** 新建任务：清空画布、草稿与附件。运行中不清（那等于砍掉正在跑的执行现场）。 */
function onNewTask() {
  if (busy.value) return props.showToast(t("agent.busyNew"));
  viewRunId.value = "";
  goal.value = "";
  attachments.value = [];
  clearTimeline();
  nextTick(() => composerRef.value?.focus());
}

/**
 * 导出运行日志（Markdown）：当前运行优先，其次是被回看的那条。
 * 落盘沿用项目惯例：saveDialog 取目标 → invoke("export_file")（浏览器端转成下载）。
 */
async function exportRun() {
  const run = viewRun.value || agentSession.runs.find((item) => item.id === agentSession.currentRunId);
  if (!run) return props.showToast(t("agent.exportNothing"));
  try {
    const markdown = runToMarkdown(run, t, { noticeText });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes());
    const dest = await saveDialog({
      title: t("agent.exportDlg"),
      defaultPath: "toolcove-run-" + stamp + ".md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!dest) return;
    await invoke("export_file", { path: dest, content: markdown });
    props.showToast(t("agent.exportDone"));
  } catch (e) {
    props.showToast(t("agent.exportFail", { err: errText(e) }));
  }
}

function useExample(key) {
  goal.value = t(key);
  nextTick(() => composerRef.value?.focus());
}

// 确认卡自动聚焦：批准卡聚焦「拒绝」（Enter 落到拒绝上，不会误批准一个写入）；
// 提问卡聚焦输入框（这里要的是内容，不是判断）。
watch(
  () => agentSession.pending,
  async (p) => {
    if (!p) return;
    await nextTick();
    if (p.kind === "ask") {
      answerDraft.value = "";
      pickedOptions.value = [];
      // 有选项时焦点落在第一个选项（选择是主路径）；没有选项才直接进输入框
      if (askOptions.value.length) askOptionsRef.value?.querySelector("button")?.focus();
      else answerBox.value?.focus();
      return;
    }
    denyBtn.value?.focus();
  }
);

function onDecide(approved) {
  if (resolvePending(approved)) props.showToast(t(approved ? "agent.confirmAllow" : "agent.confirmDeny"));
}

/** 提交提问卡的回答（文本）。空回答不发：让用户看见提示，而不是把空串回灌给模型。 */
function onAnswer() {
  if (!answerPending(composedAnswer.value)) {
    props.showToast(t("agent.answerEmpty"));
    return;
  }
  answerDraft.value = "";
  pickedOptions.value = [];
}

function onAnswerKey(e) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    onAnswer();
  }
}

/** 跳过提问 = 放弃这次目标（与 runtime 的 cancelled 语义一致）。 */
function onAnswerSkip() {
  if (stopAgentRun("denied")) props.showToast(t("agent.stopped"));
}

// 工具开关 / 技能库 / 溢出清理的交互已搬进「设置 → Agent」（见 SettingsView.vue）。
// 视图这边只保留运行与回看：主区不再长着一张配置表。

function openManual(toolKey, prefill) {
  const tool = findToolboxTool(toolKey);
  if (!tool) return;
  track("tool." + tool.key);
  // 预填先落 localStorage 再走原流程：独立窗口与内嵌降级都在工具组件 onMounted 消费（见 app/toolPrefill.js）。
  // 已知限制：同工具窗口已开着时 openToolWindow 只聚焦不重挂，预填不会被消费——一期限定「产物 → 新开窗口」场景。
  if (prefill) setToolPrefill(tool.key, prefill);
  const fallback = () => emit("navigate", { module: "toolbox", id: tool.key });
  if (isTauriEnv()) openToolWindow(tool, { showToast: props.showToast, onFallback: fallback });
  else fallback();
}

// 「在工具中打开」：多产物（pdf.split 一次拆出一组文件）一期只接第一个，
// 逐个打开 / 产物面板是二期的活。
function openArtifact(toolName, artifacts) {
  const toolKey = toolMeta.value.get(toolName)?.toolKey;
  const first = artifacts?.[0];
  if (!toolKey || !first) return;
  openManual(toolKey, { kind: "open-file", path: first.path });
}

// —— Agent 演示：「看它怎么操作」 ——
//
// 脚本来自契约里的 demo 声明（见 app/toolDemo.js）+ 这一步的真实参数，所以在界面上演的是
// **这次调用真正发生过的操作**，播放器改的也是工具自己的状态（不是一段伪造的动画）。
// 演示结束后工具有回执（ready/done），这一步才算闭环——否则主窗口无从知道对面演到哪了。
const demoDone = reactive(new Map()); // runId(`${卡片 id}#${尝试号}`) -> { steps, skipped }

/** 这一步有没有可播的演示（契约声明了脚本、且参数齐到能演） */
function demoScriptOf(actionName, args) {
  const toolKey = toolMeta.value.get(actionName)?.toolKey;
  if (!toolKey) return null;
  const script = buildDemoScript(actionDemo(toolKey, actionName), args);
  return isPlayable(script) ? { toolKey, script } : null;
}

// 工具卡的身份来自工具箱注册表：图标与「本地工具」目录同源，不再一律用终端图标
function toolIcon(actionName) {
  const key = toolMeta.value.get(actionName)?.toolKey;
  return (key && findToolboxTool(key)?.icon) || "terminal";
}

async function openDemo(item, attempt) {
  const found = demoScriptOf(item.tool, attempt.args);
  if (!found) return;
  return launchDemo({ ...found, action: item.tool }, `${item.id}#${attempt.n}`, attempt.artifacts?.[0]);
}

/** 演示的统一收尾：可选预填产物 → 投递脚本 → 提示 → 开窗（预填必须等投递落地）。 */
async function launchDemo(found, runId, artifact) {
  const label = findToolboxTool(found.toolKey)?.labelKey;
  track("tool.demo." + found.toolKey);
  // 结果里有落盘产物的动作（pdf.*）：演示的前提是工具里先有那份文件，
  // 所以顺带把产物预填过去（与「在工具中打开」同一条交接机制），否则演示只能指着一片空白。
  if (artifact) setToolPrefill(found.toolKey, { kind: "open-file", path: artifact.path });
  // 必须**等投递落地**再开窗：写存储是异步的，抢在它之前开窗会让新窗口挂载时读到空，
  // 表现就是「点了没反应」（静默退化）。已开着的工具还会经实时通道额外收到一份。
  await sendDemo({ toolKey: found.toolKey, action: found.action, runId, script: found.script });
  props.showToast(t("agent.demoOpening", { tool: label ? t(label) : found.toolKey }));
  openManual(found.toolKey);
}

// ------- 直播：运行到支持演示的工具时，把这步真操作投到工具窗口 -------
// tool_start 已带 args，所以不必等结果就能生成脚本。只在用户点「在工具中观看」时开窗
// （自动弹窗会打断阅读），且与事后回放共用同一个播放器与回执通道。
const liveDemos = computed(() => {
  const map = new Map();
  if (viewRun.value) return map;
  for (const item of timeline.value) {
    if (item.kind !== "tool" || !item.id) continue;
    const last = item.attempts[item.attempts.length - 1];
    if (!last || last.status !== "running" || last.args == null) continue;
    const found = demoScriptOf(item.tool, last.args);
    if (found) map.set(item.id, { item, attempt: last, action: item.tool, ...found });
  }
  return map;
});

async function openLiveDemo(found) {
  if (!found) return;
  return launchDemo(found, `${found.item.id}#${found.attempt.n}`);
}

let offDemoSignal = null;
onMounted(() => {
  offDemoSignal = onDemoSignal((signal) => {
    if (!signal || !signal.runId) return;
    // ready：工具那边开播了 → 清掉这一条上旧的「已演示」结论（重播后不该还挂着上一轮的结论）
    if (signal.kind === "ready") {
      demoDone.delete(signal.runId);
      return;
    }
    if (signal.kind !== "done") return;
    demoDone.set(signal.runId, { steps: Number(signal.steps) || 0, skipped: !!signal.skipped });
  });
});
onBeforeUnmount(() => offDemoSignal?.());

async function onCopy(text, okKey) {
  try {
    await navigator.clipboard.writeText(text);
    props.showToast(t(okKey));
  } catch {
    props.showToast(t("agent.copyFail"));
  }
}

function onRerun(rec) {
  viewRunId.value = ""; // 输入框在回看模式下是藏的：先退出回看，重填的目标才看得见
  goal.value = rec.input || "";
  // 重跑沿用原附件：那次运行拿到过什么，这次也该拿到
  attachments.value = normalizeAttachments(rec.attachments);
  nextTick(() => composerRef.value?.focus());
}

async function onResume(rec) {
  // 续跑判定要 registry：二期入口（回看横幅）不再经过左栏 pointerenter，
  // 这里主动 ensure 一次（幂等；registry 未就绪时 resumeMap 判「不可续跑」的语义不变）
  await ensureAgentRegistry();
  if (!resumeMap.value.get(rec.id)) return props.showToast(t("agent.resumeBlocked"));
  if (!agentSession.aiReady) {
    props.showToast(t("agent.errNoAI"));
    return goSettings("ai");
  }
  viewRunId.value = ""; // 续跑即回到实时画布
  track("agent.resume");
  await resumeAgentRun(rec);
}

// ------- 知识沉淀：把成功路径提升为技能 -------
// 技能库本身的开关 / 删除在设置页；这里只留「这一轮跑得好，存下来」这个当场的动作。
async function onPromoteRun(runId) {
  try {
    let result = await promoteRunToSkill(runId);
    // 语义说「这条大概是一次性的」——不替用户拍板，问一句再沉淀（技能库也可能是他自己想留的路径）
    if (!result.ok && result.reason === "not_reusable") {
      const go = await askConfirm({
        title: t("agent.skillReusableTitle"),
        message: t("agent.skillReusableMsg", { weakest: Number.isFinite(result.weakest) ? result.weakest.toFixed(2) : "?" }),
        okText: t("agent.skillReusableOk"),
        danger: false,
      });
      if (!go) return;
      result = await promoteRunToSkill(runId, { force: true });
    }
    if (!result.ok) {
      props.showToast(t("agent.skillNotSkillable"));
      return;
    }
    track("agent.skill.save");
    props.showToast(t(result.updated ? "agent.skillUpdated" : "agent.skillSaved", { name: result.skill.name }));
  } catch (e) {
    props.showToast(t("settings.saveFailed", { err: errText(e) }));
  }
}

// ------- Summary 交付清单（纯派生，不改引擎） -------
// 为什么是派生而不是引擎生成：一期不动 session.js 的收尾逻辑，视图从现有 steps 现算一份；
// 把 summary 写进 run 记录落盘是二期的任务列表升级（见 docs/agent-workspace-plan.md）。
// 二期：数据源参数化——回看历史时吃该 run 的快照（落盘 run 没有 error 字段，缺什么显示什么）。
const TERMINAL_STATUS = new Set(["completed", "failed", "cancelled", "max_steps"]);
const runSummary = computed(() => {
  const viewing = viewRun.value;
  const status = viewing ? viewing.status : agentSession.runStatus;
  if (!TERMINAL_STATUS.has(status)) return null;
  const counts = new Map();
  const seen = new Set();
  const artifacts = [];
  const demos = new Map();
  for (const item of timeline.value) {
    if (item.kind !== "tool") continue;
    // 工具卡一张 = 一次调用（重试是卡内的多次尝试，不重复计数）
    counts.set(item.tool, (counts.get(item.tool) || 0) + 1);
    for (const a of item.attempts) {
      if (a.status !== "ok") continue;
      // 演示入口属于结果面：交付清单里直接给「看它怎么操作」，不必翻进执行记录
      const found = demoScriptOf(item.tool, a.args);
      if (found) demos.set(item.tool, { item, attempt: a });
      for (const art of a.artifacts || []) {
        if (seen.has(art.path)) continue;
        seen.add(art.path);
        artifacts.push({ ...art, tool: item.tool });
      }
    }
  }
  if (!artifacts.length && (status !== "completed" || !counts.size)) return null;
  return {
    titleKey: status === "completed" ? "agent.summaryTitle" : "agent.partialArtifacts",
    tools: [...counts].map(([name, count]) => ({ name, count, demo: demos.get(name) || null })),
    artifacts,
  };
});
const outcome = computed(() => {
  const status = displayedStatus.value;
  if (!["cancelled", "failed", "max_steps"].includes(status)) return null;
  const reason = viewRun.value
    ? viewRun.value.error || sourceSteps.value.findLast((step) => step.type === "notice" && step.code === "failed")?.text || ""
    : errorText.value;
  return {
    status,
    message: status === "failed" ? reason || t("agent.failedHint") : t(status === "cancelled" ? "agent.cancelledHint" : "agent.limitHint"),
  };
});

// ------- 运行进度条的数据来源 -------
// 全部是**派生**的，不改引擎：runStatus 反映已结束的运行，status 反映进行中的状态。
const progressStatus = computed(() => agentSession.runStatus || agentSession.status || "");

/** 正在执行的工具：取最后一个尚未收到结果的 tool_start。
 *  重试会再发一次 tool_start（同一 id），所以按 id 去重后看最后一个。 */
const currentTool = computed(() => {
  if (agentSession.status !== "running" && agentSession.status !== "waiting") return "";
  const steps = agentSession.steps;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s?.type === "tool_start") return s.tool || "";
    if (s?.type === "tool_result" || s?.type === "tool_error") return "";
  }
  return "";
});

/** 步数上限：来自本次运行实际生效的配置（resolveRunOptions 已钳制到硬上限） */
const maxSteps = computed(() => Number(agentSession.cfg?.maxSteps) || 0);
const usageText = computed(() => (agentSession.usage.totalTokens ? fmtNum(agentSession.usage.totalTokens) : ""));
</script>

<template>
  <div class="agent">
    <!-- 会话头已经上移到外壳的单一顶栏（标题 / 状态 / 右栏开关都在那里），
         这里不再叠第二条 bar。 -->
    <div class="body" :class="{ 'body-insp': selectedStep }">
      <!-- 对话列：消息流占满剩余高度，输入框钉在底部。
           这是主流 agent 产品的固定骨架（Qoder「输入框位于中央区域底部」、
           VS Code Chat view 的 sessions/对话/输入三段、Zed 的 message editor 在面板底部），
           二期的实现恰好相反——输入框浮在页面中部、空态标语落在它下面。 -->
      <div class="canvas">
        <!-- 历史任务回看横幅：画布只读渲染该 run 的 steps 快照。
             续跑/重跑按钮复用主流程（内部会先退出回看）；「返回当前」回到实时画布。 -->
        <section v-if="viewRun" class="view-banner">
          <Icon name="clock" :size="14" />
          <span class="vb-label">{{ t("agent.viewingHistory") }}</span>
          <span class="vb-input" :title="viewRun.input">{{ viewRun.input }}</span>
          <span class="vb-actions">
            <button class="link xs" :disabled="busy" @click="onResume(viewRun)">{{ t("agent.resume") }}</button>
            <button class="link xs" :disabled="busy" @click="onRerun(viewRun)">{{ t("agent.rerun") }}</button>
            <button class="btn-ghost xs" @click="backToCurrent">{{ t("agent.backToCurrent") }}</button>
          </span>
        </section>

        <!-- 管线条：这一轮的工具步 + 正在等确认的那一步。点节点跳到对应卡片；
             不替代对话流，只做「现在在哪、下一步是什么」的常驻入口。 -->
        <nav v-if="pipelineNodes.length || pendingTool" class="pipe" :aria-label="t('agent.trajectoryTitle')">
          <span class="pipe-label">{{ t("agent.trajectoryTitle") }}</span>
          <div class="pipe-track">
            <button
              v-for="node in pipelineNodes"
              :key="node.id"
              type="button"
              class="pipe-node"
              :class="'s-' + node.status"
              :title="node.tool"
              :aria-pressed="selectedStepId === node.id"
              @click="selectStep(node.id)"
            >
              <span class="pn-no">{{ String(node.n).padStart(2, "0") }}</span>
              <span class="pn-name">{{ node.tool }}</span>
              <span v-if="node.status === 'running'" class="pn-live" aria-hidden="true"></span>
              <span v-else class="pn-meta">{{ node.spanText }}</span>
            </button>
            <button v-if="pendingTool" type="button" class="pipe-node s-wait" :title="pendingTool" @click="focusPending">
              <span class="pn-no">{{ String(pipelineNodes.length + 1).padStart(2, "0") }}</span>
              <span class="pn-name">{{ pendingTool }}</span>
              <span class="pn-meta pn-wait">{{ t("agent.approvalPending") }}</span>
            </button>
          </div>
        </nav>

        <div ref="scrollEl" class="scroll">
          <!-- 我说的那句话：会话流的第一条消息。回看历史时它就是当初那条目标，
               实时运行时是本次运行的目标（goal 在 startRun 成功后即被清空，
               所以这里读 agentSession.goal，而不是输入框的草稿）。 -->
          <article v-if="threadGoal" class="msg msg-user">
            <span class="msg-av"><Icon name="user" :size="13" /></span>
            <div class="msg-body">
              <span class="msg-who">{{ t("agent.you") }}</span>
              <p class="msg-text">{{ threadGoal }}</p>
              <!-- 附件与目标放在一起：翻历史时要能看出「这一轮它手里有过哪些文件」 -->
              <div v-if="threadAttachments.length" class="msg-atts">
                <span v-for="item in threadAttachments" :key="item.id || item.path || item.name" class="msg-att" :title="item.path || item.name">
                  <Icon :name="attachmentIcon(item.kind)" :size="12" />
                  <span class="msg-att-name">{{ item.name }}</span>
                </span>
              </div>
            </div>
          </article>

          <!-- 内联确认卡：运行时交给我们的是 Promise，卡片能展示工具名 / 风险 / 完整 args，
               全局 askConfirm 模态做不到，而且不会盖住用户正在看的时间线。
               它属于实时运行：回看历史时照常显示——后台运行来了一张确认卡，人仍要答得上。 -->
          <section v-if="agentSession.pending" ref="confirmEl" class="confirm" :class="'risk-' + (agentSession.pending.risk || 'ask')">
            <p v-if="viewRun" class="cf-hint">{{ t("agent.backgroundTask") }} · {{ agentSession.goal }}</p>
            <div class="cf-head">
              <Icon name="alert" :size="15" />
              <b>{{ agentSession.pending.kind === "tool" ? t("agent.confirmTitle") : t("agent.needInput") }}</b>
              <span v-if="agentSession.pending.risk" class="tc-chip sm" :class="riskChip(agentSession.pending.risk)">
                {{ t(riskKey(agentSession.pending.risk)) }}
              </span>
              <span v-if="agentSession.pending.kind === 'tool'" class="cf-wait">{{ t("agent.approvalPending") }}</span>
            </div>
            <!-- 提问卡：ask_user 要的是**文本**答案（路径、SQL、口令…），不是允许/拒绝。
                 旧实现把它画成同一张确认卡，于是「允许」把布尔当答案回灌，模型只会再问一遍。 -->
            <template v-if="agentSession.pending.kind === 'ask'">
              <p class="cf-question">{{ agentSession.pending.question }}</p>
              <!-- 候选项：点选只是快速组成回答，发送仍由用户确认；自由文本入口始终保留 -->
              <div v-if="askOptions.length" ref="askOptionsRef" class="cf-options" role="group" :aria-label="t('agent.askOptionsLabel')">
                <button
                  v-for="option in askOptions"
                  :key="option"
                  type="button"
                  class="cf-option"
                  :class="{ on: pickedOptions.includes(option) }"
                  :aria-pressed="pickedOptions.includes(option)"
                  @click="toggleOption(option)"
                >
                  <Icon v-if="pickedOptions.includes(option)" name="check" :size="12" />
                  {{ option }}
                </button>
              </div>
              <textarea
                ref="answerBox"
                v-model="answerDraft"
                class="cf-answer"
                rows="3"
                :aria-label="agentSession.pending.question"
                :placeholder="askOptions.length ? t('agent.answerExtraPh') : t('agent.answerPlaceholder')"
                @keydown="onAnswerKey"
              ></textarea>
              <p class="cf-hint">
                {{ askOptions.length ? t(askMultiple ? "agent.askOptionsHintMulti" : "agent.askOptionsHint") : t("agent.answerHint") }}
              </p>
              <div class="cf-actions">
                <button class="btn-ghost sm" @click="onAnswerSkip">{{ t("agent.answerSkip") }}</button>
                <button class="btn-primary sm" :disabled="!composedAnswer" @click="onAnswer">{{ t("agent.answerSend") }}</button>
              </div>
            </template>
            <template v-else>
              <code v-if="agentSession.pending.kind === 'tool'" class="cf-tool">{{ agentSession.pending.tool }}</code>
              <!-- 写前预览：runtime 在问人之前已经把旧内容读出来做过 diff，这里只负责显示。
                   长文件只给改动附近的若干行，并明说这是节选——否则「改动在文件末尾」会看不见。 -->
              <div v-if="pendingPreview" class="cf-preview">
                <div class="cf-pv-head">
                  <b>{{ t("agent.previewTitle") }}</b>
                  <code class="cf-pv-path">{{ pendingPreview.path }}</code>
                  <span v-if="pendingPreview.isNew" class="tc-chip sm tc-primary">{{ t("agent.previewNewChip") }}</span>
                  <span v-else-if="!pendingPreview.hasChanges" class="tc-chip sm tc-neutral">{{ t("agent.previewSame") }}</span>
                  <span v-else class="cf-pv-stat">
                    +{{ pendingPreview.added }} / -{{ pendingPreview.removed }}
                    <!-- 单行替换在 textDiff 里是 modified（既不算增也不算删）：不显式写出来，
                         「有 diff 行、计数却是 +0 / -0」会让人以为没改动 -->
                    <template v-if="pendingPreview.modified">{{ " " }}· {{ t("agent.previewModified", { n: pendingPreview.modified }) }}</template>
                  </span>
                </div>
                <div v-if="pendingPreview.rows.length" class="cf-pv-body">
                  <div v-for="(row, i) in pendingPreview.rows" :key="i" class="cf-pv-row" :class="'pv-' + rowKind(row)">
                    <span class="cf-pv-no">{{ row.right?.number ?? row.left?.number ?? "" }}</span>
                    <span class="cf-pv-text">{{ rowText(row) }}</span>
                  </div>
                </div>
                <!-- 有 diff 却一行都取不出来 / 没有 diff：都要说清原因，
                     否则「卡片上一个字都没有」比没有预览更让人困惑（用户实测反馈）。 -->
                <p v-else-if="pendingPreview.schemaUnsupported" class="cf-pv-more">{{ t("agent.previewUnreadable") }}</p>
                <p v-else-if="!pendingPreview.hasChanges" class="cf-pv-more">{{ t("agent.previewSame") }}</p>
                <p v-if="pendingPreview.hidden > 0" class="cf-pv-more">
                  {{ t("agent.previewTruncated", { shown: pendingPreview.shown, total: pendingPreview.total }) }}
                </p>
              </div>
              <pre v-if="agentSession.pending.args" class="cf-args">{{ payloadText(agentSession.pending.args) }}</pre>
              <p class="cf-hint">{{ t("agent.confirmArgsHint") }}</p>
              <div class="cf-foot">
                <p v-if="agentSession.pending.kind === 'tool'" class="cf-once">{{ t("agent.confirmOnce") }}</p>
                <div class="cf-actions">
                  <button ref="denyBtn" class="btn-ghost sm" @click="onDecide(false)">{{ t("agent.confirmDeny") }}</button>
                  <button class="btn-primary sm" @click="onDecide(true)">{{ t("agent.confirmAllow") }}</button>
                </div>
              </div>
            </template>
          </section>

          <details v-if="executionTimeline.length" :key="viewRunId || agentSession.currentRunId" ref="executionEl" class="execution" @toggle="onExecutionToggle">
            <summary class="execution-head">
              <Icon name="chevron-right" :size="13" class="execution-arrow" />
              <span>{{ t("agent.executionTitle") }}</span>
              <span class="execution-count">{{ t("agent.eventCount", { n: executionTimeline.length }) }}</span>
              <span class="execution-usage">{{ t("agent.tokensCount", { n: fmtNum(displayedUsage.totalTokens) }) }}</span>
            </summary>
            <div class="execution-meta">
              <span>{{ t("agent.toolCallsCount", { n: toolCount }) }}</span>
              <span>{{ t("agent.modelCallsCount", { n: displayedUsage.calls || 0 }) }}</span>
              <span v-if="runModelText">{{ t("agent.runModel", { model: runModelText }) }}</span>
            </div>
            <!-- 泳道：模型 / 工具 / 确认三条时间道，运行中随事件生长 -->
            <ExecutionLanes :steps="sourceSteps" :running="busy && !viewRun" :now="clock" />
            <section class="timeline">
            <template v-for="(item, index) in executionTimeline" :key="cardKey(item, index)">
              <article v-if="item.kind === 'tool'" :data-step-id="item.id" class="tl-card" :data-status="item.attempts[item.attempts.length - 1].status" :data-motion="motionKind(item.tool)" data-role="tool-card">
                <button
                  class="tl-head"
                  :aria-expanded="openCards.has(cardKey(item, index))"
                  @click="toggle(openCards, cardKey(item, index))"
                >
                  <Icon name="chevron-right" :size="13" class="tl-arrow" :class="{ open: openCards.has(cardKey(item, index)) }" />
                  <Icon :name="toolIcon(item.tool)" :size="14" class="tl-ico" />
                  <code class="tl-name">{{ item.tool }}</code>
                  <span class="tc-chip sm" :class="riskChip(toolMeta.get(item.tool)?.risk)">
                    {{ t(riskKey(toolMeta.get(item.tool)?.risk)) }}
                  </span>
                  <span v-if="item.attempts.length > 1" class="tl-n">{{ t("agent.attempt", { n: item.attempts.length }) }}</span>
                  <span v-if="lastSpan(item)" class="tl-dur" :title="t('agent.toolDuration', { dur: fmtMs(lastSpan(item)) })">{{ fmtMs(lastSpan(item)) }}</span>
                  <span class="tl-badge" :class="'b-' + item.attempts[item.attempts.length - 1].status">
                    {{ t(ATTEMPT_KEY[item.attempts[item.attempts.length - 1].status]) }}
                  </span>
                </button>
                <!-- 直播入口：这一步还在跑、且动作有演示脚本时出现。点开才开窗，不自动打扰 -->
                <div v-if="liveDemos.get(item.id)" class="tl-live-row">
                  <button class="link xs demo-in-tool" data-role="watch-live" @click="openLiveDemo(liveDemos.get(item.id))">
                    <Icon name="sparkles" :size="12" />{{ t("agent.watchLive") }}
                  </button>
                </div>
                <div v-if="openCards.has(cardKey(item, index))" class="tl-body">
                  <div v-for="a in item.attempts" :key="a.n" class="tl-attempt">
                    <div class="ta-head">
                      <span class="ta-n">{{ t("agent.attempt", { n: a.n }) }}</span>
                      <span class="tl-badge sm" :class="'b-' + a.status">{{ t(ATTEMPT_KEY[a.status]) }}</span>
                      <span v-if="attemptSpan(a)" class="ta-dur">{{ fmtMs(attemptSpan(a)) }}</span>
                    </div>
                    <div v-if="a.args != null" class="payload">
                      <div class="pl-head">
                        <span>{{ t("agent.args") }}</span>
                        <button class="link xs" @click="onCopy(a.argsText, 'agent.copied')">{{ t("agent.copy") }}</button>
                        <button
                          v-if="a.argsText.length > COLLAPSE_AT"
                          class="link xs"
                          @click="toggle(openPayloads, item.id + '#' + a.n + '#args')"
                        >
                          {{ openPayloads.has(item.id + "#" + a.n + "#args") ? t("agent.hideArgs") : t("agent.showArgs") }}
                        </button>
                      </div>
                      <pre
                        class="pl-body"
                        :class="{ clipped: a.argsText.length > COLLAPSE_AT && !openPayloads.has(item.id + '#' + a.n + '#args') }"
                      >{{ a.argsText }}</pre>
                    </div>
                    <div v-if="a.status === 'ok' && a.result != null" class="payload">
                      <div class="pl-head">
                        <span>{{ t("agent.stepResult") }}</span>
                        <button class="link xs" @click="onCopy(a.resultText, 'agent.copied')">{{ t("agent.copy") }}</button>
                        <button
                          v-if="a.resultText.length > COLLAPSE_AT"
                          class="link xs"
                          @click="toggle(openPayloads, item.id + '#' + a.n + '#result')"
                        >
                          {{ openPayloads.has(item.id + "#" + a.n + "#result") ? t("agent.hideResult") : t("agent.showResult") }}
                        </button>
                        <!-- 产物「在工具中打开」：结果里有落盘文件、且该动作挂了工具箱工具时出现 -->
                        <button
                          v-if="a.artifacts.length && toolMeta.get(item.tool)?.toolKey"
                          class="link xs open-in-tool"
                          @click="openArtifact(item.tool, a.artifacts)"
                        >
                          <Icon name="open" :size="12" />{{ t("agent.openInTool") }}
                        </button>
                        <!-- 「看它怎么操作」：动作在契约里声明了演示脚本时出现，
                             点一下就把这次调用的操作在工具界面上重演一遍 -->
                        <button
                          v-if="demoScriptOf(item.tool, a.args)"
                          class="link xs demo-in-tool"
                          data-role="watch-demo"
                          @click="openDemo(item, a)"
                        >
                          <Icon name="sparkles" :size="12" />{{ t("agent.watchDemo") }}
                        </button>
                      </div>
                      <pre
                        class="pl-body"
                        :class="{ clipped: a.resultText.length > COLLAPSE_AT && !openPayloads.has(item.id + '#' + a.n + '#result') }"
                      >{{ a.resultText }}</pre>
                    </div>
                    <p v-if="a.error" class="ta-error"><Icon name="alert" :size="12" />{{ attemptText(a) }}</p>
                    <!-- 演示回执：工具那边播完（或被跳过）后由它回信，主窗口据此把「已演示过」写在这一步上 -->
                    <p v-if="demoDone.get(item.id + '#' + a.n)" class="ta-demo" data-role="demo-done">
                      <Icon name="sparkles" :size="12" />
                      <template v-if="demoDone.get(item.id + '#' + a.n).skipped">{{ t("agent.demoDoneSkipped") }}</template>
                      <template v-else>{{ t("agent.demoDone", { n: demoDone.get(item.id + '#' + a.n).steps }) }}</template>
                    </p>
                  </div>
                </div>
              </article>

              <article v-else-if="item.kind === 'confirm'" class="tl-row tl-confirm">
                <Icon :name="item.answer ? 'check' : 'x'" :size="14" />
                <code v-if="item.tool" class="tl-name">{{ item.tool }}</code>
                <span class="tl-text">{{ item.tool ? t("agent.stepConfirm") : item.question }}</span>
                <!-- 提问的回答是文本：原来这里一律渲染成「允许」，等于把用户填的路径丢掉，
                     历史里看不出自己答了什么（用户实测反馈的同一条链）。 -->
                <b v-if="isTextAnswer(item.answer)" class="ok ans-text" :title="item.answer">{{ t("agent.answered", { text: item.answer }) }}</b>
                <b v-else :class="item.answer ? 'ok' : 'no'">{{ item.answer ? t("agent.confirmAllow") : t("agent.confirmDeny") }}</b>
              </article>

              <article v-else-if="item.kind === 'approval'" class="tl-row tl-approval">
                <Icon :name="item.decided ? (item.approved ? 'check' : 'x') : 'alert'" :size="14" />
                <code class="tl-name">{{ item.tool }}</code>
                <span class="tl-text">{{ approvalText(item) }}</span>
                <b v-if="item.decided" :class="item.approved ? 'ok' : 'no'">
                  {{ item.approved ? (item.source === "human" ? t("agent.approvalAllowed") : t("agent.approvalAllowedPolicy")) : t("agent.approvalDenied") }}
                </b>
                <span v-else class="tl-text">{{ t("agent.approvalPending") }}</span>
              </article>

              <article v-else-if="item.kind === 'notice'" class="tl-row tl-notice">
                <Icon name="activity" :size="14" />
                <span class="tl-text">{{ noticeText(item) }}</span>
                <span v-if="item.attempt" class="tl-n">{{ t("agent.retryAttempt", { n: item.attempt }) }}</span>
              </article>
            </template>
            </section>
          </details>

          <div v-if="busy && !viewRun" class="working" role="status">
            <span class="dot"></span>
            <span>{{ agentSession.status === "waiting" ? t("agent.statusWaiting") : currentTool || t("agent.running") }}</span>
          </div>

          <section v-if="answers.length" class="answers">
              <article v-for="(item, index) in answers" :key="index" class="answer-card">
                <div class="ans-head">
                  <Icon name="sparkles" :size="14" />
                  <b>{{ t("agent.stepFinal") }}</b>
                  <button class="link xs" @click="onCopy(item.answer, 'agent.copied')">{{ t("agent.copyAnswer") }}</button>
                  <!-- 知识沉淀：把结论一键写回记录。重复点击会创建多条——有意为之（见 script 注释），
                       文案保持动词原样、不显示「已保存」，避免暗示一种不存在的状态。 -->
                  <button class="link xs" @click="onSaveSnippet(item.answer)">{{ t("agent.saveToSnippet") }}</button>
                  <button class="link xs" @click="onSaveProblem(item.answer)">{{ t("agent.saveToProblem") }}</button>
                  <!-- 沉淀为技能：只有真的跑成功、且用过工具的运行才值得复用（引擎侧判定）；
                       回看历史时作用于被回看的那条 run -->
                  <button
                    v-if="(viewRun ? viewRun.status : agentSession.runStatus) === 'completed'"
                    class="link xs ans-skill"
                    :title="t('agent.skillPromoteTip')"
                    @click="onPromoteRun(viewRun ? viewRun.id : agentSession.currentRunId)"
                  >
                    <Icon name="sparkles" :size="12" />{{ t("agent.skillPromote") }}
                  </button>
                </div>
                <MarkdownRender :text="item.answer" :show-toast="showToast" />
              </article>
          </section>
          <section v-for="(item, index) in reviewNotices" :key="index" class="review-notice" role="status">
            <Icon name="alert" :size="15" />
            <span>{{ noticeText(item) }}</span>
          </section>

          <!-- 空态：输入框正上方的那块地方。二期的空态标语落在输入框**下面**——
               新用户按从上到下的顺序读，先看到输入框、再看到"说一件事"，逻辑是反的。
               现在它待在消息流该在的位置（输入框上方），一旦有了第一条步骤就消失。
               示例提示也收进这里：二期那张可关闭的欢迎卡与空态标语同时在首屏出现，
               两块内容讲同一件事，互相稀释。 -->
          <div v-if="showEmpty" class="empty canvas-empty">
            <span class="ce-mark"><Icon name="sparkles" :size="24" /></span>
            <h2 class="ce-slogan">{{ t("agent.emptySlogan") }}</h2>
            <p class="ce-hint">{{ t("agent.emptyHint") }}</p>
            <!-- 三个例子收成一排胶囊：空态的主角是「说一句话」这件事，
                 三行带箭头的条目会让首屏读起来像工具目录（DSH 的空态同样只有标语 + 少数入口）。 -->
            <div class="ce-examples">
              <button v-for="(icon, index) in ['braces', 'zap', 'git-compare']" :key="icon" class="ce-chip" @click="useExample('agent.example' + (index + 1))">
                <Icon :name="icon" :size="13" />
                {{ t('agent.exampleTitle' + (index + 1)) }}
              </button>
            </div>
            <!-- 首启说明：确认行为是这个产品最需要提前讲清楚的一件事（写文件会先问）。
                 只讲一次、可关掉，且只在空态出现——不再是压在消息流顶上的一条横幅。 -->
            <p v-if="hintOpen" class="ce-note">
              <Icon name="shield" :size="12" />{{ t("agent.hintBody") }}
              <button class="link xs" @click="dismissHint">{{ t("agent.hintDismiss") }}</button>
            </p>
          </div>

          <section v-if="outcome" class="outcome" :class="'outcome-' + outcome.status" role="status">
            <span class="outcome-icon"><Icon :name="statusMeta.icon" :size="18" /></span>
            <div class="outcome-body">
              <h3>{{ t(statusMeta.key) }}</h3>
              <p>{{ outcome.message }}</p>
              <button class="btn-ghost sm" :disabled="busy" @click="onRerun({ input: threadGoal })">
                <Icon name="repeat" :size="13" />{{ t("agent.rerun") }}
              </button>
            </div>
          </section>

          <section v-if="runSummary" class="sum-card">
            <div class="sum-head">
              <Icon name="file" :size="14" />
              <b>{{ t(runSummary.titleKey) }}</b>
            </div>
            <div v-if="runSummary.tools.length" class="sum-row">
              <span class="sum-label">{{ t("agent.summaryTools") }}</span>
              <span v-for="x in runSummary.tools" :key="x.name" class="sum-tool">
                <span class="tc-chip sm tc-neutral">{{ x.name }} × {{ x.count }}</span>
                <button
                  v-if="x.demo"
                  class="link xs demo-in-tool"
                  data-role="watch-demo-summary"
                  @click="openDemo(x.demo.item, x.demo.attempt)"
                >
                  <Icon name="sparkles" :size="12" />{{ t("agent.watchDemo") }}
                </button>
              </span>
            </div>
            <div v-if="runSummary.artifacts.length" class="sum-row">
              <span class="sum-label">{{ t("agent.summaryArtifacts") }}</span>
              <button
                v-for="art in runSummary.artifacts"
                :key="art.path"
                class="m-chip"
                :title="art.path + ' · ' + t('agent.openInTool')"
                @click="openArtifact(art.tool, [art])"
              >
                <Icon name="open" :size="12" />{{ art.label }}
              </button>
            </div>
          </section>
        </div>

        <!-- 输入框：钉在对话列底部。它是这一屏唯一的操作面（attachments/上下文/发送
             在同一条横带上），而不是页面中部的一块卡片——二期的输入框会随内容滚走，
             翻历史翻到一半想接着问，得先滚回页面中间。 -->
        <footer class="composer">
          <!-- 未配置模型：两条出路贴着被禁用的运行按钮，而不是压在整个消息流顶上 -->
          <section v-if="!agentSession.aiReady" class="noai">
            <Icon name="sparkles" :size="18" />
            <div class="noai-text">
              <b>{{ t("agent.empty") }}</b>
              <p>{{ t("agent.settingsHint") }}</p>
            </div>
            <div class="noai-actions">
              <button class="btn-primary sm" @click="goSettings('ai')">{{ t("agent.configureAI") }}</button>
              <button class="btn-ghost sm" @click="emit('navigate', { module: 'toolbox' })">{{ t("agent.openToolbox") }}</button>
            </div>
          </section>

          <!-- 实时进度：把「现在在干嘛、走到哪、还剩多少步」压成一行，紧贴输入框。
               参考 Qoder 的会话底部 todo / OpenHands 把活动指示放进 composer —— 三态一眼可读，
               不必去翻时间线猜。只在运行或等待确认时出现，跑完就收（终态由交付清单表达）。 -->
          <div v-if="viewRun && busy" class="background-run">
            <span>{{ t("agent.backgroundTask") }} · {{ agentSession.goal }}</span>
            <button class="btn-ghost sm" @click="backToCurrent">{{ t("agent.backToCurrent") }}</button>
            <button class="btn-outline danger sm" @click="stopAgentRun('user')">{{ t("agent.stop") }}</button>
          </div>
          <RunProgress
            v-if="busy || agentSession.pending"
            class="agent-progress"
            :steps="agentSession.steps"
            :status="progressStatus"
            :current-tool="currentTool"
            :max-steps="maxSteps"
            :tokens="usageText"
          />

          <!-- 目标输入框在回看模式下隐藏：历史是只读的，留着输入框会让人以为在编辑历史。
               附件 / 指令 / 模型 / 工作域 / 发送全部收在 AgentComposer 这一条横带上。 -->
          <AgentComposer
            v-if="!viewRun"
            ref="composerRef"
            v-model:goal="goal"
            v-model:attachments="attachments"
            v-model:context-domain="agentSession.contextDomain"
            :busy="busy"
            :ai-ready="agentSession.aiReady"
            :domains="domains"
            :context-note="domainContextText"
            :model-name="aiModel.model"
            :model-base="aiModel.baseUrl"
            :effort="aiModel.reasoningEffort"
            :profiles="aiModel.profiles || []"
            :profile-id="aiModel.profileId || ''"
            :placeholder="t(busy ? 'agent.nextGoalPh' : 'agent.goalPh')"
            @submit="startRun"
            @stop="stopAgentRun('user')"
            @new-task="onNewTask"
            @export-run="exportRun"
            @open-settings="goSettings('ai')"
            @model-changed="onModelChanged"
            @create-domain="onCreateDomain"
            @toast="onComposerToast"
          />
        </footer>
      </div>

      <!-- 检查器：轨迹选中某一步时的速览。对话流仍是「记录」，这里只回答这一步干了什么。 -->
      <aside v-if="selectedStep" class="insp" :aria-label="t('agent.args')">
        <header class="insp-head">
          <code class="insp-name" :title="selectedStep.tool">{{ selectedStep.tool }}</code>
          <span class="tc-chip sm" :class="riskChip(toolMeta.get(selectedStep.tool)?.risk)">
            {{ t(riskKey(toolMeta.get(selectedStep.tool)?.risk)) }}
          </span>
          <button class="insp-x" type="button" :aria-label="t('agent.backToCurrent')" @click="selectedStepId = ''">
            <Icon name="x" :size="14" />
          </button>
        </header>
        <div class="insp-body">
          <div v-for="a in selectedStep.attempts" :key="a.n" class="insp-att">
            <div class="ia-head">
              <span class="ia-n">{{ t("agent.attempt", { n: a.n }) }}</span>
              <span class="ia-st">{{ t(ATTEMPT_KEY[a.status]) }}</span>
              <span v-if="attemptSpan(a)" class="ia-dur">{{ fmtMs(attemptSpan(a)) }}</span>
            </div>
            <p class="ia-label">{{ t("agent.args") }}</p>
            <pre class="ia-pre">{{ a.argsText }}</pre>
            <template v-if="a.status === 'ok' && a.result != null">
              <p class="ia-label">{{ t("agent.stepResult") }}</p>
              <pre class="ia-pre">{{ a.resultText }}</pre>
            </template>
          </div>
        </div>
        <footer class="insp-foot">
          <button class="btn-ghost sm" type="button" @click="focusStep(selectedStepId)">{{ t("agent.executionTitle") }} ›</button>
        </footer>
      </aside>

      <!-- 任务监控投递到外壳右栏（#shell-dock）：它属于「运行期才出现的面板」，
           不该在对话列里再切走 280px。没有外壳时（单测/手机端）留在原地。 -->
      <Teleport to="#shell-dock" :disabled="!shell">
        <aside v-if="monitorVisible" id="agent-monitor" class="monitor" :aria-label="t('agent.monitorTitle')">
        <div class="mon-head">
          <Icon name="activity" :size="14" />
          <b>{{ t("agent.monitorTitle") }}</b>
          <button class="mon-close" :aria-label="t('agent.monitorHide')" @click="toggleMonitor"><Icon name="x" :size="15" /></button>
        </div>
        <div class="mon-body">
          <div class="mon-sec">
            <span class="mon-label">{{ t("agent.goalLabel") }}</span>
            <p class="mon-goal">{{ threadGoal || t("agent.emptyTimeline") }}</p>
          </div>
          <!-- 轨迹：运行时的泳道 + 带耗时的工具行；结束后仍可回查 -->
          <div v-if="trajectoryRows.length" class="mon-sec">
            <span class="mon-label">{{ t("agent.trajectoryTitle") }}</span>
            <ExecutionLanes :steps="sourceSteps" :running="busy && !viewRun" :now="clock" flush />
            <input
              v-model="trajectoryQuery"
              class="mon-search"
              type="search"
              :placeholder="t('agent.trajectorySearch')"
              :aria-label="t('agent.trajectorySearch')"
            />
            <div class="mon-rows">
              <div v-for="row in filteredTrajectory" :key="row.key" class="mon-row">
                <Icon :name="toolIcon(row.tool)" :size="12" class="mon-row-ico" />
                <code class="mon-row-name" :title="row.tool">{{ row.tool }}</code>
                <span v-if="row.attempts > 1" class="mon-row-n">×{{ row.attempts }}</span>
                <span class="mon-row-dur">{{ fmtMs(row.span) }}</span>
                <span class="mon-row-badge" :class="'b-' + row.status">{{ t(ATTEMPT_KEY[row.status]) }}</span>
              </div>
              <p v-if="!filteredTrajectory.length" class="mon-row-empty">{{ t("agent.trajectoryEmpty") }}</p>
            </div>
          </div>
          <div class="mon-sec">
            <span class="mon-label">{{ t("agent.monitorActivity") }}</span>
            <p class="mon-now">
              <template v-if="!viewRun && currentTool"><Icon name="zap" :size="12" /><code>{{ currentTool }}</code></template>
              <template v-else><Icon :name="statusMeta.icon" :size="12" />{{ t(statusMeta.key) }}</template>
            </p>
            <dl class="mon-meter">
              <div v-if="runModelText"><dt>{{ t("agent.runModelLabel") }}</dt><dd :title="runModelText">{{ runModelText }}</dd></div>
              <div><dt>{{ t("agent.summaryTools") }}</dt><dd>{{ toolCount }}</dd></div>
              <div><dt>{{ t("agent.modelCalls") }}</dt><dd>{{ displayedUsage.calls || 0 }}</dd></div>
              <div><dt>Tokens</dt><dd>{{ fmtNum(displayedUsage.totalTokens) }}</dd></div>
            </dl>
          </div>
          <!-- 空闲态：不摆一排 0，而是回答「这轮它有哪些本地工具可用」 -->
          <div v-if="!busy && !viewRun && !agentSession.pending" class="mon-sec">
            <span class="mon-label">{{ t("nav.localTools") }}</span>
            <div class="mon-tools">
              <button
                v-for="tool in localTools"
                :key="tool.key"
                class="m-chip"
                :title="t(tool.descKey)"
                @click="openLocalTool(tool)"
              >
                <Icon :name="tool.icon" :size="12" />{{ t(tool.labelKey) }}
              </button>
            </div>
            <p class="mon-hint-inline">{{ t("toolbox.gallery.dockToolsHint") }}</p>
          </div>

          <div v-if="runSummary && runSummary.artifacts.length" class="mon-sec">
            <span class="mon-label">{{ t("agent.summaryArtifacts") }}</span>
            <div class="manual-chips">
              <button
                v-for="art in runSummary.artifacts"
                :key="art.path"
                class="m-chip"
                :title="art.path + ' · ' + t('agent.openInTool')"
                @click="openArtifact(art.tool, [art])"
              >
                <Icon name="open" :size="12" />{{ art.label }}
              </button>
            </div>
          </div>
          <p class="mon-hint">{{ t("agent.capMoved") }}</p>
          </div>
        </aside>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
.agent { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--card); container: agent / inline-size; }
.agent-progress { flex-shrink: 0; }
/* 空态居中：先说「这是什么」，再给三个一键可点的例子，最后一行安全说明。
   垂直居中而不是贴顶——空态是这一屏唯一的正文，贴顶会让下半屏空成一片。 */
/* 居中骨架与文字层级走全局 .empty */
.canvas-empty { flex: 1; min-height: 320px; margin: 0; padding: var(--sp-7) 0 var(--sp-6); gap: var(--sp-2); align-items: flex-start; text-align: left; }
.ce-mark { display: grid; place-items: center; width: 32px; height: 32px; color: var(--primary); background: var(--card); border: 1px solid var(--border); border-radius: var(--r-xs); margin-bottom: var(--sp-2); }
.ce-slogan { margin: 0; font-size: 24px; line-height: 1.3; font-weight: 650; color: var(--text); letter-spacing: -0.4px; }
.ce-hint { margin: 0; max-width: 42ch; font-size: var(--fs-base); color: var(--muted); line-height: var(--lh-body); }
.ce-examples { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); margin-top: var(--sp-5); width: 100%; max-width: 640px; }
.ce-chip {
  display: flex; align-items: center; gap: var(--sp-2); height: 46px; padding: 0 var(--sp-3);
  font-size: var(--fs-md); font-weight: 600; color: var(--text);
  background: var(--card); border: 1px solid var(--border); border-radius: var(--r-sm); text-align: left;
  cursor: pointer; white-space: nowrap;
  transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
}
.ce-chip .icon { flex-shrink: 0; color: var(--muted); }
.ce-chip:hover { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); }
.ce-chip:hover .icon { color: var(--primary-hover); }
.ce-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
/* 确认行为说明：低调的一段，且自带「知道了」——它讲的是安全边界，不是卖点。
   刻意不用 flex（图标会在大段文字里被挤到单独一行），图标用 vertical-align 跟首行对齐。 */
.ce-note {
  display: flex; align-items: center; gap: var(--sp-2);
  margin: var(--sp-5) 0 0; max-width: 640px; text-align: left;
  font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body);
  padding: var(--sp-2) var(--sp-3); background: var(--card-soft);
  border: 1px solid var(--border); border-left: 2px solid var(--primary);
}
.ce-note .icon { vertical-align: -2px; margin-right: var(--sp-05); }
.ce-note .link { margin-left: auto; flex-shrink: 0; }

/* ---------- 管线条 ---------- */
.pipe {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-6);
  border-bottom: 1px solid var(--border);
  background: var(--card);
  min-width: 0;
}
.pipe-label {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}
.pipe-track {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  overflow-x: auto;
  scrollbar-width: none;
  min-width: 0;
  padding: var(--sp-05) 0;
}
.pipe-track::-webkit-scrollbar { display: none; }
.pipe-node {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex-shrink: 0;
  height: 30px;
  padding: 0 var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  background: var(--card);
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  white-space: nowrap;
  cursor: pointer;
  transition: border-color var(--dur-fast), color var(--dur-fast), background var(--dur-fast);
}
.pipe-node:hover { border-color: var(--primary); color: var(--text); }
.pipe-node:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.pipe-node .pn-no { color: var(--faint); font-size: var(--fs-xs); }
.pipe-node .pn-meta { color: var(--faint); font-size: var(--fs-xs); }
.pipe-node.s-ok .pn-name { color: var(--done); }
.pipe-node.s-error { border-color: var(--border-danger); }
.pipe-node.s-error .pn-name { color: var(--danger); }
.pipe-node.s-running { border-color: var(--primary); background: var(--primary-soft); color: var(--text); }
.pipe-node.s-wait { border-color: var(--primary); background: var(--primary-soft); }
.pipe-node.s-wait .pn-name { color: var(--primary-hover); }
.pipe-node .pn-wait { color: var(--wait); }
.pipe-node .pn-live {
  width: 6px;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--primary);
  animation: pipe-live 1.1s ease-in-out infinite;
}
@keyframes pipe-live { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }

/* ---------- 未配置模型 ---------- */
/* 横排：图标 + 说明 + 出路按钮一行放下，占的高度不到原来的三分之二，
   因为它现在是「贴在禁用按钮上方的一行提示」，不是压在消息流顶上的一张公告。 */
.noai {
  flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4); color: var(--text);
  background: var(--card); border: 1px dashed var(--border-strong); border-radius: var(--r-md);
}
.noai-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.noai b { font-size: var(--fs-sm); }
.noai p { margin: 0; font-size: var(--fs-xs); color: var(--muted); line-height: var(--lh-tight); }
.noai-actions { flex-shrink: 0; display: flex; gap: var(--sp-2); }

.body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); align-items: stretch; position: relative; overflow: hidden; }
.canvas { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.scroll { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-7); padding: 28px 24px; scrollbar-gutter: stable both-edges; overscroll-behavior: contain; }
.scroll > * { width: 100%; max-width: 820px; align-self: center; flex-shrink: 0; }
.scroll > .canvas-empty { max-width: 640px; }

/* ---------- 用户消息（会话流的第一条） ---------- */
/* 与 Agent 的答复卡刻意长得不一样：靠头像 + 姓名行认出「谁在说话」，
   底色用 card-soft 而不是 card，避免和右侧工具卡的白色块糊成一片。 */
.msg { display: flex; gap: var(--sp-3); align-items: flex-start; }
.msg-user { flex-shrink: 0; }
.msg-av {
  flex-shrink: 0; display: grid; place-items: center; width: 26px; height: 26px;
  border-radius: var(--r-sm); background: var(--well); color: var(--text-weak);
}
.msg-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.msg-who { font-size: var(--fs-xs); font-weight: 700; color: var(--muted); }
.msg-text {
  margin: 0; padding: var(--sp-3) var(--sp-4);
  font-size: var(--fs-base); line-height: var(--lh-body); color: var(--text);
  background: var(--card-soft); border: 1px solid var(--card-border); border-radius: var(--r-md);
  white-space: pre-wrap; word-break: break-word;
}
/* 附件跟在那句话下面，做成小胶囊：它们是「这一轮的输入材料」，不是另一条消息 */
.msg-atts { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-top: var(--sp-0); }
.msg-att {
  display: inline-flex; align-items: center; gap: 5px; max-width: 240px;
  padding: 2px var(--sp-2); color: var(--text-weak);
  background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-pill);
  font-size: var(--fs-xs);
}
.msg-att .icon { color: var(--muted); }
.msg-att-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.composer { width: calc(100% - 48px); max-width: 820px; align-self: center; flex-shrink: 0; display: flex; flex-direction: column; gap: var(--sp-2); margin-bottom: var(--sp-7); }
.background-run { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-weak); }
.background-run > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- 历史任务回看横幅 ---------- */
.view-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  background: var(--primary-soft);
  border: 1px solid var(--border-blue);
  border-radius: var(--r-md);
  color: var(--primary-hover);
  font-size: var(--fs-sm);
}
.vb-label { flex-shrink: 0; font-weight: 700; }
.vb-input { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-weak); }
.vb-actions { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3); }

/* 输入框本体（.goal-box / .goal / 弹层）住在 AgentComposer.vue：同一份状态在三个入口
   （加号 / 斜杠指令 / 模型胶囊）之间流转，样式分家就会先在两处漂移。 */

/* ---------- 内联确认卡 ---------- */
.confirm { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-5); background: var(--card); border: 1px solid var(--border-strong); border-left: 3px solid var(--muted); border-radius: var(--r-md); box-shadow: var(--shadow); }
.confirm.risk-write { border-left-color: var(--danger); }
.confirm.risk-database { border-left-color: var(--teal); }
.confirm.risk-transform, .confirm.risk-read { border-left-color: var(--primary); }
.cf-head { display: flex; align-items: center; gap: var(--sp-3); color: var(--warn-deep); }
.cf-head b { font-size: var(--fs-base); color: var(--text); }
.cf-tool { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-code); }
/* 提问卡：问题是正文（不是工具名），回答是文本（不是允许/拒绝） */
.cf-question { margin: 0; font-size: var(--fs-base); line-height: var(--lh-body); color: var(--text); white-space: pre-wrap; word-break: break-word; }
/* 候选项：可点选的胶囊；选中态用主色 + 勾，不靠颜色单独表达状态 */
.cf-options { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.cf-option {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 30px;
  padding: 4px var(--sp-3);
  font-family: inherit;
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-weak);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  cursor: pointer;
  transition: color var(--dur-fast), background var(--dur-fast), border-color var(--dur-fast);
}
.cf-option:hover { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); }
.cf-option.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--primary); font-weight: 600; }
.cf-option:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.cf-option .icon { flex-shrink: 0; }
.cf-answer { width: 100%; padding: var(--sp-3); font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--text-code); background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-sm); resize: vertical; }
.cf-args { margin: 0; max-height: 260px; overflow: auto; padding: var(--sp-3); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: var(--lh-body); color: var(--text-code); background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-sm); white-space: pre-wrap; word-break: break-word; }
.cf-hint { margin: 0; font-size: var(--fs-xs); color: var(--muted); }
.cf-once { margin: 0; font-size: var(--fs-xs); color: var(--warn-deep); }
/* 写前预览：diff 行用语义色（新增=成功绿、删除=危险红、修改=主色），与时间线同一套色板 */
.cf-preview { display: flex; flex-direction: column; gap: var(--sp-2); }
.cf-pv-head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-xs); color: var(--muted); }
.cf-pv-path { font-family: var(--font-mono); color: var(--text-code); word-break: break-all; }
.cf-pv-stat { font-family: var(--font-mono); color: var(--muted); }
.cf-pv-body { max-height: 220px; overflow: auto; padding: var(--sp-2) 0; font-family: var(--font-mono); font-size: var(--fs-xs); background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-sm); }
.cf-pv-row { display: flex; gap: var(--sp-2); padding: 0 var(--sp-2); line-height: var(--lh-body); }
.cf-pv-no { flex: 0 0 3.2em; text-align: right; color: var(--muted); user-select: none; }
.cf-pv-text { white-space: pre-wrap; word-break: break-word; color: var(--text-code); }
.cf-pv-row.pv-added { background: var(--success-soft); }
.cf-pv-row.pv-removed { background: var(--danger-soft); }
.cf-pv-row.pv-changed { background: var(--primary-soft); }
.cf-pv-more { margin: 0; font-size: var(--fs-xs); color: var(--muted); }
.cf-actions { display: flex; justify-content: flex-end; gap: var(--sp-3); }

.execution { border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card-soft); }
.execution-head { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); cursor: pointer; list-style: none; color: var(--text-weak); font-size: var(--fs-sm); }
.execution-head::-webkit-details-marker { display: none; }
.execution-head:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
.execution-arrow { flex-shrink: 0; transition: transform var(--dur-fast); }
.execution[open] .execution-arrow { transform: rotate(90deg); }
.execution-count, .execution-usage { color: var(--muted); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.execution-usage { margin-left: auto; }
.execution-meta { display: flex; flex-wrap: wrap; gap: var(--sp-6); padding: 0 var(--sp-4) var(--sp-3); font-size: var(--fs-xs); color: var(--muted); }
.timeline { display: flex; flex-direction: column; gap: var(--sp-2); padding: 0 var(--sp-3) var(--sp-3); }

.tl-card { position: relative; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); overflow: hidden; }

/* 工具卡的「正在动手 / 已落地」反馈（动效第一层体感，不需要工具侧改造就生效）。
   呼吸动画只在允许动效时播：prefers-reduced-motion 下退化为静态主色描边。 */
.tl-card[data-status="running"] { border-color: var(--primary); }
.tl-card[data-status="ok"] { animation: tlCardSettle 0.42s var(--ease-out); }
@media (prefers-reduced-motion: no-preference) {
  .tl-card[data-status="running"] { animation: tlCardBreath 1.4s ease-in-out infinite; }

  /* 四类动作原型：只回答「这只手在做什么」，不承担信息。
     扫描＝高光扫过卡头；流动＝底部流光；落章＝图标脉冲；拉取＝状态徽标走马灯。 */
  .tl-card[data-status="running"][data-motion="scan"] .tl-head::after {
    content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 38%;
    background: linear-gradient(90deg, transparent, var(--primary-soft), transparent);
    pointer-events: none;
    animation: tlScan 1.5s linear infinite;
  }
  .tl-card[data-status="running"][data-motion="flow"]::after {
    content: ""; position: absolute; left: 0; bottom: 0; width: 30%; height: 2px;
    background: linear-gradient(90deg, transparent, var(--primary), transparent);
    pointer-events: none;
    animation: tlFlow 1.3s linear infinite;
  }
  .tl-card[data-status="running"][data-motion="stamp"] .tl-ico { animation: tlStamp 1.05s ease-in-out infinite; }
  .tl-card[data-status="running"][data-motion="stream"] .tl-badge {
    background-image: linear-gradient(90deg, var(--primary-soft), var(--border-blue), var(--primary-soft));
    background-size: 250% 100%;
    animation: tlStream 1.1s linear infinite;
  }
}
@keyframes tlCardBreath {
  0%, 100% { box-shadow: 0 0 0 0 var(--primary-soft); }
  50% { box-shadow: 0 0 0 4px var(--primary-soft); }
}
@keyframes tlCardSettle {
  0% { transform: translateY(-1px); box-shadow: 0 0 0 3px var(--primary-soft); }
  100% { transform: none; box-shadow: none; }
}
@keyframes tlScan {
  from { transform: translateX(-120%); }
  to { transform: translateX(320%); }
}
@keyframes tlFlow {
  from { transform: translateX(-100%); }
  to { transform: translateX(400%); }
}
@keyframes tlStamp {
  0%, 100% { transform: scale(1); }
  45% { transform: scale(1.22); }
}
@keyframes tlStream {
  from { background-position: 120% 0; }
  to { background-position: -120% 0; }
}
.tl-head { position: relative; display: flex; align-items: center; gap: var(--sp-2); width: 100%; padding: var(--sp-2) var(--sp-4); background: transparent; border: none; cursor: pointer; text-align: left; transition: background 0.15s; overflow: hidden; }
.tl-head:hover { background: var(--card-soft); }
.tl-arrow { flex-shrink: 0; color: var(--muted); transition: transform 0.15s; }
.tl-arrow.open { transform: rotate(90deg); }
.tl-ico { flex-shrink: 0; color: var(--primary); }
.tl-name { flex-shrink: 0; font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.tl-n { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-num); }
.tl-dur { flex-shrink: 0; font-size: var(--fs-xs); color: var(--faint); font-family: var(--font-num); font-variant-numeric: tabular-nums; }
.tl-badge { margin-left: auto; flex-shrink: 0; padding: 1px var(--sp-2); font-size: var(--fs-xs); font-weight: 600; border-radius: var(--r-pill); color: var(--text-soft); background: var(--well); }
.tl-badge.sm { padding: 0 var(--sp-1); }
.tl-badge.b-running { color: var(--primary); background: var(--primary-soft); }
.tl-badge.b-ok { color: var(--success-deep); background: var(--success-soft); }
.tl-badge.b-retry { color: var(--warn-deep); background: var(--amber-soft); }
.tl-badge.b-error { color: var(--danger-deep); background: var(--danger-soft); }
.tl-body { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4) var(--sp-4); border-top: 1px solid var(--card-border); background: var(--card-soft); }
.tl-live-row { display: flex; justify-content: flex-end; padding: 0 var(--sp-4) var(--sp-2); }
.tl-attempt { display: flex; flex-direction: column; gap: var(--sp-2); }
.ta-head { display: flex; align-items: center; gap: var(--sp-2); }
.ta-n { font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-num); }
.ta-dur { margin-left: auto; font-size: var(--fs-xs); color: var(--faint); font-family: var(--font-num); font-variant-numeric: tabular-nums; }
.ta-error { display: flex; align-items: center; gap: 5px; margin: 0; font-size: var(--fs-sm); color: var(--danger-deep); line-height: var(--lh-body); }
.ta-demo { display: flex; align-items: center; gap: 5px; margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--primary); line-height: var(--lh-body); }

.payload { display: flex; flex-direction: column; gap: 3px; }
.pl-head { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-xs); color: var(--muted); }
.pl-body { margin: 0; padding: var(--sp-2) var(--sp-3); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: var(--lh-body); color: var(--text-code); background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-xs); white-space: pre-wrap; word-break: break-word; }
.pl-body.clipped { max-height: 96px; overflow: hidden; }

.tl-row { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-4); font-size: var(--fs-sm); border-radius: var(--r-sm); border: 1px solid var(--card-border); background: var(--card); }
.tl-confirm { color: var(--text-weak); }
.tl-confirm .ok { margin-left: auto; color: var(--success-deep); font-size: var(--fs-sm); }
/* 文本回答可能很长（路径、SQL）：单行截断 + title 看全文，不把时间线撑开 */
.tl-confirm .ans-text { max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
.tl-confirm .no { margin-left: auto; color: var(--danger-deep); font-size: var(--fs-sm); }
.tl-notice { color: var(--text-weak); background: transparent; border-color: transparent; align-items: flex-start; }
.tl-notice > .icon { flex-shrink: 0; margin-top: 3px; }
.tl-notice .tl-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.review-notice { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-4); font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--warn-deep); background: var(--warn-tint); border: 1px solid var(--warn-border); border-radius: var(--r-sm); }
.review-notice .icon { flex-shrink: 0; margin-top: 3px; }
/* 审计行：与确认行同款右对齐结论，但来源是事件流而非卡片 */
.tl-approval { color: var(--text-weak); }
.tl-approval .ok { margin-left: auto; color: var(--success-deep); font-size: var(--fs-sm); }
.tl-approval .no { margin-left: auto; color: var(--danger-deep); font-size: var(--fs-sm); }
.tl-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.answers { display: flex; flex-direction: column; gap: var(--sp-7); }
.answer-card { min-width: 0; padding: var(--sp-2) 0; background: transparent; }
.ans-head { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-4); color: var(--text-weak); }
.ans-head b { font-size: var(--fs-md); color: var(--text); margin-right: auto; }
.answer-card :deep(.md-render) { overflow-wrap: anywhere; }

.working { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-4); font-size: var(--fs-sm); color: var(--muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--primary); animation: agentPulse 1.1s ease-in-out infinite; }
@keyframes agentPulse { 0%, 100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }

.outcome { display: flex; align-items: flex-start; gap: var(--sp-4); padding: var(--sp-7) 0; }
.outcome-icon { display: grid; place-items: center; width: 34px; height: 34px; flex-shrink: 0; border-radius: var(--r-sm); color: var(--text-weak); background: var(--well); }
.outcome-failed .outcome-icon { color: var(--fail-deep); background: var(--fail-soft); }
.outcome-max_steps .outcome-icon { color: var(--wait-deep); background: var(--wait-soft); }
.outcome-body { flex: 1; min-width: 0; }
.outcome h3 { margin: var(--sp-1) 0 var(--sp-2); font-size: var(--fs-base); font-weight: 600; color: var(--text); }
.outcome p { margin: 0 0 var(--sp-4); font-size: var(--fs-md); line-height: var(--lh-body); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-weak); }
.sum-card { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4) var(--sp-5); background: var(--card-soft); border: 1px solid var(--card-border); border-radius: var(--r-sm); }
/* 产物 chip 入场：完成态唯一的「抵达」动效——轻微上浮，不庆祝、不抢答案 */
@media (prefers-reduced-motion: no-preference) {
  .sum-card .m-chip { animation: artifactIn 0.32s var(--ease-out) both; }
}
@keyframes artifactIn {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}
.sum-head { display: flex; align-items: center; gap: var(--sp-2); color: var(--text-weak); }
.sum-head b { font-size: var(--fs-md); }
.sum-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); font-size: var(--fs-sm); }
.sum-tool { display: inline-flex; align-items: center; gap: var(--sp-1); }
.sum-label { flex-shrink: 0; color: var(--muted); font-size: var(--fs-xs); }

/* 面板本体住在外壳右栏里：分隔线与底色由 .dock 提供，这里只管内容节奏。
   没有外壳时（:disabled 的 Teleport）它会退回对话列内，靠 .dock 缺失也不至于糊成一团。 */
.monitor { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-5); padding: var(--sp-4) var(--sp-5) var(--sp-6); }
.mon-head { display: flex; align-items: center; gap: var(--sp-2); height: 44px; flex-shrink: 0; color: var(--text-weak); border-bottom: 1px solid var(--border); }
.mon-head b { font-size: var(--fs-sm); }
.mon-close { display: grid; place-items: center; margin-left: auto; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--r-xs); color: var(--muted); background: transparent; cursor: pointer; }
.mon-close:hover { color: var(--text); background: var(--well); }
.mon-close:focus-visible { outline: 2px solid var(--focus-ring); }
.mon-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding-right: var(--sp-0); }
.mon-sec { display: flex; flex-direction: column; gap: var(--sp-2); }
.mon-label { font-size: var(--fs-xs); font-weight: 700; color: var(--faint); }
/* 目标可能很长（一句话描述）：限高滚动而不是撑爆面板，也不截断成看不懂的半句 */
.mon-goal { margin: 0; max-height: 6.6em; overflow: auto; font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--text); white-space: pre-wrap; word-break: break-word; }
.mon-now { display: flex; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-sm); color: var(--text-soft); }
.mon-now code { padding: 1px var(--sp-1); background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-xs); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-code); }
.mon-meter { display: flex; flex-direction: column; gap: var(--sp-3); margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--muted); }
.mon-meter > div { display: flex; justify-content: space-between; gap: var(--sp-2); }
.mon-meter dd { margin: 0; color: var(--text); font-family: var(--font-num); font-variant-numeric: tabular-nums; }
/* 面板里唯一一句「去哪儿配」的指路，常驻在底部（工具开关在设置页，见 capMoved） */
.mon-hint { margin: auto 0 0; padding-top: var(--sp-2); font-size: var(--fs-xs); color: var(--faint); line-height: var(--lh-body); border-top: 1px solid var(--card-border); }

.mon-tools { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
/* 轨迹行：与执行记录同一份数据，密度更高——右栏是黑匣子，不是第二份日志墙 */
.mon-search { width: 100%; height: 28px; padding: 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text); background: var(--card); border: 1px solid var(--border); border-radius: var(--r-xs); }
.mon-search:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.mon-rows { display: flex; flex-direction: column; gap: var(--sp-0); max-height: 220px; overflow: auto; }
.mon-row { display: flex; align-items: center; gap: var(--sp-2); padding: 3px var(--sp-2); border-radius: var(--r-xs); font-size: var(--fs-xs); }
.mon-row:hover { background: var(--well); }
.mon-row-ico { flex-shrink: 0; color: var(--primary); }
.mon-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); color: var(--text-code); }
.mon-row-n { flex-shrink: 0; color: var(--muted); }
.mon-row-dur { margin-left: auto; flex-shrink: 0; font-family: var(--font-num); font-variant-numeric: tabular-nums; color: var(--faint); }
.mon-row-badge { flex-shrink: 0; padding: 0 5px; border-radius: var(--r-pill); font-size: 10px; color: var(--text-soft); background: var(--well); }
.mon-row-badge.b-running { color: var(--primary); background: var(--primary-soft); }
.mon-row-badge.b-ok { color: var(--success-deep); background: var(--success-soft); }
.mon-row-badge.b-retry { color: var(--warn-deep); background: var(--amber-soft); }
.mon-row-badge.b-error { color: var(--danger-deep); background: var(--danger-soft); }
.mon-row-empty { margin: 0; padding: var(--sp-1) 0; font-size: var(--fs-xs); color: var(--faint); }
.mon-hint-inline { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--faint); line-height: var(--lh-body); }
.manual-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.m-chip { display: inline-flex; align-items: center; gap: var(--sp-05); padding: 3px 9px; font-size: var(--fs-xs); font-weight: 600; color: var(--text-soft); background: var(--ghost); border: 1px solid var(--border); border-radius: var(--r-pill); cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s; }
.m-chip:hover { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); }


/* ---------- 局部链接按钮（全局按钮体系里没有 xs 文字钮） ---------- */
.link { padding: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--primary); background: none; border: none; cursor: pointer; transition: color 0.15s; }
.link:hover { color: var(--primary-hover); text-decoration: underline; }
.link.xs { font-size: var(--fs-xs); font-weight: 500; color: var(--muted); }
.link.xs:hover { color: var(--primary); }
.link.xs.danger:hover { color: var(--danger); }
.link:disabled { opacity: 0.45; cursor: not-allowed; text-decoration: none; }

.link { color: var(--primary-hover); }
.view-banner { margin: var(--sp-3) var(--sp-6) 0; }
.tl-head, .pl-head, .tl-row { flex-wrap: wrap; }
.tl-name { flex-shrink: 1; overflow-wrap: anywhere; }

@media (max-width: 600px) {
  .scroll { padding: var(--sp-6) var(--sp-3); scrollbar-gutter: auto; }
  .composer { width: calc(100% - 20px); margin-bottom: var(--sp-3); }
  .goal-hint { font-size: var(--fs-xs); }
  .composer-mode { display: none; }
  .ce-slogan { font-size: var(--fs-xl); }
  .ce-ex { padding-left: 0; padding-right: 0; }
  .noai { flex-wrap: wrap; }
  .noai-actions { width: 100%; }
  .view-banner { flex-wrap: wrap; margin: var(--sp-2); }
  .vb-actions { width: 100%; justify-content: flex-end; }
  .msg-av { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dot, .tl-card { animation: none; }
}

/* ---------- B · Pipeline 收口：卡片降噪 ----------
   把执行记录/工具卡/确认卡从「浮起的卡片」压成「发丝线分区」：
   圆角收到 r-xs、去掉阴影、边框统一走 --border。结构不动，只换材质。 */
.execution { border-color: var(--border); border-radius: var(--r-xs); background: var(--card); }
.tl-card { border-color: var(--border); border-radius: var(--r-xs); }
.tl-head { padding: var(--sp-2) var(--sp-3); }
.confirm { border-radius: var(--r-xs); border-color: var(--border); border-left-width: 2px; box-shadow: none; background: var(--card-soft); }
.view-banner { border-radius: var(--r-xs); }
.cf-preview .cf-pv-body, .cf-args, .payload pre { border-radius: var(--r-xs); }

/* ---------- 检查器（轨迹选中的那一步） ---------- */
.body.body-insp { grid-template-columns: minmax(0, 1fr) 320px; }
.insp { display: flex; flex-direction: column; min-height: 0; border-left: 1px solid var(--border); background: var(--card); }
.insp-head { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); min-width: 0; }
.insp-name { font-family: var(--font-mono); font-size: var(--fs-md); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.insp-x { margin-left: auto; flex-shrink: 0; width: 26px; height: 26px; display: grid; place-items: center; color: var(--muted); border: 1px solid transparent; border-radius: var(--r-xs); background: none; cursor: pointer; }
.insp-x:hover { color: var(--text); border-color: var(--border); }
.insp-body { flex: 1; min-height: 0; overflow: auto; padding: var(--sp-4); }
.insp-att + .insp-att { margin-top: var(--sp-5); }
.ia-head { display: flex; align-items: center; gap: var(--sp-2); }
.ia-n, .ia-st, .ia-dur { font-size: var(--fs-xs); color: var(--muted); }
.ia-st { border: 1px solid var(--border); border-radius: var(--r-xs); padding: 0 var(--sp-05); }
.ia-dur { margin-left: auto; font-family: var(--font-mono); color: var(--faint); }
.ia-label { margin: var(--sp-3) 0 var(--sp-1); font-family: var(--font-mono); font-size: var(--fs-xs); letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
.ia-pre { margin: 0; max-height: 220px; overflow: auto; padding: var(--sp-2); font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--text-code); background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-xs); white-space: pre-wrap; word-break: break-word; }
.insp-foot { display: flex; justify-content: flex-end; padding: var(--sp-2) var(--sp-4); border-top: 1px solid var(--border); }

/* 闸门底栏：说明在左、决定在右，和轨迹尾部的「等待你的决定」是同一件事的两种入口。 */
.cf-wait { margin-left: auto; font-size: var(--fs-xs); color: var(--wait); font-weight: 600; letter-spacing: 0.02em; }
.cf-foot { display: flex; align-items: center; gap: var(--sp-3); padding-top: var(--sp-2); border-top: 1px solid var(--border); }
.cf-foot .cf-once { margin: 0; flex: 1; min-width: 0; }
</style>
