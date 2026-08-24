<script setup>
import { computed, onBeforeUnmount, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import {
  builtinTemplates,
  mockFieldTypes,
  randomTypes,
  formatMockOutput,
  generateIdentifiers,
  generateMockRows,
  generateRandomValues,
  generateSequence,
  parseUlidTime,
} from "../generatorTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t, locale } = useI18n();

const TABS = computed(() => [
  { key: "identifier", label: t("toolbox.generator.tabIdentifier") },
  { key: "random", label: t("toolbox.generator.tabRandom") },
  { key: "mock", label: t("toolbox.generator.tabMock") },
  { key: "sequence", label: t("toolbox.generator.tabSequence") },
  { key: "template", label: t("toolbox.generator.tabTemplate") },
]);
const RANDOM_TYPES = computed(() => randomTypes());
const MOCK_FIELD_TYPES = computed(() => mockFieldTypes());
const BUILTIN_TEMPLATES = computed(() => builtinTemplates());
const activeTab = ref("identifier");
const copiedKey = ref("");
let copiedTimer = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function copyResult(value, key = "result") {
  if (!value) return props.showToast(t("toolbox.generator.copyEmpty"));
  try {
    await navigator.clipboard.writeText(String(value));
    copiedKey.value = key;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedKey.value = ""; }, 1800);
    props.showToast(t("toolbox.generator.resultCopied"));
  } catch {
    props.showToast(t("toolbox.generator.copyFailed"));
  }
}
async function exportResult(value, defaultPath, extension) {
  if (!value) return props.showToast(t("toolbox.generator.exportEmpty"));
  if (!window.__TAURI_INTERNALS__) return props.showToast(t("toolbox.generator.exportNeedDesktop"));
  try {
    const path = await saveDialog({
      title: t("toolbox.generator.exportDialogTitle"),
      defaultPath,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (!path) return;
    await invoke("export_file", { path, content: String(value) });
    props.showToast(t("toolbox.generator.exported"));
  } catch (error) {
    props.showToast(t("toolbox.generator.exportFailed", { err: errorMessage(error) }));
  }
}
function localDateTimeValue(timestamp = Date.now()) {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 16);
}
function taskState() {
  return { result: "", error: "", count: 0 };
}

// 标识符
const identifierOptions = ref({
  type: "uuid-v4", count: 10, seed: "", uppercase: false, hyphens: true,
  timestampMode: "now", timestamp: localDateTimeValue(), nanoLength: 21,
  nanoAlphabet: "_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
});
const identifierState = ref(taskState());
const identifierFirstTime = computed(() => {
  if (identifierOptions.value.type !== "ulid" || !identifierState.value.result) return "";
  try {
    const first = identifierState.value.result.split("\n")[0];
    return new Date(parseUlidTime(first)).toLocaleString(locale.value);
  } catch { return ""; }
});
function runIdentifiers() {
  try {
    const timestamp = identifierOptions.value.timestampMode === "custom"
      ? new Date(identifierOptions.value.timestamp).getTime()
      : Date.now();
    let values = generateIdentifiers(identifierOptions.value.type, identifierOptions.value.count, {
      seed: identifierOptions.value.seed,
      timestamp,
      length: identifierOptions.value.nanoLength,
      alphabet: identifierOptions.value.nanoAlphabet,
    });
    if (identifierOptions.value.type.startsWith("uuid")) {
      values = values.map((value) => {
        let formatted = identifierOptions.value.hyphens ? value : value.replace(/-/g, "");
        if (identifierOptions.value.uppercase) formatted = formatted.toUpperCase();
        return formatted;
      });
    }
    identifierState.value = { result: values.join("\n"), error: "", count: values.length };
  } catch (error) {
    identifierState.value = { result: "", error: errorMessage(error), count: 0 };
  }
}
runIdentifiers();

// 随机数据
const randomOptions = ref({
  type: "integer", count: 20, seed: "", min: 0, max: 100, precision: 2,
  length: 16, charset: "letter-number", start: "2026-01-01", end: "2026-12-31",
  enumValues: "pending,processing,completed", output: "lines",
});
const randomState = ref(taskState());
const randomNeedsRange = computed(() => ["integer", "decimal"].includes(randomOptions.value.type));
const randomNeedsDate = computed(() => ["date", "datetime"].includes(randomOptions.value.type));
const randomNeedsString = computed(() => randomOptions.value.type === "string");
function runRandomData() {
  try {
    const values = generateRandomValues(randomOptions.value.type, randomOptions.value.count, {
      seed: randomOptions.value.seed,
      min: randomOptions.value.min,
      max: randomOptions.value.max,
      precision: randomOptions.value.precision,
      length: randomOptions.value.length,
      charset: randomOptions.value.charset,
      start: randomOptions.value.start,
      end: randomOptions.value.end,
      values: randomOptions.value.enumValues,
    });
    const result = randomOptions.value.output === "json"
      ? JSON.stringify(values, null, 2)
      : values.map((value) => String(value)).join("\n");
    randomState.value = { result, error: "", count: values.length };
  } catch (error) {
    randomState.value = { result: "", error: errorMessage(error), count: 0 };
  }
}
runRandomData();

// Mock 结构
let fieldSequence = 0;
function newField(data = {}) {
  fieldSequence += 1;
  const type = data.type || "string";
  return {
    id: `field-${fieldSequence}`,
    name: data.name || "field_name",
    type,
    params: data.params ?? (type === "string" ? "16,letter-number" : ""),
    nullable: Boolean(data.nullable),
    nullRate: Number(data.nullRate ?? 0.1),
    unique: Boolean(data.unique),
  };
}
const mockFields = ref([
  newField({ name: "id", type: "sequence", params: "1,1", unique: true }),
  newField({ name: "name", type: "name", params: "" }),
  newField({ name: "email", type: "email", params: "", unique: true }),
  newField({ name: "status", type: "enum", params: "active,disabled" }),
]);
const mockOptions = ref({ count: 10, seed: "", format: "json", tableName: "mock_data" });
const mockState = ref({ ...taskState(), rows: [] });
const mockParamHint = (type) => MOCK_FIELD_TYPES.value.find((item) => item.key === type)?.hint || t("toolbox.generator.noParamsHint");
function addMockField() {
  mockFields.value.push(newField());
}
function removeMockField(index) {
  mockFields.value.splice(index, 1);
}
function runMockData() {
  try {
    const rows = generateMockRows(mockFields.value, mockOptions.value.count, { seed: mockOptions.value.seed });
    const result = formatMockOutput(rows, mockOptions.value.format, { tableName: mockOptions.value.tableName });
    mockState.value = { result, error: "", count: rows.length, rows };
  } catch (error) {
    mockState.value = { result: "", error: errorMessage(error), count: 0, rows: [] };
  }
}
function loadTemplate(template) {
  mockFields.value = template.fields.map((field) => newField(field));
  activeTab.value = "mock";
  runMockData();
  props.showToast(t("toolbox.generator.templateLoaded", { label: template.label }));
}
runMockData();

// 序列
const sequenceOptions = ref({
  start: 1, step: 1, count: 20, radix: 10, padding: 4,
  prefix: "ID-", suffix: "", uppercase: true, output: "lines",
});
const sequenceState = ref(taskState());
function runSequence() {
  try {
    const values = generateSequence(sequenceOptions.value);
    const result = sequenceOptions.value.output === "json"
      ? JSON.stringify(values, null, 2)
      : sequenceOptions.value.output === "comma"
        ? values.join(", ")
        : values.join("\n");
    sequenceState.value = { result, error: "", count: values.length };
  } catch (error) {
    sequenceState.value = { result: "", error: errorMessage(error), count: 0 };
  }
}
runSequence();

// 常用模板
const templateOptions = ref({ key: "user", count: 10, seed: "", format: "json", tableName: "mock_users" });
const templateState = ref({ ...taskState(), rows: [] });
const activeTemplate = computed(() => BUILTIN_TEMPLATES.value.find((item) => item.key === templateOptions.value.key) || BUILTIN_TEMPLATES.value[0]);
function chooseTemplate(template) {
  templateOptions.value.key = template.key;
  if (template.key === "user") templateOptions.value.tableName = "mock_users";
  else if (template.key === "order") templateOptions.value.tableName = "mock_orders";
  else if (template.key === "product") templateOptions.value.tableName = "mock_products";
  else templateOptions.value.tableName = "mock_addresses";
  runTemplate();
}
function runTemplate() {
  try {
    const rows = generateMockRows(activeTemplate.value.fields, templateOptions.value.count, { seed: templateOptions.value.seed });
    const result = formatMockOutput(rows, templateOptions.value.format, { tableName: templateOptions.value.tableName });
    templateState.value = { result, error: "", count: rows.length, rows };
  } catch (error) {
    templateState.value = { result: "", error: errorMessage(error), count: 0, rows: [] };
  }
}
runTemplate();

function outputExtension(format) {
  return format === "sql" ? "sql" : format === "csv" ? "csv" : format === "json" ? "json" : "txt";
}
onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>

<template>
  <div class="generator-tool">
    <nav class="mode-tabs" :aria-label="t('toolbox.generator.navLabel')">
      <button v-for="tab in TABS" :key="tab.key" class="mode-tab" :class="{ on: activeTab === tab.key }" @click="activeTab = tab.key">{{ tab.label }}</button>
    </nav>

    <section v-if="activeTab === 'identifier'" class="workspace split-layout">
      <aside class="panel config-panel">
        <header class="panel-head"><b>{{ t("toolbox.generator.configTitle") }}</b></header>
        <div class="config-body">
          <label class="field"><span>{{ t("toolbox.generator.idTypeLabel") }}</span><select v-model="identifierOptions.type"><option value="uuid-v4">UUID v4</option><option value="uuid-v7">UUID v7</option><option value="ulid">ULID</option><option value="nanoid">Nano ID</option></select></label>
          <div class="two-fields"><label class="field"><span>{{ t("toolbox.generator.countLabel") }}</span><input v-model.number="identifierOptions.count" type="number" min="1" max="10000" /></label><label class="field"><span>{{ t("toolbox.generator.seedLabel") }}</span><input v-model="identifierOptions.seed" :placeholder="t('toolbox.generator.seedPh')" /></label></div>
          <template v-if="identifierOptions.type.startsWith('uuid')"><label class="check-control"><input v-model="identifierOptions.uppercase" type="checkbox" />{{ t("toolbox.generator.optUppercase") }}</label><label class="check-control"><input v-model="identifierOptions.hyphens" type="checkbox" />{{ t("toolbox.generator.optHyphens") }}</label></template>
          <template v-if="identifierOptions.type === 'uuid-v7' || identifierOptions.type === 'ulid'">
            <label class="field"><span>{{ t("toolbox.generator.timeSourceLabel") }}</span><select v-model="identifierOptions.timestampMode"><option value="now">{{ t("toolbox.generator.timeNow") }}</option><option value="custom">{{ t("toolbox.generator.timeCustom") }}</option></select></label>
            <label v-if="identifierOptions.timestampMode === 'custom'" class="field"><span>{{ t("toolbox.generator.customTimeLabel") }}</span><input v-model="identifierOptions.timestamp" type="datetime-local" /></label>
          </template>
          <template v-if="identifierOptions.type === 'nanoid'">
            <label class="field"><span>{{ t("toolbox.generator.lengthLabel") }}</span><input v-model.number="identifierOptions.nanoLength" type="number" min="1" max="256" /></label>
            <label class="field"><span>{{ t("toolbox.generator.alphabetLabel") }}</span><textarea v-model="identifierOptions.nanoAlphabet" class="mini-editor mono" spellcheck="false"></textarea></label>
          </template>
          <button class="btn-primary full-btn" @click="runIdentifiers"><Icon name="dice" :size="15" />{{ t("toolbox.generator.genIdentifierBtn") }}</button>
        </div>
      </aside>
      <section class="panel result-panel" :class="{ invalid: identifierState.error }">
        <header class="panel-head"><b>{{ t("toolbox.generator.resultTitle") }}</b><span>{{ t("toolbox.generator.countItems", { count: identifierState.count }) }}</span><div class="panel-actions"><button class="icon-btn xs" :class="{ copied: copiedKey === 'identifier' }" :title="copiedKey === 'identifier' ? t('toolbox.generator.copiedTitle') : t('toolbox.generator.copyTitle')" @click="copyResult(identifierState.result, 'identifier')"><Icon :name="copiedKey === 'identifier' ? 'check' : 'copy'" :size="13" /></button><button class="icon-btn xs" :title="t('toolbox.generator.exportTxtTitle')" @click="exportResult(identifierState.result, 'identifiers.txt', 'txt')"><Icon name="download" :size="13" /></button></div></header>
        <div v-if="identifierState.error" class="error-state"><Icon name="alert" :size="20" />{{ identifierState.error }}</div>
        <template v-else><div v-if="identifierFirstTime" class="result-note">{{ t("toolbox.generator.ulidFirstTime", { time: identifierFirstTime }) }}</div><textarea :value="identifierState.result" class="result-editor mono" readonly spellcheck="false"></textarea></template>
      </section>
    </section>

    <section v-else-if="activeTab === 'random'" class="workspace column-layout">
      <div class="control-bar random-controls">
        <label class="field type-field"><span>{{ t("toolbox.generator.dataTypeLabel") }}</span><select v-model="randomOptions.type"><option v-for="item in RANDOM_TYPES" :key="item.key" :value="item.key">{{ item.label }}</option></select></label>
        <label class="field count-field"><span>{{ t("toolbox.generator.countLabel") }}</span><input v-model.number="randomOptions.count" type="number" min="1" max="10000" /></label>
        <label class="field seed-field"><span>{{ t("toolbox.generator.seedLabel") }}</span><input v-model="randomOptions.seed" :placeholder="t('toolbox.generator.seedPh')" /></label>
        <template v-if="randomNeedsRange"><label class="field number-field"><span>{{ t("toolbox.generator.minLabel") }}</span><input v-model.number="randomOptions.min" type="number" /></label><label class="field number-field"><span>{{ t("toolbox.generator.maxLabel") }}</span><input v-model.number="randomOptions.max" type="number" /></label><label v-if="randomOptions.type === 'decimal'" class="field number-field"><span>{{ t("toolbox.generator.precisionLabel") }}</span><input v-model.number="randomOptions.precision" type="number" min="0" max="12" /></label></template>
        <template v-if="randomNeedsString"><label class="field number-field"><span>{{ t("toolbox.generator.lengthLabel") }}</span><input v-model.number="randomOptions.length" type="number" min="1" max="1024" /></label><label class="field charset-field"><span>{{ t("toolbox.generator.charsetLabel") }}</span><select v-model="randomOptions.charset"><option value="letter-number">{{ t("toolbox.generator.charsetLetterNumber") }}</option><option value="lower-number">{{ t("toolbox.generator.charsetLowerNumber") }}</option><option value="upper-number">{{ t("toolbox.generator.charsetUpperNumber") }}</option><option value="number">{{ t("toolbox.generator.charsetNumber") }}</option><option value="all">{{ t("toolbox.generator.charsetAll") }}</option></select></label></template>
        <template v-if="randomNeedsDate"><label class="field date-field"><span>{{ t("toolbox.generator.startDateLabel") }}</span><input v-model="randomOptions.start" type="date" /></label><label class="field date-field"><span>{{ t("toolbox.generator.endDateLabel") }}</span><input v-model="randomOptions.end" type="date" /></label></template>
        <label v-if="randomOptions.type === 'enum'" class="field enum-field"><span>{{ t("toolbox.generator.enumLabel") }}</span><input v-model="randomOptions.enumValues" :placeholder="t('toolbox.generator.enumPh')" /></label>
        <label class="field output-type-field"><span>{{ t("toolbox.generator.outputLabel") }}</span><select v-model="randomOptions.output"><option value="lines">{{ t("toolbox.generator.outputLines") }}</option><option value="json">{{ t("toolbox.generator.outputJson") }}</option></select></label>
        <button class="btn-primary" @click="runRandomData"><Icon name="dice" :size="15" />{{ t("toolbox.generator.generateBtn") }}</button>
      </div>
      <section class="panel result-panel" :class="{ invalid: randomState.error }"><header class="panel-head"><b>{{ t("toolbox.generator.randomTitle") }}</b><span>{{ t("toolbox.generator.countItems", { count: randomState.count }) }}</span><div class="panel-actions"><button class="icon-btn xs" :class="{ copied: copiedKey === 'random' }" :title="t('toolbox.generator.copyTitle')" @click="copyResult(randomState.result, 'random')"><Icon :name="copiedKey === 'random' ? 'check' : 'copy'" :size="13" /></button><button class="icon-btn xs" :title="t('toolbox.generator.exportResultTitle')" @click="exportResult(randomState.result, randomOptions.output === 'json' ? 'random-data.json' : 'random-data.txt', randomOptions.output === 'json' ? 'json' : 'txt')"><Icon name="download" :size="13" /></button></div></header><div v-if="randomState.error" class="error-state"><Icon name="alert" :size="20" />{{ randomState.error }}</div><textarea v-else :value="randomState.result" class="result-editor mono" readonly spellcheck="false"></textarea></section>
    </section>

    <section v-else-if="activeTab === 'mock'" class="workspace mock-layout">
      <div class="mock-toolbar">
        <label class="field count-field"><span>{{ t("toolbox.generator.rowCountLabel") }}</span><input v-model.number="mockOptions.count" type="number" min="1" max="10000" /></label>
        <label class="field seed-field"><span>{{ t("toolbox.generator.seedLabel") }}</span><input v-model="mockOptions.seed" :placeholder="t('toolbox.generator.seedPh')" /></label>
        <label class="field output-type-field"><span>{{ t("toolbox.generator.formatLabel") }}</span><select v-model="mockOptions.format"><option value="json">JSON</option><option value="csv">CSV</option><option value="sql">SQL INSERT</option></select></label>
        <label v-if="mockOptions.format === 'sql'" class="field table-field"><span>{{ t("toolbox.generator.tableNameLabel") }}</span><input v-model="mockOptions.tableName" class="mono" /></label>
        <button class="btn-ghost" @click="addMockField"><Icon name="plus" :size="14" />{{ t("toolbox.generator.addFieldBtn") }}</button>
        <button class="btn-primary" @click="runMockData"><Icon name="dice" :size="15" />{{ t("toolbox.generator.genMockBtn") }}</button>
      </div>
      <div class="mock-grid">
        <section class="panel field-panel"><header class="panel-head"><b>{{ t("toolbox.generator.fieldRulesTitle") }}</b><span>{{ t("toolbox.generator.fieldCount", { count: mockFields.length }) }}</span></header><div class="field-table-wrap"><table class="field-table"><thead><tr><th>{{ t("toolbox.generator.thFieldName") }}</th><th>{{ t("toolbox.generator.thType") }}</th><th>{{ t("toolbox.generator.thParams") }}</th><th>{{ t("toolbox.generator.thNullable") }}</th><th>{{ t("toolbox.generator.thUnique") }}</th><th></th></tr></thead><tbody><tr v-for="(field, index) in mockFields" :key="field.id"><td><input v-model="field.name" class="mono" :aria-label="t('toolbox.generator.fieldNameAria')" /></td><td><select v-model="field.type"><option v-for="item in MOCK_FIELD_TYPES" :key="item.key" :value="item.key">{{ item.label }}</option></select></td><td><input v-model="field.params" class="mono" :placeholder="mockParamHint(field.type)" :title="mockParamHint(field.type)" /></td><td><label class="cell-check"><input v-model="field.nullable" type="checkbox" /><input v-if="field.nullable" v-model.number="field.nullRate" class="rate-input" type="number" min="0" max="1" step="0.1" :title="t('toolbox.generator.nullRateTitle')" /></label></td><td><input v-model="field.unique" type="checkbox" /></td><td><button class="icon-btn xs" :title="t('toolbox.generator.removeFieldTitle')" @click="removeMockField(index)"><Icon name="x" :size="13" /></button></td></tr></tbody></table></div></section>
        <section class="panel result-panel" :class="{ invalid: mockState.error }"><header class="panel-head"><b>{{ t("toolbox.generator.mockResultTitle") }}</b><span>{{ t("toolbox.generator.countRows", { count: mockState.count }) }}</span><div class="panel-actions"><button class="icon-btn xs" :class="{ copied: copiedKey === 'mock' }" :title="t('toolbox.generator.copyTitle')" @click="copyResult(mockState.result, 'mock')"><Icon :name="copiedKey === 'mock' ? 'check' : 'copy'" :size="13" /></button><button class="icon-btn xs" :title="t('toolbox.generator.exportResultTitle')" @click="exportResult(mockState.result, `mock-data.${outputExtension(mockOptions.format)}`, outputExtension(mockOptions.format))"><Icon name="download" :size="13" /></button></div></header><div v-if="mockState.error" class="error-state"><Icon name="alert" :size="20" />{{ mockState.error }}</div><textarea v-else :value="mockState.result" class="result-editor mono" readonly spellcheck="false"></textarea></section>
      </div>
    </section>

    <section v-else-if="activeTab === 'sequence'" class="workspace split-layout">
      <aside class="panel config-panel"><header class="panel-head"><b>{{ t("toolbox.generator.seqConfigTitle") }}</b></header><div class="config-body"><div class="two-fields"><label class="field"><span>{{ t("toolbox.generator.startValueLabel") }}</span><input v-model.number="sequenceOptions.start" type="number" /></label><label class="field"><span>{{ t("toolbox.generator.stepLabel") }}</span><input v-model.number="sequenceOptions.step" type="number" /></label></div><div class="two-fields"><label class="field"><span>{{ t("toolbox.generator.countLabel") }}</span><input v-model.number="sequenceOptions.count" type="number" min="1" max="10000" /></label><label class="field"><span>{{ t("toolbox.generator.radixLabel") }}</span><select v-model.number="sequenceOptions.radix"><option :value="2">{{ t("toolbox.generator.radix2") }}</option><option :value="8">{{ t("toolbox.generator.radix8") }}</option><option :value="10">{{ t("toolbox.generator.radix10") }}</option><option :value="16">{{ t("toolbox.generator.radix16") }}</option><option :value="36">{{ t("toolbox.generator.radix36") }}</option></select></label></div><div class="two-fields"><label class="field"><span>{{ t("toolbox.generator.paddingLabel") }}</span><input v-model.number="sequenceOptions.padding" type="number" min="0" max="128" /></label><label class="field"><span>{{ t("toolbox.generator.outputModeLabel") }}</span><select v-model="sequenceOptions.output"><option value="lines">{{ t("toolbox.generator.outputLines") }}</option><option value="comma">{{ t("toolbox.generator.outputComma") }}</option><option value="json">{{ t("toolbox.generator.outputJson") }}</option></select></label></div><div class="two-fields"><label class="field"><span>{{ t("toolbox.generator.prefixLabel") }}</span><input v-model="sequenceOptions.prefix" /></label><label class="field"><span>{{ t("toolbox.generator.suffixLabel") }}</span><input v-model="sequenceOptions.suffix" /></label></div><label class="check-control"><input v-model="sequenceOptions.uppercase" type="checkbox" />{{ t("toolbox.generator.optLetterUpper") }}</label><button class="btn-primary full-btn" @click="runSequence"><Icon name="sort" :size="15" />{{ t("toolbox.generator.genSeqBtn") }}</button></div></aside>
      <section class="panel result-panel" :class="{ invalid: sequenceState.error }"><header class="panel-head"><b>{{ t("toolbox.generator.seqResultTitle") }}</b><span>{{ t("toolbox.generator.countItems", { count: sequenceState.count }) }}</span><div class="panel-actions"><button class="icon-btn xs" :class="{ copied: copiedKey === 'sequence' }" :title="t('toolbox.generator.copyTitle')" @click="copyResult(sequenceState.result, 'sequence')"><Icon :name="copiedKey === 'sequence' ? 'check' : 'copy'" :size="13" /></button><button class="icon-btn xs" :title="t('toolbox.generator.exportResultTitle')" @click="exportResult(sequenceState.result, sequenceOptions.output === 'json' ? 'sequence.json' : 'sequence.txt', sequenceOptions.output === 'json' ? 'json' : 'txt')"><Icon name="download" :size="13" /></button></div></header><div v-if="sequenceState.error" class="error-state"><Icon name="alert" :size="20" />{{ sequenceState.error }}</div><textarea v-else :value="sequenceState.result" class="result-editor mono" readonly spellcheck="false"></textarea></section>
    </section>

    <section v-else class="workspace template-layout">
      <div class="template-list"><button v-for="template in BUILTIN_TEMPLATES" :key="template.key" class="template-card" :class="{ on: templateOptions.key === template.key }" @click="chooseTemplate(template)"><span class="template-icon"><Icon :name="template.key === 'user' ? 'user' : template.key === 'order' ? 'note' : template.key === 'product' ? 'box' : 'home'" :size="20" /></span><span><b>{{ template.label }}</b><small>{{ template.desc }}</small></span><em>{{ t("toolbox.generator.templateFields", { count: template.fields.length }) }}</em></button></div>
      <div class="template-workspace">
        <div class="template-toolbar"><label class="field count-field"><span>{{ t("toolbox.generator.rowCountLabel") }}</span><input v-model.number="templateOptions.count" type="number" min="1" max="10000" /></label><label class="field seed-field"><span>{{ t("toolbox.generator.seedLabel") }}</span><input v-model="templateOptions.seed" :placeholder="t('toolbox.generator.seedPh')" /></label><label class="field output-type-field"><span>{{ t("toolbox.generator.formatLabel") }}</span><select v-model="templateOptions.format"><option value="json">JSON</option><option value="csv">CSV</option><option value="sql">SQL INSERT</option></select></label><label v-if="templateOptions.format === 'sql'" class="field table-field"><span>{{ t("toolbox.generator.tableNameLabel") }}</span><input v-model="templateOptions.tableName" class="mono" /></label><button class="btn-ghost" @click="loadTemplate(activeTemplate)"><Icon name="edit" :size="14" />{{ t("toolbox.generator.loadMockBtn") }}</button><button class="btn-primary" @click="runTemplate"><Icon name="dice" :size="15" />{{ t("toolbox.generator.generateBtn") }}</button></div>
        <div class="template-detail"><section class="panel schema-panel"><header class="panel-head"><b>{{ t("toolbox.generator.tplFieldsTitle", { label: activeTemplate.label }) }}</b><span>{{ t("toolbox.generator.tplFieldCount", { count: activeTemplate.fields.length }) }}</span></header><div class="schema-list"><div v-for="field in activeTemplate.fields" :key="field.name"><code>{{ field.name }}</code><span>{{ MOCK_FIELD_TYPES.find((item) => item.key === field.type)?.label || field.type }}</span><small :title="field.params">{{ field.params || t("toolbox.generator.defaultParams") }}</small></div></div></section><section class="panel result-panel" :class="{ invalid: templateState.error }"><header class="panel-head"><b>{{ t("toolbox.generator.tplResultTitle") }}</b><span>{{ t("toolbox.generator.countRows", { count: templateState.count }) }}</span><div class="panel-actions"><button class="icon-btn xs" :class="{ copied: copiedKey === 'template' }" :title="t('toolbox.generator.copyTitle')" @click="copyResult(templateState.result, 'template')"><Icon :name="copiedKey === 'template' ? 'check' : 'copy'" :size="13" /></button><button class="icon-btn xs" :title="t('toolbox.generator.exportResultTitle')" @click="exportResult(templateState.result, `${activeTemplate.key}.${outputExtension(templateOptions.format)}`, outputExtension(templateOptions.format))"><Icon name="download" :size="13" /></button></div></header><div v-if="templateState.error" class="error-state"><Icon name="alert" :size="20" />{{ templateState.error }}</div><textarea v-else :value="templateState.result" class="result-editor mono" readonly spellcheck="false"></textarea></section></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.generator-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.mode-tabs { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border); }
