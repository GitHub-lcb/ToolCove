<script setup>
// 表格工具（桌面端）：粘贴/导入分隔文本 → 表格视图 → 清洗操作 → 导出多种格式。
//
// 与相邻工具的边界（刻意划清，避免功能重叠）：
//   · 不做通用文本处理（正则/替换/行处理）→ 那是 text 工具
//   · 不做 JSON 语法校验 → 那是 json 工具
//   · 只负责"分隔文本 ⇄ 结构化数据"与围绕它的表格操作
//
// 所有解析/转换/清洗逻辑都在 src/tableTool.js（纯函数，三端共用，54 条单测）。
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import { saveToolbox, loadToolbox } from "../toolboxStore.js";
import {
  DELIMITERS,
  MAX_ROWS,
  dedupeRows,
  detectDelimiter,
  filterRows,
  parseDelimited,
  removeEmptyRows,
  selectColumns,
  sortRows,
  stats,
  toDelimited,
  toJson,
  toMarkdown,
  toSqlInsert,
} from "../tableTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const input = ref("");
const delimiter = ref("auto"); // auto | 具体字符
const hasHeader = ref(true);
const error = ref("");
const previewLimit = ref(200);

/** 清洗操作的"待应用"状态：操作先在内存里叠加，用户能看到结果再导出。 */
const operations = ref([]); // [{ kind, columnIndex, direction, numeric, indexes, op, value }]

const activeDelimiter = computed(() => {
  if (delimiter.value === "auto") return detectDelimiter(input.value);
  return delimiter.value;
});

/**
 * 解析结果（脏数据/大输入都在这里被处理，见 tableTool 的注释）。
 *
 * ⚠️ computed 必须是**纯函数**：不能在里面对 error 之类的 ref 赋值
 * （eslint 的 vue/no-side-effects-in-computed-properties 会拦，而且确实会导致
 * 依赖追踪错乱）。所以解析错误作为返回值的一部分带出来，由模板显示。
 */
const parsed = computed(() => {
  if (!input.value.trim()) return { rows: [], truncated: false, totalRows: 0, parseError: "" };
  try {
    return { ...parseDelimited(input.value, activeDelimiter.value), parseError: "" };
  } catch (e) {
    return { rows: [], truncated: false, totalRows: 0, parseError: e?.message || String(e) };
  }
});

/** 应用清洗操作后的表格。 */
const table = computed(() => {
  let rows = parsed.value.rows;
  for (const op of operations.value) {
    if (op.kind === "sort") rows = sortRows(rows, op.columnIndex, op.direction, { header: hasHeader.value, numeric: op.numeric });
    else if (op.kind === "dedupe") rows = dedupeRows(rows, { header: hasHeader.value });
    else if (op.kind === "removeEmpty") rows = removeEmptyRows(rows, { header: hasHeader.value });
    else if (op.kind === "selectColumns") rows = selectColumns(rows, op.indexes);
    else if (op.kind === "filter") rows = filterRows(rows, { ...op, header: hasHeader.value });
  }
  return rows;
});

const header = computed(() => (hasHeader.value ? table.value[0] || [] : []));
const body = computed(() => (hasHeader.value ? table.value.slice(1) : table.value));
const visibleBody = computed(() => body.value.slice(0, previewLimit.value));
const columnCount = computed(() => Math.max(0, ...table.value.map((row) => row.length)));
const tableStats = computed(() => stats(table.value, { header: hasHeader.value }));

/** 各导出格式的结果（按需计算，避免每次输入都生成一大段 SQL）。 */
const EXPORTS = computed(() => [
  { key: "csv", label: "CSV" },
  { key: "tsv", label: "TSV" },
  { key: "json", label: "JSON" },
  { key: "markdown", label: t("toolbox.table.exportMarkdown") },
  { key: "sql", label: t("toolbox.table.exportSql") },
]);

const exportFormat = ref("csv");
const sqlTable = ref("t");

const exportText = computed(() => {
  const rows = table.value;
  switch (exportFormat.value) {
    case "tsv":
      return toDelimited(rows, { delimiter: "\t" });
    case "json":
      return toJson(rows, { header: hasHeader.value });
    case "markdown":
      return toMarkdown(rows);
    case "sql":
      return toSqlInsert(rows, { table: sqlTable.value, header: hasHeader.value });
    default:
      return toDelimited(rows, { delimiter: "," });
  }
});

