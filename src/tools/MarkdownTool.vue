<script setup>
// Markdown 工具（桌面端）：编辑 + 实时预览 + 目录/统计/检查 + 导出 HTML。
//
// 渲染**复用** src/shared.js 的 renderMarkdown（AI 回复也在用同一份），
// 所以这里的预览与聊天里看到的必然一致——不重写第二份渲染器。
// 围绕 Markdown 的处理（大纲/统计/表格对齐/规范化/检查）在 src/markdownTool.js（纯函数，52 条单测）。
//
// 与相邻工具的边界：不做通用文本处理（那是 text 工具）、不做 JSON/YAML（那是 json 工具）。
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import { renderMarkdown } from "../shared.js";
import { loadToolbox, saveToolbox } from "../toolboxStore.js";
import { formatTables, lint, normalize, outline, stats, toHtmlDocument, toToc } from "../markdownTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const SAMPLE = [
  "# 项目说明",
  "",
  "这是一个 **Markdown** 编辑器，左边写、右边实时预览。",
  "",
  "## 功能",
  "",
  "- 目录生成",
  "- 表格对齐",
  "- 导出 HTML",
  "",
  "## 示例表格",
  "",
  "| 名称 | 说明 | 数量 |",
  "| --- | --- | --- |",
  "| 甲 | 第一项 | 1 |",
  "| 乙 | 第二项 | 22 |",
].join("\n");

const input = ref(SAMPLE);
const view = ref("split"); // split | edit | preview
const sidePanel = ref("outline"); // outline | stats | issues
const title = ref("文档");

const html = computed(() => renderMarkdown(input.value, { highlight: false }));
const headings = computed(() => outline(input.value));
const toc = computed(() => toToc(headings.value));
const docStats = computed(() => stats(input.value));
const issues = computed(() => lint(input.value));

const exportHtml = computed(() => toHtmlDocument(input.value, { render: renderMarkdown, title: title.value }));

/** 大纲点击 → 跳到编辑器里对应的行（textarea 用 selectionStart 定位）。 */
const editorRef = ref(null);
function jumpTo(line) {
  const node = editorRef.value;
  if (!node) return;
  const lines = input.value.split("\n");
  const offset = lines.slice(0, Math.max(0, line - 1)).join("\n").length + (line > 1 ? 1 : 0);
  node.focus();
  node.setSelectionRange(offset, offset + (lines[line - 1]?.length || 0));
  // 让目标行滚到视野中（按行高估算，够用且不依赖 DOM 测量）
  const lineHeight = 21;
  node.scrollTop = Math.max(0, (line - 3) * lineHeight);
}

/** 把处理结果写回编辑器（表格对齐 / 规范化）。 */
function applyTransform(kind) {
  const before = input.value;
  const after = kind === "tables" ? formatTables(before) : normalize(before);
  if (after === before) {
    props.showToast(t("toolbox.markdown.noChange"));
    return;
  }
  input.value = after;
  props.showToast(kind === "tables" ? t("toolbox.markdown.tablesDone") : t("toolbox.markdown.normalizeDone"));
}

