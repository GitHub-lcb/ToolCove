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
import { describePreview, rowKind, rowText } from "../agent/preview.js";
import { canResume } from "../agent/runStore.js";
import { extractArtifacts } from "../agent/artifacts.js";
import { answerToProblemDraft, answerToSnippetDraft } from "../agent/answerDraft.js";
import { buildContextLine } from "../agent/context.js";
import { create as createRecord, load as loadRepo } from "../data/repository.js";
import { findToolboxTool } from "../toolboxTools.js";
import RunProgress from "./RunProgress.vue";
import { askConfirm } from "../ui/confirm.js";
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

const busy = computed(() => agentSession.status !== "idle");

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
      clearTimeline();
      nextTick(() => goalBox.value?.focus());
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
watch(busy, (now, before) => {
  if (before && !now) {
    openCards.clear();
    openPayloads.clear();
  }
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

const statusMeta = computed(() => {
  const s = agentSession;
  if (s.status === "waiting") return { cls: "st-wait", key: "agent.statusWaiting", icon: "alert" };
  if (s.status === "running") return { cls: "st-dev", key: "agent.statusRunning", icon: "activity" };
  if (s.runStatus === "completed") return { cls: "st-done", key: "agent.statusSuccess", icon: "check" };
  if (s.runStatus === "cancelled") return { cls: "st-pending", key: "agent.statusCancelled", icon: "x" };
  if (s.runStatus === "max_steps") return { cls: "st-pending", key: "agent.statusMaxSteps", icon: "alert" };
  if (s.runStatus === "failed") return { cls: "st-fail", key: "agent.statusFailed", icon: "alert" };
  return { cls: "tc-neutral", key: "agent.statusIdle", icon: "zap" };
});

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

// ------- 任务监控面板（右侧，条件出现） -------
// 三期的核心取舍：右侧**不再常驻**「能力清单」。工具开关是配置，不是对话的家具——
// 它常驻时占掉 1/4 宽度，把消息流挤成窄条，而且和"这台机器能干什么"这个一次性问题
// 绑死在每一轮对话上。工具开关因此搬进「设置 → Agent」，这里只留在**运行时**才有意义的
// 东西（目标 / 实时进度 / 产物），也就是 Qoder 的任务监控那一栏。
//
// 可见条件 = 用户没手动关掉 且 （正在跑 或 有待确认 或 有产物）。
// 用户手动关掉后即使是运行中也不弹回来——面板自己冒出来比少一个面板更烦人。
const monitorWanted = ref(true);
const monitorVisible = computed(
  () => monitorWanted.value && (busy.value || !!agentSession.pending || !!runSummary.value?.artifacts.length)
);
function toggleMonitor() {
  monitorWanted.value = !monitorWanted.value;
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

// 空态只在「这一轮还没有任何步骤」时出现。回看历史时一律不补空态——
// 横幅与交付清单已经说明了现状，再插一句标语是噪声。
const showEmpty = computed(() => !viewRun.value && !timeline.value.length && !agentSession.pending);

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

const goal = ref("");
const goalBox = ref(null);
const denyBtn = ref(null);
// 提问卡的回答草稿。与 goal 分开：提问的回答常常是路径这类短文本，不该污染上一条目标。
const answerDraft = ref("");
const answerBox = ref(null);

onMounted(async () => {
  await initAgentSession();
  if (agentSession.goal && !goal.value) goal.value = agentSession.goal;
  // 有历史才值得提前建 registry（续跑按钮靠它判定）；没有就等 onResume 里 ensure
  setTimeout(() => {
    if (agentSession.runs.length) ensureAgentRegistry();
  }, 1200);
});

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
  if (await startAgentRun(input, { contextLine })) {
    goal.value = "";
  }
}

function onGoalKey(e) {
  // isComposing：中文输入法选词的回车不能当成提交；运行中回车退回普通换行，方便先写下一条目标
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !busy.value) {
    e.preventDefault();
    startRun();
  }
}

function useExample(key) {
  goal.value = t(key);
  nextTick(() => goalBox.value?.focus());
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
      answerBox.value?.focus();
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
  if (!answerPending(answerDraft.value)) {
    props.showToast(t("agent.answerEmpty"));
    return;
  }
  answerDraft.value = "";
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

async function openDemo(item, attempt) {
  const found = demoScriptOf(item.tool, attempt.args);
  if (!found) return;
  const runId = `${item.id}#${attempt.n}`;
  const label = findToolboxTool(found.toolKey)?.labelKey;
  track("tool.demo." + found.toolKey);
  // 结果里有落盘产物的动作（pdf.*）：演示的前提是工具里先有那份文件，
  // 所以顺带把产物预填过去（与「在工具中打开」同一条交接机制），否则演示只能指着一片空白。
  const artifact = attempt.artifacts?.[0];
  if (artifact) setToolPrefill(found.toolKey, { kind: "open-file", path: artifact.path });
  // 必须**等投递落地**再开窗：写存储是异步的，抢在它之前开窗会让新窗口挂载时读到空，
  // 表现就是「点了没反应」（静默退化）。已开着的工具还会经实时通道额外收到一份。
  await sendDemo({ toolKey: found.toolKey, action: item.tool, runId, script: found.script });
  props.showToast(t("agent.demoOpening", { tool: label ? t(label) : found.toolKey }));
  openManual(found.toolKey);
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
  nextTick(() => goalBox.value?.focus());
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

const RUN_STATUS = {
  success: { cls: "st-done", key: "agent.statusSuccess" },
  completed: { cls: "st-done", key: "agent.statusSuccess" },
  pending: { cls: "st-dev", key: "agent.statusRunning" },
  running: { cls: "st-dev", key: "agent.statusRunning" },
  failed: { cls: "st-fail", key: "agent.statusFailed" },
  cancelled: { cls: "st-pending", key: "agent.statusCancelled" },
  max_steps: { cls: "st-pending", key: "agent.statusMaxSteps" },
};
const runMeta = (rec) => RUN_STATUS[rec.status] || { cls: "tc-neutral", key: "agent.statusIdle" };

// ------- Summary 交付清单（纯派生，不改引擎） -------
// 为什么是派生而不是引擎生成：一期不动 session.js 的收尾逻辑，视图从现有 steps 现算一份；
// 把 summary 写进 run 记录落盘是二期的任务列表升级（见 docs/agent-workspace-plan.md）。
// 二期：数据源参数化——回看历史时吃该 run 的快照（落盘 run 没有 error 字段，缺什么显示什么）。
const TERMINAL_STATUS = new Set(["completed", "failed", "cancelled", "max_steps"]);
const runSummary = computed(() => {
  const viewing = viewRun.value;
  const status = viewing ? viewing.status : agentSession.runStatus;
  if (!TERMINAL_STATUS.has(status) || !sourceSteps.value.length) return null;
  const counts = new Map();
  const seen = new Set();
  const artifacts = [];
  for (const item of timeline.value) {
    if (item.kind !== "tool") continue;
    // 工具卡一张 = 一次调用（重试是卡内的多次尝试，不重复计数）
    counts.set(item.tool, (counts.get(item.tool) || 0) + 1);
    for (const a of item.attempts) {
      if (a.status !== "ok") continue;
      for (const art of a.artifacts || []) {
        if (seen.has(art.path)) continue;
        seen.add(art.path);
        artifacts.push({ ...art, tool: item.tool });
      }
    }
  }
  // 遗留说明：只有非圆满终态才有话可说
  let leftover = "";
  if (status === "failed") leftover = viewing ? viewing.error || "" : errorText.value;
  else if (status === "cancelled") leftover = t("agent.statusCancelled");
  else if (status === "max_steps") leftover = t("agent.statusMaxSteps");
  return {
    goal: viewing ? viewing.input || "" : agentSession.goal,
    statusKey: runMeta({ status }).key,
    cls: runMeta({ status }).cls,
    tools: [...counts].map(([name, count]) => ({ name, count })),
    artifacts,
    leftover,
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
    <!-- 表头条：只放「这一轮是什么状态」与全局动作。曾经还挂着一条运行进度条，
         已下移贴住输入框——进度讲的是「我正在做什么」，它该挨着用户下一步动作，
         而不是和页面标题抢第一行。 -->
    <header class="bar">
      <span class="st-chip" :class="statusMeta.cls">
        <Icon :name="statusMeta.icon" :size="13" />{{ t(statusMeta.key) }}
      </span>
      <span class="meter">
        <span>{{ t("agent.stepsCount", { n: agentSession.steps.length }) }}</span>
        <span>{{ t("agent.tokensCount", { n: fmtNum(agentSession.usage.totalTokens) }) }}</span>
        <span>{{ t("agent.callsCount", { n: agentSession.usage.calls }) }}</span>
      </span>
      <span class="spacer"></span>
      <button
        class="btn-ghost sm"
        :class="{ 'mon-on': monitorVisible }"
        :title="monitorWanted ? t('agent.monitorHide') : t('agent.monitorShow')"
        :aria-pressed="monitorWanted"
        @click="toggleMonitor"
      >
        <Icon name="layout" :size="14" />{{ t("agent.monitorTitle") }}
      </button>
      <button class="btn-ghost sm" @click="goSettings('agent')">
        <Icon name="settings" :size="14" />{{ t("agent.openSettings") }}
      </button>
      <button v-if="busy" class="btn-outline danger sm" @click="stopAgentRun('user')">
        <Icon name="x" :size="14" />{{ t("agent.stop") }}
      </button>
    </header>

    <div class="body" :class="{ 'with-monitor': monitorVisible }">
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

        <div class="scroll">
          <!-- 我说的那句话：会话流的第一条消息。回看历史时它就是当初那条目标，
               实时运行时是本次运行的目标（goal 在 startRun 成功后即被清空，
               所以这里读 agentSession.goal，而不是输入框的草稿）。 -->
          <article v-if="threadGoal" class="msg msg-user">
            <span class="msg-av"><Icon name="user" :size="13" /></span>
            <div class="msg-body">
              <span class="msg-who">{{ t("agent.you") }}</span>
              <p class="msg-text">{{ threadGoal }}</p>
            </div>
          </article>

          <!-- 内联确认卡：运行时交给我们的是 Promise，卡片能展示工具名 / 风险 / 完整 args，
               全局 askConfirm 模态做不到，而且不会盖住用户正在看的时间线。
               它属于实时运行：回看历史时照常显示——后台运行来了一张确认卡，人仍要答得上。 -->
          <section v-if="agentSession.pending" class="confirm" :class="'risk-' + (agentSession.pending.risk || 'ask')">
            <div class="cf-head">
              <Icon name="alert" :size="15" />
              <b>{{ agentSession.pending.kind === "tool" ? t("agent.confirmTitle") : agentSession.pending.question }}</b>
              <span v-if="agentSession.pending.risk" class="tc-chip sm" :class="riskChip(agentSession.pending.risk)">
                {{ t(riskKey(agentSession.pending.risk)) }}
              </span>
            </div>
            <!-- 提问卡：ask_user 要的是**文本**答案（路径、SQL、口令…），不是允许/拒绝。
                 旧实现把它画成同一张确认卡，于是「允许」把布尔当答案回灌，模型只会再问一遍。 -->
            <template v-if="agentSession.pending.kind === 'ask'">
              <p class="cf-question">{{ agentSession.pending.question }}</p>
              <textarea
                ref="answerBox"
                v-model="answerDraft"
                class="cf-answer"
                rows="3"
                :placeholder="t('agent.answerPlaceholder')"
                @keydown.enter.exact.prevent="onAnswer"
              ></textarea>
              <p class="cf-hint">{{ t("agent.answerHint") }}</p>
              <div class="cf-actions">
                <button class="btn-ghost sm" @click="onAnswerSkip">{{ t("agent.answerSkip") }}</button>
                <button class="btn-primary sm" :disabled="!answerDraft.trim()" @click="onAnswer">{{ t("agent.answerSend") }}</button>
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
              <p v-if="agentSession.pending.kind === 'tool'" class="cf-once">{{ t("agent.confirmOnce") }}</p>
              <div class="cf-actions">
                <button ref="denyBtn" class="btn-ghost sm" @click="onDecide(false)">{{ t("agent.confirmDeny") }}</button>
                <button class="btn-primary sm" @click="onDecide(true)">{{ t("agent.confirmAllow") }}</button>
              </div>
            </template>
          </section>

          <!-- 步骤时间线 -->
          <section v-if="timeline.length" class="timeline">
            <template v-for="(item, index) in timeline" :key="cardKey(item, index)">
              <article v-if="item.kind === 'tool'" class="tl-card" :data-status="item.attempts[item.attempts.length - 1].status" data-role="tool-card">
                <button
                  class="tl-head"
                  :aria-expanded="openCards.has(cardKey(item, index))"
                  @click="toggle(openCards, cardKey(item, index))"
                >
                  <Icon name="chevron-right" :size="13" class="tl-arrow" :class="{ open: openCards.has(cardKey(item, index)) }" />
                  <Icon name="terminal" :size="14" class="tl-ico" />
                  <code class="tl-name">{{ item.tool }}</code>
                  <span class="tc-chip sm" :class="riskChip(toolMeta.get(item.tool)?.risk)">
                    {{ t(riskKey(toolMeta.get(item.tool)?.risk)) }}
                  </span>
                  <span v-if="item.attempts.length > 1" class="tl-n">{{ t("agent.attempt", { n: item.attempts.length }) }}</span>
                  <span class="tl-badge" :class="'b-' + item.attempts[item.attempts.length - 1].status">
                    {{ t(ATTEMPT_KEY[item.attempts[item.attempts.length - 1].status]) }}
                  </span>
                </button>
                <div v-if="openCards.has(cardKey(item, index))" class="tl-body">
                  <div v-for="a in item.attempts" :key="a.n" class="tl-attempt">
                    <div class="ta-head">
                      <span class="ta-n">{{ t("agent.attempt", { n: a.n }) }}</span>
                      <span class="tl-badge sm" :class="'b-' + a.status">{{ t(ATTEMPT_KEY[a.status]) }}</span>
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
                <Icon name="alert" :size="14" />
                <span class="tl-text">{{ noticeText(item) }}</span>
                <span v-if="item.attempt" class="tl-n">{{ t("agent.retryAttempt", { n: item.attempt }) }}</span>
              </article>

              <article v-else class="answer-card">
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
            </template>

            <div v-if="busy && !viewRun" class="working">
              <span class="dot"></span>{{ agentSession.status === "waiting" ? t("agent.statusWaiting") : t("agent.running") }}
            </div>
          </section>

          <!-- 空态：输入框正上方的那块地方。二期的空态标语落在输入框**下面**——
               新用户按从上到下的顺序读，先看到输入框、再看到"说一件事"，逻辑是反的。
               现在它待在消息流该在的位置（输入框上方），一旦有了第一条步骤就消失。
               示例提示也收进这里：二期那张可关闭的欢迎卡与空态标语同时在首屏出现，
               两块内容讲同一件事，互相稀释。 -->
          <div v-if="showEmpty" class="canvas-empty">
            <b class="ce-slogan">{{ t("agent.emptySlogan") }}</b>
            <p class="ce-hint">{{ t("agent.emptyHint") }}</p>
            <div class="ce-examples">
              <button v-for="n in 3" :key="n" class="ce-ex" @click="useExample('agent.example' + n)">{{ t("agent.example" + n) }}</button>
            </div>
            <!-- 首启说明：确认行为是这个产品最需要提前讲清楚的一件事（写文件会先问）。
                 只讲一次、可关掉，且只在空态出现——不再是压在消息流顶上的一条横幅。 -->
            <p v-if="hintOpen" class="ce-note">
              <Icon name="shield" :size="12" />{{ t("agent.hintBody") }}
              <button class="link xs" @click="dismissHint">{{ t("agent.hintDismiss") }}</button>
            </p>
          </div>

          <!-- 运行级错误卡（仅实时运行；历史 run 的失败信息由交付清单的遗留说明表达） -->
          <section v-if="errorText && agentSession.runStatus === 'failed' && !viewRun" class="err-card">
            <Icon name="alert" :size="15" />
            <pre class="err-text">{{ errorText }}</pre>
          </section>

          <!-- Summary 交付清单：终态后给出「做了什么 / 产出了什么 / 遗留什么」（派生数据，见 script 注释） -->
          <section v-if="runSummary" class="sum-card">
            <div class="sum-head">
              <Icon name="check" :size="14" />
              <b>{{ t("agent.summaryTitle") }}</b>
              <span class="st-chip sm" :class="runSummary.cls">{{ t(runSummary.statusKey) }}</span>
            </div>
            <p class="sum-goal" :title="runSummary.goal">{{ runSummary.goal }}</p>
            <div v-if="runSummary.tools.length" class="sum-row">
              <span class="sum-label">{{ t("agent.summaryTools") }}</span>
              <span v-for="x in runSummary.tools" :key="x.name" class="tc-chip sm tc-neutral">{{ x.name }} × {{ x.count }}</span>
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
            <p v-if="runSummary.leftover" class="sum-leftover">{{ runSummary.leftover }}</p>
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
          <RunProgress
            v-if="busy || agentSession.pending"
            class="agent-progress"
            :steps="agentSession.steps"
            :status="progressStatus"
            :current-tool="currentTool"
            :max-steps="maxSteps"
            :tokens="usageText"
          />

          <!-- 目标输入框在回看模式下隐藏：历史是只读的，留着输入框会让人以为在编辑历史 -->
          <div v-if="!viewRun" class="goal-box">
            <!-- 域选择器（三期上下文）：没有领域数据时不显示；选定后给一行预览并可一键清除 -->
            <div v-if="domains.length" class="goal-domain">
              <label class="gd-label" :title="t('agent.domain')"><Icon name="layers" :size="13" />{{ t("agent.domain") }}</label>
              <select v-model="agentSession.contextDomain" class="gd-select">
                <option value="">{{ t("agent.domainNone") }}</option>
                <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.name }}</option>
              </select>
              <span v-if="selectedDomain" class="gd-context">{{ domainContextText }}</span>
              <button v-if="selectedDomain" class="link xs" @click="agentSession.contextDomain = ''">{{ t("agent.domainClear") }}</button>
            </div>
            <textarea
              ref="goalBox"
              v-model="goal"
              class="goal"
              rows="2"
              :placeholder="t('agent.goalPh')"
              @keydown="onGoalKey"
            ></textarea>
            <div class="goal-actions">
              <span class="goal-hint">Enter {{ t("agent.run") }} · Shift+Enter {{ t("agent.newline") }}</span>
              <button v-if="agentSession.steps.length" class="btn-ghost xs" :disabled="busy" @click="clearTimeline()">
                {{ t("agent.clear") }}
              </button>
              <button class="btn-primary sm" :disabled="busy || !goal.trim()" @click="startRun">
                <Icon name="rocket" :size="14" />{{ busy ? t("agent.running") : t("agent.run") }}
              </button>
            </div>
          </div>
        </footer>
      </div>

      <!-- 右栏：任务监控（Qoder 同名的「条件出现」面板）。
           它的可见性由监视器状态与运行态共同决定：只有正在跑、等你确认、或这一轮产出了
           文件时才占位，其余时间对话区独占整宽。工具开关不在这里——那是设置。 -->
      <aside v-if="monitorVisible" class="monitor">
        <div class="mon-head">
          <Icon name="activity" :size="14" />
          <b>{{ t("agent.monitorTitle") }}</b>
          <span class="st-chip sm" :class="statusMeta.cls">{{ t(statusMeta.key) }}</span>
        </div>
        <div class="mon-body">
          <div class="mon-sec">
            <span class="mon-label">{{ t("agent.goalLabel") }}</span>
            <p class="mon-goal">{{ threadGoal || t("agent.emptyTimeline") }}</p>
          </div>
          <div class="mon-sec">
            <span class="mon-label">{{ t("agent.monitorActivity") }}</span>
            <p class="mon-now">
              <template v-if="currentTool"><Icon name="zap" :size="12" /><code>{{ currentTool }}</code></template>
              <template v-else>{{ t(progressStatus === "waiting" ? "agent.statusWaiting" : busy ? "agent.running" : statusMeta.key) }}</template>
            </p>
            <p class="mon-meter">
              <span>{{ t("agent.stepsCount", { n: agentSession.steps.length }) }}</span>
              <span>{{ t("agent.tokensCount", { n: fmtNum(agentSession.usage.totalTokens) }) }}</span>
              <span>{{ t("agent.callsCount", { n: agentSession.usage.calls }) }}</span>
            </p>
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
    </div>
  </div>
</template>

<style scoped>
/* 页面留白对齐全局惯例：水平 28px，与顶栏标题起点对齐 */
.agent { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: var(--sp-3); padding: var(--sp-2) 28px 18px; }

/* ---------- 表头条 ---------- */
.bar { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
/* 进度条贴住输入框：它讲的是「这一次现在走到哪」，与用户下一步动作是同一件事 */
.agent-progress { flex-shrink: 0; }
.meter { display: inline-flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-sm); color: var(--muted); font-family: var(--font-num); }
.spacer { flex: 1; }

/* ---------- 空态（输入框正上方） ---------- */
/* 占满输入框以上的整块消息区并**垂直居中**：只顶对齐会在下面留出四五百像素的死白，
   读起来像界面没加载完；居中让标题、示例、说明成为这一屏的主体，视线自然落到下方输入框。
   flex:1 让它吃掉 .scroll 的剩余高度（.scroll 是 flex 列）。 */
.canvas-empty { flex: 1; margin: 0; padding: 0 var(--sp-6); display: flex; flex-direction: column; gap: var(--sp-3); align-items: center; justify-content: center; text-align: center; }
.ce-slogan { font-size: var(--fs-lg); font-weight: 700; color: var(--text-weak); }
.ce-hint { margin: 0; font-size: var(--fs-sm); color: var(--faint); }
.ce-examples { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--sp-2); margin-top: var(--sp-1); }
.ce-ex {
  padding: 5px 11px; font-size: var(--fs-sm); color: var(--primary-hover); text-align: left;
  background: var(--card); border: 1px solid var(--border-blue); border-radius: var(--r-pill);
  cursor: pointer; transition: background 0.15s, border-color 0.15s;
}
.ce-ex:hover { background: var(--primary-soft); border-color: var(--primary); }
/* 确认行为说明：低调的一段，且自带「知道了」——它讲的是安全边界，不是卖点。
   刻意不用 flex（图标会在大段文字里被挤到单独一行），图标用 vertical-align 跟首行对齐。 */
.ce-note {
  margin: var(--sp-2) 0 0; max-width: 60ch;
  font-size: var(--fs-xs); color: var(--muted); line-height: var(--lh-body);
}
.ce-note .icon { vertical-align: -2px; margin-right: 4px; }
.ce-note .link { margin-left: var(--sp-2); }

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

/* ---------- 对话列 + 条件出现的任务监控 ---------- */
/* 第二列只在监控面板真的渲染时才有意义，所以列宽由 .with-monitor 这个类切换，
   而不是写死 grid-template-columns（写死会让空列白占 320px，正是「右栏不常驻」要避免的）。
   刻意不用 :has(.monitor)：它要求较新的 WebView2，老运行时上规则会被整条丢弃、
   面板退化成堆在对话下方，而这里的降级必须可控。 */
.body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-5); align-items: stretch; }
.body.with-monitor { grid-template-columns: minmax(0, 1fr) 320px; }
/* 两列都要 min-height:0，否则 grid 子项被内容撑高、内部滚动失效 */
.canvas { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
/* 消息流：占满输入框以上的全部高度，滚它自己 */
.scroll { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding-bottom: var(--sp-3); }

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

/* ---------- 输入区（钉在对话列底部） ---------- */
.composer { flex-shrink: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
/* 与消息流的分隔：一条发丝线足矣，不做整块背板——输入框本身已经是卡片 */
.composer::before { content: ""; display: block; height: 1px; margin-bottom: var(--sp-1); background: var(--card-border); }

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

/* ---------- 目标输入 ---------- */
/* rows=2 + min-height 44px：输入框是入口不是编辑器，默认给两行足够写下目标；
   需要写长的拖右下角（resize: vertical）自己拉高，而不是一上来就占掉半屏。 */
.goal-box { flex-shrink: 0; display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); }
.goal {
  width: 100%; resize: vertical; min-height: 44px; padding: var(--sp-3);
  font-family: inherit; font-size: var(--fs-base); line-height: var(--lh-body); color: var(--text);
  background: var(--card-soft); border: 1px solid var(--border); border-radius: var(--r-sm);
}
.goal:focus { outline: none; border-color: var(--primary); background: var(--card); }
.goal-actions { display: flex; align-items: center; gap: var(--sp-3); }
.goal-hint { flex: 1; font-size: var(--fs-xs); color: var(--faint); }

/* ---------- 域选择器（三段同色系小控件，与目标输入同卡） ---------- */
.goal-domain { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.gd-label { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); }
.gd-select { max-width: 220px; padding: 3px var(--sp-2); font-size: var(--fs-sm); color: var(--text); background: var(--card-soft); border: 1px solid var(--border); border-radius: var(--r-sm); }
.gd-select:focus { outline: none; border-color: var(--primary); }
.gd-context { font-size: var(--fs-xs); color: var(--primary-hover); background: var(--primary-soft); padding: 1px var(--sp-2); border-radius: var(--r-pill); }

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

/* ---------- 时间线 ---------- */
.timeline { display: flex; flex-direction: column; gap: var(--sp-2); }

.tl-card { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); overflow: hidden; }

/* 工具卡的「正在动手 / 已落地」反馈（动效第一层体感，不需要工具侧改造就生效）。
   呼吸动画只在允许动效时播：prefers-reduced-motion 下退化为静态主色描边。 */
.tl-card[data-status="running"] { border-color: var(--primary); }
.tl-card[data-status="ok"] { animation: tlCardSettle 0.42s var(--ease-out); }
@media (prefers-reduced-motion: no-preference) {
  .tl-card[data-status="running"] { animation: tlCardBreath 1.4s ease-in-out infinite; }
}
@keyframes tlCardBreath {
  0%, 100% { box-shadow: 0 0 0 0 var(--primary-soft); }
  50% { box-shadow: 0 0 0 4px var(--primary-soft); }
}
@keyframes tlCardSettle {
  0% { transform: translateY(-1px); box-shadow: 0 0 0 3px var(--primary-soft); }
  100% { transform: none; box-shadow: none; }
}
.tl-head { display: flex; align-items: center; gap: var(--sp-2); width: 100%; padding: var(--sp-2) var(--sp-4); background: transparent; border: none; cursor: pointer; text-align: left; transition: background 0.15s; }
.tl-head:hover { background: var(--card-soft); }
.tl-arrow { flex-shrink: 0; color: var(--muted); transition: transform 0.15s; }
.tl-arrow.open { transform: rotate(90deg); }
.tl-ico { flex-shrink: 0; color: var(--primary); }
.tl-name { flex-shrink: 0; font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.tl-n { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-num); }
.tl-badge { margin-left: auto; flex-shrink: 0; padding: 1px var(--sp-2); font-size: var(--fs-xs); font-weight: 600; border-radius: var(--r-pill); color: var(--text-soft); background: var(--well); }
.tl-badge.sm { padding: 0 var(--sp-1); }
.tl-badge.b-running { color: var(--primary); background: var(--primary-soft); }
.tl-badge.b-ok { color: var(--success-deep); background: var(--success-soft); }
.tl-badge.b-retry { color: var(--warn-deep); background: var(--amber-soft); }
.tl-badge.b-error { color: var(--danger-deep); background: var(--danger-soft); }
.tl-body { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4) var(--sp-4); border-top: 1px solid var(--card-border); background: var(--card-soft); }
.tl-attempt { display: flex; flex-direction: column; gap: var(--sp-2); }
.ta-head { display: flex; align-items: center; gap: var(--sp-2); }
.ta-n { font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-num); }
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
.tl-notice { color: var(--warn-deep); background: var(--amber-soft); border-color: var(--amber-border); }
/* 审计行：与确认行同款右对齐结论，但来源是事件流而非卡片 */
.tl-approval { color: var(--text-weak); }
.tl-approval .ok { margin-left: auto; color: var(--success-deep); font-size: var(--fs-sm); }
.tl-approval .no { margin-left: auto; color: var(--danger-deep); font-size: var(--fs-sm); }
.tl-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.answer-card { padding: var(--sp-4) var(--sp-5); background: var(--card); border: 1px solid var(--border-blue); border-radius: var(--r-md); }
.ans-head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-bottom: var(--sp-2); color: var(--primary-hover); }
.ans-head b { font-size: var(--fs-md); }

