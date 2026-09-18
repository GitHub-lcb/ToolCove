<script setup>
// Agent 工作台（手机端）：目标输入 → 时间线 → 确认卡 → 历史 / 技能。
//
// 运行态完全复用 src/agent/session.js 的单例（与桌面端同一份）：
// 视图被销毁重建也不丢运行、pending 确认与时间线。时间线折叠用 agent/timeline.js 的 foldTimeline，
// 所以「工具卡 + 确认行」的口径与桌面端一致。
//
// 手机端的呈现取舍：桌面端是「左侧运行 + 右侧历史/技能」的多栏工作台；
// 手机改成**运行区优先，历史/技能收进可切换的分段**——玩的时候最常看的是"现在跑到哪了"。
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  agentSession,
  answerPending,
  clearTimeline,
  deleteSkill,
  discardRun,
  initAgentSession,
  promoteRunToSkill,
  resolvePending,
  resumeAgentRun,
  setSkillEnabled,
  startAgentRun,
  stopAgentRun,
} from "../../src/agent/session.js";
import { listAgentTools } from "../../src/agent/tools.js";
import { COLLAPSE_AT, foldTimeline, payloadText } from "../../src/agent/timeline.js";

const { t } = useI18n();

const goal = ref("");
const answerDraft = ref("");
const tab = ref("run"); // run | history | skills
const error = ref("");
const openCards = ref(new Set());

const busy = computed(() => agentSession.status !== "idle");
const pending = computed(() => agentSession.pending);
const toolMeta = computed(() => new Map(listAgentTools(agentSession.cfg).map((x) => [x.name, x])));
const timeline = computed(() =>
  foldTimeline(agentSession.steps).map((item) => ({
    ...item,
    // 工具卡默认折叠长结果（手机上更明显：一屏放不下两三段长文本）
    collapsed: item.kind === "tool" && (item.attempts?.at(-1)?.result?.length || 0) > COLLAPSE_AT && !openCards.value.has(item.id),
  }))
);

const skills = computed(() => agentSession.skills || []);
const runs = computed(() => (agentSession.runs || []).slice(0, 10));

onMounted(initAgentSession);

// 运行中的工具卡自动展开：正在发生的事不该被折叠起来
watch(
  () => timeline.value.length,
  () => {
    const last = timeline.value.at(-1);
    if (last?.kind === "tool" && last.id && busy.value) {
      const next = new Set(openCards.value);
      next.add(last.id);
      openCards.value = next;
    }
  }
);

