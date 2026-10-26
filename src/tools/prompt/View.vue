<script setup>
// 提示词工具（tool-prompt 窗口）：左栏提示词库（生图/生视频），右栏 生成 / 历史 / 设置。
//
// 数据落点：
// - 提示词库 → repository kind "prompts"（sync:true，与速记同待遇：墓碑 + 云同步）。
// - 生成配置 → secureToolbox "prompt-config"（apiKey 加密落盘；外层 watch 防抖保存）。
// - 生成历史 → toolboxStore "prompt-history"；自定义工作流 → "prompt-workflows"。
// - 生成媒体在 <app_data>/media/（Rust prompt_media.rs），**不进数据备份**，设置页如实说明。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../../platform/invoke.js";
import { isDesktop } from "../../platform/env.js";
import { save as saveDialog } from "../../platform/dialog.js";
import { openPath } from "../../platform/shell.js";
import { askConfirm } from "../../ui/confirm.js";
import { loadToolbox, saveToolbox } from "../../toolboxStore.js";
import { flushSecureToolbox, loadSecureToolbox, saveSecureToolbox } from "../../secureToolbox.js";
import { decryptValue, encryptValue } from "../../secure.js";
import { loadAIConfig } from "../../ai.js";
import {
  create,
  load as loadKind,
  onDataChanged,
  remove as removeRecord,
  restore as restoreRecord,
  update as updateRecord,
} from "../../data/repository.js";
import {
  categoriesOf,
  exportPromptsJson,
  extractVariables,
  filterPrompts,
  hasSample,
  HISTORY_CAP,
  normalizePromptDraft,
  normalizeTags,
  parsePromptsJson,
  samplePrompts,
  sortPrompts,
  splitImports,
  tagsOf,
  trimHistory,
  WORKFLOW_CAP,
  WORKFLOW_MAX_BYTES,
} from "./promptLib.js";
import { normalizeGenConfig, SIZE_OPTIONS } from "./promptGen.js";
import Icon from "../../ui/Icon.vue";
import PromptGenPanel from "./PromptGenPanel.vue";
import PromptHistoryPanel from "./PromptHistoryPanel.vue";
import PromptWorkflowDialog from "./PromptWorkflowDialog.vue";
import { vDialog } from '../../ui/dialog.js'; // 模板里的 v-dialog 由 <script setup> 就地解析（SSR 渲染测试也能用）

const props = defineProps({ showToast: { type: Function, default: () => {} } });
const { t } = useI18n();
const toast = (message, options) => props.showToast(message, options);

const tab = ref("gen");
// 配置读完才挂载生成面板：否则「探活 → 写入默认 checkpoint」会先落在初始 config 上，
// 随后 loadConfig 用磁盘快照整体替换 config.value，把刚选好的 checkpoint 又抹掉（真实竞态，e2e 抓到）。
const bootstrapped = ref(false);

// ------- 提示词库 -------
const library = ref([]);
const keyword = ref("");
const catFilter = ref("");
const tagFilter = ref("");
const selected = ref(null);
const fillSeq = ref(0);

const filtered = computed(() => sortPrompts(filterPrompts(library.value, { keyword: keyword.value, category: catFilter.value, tag: tagFilter.value })));
const categories = computed(() => categoriesOf(library.value));
const tags = computed(() => tagsOf(library.value));
const samples = computed(() => samplePrompts(t));
const isSampleAdded = (sample) => hasSample(library.value, sample);

async function loadLibrary() {
  try {
    library.value = await loadKind("prompts");
  } catch (e) {
    toast(String(e?.message ?? e));
  }
  if (selected.value) {
    selected.value = library.value.find((record) => record.id === selected.value.id) ?? null;
  }
}

let offDataChanged = null;

// ------- 编辑对话框 -------
const editorOpen = ref(false);
const form = ref({ id: "", title: "", positive: "", negative: "", target: "image", category: "", tags: "", note: "", pinned: false });

function openNew() {
  form.value = { id: "", title: "", positive: "", negative: "", target: "image", category: catFilter.value || "", tags: "", note: "", pinned: false };
  editorOpen.value = true;
}