.working { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-4); font-size: var(--fs-sm); color: var(--muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--primary); animation: agentPulse 1.1s ease-in-out infinite; }
@keyframes agentPulse { 0%, 100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }

.err-card { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-4) var(--sp-5); color: var(--danger-deep); background: var(--danger-soft); border: 1px solid var(--border-danger); border-radius: var(--r-md); }
.err-text { flex: 1; min-width: 0; margin: 0; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--danger-deep); white-space: pre-wrap; word-break: break-word; }

/* ---------- Summary 交付清单 ---------- */
.sum-card { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4) var(--sp-5); background: var(--card); border: 1px solid var(--border-blue); border-radius: var(--r-md); }
.sum-head { display: flex; align-items: center; gap: var(--sp-2); color: var(--primary-hover); }
.sum-head b { font-size: var(--fs-md); }
.sum-head .st-chip { margin-left: auto; }
.sum-goal { margin: 0; font-size: var(--fs-sm); color: var(--text-weak); line-height: var(--lh-tight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sum-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); font-size: var(--fs-sm); }
.sum-label { flex-shrink: 0; color: var(--muted); font-size: var(--fs-xs); }
.sum-leftover { margin: 0; font-size: var(--fs-sm); color: var(--warn-deep); line-height: var(--lh-body); }

