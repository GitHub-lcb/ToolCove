<script setup>
// JSON Schema 工具（桌面端）：从 JSON 推断 Schema、按 Schema 校验、造样例、解读结构。
//
// 为什么独立成工具而不是并进 json 工具：它需要**两个输入**（JSON + Schema），
// 而 json 工具的 8 个模式都是"单输入单输出"；而且它有四个独立操作（推断/校验/造样例/解读）。
// 塞进去会让那个工具的模式列表变成两种形状混在一起。
//
// 校验器是自己写的（src/jsonSchema.js，纯函数零依赖，60 条单测）——不引 ajv 的理由与
// 不引 XML 解析库一样：单测跑在 node 环境、三端一致、错误定位可控。
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import { loadToolbox, saveToolbox } from "../toolboxStore.js";
import { inferSchema, sampleFromSchema, summarizeSchema, validateSchema } from "../jsonSchema.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const SAMPLE_JSON = JSON.stringify(
  {
    orderId: "SO20260101",
    customer: { name: "张三", email: "zhangsan@example.com" },
    items: [
      { sku: "A-1", qty: 2 },
      { sku: "B-2", qty: 1 },
    ],
    createdAt: "2026-01-01T10:00:00Z",
  },
  null,
  2
);

const json = ref(SAMPLE_JSON);
const schemaText = ref("");
const mode = ref("validate"); // validate | infer | sample | outline
const error = ref("");
const notice = ref("");

/** 解析两个输入（JSON 与 Schema 都可能写错，各自给可读原因）。 */
const parsedJson = computed(() => {
  if (!json.value.trim()) return { ok: false, value: undefined, error: "" };
  try {
    return { ok: true, value: JSON.parse(json.value), error: "" };
  } catch (e) {
    return { ok: false, value: undefined, error: t("toolbox.schema.badJson", { err: e?.message || String(e) }) };
  }
});

const parsedSchema = computed(() => {
  if (!schemaText.value.trim()) return { ok: false, value: undefined, error: "" };
  try {
    const value = JSON.parse(schemaText.value);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, value: undefined, error: t("toolbox.schema.notSchema") };
    }
    return { ok: true, value, error: "" };
  } catch (e) {
    return { ok: false, value: undefined, error: t("toolbox.schema.badSchema", { err: e?.message || String(e) }) };
  }
});

/** 校验结果。 */
const validation = computed(() => {
  if (!parsedJson.value.ok || !parsedSchema.value.ok) return null;
  return validateSchema(parsedJson.value.value, parsedSchema.value.value);
});

/** 推断出的 Schema。 */
const inferred = computed(() => (parsedJson.value.ok ? inferSchema(parsedJson.value.value) : null));

/** 按 Schema 造的样例。 */
const sample = computed(() => (parsedSchema.value.ok ? sampleFromSchema(parsedSchema.value.value) : null));

/** Schema 结构解读。 */
const outlineRows = computed(() => (parsedSchema.value.ok ? summarizeSchema(parsedSchema.value.value) : []));

/** 当前模式的输出文本。 */
const output = computed(() => {
  if (mode.value === "infer") return inferred.value ? JSON.stringify(inferred.value, null, 2) : "";
  if (mode.value === "sample") return sample.value === null ? "" : JSON.stringify(sample.value, null, 2);
  if (mode.value === "outline") {
    return outlineRows.value.map((row) => `${row.path || "(root)"}  ${row.type}${row.note ? `  [${row.note}]` : ""}`).join("\n");
  }
  return "";
});

/** 错误按关键字渲染文案（与 xml/label 工具的体检同一约定）。 */
const errorText = (item) => t(`toolbox.schema.err_${item.keyword}`, { ...(item.params || {}), path: item.path || "/" });

function flash(message) {
  notice.value = message;
  setTimeout(() => (notice.value = ""), 2000);
}

/** 把推断结果填进 Schema 输入区（推断 → 校验 的自然衔接）。 */
function useInferred() {
  if (!inferred.value) return;
  schemaText.value = JSON.stringify(inferred.value, null, 2);
  mode.value = "validate";
  flash(t("toolbox.schema.inferredApplied"));
}

async function copyOutput() {
  const text = output.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    props.showToast(t("toolbox.schema.copied"));
  } catch {
    props.showToast(t("toolbox.schema.copyFailed"));
  }
}