.mode-tab { flex-shrink: 0; padding: var(--sp-2) var(--sp-4); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text-weak); font-size: var(--fs-md); cursor: pointer; transition: color 0.15s, background 0.15s, border-color 0.15s; }
.mode-tab:hover { color: var(--text); background: var(--ghost); }
.mode-tab.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }
.workspace { flex: 1; min-height: 0; }
.split-layout { display: grid; grid-template-columns: minmax(245px, 0.7fr) minmax(360px, 1.3fr); gap: var(--sp-3); }
.column-layout, .mock-layout, .template-layout { display: flex; flex-direction: column; gap: var(--sp-3); }
.panel { min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.panel.invalid { border-color: var(--border-danger); }
.panel-head { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.panel-head > span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.panel-actions { margin-left: var(--sp-1); display: flex; gap: var(--sp-1); }
.field { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.field > span { color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
.field input, .field select, .field-table input, .field-table select { min-width: 0; height: 34px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none; background: var(--card); color: var(--text); font-size: var(--fs-md); }
.field input:focus, .field select:focus, .field-table input:focus, .field-table select:focus, .mini-editor:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.check-control { display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 30px; color: var(--text-weak); font-size: var(--fs-sm); cursor: pointer; }
.check-control input, .field-table input[type="checkbox"] { accent-color: var(--primary); }
.config-panel, .result-panel, .field-panel, .schema-panel { display: flex; flex-direction: column; }
.config-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
.two-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); }
.mini-editor { width: 100%; min-height: 66px; padding: var(--sp-3); resize: vertical; border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none; background: var(--card); color: var(--text-code); font-size: var(--fs-xs); }
.full-btn { width: 100%; justify-content: center; margin-top: auto; }
.result-editor { flex: 1; min-height: 0; width: 100%; padding: var(--sp-4); resize: none; border: none; outline: none; background: color-mix(in srgb, var(--text) 1.5%, transparent); color: var(--text-code); font-size: var(--fs-md); line-height: var(--lh-body); overflow: auto; }
.result-note { flex-shrink: 0; padding: var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--border); background: var(--primary-soft); color: var(--primary-hover); font-size: var(--fs-sm); }
.mono, code { font-family: var(--font-mono); }
.error-state { flex: 1; min-height: 130px; display: flex; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-5); background: var(--danger-soft); color: var(--danger-deep); font-size: var(--fs-sm); text-align: center; }
.icon-btn.copied { border-color: var(--success-border); background: var(--success-soft); color: var(--success-deep); }