function openEdit(record) {
  form.value = {
    id: record.id,
    title: record.title ?? "",
    positive: record.positive ?? "",
    negative: record.negative ?? "",
    target: record.target === "video" ? "video" : "image",
    category: record.category ?? "",
    tags: normalizeTags(record.tags).join(" "),
    note: record.note ?? "",
    pinned: Boolean(record.pinned),
  };
  editorOpen.value = true;
}

async function saveEditor() {
  const draft = normalizePromptDraft({ ...form.value, tags: form.value.tags });
  if (!draft) {
    toast(t("toolbox.prompt.editorRequired"));
    return;
  }
  try {
    if (form.value.id) {
      const saved = await updateRecord("prompts", form.value.id, draft, { source: "view" });
      const index = library.value.findIndex((record) => record.id === form.value.id);
      if (index >= 0) library.value[index] = saved;
      if (selected.value?.id === saved.id) {
        selected.value = saved;
        fillSeq.value += 1;
      }
    } else {
      const saved = await create("prompts", draft, { source: "view" });
      library.value.unshift(saved);
    }
    editorOpen.value = false;
    toast(t("toolbox.prompt.editorSaved"));
  } catch (e) {
    toast(String(e?.message ?? e));
  }
}

async function togglePin(record) {
  const next = !record.pinned;
  record.pinned = next;
  try {
    await updateRecord("prompts", record.id, { pinned: next }, { source: "view" });
  } catch (e) {
    record.pinned = !next;
    toast(String(e?.message ?? e));
  }
}

async function removePrompt(record) {
  const ok = await askConfirm({
    title: t("toolbox.prompt.deleteConfirmTitle"),
    message: t("toolbox.prompt.deleteConfirmMsg", { title: record.title || t("toolbox.prompt.libEmpty") }),
    okText: t("toolbox.prompt.delete"),
  });
  if (!ok) return;
  const index = library.value.findIndex((item) => item.id === record.id);
  try {
    await removeRecord("prompts", record.id, { source: "view" });
  } catch (e) {
    toast(String(e?.message ?? e));
    return;
  }
  library.value = library.value.filter((item) => item.id !== record.id);
  if (selected.value?.id === record.id) selected.value = null;
  toast(t("toolbox.prompt.deleted"), {
    actionLabel: t("toolbox.prompt.undo"),
    onAction: async () => {
      try {
        const restored = await restoreRecord("prompts", record, { source: "view" });
        library.value.splice(Math.min(Math.max(index, 0), library.value.length), 0, restored);
      } catch (e) {
        toast(String(e?.message ?? e));
      }
    },
  });
}

function selectRow(record) {
  selected.value = record;
  fillSeq.value += 1;
}

// ------- 示例 -------
async function addSample(sample) {
  if (isSampleAdded(sample)) return;
  try {
    const saved = await create("prompts", { ...sample, tags: [] }, { source: "view" });
    library.value.unshift(saved);
    toast(t("toolbox.prompt.editorSaved"));
  } catch (e) {
    toast(String(e?.message ?? e));
  }
}

async function addAllSamples() {
  const fresh = samples.value.filter((sample) => !isSampleAdded(sample));
  // create 是 unshift：倒序落盘，界面顺序才与示例区一致
  for (const sample of [...fresh].reverse()) {
    try {
      const saved = await create("prompts", { ...sample, tags: [] }, { source: "view" });
      library.value.unshift(saved);
    } catch (e) {
      toast(String(e?.message ?? e));
      return;
    }
  }
  if (fresh.length) toast(t("toolbox.prompt.editorSaved"));
}

// ------- 导入 / 导出 -------
const importOpen = ref(false);
const importText = ref("");
const importError = ref("");
const importDetail = ref("");

const IMPORT_ERR = {
  empty: "toolbox.prompt.impErrEmpty",
  badJson: "toolbox.prompt.impErrBadJson",
  badFormat: "toolbox.prompt.impErrBadFormat",
  badShape: "toolbox.prompt.impErrBadShape",
  noPrompts: "toolbox.prompt.impErrNoPrompts",
};

function openImport() {
  importOpen.value = true;
  importText.value = "";
  importError.value = "";
  importDetail.value = "";
}

function onImportFile(event) {
  const file = event.target?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importText.value = String(reader.result ?? "");
  };
  reader.readAsText(file);
  event.target.value = "";
}

