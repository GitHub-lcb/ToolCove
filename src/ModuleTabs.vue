<script setup>
// 模块 Tab 外壳：只负责 Tab 栏与内层视图挂载，不改各视图内部（视图之间零耦合）。
// 切换 Tab 用 :key 重挂载内层组件，与既有的「切模块即重载」行为一致。
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";

const props = defineProps({
  // [{ key, labelKey, icon, comp }]
  tabs: { type: Array, required: true },
  active: { type: String, required: true },
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});
const emit = defineEmits(["update:active", "navigate"]);
const { t } = useI18n();

const activeComp = computed(() => (props.tabs.find((x) => x.key === props.active) || props.tabs[0]).comp);
</script>

<template>
  <div class="module-tabs">
    <div class="tabs-bar" role="tablist">
      <button
        v-for="x in tabs"
        :key="x.key"
        role="tab"
        class="tab-btn"
        :class="{ on: x.key === active }"
        :aria-selected="x.key === active"
        :title="t(x.labelKey)"
        @click="emit('update:active', x.key)"
      >
        <Icon :name="x.icon" :size="14" /> <span class="tab-label">{{ t(x.labelKey) }}</span>
      </button>
    </div>
    <div class="tabs-body">
      <component :is="activeComp" :key="active" :show-toast="showToast" :jump-id="jumpId" @navigate="(e) => emit('navigate', e)" />
    </div>
  </div>
</template>

<style scoped>
.module-tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.tabs-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 28px 10px;
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs-bar::-webkit-scrollbar { display: none; }
.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 7px 14px;
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  background: none;
  color: var(--text-weak);
  font-size: var(--fs-md);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.tab-btn:hover { background: var(--card); border-color: var(--card-border); color: var(--primary-hover); }
.tab-btn.on { background: var(--grad-selected); border-color: var(--border-blue); color: var(--primary-hover); }
/* 小窗：只留图标（label 隐藏），避免 Tab 横向滚动挤掉内容 */
@media (max-width: 780px) {
  .tab-label { display: none; }
  .tab-btn { padding: 7px 10px; }
}
.tabs-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
</style>
