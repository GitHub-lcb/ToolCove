<script setup>
// 表格工具（手机端）：粘贴分隔文本 → 表格视图 → 清洗 → 导出。
//
// 与桌面端**共用同一份纯逻辑** src/tableTool.js（54 条单测），所以解析/转换/清洗的结果两端一致。
// 界面按手机重排：
//   · 表格横向滚动 + 首列行号固定（手机上列多时必须能定位）
//   · 操作收进 chips（横排可滚动），不摆一排按钮挤成两行
//   · 排序点列头（与桌面同一交互，手机上也好点）
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { loadToolbox, saveToolbox } from "../../../src/toolboxStore.js";
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
} from "../../../src/tableTool.js";

const { t } = useI18n();

const input = ref("");
const delimiter = ref("auto");
const hasHeader = ref(true);
const error = ref("");
const notice = ref("");
const previewLimit = ref(100);
const operations = ref([]);

const activeDelimiter = computed(() => (delimiter.value === "auto" ? detectDelimiter(input.value) : delimiter.value));

/**
 * 解析结果。
 *
 * ⚠️ computed 必须是**纯函数**：不能在里面对 error 之类的 ref 赋值
 * （eslint 的 vue/no-side-effects-in-computed-properties 会拦，而且确实会导致依赖追踪错乱）。
 * 所以解析错误作为返回值的一部分带出来，由模板显示。
 */
const parsed = computed(() => {
  if (!input.value.trim()) return { rows: [], truncated: false, totalRows: 0, parseError: "" };
  try {
    return { ...parseDelimited(input.value, activeDelimiter.value), parseError: "" };
  } catch (e) {
    return { rows: [], truncated: false, totalRows: 0, parseError: e?.message || String(e) };
  }
});

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

const EXPORTS = computed(() => [
  { key: "csv", label: "CSV" },
  { key: "tsv", label: "TSV" },
  { key: "json", label: "JSON" },
  { key: "markdown", label: t("toolbox.table.exportMarkdown") },
  { key: "sql", label: t("toolbox.table.exportSql") },
]);
const exportFormat = ref("csv");
const sqlTable = ref("t");
const showExport = ref(false);

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

function sortByColumn(index) {
  const last = operations.value.find((op) => op.kind === "sort");
  const direction = last?.columnIndex === index && last.direction === "asc" ? "desc" : "asc";
  // 排序是替换语义：叠加两次排序没有意义
  operations.value = [...operations.value.filter((op) => op.kind !== "sort"), { kind: "sort", columnIndex: index, direction, numeric: true }];
}
const sortState = computed(() => operations.value.find((op) => op.kind === "sort") || null);

const filterOpen = ref(false);
const filterForm = ref({ columnIndex: 0, op: "contains", value: "" });
function applyFilter() {
  operations.value = [...operations.value, { ...filterForm.value, kind: "filter" }];
  filterOpen.value = false;
}

const columnPickOpen = ref(false);
const pickedColumns = ref([]);
function openColumnPick() {
  pickedColumns.value = Array.from({ length: columnCount.value }, (_, i) => i);
  columnPickOpen.value = true;
}
function applyColumnPick() {
  operations.value = [...operations.value, { kind: "selectColumns", indexes: [...pickedColumns.value] }];
  columnPickOpen.value = false;
}

async function pasteFromClipboard() {
  error.value = "";
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      notice.value = t("toolbox.table.clipboardEmpty");
      return;
    }
    input.value = text;
    delimiter.value = "auto";
    operations.value = [];
  } catch (e) {
    error.value = t("toolbox.table.clipboardFailed", { err: e?.message || String(e) });
  }
}

async function copyExport() {
  if (!exportText.value) return;
  try {
    await navigator.clipboard.writeText(exportText.value);
    notice.value = t("toolbox.table.copied");
    setTimeout(() => (notice.value = ""), 2000);
  } catch (e) {
    error.value = t("toolbox.table.copyFailed");
  }
}

/** 手机上"导出"就是下载/分享：用 <a download>，系统会给出保存或分享入口。 */
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
  notice.value = t("toolbox.table.saved");
}

function clearAll() {
  input.value = "";
  operations.value = [];
  error.value = "";
  notice.value = "";
}

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
  const char = activeDelimiter.value;
  const found = DELIMITERS.find((item) => item.char === char);
  const name = found ? t(found.labelKey) : char;
  return delimiter.value === "auto" ? `${t("toolbox.table.delimAuto")}（${name}）` : name;
});

/** 显示用的错误：解析错误优先，其次是操作类错误。 */
const shownError = computed(() => parsed.value.parseError || error.value);
</script>

