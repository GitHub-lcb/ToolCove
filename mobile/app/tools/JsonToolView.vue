<script setup>
// JSON 工具（手机端）：格式化 / 压缩 / 转义 / 去转义 / 结构统计 / 敏感字段脱敏。
//
// 逻辑全部复用 src/json.js（桌面端同一个模块），**文案也尽量复用桌面端词条**
// （toolbox.json.*）——同一件事两套措辞只会让人以为是两个功能。
//
// 错误呈现是重点：JSON 报错里的「位置 N」对用户无意义，这里翻成「第 L 行第 C 列 + 该行内容」。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { escapeJson, formatJson, jsonStats, locateJsonError, maskJsonText, minifyJson, unescapeJson } from "../../../src/json.js";

const { t } = useI18n();

const input = ref("");
const output = ref("");
const error = ref("");
const info = ref("");
const tab = ref("format"); // format | mask

const TABS = [
  { key: "format", labelKey: "toolbox.json.modeFormat" },
  { key: "mask", labelKey: "toolbox.json.mask" },
];

/**
 * 统一的执行包装。
 *
 * ⚠️ 要同时兼容两种返回约定（toolContracts.test.js 把契约钉住了）：
 *   · json.js 的函数返回 `{ ok, output, error }`，**不抛异常**；
 *   · transform 自己抛（例如 JSON.parse）也在这里兜住。
 * 混用的后果是把错误对象当结果渲染出来——踩过一次。
 */
function run(transform, describe) {
  error.value = "";
  info.value = "";
  const text = input.value;
  if (!text.trim()) {
    output.value = "";
    return;
  }
  try {
    const result = transform(text);
    if (result && typeof result === "object" && "ok" in result) {
      if (!result.ok) {
        output.value = "";
        error.value = describeError(text, result.error);
        return;
      }
      output.value = String(result.output ?? "");
      info.value = describe ? describe(result) : "";
      return;
    }
    output.value = String(result ?? "");
    info.value = describe ? describe({ output: result }) : "";
  } catch (e) {
    output.value = "";
    error.value = describeError(text, e);
  }
}

/** 把错误翻成「原文 + 第 L 行第 C 列 + 该行内容」——用户才看得出问题在哪。 */
function describeError(text, errorLike) {
  const raw = errorLike?.message || String(errorLike || "");
  const located = errorLike && typeof errorLike.line === "number" && errorLike.line > 0 ? errorLike : locateJsonError(text);
  if (located && located.line) {
    const snippet = String(text).split("\n")[located.line - 1] || "";
    const where = t("toolbox.json.errorLocation", { line: located.line, column: located.column, message: "" }).trim();
    return `${raw}\n${where}${snippet ? `\n${snippet.trim().slice(0, 80)}` : ""}`;
  }
  return raw;
}

const stats = computed(() => {
  if (!output.value.trim()) return [];
  try {
    const value = JSON.parse(output.value);
    const s = jsonStats(value);
    const type = Array.isArray(value)
      ? t("toolbox.json.typeArray", { count: value.length })
      : value !== null && typeof value === "object"
        ? t("toolbox.json.typeObject", { count: s.keys })
        : t(`toolbox.json.type${typeof value === "string" ? "String" : typeof value === "number" ? "Number" : "Boolean"}`);
    return [
      { key: "type", label: t("mobile.toolType"), value: type },
      { key: "keys", label: t("toolbox.json.statKeys"), value: String(s.keys) },
      { key: "depth", label: t("toolbox.json.statDepth"), value: String(s.depth) },
      { key: "containers", label: t("mobile.toolContainers"), value: `${s.objects} / ${s.arrays}` },
    ];
  } catch {
    return [];
  }
});

const onFormat = () => run((text) => formatJson(text, 2));
const onMinify = () => run((text) => minifyJson(text));
const onEscape = () => run((text) => escapeJson(text));
const onUnescape = () => run((text) => unescapeJson(text));
const onMask = () =>
  run(
    (text) => maskJsonText(text, 2),
    (result) => (result.count > 0 ? t("toolbox.json.masked", { count: result.count }) : t("toolbox.json.maskNoneFound"))
  );

async function copyOutput() {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    info.value = t("toolbox.json.copiedResult");
  } catch {
    error.value = t("snippet.copyFailed");
  }
}

function swap() {
  input.value = output.value;
  output.value = "";
  error.value = "";
  info.value = "";
}
</script>

<template>
  <section class="m-tool" data-tool="json">
    <div class="m-chips">
      <button v-for="item in TABS" :key="item.key" class="m-chip" :class="{ on: tab === item.key }" @click="tab = item.key">
        {{ t(item.labelKey) }}
      </button>
    </div>

    <label class="m-field">
      <span>{{ t("mobile.toolInput") }}</span>
      <textarea v-model="input" rows="7" spellcheck="false" :placeholder="t('toolbox.json.inputPlaceholderJson')"></textarea>
    </label>

    <div class="m-actions">
      <template v-if="tab === 'format'">
        <button class="m-btn primary" @click="onFormat">{{ t("toolbox.json.modeFormat") }}</button>
        <button class="m-btn" @click="onMinify">{{ t("toolbox.json.modeMinify") }}</button>
        <button class="m-btn" @click="onEscape">{{ t("toolbox.json.modeEscape") }}</button>
        <button class="m-btn" @click="onUnescape">{{ t("toolbox.json.modeUnescape") }}</button>
      </template>
      <button v-else class="m-btn primary" @click="onMask">{{ t("toolbox.json.mask") }}</button>
    </div>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
    <p v-else-if="info" class="m-ok" data-role="info">{{ info }}</p>

    <label class="m-field">
      <span>{{ t("mobile.toolOutput") }}</span>
      <textarea :value="output" rows="9" readonly spellcheck="false" data-role="output"></textarea>
    </label>

    <ul v-if="stats.length" class="m-stats">
      <li v-for="s in stats" :key="s.key"><b>{{ s.label }}</b><span>{{ s.value }}</span></li>
    </ul>

    <div class="m-actions">
      <button class="m-btn" :disabled="!output" @click="copyOutput">{{ t("toolbox.json.copyResult") }}</button>
      <button class="m-btn" :disabled="!output" @click="swap">{{ t("mobile.toolSwap") }}</button>
    </div>
  </section>
</template>
