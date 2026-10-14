<script setup>
// 二期导航重构：侧边栏主体（新任务 + 任务列表）与后台任务监控条。
//
// 为什么这两块收进一个异步组件、而不是直接写进 App.vue：
// 它们都要读 agentSession 这个模块级单例，而 App.vue 是全静态依赖——
// 在外壳里 import agent/session.js 会把整个 agent 引擎（runtime/tools/catalog）
// 拖进首屏 entry chunk。异步组件让引擎留在自己的 chunk 里按需加载（与
// App.vue 对所有模块视图 defineAsyncComponent 的既有惯例一致）。
//
// 监控条为什么必须挂在应用外壳层（而不是 AgentView 里）：
// 运行是模块级单例，「切去工作面查数据、任务在后台继续跑」正是产品心智——
// 只有跨模块都活着的外壳能让它可见。
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../ui/Icon.vue";
import RunProgress from "../views/RunProgress.vue";
import { relativeTime } from "../shared/dates.js";
import { buildTaskItems } from "./taskListItems.js";
import { agentSession } from "../agent/session.js";

const props = defineProps({
  activeModule: { type: String, default: "agent" },
  // 正在回看的历史 run id（仅用于行高亮；回看状态本体在 AgentView 里）
  viewingRunId: { type: String, default: "" },
  collapsed: { type: Boolean, default: false },
});
const emit = defineEmits(["new", "view", "open"]);

const { t } = useI18n();

// 任务列表是 runs 的纯投影（最新在前）；运行中 unshift/更新都会即时反映
const taskItems = computed(() => buildTaskItems(agentSession.runs));

// 状态点只取颜色语义，与 AgentView 的 RUN_STATUS 一致：
// 进行中脉冲、成功绿、失败红、取消/达上限灰。行太窄放不下状态词，点来扛语义。
const DOT_CLASS = {
  pending: "run",
  running: "run",
  success: "ok",
  completed: "ok",
  failed: "fail",
  cancelled: "mute",
  max_steps: "mute",
};
const dotClass = (item) => "dot-" + (DOT_CLASS[item.status] || "mute");

// ------- 后台任务监控条 -------
// agent 正在跑且用户不在 agent 主区时出现；点击整条回 agent（停止按钮不放这里——
// 误触代价是杀掉一次运行，要停请回主区点停止）。
const monitorVisible = computed(() => agentSession.status !== "idle" && props.activeModule !== "agent");
const monitorStatus = computed(() => agentSession.runStatus || agentSession.status || "");
// 与 AgentView 同一派生：最后一个还没收到结果的 tool_start 就是「正在跑的那一步」
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
const maxSteps = computed(() => Number(agentSession.cfg?.maxSteps) || 0);
</script>

<template>
  <!-- 主按钮：新任务（回 agent 主区并开一条新时间线） -->
  <button
    class="nav-item nav-new"
    :class="{ on: activeModule === 'agent' && !viewingRunId, 'hide-text': collapsed }"
    :title="t('nav.newTask')"
    @click="emit('new')"
  >
    <span class="nav-ico"><Icon name="plus" :size="17" /></span>
    <span class="nav-label">{{ t("nav.newTask") }}</span>
  </button>

  <!-- 任务列表：agent 的历史即主区入口，一行 = 一次运行 -->
  <p v-if="!taskItems.length && !collapsed" class="task-empty">{{ t("agent.historyEmpty") }}</p>
  <button
    v-for="item in taskItems"
    :key="item.id"
    class="task-item"
    :class="{ on: activeModule === 'agent' && viewingRunId === item.id, 'hide-text': collapsed }"
    :title="item.input"
    @click="emit('view', item.id)"
  >
    <span class="task-dot" :class="dotClass(item)"></span>
    <span class="task-main">
      <span class="task-text">{{ item.input }}</span>
      <span class="task-time">{{ relativeTime(item.updatedAt) }}</span>
    </span>
  </button>

  <!-- 后台任务监控条：position:fixed，与在 DOM 里的位置无关，放这里随面板同生命周期 -->
  <div
    v-if="monitorVisible"
    class="agent-monitor"
    role="button"
    tabindex="0"
    :title="t('nav.agent')"
    @click="emit('open')"
    @keydown.enter="emit('open')"
  >
    <RunProgress :steps="agentSession.steps" :status="monitorStatus" :current-tool="currentTool" :max-steps="maxSteps" />
  </div>