function downloadOutput() {
  if (!output.value) return;
  const blob = new Blob([output.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = mode.value === "infer" ? "schema.json" : mode.value === "sample" ? "sample.json" : "schema-outline.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  flash(t("toolbox.schema.saved"));
}

const MODES = computed(() => [
  { key: "validate", label: t("toolbox.schema.modeValidate") },
  { key: "infer", label: t("toolbox.schema.modeInfer") },
  { key: "sample", label: t("toolbox.schema.modeSample") },
  { key: "outline", label: t("toolbox.schema.modeOutline") },
]);

loadToolbox("schema", {}).then((saved) => {
  if (!saved || typeof saved !== "object") return;
  if (typeof saved.json === "string" && saved.json) json.value = saved.json;
  if (typeof saved.schema === "string") schemaText.value = saved.schema;
  if (typeof saved.mode === "string") mode.value = saved.mode;
});

watch([json, schemaText, mode], () => {
  saveToolbox("schema", { json: json.value, schema: schemaText.value, mode: mode.value });
});
</script>

<template>
  <div class="tool-schema">
    <div class="s-toolbar">
      <div class="s-seg">
        <button v-for="item in MODES" :key="item.key" :class="{ on: mode === item.key }" :data-mode="item.key" @click="mode = item.key">
          {{ item.label }}
        </button>
      </div>
      <button class="s-btn" data-role="use-inferred" :disabled="!inferred" @click="useInferred">{{ t("toolbox.schema.useInferred") }}</button>
      <span class="s-spacer"></span>
      <button class="s-btn" data-role="copy" :disabled="!output" @click="copyOutput">
        <Icon name="copy" /> {{ t("toolbox.schema.copy") }}
      </button>
      <button class="s-btn primary" data-role="download" :disabled="!output" @click="downloadOutput">{{ t("toolbox.schema.download") }}</button>
    </div>

    <div class="s-body">
      <label class="s-pane">
        <span class="s-label">{{ t("toolbox.schema.jsonLabel") }}</span>
        <textarea v-model="json" class="s-text" spellcheck="false" data-role="json"></textarea>
        <span v-if="parsedJson.error" class="s-err" data-role="json-error">{{ parsedJson.error }}</span>
      </label>
      <label class="s-pane">
        <span class="s-label">{{ t("toolbox.schema.schemaLabel") }}</span>
        <textarea v-model="schemaText" class="s-text" spellcheck="false" data-role="schema" :placeholder="t('toolbox.schema.schemaPh')"></textarea>
        <span v-if="parsedSchema.error" class="s-err" data-role="schema-error">{{ parsedSchema.error }}</span>
      </label>
    </div>

    <!-- 校验结果：常驻显示，编辑时就能看到 -->
    <div v-if="mode === 'validate' && validation" class="s-result" :data-valid="validation.valid">
      <p v-if="validation.valid" class="s-ok" data-role="valid">{{ t("toolbox.schema.valid") }}</p>
      <template v-else>
        <p class="s-bad" data-role="invalid">{{ t("toolbox.schema.invalid", { n: validation.errors.length }) }}</p>
        <ul class="s-errors" data-role="errors">
          <li v-for="(item, index) in validation.errors" :key="index" :data-keyword="item.keyword">
            <code class="s-path">{{ item.path || "/" }}</code>
            <span>{{ errorText(item) }}</span>
          </li>
        </ul>
      </template>
    </div>

    <!-- 其它模式的输出 -->
    <template v-if="mode !== 'validate'">
      <textarea class="s-output" readonly spellcheck="false" data-role="output" :value="output"></textarea>
    </template>

    <p class="s-hint">{{ t("toolbox.schema.subsetNote") }}</p>
    <p v-if="notice" class="s-ok" data-role="notice">{{ notice }}</p>
    <p v-if="error" class="s-err" data-role="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.tool-schema {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.s-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.s-spacer {
  flex: 1;
}

.s-seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.s-seg button {
  padding: 5px 10px;
  border: 0;
  background: var(--card);
  color: var(--muted);
  cursor: pointer;
  font-size: 0.82rem;
}

.s-seg button.on {
  background: var(--primary-soft);
  color: var(--primary);
}

.s-btn {
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

.s-btn:hover:not(:disabled) {
  border-color: var(--primary);
}

.s-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.s-btn.primary {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.s-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.s-pane {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.s-label {
  font-size: 0.8rem;
  color: var(--muted);
}

.s-text,
.s-output {
  flex: 1;
  min-height: 180px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
  line-height: 1.55;
  resize: none;
}

.s-output {
  min-height: 140px;
}

.s-result {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--soft);
}

.s-ok {
  margin: 0;
  color: var(--ok);
  font-size: 0.85rem;
}

.s-bad {
  margin: 0 0 6px;
  color: var(--danger);
  font-size: 0.85rem;
  font-weight: 600;
}

.s-errors {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 160px;
  overflow: auto;
  font-size: 0.82rem;
}

.s-errors li {
  display: flex;
  gap: 8px;
  padding: 3px 0;
}

.s-path {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--card);
  color: var(--primary);
  font-size: 0.78rem;
}

.s-err {
  margin: 0;
  font-size: 0.8rem;
  color: var(--danger);
}

.s-hint {
  margin: 0;
  font-size: 0.78rem;
  color: var(--muted);
}
</style>
