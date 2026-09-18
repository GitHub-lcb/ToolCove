<script setup>
// 手机端壳层（Phase 2）：底部标签栏 + 当前页。
//
// 与桌面端的差异是**有意的**：桌面有 Tauri 多窗口 + 自由布局；手机没有多窗口，
// 所以采用「底部标签 + 当前页全屏」的标准安卓结构，并且让标签栏与系统返回键配合
// （返回键先关弹层/退分段，到栈底才交回系统）。
//
// Phase 2 只接入「记录」；工作台 / 工具箱 / Agent / 设置按后续 Phase 逐个替换占位页。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import RecordsView from "./RecordsView.vue";

const props = defineProps({
  bridged: { type: Boolean, default: false },
  native: { type: Boolean, default: false },
  capabilities: { type: Object, required: true },
  isMobile: { type: Boolean, default: false },
  isDesktop: { type: Boolean, default: false },
  isBrowser: { type: Boolean, default: false },
});

const { t } = useI18n();

/** 标签定义：key 与桌面端导航同名（nav.*），方便后续把同一模块的桌面视图移动端化。 */
const TABS = [
  { key: "records", labelKey: "nav.records", icon: "☰", ready: true },
  { key: "work", labelKey: "nav.work", icon: "▤", ready: false },
  { key: "toolbox", labelKey: "nav.toolbox", icon: "⚒", ready: false },
  { key: "agent", labelKey: "nav.agent", icon: "✦", ready: false },
  { key: "settings", labelKey: "nav.settings", icon: "⚙", ready: false },
];

const tab = ref("records");
const current = computed(() => TABS.find((x) => x.key === tab.value) || TABS[0]);

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

      <!-- 其余标签先给占位：如实说明「还没做」，而不是画一个点不动的界面 -->
      <section v-else class="m-todo" :data-tab="current.key">
        <h2 class="m-todo-title">{{ t(current.labelKey) }}</h2>
        <p class="m-todo-body">{{ t("mobile.tabTodo") }}</p>
        <ul class="m-status">
          <li class="m-bridge" :data-on="bridged">{{ bridged ? t("mobile.bridgeOn") : t("mobile.bridgeOff") }}</li>
        </ul>
      </section>
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