/* ---------- 任务监控（右侧，条件出现） ---------- */
/* 320px 而不是二期能力清单的 340px：这栏只放目标/实时状态/产物，不需要工具目录那么宽。
   它出现时对话区仍然拿得到绝大部分宽度，1280px 窗口下也不至于把消息挤成窄条。 */
.monitor { min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.mon-head { display: flex; align-items: center; gap: var(--sp-2); color: var(--text-weak); }
.mon-head b { font-size: var(--fs-sm); }
.mon-head .st-chip { margin-left: auto; }
.mon-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding-right: 2px; }
.mon-sec { display: flex; flex-direction: column; gap: var(--sp-2); }
.mon-label { font-size: var(--fs-xs); font-weight: 700; color: var(--faint); }
/* 目标可能很长（一句话描述）：限高滚动而不是撑爆面板，也不截断成看不懂的半句 */
.mon-goal { margin: 0; max-height: 6.6em; overflow: auto; font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--text); white-space: pre-wrap; word-break: break-word; }
.mon-now { display: flex; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-sm); color: var(--text-soft); }
.mon-now code { padding: 1px var(--sp-1); background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-xs); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-code); }
.mon-meter { display: flex; flex-wrap: wrap; gap: var(--sp-3); margin: 0; font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-num); }
/* 面板里唯一一句「去哪儿配」的指路，常驻在底部（工具开关在设置页，见 capMoved） */
.mon-hint { margin: auto 0 0; padding-top: var(--sp-2); font-size: var(--fs-xs); color: var(--faint); line-height: var(--lh-body); border-top: 1px solid var(--card-border); }

