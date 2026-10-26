<script setup>
// 运行进度条：把当前这次 Agent 运行的状态压缩成一行，回答"它现在在干嘛、走到哪了"。
//
// 为什么要单独一个组件（而不是继续堆在 AgentView 的模板里）：
//   AgentView 已经 1024 行，而这块的信息来源是**纯派生的**——步数、状态、当前工具，
//   全都是 agentSession 上已有的字段。抽出来之后它有独立的单测（runProgress.test.js），
//   将来 C 端（手机端 Agent 页）也能直接复用同一份判定，不必各写一套"进度怎么算"。
//
// 设计参考 Qoder 的会话底部 todo：空心圆 → 转圈 → 勾选，三态一眼可读。
// 这里做成横向的步进条，因为本产品的运行是**线性**的（一次一步），不是并行任务列表。
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../ui/Icon.vue";

const props = defineProps({
  /** 已完成/正在进行的步骤事件（agentSession.steps） */
  steps: { type: Array, default: () => [] },
  /** 运行状态："" | running | waiting | completed | failed | cancelled | max_steps */
  status: { type: String, default: "" },
  /** 当前正在执行的工具名（有值即表示卡在这一步） */
  currentTool: { type: String, default: "" },
  /** 步数上限，用来画"还能走多远" */
  maxSteps: { type: Number, default: 0 },
  /** token 用量文案（如 "1.2k"），空则不显示 */
  tokens: { type: String, default: "" },
});

const { t } = useI18n();

// 状态 → 语义五态。刻意与设计令牌的 --run/--wait/--done/--fail/--idle 一一对应，
// 于是"运行中"在 Agent 页、任务页、发布页是同一个颜色（跨页面一致的色彩语言）。
const TONE = {
  running: { tone: "run", key: "agent.statusRunning", icon: "" },
  waiting: { tone: "wait", key: "agent.statusWaiting", icon: "alert" },
  completed: { tone: "done", key: "agent.statusSuccess", icon: "check" },
  failed: { tone: "fail", key: "agent.statusFailed", icon: "alert" },
  cancelled: { tone: "idle", key: "agent.statusCancelled", icon: "x" },
  max_steps: { tone: "wait", key: "agent.statusMaxSteps", icon: "alert" },
};
const EMPTY = { tone: "idle", key: "agent.statusIdle", icon: "" };

const meta = computed(() => TONE[props.status] || EMPTY);

/** 工具调用步数：只数 tool_start，重试不重复计数（重试是同一张卡） */
const toolSteps = computed(() => props.steps.filter((s) => s && s.type === "tool_start").length);

/** 失败步数：让"走完了但有两步失败"和"一路顺利"在界面上能分开 */
const failedSteps = computed(() => props.steps.filter((s) => s && s.type === "tool_error").length);

const progress = computed(() => {
  if (!props.maxSteps) return 0;
  return Math.min(100, Math.round((toolSteps.value / props.maxSteps) * 100));
});
</script>

<template>
  <!-- 状态行会自己变（运行中 → 等待 → 完成），读屏要能"发生后才知道"：role=status 播报变化，
       播报内容就是可见文字本身，不需要为它另写一份文案 -->
  <div class="rp" :class="'rp--' + meta.tone" role="status" aria-live="polite">
    <span class="rp-state">
      <span class="tc-dot" :class="'tc-dot--' + meta.tone"></span>
      <b>{{ t(meta.key) }}</b>
    </span>

    <!-- 当前步骤：有具体工具名就报出来，这比"运行中…"有用得多 -->
    <span v-if="currentTool && (status === 'running' || status === 'waiting')" class="rp-now">
      <Icon name="zap" :size="12" />
      <code>{{ currentTool }}</code>
    </span>

    <span class="rp-steps">{{ t("agent.stepsCount", { n: toolSteps }) }}</span>

    <!-- 失败计数只在真有失败时出现 -->
    <span v-if="failedSteps" class="rp-fail">
      <Icon name="alert" :size="11" />{{ failedSteps }}
    </span>

    <span v-if="tokens" class="rp-tokens">{{ t("agent.tokensCount", { n: tokens }) }}</span>

    <!-- 步数上限用一条细进度条表达：到达上限会自动收尾，用户需要提前有预期 -->
    <span
      v-if="maxSteps"
      class="rp-track"
      role="progressbar"
      aria-valuemin="0"
      :aria-valuenow="toolSteps"
      :aria-valuemax="maxSteps"
      :title="t('agent.stepsCount', { n: toolSteps }) + ' / ' + maxSteps"
    >
      <span class="rp-fill" :style="{ width: progress + '%' }"></span>
    </span>
  </div>
</template>

<style scoped>
.rp {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  padding: var(--sp-2) var(--sp-4);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  background: var(--card-soft);
  font-size: var(--fs-sm);
  color: var(--text-soft);
}
.rp-state { display: inline-flex; align-items: center; gap: var(--sp-2); }
.rp-state b { font-weight: 700; }
.rp--run .rp-state b { color: var(--run-deep); }
.rp--wait .rp-state b { color: var(--wait-deep); }
.rp--done .rp-state b { color: var(--done-deep); }
.rp--fail .rp-state b { color: var(--fail-deep); }

.rp-now { display: inline-flex; align-items: center; gap: var(--sp-05); color: var(--text); }
.rp-now code {
  padding: 1px var(--sp-1);
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: var(--r-xs);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
.rp-steps { font-variant-numeric: tabular-nums; }
.rp-fail { display: inline-flex; align-items: center; gap: 3px; color: var(--fail-deep); font-weight: 600; }
.rp-tokens { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--muted); }

.rp-track {
  flex-basis: 100%;
  height: 3px;
  overflow: hidden;
  background: var(--well);
  border-radius: var(--r-pill);
}
.rp-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-pill);
  background: var(--run);
  transition: width var(--dur-slow) var(--ease-out);
}
.rp--done .rp-fill { background: var(--done); }
.rp--fail .rp-fill { background: var(--fail); }
.rp--wait .rp-fill { background: var(--wait); }
</style>
