<script setup>
// 手机端壳层（Phase 2）：底部标签栏 + 当前页。
//
// 与桌面端的差异是**有意的**：桌面有 Tauri 多窗口 + 自由布局；手机没有多窗口，
// 所以采用「底部标签 + 当前页全屏」的标准安卓结构，并且让标签栏与系统返回键配合
// （返回键先关弹层/退分段，到栈底才交回系统）。
//
// Phase 2 只接入「记录」；工作台 / 工具箱 / Agent / 设置按后续 Phase 逐个替换占位页。
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import RecordsView from "./RecordsView.vue";
import WorkView from "./WorkView.vue";
import ToolboxView from "./ToolboxView.vue";
import SettingsView from "./SettingsView.vue";
import AgentView from "./AgentView.vue";

const props = defineProps({
  capabilities: { type: Object, required: true },
  isMobile: { type: Boolean, default: false },
  isDesktop: { type: Boolean, default: false },
  isBrowser: { type: Boolean, default: false },
});

const { t } = useI18n();

/** 标签定义：key 与桌面端导航同名（nav.*），方便后续把同一模块的桌面视图移动端化。 */
const TABS = [
  { key: "records", labelKey: "nav.records", icon: "☰", ready: true },
  { key: "work", labelKey: "nav.work", icon: "▤", ready: true },
  { key: "toolbox", labelKey: "nav.toolbox", icon: "⚒", ready: true },
  { key: "agent", labelKey: "nav.agent", icon: "✦", ready: true },
  { key: "settings", labelKey: "nav.settings", icon: "⚙", ready: true },
];

const tab = ref("records");
const current = computed(() => TABS.find((x) => x.key === tab.value) || TABS[0]);

/**
 * 各页暴露的"返回上一层"能力（见下面的系统返回键处理）。
 * 页内层级（工作台的概览→迭代→需求→子任务、工具箱的工具页）都靠它回退，
 * 否则安卓返回键会直接退出应用——那是用户最容易骂人的一种行为。
 */
const workRef = ref(null);
const toolboxRef = ref(null);

/** 当前页能回退吗？返回 true 表示已消费这次返回。 */
function backWithinPage() {
  const page = current.value.key;
  if (page === "work") return workRef.value?.goBack?.() === true;
  if (page === "toolbox") return toolboxRef.value?.goBack?.() === true;
  return false;
}

/**
 * 系统返回键：WebView 把它变成 history.back()（见 MainActivity 的 onBackPressed），
 * 所以这里用 popstate 接住。策略是"页面内先回退，到栈底才真正退出"：
 * 每次进入可回退的状态就往历史里压一条哨兵，回退时消费掉它。
 */
function pushSentinel() {
  history.pushState({ tc: "layer" }, "");
}

function onPopState() {
  if (backWithinPage()) {
    // 页内还有层级：把哨兵补回去，保证下一次返回仍能被我们接住
    pushSentinel();
    return;
  }
  if (tab.value !== "records") {
    // 不在第一个标签：退回记录页（安卓上"返回"回主标签是符合直觉的）
    tab.value = "records";
    pushSentinel();
    return;
  }
  // 到栈底：不再补哨兵，下一次返回交给系统退出应用
}

onMounted(() => {
  // 压一条初始哨兵：否则第一次按返回会直接离开应用，页内层级根本没机会回退
  pushSentinel();
  window.addEventListener("popstate", onPopState);
});
onUnmounted(() => window.removeEventListener("popstate", onPopState));

const platform = computed(() => {
  if (props.isMobile) return "mobile";
  if (props.isDesktop) return "desktop";
  return "browser";
});
</script>

<template>
  <div class="m-app" :data-platform="platform">
    <main class="m-page">
      <RecordsView v-if="current.key === 'records'" />
      <WorkView v-else-if="current.key === 'work'" ref="workRef" />
      <ToolboxView v-else-if="current.key === 'toolbox'" ref="toolboxRef" />
      <AgentView v-else-if="current.key === 'agent'" />
      <SettingsView v-else-if="current.key === 'settings'" />
    </main>

    <nav class="m-tabbar" role="tablist">
      <button
        v-for="item in TABS"
        :key="item.key"
        class="m-tab"
        role="tab"
        :data-tab="item.key"
        :aria-selected="tab === item.key"
        :class="{ on: tab === item.key, todo: !item.ready }"
        @click="tab = item.key"
      >
        <span class="m-tab-ico" aria-hidden="true">{{ item.icon }}</span>
        <span class="m-tab-label">{{ t(item.labelKey) }}</span>
      </button>
    </nav>
  </div>
</template>
