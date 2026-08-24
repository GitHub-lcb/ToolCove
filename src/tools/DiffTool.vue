<script setup>
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import { buildTextDiff, createUnifiedDiff, splitTextLines } from "../textDiff.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const leftText = ref("");
const rightText = ref("");
const view = ref("input");
const ignoreWhitespace = ref(false);
const ignoreCase = ref(false);
const onlyChanges = ref(false);

const options = computed(() => ({
  ignoreWhitespace: ignoreWhitespace.value,
  ignoreCase: ignoreCase.value,
}));

const leftStats = computed(() => ({
  lines: splitTextLines(leftText.value).length,
  chars: Array.from(leftText.value).length,
}));
const rightStats = computed(() => ({
  lines: splitTextLines(rightText.value).length,
  chars: Array.from(rightText.value).length,
}));

const comparison = computed(() => {
  try {
    return { data: buildTextDiff(leftText.value, rightText.value, options.value), error: "" };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
});

const displayRows = computed(() => {
  const rows = comparison.value.data?.rows || [];
  return onlyChanges.value ? rows.filter((row) => row.type !== "equal") : rows;
});

function startCompare() {
  if (!leftText.value && !rightText.value) return props.showToast(t("toolbox.diff.emptyToast"));
  view.value = "result";
}

function swapTexts() {
  [leftText.value, rightText.value] = [rightText.value, leftText.value];
}

function clearAll() {
  leftText.value = "";
  rightText.value = "";
  view.value = "input";
}

async function copyPatch() {
  let patch;
  try {
    patch = createUnifiedDiff(leftText.value, rightText.value, options.value);
  } catch (e) {
    return props.showToast(e instanceof Error ? e.message : String(e));
  }
  if (!patch) return props.showToast(t("toolbox.diff.noDiff"));
  try {
    await navigator.clipboard.writeText(patch);
    props.showToast(t("toolbox.diff.copiedPatch"));
  } catch (e) {
    props.showToast(t("toolbox.diff.copyFailed", { err: String(e) }));
  }
}
</script>

<template>
  <div class="diff-tool">
    <div class="toolbar">
      <div class="view-switch" role="group" :aria-label="t('toolbox.diff.viewLabel')">
        <button type="button" :class="{ on: view === 'input' }" @click="view = 'input'">{{ t("toolbox.diff.viewInput") }}</button>
        <button type="button" :class="{ on: view === 'result' }" @click="startCompare">{{ t("toolbox.diff.viewResult") }}</button>
      </div>

      <label class="check-option">
        <input v-model="ignoreWhitespace" type="checkbox" />
        <span>{{ t("toolbox.diff.ignoreWs") }}</span>
      </label>
      <label class="check-option">
        <input v-model="ignoreCase" type="checkbox" />
        <span>{{ t("toolbox.diff.ignoreCase") }}</span>
      </label>
      <label v-if="view === 'result'" class="check-option">
        <input v-model="onlyChanges" type="checkbox" />
        <span>{{ t("toolbox.diff.onlyChanges") }}</span>
      </label>

      <span class="toolbar-spacer"></span>
      <button class="icon-btn" type="button" :title="t('toolbox.diff.swapTitle')" :aria-label="t('toolbox.diff.swapTitle')" :disabled="!leftText && !rightText" @click="swapTexts">
        <Icon name="repeat" :size="16" />
      </button>
      <button class="btn-ghost sm" type="button" :disabled="!leftText && !rightText" @click="clearAll">{{ t("toolbox.diff.clear") }}</button>
      <button v-if="view === 'input'" class="btn-primary sm" type="button" @click="startCompare">
        <Icon name="git-compare" :size="15" />{{ t("toolbox.diff.startCompare") }}
      </button>
      <button v-else class="btn-outline sm" type="button" :disabled="!comparison.data?.hasChanges" @click="copyPatch">
        <Icon name="copy" :size="14" />{{ t("toolbox.diff.copyDiff") }}
      </button>
    </div>

    <div v-if="view === 'input'" class="input-workspace">
      <section class="editor-panel">
        <header class="panel-head">
          <span class="side-mark left"></span>
          <b>{{ t("toolbox.diff.leftName") }}</b>
          <span class="text-stats">{{ t("toolbox.diff.stats", { lines: leftStats.lines, chars: leftStats.chars }) }}</span>
        </header>
        <textarea v-model="leftText" class="text-editor" spellcheck="false" :placeholder="t('toolbox.diff.phLeft')" :aria-label="t('toolbox.diff.leftName')"></textarea>
      </section>

      <section class="editor-panel">
        <header class="panel-head">
          <span class="side-mark right"></span>
          <b>{{ t("toolbox.diff.rightName") }}</b>
          <span class="text-stats">{{ t("toolbox.diff.stats", { lines: rightStats.lines, chars: rightStats.chars }) }}</span>
        </header>
        <textarea v-model="rightText" class="text-editor" spellcheck="false" :placeholder="t('toolbox.diff.phRight')" :aria-label="t('toolbox.diff.rightName')"></textarea>
      </section>
    </div>

    <section v-else class="result-workspace">
      <div v-if="comparison.error" class="result-state error" role="alert">
        <span><Icon name="alert" :size="22" /></span>
        <b>{{ t("toolbox.diff.compareFailed") }}</b>
        <p>{{ comparison.error }}</p>
      </div>

      <div v-else-if="!comparison.data?.hasChanges" class="result-state same">
        <span><Icon name="check" :size="22" /></span>
        <b>{{ t("toolbox.diff.sameTitle") }}</b>
        <p>{{ t("toolbox.diff.sameDesc") }}</p>
      </div>

      <template v-else>
        <div class="result-summary">
          <span class="summary-title">{{ t("toolbox.diff.totalRows", { count: comparison.data.rows.length }) }}</span>
          <span class="stat modified">{{ t("toolbox.diff.statModified", { count: comparison.data.stats.modified }) }}</span>
          <span class="stat added">{{ t("toolbox.diff.statAdded", { count: comparison.data.stats.added }) }}</span>
          <span class="stat removed">{{ t("toolbox.diff.statRemoved", { count: comparison.data.stats.removed }) }}</span>
          <span class="stat unchanged">{{ t("toolbox.diff.statUnchanged", { count: comparison.data.stats.unchanged }) }}</span>
        </div>

        <div class="diff-grid" role="table" :aria-label="t('toolbox.diff.tableLabel')">
          <div class="diff-head" role="row">
            <div role="columnheader"><span class="side-mark left"></span>{{ t("toolbox.diff.leftName") }}</div>
            <div role="columnheader"><span class="side-mark right"></span>{{ t("toolbox.diff.rightName") }}</div>
          </div>
          <div class="diff-body">
            <div v-for="(row, index) in displayRows" :key="index" class="diff-row" :class="row.type" role="row">
              <div class="diff-cell left-cell" :class="{ empty: !row.left }" role="cell">
                <span class="line-no">{{ row.left?.number || "" }}</span>
                <span class="line-sign">{{ row.type === "removed" || row.type === "modified" ? "-" : " " }}</span>
                <code>{{ row.left?.text || "" }}</code>
              </div>
              <div class="diff-cell right-cell" :class="{ empty: !row.right }" role="cell">
                <span class="line-no">{{ row.right?.number || "" }}</span>
                <span class="line-sign">{{ row.type === "added" || row.type === "modified" ? "+" : " " }}</span>
                <code>{{ row.right?.text || "" }}</code>
              </div>
            </div>
            <p v-if="!displayRows.length" class="filtered-empty">{{ t("toolbox.diff.filteredEmpty") }}</p>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.diff-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.toolbar { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-3); }
