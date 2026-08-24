<script setup>
// AI 回复的 Markdown 渲染：v-html 输出 renderMarkdown（highlight 开启），代码块复制走事件委托
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { renderMarkdown } from "../shared.js";

const { t } = useI18n();

const props = defineProps({
  text: { type: String, default: "" },
  highlight: { type: Boolean, default: true },
  showToast: { type: Function, default: () => {} },
});

const html = computed(() => renderMarkdown(props.text, { highlight: props.highlight }));

function onMdClick(e) {
  const btn = e.target.closest?.(".md-copy");
  if (!btn) return;
  const code = btn.parentElement?.querySelector("code");
  if (!code) return;
  navigator.clipboard
    ?.writeText(code.textContent || "")
    .then(() => props.showToast(t("toolbox.ai.codeCopied")))
    .catch(() => props.showToast(t("toolbox.ai.copyFail")));
}
</script>

<template>
  <div class="md" v-html="html" @click="onMdClick"></div>
</template>

<style scoped>
/* v-html 注入的内容不受 scoped 限制，统一用 :deep 覆盖（颜色/字号走全局设计令牌） */
.md :deep(.md-code) {
  position: relative;
  margin: 6px 0;
  padding: 26px 12px 10px;
  background: var(--well);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  overflow-x: auto;
  font-family: var(--font-num);
  font-size: var(--fs-sm);
  line-height: 1.55;
}
.md :deep(.md-code .md-copy) {
  position: absolute;
  top: 5px;
  right: 6px;
  padding: 1px 8px;
  font-size: var(--fs-xs);
  color: var(--muted);
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-xs);
  cursor: pointer;
}
.md :deep(.md-code .md-copy:hover) {
  color: var(--primary-hover);
  border-color: var(--border-blue);
}
.md :deep(.md-table) {
  margin: 6px 0;
  border-collapse: collapse;
  font-size: var(--fs-sm);
}
.md :deep(.md-table th),
.md :deep(.md-table td) {
  padding: 4px 10px;
  border: 1px solid var(--card-border);
  text-align: left;
}
.md :deep(.md-table th) {
  background: var(--well);
  font-weight: 600;
}
.md :deep(blockquote) {
  margin: 6px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--border-blue);
  color: var(--muted);
}
.md :deep(p) {
  margin: 4px 0;
}
.md :deep(a) {
  color: var(--primary-hover);
}
.md :deep(code) {
  font-family: var(--font-num);
  font-size: 0.92em;
  background: var(--well);
  padding: 1px 5px;
  border-radius: var(--r-xs);
}
.md :deep(pre.md-code code) {
  background: transparent;
  padding: 0;
}
</style>
