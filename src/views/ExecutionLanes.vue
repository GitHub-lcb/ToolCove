<script setup>
// 执行泳道：模型 / 工具 / 确认三条时间道。数据推导全在 agent/lanes.js（纯函数、可单测），
// 这里只负责把毫秒区间画成百分比色块。运行中由父组件传 now，让进行中的段继续生长。
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { buildLanes } from "../agent/lanes.js";

const props = defineProps({
  steps: { type: Array, default: () => [] },
  running: { type: Boolean, default: false },
  now: { type: Number, default: 0 },
  // 右栏等已有内边距的容器里去掉左右留白，避免二次缩进
  flush: { type: Boolean, default: false },
});

const { t } = useI18n();
const data = computed(() => buildLanes(props.steps, { now: props.running ? props.now : 0 }));

const LABEL_KEY = { model: "agent.laneModel", tool: "agent.laneTool", wait: "agent.laneWait" };

function pct(ms) {
  return `${Math.max(0, Math.min(100, (Number(ms) / data.value.totalMs) * 100))}%`;
}

function fmt(ms) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

const segTitle = (lane, seg) => `${t(LABEL_KEY[lane.key])} · ${fmt(seg.end - seg.start)}`;
</script>

<template>
  <div v-if="data" class="lanes" :class="{ 'lanes--flush': flush }" role="img" :aria-label="t('agent.lanesTitle')">
    <div v-for="lane in data.lanes" :key="lane.key" class="lane" :class="'lane-' + lane.key">
      <span class="lane-label">{{ t(LABEL_KEY[lane.key]) }}</span>
      <span class="lane-track">
        <span
          v-for="(seg, i) in lane.segments"
          :key="i"
          class="lane-seg"
          :style="{ left: pct(seg.start - data.start), width: pct(seg.end - seg.start) }"
          :title="segTitle(lane, seg)"
        ></span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.lanes { display: flex; flex-direction: column; gap: 4px; padding: 0 var(--sp-4) var(--sp-3); }
.lanes--flush { padding: 0; }
.lane { display: flex; align-items: center; gap: var(--sp-2); }
.lane-label { flex: 0 0 34px; font-size: var(--fs-xs); color: var(--muted); }
.lane-track { position: relative; flex: 1; height: 6px; overflow: hidden; border-radius: var(--r-pill); background: var(--well); }
.lane-seg { position: absolute; top: 0; bottom: 0; min-width: 2px; border-radius: var(--r-pill); background: var(--run); }
.lane-tool .lane-seg { background: var(--primary); }
.lane-wait .lane-seg { background: var(--wait); }
</style>
