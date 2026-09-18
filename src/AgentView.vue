<script setup>
// Agent 工作台：应用首屏。运行态在 src/agent/session.js 的模块级单例里，
// 视图被 :key="activeModule" 销毁重建也不丢运行、pending 确认与时间线。
import { ref, reactive, computed, inject, nextTick, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";
import MarkdownRender from "./tools/MarkdownRender.vue";
import { errText, relativeTime } from "./shared.js";
import { buildAgentRegistry, listAgentTools } from "./agent/tools.js";
import { foldTimeline, payloadText, COLLAPSE_AT } from "./agent/timeline.js";
import { describePreview, rowKind, rowText } from "./agent/preview.js";
import { canResume, sanitizeRun } from "./agent/runStore.js";
import { visibleToolboxTools, findToolboxTool } from "./toolboxTools.js";
import { openToolWindow, isTauriEnv } from "./toolWindow.js";
import { track } from "./telemetry.js";
import {
  agentSession,
  answerPending,
  clearSpills,
  clearTimeline,
  deleteSkill,
  discardRun,
  initAgentSession,
  promoteRunToSkill,
  resolvePending,
  resumeAgentRun,
  setSkillEnabled,
  setToolEnabled,
  startAgentRun,
  stopAgentRun,
} from "./agent/session.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  // App.vue 对所有模块视图统一透传这两个 prop；Agent 视图没有分段与跳转目标，仅为契约一致
  section: { type: String, default: "" },
  jumpId: { type: Object, default: null },
});
const emit = defineEmits(["navigate"]);

const { t } = useI18n();
const openSettings = inject("openSettings", null);

