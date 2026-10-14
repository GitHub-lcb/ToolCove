<script setup>
// 自定义工作流导入 / 映射编辑对话框（分两步：粘贴或选文件 → 指定提示词与参数节点）。
// API 格式校验、自动映射建议都来自 comfy.js 的纯函数；本组件只做交互与展示。
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { parseWorkflowGraph } from "./comfy.js";
import Icon from "../../ui/Icon.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  initial: { type: Object, default: null }, // 编辑映射模式：已有工作流记录（{ id, name, workflow, mapping }）
});
const emit = defineEmits(["close", "save"]);

const { t } = useI18n();

const step = ref("import"); // import | mapping
const name = ref("");
const text = ref("");
const fileName = ref("");
const errorKey = ref("");
const errorDetail = ref("");
const parsed = ref(null); // { workflow, nodes, suggestion }
const mapping = ref({ positive: "", negative: "", params: "", latent: "" });

const ERR_KEY = {
  empty: "toolbox.prompt.wfErrEmpty",
  badJson: "toolbox.prompt.wfErrBadJson",
  badShape: "toolbox.prompt.wfErrBadShape",
  uiFormat: "toolbox.prompt.wfErrUiFormat",
};

const posOptions = computed(() => (parsed.value?.nodes ?? []).filter((node) => node.textKey));
const allOptions = computed(() => parsed.value?.nodes ?? []);
const canSave = computed(() => Boolean(name.value.trim()));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    errorKey.value = "";
    errorDetail.value = "";
    if (props.initial) {
      const result = parseWorkflowGraph(props.initial.workflow);
      parsed.value = result.ok ? result : null;
      name.value = props.initial.name;
      mapping.value = {
        positive: props.initial.mapping?.positive?.node ?? "",
        negative: props.initial.mapping?.negative?.node ?? "",
        params: props.initial.mapping?.params?.node ?? "",
        latent: props.initial.mapping?.latent?.node ?? "",
      };
      step.value = "mapping";
    } else {
      step.value = "import";
      name.value = "";
      text.value = "";
      fileName.value = "";
      parsed.value = null;
      mapping.value = { positive: "", negative: "", params: "", latent: "" };
    }
  }
);

function onFile(event) {
  const file = event.target?.files?.[0];
  if (!file) return;
  fileName.value = String(file.name ?? "").replace(/\.json$/i, "");
  const reader = new FileReader();
  reader.onload = () => {
    text.value = String(reader.result ?? "");
  };
  reader.readAsText(file);
  event.target.value = "";
}

function parseNow() {
  errorKey.value = "";
  errorDetail.value = "";
  const result = parseWorkflowGraph(text.value);
  if (!result.ok) {
    errorKey.value = ERR_KEY[result.error] ?? "toolbox.prompt.wfErrBadShape";
    errorDetail.value = result.error === "badJson" ? String(result.detail ?? "") : "";
    return;
  }
  parsed.value = result;
  if (!name.value.trim()) name.value = fileName.value || "";
  mapping.value = {
    positive: result.suggestion?.positive?.node ?? "",
    negative: result.suggestion?.negative?.node ?? "",
    params: result.suggestion?.params?.node ?? "",
    latent: result.suggestion?.latent?.node ?? "",
  };
  step.value = "mapping";
}

function nodeById(id) {
  return (parsed.value?.nodes ?? []).find((node) => node.id === id) || null;
}

function buildMapping() {
  const entry = (id, withInput) => {
    if (!id) return null;
    const node = nodeById(id);
    if (!node) return null;
    return withInput ? { node: id, input: node.textKey || "text" } : { node: id };
  };
  return {
    positive: entry(mapping.value.positive, true),
    negative: entry(mapping.value.negative, true),
    params: entry(mapping.value.params, false),
    latent: entry(mapping.value.latent, false),
  };
}

function save() {
  if (!parsed.value || !canSave.value) return;
  emit("save", {
    id: props.initial?.id ?? "",
    name: name.value.trim(),
    workflow: parsed.value.workflow,
    mapping: buildMapping(),
  });
}
</script>

