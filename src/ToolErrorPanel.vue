<script setup>
// 工具加载/初始化失败的统一报错面板：独立窗口（ToolWindow）与主窗口内嵌（ToolboxView）共用，
// 避免两处各写一份 markup/CSS 后慢慢漂移。
// 背景：异步组件 import 失败、或工具 setup/首次渲染抛错时，Vue 不会给出任何可见反馈——
// 用户只看到一片空白，只能按 F12 才知道发生了什么。这里把原因直接摆在界面上。
import Icon from "./Icon.vue";

defineProps({
  reason: { type: String, required: true }, // 已翻译的标题（加载失败 / 加载超时）
  hint: { type: String, default: "" }, // 已翻译的排障建议
  detail: { type: String, default: "" }, // 原始错误信息，方便直接复制进 issue
});
</script>

<template>
  <div class="tool-error" role="alert">
    <Icon name="alert" :size="22" />
    <b>{{ reason }}</b>
    <p v-if="hint" class="te-hint">{{ hint }}</p>
    <code v-if="detail" class="te-detail">{{ detail }}</code>
  </div>
</template>

<style scoped>
.tool-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 16px; height: 100%; overflow: auto; }
.tool-error > svg { color: var(--danger); flex-shrink: 0; }
.tool-error b { font-size: var(--fs-md); color: var(--text); }
.te-hint { margin: 0; max-width: 68ch; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }
.te-detail {
  max-width: 100%;
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--text-weak);
  background: var(--well);
  border-radius: var(--r-sm);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