// payloadText 在模板里会被同一份数据反复调用，这里一次性算好挂到尝试上
const timeline = computed(() =>
  foldTimeline(agentSession.steps).map((item) =>
    item.kind === "tool"
      ? { ...item, attempts: item.attempts.map((a) => ({ ...a, argsText: payloadText(a.args), resultText: payloadText(a.result) })) }
      : item
  )
);
const busy = computed(() => agentSession.status !== "idle");
const toolMeta = computed(() => new Map(listAgentTools(agentSession.cfg).map((x) => [x.name, x])));
// registry 只建一次：逐行调 canResume 会为 30 行历史重建 30 次 14 个工具定义
const resumeMap = computed(() => {
  const registry = buildAgentRegistry(agentSession.cfg);
  const map = new Map();
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

const RISK_ORDER = ["read", "transform", "write", "database"];
const RISK_CHIP = { read: "tc-sky", transform: "tc-primary", write: "tc-danger", database: "tc-teal" };
const RISK_KEY = { read: "agent.riskRead", transform: "agent.riskTransform", write: "agent.riskWrite", database: "agent.riskDatabase" };
const riskChip = (risk) => RISK_CHIP[risk] || "tc-neutral";
const riskKey = (risk) => RISK_KEY[risk] || "agent.riskRead";

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
const noticeText = (item) => {
  // 需要参数的两类：结果被裁剪（省略了多少）、完整结果落盘（key 是什么）。
  // 模型侧看的是引擎原文，人看的是词条——两边都要能说清「这一步为什么信息变少了」。
  if (item.code === "tool_clip") return t("agent.noticeToolClip", { omitted: item.omittedChars || 0, original: item.originalChars || 0 });
  if (item.code === "tool_spill") return t("agent.noticeToolSpill", { key: item.text || "", chars: item.chars || 0 });
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

// 能力面板：机器工具按风险分组 + 手动兜底工具箱
const capTools = computed(() => listAgentTools(agentSession.cfg));
const capGroups = computed(() =>
  RISK_ORDER.map((risk) => ({ risk, tools: capTools.value.filter((x) => x.risk === risk) })).filter((g) => g.tools.length > 0)
);
const capEnabledCount = computed(() => capTools.value.filter((x) => x.enabled).length);
const manualTools = visibleToolboxTools();
const railTab = ref("caps");

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
});

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
  if (await startAgentRun(input)) {
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

async function onToggleTool(tool) {
  try {
    await setToolEnabled(tool.name, !tool.enabled);
  } catch (e) {
    props.showToast(e?.code === "ALL_DISABLED" ? t("settings.errAgentTools") : t("settings.saveFailed", { err: errText(e) }));
  }
}

function openManual(toolKey) {
  const tool = findToolboxTool(toolKey);
  if (!tool) return;
  track("tool." + tool.key);
  const fallback = () => emit("navigate", { module: "toolbox", id: tool.key });
  if (isTauriEnv()) openToolWindow(tool, { showToast: props.showToast, onFallback: fallback });
  else fallback();
}

async function onCopy(text, okKey) {
  try {
    await navigator.clipboard.writeText(text);
    props.showToast(t(okKey));
  } catch {
    props.showToast(t("agent.copyFail"));
  }
}

function onRerun(rec) {
  goal.value = rec.input || "";
  nextTick(() => goalBox.value?.focus());
}

async function onResume(rec) {
  if (!resumeMap.value.get(rec.id)) return props.showToast(t("agent.resumeBlocked"));
  if (!agentSession.aiReady) {
    props.showToast(t("agent.errNoAI"));
    return goSettings("ai");
  }
  track("agent.resume");
  await resumeAgentRun(rec);
}

// ------- 技能库 -------
// 技能是「可选增强」：关掉/删掉都不影响可执行能力，所以没有「至少留一条」的校验（对比工具开关）。
const skillDisabled = (id) => (agentSession.cfg?.disabledSkills || []).includes(id);
const skillsOpen = ref(false);

async function onPromoteRun(runId) {
  try {
    const result = await promoteRunToSkill(runId);
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

async function onToggleSkill(skill) {
  try {
    await setSkillEnabled(skill.id, skillDisabled(skill.id));
  } catch (e) {
    props.showToast(t("settings.saveFailed", { err: errText(e) }));
  }
}

async function onDeleteSkill(skill) {
  try {
    if (await deleteSkill(skill.id)) props.showToast(t("agent.skillDeleted", { name: skill.name }));
  } catch (e) {
    props.showToast(t("settings.saveFailed", { err: errText(e) }));
  }
}

/** 清空溢出结果区。没有可清的条目时如实说「本来就是空的」，不要假装成功。 */
async function onClearSpills() {
  try {
    const result = await clearSpills();
    props.showToast(
      result.cleared
        ? t("agent.spillCleared", { n: result.cleared, chars: fmtNum(result.chars) })
        : t("agent.spillClearEmpty")
    );
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
const runLabel = (rec) => t(runMeta(rec).key);
</script>

<template>
  <div class="agent">
    <!-- 表头条 -->
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
      <button class="btn-ghost sm" @click="goSettings('agent')">
        <Icon name="settings" :size="14" />{{ t("agent.openSettings") }}
      </button>
      <button v-if="busy" class="btn-outline danger sm" @click="stopAgentRun('user')">
        <Icon name="x" :size="14" />{{ t("agent.stop") }}
      </button>
    </header>

    <!-- 首启引导卡：可关闭，不叠第二个模态（遥测同意弹窗已是唯一的模态闸门） -->
    <section v-if="hintOpen" class="hint">
      <button class="hint-x icon-btn xs" :aria-label="t('agent.hintDismiss')" @click="dismissHint">
        <Icon name="x" :size="13" />
      </button>
      <b class="hint-title">{{ t("agent.hintTitle") }}</b>
      <p class="hint-body">{{ t("agent.hintBody") }}</p>
      <div class="hint-examples">
        <button v-for="n in 3" :key="n" class="hint-ex" @click="useExample('agent.example' + n)">{{ t("agent.example" + n) }}</button>
      </div>
      <div class="hint-foot">
        <button class="link" @click="railTab = 'caps'">{{ t("agent.capTitle") }}</button>
        <button class="link" @click="dismissHint">{{ t("agent.hintDismiss") }}</button>
      </div>
    </section>

    <!-- 未配置模型：给出两条出路，而不是把死界面推给用户 -->
    <section v-if="!agentSession.aiReady" class="noai">
      <Icon name="sparkles" :size="20" />
      <b>{{ t("agent.empty") }}</b>
      <p>{{ t("agent.settingsHint") }}</p>
      <div class="noai-actions">
        <button class="btn-primary sm" @click="goSettings('ai')">{{ t("agent.configureAI") }}</button>
        <button class="btn-ghost sm" @click="emit('navigate', { module: 'toolbox' })">{{ t("agent.openToolbox") }}</button>
      </div>
    </section>

    <div class="body">
      <!-- 运行画布 -->
      <div class="canvas">
        <div class="goal-box">
          <textarea
            ref="goalBox"
            v-model="goal"
            class="goal"
            rows="3"
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

        <div class="scroll">
          <!-- 内联确认卡：运行时交给我们的是 Promise，卡片能展示工具名 / 风险 / 完整 args，
               全局 askConfirm 模态做不到，而且不会盖住用户正在看的时间线 -->
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
              <article v-if="item.kind === 'tool'" class="tl-card">
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
                      </div>
                      <pre
                        class="pl-body"
                        :class="{ clipped: a.resultText.length > COLLAPSE_AT && !openPayloads.has(item.id + '#' + a.n + '#result') }"
                      >{{ a.resultText }}</pre>
                    </div>
                    <p v-if="a.error" class="ta-error"><Icon name="alert" :size="12" />{{ attemptText(a) }}</p>
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
                  <!-- 沉淀为技能：只有真的跑成功、且用过工具的运行才值得复用（引擎侧判定） -->
                  <button
                    v-if="agentSession.runStatus === 'completed'"
                    class="link xs ans-skill"
                    :title="t('agent.skillPromoteTip')"
                    @click="onPromoteRun(agentSession.currentRunId)"
                  >
                    <Icon name="sparkles" :size="12" />{{ t("agent.skillPromote") }}
                  </button>
                </div>
                <MarkdownRender :text="item.answer" :show-toast="showToast" />
              </article>
            </template>

            <div v-if="busy" class="working">
              <span class="dot"></span>{{ agentSession.status === "waiting" ? t("agent.statusWaiting") : t("agent.running") }}
            </div>
          </section>

          <p v-else class="canvas-empty">{{ t("agent.emptyTimeline") }}</p>

          <!-- 运行级错误卡 -->
          <section v-if="errorText && agentSession.runStatus === 'failed'" class="err-card">
            <Icon name="alert" :size="15" />
            <pre class="err-text">{{ errorText }}</pre>
          </section>
        </div>
      </div>

      <!-- 右栏：能力清单 / 最近任务 -->
      <aside class="rail">
        <div class="rail-tabs">
          <button :class="{ on: railTab === 'caps' }" @click="railTab = 'caps'">{{ t("agent.capTitle") }}</button>
          <button :class="{ on: railTab === 'history' }" @click="railTab = 'history'">
            {{ t("agent.history") }}
            <span v-if="agentSession.runs.length" class="rail-n">{{ agentSession.runs.length }}</span>
          </button>
        </div>

        <div v-if="railTab === 'caps'" class="rail-body">
          <p class="rail-desc">{{ t("agent.capDesc", { n: capEnabledCount }) }}</p>
          <section v-for="group in capGroups" :key="group.risk" class="cap-group">
            <h4 class="cap-head">
              <span class="tc-chip sm" :class="riskChip(group.risk)">{{ t(riskKey(group.risk)) }}</span>
              <span class="cap-count">{{ group.tools.length }}</span>
            </h4>
            <div v-for="tool in group.tools" :key="tool.name" class="cap-row" :class="{ off: !tool.enabled }">
              <div class="cap-main">
                <code class="cap-name">{{ tool.name }}</code>
                <span class="cap-item-desc">{{ tool.descriptionKey ? t(tool.descriptionKey) : tool.name }}</span>
              </div>
              <div class="cap-side">
                <button v-if="tool.toolKey" class="link xs" :title="t('agent.capOpenTool')" @click="openManual(tool.toolKey)">
                  <Icon name="open" :size="12" />
                </button>
                <button
                  class="switch"
                  role="switch"
                  :aria-checked="tool.enabled"
                  :aria-label="tool.name"
                  :title="t('agent.capEnabled')"
                  @click="onToggleTool(tool)"
                >
                  <span class="knob"></span>
                </button>
              </div>
            </div>
          </section>

          <!-- 技能库：用户自己沉淀的成功路径。默认折叠——技能是可选增强，不该挤占能力清单的位置。 -->
          <section class="cap-group">
            <button class="cap-head skill-head" :aria-expanded="skillsOpen" @click="skillsOpen = !skillsOpen">
              <Icon name="chevron-right" :size="13" class="tl-arrow" :class="{ open: skillsOpen }" />
              <span class="tc-chip sm tc-primary">{{ t("agent.capSkills") }}</span>
              <span class="cap-count">{{ agentSession.skills.length }}</span>
            </button>
            <template v-if="skillsOpen">
              <p class="rail-desc">{{ t("agent.capSkillsDesc") }}</p>
              <p v-if="!agentSession.skills.length" class="rail-desc">{{ t("agent.skillEmpty") }}</p>
              <div v-for="skill in agentSession.skills" :key="skill.id" class="cap-row" :class="{ off: skillDisabled(skill.id) }">
                <div class="cap-main">
                  <code class="cap-name">{{ skill.name }}</code>
                  <span class="cap-item-desc">{{ skill.description || t("agent.skillNoDesc") }}</span>
                </div>
                <div class="cap-side">
                  <button class="link xs danger" :title="t('agent.skillDelete')" @click="onDeleteSkill(skill)">
                    <Icon name="trash" :size="12" />
                  </button>
                  <button
                    class="switch"
                    role="switch"
                    :aria-checked="!skillDisabled(skill.id)"
                    :aria-label="t('agent.skillToggle')"
                    :class="{ on: !skillDisabled(skill.id) }"
                    @click="onToggleSkill(skill)"
                  >
                    <span class="knob"></span>
                  </button>
                </div>
              </div>
            </template>
          </section>

          <section class="cap-group">
            <h4 class="cap-head">
              <span class="tc-chip sm tc-neutral">{{ t("agent.capManual") }}</span>
              <span class="cap-count">{{ manualTools.length }}</span>
            </h4>
            <p class="rail-desc">{{ t("agent.capManualDesc") }}</p>
            <div class="manual-chips">
              <button v-for="tool in manualTools" :key="tool.key" class="m-chip" @click="openManual(tool.key)">
                <Icon :name="tool.icon" :size="13" />{{ t(tool.labelKey) }}
              </button>
            </div>
            <button class="btn-ghost sm wide" @click="emit('navigate', { module: 'toolbox' })">
              <Icon name="grid" :size="14" />{{ t("agent.openToolbox") }}
            </button>
          </section>
          <p class="rail-desc">{{ t("agent.capSettingsHint") }}</p>
          <!-- 溢出结果区：大结果落盘的正文会占磁盘，这里给一个手动出口。
               措辞如实——桌面端删不掉文件本体，只能清索引并把正文覆写成空。 -->
          <section class="cap-group">
            <h4 class="cap-head">
              <span class="tc-chip sm tc-neutral">{{ t("agent.capSpills") }}</span>
            </h4>
            <p class="rail-desc">{{ t("agent.capSpillsDesc") }}</p>
            <button class="btn-ghost sm wide" :disabled="busy" @click="onClearSpills">
              <Icon name="trash" :size="13" />{{ t("agent.spillClear") }}
            </button>
          </section>
        </div>

        <div v-else class="rail-body">
          <p v-if="!agentSession.runs.length" class="rail-desc">{{ t("agent.historyEmpty") }}</p>
          <article v-for="rec in agentSession.runs" :key="rec.id" class="run-item" :class="{ cur: rec.id === agentSession.currentRunId }">
            <div class="run-top">
              <span class="st-chip sm" :class="runMeta(rec).cls">{{ runLabel(rec) }}</span>
              <span class="run-time">{{ relativeTime(rec.updatedAt || rec.createdAt) }}</span>
            </div>
            <p class="run-input" :title="rec.input">{{ rec.input }}</p>
            <div class="run-meter">
              {{ t("agent.stepsCount", { n: rec.steps?.length || 0 }) }} · {{ t("agent.tokensCount", { n: fmtNum(rec.usage?.totalTokens) }) }}
            </div>
            <div class="run-actions">
              <button
                class="link xs"
                :disabled="busy || !resumeMap.get(rec.id)"
                :title="resumeMap.get(rec.id) ? t('agent.resume') : t('agent.resumeBlocked')"
                @click="onResume(rec)"
              >
                {{ t("agent.resume") }}
              </button>
              <button class="link xs" :disabled="busy" @click="onRerun(rec)">{{ t("agent.rerun") }}</button>
              <button class="link xs" @click="onCopy(JSON.stringify(sanitizeRun(rec), null, 2), 'agent.copied')">
                {{ t("agent.copyRun") }}
              </button>
              <button class="link xs danger" :disabled="busy" @click="discardRun(rec.id)">{{ t("agent.deleteRun") }}</button>
            </div>
          </article>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* 页面留白对齐全局惯例：水平 28px，与顶栏标题起点对齐 */
.agent { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: var(--sp-3); padding: 8px 28px 18px; }

/* ---------- 表头条 ---------- */
.bar { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.meter { display: inline-flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-sm); color: var(--muted); font-family: var(--font-num); }
.spacer { flex: 1; }

/* ---------- 首启引导卡 ---------- */
.hint {
  position: relative; flex-shrink: 0; padding: var(--sp-5) var(--sp-6);
  background: var(--grad-promo); border: 1px solid var(--border-blue); border-radius: var(--r-md);
  display: flex; flex-direction: column; gap: var(--sp-2);
}
.hint-x { position: absolute; top: 10px; right: 10px; }
.hint-title { font-size: var(--fs-base); font-weight: 700; }
.hint-body { margin: 0; font-size: var(--fs-sm); color: var(--text-weak); line-height: var(--lh-body); max-width: 78ch; }
.hint-examples { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.hint-ex {
  padding: 5px 11px; font-size: var(--fs-sm); color: var(--primary-hover); text-align: left;
  background: var(--card); border: 1px solid var(--border-blue); border-radius: var(--r-pill);
  cursor: pointer; transition: all 0.15s;
}
.hint-ex:hover { background: var(--primary-soft); border-color: var(--primary); }
.hint-foot { display: flex; gap: var(--sp-4); }

/* ---------- 未配置模型 ---------- */
.noai {
  flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2);
  padding: var(--sp-5) var(--sp-6); color: var(--text);
  background: var(--card); border: 1px dashed var(--border-strong); border-radius: var(--r-md);
}
.noai b { font-size: var(--fs-base); }
.noai p { margin: 0; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }
.noai-actions { display: flex; gap: var(--sp-3); }

/* ---------- 两栏 ---------- */
.body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: var(--sp-5); align-items: stretch; }
.canvas { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-4); }
.scroll { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding-bottom: var(--sp-3); }

/* ---------- 目标输入 ---------- */
.goal-box { flex-shrink: 0; display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); }
.goal {
  width: 100%; resize: vertical; min-height: 62px; padding: var(--sp-3);
  font-family: inherit; font-size: var(--fs-base); line-height: var(--lh-body); color: var(--text);
  background: var(--card-soft); border: 1px solid var(--border); border-radius: var(--r-sm);
}
.goal:focus { outline: none; border-color: var(--primary); background: var(--card); }
.goal-actions { display: flex; align-items: center; gap: var(--sp-3); }
.goal-hint { flex: 1; font-size: var(--fs-xs); color: var(--faint); }

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
.canvas-empty { margin: 0; padding: var(--sp-7) 0; text-align: center; font-size: var(--fs-sm); color: var(--faint); }

.tl-card { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); overflow: hidden; }
.tl-head { display: flex; align-items: center; gap: var(--sp-2); width: 100%; padding: var(--sp-2) var(--sp-4); background: transparent; border: none; cursor: pointer; text-align: left; transition: background 0.15s; }
.tl-head:hover { background: var(--card-soft); }
.tl-arrow { flex-shrink: 0; color: var(--muted); transition: transform 0.15s; }
.tl-arrow.open { transform: rotate(90deg); }
.tl-ico { flex-shrink: 0; color: var(--primary); }
.tl-name { flex-shrink: 0; font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.tl-n { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-num); }
.tl-badge { margin-left: auto; flex-shrink: 0; padding: 1px 8px; font-size: var(--fs-xs); font-weight: 600; border-radius: var(--r-pill); color: var(--text-soft); background: var(--well); }
.tl-badge.sm { padding: 0 6px; }
.tl-badge.b-running { color: var(--primary); background: var(--primary-soft); }
.tl-badge.b-ok { color: var(--success-deep); background: var(--success-soft); }
.tl-badge.b-retry { color: var(--warn-deep); background: var(--amber-soft); }
.tl-badge.b-error { color: var(--danger-deep); background: var(--danger-soft); }
.tl-body { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4) var(--sp-4); border-top: 1px solid var(--card-border); background: var(--card-soft); }
.tl-attempt { display: flex; flex-direction: column; gap: var(--sp-2); }
.ta-head { display: flex; align-items: center; gap: var(--sp-2); }
.ta-n { font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-num); }
.ta-error { display: flex; align-items: center; gap: 5px; margin: 0; font-size: var(--fs-sm); color: var(--danger-deep); line-height: var(--lh-body); }

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
.ans-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); color: var(--primary-hover); }
.ans-head b { font-size: var(--fs-md); }