async function applyImport() {
  const parsed = parsePromptsJson(importText.value);
  if (!parsed.ok) {
    importError.value = t(IMPORT_ERR[parsed.error] ?? "toolbox.prompt.impErrBadShape", { detail: "" });
    importDetail.value = parsed.error === "badJson" ? String(parsed.stats?.detail ?? "") : "";
    return;
  }
  const { fresh, duplicates } = splitImports(parsed.prompts, library.value);
  const skipped = duplicates + (parsed.stats?.invalid ?? 0);
  try {
    for (const draft of [...fresh].reverse()) {
      const saved = await create("prompts", draft, { source: "view" });
      library.value.unshift(saved);
    }
  } catch (e) {
    toast(String(e?.message ?? e));
    return;
  }
  importOpen.value = false;
  toast(t("toolbox.prompt.impDone", { n: fresh.length, skipped }));
}

async function exportLibrary() {
  const content = exportPromptsJson(library.value);
  const path = await saveDialog({ defaultPath: "toolcove-prompts.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return;
  try {
    await invoke("export_file", { path, content });
    toast(t("toolbox.prompt.expDone", { n: library.value.length }));
  } catch (e) {
    toast(String(e?.message ?? e));
  }
}

// ------- 生成配置（secureToolbox，apiKey 加密） -------
const config = ref(normalizeGenConfig(null));
let configSaveTimer = null;
let configLoaded = false;

async function loadConfig() {
  try {
    config.value = await loadSecureToolbox("prompt-config", null, async (raw) => {
      const normalized = normalizeGenConfig(raw);
      normalized.cloud.apiKey = await decryptValue(normalized.cloud.apiKey);
      return normalized;
    });
  } catch {
    config.value = normalizeGenConfig(null);
  }
  configLoaded = true;
}

watch(
  config,
  () => {
    if (!configLoaded) return;
    clearTimeout(configSaveTimer);
    configSaveTimer = setTimeout(() => {
      saveSecureToolbox(
        "prompt-config",
        config.value,
        async (value) => ({ ...value, cloud: { ...value.cloud, apiKey: await encryptValue(value.cloud.apiKey) } }),
        (e) => toast(String(e?.message ?? e))
      );
    }, 400);
  },
  { deep: true }
);

async function inheritAI() {
  try {
    const ai = await loadAIConfig();
    if (ai.baseUrl) config.value.cloud.baseUrl = ai.baseUrl;
    if (ai.apiKey) config.value.cloud.apiKey = ai.apiKey;
    if (ai.model) config.value.cloud.model = ai.model;
    toast(t("toolbox.prompt.setInherited"));
  } catch (e) {
    toast(String(e?.message ?? e));
  }
}

async function openMediaDir() {
  try {
    const path = await invoke("media_path", {});
    await openPath(path);
  } catch (e) {
    toast(String(e?.message ?? e));
  }
}

// ------- 自定义工作流 -------
const workflows = ref([]);
const wfDialogOpen = ref(false);
const wfDialogInitial = ref(null);

function openWfImport() {
  wfDialogInitial.value = null;
  wfDialogOpen.value = true;
}

function openWfEdit(record) {
  wfDialogInitial.value = record;
  wfDialogOpen.value = true;
}

function persistWorkflows() {
  saveToolbox("prompt-workflows", workflows.value);
}

function saveWorkflow({ id, name, workflow, mapping }) {
  if (JSON.stringify(workflow ?? {}).length > WORKFLOW_MAX_BYTES) {
    toast(t("toolbox.prompt.wfTooLarge"));
    return;
  }
  if (id) {
    const record = workflows.value.find((item) => item.id === id);
    if (record) {
      record.name = name;
      record.workflow = workflow;
      record.mapping = mapping;
      record.updatedAt = Date.now();
    }
  } else {
    if (workflows.value.length >= WORKFLOW_CAP) {
      toast(t("toolbox.prompt.wfCap", { n: WORKFLOW_CAP }));
      return;
    }
    workflows.value.unshift({ id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, workflow, mapping, createdAt: Date.now(), updatedAt: Date.now() });
  }
  persistWorkflows();
  wfDialogOpen.value = false;
  toast(t("toolbox.prompt.wfSaved"));
}

async function removeWorkflow(record) {
  const ok = await askConfirm({
    title: t("toolbox.prompt.wfDeleteConfirmTitle"),
    message: t("toolbox.prompt.wfDeleteConfirmMsg", { name: record.name }),
    okText: t("toolbox.prompt.delete"),
  });
  if (!ok) return;
  workflows.value = workflows.value.filter((item) => item.id !== record.id);
  if (config.value.comfy.workflowId === record.id) config.value.comfy.workflowId = "";
  persistWorkflows();
}

// ------- 生成历史 -------
const history = ref([]);
let runSeq = 0;
const runRequest = ref(null);

function persistHistory() {
  saveToolbox("prompt-history", history.value);
}

function addHistory(record) {
  history.value.unshift(record);
  const { kept, evicted } = trimHistory(history.value, HISTORY_CAP);
  history.value = kept;
  for (const old of evicted) {
    for (const file of [...(old.files || []), ...(old.failed || [])]) {
      if (file?.name) invoke("media_delete", { name: file.name }).catch(() => {});
    }
  }
  persistHistory();
}

function updateHistory({ id, patch }) {
  const record = history.value.find((item) => item.id === id);
  if (!record) return;
  Object.assign(record, patch);
  persistHistory();
}

function deleteHistory(id) {
  history.value = history.value.filter((item) => item.id !== id);
  persistHistory();
}

function rerun(record) {
  if (!String(record?.positive ?? "").trim()) {
    toast(t("toolbox.prompt.histRerunNoSource"));
    return;
  }
  if (record.backend === "comfy" && record.mode === "workflow") {
    const wf = workflows.value.find((item) => item.id === record.params?.workflowId);
    if (!wf) {
      toast(t("toolbox.prompt.histRerunNoWorkflow"));
      return;
    }
  }
  const backend = record.backend === "cloud" ? "cloud" : record.mode === "txt2img" ? "builtin" : "workflow";
  runSeq += 1;
  tab.value = "gen";
  runRequest.value = { seq: runSeq, spec: { backend, positive: record.positive, negative: record.negative, params: record.params || {} } };
}

function saveResultToLib({ positive, negative }) {
  const draft = normalizePromptDraft({ positive, negative });
  if (!draft) return;
  create("prompts", draft, { source: "view" })
    .then((saved) => {
      library.value.unshift(saved);
      toast(t("toolbox.prompt.saveToLibDone"));
    })
    .catch((e) => toast(String(e?.message ?? e)));
}

// ------- 生命周期 -------
onMounted(async () => {
  await Promise.all([loadLibrary(), loadConfig()]);
  bootstrapped.value = true;
  try {
    history.value = (await loadToolbox("prompt-history", [])) || [];
  } catch {
    history.value = [];
  }
  try {
    workflows.value = (await loadToolbox("prompt-workflows", [])) || [];
  } catch {
    workflows.value = [];
  }
  offDataChanged = onDataChanged(async ({ kind, source }) => {
    if (kind !== "prompts" || source === "view") return;
    await loadLibrary();
    if (editorOpen.value) toast(t("toolbox.prompt.updatedExternally"));
  });
});

onBeforeUnmount(() => {
  offDataChanged?.();
  clearTimeout(configSaveTimer);
  flushSecureToolbox("prompt-config");
  persistHistory();
  persistWorkflows();
});
</script>

<template>
  <div class="tool-prompt">
    <div v-if="!isDesktop" class="empty desktop-error" data-role="desktop-error">
      <Icon name="wand" :size="28" />
      <p>{{ t("toolbox.prompt.desktopOnly") }}</p>
    </div>

    <template v-else>
      <aside class="lib">
        <div class="lib-head">
          <h3>{{ t("toolbox.prompt.libTitle") }}</h3>
          <div class="lib-actions">
            <button type="button" class="ghost" data-role="lib-new" @click="openNew"><Icon name="plus" :size="13" />{{ t("toolbox.prompt.libNew") }}</button>
            <button type="button" class="ghost" data-role="lib-import" @click="openImport"><Icon name="upload" :size="13" />{{ t("toolbox.prompt.libImport") }}</button>
            <button type="button" class="ghost" data-role="lib-export" @click="exportLibrary"><Icon name="download" :size="13" />{{ t("toolbox.prompt.libExport") }}</button>
          </div>
          <input v-model="keyword" type="search" :placeholder="t('toolbox.prompt.libSearchPh')" data-role="lib-search" />
          <div class="filters">
            <select v-model="catFilter" data-role="lib-cat">
              <option value="">{{ t("toolbox.prompt.libCatAll") }}</option>
              <option v-for="name in categories" :key="name" :value="name">{{ name }}</option>
            </select>
            <select v-model="tagFilter" data-role="lib-tag">
              <option value="">{{ t("toolbox.prompt.libTagAll") }}</option>
              <option v-for="name in tags" :key="name" :value="name">{{ name }}</option>
            </select>
          </div>
        </div>

        <div class="lib-rows" data-role="lib-rows">
          <div
            v-for="record in filtered"
            :key="record.id"
            class="lib-row"
            :class="{ on: selected?.id === record.id }"
            :data-id="record.id"
            data-role="lib-row"
            @click="selectRow(record)"
          >
            <button
              type="button"
              class="icon-btn"
              :class="{ starred: record.pinned }"
              :title="record.pinned ? t('toolbox.prompt.pinOff') : t('toolbox.prompt.pinOn')"
              data-role="lib-pin"
              @click.stop="togglePin(record)"
            >
              <Icon name="star" :size="13" />
            </button>
            <div class="lib-info">
              <span class="lib-title" :title="record.title">{{ record.title }}</span>
              <span class="lib-meta">
                <span class="badge" data-role="lib-badge-target">{{ record.target === "video" ? t("toolbox.prompt.targetVideo") : t("toolbox.prompt.targetImage") }}</span>
                <span v-if="extractVariables(record.positive, record.negative).length" class="badge vars" data-role="lib-badge-vars">
                  {{ t("toolbox.prompt.badgeVars", { n: extractVariables(record.positive, record.negative).length }) }}
                </span>
                <span v-if="record.category" class="badge plain">{{ record.category }}</span>
              </span>
            </div>
            <div class="lib-row-actions">
              <button type="button" class="icon-btn" :title="t('toolbox.prompt.editorEdit')" data-role="lib-edit" @click.stop="openEdit(record)">
                <Icon name="edit" :size="13" />
              </button>
              <button type="button" class="icon-btn danger" :title="t('toolbox.prompt.delete')" data-role="lib-del" @click.stop="removePrompt(record)">
                <Icon name="trash" :size="13" />
              </button>
            </div>
          </div>

          <div v-if="!library.length" class="lib-empty" data-role="lib-empty">
            <p class="empty-title">{{ t("toolbox.prompt.libEmpty") }}</p>
            <p class="hint">{{ t("toolbox.prompt.libEmptyHint") }}</p>
            <div class="samples" data-role="lib-samples">
              <div class="samples-head">
                <span>{{ t("toolbox.prompt.libSamplesTitle") }}</span>
                <button type="button" class="link" data-role="lib-sample-add-all" @click="addAllSamples">{{ t("toolbox.prompt.libSampleAddAll") }}</button>
              </div>
              <div v-for="sample in samples" :key="sample.key" class="sample-row">
                <div class="sample-info">
                  <span class="sample-title">{{ sample.title }}</span>
                  <span class="badge plain">{{ sample.target === "video" ? t("toolbox.prompt.targetVideo") : t("toolbox.prompt.targetImage") }}</span>
                </div>
                <button
                  type="button"
                  class="ghost"
                  :disabled="isSampleAdded(sample)"
                  data-role="lib-sample-add"
                  :data-sample="sample.key"
                  @click="addSample(sample)"
                >
                  {{ isSampleAdded(sample) ? t("toolbox.prompt.libSampleAdded") : t("toolbox.prompt.libSampleAdd") }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <main class="stage">
        <div class="tabs">
          <button type="button" :class="{ on: tab === 'gen' }" data-role="tab-gen" @click="tab = 'gen'">{{ t("toolbox.prompt.genTab") }}</button>
          <button type="button" :class="{ on: tab === 'history' }" data-role="tab-history" @click="tab = 'history'">{{ t("toolbox.prompt.histTab") }}</button>
          <button type="button" :class="{ on: tab === 'settings' }" data-role="tab-settings" @click="tab = 'settings'">{{ t("toolbox.prompt.setTab") }}</button>
        </div>

        <div class="stage-body">
          <div v-show="tab === 'gen'" class="pane">
            <PromptGenPanel
              v-if="bootstrapped"
              :prompt="selected"
              :fill-seq="fillSeq"
              :run-request="runRequest"
              :config="config"
              :workflows="workflows"
              :show-toast="showToast"
              @save-to-lib="saveResultToLib"
              @goto-settings="tab = 'settings'"
              @history-add="addHistory"
              @history-update="updateHistory"
            />
          </div>

          <div v-show="tab === 'history'" class="pane">
            <PromptHistoryPanel
              :history="history"
              :config="config"
              :show-toast="showToast"
              @rerun="rerun"
              @delete="deleteHistory"
              @update="updateHistory"
            />
          </div>

          <div v-show="tab === 'settings'" class="pane">
            <section class="set-block">
              <h4>{{ t("toolbox.prompt.setCloud") }}</h4>
              <div class="set-grid">
                <label class="field">
                  <span>{{ t("toolbox.prompt.setBaseUrl") }}</span>
                  <input v-model="config.cloud.baseUrl" type="text" :placeholder="t('toolbox.prompt.setBaseUrlPh')" data-role="set-base-url" />
                </label>
                <label class="field">
                  <span>{{ t("toolbox.prompt.setApiKey") }}</span>
                  <input v-model="config.cloud.apiKey" type="password" data-role="set-api-key" />
                </label>
                <label class="field">
                  <span>{{ t("toolbox.prompt.setModel") }}</span>
                  <input v-model="config.cloud.model" type="text" :placeholder="t('toolbox.prompt.setModelPh')" data-role="set-model" />
                </label>
                <label class="field">
                  <span>{{ t("toolbox.prompt.setSize") }}</span>
                  <select v-model="config.cloud.size" data-role="set-size">
                    <option v-for="size in SIZE_OPTIONS" :key="size" :value="size">{{ size }}</option>
                  </select>
                </label>
                <label class="field">
                  <span>{{ t("toolbox.prompt.setCount") }}</span>
                  <input v-model.number="config.cloud.n" type="number" min="1" max="4" data-role="set-count" />
                </label>
              </div>
              <label class="check">
                <input v-model="config.cloud.sendNegative" type="checkbox" data-role="set-send-negative" />
                <span>{{ t("toolbox.prompt.setSendNegative") }}</span>
              </label>
              <p class="hint">{{ t("toolbox.prompt.setSendNegativeTip") }}</p>
              <button type="button" class="ghost" data-role="set-inherit" @click="inheritAI">{{ t("toolbox.prompt.setInherit") }}</button>
            </section>

            <section class="set-block">
              <h4>{{ t("toolbox.prompt.setComfy") }}</h4>
              <label class="field">
                <span>{{ t("toolbox.prompt.setComfyUrl") }}</span>
                <input v-model="config.comfy.baseUrl" type="text" :placeholder="t('toolbox.prompt.setComfyUrlPh')" data-role="set-comfy-url" />
              </label>
            </section>

            <section class="set-block">
              <h4>{{ t("toolbox.prompt.setWorkflows") }}</h4>
              <p v-if="!workflows.length" class="hint">{{ t("toolbox.prompt.wfEmpty") }}</p>
              <div v-else class="wf-list" data-role="wf-list">
                <div v-for="wf in workflows" :key="wf.id" class="wf-row" :data-id="wf.id" data-role="wf-row">
                  <span class="wf-name">{{ wf.name }}</span>
                  <div class="wf-actions">
                    <button type="button" class="ghost" data-role="wf-edit" @click="openWfEdit(wf)">{{ t("toolbox.prompt.wfEditMapping") }}</button>
                    <button type="button" class="ghost danger" data-role="wf-del" @click="removeWorkflow(wf)"><Icon name="trash" :size="13" /></button>
                  </div>
                </div>
              </div>
              <button type="button" class="ghost" data-role="wf-import" @click="openWfImport"><Icon name="upload" :size="13" />{{ t("toolbox.prompt.wfImport") }}</button>
            </section>

            <section class="set-block">
              <h4>{{ t("toolbox.prompt.setOpenMediaDir") }}</h4>
              <p class="hint" data-role="set-backup-note">{{ t("toolbox.prompt.setBackupNote") }}</p>
              <button type="button" class="ghost" data-role="set-open-media-dir" @click="openMediaDir"><Icon name="folder" :size="13" />{{ t("toolbox.prompt.setOpenMediaDir") }}</button>
            </section>
          </div>
        </div>
      </main>

      <div v-if="editorOpen" class="modal-mask mask" data-role="lib-editor">
        <div class="box" v-dialog>
          <h3>{{ form.id ? t("toolbox.prompt.editorEdit") : t("toolbox.prompt.editorNew") }}</h3>
          <label class="field">
            <span>{{ t("toolbox.prompt.editorTitle") }}</span>
            <input v-model="form.title" type="text" :placeholder="t('toolbox.prompt.editorTitlePh')" data-role="lib-title" />
          </label>
          <label class="field">
            <span>{{ t("toolbox.prompt.editorPositive") }}</span>
            <textarea v-model="form.positive" rows="4" :placeholder="t('toolbox.prompt.editorPositivePh')" data-role="lib-positive"></textarea>
          </label>
          <label class="field">
            <span>{{ t("toolbox.prompt.editorNegative") }}</span>
            <textarea v-model="form.negative" rows="2" :placeholder="t('toolbox.prompt.editorNegativePh')" data-role="lib-negative"></textarea>
          </label>
          <div class="seg small">
            <button type="button" :class="{ on: form.target === 'image' }" data-role="lib-target-image" @click="form.target = 'image'">{{ t("toolbox.prompt.targetImage") }}</button>
            <button type="button" :class="{ on: form.target === 'video' }" data-role="lib-target-video" @click="form.target = 'video'">{{ t("toolbox.prompt.targetVideo") }}</button>
          </div>
          <div class="two-col">
            <label class="field">
              <span>{{ t("toolbox.prompt.editorCategory") }}</span>
              <input v-model="form.category" type="text" list="prompt-cats" :placeholder="t('toolbox.prompt.editorCategoryPh')" data-role="lib-cat-input" />
              <datalist id="prompt-cats">
                <option v-for="name in categories" :key="name" :value="name"></option>
              </datalist>
            </label>
            <label class="field">
              <span>{{ t("toolbox.prompt.editorTags") }}</span>
              <input v-model="form.tags" type="text" :placeholder="t('toolbox.prompt.editorTagsPh')" data-role="lib-tags-input" />
            </label>
          </div>
          <label class="field">
            <span>{{ t("toolbox.prompt.editorNote") }}</span>
            <input v-model="form.note" type="text" :placeholder="t('toolbox.prompt.editorNotePh')" data-role="lib-note" />
          </label>
          <div class="actions">
            <button type="button" class="ghost" data-role="lib-cancel" @click="editorOpen = false">{{ t("toolbox.prompt.editorCancel") }}</button>
            <button type="button" class="primary" data-role="lib-save" @click="saveEditor">{{ t("toolbox.prompt.editorSave") }}</button>
          </div>
        </div>
      </div>

      <div v-if="importOpen" class="modal-mask mask" data-role="imp-panel">
        <div class="box" v-dialog>
          <h3>{{ t("toolbox.prompt.impTitle") }}</h3>
          <textarea v-model="importText" rows="8" :placeholder="t('toolbox.prompt.impPh')" data-role="imp-text"></textarea>
          <div class="row">
            <input id="imp-file" class="file" type="file" accept=".json,application/json" data-role="imp-file" @change="onImportFile" />
            <label for="imp-file" class="ghost">{{ t("toolbox.prompt.impChooseFile") }}</label>
          </div>
          <p v-if="importError" class="err" data-role="imp-error">{{ importError }}<span v-if="importDetail">（{{ importDetail }}）</span></p>
          <div class="actions">
            <button type="button" class="ghost" data-role="imp-cancel" @click="importOpen = false">{{ t("toolbox.prompt.editorCancel") }}</button>
            <button type="button" class="primary" data-role="imp-apply" @click="applyImport">{{ t("toolbox.prompt.impApply") }}</button>
          </div>
        </div>
      </div>

      <PromptWorkflowDialog
        :open="wfDialogOpen"
        :initial="wfDialogInitial"
        :base-url="config.comfy.baseUrl"
        @close="wfDialogOpen = false"
        @save="saveWorkflow"
      />
    </template>
  </div>
</template>

<style scoped>
.tool-prompt {
  display: flex;
  height: 100%;
  min-height: 0;
  color: var(--text);
}
.desktop-error {
  flex: 1;
  gap: var(--sp-4);
  color: var(--text-weak);
  padding: 40px;
}
.lib {
  width: 320px;
  flex-shrink: 0;
  border-right: 1px solid var(--card-border);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.lib-head {
  padding: var(--sp-3) var(--sp-4) var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--card-border);
}
.lib-head h3 {
  margin: 0;
  font-size: var(--fs-base);
}
.lib-actions {
  display: flex;
  gap: var(--sp-1);
}
.filters {
  display: flex;
  gap: var(--sp-1);
}
.filters select {
  flex: 1;
}
.lib-rows {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.lib-row {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  cursor: pointer;
  border-bottom: 1px solid var(--card-border);
}
.lib-row:hover {
  background: var(--ghost);
}
.lib-row.on {
  background: var(--primary-soft);
}
.lib-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.lib-title {
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lib-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-05);
}
.badge {
  font-size: var(--fs-xs);
  padding: 1px var(--sp-1);
  border-radius: var(--r-pill, 999px);
  background: var(--well);
  color: var(--text-weak);
}
.badge.vars {
  background: var(--primary-soft);
  color: var(--primary);
}
.badge.plain {
  background: transparent;
  border: 1px solid var(--border);
}
.lib-row-actions {
  display: flex;
  gap: var(--sp-0);
  opacity: 0;
}
.lib-row:hover .lib-row-actions,
.lib-row.on .lib-row-actions {
  opacity: 1;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--text-weak);
  cursor: pointer;
  border-radius: var(--r-xs, 6px);
}
.icon-btn:hover {
  background: var(--ghost);
  color: var(--text);
}
.icon-btn.starred {
  color: var(--warn);
}
.icon-btn.danger:hover {
  color: var(--danger);
}
.lib-empty {
  padding: var(--sp-6) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.empty-title {
  margin: 0;
  font-size: var(--fs-base);
}
.hint {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-weak);
}
.samples {
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm, 8px);
  padding: var(--sp-2) var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.samples-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-sm);
  font-weight: 600;
}
.sample-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.sample-info {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
}
.sample-title {
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tabs {
  display: flex;
  gap: var(--sp-05);
  padding: var(--sp-2) var(--sp-4) 0;
  border-bottom: 1px solid var(--card-border);
}
.tabs button {
  border: none;
  background: transparent;
  color: var(--text-weak);
  font-size: var(--fs-sm);
  padding: var(--sp-1) var(--sp-4);
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.tabs button.on {
  color: var(--text);
  border-bottom-color: var(--primary);
}
.stage-body {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.pane {
  padding: var(--sp-4);
}
.set-block {
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm, 8px);
  padding: var(--sp-3) var(--sp-4);
  margin-bottom: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.set-block h4 {
  margin: 0;
  font-size: var(--fs-sm);
}
.set-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-05);
  font-size: var(--fs-sm);
  color: var(--text-weak);
  min-width: 0;
}
.check {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-sm);
  color: var(--text-weak);
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
}
.wf-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.wf-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.wf-name {
  font-size: var(--fs-sm);
}
.wf-actions {
  display: flex;
  gap: var(--sp-1);
}
.seg {
  display: flex;
  gap: var(--sp-05);
  background: var(--well);
  border-radius: var(--r-sm, 8px);
  padding: 3px;
  align-self: flex-start;
}
.seg.small button {
  padding: 5px var(--sp-4);
}
.seg button {
  border: none;
  background: transparent;
  color: var(--text-weak);
  font-size: var(--fs-sm);
  border-radius: var(--r-xs, 6px);
  cursor: pointer;
}
.seg button.on {
  background: var(--card);
  color: var(--text);
}
.box {
  width: min(640px, calc(100vw - 48px));
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
.box h3 {
  margin: 0;
  font-size: var(--fs-lg);
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
.primary:hover {
  background: var(--primary-hover);
}
.ghost {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 8px);
  background: transparent;
  color: var(--text);
  padding: 5px var(--sp-3);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.ghost:hover {
  background: var(--ghost);
}
.ghost:disabled {
  opacity: 0.55;
  cursor: default;
}
.ghost.danger {
  color: var(--danger);
}
.link {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: var(--fs-sm);
  cursor: pointer;
  padding: 0;
}
.link:hover {
  text-decoration: underline;
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
}
</style>
