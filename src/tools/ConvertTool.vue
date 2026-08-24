<script setup>
import { computed, ref, watch } from "vue";
import Icon from "../Icon.vue";
import {
  decodeBase64,
  decodeHex,
  decodeJsonString,
  decodeUnicode,
  decodeUrl,
  encodeBase64,
  encodeHex,
  encodeJsonString,
  encodeUnicode,
  encodeUrl,
  parseJwt,
} from "../convert.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const MODES = [
  { key: "base64", label: "Base64", placeholder: "输入要编码的文本" },
  { key: "url", label: "URL", placeholder: "输入 URL 组件或参数" },
  { key: "unicode", label: "Unicode", placeholder: "输入要转换的文本" },
  { key: "hex", label: "Hex", placeholder: "输入要转换的 UTF-8 文本" },
  { key: "json", label: "JSON 转义", placeholder: "输入 JSON 字符串内容" },
  { key: "jwt", label: "JWT 解析", placeholder: "粘贴 JWT 或 Bearer Token" },
];

const mode = ref("base64");
const direction = ref("encode");
const input = ref("");
const output = ref("");
const error = ref("");
const jwtResult = ref(null);
const base64UrlSafe = ref(false);

const activeMode = computed(() => MODES.find((item) => item.key === mode.value) || MODES[0]);
const inputCount = computed(() => Array.from(input.value).length);
const outputCount = computed(() => Array.from(output.value).length);
const resultPlaceholder = computed(() => mode.value === "jwt" ? "解析结果将在这里显示" : "转换结果将在这里显示");

const converters = {
  base64: { encode: () => encodeBase64(input.value, base64UrlSafe.value), decode: () => decodeBase64(input.value) },
  url: { encode: () => encodeUrl(input.value), decode: () => decodeUrl(input.value) },
  unicode: { encode: () => encodeUnicode(input.value), decode: () => decodeUnicode(input.value) },
  hex: { encode: () => encodeHex(input.value), decode: () => decodeHex(input.value) },
  json: { encode: () => encodeJsonString(input.value), decode: () => decodeJsonString(input.value) },
};

function convert() {
  error.value = "";
  output.value = "";
  jwtResult.value = null;
  if (!input.value) return;
  try {
    if (mode.value === "jwt") {
      jwtResult.value = parseJwt(input.value);
      return;
    }
    output.value = converters[mode.value][direction.value]();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

watch([input, mode, direction, base64UrlSafe], convert, { immediate: true });

function selectMode(key) {
  mode.value = key;
  input.value = "";
  output.value = "";
  error.value = "";
  jwtResult.value = null;
}

function swap() {
  if (mode.value === "jwt" || error.value || !output.value) return;
  input.value = output.value;
  direction.value = direction.value === "encode" ? "decode" : "encode";
}

function clearAll() {
  input.value = "";
  output.value = "";
  error.value = "";
  jwtResult.value = null;
}

async function copyText(text, label = "结果") {
  if (!text) return props.showToast(`没有可复制的${label}`);
  try {
    await navigator.clipboard.writeText(text);
    props.showToast(`已复制${label}`);
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}

function prettyJson(value) {
  return value ? JSON.stringify(value, null, 2) : "";
}
</script>

<template>
  <div class="convert-tool">
    <nav class="mode-tabs" aria-label="转换类型">
      <button
        v-for="item in MODES"
        :key="item.key"
        class="mode-tab"
        :class="{ on: mode === item.key }"
        type="button"
        @click="selectMode(item.key)"
      >{{ item.label }}</button>
    </nav>

    <div class="action-bar">
      <div v-if="mode !== 'jwt'" class="direction" role="group" aria-label="转换方向">
        <button type="button" :class="{ on: direction === 'encode' }" @click="direction = 'encode'">编码</button>
        <button type="button" :class="{ on: direction === 'decode' }" @click="direction = 'decode'">解码</button>
      </div>
      <span v-else class="local-badge"><Icon name="eye" :size="14" />仅本地解析，不验证签名</span>

      <label v-if="mode === 'base64' && direction === 'encode'" class="url-safe">
        <input v-model="base64UrlSafe" type="checkbox" />
        <span>URL 安全格式</span>
      </label>

      <span class="action-spacer"></span>
      <button
        v-if="mode !== 'jwt'"
        class="icon-btn"
        type="button"
        title="交换输入输出"
        aria-label="交换输入输出"
        :disabled="!output || !!error"
        @click="swap"
      ><Icon name="repeat" :size="16" /></button>
      <button class="btn-ghost sm" type="button" :disabled="!input" @click="clearAll">清空</button>
    </div>

    <div class="workspace" :class="{ 'jwt-workspace': mode === 'jwt' }">
      <section class="editor-panel">
        <header class="panel-head">
          <b>输入</b>
          <span>{{ inputCount }} 字符</span>
        </header>
        <textarea
          v-model="input"
          class="text-editor"
          spellcheck="false"
          :placeholder="activeMode.placeholder"
          aria-label="待转换内容"
        ></textarea>
      </section>

      <section class="editor-panel result-panel" :class="{ invalid: error }">
        <header class="panel-head">
          <b>结果</b>
          <span v-if="mode !== 'jwt'">{{ outputCount }} 字符</span>
          <button
            v-if="mode !== 'jwt'"
            class="icon-btn xs"
            type="button"
            title="复制结果"
            aria-label="复制结果"
            :disabled="!output"
            @click="copyText(output)"
          ><Icon name="copy" :size="14" /></button>
        </header>

        <div v-if="error" class="error-state" role="alert">
          <span class="error-icon"><Icon name="alert" :size="20" /></span>
          <b>无法转换</b>
          <p>{{ error }}</p>
        </div>

        <template v-else-if="mode === 'jwt' && jwtResult">
          <div class="jwt-results">
            <section class="jwt-part">
              <header>
                <b>Header</b>
                <button class="icon-btn xs" type="button" title="复制 Header" aria-label="复制 Header" @click="copyText(prettyJson(jwtResult.header), ' Header')"><Icon name="copy" :size="14" /></button>
              </header>
              <pre>{{ prettyJson(jwtResult.header) }}</pre>
            </section>
            <section class="jwt-part payload">
              <header>
                <b>Payload</b>
                <button class="icon-btn xs" type="button" title="复制 Payload" aria-label="复制 Payload" @click="copyText(prettyJson(jwtResult.payload), ' Payload')"><Icon name="copy" :size="14" /></button>
              </header>
              <pre>{{ prettyJson(jwtResult.payload) }}</pre>
            </section>
            <section class="signature-row">
              <span>Signature</span>
              <code :title="jwtResult.signature">{{ jwtResult.signature || "（空）" }}</code>
            </section>
          </div>
        </template>

        <textarea
          v-else-if="mode !== 'jwt'"
          :value="output"
          class="text-editor output-editor"
          readonly
          spellcheck="false"
          :placeholder="resultPlaceholder"
          aria-label="转换结果"
        ></textarea>
        <p v-else class="result-empty">{{ resultPlaceholder }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.convert-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }

.mode-tabs { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border); }
.mode-tab { flex-shrink: 0; padding: var(--sp-2) var(--sp-4); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text-weak); font-size: var(--fs-md); cursor: pointer; transition: color 0.15s, background 0.15s, border-color 0.15s; }
.mode-tab:hover { color: var(--text); background: var(--ghost); }
.mode-tab.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }

.action-bar { flex-shrink: 0; min-height: 34px; display: flex; align-items: center; gap: var(--sp-3); }
.action-spacer { flex: 1; }
.direction { display: inline-grid; grid-template-columns: repeat(2, minmax(58px, 1fr)); padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.direction button { padding: var(--sp-1) var(--sp-4); border: none; border-radius: var(--r-xs); background: transparent; color: var(--muted); font-size: var(--fs-sm); cursor: pointer; }
.direction button.on { background: var(--card); color: var(--primary-hover); box-shadow: var(--shadow); font-weight: 600; }
.url-safe { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--text-weak); font-size: var(--fs-sm); cursor: pointer; }
.url-safe input { accent-color: var(--primary); cursor: pointer; }
.local-badge { display: inline-flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-3); border-radius: var(--r-pill); background: var(--success-soft); color: var(--success-deep); font-size: var(--fs-sm); font-weight: 600; }
.action-bar :disabled { opacity: 0.45; cursor: default; }

.workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--sp-3); }
.editor-panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.editor-panel:focus-within { border-color: var(--primary); }
.editor-panel.invalid { border-color: var(--border-danger); }
.panel-head { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.panel-head span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.panel-head .icon-btn { margin-left: 0; }
.text-editor { flex: 1; min-height: 0; width: 100%; padding: var(--sp-4); resize: none; border: none; outline: none; background: transparent; color: var(--text-code); font-family: var(--font-mono); font-size: var(--fs-md); line-height: var(--lh-body); overflow: auto; }
.text-editor::placeholder { color: var(--muted); font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.output-editor { background: color-mix(in srgb, var(--text) 1.5%, transparent); }

.error-state { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-7); text-align: center; }
.error-icon { width: 42px; height: 42px; display: grid; place-items: center; border-radius: var(--r-pill); background: var(--danger-soft); color: var(--danger); }
.error-state b { font-size: var(--fs-base); }
.error-state p { max-width: 440px; margin: 0; color: var(--danger-deep); font-size: var(--fs-sm); line-height: var(--lh-body); word-break: break-word; }
.result-empty { margin: auto; color: var(--muted); font-size: var(--fs-sm); }

.jwt-results { flex: 1; min-height: 0; display: grid; grid-template-rows: minmax(0, 0.8fr) minmax(0, 1.2fr) auto; overflow: hidden; }
.jwt-part { min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid var(--border); }
.jwt-part header { flex-shrink: 0; min-height: 34px; display: flex; align-items: center; justify-content: space-between; padding: 0 var(--sp-4); color: var(--primary-hover); font-size: var(--fs-sm); }
.jwt-part pre { flex: 1; min-height: 0; margin: 0; padding: var(--sp-4); overflow: auto; background: color-mix(in srgb, var(--text) 1.5%, transparent); color: var(--text-code); font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); white-space: pre-wrap; word-break: break-word; }
.signature-row { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--sp-3); min-height: 38px; padding: 0 var(--sp-4); }
.signature-row span { color: var(--muted); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; }
.signature-row code { overflow: hidden; color: var(--text-code); font-family: var(--font-mono); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 760px) {
  .workspace { grid-template-columns: 1fr; grid-template-rows: repeat(2, minmax(0, 1fr)); }
  .action-bar { flex-wrap: wrap; }
}
</style>
