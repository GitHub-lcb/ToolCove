<script setup>
// Pool 行右侧：发布状态徽章 + 详情 + 发布主行动按钮（ReleaseView 领域池 / 本页维护池共用）
// 状态徽章样式（st-chip/st-*）为全局定义，本组件只带布局与 hover
import Icon from "./Icon.vue";

const props = defineProps({
  statusKey: { type: String, default: "idle" },
  badgeCls: { type: String, default: "" },
  label: { type: String, default: "" },
  detail: { type: String, default: "" },
  publishLabel: { type: String, default: "发布" },
  publishTitle: { type: String, default: "" },
  publishIcon: { type: String, default: "upload" },
});
const emit = defineEmits(["publish"]);
</script>

<template>
  <div class="ps-wrap">
    <div class="pub-state">
      <span class="st-chip" :class="badgeCls">
        <Icon v-if="statusKey === 'building' || statusKey === 'deploying'" name="repeat" :size="13" class="spin" />
        <Icon v-else-if="statusKey === 'built'" name="clock" :size="13" />
        <Icon v-else-if="statusKey === 'success'" name="check" :size="13" />
        <Icon v-else-if="statusKey === 'failed'" name="alert" :size="13" />
        {{ label }}
      </span>
      <span v-if="detail" class="pub-detail" :title="detail">{{ detail }}</span>
    </div>
    <button class="btn-ghost sm publish-btn" :title="publishTitle" @click="emit('publish')">
      <Icon :name="publishIcon" :size="14" />
      {{ publishLabel }}
    </button>
  </div>
</template>

<style scoped>
.ps-wrap { display: flex; align-items: center; gap: var(--sp-1); flex-shrink: 0; }
.pub-state { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex-shrink: 0; min-width: 0; }
.idle-chip { color: var(--muted); background: var(--well); }
.pub-detail { font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
.publish-btn:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }

@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 0.9s linear infinite; }

@media (prefers-color-scheme: dark) {
  .idle-chip { background: var(--well); color: var(--text-weak); }
}
</style>