/** 点列头排序：同一列再点一次切换升降序。 */
function sortByColumn(index) {
  const last = operations.value[operations.value.length - 1];
  const direction = last?.kind === "sort" && last.columnIndex === index && last.direction === "asc" ? "desc" : "asc";
  // 排序是"替换"语义而不是叠加：叠加两次排序没有意义，只会让人困惑
  operations.value = [...operations.value.filter((op) => op.kind !== "sort"), { kind: "sort", columnIndex: index, direction, numeric: true }];
}

const sortState = computed(() => {
  const last = operations.value.find((op) => op.kind === "sort");
  return last ? { index: last.columnIndex, direction: last.direction } : null;
});

function addOperation(op) {
  operations.value = [...operations.value, op];
}

function resetOperations() {
  operations.value = [];
}

/** 列选择：用一个简单的多选面板，而不是让用户手写列号。 */
const columnPickOpen = ref(false);
const pickedColumns = ref([]);
function openColumnPick() {
  pickedColumns.value = Array.from({ length: columnCount.value }, (_, i) => i);
  columnPickOpen.value = true;
}
function applyColumnPick() {
  addOperation({ kind: "selectColumns", indexes: [...pickedColumns.value] });
  columnPickOpen.value = false;
}

/** 过滤：列 + 条件 + 值。 */
const filterOpen = ref(false);
const filterForm = ref({ columnIndex: 0, op: "contains", value: "" });
function applyFilter() {
  addOperation({ ...filterForm.value, kind: "filter" });
  filterOpen.value = false;
}

async function copyExport() {
  if (!exportText.value) return;
  try {
    await navigator.clipboard.writeText(exportText.value);
    props.showToast(t("toolbox.table.copied"));
  } catch {
    props.showToast(t("toolbox.table.copyFailed"));
  }
}