.toolbar-spacer { flex: 1; }
.toolbar :disabled { opacity: 0.45; cursor: default; }
.view-switch { display: inline-grid; grid-template-columns: repeat(2, minmax(72px, 1fr)); padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.view-switch button { padding: var(--sp-1) var(--sp-4); border: none; border-radius: var(--r-xs); background: transparent; color: var(--muted); font-size: var(--fs-sm); cursor: pointer; }
.view-switch button.on { background: var(--card); color: var(--primary-hover); box-shadow: var(--shadow); font-weight: 600; }
.check-option { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--text-weak); font-size: var(--fs-sm); white-space: nowrap; cursor: pointer; }
.check-option input { accent-color: var(--primary); cursor: pointer; }

.input-workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }
.editor-panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.editor-panel:focus-within { border-color: var(--primary); }
.panel-head { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.side-mark { width: 3px; height: 16px; flex-shrink: 0; border-radius: var(--r-pill); }
.side-mark.left { background: var(--danger); }
.side-mark.right { background: var(--success); }
.text-stats { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.text-editor { flex: 1; min-height: 0; width: 100%; padding: var(--sp-4); resize: none; border: none; outline: none; background: transparent; color: var(--text-code); font-family: var(--font-mono); font-size: var(--fs-md); line-height: var(--lh-body); overflow: auto; }
.text-editor::placeholder { color: var(--muted); font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }

.result-workspace { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.result-summary { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-2); min-height: 38px; padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.summary-title { margin-right: var(--sp-1); color: var(--text-weak); font-size: var(--fs-sm); }
.stat { padding: 2px var(--sp-2); border-radius: var(--r-pill); font-family: var(--font-num); font-size: var(--fs-xs); font-weight: 600; }
.stat.modified { color: var(--warn-deep); background: var(--warn-soft); }
.stat.added { color: var(--success-deep); background: var(--success-soft); }
.stat.removed { color: var(--danger-deep); background: var(--danger-soft); }
.stat.unchanged { color: var(--text-dim); background: var(--well); }

.diff-grid { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.diff-head { flex-shrink: 0; display: grid; grid-template-columns: repeat(2, minmax(300px, 1fr)); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.diff-head > div { display: flex; align-items: center; gap: var(--sp-2); min-height: 34px; padding: 0 var(--sp-4); color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
.diff-head > div + div { border-left: 1px solid var(--border); }
.diff-body { flex: 1; min-height: 0; overflow: auto; }
.diff-row { display: grid; grid-template-columns: repeat(2, minmax(300px, 1fr)); min-width: 600px; border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.diff-cell { min-width: 0; display: grid; grid-template-columns: 42px 24px minmax(0, 1fr); min-height: 28px; color: var(--text-code); font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); }
.diff-cell + .diff-cell { border-left: 1px solid var(--border); }
.line-no { padding: var(--sp-1) var(--sp-2); text-align: right; color: var(--muted); background: color-mix(in srgb, var(--text) 2%, transparent); user-select: none; }
.line-sign { padding: var(--sp-1) 0; text-align: center; color: var(--muted); user-select: none; }
.diff-cell code { min-width: 0; padding: var(--sp-1) var(--sp-2); color: inherit; font: inherit; white-space: pre; }
.diff-row.removed .left-cell, .diff-row.modified .left-cell { color: var(--danger-deep); background: var(--danger-soft); }
.diff-row.added .right-cell, .diff-row.modified .right-cell { color: var(--success-deep); background: var(--success-soft); }
.diff-cell.empty { background: color-mix(in srgb, var(--text) 3%, transparent); }
.diff-cell.empty .line-no, .diff-cell.empty .line-sign { color: transparent; background: transparent; }
.filtered-empty { margin: var(--sp-7); color: var(--muted); font-size: var(--fs-sm); text-align: center; }

.result-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-7); text-align: center; }
.result-state > span { width: 46px; height: 46px; display: grid; place-items: center; border-radius: var(--r-pill); }
.result-state.same > span { color: var(--success-deep); background: var(--success-soft); }
.result-state.error > span { color: var(--danger); background: var(--danger-soft); }
.result-state b { font-size: var(--fs-base); }
.result-state p { margin: 0; color: var(--muted); font-size: var(--fs-sm); line-height: var(--lh-body); }
.result-state.error p { color: var(--danger-deep); }

@media (max-width: 820px) {
  .toolbar { flex-wrap: wrap; }
  .toolbar-spacer { display: none; }
  .input-workspace { grid-template-columns: repeat(2, minmax(300px, 1fr)); overflow-x: auto; }
}
</style>
