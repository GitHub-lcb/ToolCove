<script setup>
// PDF 工具（手机端）：合并 / 拆分 / 页面操作（提取、删除、旋转）。
//
// 逻辑全部复用 src/pdfTool.js（桌面端同一模块，基于 pdf-lib）。挑文件走 File API，
// 与图片工具同一条路径——手机端不需要原生桥。
//
// 两个刻意的取舍：
//  1) 页码范围用**文本输入**（`1-3,5,7-9`）而不是桌面的缩略图点选：手机上点缩略图容易误触，
//     而文本范围解析器（parsePageRanges）已有单测，规则确定、可预期；
//  2) 输出走浏览器下载（安卓壳接管后落应用目录）——文件名沿用共享层的 pdfOutputName，
//     两端命名一致。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { extractPages, formatPageRanges, mergePdfs, parsePageRanges, pdfBaseName, pdfOutputName, readPdfSummary, removePages, rotatePages, splitPdf } from "../../../src/pdfTool.js";

const { t } = useI18n();

const MODES = [
  { key: "merge", labelKey: "toolbox.pdf.modeMerge" },
  { key: "split", labelKey: "toolbox.pdf.modeSplit" },
  { key: "pages", labelKey: "toolbox.pdf.modePages" },
];

const mode = ref("merge");
const error = ref("");
const notice = ref("");
const busy = ref(false);
const pdfInput = ref(null);

/** 已选文件：合并用多个；拆分/页面操作用第一个。每项 { name, size, bytes }。 */
const files = ref([]);
const activeIndex = ref(0);
const summary = ref(null);
const rangeText = ref("");
const rotateAngle = ref(90);

const active = computed(() => files.value[activeIndex.value] || null);

const kb = (bytes) => `${Math.max(1, Math.round(Number(bytes || 0) / 1024))} KB`;