<template>
  <section class="m-tool" data-tool="table">
    <!-- 输入区 -->
    <template v-if="!table.length">
      <p class="m-hint-sm" data-role="input-hint">{{ t("toolbox.table.inputPh") }}</p>
      <label class="m-field">
        <span>{{ t("toolbox.table.inputLabel") }}</span>
        <textarea v-model="input" rows="10" spellcheck="false" data-role="input"></textarea>
      </label>
      <div class="m-actions">
        <button class="m-btn primary" data-role="paste" @click="pasteFromClipboard">{{ t("toolbox.table.paste") }}</button>
      </div>
    </template>

    <!-- 表格视图 -->
    <template v-else>
      <div class="m-chips" data-role="toolbar">
        <button class="m-chip" data-role="toggle-delimiter" @click="delimiter = delimiter === 'auto' ? ',' : 'auto'">
          {{ delimiterLabel }}
        </button>
        <button class="m-chip" :class="{ on: hasHeader }" data-role="has-header" @click="hasHeader = !hasHeader">
          {{ t("toolbox.table.hasHeader") }}
        </button>
        <button class="m-chip" data-role="dedupe" @click="operations = [...operations, { kind: 'dedupe' }]">{{ t("toolbox.table.opDedupe") }}</button>
        <button class="m-chip" data-role="remove-empty" @click="operations = [...operations, { kind: 'removeEmpty' }]">{{ t("toolbox.table.opRemoveEmpty") }}</button>
        <button class="m-chip" data-role="pick-columns" @click="openColumnPick">{{ t("toolbox.table.opColumns") }}</button>
        <button class="m-chip" data-role="open-filter" @click="filterOpen = !filterOpen">{{ t("toolbox.table.opFilter") }}</button>
        <button v-if="operations.length" class="m-chip" data-role="reset-ops" @click="operations = []">
          {{ t("toolbox.table.opReset", { n: operations.length }) }}
        </button>
        <button class="m-chip" data-role="clear" @click="clearAll">{{ t("toolbox.table.clear") }}</button>
      </div>

      <!-- 统计 -->
      <ul class="m-stats" data-role="stats">
        <li><b>{{ t("toolbox.table.statRows", { n: tableStats.rows }) }}</b><span>{{ t("toolbox.table.statColumns", { n: tableStats.columns }) }}</span></li>
        <li><b>{{ t("toolbox.table.statEmpty", { n: tableStats.empty }) }}</b><span>{{ t("toolbox.table.statDuplicates", { n: tableStats.duplicates }) }}</span></li>
      </ul>

      <!-- 过滤面板 -->
      <div v-if="filterOpen" class="m-card" data-role="filter-panel">
        <label class="m-field">
          <span>{{ t("toolbox.table.filterColumn") }}</span>
          <select v-model.number="filterForm.columnIndex" data-role="filter-column">
            <option v-for="index in columnCount" :key="index" :value="index - 1">{{ header[index - 1] || t("toolbox.table.colN", { n: index }) }}</option>
          </select>
        </label>
        <label class="m-field">
          <span>{{ t("toolbox.table.filterOp") }}</span>
          <select v-model="filterForm.op" data-role="filter-op">
            <option value="contains">{{ t("toolbox.table.opContains") }}</option>
            <option value="equals">{{ t("toolbox.table.opEquals") }}</option>
            <option value="notEmpty">{{ t("toolbox.table.opNotEmpty") }}</option>
          </select>
        </label>
        <label v-if="filterForm.op !== 'notEmpty'" class="m-field">
          <span>{{ t("toolbox.table.filterValue") }}</span>
          <input v-model="filterForm.value" data-role="filter-value" />
        </label>
        <button class="m-btn primary" data-role="apply-filter" @click="applyFilter">{{ t("common.confirm") }}</button>
      </div>

      <!-- 列选择 -->
      <div v-if="columnPickOpen" class="m-card" data-role="column-panel">
        <label v-for="index in columnCount" :key="index" class="m-check">
          <input v-model="pickedColumns" type="checkbox" :value="index - 1" />
          <span>{{ header[index - 1] || t("toolbox.table.colN", { n: index }) }}</span>
        </label>
        <button class="m-btn primary" data-role="apply-columns" @click="applyColumnPick">{{ t("common.confirm") }}</button>
      </div>

      <!-- 表格：横向滚动，点列头排序 -->
      <div class="m-table-wrap">
        <table class="m-table" data-role="table">
          <thead v-if="hasHeader">
            <tr>
              <th class="m-rownum"></th>
              <th
                v-for="(cell, index) in header"
                :key="index"
                :data-sort="sortState?.columnIndex === index ? sortState.direction : ''"
                @click="sortByColumn(index)"
              >
                {{ cell || t("toolbox.table.colN", { n: index + 1 }) }}
                <span v-if="sortState?.columnIndex === index">{{ sortState.direction === "asc" ? "▲" : "▼" }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in visibleBody" :key="rowIndex">
              <td class="m-rownum">{{ rowIndex + 1 }}</td>
              <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="body.length > visibleBody.length" class="m-hint-sm" data-role="more-rows">
        {{ t("toolbox.table.moreRows", { shown: visibleBody.length, total: body.length }) }}
        <button class="m-op" data-role="show-more" @click="previewLimit += 300">{{ t("toolbox.table.showMore") }}</button>
      </p>
      <p v-if="parsed.truncated" class="m-err" data-role="truncated">{{ t("toolbox.table.truncated", { n: MAX_ROWS }) }}</p>

      <!-- 导出 -->
      <div class="m-chips">
        <button class="m-chip" :class="{ on: showExport }" data-role="toggle-export" @click="showExport = !showExport">
          {{ t("toolbox.table.exportAs") }}
        </button>
      </div>
      <template v-if="showExport">
        <div class="m-chips" data-role="export-formats">
          <button v-for="item in EXPORTS" :key="item.key" class="m-chip" :class="{ on: exportFormat === item.key }" :data-format="item.key" @click="exportFormat = item.key">
            {{ item.label }}
          </button>
        </div>
        <label v-if="exportFormat === 'sql'" class="m-field">
          <span>{{ t("toolbox.table.sqlTable") }}</span>
          <input v-model="sqlTable" data-role="sql-table" />
        </label>
        <label class="m-field">
          <span>{{ t("toolbox.table.exportResult") }}</span>
          <textarea :value="exportText" rows="8" readonly spellcheck="false" data-role="export-output"></textarea>
        </label>
        <div class="m-actions">
          <button class="m-btn primary" data-role="download-export" @click="downloadExport">{{ t("toolbox.table.downloadExport") }}</button>
          <button class="m-btn" data-role="copy-export" @click="copyExport">{{ t("toolbox.table.copyExport") }}</button>
        </div>
      </template>
    </template>

    <p v-if="shownError" class="m-err" data-role="error">{{ shownError }}</p>
    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
  </section>
</template>
