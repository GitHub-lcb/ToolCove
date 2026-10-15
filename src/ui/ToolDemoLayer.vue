<script setup>
// 演示层（工具视图底部的一条）：说明「这个工具是 AI 打开的」、当前在操作哪一步、以及结束后的复现步骤。
//
// 为什么是一条而不是满屏蒙层：工具本身还要用，蒙层会挡住它的界面；真正抓视线的是目标控件上的
// 聚光（FOCUS_CLASS 加在真实元素上，样式在 styles/globals.css），这里只负责叙事与节奏控制。
//
// 只在被 Agent 打开时出现（state.active 为假则整层不渲染）——手动点开的工具不该看到任何演示痕迹。
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";
import { clipValue, replayLines } from "../app/toolDemo.js";

const props = defineProps({
  state: { type: Object, required: true },
});
const emit = defineEmits(["skip", "replay"]);

const { t } = useI18n();

const lines = computed(() => replayLines(props.state.script, { t }));
const stepNo = computed(() => (props.state.total ? Math.min(props.state.index + 1, props.state.total) : 0));
</script>

<template>
  <section v-if="state.active" class="tdl" data-role="tool-demo" :data-done="state.done ? '1' : '0'">
    <div class="tdl-row">
      <Icon name="sparkles" :size="14" class="tdl-ico" />
      <span class="tdl-who" data-role="demo-origin">{{ t("toolbox.demo.openedByAgent") }}</span>

      <span class="tdl-dots" data-role="demo-dots" :aria-label="t('toolbox.demo.step', { n: stepNo, total: state.total })">
        <i v-for="n in state.total" :key="n" :class="{ on: n <= stepNo }"></i>
      </span>

      <span class="tdl-caption" data-role="demo-caption">
        <template v-if="state.done">{{ state.skipped ? t("toolbox.demo.skipped") : t("toolbox.demo.done") }}</template>
        <template v-else>{{ t(state.captionKey) }}</template>
      </span>

      <code v-if="!state.done && state.captionValue != null" class="tdl-value" data-role="demo-value">{{ clipValue(state.captionValue) }}</code>

      <span class="tdl-spacer"></span>
      <button v-if="!state.done" class="tdl-btn" data-role="demo-skip" @click="emit('skip')">{{ t("toolbox.demo.skip") }}</button>
      <button v-else class="tdl-btn" data-role="demo-replay" @click="emit('replay')">{{ t("toolbox.demo.replay") }}</button>
    </div>

    <details v-if="state.done && lines.length" class="tdl-replay" data-role="demo-steps">
      <summary>{{ t("toolbox.demo.stepsTitle") }}</summary>
      <ol>
        <li v-for="(line, index) in lines" :key="index">{{ line }}</li>
      </ol>
    </details>
  </section>
</template>

<style scoped>
.tdl {
  border: 1px solid var(--primary);
  border-radius: 8px;
  background: var(--primary-soft);
  color: var(--text);
  font-size: 0.82rem;
}

.tdl-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
}

.tdl-ico {
  color: var(--primary);
}

.tdl-who {
  color: var(--primary);
  font-weight: 600;
}

.tdl-dots {
  display: inline-flex;
  gap: 3px;
}

.tdl-dots i {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--border);
}

.tdl-dots i.on {
  background: var(--primary);
}

.tdl-caption {
  color: var(--text);
}

.tdl-value {
  padding: 1px var(--sp-1);
  border-radius: 4px;
  background: var(--card);
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.76rem;
}

.tdl-spacer {
  flex: 1;
}

.tdl-btn {
  padding: 2px var(--sp-2);
  border: 1px solid var(--primary);
  border-radius: 6px;
  background: var(--card);
  color: var(--primary);
  cursor: pointer;
  font-size: 0.78rem;
}

.tdl-replay {
  padding: 0 var(--sp-3) var(--sp-2);
  color: var(--muted);
}

.tdl-replay summary {
  cursor: pointer;
}

.tdl-replay ol {
  margin: var(--sp-1) 0 0;
  padding-left: 1.2em;
  line-height: 1.6;
}
</style>