function insertToc() {
  if (!toc.value) {
    props.showToast(t("toolbox.markdown.noHeadings"));
    return;
  }
  // 插到第一个标题之后（目录放在文首标题下面最自然）
  const lines = input.value.split("\n");
  const firstHeading = lines.findIndex((line) => /^#{1,6}\s/.test(line));
  const at = firstHeading >= 0 ? firstHeading + 1 : 0;
  lines.splice(at, 0, "", toc.value);
  input.value = lines.join("\n");
  props.showToast(t("toolbox.markdown.tocInserted"));
}

async function copyHtml() {
  try {
    await navigator.clipboard.writeText(html.value);
    props.showToast(t("toolbox.markdown.copiedHtml"));
  } catch {
    props.showToast(t("toolbox.markdown.copyFailed"));
  }
}

function downloadHtml() {
  const blob = new Blob([exportHtml.value], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(title.value || "document").replace(/[\\/:*?"<>|]/g, "_")}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  props.showToast(t("toolbox.markdown.savedHtml"));
}

function clearAll() {
  input.value = "";
}

/** 检查项按错误码渲染文案（与标签工具的体检同一约定）。 */
const issueText = (issue) => t(`toolbox.markdown.issue_${issue.code}`, issue.params);

loadToolbox("markdown", {}).then((saved) => {
  if (!saved || typeof saved !== "object") return;
  if (typeof saved.input === "string" && saved.input) input.value = saved.input;
  if (typeof saved.view === "string") view.value = saved.view;
  if (typeof saved.title === "string") title.value = saved.title;
});

watch([input, view, title], () => {
  saveToolbox("markdown", { input: input.value, view: view.value, title: title.value });
});
</script>

<template>
  <div class="tool-markdown">
    <div class="md-toolbar">
      <div class="md-seg">
        <button v-for="item in ['split', 'edit', 'preview']" :key="item" :class="{ on: view === item }" :data-view="item" @click="view = item">
          {{ t(`toolbox.markdown.view_${item}`) }}
        </button>
      </div>
      <button class="md-btn" data-role="format-tables" @click="applyTransform('tables')">{{ t("toolbox.markdown.formatTables") }}</button>
      <button class="md-btn" data-role="normalize" @click="applyTransform('normalize')">{{ t("toolbox.markdown.normalize") }}</button>
      <button class="md-btn" data-role="insert-toc" @click="insertToc">{{ t("toolbox.markdown.insertToc") }}</button>
      <button class="md-btn" data-role="clear" @click="clearAll">{{ t("toolbox.markdown.clear") }}</button>
      <span class="md-spacer"></span>
      <label class="md-field">
        <span>{{ t("toolbox.markdown.docTitle") }}</span>
        <input v-model="title" data-role="doc-title" />
      </label>
      <button class="md-btn" data-role="copy-html" @click="copyHtml">
        <Icon name="copy" /> {{ t("toolbox.markdown.copyHtml") }}
      </button>
      <button class="md-btn primary" data-role="download-html" @click="downloadHtml">{{ t("toolbox.markdown.downloadHtml") }}</button>
    </div>

    <div class="md-body" :data-view="view">
      <!-- 编辑区 -->
      <textarea
        v-if="view !== 'preview'"
        ref="editorRef"
        v-model="input"
        class="md-editor"
        spellcheck="false"
        data-role="input"
        :placeholder="t('toolbox.markdown.inputPh')"
      ></textarea>

      <!-- 预览区 -->
      <!-- eslint-disable-next-line vue/no-v-html -- 渲染入口是 shared.renderMarkdown（先 escapeHtml 再套标记），与聊天/Agent 用的是同一个 -->
      <div v-if="view !== 'edit'" class="md-preview md-content" data-role="preview" v-html="html"></div>
    </div>

    <!-- 侧栏：大纲 / 统计 / 检查 -->
    <div class="md-side">
      <div class="md-seg">
        <button v-for="item in ['outline', 'stats', 'issues']" :key="item" :class="{ on: sidePanel === item }" :data-panel="item" @click="sidePanel = item">
          {{ t(`toolbox.markdown.panel_${item}`) }}
          <span v-if="item === 'issues' && issues.length" class="md-badge">{{ issues.length }}</span>
        </button>
      </div>

      <ul v-if="sidePanel === 'outline'" class="md-list" data-role="outline">
        <li v-if="!headings.length" class="md-empty">{{ t("toolbox.markdown.noHeadings") }}</li>
        <li v-for="item in headings" :key="item.line" :data-level="item.level" :style="{ paddingLeft: `${(item.level - 1) * 12}px` }">
          <button class="md-link" data-role="outline-item" @click="jumpTo(item.line)">{{ item.text }}</button>
        </li>
      </ul>

      <ul v-else-if="sidePanel === 'stats'" class="md-list" data-role="stats">
        <li><b>{{ t("toolbox.markdown.statLines") }}</b><span>{{ docStats.lines }}</span></li>
        <li><b>{{ t("toolbox.markdown.statChars") }}</b><span>{{ docStats.chars }}</span></li>
        <li><b>{{ t("toolbox.markdown.statWords") }}</b><span>{{ docStats.cjk + docStats.words }}</span></li>
        <li><b>{{ t("toolbox.markdown.statHeadings") }}</b><span>{{ docStats.headings }}</span></li>
        <li><b>{{ t("toolbox.markdown.statLinks") }}</b><span>{{ docStats.links }}</span></li>
        <li><b>{{ t("toolbox.markdown.statImages") }}</b><span>{{ docStats.images }}</span></li>
        <li><b>{{ t("toolbox.markdown.statCode") }}</b><span>{{ docStats.codeBlocks }}</span></li>
        <li><b>{{ t("toolbox.markdown.statTables") }}</b><span>{{ docStats.tables }}</span></li>
        <li><b>{{ t("toolbox.markdown.statRead") }}</b><span>{{ t("toolbox.markdown.readMinutes", { n: docStats.readMinutes }) }}</span></li>
      </ul>

      <ul v-else class="md-list" data-role="issues">
        <li v-if="!issues.length" class="md-empty" data-role="no-issues">{{ t("toolbox.markdown.noIssues") }}</li>
        <li v-for="(issue, index) in issues" :key="index" :data-code="issue.code">
          <button class="md-link" @click="jumpTo(issue.line)">
            <span class="md-line">{{ t("toolbox.markdown.atLine", { n: issue.line }) }}</span>
            {{ issueText(issue) }}
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.tool-markdown {
  display: grid;
  grid-template-columns: 1fr 260px;
  grid-template-rows: auto 1fr;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.md-toolbar {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.md-spacer {
  flex: 1;
}

.md-seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.md-seg button {
  padding: 5px 12px;
  border: 0;
  background: var(--card);
  color: var(--muted);
  cursor: pointer;
  font-size: 0.85rem;
}

.md-seg button.on {
  background: var(--primary-soft);
  color: var(--primary);
}

.md-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text);
  cursor: pointer;
  font-size: 0.85rem;
}

.md-btn:hover {
  border-color: var(--primary);
}

.md-btn.primary {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.md-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  color: var(--muted);
}

.md-field input {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text);
  width: 140px;
}

.md-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  min-height: 0;
}

/* 单栏模式：只显示一侧时占满 */
.md-body[data-view="edit"],
.md-body[data-view="preview"] {
  grid-template-columns: 1fr;
}

.md-editor {
  width: 100%;
  height: 100%;
  min-height: 300px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.84rem;
  line-height: 21px;
  resize: none;
}

.md-preview {
  min-height: 300px;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  overflow: auto;
  font-size: 0.9rem;
  line-height: 1.75;
}

.md-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.md-list {
  flex: 1;
  margin: 0;
  padding: 8px;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  overflow: auto;
  font-size: 0.84rem;
}

.md-list li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
}

.md-list li:hover {
  background: var(--soft);
}

.md-list li[data-level="1"] {
  font-weight: 600;
}

.md-link {
  border: 0;
  background: none;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  padding: 0;
  font: inherit;
  flex: 1;
}

.md-link:hover {
  color: var(--primary);
}

.md-line {
  color: var(--muted);
  margin-right: 6px;
  font-variant-numeric: tabular-nums;
}

.md-empty {
  color: var(--muted);
}

.md-badge {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 0.72rem;
}
</style>