.working { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-4); font-size: var(--fs-sm); color: var(--muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--primary); animation: agentPulse 1.1s ease-in-out infinite; }
@keyframes agentPulse { 0%, 100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }

.err-card { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-4) var(--sp-5); color: var(--danger-deep); background: var(--danger-soft); border: 1px solid var(--border-danger); border-radius: var(--r-md); }
.err-text { flex: 1; min-width: 0; margin: 0; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--danger-deep); white-space: pre-wrap; word-break: break-word; }

/* ---------- 右栏 ---------- */
.rail { min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.rail-tabs { flex-shrink: 0; display: flex; gap: var(--sp-1); padding: 3px; background: var(--well); border-radius: var(--r-sm); }
.rail-tabs button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 5px 8px; font-size: var(--fs-md); font-weight: 600; color: var(--muted); background: transparent; border: none; border-radius: var(--r-xs); cursor: pointer; transition: all 0.15s; }
.rail-tabs button.on { color: var(--primary-hover); background: var(--card); box-shadow: var(--shadow-tile); }
.rail-n { padding: 0 5px; font-size: var(--fs-xs); font-family: var(--font-num); color: var(--text-invert); background: var(--primary); border-radius: var(--r-pill); }
.rail-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding-right: 2px; }
.rail-desc { margin: 0; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }

