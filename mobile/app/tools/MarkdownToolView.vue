<script setup>
// Markdown 工具（手机端）：编辑 / 预览切换 + 目录 + 统计 + 检查 + 导出 HTML。
//
// 与桌面端**共用同一份纯逻辑**（src/markdownTool.js，52 条单测）与**同一个渲染器**
// （src/shared.js 的 renderMarkdown），所以预览结果两端一致。
//
// 界面按手机重排：编辑与预览**不能并排**（393px 宽并排两边都没法看），
// 改成切换式；工具操作收进 chips；侧栏信息用可折叠卡片。
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { renderMarkdown } from "../../../src/shared.js";
import { loadToolbox, saveToolbox } from "../../../src/toolboxStore.js";
import { formatTables, lint, normalize, outline, stats, toHtmlDocument, toToc } from "../../../src/markdownTool.js";

const { t } = useI18n();

const SAMPLE = [
  "# 项目说明",
  "",
  "这是一个 **Markdown** 编辑器。",
  "",
  "## 功能",
  "",
  "- 目录生成",
  "- 表格对齐",
  "",
  "| 名称 | 说明 |",
  "| --- | --- |",
  "| 甲 | 第一项 |",
].join("\n");

const input = ref(SAMPLE);
const view = ref("edit"); // edit | preview
const panel = ref(""); // "" | outline | stats | issues
const title = ref("文档");
const notice = ref("");

const html = computed(() => renderMarkdown(input.value, { highlight: false }));
const headings = computed(() => outline(input.value));
const toc = computed(() => toToc(headings.value));
const docStats = computed(() => stats(input.value));
const issues = computed(() => lint(input.value));

function flash(message) {
  notice.value = message;
  setTimeout(() => (notice.value = ""), 2000);
}

function applyTransform(kind) {
  const before = input.value;
  const after = kind === "tables" ? formatTables(before) : normalize(before);
  if (after === before) {
    flash(t("toolbox.markdown.noChange"));
    return;
  }
  input.value = after;
  flash(kind === "tables" ? t("toolbox.markdown.tablesDone") : t("toolbox.markdown.normalizeDone"));
}

function insertToc() {
  if (!toc.value) {
    flash(t("toolbox.markdown.noHeadings"));
    return;
  }
  const lines = input.value.split("\n");
  const firstHeading = lines.findIndex((line) => /^#{1,6}\s/.test(line));
  const at = firstHeading >= 0 ? firstHeading + 1 : 0;
  lines.splice(at, 0, "", toc.value);
  input.value = lines.join("\n");
  flash(t("toolbox.markdown.tocInserted"));
}

/** 手机上"导出"就是下载/分享：系统会给出保存或分享入口。 */
function downloadHtml() {
  const blob = new Blob([toHtmlDocument(input.value, { render: renderMarkdown, title: title.value })], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(title.value || "document").replace(/[\\/:*?"<>|]/g, "_")}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  flash(t("toolbox.markdown.savedHtml"));
}

async function copyHtml() {
  try {
    await navigator.clipboard.writeText(html.value);
    flash(t("toolbox.markdown.copiedHtml"));
  } catch {
    flash(t("toolbox.markdown.copyFailed"));
  }
}

const issueText = (issue) => t(`toolbox.markdown.issue_${issue.code}`, issue.params);

loadToolbox("markdown", {}).then((saved) => {
  if (!saved || typeof saved !== "object") return;
  if (typeof saved.input === "string" && saved.input) input.value = saved.input;
  if (typeof saved.title === "string") title.value = saved.title;
});

watch([input, title], () => {
  saveToolbox("markdown", { input: input.value, title: title.value });
});
</script>

<template>
  <section class="m-tool" data-tool="markdown">
    <div class="m-chips" data-role="views">
      <button class="m-chip" :class="{ on: view === 'edit' }" data-view="edit" @click="view = 'edit'">{{ t("toolbox.markdown.view_edit") }}</button>
      <button class="m-chip" :class="{ on: view === 'preview' }" data-view="preview" @click="view = 'preview'">{{ t("toolbox.markdown.view_preview") }}</button>
    </div>

    <template v-if="view === 'edit'">
      <label class="m-field">
        <span>{{ t("toolbox.markdown.inputLabel") }}</span>
        <textarea v-model="input" rows="14" spellcheck="false" data-role="input" :placeholder="t('toolbox.markdown.inputPh')"></textarea>
      </label>
    </template>
    <!-- eslint-disable-next-line vue/no-v-html -- 渲染入口是 shared.renderMarkdown（先 escapeHtml 再套标记），与聊天用的是同一个 -->
    <div v-else class="m-md" data-role="preview" v-html="html"></div>

    <div class="m-chips" data-role="actions">
      <button class="m-chip" data-role="format-tables" @click="applyTransform('tables')">{{ t("toolbox.markdown.formatTables") }}</button>
      <button class="m-chip" data-role="normalize" @click="applyTransform('normalize')">{{ t("toolbox.markdown.normalize") }}</button>
      <button class="m-chip" data-role="insert-toc" @click="insertToc">{{ t("toolbox.markdown.insertToc") }}</button>
      <button class="m-chip" data-role="clear" @click="input = ''">{{ t("toolbox.markdown.clear") }}</button>
    </div>

    <div class="m-chips" data-role="panels">
      <button class="m-chip" :class="{ on: panel === 'outline' }" data-panel="outline" @click="panel = panel === 'outline' ? '' : 'outline'">
        {{ t("toolbox.markdown.panel_outline") }} ({{ headings.length }})
      </button>
      <button class="m-chip" :class="{ on: panel === 'stats' }" data-panel="stats" @click="panel = panel === 'stats' ? '' : 'stats'">
        {{ t("toolbox.markdown.panel_stats") }}
      </button>
      <button class="m-chip" :class="{ on: panel === 'issues' }" data-panel="issues" @click="panel = panel === 'issues' ? '' : 'issues'">
        {{ t("toolbox.markdown.panel_issues") }} ({{ issues.length }})
      </button>
    </div>

    <ul v-if="panel === 'outline'" class="m-stats" data-role="outline">
      <li v-if="!headings.length" class="m-hint-sm">{{ t("toolbox.markdown.noHeadings") }}</li>
      <li v-for="item in headings" :key="item.line" :data-level="item.level">
        <b :style="{ paddingLeft: `${(item.level - 1) * 10}px` }">{{ item.text }}</b>
        <span>{{ t("toolbox.markdown.atLine", { n: item.line }) }}</span>
      </li>
    </ul>

    <ul v-else-if="panel === 'stats'" class="m-stats" data-role="stats">
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

    <ul v-else-if="panel === 'issues'" class="m-stats" data-role="issues">
      <li v-if="!issues.length" class="m-hint-sm" data-role="no-issues">{{ t("toolbox.markdown.noIssues") }}</li>
      <li v-for="(issue, index) in issues" :key="index" :data-code="issue.code">
        <b>{{ t("toolbox.markdown.atLine", { n: issue.line }) }}</b>
        <span>{{ issueText(issue) }}</span>
      </li>
    </ul>

    <label class="m-field">
      <span>{{ t("toolbox.markdown.docTitle") }}</span>
      <input v-model="title" data-role="doc-title" />
    </label>
    <div class="m-actions">
      <button class="m-btn primary" data-role="download-html" @click="downloadHtml">{{ t("toolbox.markdown.downloadHtml") }}</button>
      <button class="m-btn" data-role="copy-html" @click="copyHtml">{{ t("toolbox.markdown.copyHtml") }}</button>
    </div>

    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
  </section>
</template>