.manual-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.m-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; font-size: var(--fs-xs); font-weight: 600; color: var(--text-soft); background: var(--ghost); border: 1px solid var(--border); border-radius: var(--r-pill); cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s; }
.m-chip:hover { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); }
/* 顶栏的「任务监控」按钮：面板开着时留一个按下态，否则点了没反馈 */
.mon-on { color: var(--primary-hover); border-color: var(--border-blue); background: var(--primary-soft); }

/* ---------- 局部链接按钮（全局按钮体系里没有 xs 文字钮） ---------- */
.link { padding: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--primary); background: none; border: none; cursor: pointer; transition: color 0.15s; }
.link:hover { color: var(--primary-hover); text-decoration: underline; }
.link.xs { font-size: var(--fs-xs); font-weight: 500; color: var(--muted); }
.link.xs:hover { color: var(--primary); }
.link.xs.danger:hover { color: var(--danger); }
.link:disabled { opacity: 0.45; cursor: not-allowed; text-decoration: none; }

/* 深色下 --primary 被压深（为了主按钮上的白字达标），文字类链接需要更亮的一档，
   否则 12.5px 的链接只有 3.67:1（E2E 对比度审计）。同理用于空态的示例按钮文字。 */
@media (prefers-color-scheme: dark) {
  .link { color: var(--primary-light); }
  .link:hover { color: var(--primary-bright); }
  .ce-ex { color: var(--primary-light); }
  .ce-ex:hover { color: var(--primary-bright); }
}

/* 窄窗口：监控面板移到对话列下方，并且不再有并排的两列。
   同权重下靠源码顺序盖过上面的 .body.with-monitor。 */
@media (max-width: 1100px) {
  .body.with-monitor { grid-template-columns: minmax(0, 1fr); }
  .body { overflow: auto; }
  .monitor { min-height: 0; }
}
</style>