function downloadExport() {
  if (!exportText.value) return;
  const extensions = { csv: "csv", tsv: "tsv", json: "json", markdown: "md", sql: "sql" };
  const blob = new Blob([exportText.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `table.${extensions[exportFormat.value] || "txt"}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  props.showToast(t("toolbox.table.saved"));
}

/** 从剪贴板粘贴（桌面端最常见的入口：从 Excel 复制一片区域）。 */
async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      props.showToast(t("toolbox.table.clipboardEmpty"));
      return;
    }
    input.value = text;
    // 粘贴后重新嗅探（用户换了数据源，分隔符可能不同）
    delimiter.value = "auto";
    resetOperations();
  } catch (e) {
    props.showToast(t("toolbox.table.clipboardFailed", { err: e?.message || String(e) }));
  }
}

function clearAll() {
  input.value = "";
  operations.value = [];
  error.value = "";
}

// 持久化输入与选项（与其它工具一致：切走再回来还在）
loadToolbox("table", {}).then((saved) => {
  if (!saved || typeof saved !== "object") return;
  if (typeof saved.input === "string") input.value = saved.input;
  if (typeof saved.delimiter === "string") delimiter.value = saved.delimiter;
  if (typeof saved.hasHeader === "boolean") hasHeader.value = saved.hasHeader;
  if (typeof saved.exportFormat === "string") exportFormat.value = saved.exportFormat;
  if (typeof saved.sqlTable === "string") sqlTable.value = saved.sqlTable;
});

watch([input, delimiter, hasHeader, exportFormat, sqlTable], () => {
  saveToolbox("table", {
    input: input.value,
    delimiter: delimiter.value,
    hasHeader: hasHeader.value,
    exportFormat: exportFormat.value,
    sqlTable: sqlTable.value,
  });
});

const delimiterLabel = computed(() => {
  if (delimiter.value !== "auto") {
    const found = DELIMITERS.find((item) => item.char === delimiter.value);
    return found ? t(found.labelKey) : delimiter.value;
  }
  const found = DELIMITERS.find((item) => item.char === activeDelimiter.value);
  return `${t("toolbox.table.delimAuto")}（${found ? t(found.labelKey) : activeDelimiter.value}）`;
});

/** 显示用的错误：解析错误优先，其次是操作类错误。 */
const shownError = computed(() => parsed.value.parseError || error.value);
</script>

<template>
  <div class="tool-table">
    <div class="tt-toolbar">
      <button class="tt-btn" data-role="paste" :title="t('toolbox.table.paste')" @click="pasteFromClipboard">
        <Icon name="clipboard" /> {{ t("toolbox.table.paste") }}
      </button>
      <label class="tt-field">
        <span>{{ t("toolbox.table.delimiter") }}</span>
        <select v-model="delimiter" data-role="delimiter">
          <option value="auto">{{ t("toolbox.table.delimAuto") }}</option>
          <option v-for="item in DELIMITERS" :key="item.key" :value="item.char">{{ t(item.labelKey) }}</option>
        </select>
      </label>
      <label class="tt-check">
        <input v-model="hasHeader" type="checkbox" data-role="has-header" />
        <span>{{ t("toolbox.table.hasHeader") }}</span>
      </label>
      <button class="tt-btn" :disabled="!table.length" data-role="clear" @click="clearAll">{{ t("toolbox.table.clear") }}</button>
      <span class="tt-hint" data-role="detected">{{ delimiterLabel }}</span>
    </div>

    <p v-if="shownError" class="tt-err" data-role="error">{{ shownError }}</p>

    <!-- 输入区 -->
    <textarea
      v-if="!table.length"
      v-model="input"
      class="tt-input"
      rows="12"
      spellcheck="false"
      data-role="input"
      :placeholder="t('toolbox.table.inputPh')"
    ></textarea>

    <template v-else>
      <!-- 统计：清洗前先看清数据长什么样 -->
      <div class="tt-stats" data-role="stats">
        <span>{{ t("toolbox.table.statRows", { n: tableStats.rows }) }}</span>
        <span>{{ t("toolbox.table.statColumns", { n: tableStats.columns }) }}</span>
        <span>{{ t("toolbox.table.statEmpty", { n: tableStats.empty }) }}</span>
        <span v-if="tableStats.duplicates">{{ t("toolbox.table.statDuplicates", { n: tableStats.duplicates }) }}</span>
      </div>

      <!-- 清洗操作 -->
      <div class="tt-toolbar">
        <button class="tt-btn" data-role="dedupe" @click="addOperation({ kind: 'dedupe' })">{{ t("toolbox.table.opDedupe") }}</button>
        <button class="tt-btn" data-role="remove-empty" @click="addOperation({ kind: 'removeEmpty' })">{{ t("toolbox.table.opRemoveEmpty") }}</button>
        <button class="tt-btn" data-role="pick-columns" @click="openColumnPick">{{ t("toolbox.table.opColumns") }}</button>
        <button class="tt-btn" data-role="open-filter" @click="filterOpen = !filterOpen">{{ t("toolbox.table.opFilter") }}</button>
        <button v-if="operations.length" class="tt-btn" data-role="reset-ops" @click="resetOperations">
          {{ t("toolbox.table.opReset", { n: operations.length }) }}
        </button>
      </div>

      <!-- 过滤面板 -->
      <div v-if="filterOpen" class="tt-panel" data-role="filter-panel">
        <label class="tt-field">
          <span>{{ t("toolbox.table.filterColumn") }}</span>
          <select v-model.number="filterForm.columnIndex" data-role="filter-column">
            <option v-for="index in columnCount" :key="index" :value="index - 1">{{ header[index - 1] || t("toolbox.table.colN", { n: index }) }}</option>
          </select>
        </label>
        <label class="tt-field">
          <span>{{ t("toolbox.table.filterOp") }}</span>
          <select v-model="filterForm.op" data-role="filter-op">
            <option value="contains">{{ t("toolbox.table.opContains") }}</option>
            <option value="equals">{{ t("toolbox.table.opEquals") }}</option>
            <option value="notEmpty">{{ t("toolbox.table.opNotEmpty") }}</option>
          </select>
        </label>
        <label v-if="filterForm.op !== 'notEmpty'" class="tt-field">
          <span>{{ t("toolbox.table.filterValue") }}</span>
          <input v-model="filterForm.value" data-role="filter-value" />
        </label>
        <button class="tt-btn primary" data-role="apply-filter" @click="applyFilter">{{ t("common.confirm") }}</button>
      </div>

      <!-- 列选择面板 -->
      <div v-if="columnPickOpen" class="tt-panel" data-role="column-panel">
        <label v-for="index in columnCount" :key="index" class="tt-check">
          <input v-model="pickedColumns" type="checkbox" :value="index - 1" />
          <span>{{ header[index - 1] || t("toolbox.table.colN", { n: index }) }}</span>
        </label>
        <button class="tt-btn primary" data-role="apply-columns" @click="applyColumnPick">{{ t("common.confirm") }}</button>
      </div>

      <!-- 表格视图：点列头排序 -->
      <div class="tt-wrap">
        <table class="tt-table" data-role="table">
          <thead v-if="hasHeader">
            <tr>
              <th class="tt-rownum"></th>
              <th
                v-for="(cell, index) in header"
                :key="index"
                class="tt-sortable"
                :data-sort="sortState?.index === index ? sortState.direction : ''"
                @click="sortByColumn(index)"
              >
                {{ cell || t("toolbox.table.colN", { n: index + 1 }) }}
                <span v-if="sortState?.index === index" class="tt-arrow">{{ sortState.direction === "asc" ? "▲" : "▼" }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in visibleBody" :key="rowIndex">
              <td class="tt-rownum">{{ rowIndex + 1 }}</td>
              <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="body.length > visibleBody.length" class="tt-hint" data-role="more-rows">
        {{ t("toolbox.table.moreRows", { shown: visibleBody.length, total: body.length }) }}
        <button class="tt-btn" data-role="show-more" @click="previewLimit += 500">{{ t("toolbox.table.showMore") }}</button>
      </p>
      <p v-if="parsed.truncated" class="tt-hint" data-role="truncated">{{ t("toolbox.table.truncated", { n: MAX_ROWS }) }}</p>

      <!-- 导出 -->
      <div class="tt-toolbar">
        <label class="tt-field">
          <span>{{ t("toolbox.table.exportAs") }}</span>
          <select v-model="exportFormat" data-role="export-format">
            <option v-for="item in EXPORTS" :key="item.key" :value="item.key">{{ item.label }}</option>
          </select>
        </label>
        <label v-if="exportFormat === 'sql'" class="tt-field">
          <span>{{ t("toolbox.table.sqlTable") }}</span>
          <input v-model="sqlTable" data-role="sql-table" />
        </label>
        <button class="tt-btn" data-role="copy-export" @click="copyExport">{{ t("toolbox.table.copyExport") }}</button>
        <button class="tt-btn primary" data-role="download-export" @click="downloadExport">{{ t("toolbox.table.downloadExport") }}</button>
      </div>
      <textarea class="tt-output" rows="8" readonly spellcheck="false" data-role="export-output" :value="exportText"></textarea>
    </template>
  </div>
</template>

<style scoped>
.tool-table {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.tt-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.tt-btn {
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

.tt-btn:hover:not(:disabled) {
  border-color: var(--primary);
}

.tt-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tt-btn.primary {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.tt-field,
.tt-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  color: var(--muted);
}

.tt-field select,
.tt-field input {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text);
}

.tt-input,
.tt-output {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
  line-height: 1.5;
  resize: vertical;
}

.tt-input {
  flex: 1;
  min-height: 200px;
}

.tt-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 0.82rem;
  color: var(--muted);
}

.tt-err {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 0.85rem;
}

.tt-hint {
  margin: 0;
  font-size: 0.8rem;
  color: var(--muted);
}

.tt-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--soft);
}

/* 表格：列多时横向滚动，不折行（折行会让列对不齐） */
.tt-wrap {
  flex: 1;
  min-height: 120px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.tt-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.82rem;
  white-space: nowrap;
}

.tt-table th,
.tt-table td {
  padding: 5px 10px;
  border-bottom: 1px solid var(--border);
  border-right: 1px solid var(--border);
  text-align: left;
}

.tt-table th {
  position: sticky;
  top: 0;
  background: var(--soft);
  font-weight: 600;
  z-index: 1;
}

.tt-sortable {
  cursor: pointer;
  user-select: none;
}

.tt-sortable:hover {
  color: var(--primary);
}

.tt-arrow {
  margin-left: 4px;
  color: var(--primary);
  font-size: 0.7rem;
}

/* 行号列：固定宽度、右对齐，便于定位 */
.tt-rownum {
  width: 44px;
  color: var(--muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
  background: var(--soft);
}
</style>