async function run() {
  const text = goal.value.trim();
  if (!text || busy.value) return;
  error.value = "";
  try {
    const started = await startAgentRun(text);
    if (started === false) throw new Error(t("agent.errNoAI"));
    goal.value = "";
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

async function answer() {
  const text = answerDraft.value.trim();
  if (!text) return;
  answerDraft.value = "";
  await answerPending(text);
}

function approve(ok) {
  resolvePending(ok);
}

function toggleCard(id) {
  const next = new Set(openCards.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openCards.value = next;
}

const copied = ref("");
const notice = ref("");
async function copyRun(run) {
  const text = [run.goal, run.answer].filter(Boolean).join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    copied.value = t("agent.copy");
    setTimeout(() => (copied.value = ""), 2000);
  } catch {
    error.value = t("agent.copyFail");
  }
}

/**
 * 沉淀为技能。
 * ⚠️ promoteRunToSkill 用**返回值**表达拒绝（{ ok:false, reason }），不抛异常——
 * 不检查返回值就会「点了没反应」（踩过一次）。reason 交给 UI 映射文案，UI 不猜引擎为什么拒绝。
 */
async function promote(runId) {
  error.value = "";
  notice.value = "";
  try {
    const result = await promoteRunToSkill(runId);
    if (result?.ok) {
      notice.value = t("agent.skillSaved", { name: result.skill?.name || "" });
      return;
    }
    notice.value = t(`mobile.skillReason.${result?.reason || "unknown"}`, { defaultValue: t("agent.skillNotSkillable") });
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

const runStatusKey = (status) =>
  ({ completed: "agent.stepFinal", failed: "agent.statusFailed", cancelled: "agent.statusCancelled", max_steps: "agent.statusMaxSteps" })[status] || "";

/** 工具风险等级：手机上直接写出来，别让人去猜"这个要不要确认"。 */
const riskOf = (name) => toolMeta.value.get(name)?.risk || "";
</script>

<template>
  <section class="m-agent" :data-status="agentSession.status">
    <div class="m-chips">
      <button class="m-chip" :class="{ on: tab === 'run' }" data-tab="run" @click="tab = 'run'">{{ t("agent.run") }}</button>
      <button class="m-chip" :class="{ on: tab === 'history' }" data-tab="history" @click="tab = 'history'">{{ t("agent.history") }}</button>
      <button class="m-chip" :class="{ on: tab === 'skills' }" data-tab="skills" @click="tab = 'skills'">{{ t("agent.capSkills") }}</button>
    </div>

    <!-- 运行 -->
    <template v-if="tab === 'run'">
      <label class="m-field">
        <span>{{ t("mobile.agentGoal") }}</span>
        <textarea v-model="goal" rows="3" :placeholder="t('agent.goalPh')" data-role="goal"></textarea>
      </label>
      <div class="m-actions">
        <button class="m-btn primary" :disabled="busy || !goal.trim()" data-role="start" @click="run">
          {{ busy ? t("agent.running") : t("agent.run") }}
        </button>
        <button v-if="busy" class="m-btn danger" data-role="stop" @click="stopAgentRun()">{{ t("agent.stop") }}</button>
        <button v-if="!busy && agentSession.steps.length" class="m-btn" data-role="clear" @click="clearTimeline()">{{ t("agent.clear") }}</button>
      </div>

      <p v-if="error" class="m-err" data-role="error">{{ error }}</p>

      <!-- 还没配 AI：直接把入口给出来，而不是让人对着输入框发呆 -->
      <p v-if="agentSession.ready && !agentSession.aiReady" class="m-hint-sm" data-role="no-ai">
        {{ t("agent.errNoAI") }} · {{ t("agent.configureAI") }}
      </p>

      <!-- 确认卡：工具调用 / 模型提问 -->
      <div v-if="pending" class="m-card m-confirm" data-role="pending">
        <b data-role="pending-title">{{ pending.kind === "tool" ? t("agent.confirmTitle") : pending.question }}</b>

        <template v-if="pending.kind === 'ask'">
          <p class="m-hint-sm">{{ t("agent.answerHint") }}</p>
          <textarea v-model="answerDraft" rows="3" data-role="answer"></textarea>
          <div class="m-actions">
            <button class="m-btn" data-role="answer-skip" @click="answerPending('')">{{ t("agent.answerSkip") }}</button>
            <button class="m-btn primary" :disabled="!answerDraft.trim()" data-role="answer-send" @click="answer">{{ t("agent.answerSend") }}</button>
          </div>
        </template>

        <template v-else>
          <p class="m-hint-sm"><code data-role="pending-tool">{{ pending.tool }}</code> · {{ riskOf(pending.tool) }}</p>
          <pre v-if="pending.args" class="m-args" data-role="pending-args">{{ payloadText(pending.args) }}</pre>
          <p class="m-hint-sm">{{ t("agent.confirmArgsHint") }}</p>
          <div class="m-actions">
            <button class="m-btn danger" data-role="deny" @click="approve(false)">{{ t("agent.confirmDeny") }}</button>
            <button class="m-btn primary" data-role="allow" @click="approve(true)">{{ t("agent.confirmAllow") }}</button>
          </div>
        </template>
      </div>

      <!-- 时间线 -->
      <p v-if="!timeline.length" class="m-hint-sm" data-role="empty-timeline">{{ t("agent.emptyTimeline") }}</p>
      <ul v-else class="m-timeline" data-role="timeline">
        <li v-for="(item, index) in timeline" :key="item.id || 'k' + index" :data-kind="item.kind" class="m-tl-row">
          <template v-if="item.kind === 'tool'">
            <button class="m-tl-head" @click="toggleCard(item.id)">
              <b>{{ item.tool }}</b>
              <span class="m-zone">{{ item.attempts.length > 1 ? t("agent.retryAttempt", { n: item.attempts.length }) : "" }}</span>
            </button>
            <p v-if="!item.collapsed" class="m-tl-body" data-role="tool-result">
              <span v-if="item.attempts.at(-1)?.status === 'running'">{{ t("agent.running") }}</span>
              <span v-else-if="item.attempts.at(-1)?.error" class="m-tl-err">{{ item.attempts.at(-1).error }}</span>
              <span v-else>{{ payloadText(item.attempts.at(-1)?.result) }}</span>
            </p>
            <button v-else class="m-tl-more" @click="toggleCard(item.id)">{{ t("agent.showResult") }}</button>
          </template>

          <template v-else-if="item.kind === 'approval'">
            <span class="m-tl-note" data-role="approval">
              {{ item.approved === true ? t("agent.approvalAllowed") : item.approved === false ? t("agent.approvalDenied") : t("agent.approvalPending") }}
            </span>
          </template>

          <template v-else-if="item.kind === 'confirm'">
            <span class="m-tl-note" data-role="confirm-row">
              {{ item.answer ? t("agent.answered", { text: item.answer }) : t("agent.answerSkip") }}
            </span>
          </template>

          <template v-else>
            <span class="m-tl-note" :class="{ 'm-tl-err': item.tone === 'danger' }">{{ item.text }}</span>
          </template>
        </li>
      </ul>

      <p v-if="agentSession.error" class="m-err" data-role="run-error">{{ agentSession.error }}</p>
    </template>

    <!-- 历史 -->
    <template v-else-if="tab === 'history'">
      <p v-if="!runs.length" class="m-hint-sm" data-role="history-empty">{{ t("agent.historyEmpty") }}</p>
      <ul v-else class="m-list">
        <li v-for="run in runs" :key="run.id" class="m-item" :data-run="run.id">
          <div class="m-item-main">
            <!-- 字段名沿用运行时的记录结构：目标在 input，回答在 answer（桌面端也是这么读的） -->
            <span class="m-item-title" data-role="run-input">{{ run.input || run.goal }}</span>
            <span class="m-item-sub">
              {{ runStatusKey(run.runStatus) }}
              <template v-if="run.answer"> · {{ t("agent.answered", { text: String(run.answer).slice(0, 30) }) }}</template>
            </span>
          </div>
          <div class="m-item-ops">
            <button class="m-op" data-role="resume" @click="resumeAgentRun(run)">{{ t("agent.resume") }}</button>
            <button class="m-op" data-role="promote" @click="promote(run.id)">{{ t("agent.skillPromote") }}</button>
            <button class="m-op" @click="copyRun(run)">{{ t("agent.copyRun") }}</button>
            <button class="m-op danger" @click="discardRun(run.id)">{{ t("agent.deleteRun") }}</button>
          </div>
        </li>
      </ul>
    </template>

    <!-- 技能库 -->
    <template v-else>
      <p class="m-hint-sm">{{ t("agent.capSkillsDesc") }}</p>
      <p v-if="notice" class="m-ok" data-role="skills-notice">{{ notice }}</p>
      <p v-if="!skills.length" class="m-hint-sm" data-role="skills-empty">{{ t("agent.skillEmpty") }}</p>
      <ul v-else class="m-list" data-role="skills">
        <li v-for="skill in skills" :key="skill.id" class="m-item" :data-skill="skill.id">
          <div class="m-item-main">
            <span class="m-item-title">{{ skill.name }}</span>
            <span class="m-item-sub">{{ skill.description || t("agent.skillNoDesc") }}</span>
          </div>
          <div class="m-item-ops">
            <button class="m-op" :class="{ on: skill.enabled !== false }" data-role="skill-toggle" @click="setSkillEnabled(skill.id, skill.enabled === false)">
              {{ skill.enabled === false ? t("mobile.skillOff") : t("mobile.skillOn") }}
            </button>
            <button class="m-op danger" data-role="skill-delete" @click="deleteSkill(skill.id)">{{ t("agent.skillDelete") }}</button>
          </div>
        </li>
      </ul>
    </template>

    <p v-if="copied" class="m-ok">{{ copied }}</p>
    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
  </section>
</template>