</template>

<style scoped>
/* 新任务主按钮：复用 .nav-item 骨架（全局 primitives 之外的类在 App.vue 是 scoped，
   这里需要自带一份等效样式，保持与「工作面」按钮同一观感） */
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  border: 1px solid var(--card-border);
  background: var(--card);
  padding: 11px var(--sp-4);
  border-radius: var(--r-md);
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-weak);
  cursor: pointer;
  white-space: nowrap;
  box-shadow: 0 1px 2px rgba(35, 43, 66, 0.04), 0 6px 16px rgba(35, 43, 66, 0.05);
  transition: background 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s, border-color 0.15s;
}
.nav-ico { display: grid; place-items: center; flex-shrink: 0; width: 24px; color: inherit; }
.nav-item:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.nav-new { background: var(--grad-brand); border-color: transparent; color: var(--text-invert); box-shadow: var(--glow-md); }
.nav-new:hover { color: var(--text-invert); transform: translateY(-1px); filter: brightness(1.05); }
.nav-new.on { box-shadow: var(--glow-md), 0 0 0 2px var(--border-blue) inset; }
/* 选中指示条与 App.vue 原生 nav-item 同一形态 */
.nav-new.on::before {
  content: "";
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 22px;
  border-radius: 0 4px 4px 0;
  background: var(--primary);
}

/* 任务行：状态点 + 两行截断的目标 + 相对时间 */
.task-empty { margin: 0; padding: 2px var(--sp-2) 6px; font-size: var(--fs-xs); color: var(--faint); line-height: var(--lh-body); }
.task-item {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  width: 100%;
  padding: 8px var(--sp-3);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, border-color 0.15s;
}
.task-item:hover { background: var(--card); border-color: var(--card-border); }
.task-item:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.task-item.on { background: var(--grad-selected); border-color: var(--border-blue); }
.task-dot { flex-shrink: 0; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--faint); }
.task-dot.dot-ok { background: var(--success); }
.task-dot.dot-fail { background: var(--danger); }
.task-dot.dot-mute { background: var(--faint); }
/* 进行中脉冲：与 AgentView 的 .run-live / .working .dot 同一节奏，跨界面一致 */
.task-dot.dot-run { background: var(--primary); animation: taskPulse 1.1s ease-in-out infinite; }
@keyframes taskPulse { 0%, 100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }
.task-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.task-text {
  font-size: var(--fs-sm);
  color: var(--text);
  line-height: var(--lh-tight);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.task-time { font-size: var(--fs-xs); color: var(--faint); }

/* 收起态：只留状态点与新任务图标（与 App.vue 收起态隐藏 .nav-label 同一策略） */
.nav-new.hide-text { justify-content: center; padding-left: 0; padding-right: 0; }
.nav-new.hide-text .nav-label { display: none; }
.task-item.hide-text { justify-content: center; padding-left: 0; padding-right: 0; }
.task-item.hide-text .task-main { display: none; }
.task-item.hide-text .task-dot { margin-top: 0; }

/* 后台任务监控条：主区右下角悬浮卡片，点击整条回 agent 主区 */
.agent-monitor {
  position: fixed;
  right: 22px;
  bottom: 20px;
  z-index: 120;
  width: min(400px, calc(100vw - 60px));
  cursor: pointer;
  border-radius: var(--r-md);
  box-shadow: 0 12px 32px rgba(16, 24, 40, 0.18);
  transition: transform 0.15s, box-shadow 0.15s;
}
.agent-monitor:hover { transform: translateY(-2px); box-shadow: 0 16px 40px rgba(16, 24, 40, 0.22); }
.agent-monitor :deep(.rp) { background: var(--card); border-color: var(--card-border); padding: var(--sp-3) var(--sp-4); }
</style>
