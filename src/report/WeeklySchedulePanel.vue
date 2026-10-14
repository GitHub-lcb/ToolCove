<script setup>
// 周报「定时生成」设置行：报告弹窗里的一行。抽成独立组件是为了能单独 SSR 渲染断言
// （设置行在 TaskView 的报告弹窗内，弹窗默认关闭，整体渲染时根本看不到它）。
// 组件刻意保持「哑」：只读 props.policy 并 emit 变更，落盘与生成由 TaskView 负责。
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../ui/Icon.vue";

const props = defineProps({
  policy: { type: Object, required: true },
  weekdayOptions: { type: Array, default: () => [] },
  generating: { type: Boolean, default: false },
});
const emit = defineEmits(["change", "generate"]);

const { t } = useI18n();

const pad = (n) => String(n).padStart(2, "0");
const timeValue = computed(() => `${pad(props.policy.hour)}:${pad(props.policy.minute)}`);

function onTimeChange(e) {
  const [hour, minute] = String(e.target.value || "").split(":").map(Number);
  if (Number.isFinite(hour) && Number.isFinite(minute)) emit("change", { ...props.policy, hour, minute });
}
</script>

<template>
  <div class="weekly-bar">
    <label class="weekly-toggle">
      <input type="checkbox" :checked="policy.enabled" @change="emit('change', { ...policy, enabled: $event.target.checked })" />
      <Icon name="repeat" :size="13" /> {{ t("task.weeklySchedule") }}
    </label>
    <label class="weekly-field">
      <span>{{ t("task.weeklyWeekday") }}</span>
      <select :value="policy.weekday" :disabled="!policy.enabled" @change="emit('change', { ...policy, weekday: Number($event.target.value) })">
        <option v-for="opt in weekdayOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </label>
    <label class="weekly-field">
      <span>{{ t("task.weeklyTime") }}</span>
      <input type="time" :value="timeValue" :disabled="!policy.enabled" @change="onTimeChange" />
    </label>
    <button class="btn-ghost sm" :disabled="generating" @click="emit('generate')">
      <Icon name="sparkles" :size="13" /> {{ generating ? t("task.generating") : t("task.weeklyGenerateNow") }}
    </button>
  </div>
</template>

<style scoped>
.weekly-bar { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; padding: var(--sp-2) var(--sp-4); margin-bottom: var(--sp-5); background: var(--card); border: 1px dashed var(--border-strong); border-radius: var(--r-md); }
.weekly-toggle { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); font-weight: 600; color: var(--text-soft); cursor: pointer; }
.weekly-field { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--muted); }
.weekly-field select, .weekly-field input { background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 3px var(--sp-2); font-size: var(--fs-sm); color: var(--text); font-family: inherit; }
.weekly-field select:disabled, .weekly-field input:disabled { opacity: 0.5; cursor: not-allowed; }
.weekly-bar button { margin-left: auto; }
</style>