<template>
  <div v-if="open" class="wf-mask" data-role="wf-dialog">
    <div class="wf-box">
      <div class="wf-head">
        <h3>{{ t("toolbox.prompt.wfTitle") }}</h3>
        <button type="button" class="mini" data-role="wf-close" @click="emit('close')">
          <Icon name="x" :size="14" />
        </button>
      </div>

      <template v-if="step === 'import'">
        <label class="field">
          <span>{{ t("toolbox.prompt.wfNamePh") }}</span>
          <input v-model="name" type="text" :placeholder="t('toolbox.prompt.wfNamePh')" data-role="wf-name" />
        </label>
        <label class="field">
          <span>{{ t("toolbox.prompt.wfImport") }}</span>
          <textarea v-model="text" rows="7" :placeholder="t('toolbox.prompt.wfImportPh')" data-role="wf-text"></textarea>
        </label>
        <div class="row">
          <input id="wf-file" class="file" type="file" accept=".json,application/json" data-role="wf-file" @change="onFile" />
          <label for="wf-file" class="ghost">{{ t("toolbox.prompt.impChooseFile") }}</label>
          <span v-if="fileName" class="hint">{{ fileName }}</span>
        </div>
        <p v-if="errorKey" class="err" data-role="wf-error">{{ t(errorKey) }}<span v-if="errorDetail">（{{ errorDetail }}）</span></p>
        <div class="actions">
          <button type="button" class="ghost" data-role="wf-cancel" @click="emit('close')">{{ t("toolbox.prompt.editorCancel") }}</button>
          <button type="button" class="primary" data-role="wf-apply" @click="parseNow">{{ t("toolbox.prompt.wfApply") }}</button>
        </div>
      </template>

      <template v-else>
        <label class="field">
          <span>{{ t("toolbox.prompt.wfNamePh") }}</span>
          <input v-model="name" type="text" data-role="wf-name" />
        </label>
        <div class="map-head">
          <span>{{ t("toolbox.prompt.wfMappingTitle") }}</span>
          <span class="hint">{{ t("toolbox.prompt.wfMapAuto") }} · {{ t("toolbox.prompt.wfNodes", { n: allOptions.length }) }}</span>
        </div>
        <div class="node-list" data-role="wf-nodes">
          <span v-for="node in allOptions" :key="node.id" class="node-chip">
            #{{ node.id }} {{ node.classType }}<template v-if="node.title">（{{ node.title }}）</template>
          </span>
        </div>
        <div class="map-grid">
          <label class="field">
            <span>{{ t("toolbox.prompt.wfMapPositive") }}</span>
            <select v-model="mapping.positive" data-role="wf-map-positive">
              <option value="">{{ t("toolbox.prompt.wfMapNone") }}</option>
              <option v-for="node in posOptions" :key="node.id" :value="node.id">#{{ node.id }} {{ node.classType }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t("toolbox.prompt.wfMapNegative") }}</span>
            <select v-model="mapping.negative" data-role="wf-map-negative">
              <option value="">{{ t("toolbox.prompt.wfMapNone") }}</option>
              <option v-for="node in posOptions" :key="node.id" :value="node.id">#{{ node.id }} {{ node.classType }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t("toolbox.prompt.wfMapParams") }}</span>
            <select v-model="mapping.params" data-role="wf-map-params">
              <option value="">{{ t("toolbox.prompt.wfMapNone") }}</option>
              <option v-for="node in allOptions" :key="node.id" :value="node.id">#{{ node.id }} {{ node.classType }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t("toolbox.prompt.wfMapLatent") }}</span>
            <select v-model="mapping.latent" data-role="wf-map-latent">
              <option value="">{{ t("toolbox.prompt.wfMapNone") }}</option>
              <option v-for="node in allOptions" :key="node.id" :value="node.id">#{{ node.id }} {{ node.classType }}</option>
            </select>
          </label>
        </div>
        <div class="actions">
          <button type="button" class="ghost" data-role="wf-cancel" @click="emit('close')">{{ t("toolbox.prompt.editorCancel") }}</button>
          <button type="button" class="primary" :disabled="!canSave" data-role="wf-save" @click="save">{{ t("toolbox.prompt.wfSave") }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wf-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
}
.wf-box {
  width: min(680px, calc(100vw - 48px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md, 10px);
  box-shadow: var(--shadow);
  padding: var(--sp-5) var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.wf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.wf-head h3 {
  margin: 0;
  font-size: var(--fs-lg);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-sm);
  color: var(--text-weak);
  min-width: 0;
}
.map-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-sm);
  font-weight: 600;
}
.hint {
  font-size: var(--fs-xs);
  color: var(--text-weak);
  font-weight: 400;
}
.node-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 96px;
  overflow: auto;
}
.node-chip {
  font-size: var(--fs-xs);
  background: var(--well);
  color: var(--text-weak);
  border-radius: var(--r-xs, 6px);
  padding: 2px var(--sp-1);
}
.map-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.file {
  display: none;
}
.err {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-sm);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.primary {
  background: var(--primary);
  color: var(--text-invert);
  border: none;
  border-radius: var(--r-sm, 8px);
  padding: 7px var(--sp-6);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.6;
  cursor: default;
}
.ghost {
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 8px);
  background: transparent;
  color: var(--text);
  padding: var(--sp-1) var(--sp-4);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.ghost:hover {
  background: var(--ghost);
}
.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-weak);
  cursor: pointer;
  border-radius: var(--r-xs, 6px);
}
.mini:hover {
  background: var(--ghost);
  color: var(--text);
}
textarea,
input,
select {
  font: inherit;
  font-size: var(--fs-sm);
  color: var(--text);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-xs, 6px);
  padding: var(--sp-1) var(--sp-2);
  min-width: 0;
}
textarea {
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
</style>