.control-bar, .mock-toolbar, .template-toolbar { flex-shrink: 0; min-height: 40px; display: flex; align-items: flex-end; gap: var(--sp-3); }
.random-controls { flex-wrap: wrap; }
.type-field { width: 138px; }
.count-field { width: 82px; }
.seed-field { flex: 1; min-width: 130px; max-width: 220px; }
.number-field { width: 90px; }
.charset-field { width: 145px; }
.date-field { width: 138px; }
.enum-field { flex: 1; min-width: 190px; }
.output-type-field { width: 115px; }
.table-field { width: 140px; }

.mock-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(470px, 1.2fr) minmax(320px, 0.8fr); gap: var(--sp-3); }
.field-table-wrap { flex: 1; min-height: 0; overflow: auto; }
.field-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.field-table th { position: sticky; top: 0; z-index: 1; height: 34px; padding: 0 var(--sp-2); background: var(--card-soft); color: var(--text-dim); font-size: var(--fs-xs); text-align: left; }
.field-table td { height: 44px; padding: var(--sp-1) var(--sp-2); border-top: 1px solid var(--border); }
.field-table th:nth-child(1) { width: 116px; }
.field-table th:nth-child(2) { width: 118px; }
.field-table th:nth-child(3) { width: 170px; }
.field-table th:nth-child(4) { width: 82px; }
.field-table th:nth-child(5) { width: 48px; text-align: center; }
.field-table th:nth-child(6) { width: 36px; }
.field-table input:not([type="checkbox"]), .field-table select { width: 100%; height: 32px; font-size: var(--fs-sm); }
.field-table td:nth-child(5), .field-table td:nth-child(6) { text-align: center; }
.cell-check { display: flex; align-items: center; gap: var(--sp-1); }
.rate-input { width: 52px !important; padding: 0 var(--sp-1) !important; }

