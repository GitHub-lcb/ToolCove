<script setup>
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { save as saveDialog, open as openDialog } from "../platform/dialog.js";
import { downloadBlob } from "../platform/download.js";
import { isDesktop } from "../platform/env.js";
import { useDragSort } from "../dragsort.js";
import { formatFileSize } from "../fileTool.js";
import Icon from "../Icon.vue";
import {
  buildSplitGroups,
  extractPages,
  formatPageRanges,
  mergePdfs,
  normalizeAngle,
  parseRangeGroups,
  pdfOutputName,
  readPdfSummary,
  removePages,
  rotatePages,
  splitPdf,
} from "../pdfTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];
const MODES = computed(() => [
  { key: "merge", label: t("toolbox.pdf.modeMerge") },
  { key: "pages", label: t("toolbox.pdf.modePages") },
  { key: "split", label: t("toolbox.pdf.modeSplit") },
]);

// 逻辑层错误 code → i18n 文案；未登记的 code 直接回显原始信息
const ERROR_KEYS = {
  encrypted: "toolbox.pdf.errEncrypted",
  invalid: "toolbox.pdf.errInvalid",
  emptyInput: "toolbox.pdf.errEmptyInput",
  emptySelection: "toolbox.pdf.errEmptySelection",
  emptyResult: "toolbox.pdf.errEmptyResult",
  rangeInvalid: "toolbox.pdf.errRangeInvalid",
  rangeOutOfRange: "toolbox.pdf.errRangeOutOfRange",
};

const mode = ref("merge");
const busy = ref(false);
const notice = ref(""); // 当前模式的提示/错误文本（成功提示走 showToast）
const noticeKind = ref("error"); // error | warn（越界钳制等属于提醒，不该显示成报错）
const mergeInput = ref(null);
const singleInput = ref(null);

// —— 合并模式 ——
const mergeItems = ref([]); // [{ id, name, size, bytes, pageCount, invalid }]
// —— 页面模式 / 拆分模式共用的单文件 ——
const source = ref(null); // { id, name, size, bytes, ...readPdfSummary }
const selected = ref([]); // 选中的页（0 基，按点击顺序）
const rotation = ref({}); // { 页码: 增量角度 }
const rangeInput = ref(""); // 页面模式：按范围追加选中
const splitRange = ref(""); // 拆分模式：留空 = 每页一个文件

const { dragId, overId, onDragStart, onDragOver, onDrop, onDragEnd } = useDragSort(() => mergeItems.value);

const validMergeItems = computed(() => mergeItems.value.filter((item) => !item.invalid));
const mergePageTotal = computed(() => validMergeItems.value.reduce((sum, item) => sum + item.pageCount, 0));
const canMerge = computed(() => validMergeItems.value.length >= 2 && !busy.value);

const pageList = computed(() => (source.value ? Array.from({ length: source.value.pageCount }, (_, i) => i) : []));
const selectedSet = computed(() => new Set(selected.value));
const rotatedCount = computed(() => Object.values(rotation.value).filter((delta) => normalizeAngle(delta) !== 0).length);
const keptIndices = computed(() => pageList.value.filter((index) => !selectedSet.value.has(index)));
const sizeSummary = computed(() =>
  (source.value?.sizes || []).map((item) => `${item.label} × ${item.count}`).join("  ·  ")
);

const splitGroups = computed(() => (source.value ? buildSplitGroups(splitRange.value, source.value.pageCount) : []));
// 文件名用规范化范围（1~3 → 1-3），保证预览与实际落盘完全一致
const splitFiles = computed(() =>
  splitGroups.value.map((group) => ({
    token: group.token,
    count: group.indices.length,
    name: pdfOutputName(source.value?.name, formatPageRanges(group.indices)),
  }))
);

/** 旋转增量映射到输出文档：输出第 j 页来自源第 order[j] 页。 */
function rotationForOrder(order) {
  const map = {};
  order.forEach((sourceIndex, outputIndex) => {
    const delta = rotation.value[sourceIndex];
    if (delta && normalizeAngle(delta) !== 0) map[outputIndex] = delta;
  });
  return map;
}

