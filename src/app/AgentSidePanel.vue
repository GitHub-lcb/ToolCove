<script setup>
// 侧边栏会话区（三期导航重构）：新任务入口 + 历史搜索 + 按时间分组的会话列表，
// 以及跨模块的后台任务监控条。
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
//
// 三期相对二期改了什么（对标 Qoder 桌面端 / VS Code Chat view 的信息架构）：
//   1. 「新任务」不再是渐变主按钮——它是导航行，不是 CTA。渐变 CTA 会和主区的
//      「运行」按钮抢视觉权重，且「在 agent 主区」时它还常亮，读起来像「新任务被选中」。
//   2. 历史加搜索与按时间分组（进行中 / 今天 / 昨天 / 最近 7 天 / 更早）。二期是一条
//      无差别的倒序长列表，20 条原始目标平铺，找不回任何一条。
//   3. 行内显示**主题**而不是原始目标（conversationTitle 压空白 + 断句处截断）。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../ui/Icon.vue";
import RunProgress from "../views/RunProgress.vue";
import { relativeTime } from "../shared/dates.js";
import { buildTaskItems, filterTaskItems, groupTaskItems } from "./taskListItems.js";
import { agentSession } from "../agent/session.js";

const props = defineProps({
  activeModule: { type: String, default: "agent" },
  // 正在回看的历史 run id（仅用于行高亮；回看状态本体在 AgentView 里）
  viewingRunId: { type: String, default: "" },
  collapsed: { type: Boolean, default: false },
});
const emit = defineEmits(["new", "view", "open"]);

const { t } = useI18n();

const query = ref("");
const searching = computed(() => query.value.trim().length > 0);

// 会话行是 runs 的纯投影（最新在前）；运行中 unshift/更新都会即时反映
const items = computed(() => buildTaskItems(agentSession.runs));
const filtered = computed(() => filterTaskItems(items.value, query.value));
const groups = computed(() => groupTaskItems(items.value));
// 渲染分段：搜索时**不分组**——搜索是「找回某一条」，少量命中被拆到多个时间标题下反而更难扫。
// 用空 key 表示「这一段不渲染标题」，这样模板里的行标记只写一遍。
const sections = computed(() => (searching.value ? [{ key: "", items: filtered.value }] : groups.value));