.template-list { flex-shrink: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-3); }
.template-card { min-width: 0; min-height: 66px; display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); color: var(--text); text-align: left; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.template-card:hover { border-color: var(--border-strong); }
.template-card.on { border-color: var(--border-blue); background: var(--primary-soft); }
.template-icon { width: 38px; height: 38px; display: grid; place-items: center; border-radius: var(--r-sm); background: var(--well); color: var(--primary-hover); }
.template-card.on .template-icon { background: var(--card); }
.template-card > span:nth-child(2) { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.template-card b { font-size: var(--fs-md); }
.template-card small { overflow: hidden; color: var(--muted); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.template-card em { color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); font-style: normal; white-space: nowrap; }
.template-workspace { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.template-detail { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(210px, 0.55fr) minmax(360px, 1.45fr); gap: var(--sp-3); }
.schema-list { flex: 1; min-height: 0; overflow: auto; }
.schema-list > div { display: grid; grid-template-columns: minmax(0, 1fr) 86px minmax(0, 1fr); align-items: center; gap: var(--sp-2); min-height: 38px; padding: 0 var(--sp-3); border-bottom: 1px solid var(--border); }
.schema-list code { overflow: hidden; color: var(--text-code); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.schema-list span { color: var(--primary-hover); font-size: var(--fs-xs); }
.schema-list small { overflow: hidden; color: var(--muted); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 820px) {
  .split-layout { grid-template-columns: minmax(220px, 0.75fr) minmax(320px, 1.25fr); overflow: auto; }
  .mock-toolbar, .template-toolbar { flex-wrap: wrap; }
  .mock-grid { grid-template-columns: 1fr; grid-template-rows: minmax(250px, 1fr) minmax(260px, 1fr); overflow: auto; }
  .template-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .template-layout { overflow: auto; }
  .template-workspace { min-height: 500px; }
  .template-detail { grid-template-columns: minmax(190px, 0.6fr) minmax(320px, 1.4fr); }
}
</style>