function errorText(error) {
  const key = ERROR_KEYS[error?.code];
  if (!key) return error instanceof Error ? error.message : String(error);
  return error.detail ? t(key, { name: error.detail }) : t(key);
}
function fail(error) {
  noticeKind.value = "error";
  notice.value = errorText(error);
  props.showToast(notice.value);
}
function warn(text) {
  noticeKind.value = "warn";
  notice.value = text;
}

/** 读取 PDF 字节并做概要解析：加密/非 PDF 在入库阶段就被拦下。 */
async function readFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const summary = await readPdfSummary(bytes);
  return { bytes, ...summary };
}
function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error(t("toolbox.pdf.errRead")));
    reader.readAsDataURL(new Blob([bytes], { type: "application/pdf" }));
  });
}

/** 落盘：桌面端走系统保存框 + export_file_b64，浏览器端直接下载。 */
async function saveBytes(bytes, name, title) {
  const target = await saveDialog({ title: title || t("toolbox.pdf.saveTitle"), defaultPath: name, filters: PDF_FILTER });
  if (!target) return false;
  const blob = new Blob([bytes], { type: "application/pdf" });
  if (isDesktop) await invoke("export_file_b64", { path: target, contentB64: await bytesToBase64(blob) });
  else downloadBlob(blob, target);
  return true;
}

function resetSingle() {
  selected.value = [];
  rotation.value = {};
  rangeInput.value = "";
  splitRange.value = "";
  notice.value = "";
}
function selectMode(key) {
  mode.value = key;
  notice.value = "";
}

