<script setup>
// 文本对比（手机端）：逐行 diff + 统一补丁（unified diff）。
//
// 逻辑复用 src/textDiff.js（桌面端同一模块），文案复用 toolbox.diff.*。
//
// 手机端的呈现取舍：桌面端是左右两栏并排逐步对齐，窄屏放不下，
// 改成**单栏行内呈现**（左列/右列合到一行，改动行用色块与 +/- 标记区分）。
// 只看变更（onlyChanges）默认关闭：手机上滚动成本高，先给全局再让人自己收敛。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { buildTextDiff, createUnifiedDiff } from "../../../src/textDiff.js";

const { t } = useI18n();

const left = ref("");
const right = ref("");
const mode = ref("rows"); // rows | patch
const onlyChanges = ref(false);
const ignoreCase = ref(false);
const ignoreWs = ref(false);

const result = computed(() => {
  if (!left.value && !right.value) return null;
  try {
    return { data: buildTextDiff(left.value, right.value, { ignoreCase: ignoreCase.value, ignoreWhitespace: ignoreWs.value }), error: "" };
  } catch (e) {
    return { data: null, error: e?.message || String(e) };
  }
});
const diff = computed(() => result.value?.data || null);
const diffError = computed(() => result.value?.error || "");

/** 统一补丁按需生成（比逐行结果大得多，不默认算）。 */
const patch = computed(() => {
  if (mode.value !== "patch") return "";
  try {
    return createUnifiedDiff(left.value, right.value, { ignoreCase: ignoreCase.value, ignoreWhitespace: ignoreWs.value });
  } catch (e) {
    return "";
  }
});

const visibleRows = computed(() => {
  const rows = diff.value?.rows || [];
  return onlyChanges.value ? rows.filter((row) => row.type !== "unchanged") : rows;
});

const stats = computed(() => diff.value?.stats || { added: 0, removed: 0, modified: 0, unchanged: 0 });

const copied = ref("");
const copyError = ref("");
async function copy(text) {
  if (!text) return;
  copyError.value = "";
  try {
    await navigator.clipboard.writeText(text);
    copied.value = t("toolbox.diff.copiedPatch");
    setTimeout(() => (copied.value = ""), 2000);
  } catch {
    copyError.value = t("toolbox.diff.copyFailed");
  }
}
</script>

<template>
  <section class="m-tool" data-tool="diff">
    <label class="m-field">
      <span>{{ t("toolbox.diff.leftName") }}</span>
      <textarea v-model="left" rows="5" spellcheck="false" data-role="left"></textarea>
    </label>
    <label class="m-field">
      <span>{{ t("toolbox.diff.rightName") }}</span>
      <textarea v-model="right" rows="5" spellcheck="false" data-role="right"></textarea>
    </label>

    <div class="m-chips">
      <button class="m-chip" :class="{ on: ignoreCase }" @click="ignoreCase = !ignoreCase">{{ t("toolbox.diff.ignoreCase") }}</button>
      <button class="m-chip" :class="{ on: ignoreWs }" @click="ignoreWs = !ignoreWs">{{ t("toolbox.diff.ignoreWs") }}</button>
      <button class="m-chip" :class="{ on: onlyChanges }" @click="onlyChanges = !onlyChanges">{{ t("toolbox.diff.onlyChanges") }}</button>
    </div>

    <div class="m-chips">
      <button class="m-chip" :class="{ on: mode === 'rows' }" data-mode="rows" @click="mode = 'rows'">{{ t("mobile.diffRows") }}</button>
      <button class="m-chip" :class="{ on: mode === 'patch' }" data-mode="patch" @click="mode = 'patch'">{{ t("mobile.diffPatch") }}</button>
    </div>

    <p v-if="diffError" class="m-err" data-role="error">{{ diffError }}</p>

    <!-- 统计：一眼看出改了多少 -->
    <ul v-if="diff" class="m-stats" data-role="diff-stats">
      <li><b>{{ t("toolbox.diff.statAdded") }}</b><span data-role="stat-added">{{ stats.added }}</span></li>
      <li><b>{{ t("toolbox.diff.statRemoved") }}</b><span data-role="stat-removed">{{ stats.removed }}</span></li>
      <li><b>{{ t("toolbox.diff.statModified") }}</b><span>{{ stats.modified }}</span></li>
    </ul>

    <p v-if="diff && !diff.hasChanges" class="m-ok" data-role="same">{{ t("toolbox.diff.sameTitle") }}</p>

    <!-- 逐行结果：单栏呈现（左/右合到一行） -->
    <template v-if="mode === 'rows' && diff && diff.hasChanges">
      <ul class="m-diff" data-role="diff-rows">
        <li v-for="(row, index) in visibleRows" :key="index" :data-type="row.type" class="m-diff-row">
          <span class="m-diff-sign">{{ row.type === "added" ? "+" : row.type === "removed" ? "-" : row.type === "modified" ? "~" : "" }}</span>
          <span class="m-diff-line">{{ row.left?.text ?? "" }}</span>
          <span v-if="row.type === 'modified'" class="m-diff-line arrow">→ {{ row.right?.text ?? "" }}</span>
          <span v-else-if="row.type === 'added'" class="m-diff-line">{{ row.right?.text ?? "" }}</span>
        </li>
      </ul>
    </template>

    <!-- 统一补丁 -->
    <label v-if="mode === 'patch'" class="m-field">
      <span>{{ t("toolbox.diff.copyDiff") }}</span>
      <textarea :value="patch" rows="10" readonly spellcheck="false" data-role="patch"></textarea>
    </label>

    <div class="m-actions">
      <button class="m-btn" :disabled="!diff" @click="left = ''; right = ''">{{ t("toolbox.diff.clear") }}</button>
      <button v-if="mode === 'patch'" class="m-btn" :disabled="!patch" @click="copy(patch)">{{ t("toolbox.diff.copyDiff") }}</button>
    </div>
    <p v-if="copied" class="m-ok">{{ copied }}</p>
    <p v-if="copyError" class="m-err" data-role="copy-error">{{ copyError }}</p>
  </section>
</template>
