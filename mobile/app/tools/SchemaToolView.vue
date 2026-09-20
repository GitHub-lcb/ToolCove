<script setup>
// JSON Schema 工具（手机端）：推断、校验、造样例、解读结构。
//
// 与桌面端**共用同一份纯逻辑**（src/jsonSchema.js，60 条单测），所以结果两端一致。
// 界面按手机重排：JSON 与 Schema 两个输入**不能并排**（393px 宽并排都没法看），
// 改成 chips 切换；校验结果常驻显示。
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { loadToolbox, saveToolbox } from "../../../src/toolboxStore.js";
import { inferSchema, sampleFromSchema, summarizeSchema, validateSchema } from "../../../src/jsonSchema.js";

const { t } = useI18n();

const SAMPLE_JSON = JSON.stringify(
  { orderId: "SO20260101", customer: { name: "张三", email: "zhangsan@example.com" }, items: [{ sku: "A-1", qty: 2 }], createdAt: "2026-01-01T10:00:00Z" },
  null,
  2
);

const json = ref(SAMPLE_JSON);
const schemaText = ref("");
const mode = ref("validate");
const inputTab = ref("json"); // json | schema
const notice = ref("");

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

const validation = computed(() => {
  if (!parsedJson.value.ok || !parsedSchema.value.ok) return null;
  return validateSchema(parsedJson.value.value, parsedSchema.value.value);
});

const inferred = computed(() => (parsedJson.value.ok ? inferSchema(parsedJson.value.value) : null));
const sample = computed(() => (parsedSchema.value.ok ? sampleFromSchema(parsedSchema.value.value) : null));
const outlineRows = computed(() => (parsedSchema.value.ok ? summarizeSchema(parsedSchema.value.value) : []));

const output = computed(() => {
  if (mode.value === "infer") return inferred.value ? JSON.stringify(inferred.value, null, 2) : "";
  if (mode.value === "sample") return sample.value === null ? "" : JSON.stringify(sample.value, null, 2);
  if (mode.value === "outline") {
    return outlineRows.value.map((row) => `${row.path || "(root)"}  ${row.type}${row.note ? `  [${row.note}]` : ""}`).join("\n");
  }
  return "";
});

const errorText = (item) => t(`toolbox.schema.err_${item.keyword}`, { ...(item.params || {}), path: item.path || "/" });

function flash(message) {
  notice.value = message;
  setTimeout(() => (notice.value = ""), 2000);
}

function useInferred() {
  if (!inferred.value) return;
  schemaText.value = JSON.stringify(inferred.value, null, 2);
  mode.value = "validate";
  inputTab.value = "schema";
  flash(t("toolbox.schema.inferredApplied"));
}

async function copyOutput() {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    flash(t("toolbox.schema.copied"));
  } catch {
    flash(t("toolbox.schema.copyFailed"));
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
  <section class="m-tool" data-tool="schema">
    <div class="m-chips" data-role="modes">
      <button v-for="item in MODES" :key="item.key" class="m-chip" :class="{ on: mode === item.key }" :data-mode="item.key" @click="mode = item.key">
        {{ item.label }}
      </button>
    </div>

    <div class="m-chips" data-role="inputs">
      <button class="m-chip" :class="{ on: inputTab === 'json' }" data-input="json" @click="inputTab = 'json'">{{ t("toolbox.schema.jsonLabel") }}</button>
      <button class="m-chip" :class="{ on: inputTab === 'schema' }" data-input="schema" @click="inputTab = 'schema'">{{ t("toolbox.schema.schemaLabel") }}</button>
      <button class="m-chip" data-role="use-inferred" :disabled="!inferred" @click="useInferred">{{ t("toolbox.schema.useInferred") }}</button>
    </div>

    <template v-if="inputTab === 'json'">
      <label class="m-field">
        <span>{{ t("toolbox.schema.jsonLabel") }}</span>
        <textarea v-model="json" rows="10" spellcheck="false" data-role="json"></textarea>
      </label>
      <p v-if="parsedJson.error" class="m-err" data-role="json-error">{{ parsedJson.error }}</p>
    </template>
    <template v-else>
      <label class="m-field">
        <span>{{ t("toolbox.schema.schemaLabel") }}</span>
        <textarea v-model="schemaText" rows="10" spellcheck="false" data-role="schema" :placeholder="t('toolbox.schema.schemaPh')"></textarea>
      </label>
      <p v-if="parsedSchema.error" class="m-err" data-role="schema-error">{{ parsedSchema.error }}</p>
    </template>

    <!-- 校验结果常驻 -->
    <template v-if="mode === 'validate'">
      <p v-if="validation?.valid" class="m-ok" data-role="valid">{{ t("toolbox.schema.valid") }}</p>
      <template v-else-if="validation">
        <p class="m-err" data-role="invalid">{{ t("toolbox.schema.invalid", { n: validation.errors.length }) }}</p>
        <ul class="m-stats" data-role="errors">
          <li v-for="(item, index) in validation.errors" :key="index" :data-keyword="item.keyword">
            <b>{{ item.path || "/" }}</b>
            <span>{{ errorText(item) }}</span>
          </li>
        </ul>
      </template>
    </template>

    <template v-else>
      <label class="m-field">
        <span>{{ t("toolbox.schema.outputLabel") }}</span>
        <textarea readonly rows="10" spellcheck="false" data-role="output" :value="output"></textarea>
      </label>
      <div class="m-actions">
        <button class="m-btn primary" data-role="download" @click="downloadOutput">{{ t("toolbox.schema.download") }}</button>
        <button class="m-btn" data-role="copy" @click="copyOutput">{{ t("toolbox.schema.copy") }}</button>
      </div>
    </template>

    <p class="m-hint-sm">{{ t("toolbox.schema.subsetNote") }}</p>
    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
  </section>
</template>