// —— 合并 ——
async function onMergeFiles(event) {
  const files = [...(event.target.files || [])];
  event.target.value = "";
  if (!files.length) return;
  busy.value = true;
  notice.value = "";
  for (const file of files) {
    const item = { id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: file.name, size: file.size, bytes: null, pageCount: 0, invalid: "" };
    try {
      const loaded = await readFile(file);
      item.bytes = loaded.bytes;
      item.pageCount = loaded.pageCount;
    } catch (error) {
      item.invalid = errorText(error);
    }
    mergeItems.value.push(item);
  }
  busy.value = false;
}
function removeMergeItem(item) {
  mergeItems.value = mergeItems.value.filter((entry) => entry.id !== item.id);
}
function clearMerge() {
  mergeItems.value = [];
  notice.value = "";
}
function moveMergeItem(index, step) {
  const target = index + step;
  if (target < 0 || target >= mergeItems.value.length) return;
  const list = mergeItems.value;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
}
async function doMerge() {
  if (!canMerge.value) return;
  busy.value = true;
  notice.value = "";
  try {
    const bytes = await mergePdfs(validMergeItems.value.map((item) => item.bytes));
    const name = pdfOutputName(validMergeItems.value[0].name, t("toolbox.pdf.suffixMerged"));
    if (await saveBytes(bytes, name, t("toolbox.pdf.saveMerged"))) props.showToast(t("toolbox.pdf.doneSaved", { name }));
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
}

// —— 页面 / 拆分 共用的单文件选择 ——
async function onSingleFile(event) {
  const file = (event.target.files || [])[0];
  event.target.value = "";
  if (!file) return;
  busy.value = true;
  resetSingle();
  try {
    source.value = { id: `${file.name}-${file.size}`, name: file.name, size: file.size, ...(await readFile(file)) };
  } catch (error) {
    source.value = null;
    fail(error);
  } finally {
    busy.value = false;
  }
}
function clearSingle() {
  source.value = null;
  resetSingle();
}

// —— 页面操作 ——
function togglePage(index) {
  const list = [...selected.value];
  const at = list.indexOf(index);
  if (at >= 0) list.splice(at, 1);
  else list.push(index);
  selected.value = list;
}
function selectAllPages() {
  selected.value = [...pageList.value];
}
function invertSelection() {
  selected.value = pageList.value.filter((index) => !selectedSet.value.has(index));
}
function clearSelection() {
  selected.value = [];
}
function applyRangeToSelection() {
  const text = rangeInput.value.trim();
  if (!text || !source.value) return;
  const { groups, invalid, outOfRange } = parseRangeGroups(text, source.value.pageCount);
  if (invalid.length) return fail({ code: "rangeInvalid", detail: invalid.join(", ") });
  if (!groups.length) return fail({ code: "rangeOutOfRange", detail: outOfRange.join(", ") });
  const merged = new Set(selected.value);
  for (const group of groups) for (const index of group.indices) merged.add(index);
  selected.value = [...merged].sort((a, b) => a - b);
  if (outOfRange.length) warn(t("toolbox.pdf.warnRangeClamped", { tokens: outOfRange.join(", ") }));
  else notice.value = "";
}
function rotateSelection(step) {
  if (!selected.value.length) return fail({ code: "emptySelection" });
  const next = { ...rotation.value };
  for (const index of selected.value) {
    const value = normalizeAngle((next[index] || 0) + step);
    if (value) next[index] = value;
    else delete next[index];
  }
  rotation.value = next;
  notice.value = "";
}
function rotationBadge(index) {
  const delta = normalizeAngle(rotation.value[index] || 0);
  return delta ? `↻${delta}°` : "";
}
async function saveRotated() {
  if (!source.value) return;
  if (!rotatedCount.value) return fail({ code: "emptySelection" });
  busy.value = true;
  notice.value = "";
  try {
    const bytes = await rotatePages(source.value.bytes, rotation.value);
    const name = pdfOutputName(source.value.name, t("toolbox.pdf.suffixRotated"));
    if (await saveBytes(bytes, name, t("toolbox.pdf.saveRotated"))) props.showToast(t("toolbox.pdf.doneSaved", { name }));
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
}
async function doExtract() {
  if (!source.value || !selected.value.length) return fail({ code: "emptySelection" });
  busy.value = true;
  notice.value = "";
  try {
    // 按文档顺序输出：点击顺序不是排序意图，也让文件名里的范围与实际页序一致
    const order = [...selected.value].sort((a, b) => a - b);
    let bytes = await extractPages(source.value.bytes, order);
    const map = rotationForOrder(order);
    if (Object.keys(map).length) bytes = await rotatePages(bytes, map);
    const name = pdfOutputName(source.value.name, formatPageRanges(order));
    if (await saveBytes(bytes, name, t("toolbox.pdf.saveExtract"))) props.showToast(t("toolbox.pdf.doneSaved", { name }));
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
}
async function doRemove() {
  if (!source.value || !selected.value.length) return fail({ code: "emptySelection" });
  busy.value = true;
  notice.value = "";
  try {
    const order = keptIndices.value;
    let bytes = await removePages(source.value.bytes, selected.value);
    const map = rotationForOrder(order);
    if (Object.keys(map).length) bytes = await rotatePages(bytes, map);
    const name = pdfOutputName(source.value.name, t("toolbox.pdf.suffixRemain"));
    if (await saveBytes(bytes, name, t("toolbox.pdf.saveRemove"))) props.showToast(t("toolbox.pdf.doneSaved", { name }));
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
}

// —— 拆分 ——
async function doSplit() {
  if (!source.value) return;
  if (!splitGroups.value.length) return fail({ code: "emptySelection" });
  busy.value = true;
  notice.value = "";
  try {
    const parts = await splitPdf(source.value.bytes, splitGroups.value);
    const outputs = parts.map((part) => ({ name: pdfOutputName(source.value.name, formatPageRanges(part.indices)), bytes: part.bytes }));
    if (isDesktop) {
      const directory = await openDialog({ directory: true, title: t("toolbox.pdf.pickSplitDir") });
      if (!directory) return;
      const separator = String(directory).includes("\\") ? "\\" : "/";
      for (const output of outputs) {
        const path = `${String(directory).replace(/[\\/]$/, "")}${separator}${output.name}`;
        await invoke("export_file_b64", { path, contentB64: await bytesToBase64(output.bytes) });
      }
    } else {
      for (const output of outputs) {
        downloadBlob(new Blob([output.bytes], { type: "application/pdf" }), output.name);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    props.showToast(t("toolbox.pdf.doneSplit", { n: outputs.length }));
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="pdf-tool">
    <nav class="mode-tabs" :aria-label="t('toolbox.pdf.navLabel')">
      <button v-for="item in MODES" :key="item.key" class="mode-tab" :class="{ on: mode === item.key }" type="button" @click="selectMode(item.key)">
        {{ item.label }}
      </button>
    </nav>

    <!-- 合并：多文件 + 排序 -->
    <template v-if="mode === 'merge'">
      <div class="action-bar">
        <input ref="mergeInput" class="hidden-input" type="file" accept="application/pdf,.pdf" multiple @change="onMergeFiles" />
        <button class="btn-outline" type="button" :disabled="busy" @click="mergeInput?.click()"><Icon name="plus" :size="15" />{{ t("toolbox.pdf.addFiles") }}</button>
        <button class="btn-ghost sm" type="button" :disabled="!mergeItems.length || busy" @click="clearMerge">{{ t("toolbox.pdf.clearList") }}</button>
        <span class="bar-hint">{{ t("toolbox.pdf.mergeHint") }}</span>
        <span class="action-spacer"></span>
        <span v-if="mergeItems.length" class="bar-stat">{{ t("toolbox.pdf.mergeStat", { n: validMergeItems.length, pages: mergePageTotal }) }}</span>
        <button class="btn-primary sm" type="button" :disabled="!canMerge" @click="doMerge">{{ t("toolbox.pdf.mergeAction") }}</button>
      </div>

      <section class="panel">
        <header class="panel-head">
          <b>{{ t("toolbox.pdf.mergeList") }}</b>
          <span>{{ t("toolbox.pdf.fileCount", { n: mergeItems.length }) }}</span>
        </header>
        <p v-if="notice" class="notice" :class="noticeKind" role="alert">{{ notice }}</p>

        <div v-if="mergeItems.length" class="file-list">
          <div
            v-for="(item, index) in mergeItems"
            :key="item.id"
            class="file-row"
            :class="{ invalid: item.invalid, dragging: dragId === item.id, over: overId === item.id }"
            draggable="true"
            @dragstart="onDragStart($event, item.id)"
            @dragover="onDragOver($event, item.id)"
            @drop="onDrop($event, item.id)"
            @dragend="onDragEnd"
          >
            <span class="row-order">{{ index + 1 }}</span>
            <span class="row-ico"><Icon name="file" :size="18" /></span>
            <span class="row-info">
              <b class="row-name" :title="item.name">{{ item.name }}</b>
              <small v-if="item.invalid" class="row-err">{{ item.invalid }}</small>
              <small v-else>{{ t("toolbox.pdf.rowMeta", { pages: item.pageCount, size: formatFileSize(item.size) }) }}</small>
            </span>
            <span class="row-move">
              <button class="icon-btn xs" type="button" :title="t('toolbox.pdf.moveUp')" :aria-label="t('toolbox.pdf.moveUp')" :disabled="index === 0" @click="moveMergeItem(index, -1)"><Icon name="chevron" :size="14" /></button>
              <button class="icon-btn xs" type="button" :title="t('toolbox.pdf.moveDown')" :aria-label="t('toolbox.pdf.moveDown')" :disabled="index === mergeItems.length - 1" @click="moveMergeItem(index, 1)"><Icon name="chevron" :size="14" class="flip" /></button>
            </span>
            <button class="icon-btn xs danger" type="button" :title="t('toolbox.pdf.removeRow')" :aria-label="t('toolbox.pdf.removeRow')" @click="removeMergeItem(item)"><Icon name="trash" :size="14" /></button>
          </div>
        </div>

        <div v-else class="empty-state">
          <span class="empty-ico"><Icon name="layers" :size="28" /></span>
          <b>{{ t("toolbox.pdf.mergeEmptyTitle") }}</b>
          <p>{{ t("toolbox.pdf.mergeEmptyHint") }}</p>
          <button class="btn-outline" type="button" @click="mergeInput?.click()"><Icon name="plus" :size="15" />{{ t("toolbox.pdf.addFiles") }}</button>
        </div>
      </section>
    </template>

    <!-- 页面操作 + 拆分：单文件 -->
    <template v-else>
      <div class="action-bar">
        <input ref="singleInput" class="hidden-input" type="file" accept="application/pdf,.pdf" @change="onSingleFile" />
        <button class="btn-outline" type="button" :disabled="busy" @click="singleInput?.click()">
          <Icon name="file" :size="15" />{{ source ? t("toolbox.pdf.switchFile") : t("toolbox.pdf.pickFile") }}
        </button>
        <span v-if="source" class="file-chip" :title="source.name"><Icon name="file" :size="13" />{{ source.name }}</span>
        <button v-if="source" class="btn-ghost sm" type="button" @click="clearSingle">{{ t("toolbox.pdf.removeFile") }}</button>

        <template v-if="mode === 'pages' && source">
          <span class="action-spacer"></span>
          <input v-model="rangeInput" class="range-input" type="text" :placeholder="t('toolbox.pdf.rangePlaceholder')" :aria-label="t('toolbox.pdf.rangeLabel')" @keyup.enter="applyRangeToSelection" />
          <button class="btn-ghost sm" type="button" @click="applyRangeToSelection">{{ t("toolbox.pdf.rangeApply") }}</button>
          <button class="btn-ghost sm" type="button" @click="selectAllPages">{{ t("toolbox.pdf.selectAll") }}</button>
          <button class="btn-ghost sm" type="button" @click="invertSelection">{{ t("toolbox.pdf.invert") }}</button>
          <button class="btn-ghost sm" type="button" :disabled="!selected.length" @click="clearSelection">{{ t("toolbox.pdf.selectNone") }}</button>
        </template>
        <template v-else-if="source">
          <span class="action-spacer"></span>
          <button class="btn-primary sm" type="button" :disabled="busy || !splitGroups.length" @click="doSplit">{{ t("toolbox.pdf.splitAction") }}</button>
        </template>
      </div>

      <section v-if="source" class="panel">
        <header class="panel-head">
          <b>{{ mode === "pages" ? t("toolbox.pdf.pagesPanel") : t("toolbox.pdf.splitPanel") }}</b>
          <span>{{ t("toolbox.pdf.sourceMeta", { pages: source.pageCount, size: formatFileSize(source.size) }) }}</span>
        </header>
        <p v-if="sizeSummary" class="meta-line">{{ t("toolbox.pdf.sizeLine") }}{{ sizeSummary }}<template v-if="source.title">  ·  {{ t("toolbox.pdf.titleLine") }}{{ source.title }}</template></p>
        <p v-if="notice" class="notice" :class="noticeKind" role="alert">{{ notice }}</p>

        <template v-if="mode === 'pages'">
          <div class="grid-head">
            <span class="grid-stat">{{ t("toolbox.pdf.selectionStat", { total: source.pageCount, n: selected.length }) }}</span>
            <span v-if="rotatedCount" class="grid-stat amber">{{ t("toolbox.pdf.rotatedStat", { n: rotatedCount }) }}</span>
            <span class="action-spacer"></span>
            <button class="icon-btn" type="button" :title="t('toolbox.pdf.rotateLeft')" :aria-label="t('toolbox.pdf.rotateLeft')" :disabled="!selected.length" @click="rotateSelection(-90)"><Icon name="rotate-left" :size="16" /></button>
            <button class="icon-btn" type="button" :title="t('toolbox.pdf.rotateRight')" :aria-label="t('toolbox.pdf.rotateRight')" :disabled="!selected.length" @click="rotateSelection(90)"><Icon name="rotate-right" :size="16" /></button>
          </div>

          <div class="page-grid">
            <button
              v-for="index in pageList"
              :key="index"
              class="page-chip"
              :class="{ on: selectedSet.has(index) }"
              type="button"
              :aria-pressed="selectedSet.has(index)"
              :title="t('toolbox.pdf.pageTip', { n: index + 1 })"
              @click="togglePage(index)"
            >
              <span class="page-no">{{ index + 1 }}</span>
              <span v-if="rotationBadge(index)" class="page-rot">{{ rotationBadge(index) }}</span>
            </button>
          </div>

          <footer class="panel-foot">
            <button class="btn-primary sm" type="button" :disabled="!selected.length || busy" @click="doExtract"><Icon name="copy" :size="15" />{{ t("toolbox.pdf.extractAction") }}</button>
            <button class="btn-outline danger" type="button" :disabled="!selected.length || busy" @click="doRemove"><Icon name="trash" :size="15" />{{ t("toolbox.pdf.removeAction") }}</button>
            <span class="action-spacer"></span>
            <span class="foot-hint">{{ t("toolbox.pdf.rotateHint") }}</span>
            <button class="btn-outline" type="button" :disabled="!rotatedCount || busy" @click="saveRotated"><Icon name="download" :size="15" />{{ t("toolbox.pdf.saveRotated") }}</button>
          </footer>
        </template>

        <template v-else>
          <div class="grid-head">
            <label class="range-field">
              <span>{{ t("toolbox.pdf.splitRangeLabel") }}</span>
              <input v-model="splitRange" class="range-input wide" type="text" :placeholder="t('toolbox.pdf.splitRangePlaceholder')" />
            </label>
            <span class="grid-stat">{{ t("toolbox.pdf.splitPreview", { n: splitFiles.length }) }}</span>
          </div>

          <div v-if="splitFiles.length" class="file-list scroll">
            <div v-for="file in splitFiles" :key="file.token" class="file-row static">
              <span class="row-order">{{ file.token }}</span>
              <span class="row-ico"><Icon name="file" :size="18" /></span>
              <span class="row-info">
                <b class="row-name" :title="file.name">{{ file.name }}</b>
                <small>{{ t("toolbox.pdf.pageCount", { n: file.count }) }}</small>
              </span>
            </div>
          </div>
          <div v-else class="empty-state">
            <span class="empty-ico"><Icon name="alert" :size="26" /></span>
            <b>{{ t("toolbox.pdf.splitEmptyTitle") }}</b>
            <p>{{ t("toolbox.pdf.splitEmptyHint") }}</p>
          </div>
        </template>
      </section>

      <div v-else class="empty-state standalone">
        <span class="empty-ico"><Icon name="file" :size="28" /></span>
        <b>{{ t("toolbox.pdf.pickEmptyTitle") }}</b>
        <p>{{ t("toolbox.pdf.pickEmptyHint") }}</p>
        <button class="btn-outline" type="button" @click="singleInput?.click()"><Icon name="file" :size="15" />{{ t("toolbox.pdf.pickFile") }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pdf-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }

.mode-tabs { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border); }
.mode-tab { flex-shrink: 0; padding: var(--sp-2) var(--sp-4); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text-weak); font-size: var(--fs-md); cursor: pointer; transition: color 0.15s, background 0.15s, border-color 0.15s; }
.mode-tab:hover { color: var(--text); background: var(--ghost); }
.mode-tab.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }

.action-bar { flex-shrink: 0; min-height: 34px; display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.action-spacer { flex: 1; }
.action-bar :disabled, .panel-foot :disabled, .grid-head :disabled { opacity: 0.45; cursor: default; }
.bar-hint { color: var(--muted); font-size: var(--fs-sm); }
.bar-stat { color: var(--text-dim); font-family: var(--font-num); font-size: var(--fs-sm); }
.hidden-input { display: none; }
.flip { transform: rotate(180deg); }
.file-chip { display: inline-flex; align-items: center; gap: var(--sp-1); max-width: 260px; padding: var(--sp-1) var(--sp-3); border-radius: var(--r-pill); background: var(--well); color: var(--text-soft); font-size: var(--fs-sm); }
.file-chip svg { flex-shrink: 0; }
.range-input { width: 180px; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card); color: var(--text); font-family: var(--font-mono); font-size: var(--fs-sm); outline: none; }
.range-input.wide { width: 240px; }
.range-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.range-field { display: inline-flex; align-items: center; gap: var(--sp-2); color: var(--text-weak); font-size: var(--fs-sm); }

.panel { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.panel-head { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.panel-head span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.panel-foot { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); background: var(--card-soft); flex-wrap: wrap; }
.foot-hint { color: var(--muted); font-size: var(--fs-sm); }
.meta-line { flex-shrink: 0; margin: 0; padding: var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--border); color: var(--muted); font-size: var(--fs-sm); }
.notice { flex-shrink: 0; margin: 0; padding: var(--sp-2) var(--sp-4); background: var(--danger-soft); color: var(--danger-deep); font-size: var(--fs-sm); }
.notice.warn { background: var(--amber-soft); color: var(--warn-deep); }

/* 文件列表（合并队列 / 拆分预览） */
.file-list { flex: 1; min-height: 0; overflow: auto; padding: var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-1); }
.file-list.scroll { max-height: 260px; flex: 0 1 auto; }
.file-row { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); border: 1px solid transparent; border-radius: var(--r-sm); background: var(--card); }
.file-row:not(.static) { cursor: grab; }
.file-row:not(.static):hover { border-color: var(--card-border); background: var(--ghost); }
.file-row.dragging { opacity: 0.5; }
.file-row.over { border-color: var(--primary); background: var(--primary-soft); }
.file-row.invalid { border-color: var(--border-danger); background: var(--danger-soft); }
.row-order { flex-shrink: 0; min-width: 26px; padding: 1px 6px; border-radius: var(--r-xs); background: var(--well); color: var(--text-soft); font-family: var(--font-num); font-size: var(--fs-xs); text-align: center; }
.row-ico { flex-shrink: 0; display: grid; place-items: center; color: var(--primary-hover); }
.row-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.row-name { overflow: hidden; font-size: var(--fs-md); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.row-info small { color: var(--muted); font-size: var(--fs-xs); }
.row-err { color: var(--danger-deep); }
.row-move { flex-shrink: 0; display: inline-flex; gap: 2px; }

/* 页面网格 */
.grid-head { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4) var(--sp-2); flex-wrap: wrap; }
.grid-stat { color: var(--muted); font-family: var(--font-num); font-size: var(--fs-sm); }
.grid-stat.amber { color: var(--amber); }
.page-grid { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: var(--sp-2); padding: 0 var(--sp-4) var(--sp-4); align-content: start; }
.page-chip { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 54px; padding: var(--sp-2); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--well); color: var(--text-soft); font-family: var(--font-num); font-size: var(--fs-md); cursor: pointer; transition: border-color 0.15s, background 0.15s, color 0.15s; }
.page-chip:hover { border-color: var(--primary); color: var(--text); }
.page-chip.on { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }
.page-rot { color: var(--amber); font-size: var(--fs-xs); }

/* 空态 */
.empty-state { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-7); text-align: center; }
.empty-state.standalone { border: 1px dashed var(--card-border); border-radius: var(--r-md); }
.empty-state .empty-ico { width: 46px; height: 46px; display: grid; place-items: center; border-radius: var(--r-pill); background: var(--primary-soft); color: var(--primary-hover); }
.empty-state b { font-size: var(--fs-base); }
.empty-state p { max-width: 420px; margin: 0; color: var(--muted); font-size: var(--fs-sm); line-height: var(--lh-body); }
.empty-state .btn-outline { margin-top: var(--sp-2); }

@media (max-width: 760px) {
  .range-input { width: 130px; }
  .range-input.wide { width: 100%; }
  .bar-hint, .foot-hint { display: none; }
}
</style>