const GROUP_LABEL = {
  running: "nav.groupRunning",
  today: "nav.groupToday",
  yesterday: "nav.groupYesterday",
  week: "nav.groupWeek",
  older: "nav.groupOlder",
};

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
  <!-- 主入口：新任务（回 agent 主区并开一条新时间线）。
       刻意做成与「工作面」按钮同一观感的导航行，而不是渐变主按钮——
       它是"去哪里"，不是"现在执行"；执行按钮只有主区那一个。 -->
  <button
    class="nav-item new-chat"
    :class="{ on: activeModule === 'agent' && !viewingRunId, 'hide-text': collapsed }"
    :title="t('nav.newTask')"
    @click="emit('new')"
  >
    <span class="nav-ico"><Icon name="plus" :size="17" /></span>
    <span class="nav-label">{{ t("nav.newTask") }}</span>
  </button>

  <!-- 「工作面」插槽：模块导航由 App.vue 渲染（它独占 navConfig / hiddenModules 这份真相源），
       但要夹在「新任务」与会话列表之间——见下方 .history 的注释。 -->
  <slot name="workspace" />

  <!-- 历史搜索：只在有历史时出现（没有历史时搜索框是纯噪声） -->
  <div v-if="!collapsed && items.length" class="search">
    <Icon name="search" :size="13" class="search-ico" />
    <input
      v-model="query"
      class="search-input"
      type="search"
      :placeholder="t('nav.searchHistoryPh')"
      :aria-label="t('nav.searchHistoryPh')"
    />
    <button v-if="searching" class="search-x" :title="t('nav.searchClear')" :aria-label="t('nav.searchClear')" @click="query = ''">
      <Icon name="x" :size="12" />
    </button>
  </div>

  <!-- 会话列表：**侧边栏里唯一滚动的东西**。
       为什么必须单独成层（用户实测反馈）：整条侧边栏共用一个滚动容器时，历史一长，
       「新任务」与搜索框会被滚出视野、工作面被挤到底部——三个固定入口都变成
       「取决于你滚到哪」。现在固定区（品牌 / 新任务 / 工作面 / 搜索 / 底部按钮）
       一律不参与滚动，这里吃掉剩余高度并自己滚。
       负 margin + 同值 padding：把滚动区撑到 .nav 的 padding 边上，
       滚动条才贴着侧边栏边缘，而行内容仍与上面的按钮左对齐。 -->
  <div class="history">
    <p v-if="!items.length && !collapsed" class="list-empty">{{ t("agent.historyEmpty") }}</p>
    <p v-else-if="searching && !filtered.length && !collapsed" class="list-empty">{{ t("nav.searchEmpty") }}</p>

    <!-- 搜索态只有一个匿名分段：key 用固定字面量而不是 query，否则每敲一个字都重建整个列表 DOM -->
    <template v-for="section in sections" :key="section.key || 'search'">
      <p v-if="section.key && !collapsed" class="list-group">{{ t(GROUP_LABEL[section.key]) }}</p>
      <button
        v-for="item in section.items"
        :key="item.id"
        class="task-item"
        :class="{ on: activeModule === 'agent' && viewingRunId === item.id, 'hide-text': collapsed }"
        :title="item.input"
        @click="emit('view', item.id)"
      >
        <span class="task-dot" :class="dotClass(item)"></span>
        <span class="task-main">
          <span class="task-text">{{ item.title }}</span>
          <span class="task-time">{{ relativeTime(item.updatedAt) }}</span>
        </span>
      </button>
    </template>
  </div>

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
/* 新任务行：与 App.vue 的 .nav-item 同骨架（那边是 scoped，拿不到它的声明，只能自带一份等效样式）。
   刻意保持「扁平导航行」而不是渐变主按钮：它是"去哪里"，不是"现在执行"——
   执行按钮只有主区那一个，两处都做 CTA 会互相抢视觉权重。 */
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-shrink: 0;
  border: 1px solid transparent;
  background: none;
  padding: 9px var(--sp-3);
  border-radius: var(--r-sm);
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-weak);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.nav-ico { display: grid; place-items: center; flex-shrink: 0; width: 22px; color: var(--text-weak); }
.nav-item:hover { color: var(--primary-hover); background: var(--card); border-color: var(--card-border); }
.nav-item:hover .nav-ico { color: var(--primary-hover); }
.nav-item:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.nav-item.on { background: var(--grad-selected); border-color: var(--border-blue); color: var(--primary-hover); }
.nav-item.on .nav-ico { color: var(--primary-hover); }
/* 选中指示条与 App.vue 原生 nav-item 同一形态 */
.nav-item.on::before {
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

/* 搜索框：与导航行同宽，视觉上更弱（它是筛选器，不是入口） */
.search { position: relative; display: flex; align-items: center; flex-shrink: 0; }
.search-ico { position: absolute; left: 10px; color: var(--faint); pointer-events: none; }
.search-input {
  width: 100%;
  padding: 7px 26px 7px 28px;
  font-family: inherit;
  font-size: var(--fs-sm);
  color: var(--text);
  background: var(--card-soft);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  transition: border-color 0.15s, background 0.15s;
}
.search-input::placeholder { color: var(--faint); }
.search-input:focus { outline: none; border-color: var(--primary); background: var(--card); }
/* 原生 search 的清除按钮与自绘的重复，去掉原生那个 */
.search-input::-webkit-search-cancel-button { display: none; }
.search-x {
  position: absolute;
  right: 6px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  color: var(--muted);
  background: none;
  border: none;
  border-radius: var(--r-xs);
  cursor: pointer;
}
.search-x:hover { color: var(--primary); background: var(--primary-soft); }

/* 会话列表：侧边栏唯一的滚动区（见模板里的说明）。
   min-height:0 解除 flex 子项「不收缩」的默认行为，否则内容会把容器撑高、滚动失效。
   负 margin + 同值 padding 用与 .nav 相同的 --sp-5：滚动条贴侧边栏边缘，行内容仍左对齐。 */
.history {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
  overflow-x: hidden;
  margin: 0 calc(var(--sp-5) * -1);
  padding: 0 var(--sp-5);
  scrollbar-width: thin;
  scrollbar-color: var(--border-steel) transparent;
}

/* 分组标题：会话列表与工作面之间的层级锚点。与 App.vue 的 .nav-group 同量级，
   但间距更小——它是列表内的分隔，不是两个功能区之间的大断点。 */
.list-group {
  flex-shrink: 0;
  margin: var(--sp-3) 0 2px;
  padding: 0 var(--sp-3);
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--faint);
}
.list-empty { flex-shrink: 0; margin: 0; padding: 2px var(--sp-3) 6px; font-size: var(--fs-xs); color: var(--faint); line-height: var(--lh-body); }

/* 会话行：状态点 + 主题 + 相对时间 */
.task-item {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  width: 100%;
  flex-shrink: 0;
  padding: 7px var(--sp-3);
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
.task-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
/* 标题已由 conversationTitle 压过空白并限长，这里再兜一道单行截断，
   免得超长 CJK 主题把行撑成两行、列表失去节奏 */
.task-text {
  font-size: var(--fs-sm);
  color: var(--text);
  line-height: var(--lh-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-time { font-size: var(--fs-xs); color: var(--faint); }

/* 收起态：只留状态点与新任务图标（与 App.vue 收起态隐藏 .nav-label 同一策略） */
.nav-item.hide-text { justify-content: center; padding-left: 0; padding-right: 0; }
.nav-item.hide-text .nav-label { display: none; }
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