async function pickFiles(event) {
  const picked = [...(event?.target?.files || [])];
  if (!picked.length) return;
  error.value = "";
  notice.value = "";
  try {
    const loaded = [];
    for (const file of picked) {
      // 逐个读成 Uint8Array：pdfTool 的入参就是它，File.arrayBuffer 正好给
      loaded.push({ name: file.name, size: file.size, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    if (mode.value === "merge") {
      files.value = [...files.value, ...loaded];
      activeIndex.value = 0;
    } else {
      // 拆分/页面操作是单文件语义：换文件就整体替换，避免"选了两个但只用第一个"的困惑
      files.value = [loaded[0]];
      activeIndex.value = 0;
      await refreshSummary();
    }
  } catch (e) {
    error.value = `${t("toolbox.pdf.errRead")}：${e?.message || String(e)}`;
  } finally {
    if (pdfInput.value) pdfInput.value.value = "";
  }
}

async function refreshSummary() {
  summary.value = null;
  if (!active.value) return;
  try {
    summary.value = await readPdfSummary(active.value.bytes);
  } catch (e) {
    error.value = `${t("toolbox.pdf.errRead")}：${e?.message || String(e)}`;
  }
}

const pageCount = computed(() => summary.value?.pageCount || 0);

/** 解析当前范围输入 → 页码数组（0 基）。解析失败给出可读原因，不静默当空。 */
const selectedIndices = computed(() => {
  if (!rangeText.value.trim() || !pageCount.value) return [];
  try {
    return parsePageRanges(rangeText.value, pageCount.value);
  } catch {
    return [];
  }
});

function download(bytes, name) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // 交给浏览器读取后再释放，避免下载被中断
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/** 统一的执行包装：busy、错误、提示三件事只写一次。 */
async function run(task) {
  if (busy.value) return;
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    await task();
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

const requireActive = () => {
  if (!active.value) throw new Error(t("toolbox.pdf.pickEmptyTitle"));
  return active.value;
};

const merge = () =>
  run(async () => {
    if (files.value.length < 2) throw new Error(t("toolbox.pdf.mergeEmptyTitle"));
    const bytes = await mergePdfs(files.value.map((f) => f.bytes));
    const name = pdfOutputName(files.value[0].name, "-merged");
    download(bytes, name);
    notice.value = t("toolbox.pdf.doneSaved", { name });
  });

const split = () =>
  run(async () => {
    const file = requireActive();
    // 一行一个分组，行号作为输出序号（token）
    const groups = rangeText.value
      .split(/[\n;；]/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => ({ token: String(index + 1), indices: parsePageRanges(line, pageCount.value) }));
    if (!groups.length) throw new Error(t("toolbox.pdf.splitEmptyTitle"));
    const results = await splitPdf(file.bytes, groups);
    const base = pdfBaseName(file.name);
    results.forEach((item, index) => download(item.bytes, `${base}-part${index + 1}.pdf`));
    notice.value = t("toolbox.pdf.doneSplit", { n: results.length });
  });

const extract = () =>
  run(async () => {
    const file = requireActive();
    if (!selectedIndices.value.length) throw new Error(t("toolbox.pdf.pickEmptyTitle"));
    const bytes = await extractPages(file.bytes, selectedIndices.value);
    const name = pdfOutputName(file.name, "-pages");
    download(bytes, name);
    notice.value = t("toolbox.pdf.doneSaved", { name });
  });

const remove = () =>
  run(async () => {
    const file = requireActive();
    if (!selectedIndices.value.length) throw new Error(t("toolbox.pdf.pickEmptyTitle"));
    const bytes = await removePages(file.bytes, selectedIndices.value);
    const name = pdfOutputName(file.name, "-removed");
    download(bytes, name);
    notice.value = t("toolbox.pdf.doneSaved", { name });
  });

const rotate = () =>
  run(async () => {
    const file = requireActive();
    if (!selectedIndices.value.length) throw new Error(t("toolbox.pdf.pickEmptyTitle"));
    const angles = Object.fromEntries(selectedIndices.value.map((index) => [String(index), Number(rotateAngle.value) || 0]));
    const bytes = await rotatePages(file.bytes, angles);
    const name = pdfOutputName(file.name, "-rotated");
    download(bytes, name);
    notice.value = t("toolbox.pdf.doneSaved", { name });
  });

function moveFile(index, delta) {
  const next = [...files.value];
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  [next[index], next[target]] = [next[target], next[index]];
  files.value = next;
}

function removeFile(index) {
  files.value = files.value.filter((_, i) => i !== index);
  if (activeIndex.value >= files.value.length) activeIndex.value = 0;
}
</script>

<template>
  <section class="m-tool" data-tool="pdf">
    <div class="m-chips">
      <button v-for="item in MODES" :key="item.key" class="m-chip" :class="{ on: mode === item.key }" :data-mode="item.key" @click="mode = item.key">
        {{ t(item.labelKey) }}
      </button>
    </div>

    <input
      ref="pdfInput"
      type="file"
      accept="application/pdf"
      :multiple="mode === 'merge'"
      class="m-file-hidden"
      data-role="file"
      @change="pickFiles"
    />
    <div class="m-actions">
      <button class="m-btn primary" data-role="pick" @click="pdfInput?.click()">
        {{ mode === "merge" ? t("toolbox.pdf.addFiles") : t("toolbox.pdf.pickFile") }}
      </button>
      <button v-if="files.length" class="m-btn" data-role="clear" @click="files = []; summary = null; rangeText = ''">
        {{ t("toolbox.pdf.clearList") }}
      </button>
    </div>

    <p v-if="!files.length" class="m-hint-sm" data-role="empty">{{ t("toolbox.pdf.pickEmptyHint") }}</p>

    <!-- 合并：列表 + 顺序调整 -->
    <ul v-if="mode === 'merge' && files.length" class="m-list" data-role="merge-list">
      <li v-for="(file, index) in files" :key="file.name + index" class="m-item" :data-file="index">
        <div class="m-item-main">
          <span class="m-item-title">{{ file.name }}</span>
          <span class="m-item-sub">{{ kb(file.size) }}</span>
        </div>
        <div class="m-item-ops">
          <button class="m-op" :disabled="index === 0" data-role="up" @click="moveFile(index, -1)">↑</button>
          <button class="m-op" :disabled="index === files.length - 1" data-role="down" @click="moveFile(index, 1)">↓</button>
          <button class="m-op danger" @click="removeFile(index)">{{ t("toolbox.pdf.removeFile") }}</button>
        </div>
      </li>
    </ul>
    <p v-if="mode === 'merge' && files.length" class="m-hint-sm">{{ t("toolbox.pdf.mergeList") }}</p>

    <!-- 单文件模式：概要 + 页码范围 -->
    <template v-if="mode !== 'merge' && active">
      <div class="m-card">
        <div class="m-card-head">
          <b data-role="file-name">{{ active.name }}</b>
          <span class="m-zone" data-role="file-meta">{{ t("toolbox.pdf.sourceMeta", { pages: pageCount, size: kb(active.size) }) }}</span>
        </div>
        <ul v-if="summary" class="m-stats" data-role="summary">
          <li><b>{{ t("toolbox.pdf.pageCount", { n: pageCount }) }}</b><span>{{ summary.sizes?.[0]?.label || "" }}</span></li>
        </ul>
      </div>

      <label class="m-field">
        <span>{{ t("toolbox.pdf.modePages") }}</span>
        <!-- 拆分要按「一行一组」输入，必须是 textarea：单行 input 会把换行规范化成空格，
             于是永远只分出一组（踩过一次，E2E 里表现为"只输出 1 个文件"）。 -->
        <textarea
          v-if="mode === 'split'"
          v-model="rangeText"
          rows="4"
          spellcheck="false"
          placeholder="1-2&#10;3-5"
          data-role="range"
        ></textarea>
        <input v-else v-model="rangeText" spellcheck="false" placeholder="1-3,5,7-9" data-role="range" />
      </label>
      <p class="m-hint-sm" data-role="selection">
        {{ t("toolbox.pdf.selectionStat", { total: pageCount, n: mode === "split" ? rangeText.split(/[\n;；]/).filter((x) => x.trim()).length : selectedIndices.length }) }}
      </p>
      <p v-if="mode === 'pages' && selectedIndices.length" class="m-hint-sm" data-role="range-label">
        {{ formatPageRanges(selectedIndices) }}
      </p>

      <label v-if="mode === 'pages'" class="m-field">
        <span>{{ t("toolbox.pdf.rotateHint") }}</span>
        <select v-model.number="rotateAngle" data-role="angle">
          <option :value="90">90°</option>
          <option :value="180">180°</option>
          <option :value="270">270°</option>
        </select>
      </label>

      <div class="m-actions">
        <button v-if="mode === 'split'" class="m-btn primary" :disabled="busy" data-role="split" @click="split">{{ t("toolbox.pdf.splitAction") }}</button>
        <template v-else>
          <button class="m-btn primary" :disabled="busy" data-role="extract" @click="extract">{{ t("toolbox.pdf.extractAction") }}</button>
          <button class="m-btn" :disabled="busy" data-role="remove" @click="remove">{{ t("toolbox.pdf.removeAction") }}</button>
          <button class="m-btn" :disabled="busy" data-role="rotate" @click="rotate">{{ t("toolbox.pdf.rotatedStat", { n: selectedIndices.length }) }}</button>
        </template>
      </div>
    </template>

    <div v-if="mode === 'merge' && files.length >= 2" class="m-actions">
      <button class="m-btn primary" :disabled="busy" data-role="merge" @click="merge">{{ t("toolbox.pdf.mergeAction") }}</button>
    </div>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>

    <p class="m-hint-sm">{{ t("mobile.pdfLocalNote") }}</p>
  </section>
</template>