.cap-group { display: flex; flex-direction: column; gap: var(--sp-2); }
.cap-head { display: flex; align-items: center; gap: var(--sp-2); margin: 0; }
.cap-count { font-size: var(--fs-xs); color: var(--faint); font-family: var(--font-num); }
.cap-row { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); }
.cap-row.off { opacity: 0.55; }
.cap-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.cap-name { font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.cap-item-desc { font-size: var(--fs-xs); color: var(--muted); line-height: var(--lh-tight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cap-side { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); }
/* 技能库：折叠头是可点击的整行按钮，不是标题（观感与 cap-head 保持一致） */
.skill-head { width: 100%; display: flex; align-items: center; gap: var(--sp-2); background: none; border: 0; padding: 0; cursor: pointer; color: inherit; font: inherit; }
.skill-head .tl-arrow { transition: transform 0.15s; color: var(--muted); }
.skill-head .tl-arrow.open { transform: rotate(90deg); }
.ans-skill { margin-left: auto; }

/* 开关：能力面板里启停单个工具 */
.switch { position: relative; width: 34px; height: 19px; flex-shrink: 0; display: inline-flex; align-items: center; padding: 0 2px; background: var(--well-hover); border: 1px solid var(--border-strong); border-radius: var(--r-pill); cursor: pointer; transition: background 0.15s, border-color 0.15s; color: var(--warn); }
.switch .knob { position: absolute; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--card); box-shadow: var(--shadow-tile); transition: transform 0.15s; }
.switch[aria-checked="true"] { background: var(--primary); border-color: var(--primary); }
.switch[aria-checked="true"] .knob { transform: translateX(15px); }

.manual-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.m-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; font-size: var(--fs-xs); font-weight: 600; color: var(--text-soft); background: var(--ghost); border: 1px solid var(--border); border-radius: var(--r-pill); cursor: pointer; transition: all 0.15s; }
.m-chip:hover { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); }
.wide { width: 100%; }

