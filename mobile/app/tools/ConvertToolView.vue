<script setup>
// 转换工具（手机端）：Base64 / URL / Unicode / Hex / JSON 字符串 的双向转换。
//
// 逻辑复用 src/convert.js（桌面端同一个模块）。手机端的差异只有排版：
// 双向转换用「方向」按钮组切换，而不是桌面端的两栏并排——窄屏放不下两栏。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { decodeBase64, decodeHex, decodeJsonString, decodeUnicode, decodeUrl, encodeBase64, encodeHex, encodeJsonString, encodeUnicode, encodeUrl } from "../../../src/convert.js";

const { t } = useI18n();

const input = ref("");
const output = ref("");
const error = ref("");

/**
 * 每种转换声明「编码/解码」两个方向。
 * 名字沿用桌面端的概念（Encode/Decode），避免同一件事两套叫法。
 */
const KINDS = [
  {
    key: "base64",
    label: "Base64",
    encode: (text) => encodeBase64(text, false),
    decode: (text) => decodeBase64(text),
  },
  { key: "url", label: "URL", encode: (text) => encodeUrl(text), decode: (text) => decodeUrl(text) },
  { key: "unicode", label: "Unicode", encode: (text) => encodeUnicode(text), decode: (text) => decodeUnicode(text) },
  { key: "hex", label: "Hex", encode: (text) => encodeHex(text), decode: (text) => decodeHex(text) },
  {
    key: "jsonString",
    label: "JSON",
    encode: (text) => encodeJsonString(text),
    decode: (text) => {
      const value = decodeJsonString(text);
      return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    },
  },
];

const kind = ref("base64");
const current = computed(() => KINDS.find((k) => k.key === kind.value) || KINDS[0]);

function convert(direction) {
  error.value = "";
  const text = input.value;
  if (!text) {
    output.value = "";
    return;
  }
  try {
    output.value = String(current.value[direction](text) ?? "");
  } catch (e) {
    output.value = "";
    error.value = e?.message || String(e);
  }
}

function swap() {
  input.value = output.value;
  output.value = "";
  error.value = "";
}

async function copyOutput() {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    error.value = "";
  } catch {
    error.value = t("snippet.copyFailed");
  }
}
</script>

<template>
  <section class="m-tool" data-tool="convert">
    <div class="m-chips">
      <button v-for="item in KINDS" :key="item.key" class="m-chip" :class="{ on: kind === item.key }" @click="kind = item.key">
        {{ item.label }}
      </button>
    </div>

    <label class="m-field">
      <span>{{ t("mobile.toolInput") }}</span>
      <textarea v-model="input" rows="6" spellcheck="false" :placeholder="t('mobile.convertInputPh')"></textarea>
    </label>

    <div class="m-actions">
      <button class="m-btn primary" @click="convert('encode')">{{ t("mobile.convertEncode") }}</button>
      <button class="m-btn" @click="convert('decode')">{{ t("mobile.convertDecode") }}</button>
    </div>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>

    <label class="m-field">
      <span>{{ t("mobile.toolOutput") }}</span>
      <textarea :value="output" rows="7" readonly spellcheck="false" data-role="output"></textarea>
    </label>

    <div class="m-actions">
      <button class="m-btn" :disabled="!output" @click="copyOutput">{{ t("snippet.copy") }}</button>
      <button class="m-btn" :disabled="!output" @click="swap">{{ t("mobile.toolSwap") }}</button>
    </div>

    <p class="m-hint-sm">{{ t("mobile.convertBase64Note") }}</p>
  </section>
</template>