/* ---------- 运行历史 ---------- */
.run-item { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-3); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); }
.run-item.cur { border-color: var(--border-blue); background: color-mix(in srgb, var(--primary) 2.5%, var(--card)); }
.run-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.run-time { flex-shrink: 0; font-size: var(--fs-xs); color: var(--faint); }
.run-input { margin: 0; font-size: var(--fs-sm); color: var(--text); line-height: var(--lh-tight); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.run-meter { font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-num); }
.run-actions { display: flex; flex-wrap: wrap; gap: var(--sp-3); margin-top: 2px; }

/* ---------- 局部链接按钮（全局按钮体系里没有 xs 文字钮） ---------- */
.link { padding: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--primary); background: none; border: none; cursor: pointer; transition: color 0.15s; }
.link:hover { color: var(--primary-hover); text-decoration: underline; }
.link.xs { font-size: var(--fs-xs); font-weight: 500; color: var(--muted); }
.link.xs:hover { color: var(--primary); }
.link.xs.danger:hover { color: var(--danger); }
.link:disabled { opacity: 0.45; cursor: not-allowed; text-decoration: none; }

/* 深色下 --primary 被压深（为了主按钮上的白字达标），文字类链接需要更亮的一档，
   否则 12.5px 的链接只有 3.67:1（E2E 对比度审计）。同理用于 .hint-ex 的示例按钮文字。 */
@media (prefers-color-scheme: dark) {
  .link { color: var(--primary-light); }
  .link:hover { color: var(--primary-bright); }
  .hint-ex { color: var(--primary-light); }
  .hint-ex:hover { color: var(--primary-bright); }
}

/* 窄窗口：右栏移到主列下方 */
@media (max-width: 1000px) {
  .body { grid-template-columns: 1fr; overflow: auto; }
  .rail { min-height: 320px; }
}
</style>
