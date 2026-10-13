<script setup>
// 照片存档（桌面端）：列出云端照片 → 勾选（默认全选新照片）→ 批量下载归档。
//
// 桌面用 Rust 干重活（photo_list / photo_download）：流式落盘、进度事件、不受 CORS 约束，
// 与下载器同一套理由。浏览器形态没有原生能力，退化为"上传视图"（与手机端同一份队列逻辑）。
//
// 「已存档」的口径是归档目录里的 archive-manifest.json（Rust 侧维护，条目带 sha256）——
// 不是靠文件名猜。换一个目录就是换一本账，界面会重新标一遍。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../ui/Icon.vue";
import PhotoThumb from "./PhotoThumb.vue";
import { invoke } from "../platform/invoke.js";
import { listen } from "../platform/events.js";
import { open as openDialog } from "../platform/dialog.js";
import { revealPath } from "../platform/shell.js";
import { isDesktop } from "../platform/env.js";
import { formatBytes } from "../downloader.js";
import { loadToolbox, saveToolbox } from "../toolboxStore.js";
import { PHOTO_PROVIDERS, defaultPhotoConfig, exportPhotoConfig, normalizePhotoConfig, parsePhotoConfigExport, validatePhotoConfig } from "../photo/config.js";
import { fieldsOf } from "../photo/fields.js";
import { generateDeviceId, parseObjectKey } from "../photo/keys.js";
import { QUEUE_STATE } from "../photo/queue.js";
import { createUploadQueue, filesFromInput, loadPhotoConfig, savePhotoConfig } from "../photo/session.js";
import { testPhotoConnection } from "../photo/upload.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const ERROR_KEYS = {
  endpointEmpty: "toolbox.photo.errEndpointEmpty",
  endpointBad: "toolbox.photo.errEndpointBad",
  regionEmpty: "toolbox.photo.errRegionEmpty",
  bucketEmpty: "toolbox.photo.errBucketEmpty",
  bucketBad: "toolbox.photo.errBucketBad",
  keyEmpty: "toolbox.photo.errKeyEmpty",
  secretEmpty: "toolbox.photo.errSecretEmpty",
  prefixBad: "toolbox.photo.errPrefixBad",
  domainEmpty: "toolbox.photo.errDomainEmpty",
  domainBad: "toolbox.photo.errDomainBad",
  uploadHostEmpty: "toolbox.photo.errUploadHostBad",
  uploadHostBad: "toolbox.photo.errUploadHostBad",
  userEmpty: "toolbox.photo.errUserEmpty",
  passEmpty: "toolbox.photo.errPassEmpty",
};

const desktopMode = isDesktop;

// ---- 配置 ----
const config = ref(defaultPhotoConfig());
const draft = ref(null);
const configErrors = ref({});
const editing = ref(false);
const testing = ref(false);
const testResult = ref("");
const testError = ref("");

const thumbConfig = computed(() => normalizePhotoConfig(config.value));
const configured = computed(() => validatePhotoConfig(config.value).ok);
const providers = computed(() => PHOTO_PROVIDERS.map((p) => ({ ...p, label: t(p.labelKey) })));
const currentProvider = computed(() => providers.value.find((p) => p.key === config.value.provider) || providers.value[0]);
const draftProvider = computed(() => providers.value.find((p) => p.key === draft.value?.provider) || currentProvider.value);
const draftFields = computed(() => fieldsOf(draft.value?.provider));
// 桌面端三种后端都能探活（走 Rust）；浏览器形态只有 S3 系能直连（另两家的列举接口不放行跨域）
const canTest = computed(() => desktopMode || config.value.provider === "s3");
const configSummary = computed(() => `${config.value.bucket || config.value.domain || config.value.endpoint} · ${config.value.prefix}/`);

function fieldError(name) {
  const code = configErrors.value[name];
  return code ? t(ERROR_KEYS[code] || code) : "";
}

function startEdit() {
  draft.value = { ...config.value };
  configErrors.value = {};
  testResult.value = "";
  testError.value = "";
  editing.value = true;
}

function cancelEdit() {
  draft.value = null;
  editing.value = false;
  configErrors.value = {};
}

async function saveConfig() {
  const check = validatePhotoConfig(draft.value);
  configErrors.value = check.errors;
  if (!check.ok) return;
  config.value = await savePhotoConfig(check.config);
  draft.value = null;
  editing.value = false;
  testResult.value = "";
  testError.value = "";
  if (desktopMode) await refreshList();
  else await uploadQueue?.pump();
}

async function runTest() {
  if (!canTest.value) return;
  testing.value = true;
  testResult.value = "";
  testError.value = "";
  try {
    if (desktopMode) {
      const result = await invoke("photo_test", { config: normalizePhotoConfig(config.value) });
      testResult.value = t("toolbox.photo.configOk", { n: result?.sampleCount ?? 0 });
    } else {
      const result = await testPhotoConnection({ config: config.value });
      testResult.value = t("toolbox.photo.configOk", { n: result.sampleCount });
    }
  } catch (e) {
    testError.value = String(e?.message || e);
  } finally {
    testing.value = false;
  }
}

// ---- 配置的导出 / 导入（多设备快速配置；与手机端同一套编解码） ----
const transferMode = ref(""); // "" | "export" | "import"
const transferText = ref("");
const transferError = ref("");
const transferOk = ref("");
const copyState = ref(""); // "" | "ok" | "fail"

const IMPORT_ERROR_KEYS = {
  badJson: "toolbox.photo.importBadJson",
  badKind: "toolbox.photo.importBadKind",
  badVersion: "toolbox.photo.importBadVersion",
  badProvider: "toolbox.photo.importBadProvider",
};

function openExport() {
  transferMode.value = "export";
  transferText.value = exportPhotoConfig(config.value);
  transferError.value = "";
  transferOk.value = "";
  copyState.value = "";
}

function openImport() {
  transferMode.value = "import";
  transferText.value = "";
  transferError.value = "";
  transferOk.value = "";
  copyState.value = "";
}

function closeTransfer() {
  transferMode.value = "";
  transferText.value = "";
  transferError.value = "";
  transferOk.value = "";
  copyState.value = "";
}

function importErrorText(result) {
  if (result.error === "invalid" && result.errors) {
    const first = Object.values(result.errors)[0];
    return t(ERROR_KEYS[first] || first);
  }
  return t(IMPORT_ERROR_KEYS[result.error] || IMPORT_ERROR_KEYS.badJson);
}

async function applyImported() {
  const result = parsePhotoConfigExport(transferText.value);
  if (!result.ok) {
    transferOk.value = "";
    transferError.value = importErrorText(result);
    return;
  }
  const cfg = normalizePhotoConfig({
    ...result.config,
    deviceId: /^[0-9a-f]{6}$/.test(config.value.deviceId) ? config.value.deviceId : generateDeviceId(),
  });
  config.value = await savePhotoConfig(cfg);
  transferText.value = "";
  transferError.value = "";
  transferOk.value = t("toolbox.photo.importOk");
  if (desktopMode) await refreshList();
  else await uploadQueue?.pump();
}

async function copyExport() {
  try {
    await navigator.clipboard.writeText(transferText.value);
    copyState.value = "ok";
  } catch {
    copyState.value = "fail";
  }
}

// ---- 桌面：云端列表与归档 ----
const objects = ref([]);
const manifestByKey = ref(new Map());
const loading = ref(false);
const listError = ref("");
const dir = ref("");
const selected = ref({});
const archiving = ref(false);
const progress = ref(null);
const resultNote = ref("");
const failedNotes = ref([]);
let archiveId = "";
let unlistenProgress = null;
let unlistenFinished = null;

const MAX_LIST = 20000;

const freshKeys = computed(() => objects.value.filter((row) => !manifestByKey.value.has(row.key)).map((row) => row.key));
const selectedKeys = computed(() => Object.keys(selected.value).filter((key) => selected.value[key]));
const groups = computed(() => {
  const byDate = new Map();
  for (const row of objects.value) {
    const parsed = parseObjectKey(row.key, config.value.prefix);
    const date = parsed?.date || (row.lastModified || "").slice(0, 10) || t("toolbox.photo.unknownDate");
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, rows]) => ({ date, rows: rows.sort((a, b) => (a.key < b.key ? 1 : -1)) }));
});

function baseName(key) {
  return String(key || "").split("/").pop();
}

/** 行副标题：本工具命名（时间戳_设备_随机）→「10-13 16:30 · 设备 ab12cd」；未识别 → 云端修改日期。 */
function rowMeta(row) {
  const parsed = parseObjectKey(row.key, config.value.prefix);
  if (parsed) {
    const stamp = parsed.stamp; // YYYYMMDDTHHMMSS
    return `${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(9, 11)}:${stamp.slice(11, 13)} · ${parsed.device}`;
  }
  return (row.lastModified || "").slice(0, 10);
}

/** 缩略图组件的 key：换后端/换桶（导入配置）后强制重挂，避免沿用旧桶的同名缓存图。 */
function thumbKey(row) {
  return `${config.value.provider}|${config.value.bucket || config.value.domain}|${row.key}`;
}

function toggle(key) {
  selected.value = { ...selected.value, [key]: !selected.value[key] };
}

function selectAllNew() {
  const next = {};
  for (const key of freshKeys.value) next[key] = true;
  selected.value = next;
}

function clearSelection() {
  selected.value = {};
}

async function chooseDir() {
  const picked = await openDialog({ directory: true, multiple: false, title: t("toolbox.photo.pickDir") });
  const value = Array.isArray(picked) ? picked[0] : picked;
  if (typeof value === "string" && value) {
    dir.value = value;
    saveToolbox("photo-archive", { dir: value });
    await loadManifest();
  }
}

/** 手动改目录文本（不弹选择器）时：持久化 + 重读账本。 */
function onDirChanged() {
  saveToolbox("photo-archive", { dir: dir.value });
  loadManifest();
}

async function loadManifest() {
  if (!dir.value) {
    manifestByKey.value = new Map();
    return;
  }
  try {
    const manifest = await invoke("photo_manifest", { destDir: dir.value });
    manifestByKey.value = new Map((manifest?.entries || []).map((entry) => [entry.key, entry]));
  } catch (e) {
    listError.value = String(e?.message || e);
  }
}

async function refreshList() {
  if (!configured.value) return;
  loading.value = true;
  listError.value = "";
  resultNote.value = "";
  failedNotes.value = [];
  try {
    const rows = [];
    let token = "";
    for (;;) {
      const page = await invoke("photo_list", {
        config: normalizePhotoConfig(config.value),
        continuationToken: token || undefined,
        maxKeys: 1000,
      });
      rows.push(...(page?.objects || []));
      token = page?.nextToken || "";
      if (!page?.truncated || !token || rows.length >= MAX_LIST) break;
    }
    objects.value = rows;
    await loadManifest();
  } catch (e) {
    listError.value = String(e?.message || e);
  } finally {
    loading.value = false;
  }
}

async function startArchive() {
  if (!dir.value) {
    props.showToast(t("toolbox.photo.needDir"));
    return;
  }
  const keys = selectedKeys.value;
  if (!keys.length) {
    props.showToast(t("toolbox.photo.needSelection"));
    return;
  }
  resultNote.value = "";
  failedNotes.value = [];
  const items = keys
    .map((key) => objects.value.find((row) => row.key === key))
    .filter(Boolean)
    .map((row) => ({ key: row.key, size: row.size, etag: row.etag, lastModified: row.lastModified }));
  archiveId = (crypto.randomUUID && crypto.randomUUID()) || `photo-${Date.now()}`;
  progress.value = { done: 0, total: items.length, skipped: 0, failed: 0, currentKey: "", fileDone: 0, fileTotal: 0 };
  archiving.value = true;
  try {
    await invoke("photo_download", { id: archiveId, config: normalizePhotoConfig(config.value), items, destDir: dir.value });
  } catch (e) {
    archiving.value = false;
    progress.value = null;
    props.showToast(String(e?.message || e));
  }
}

async function cancelArchive() {
  if (!archiveId) return;
  try {
    await invoke("photo_cancel", { id: archiveId });
  } catch {
    // 任务可能刚好结束，取消失败不改界面
  }
}

async function openDir() {
  if (dir.value) await revealPath(dir.value);
}

// ---- 浏览器：上传队列（与手机端同一份逻辑） ----
const queueItems = ref([]);
const uploadInput = ref(null);
let uploadQueue = null;

function refreshQueue() {
  queueItems.value = [...(uploadQueue?.items || [])];
}

const queueStats = computed(() => {
  const by = (state) => queueItems.value.filter((item) => item.status === state).length;
  return { pending: by(QUEUE_STATE.pending), uploading: by(QUEUE_STATE.uploading), done: by(QUEUE_STATE.done), error: by(QUEUE_STATE.error), total: queueItems.value.length };
});

function queueStateLabel(item) {
  if (item.status === QUEUE_STATE.pending) return t("toolbox.photo.statePending");
  if (item.status === QUEUE_STATE.uploading) return t("toolbox.photo.stateUploading");
  if (item.status === QUEUE_STATE.done) return t("toolbox.photo.stateDone");
  return t("toolbox.photo.stateError");
}

async function onUploadPicked(event) {
  const files = filesFromInput(event?.target?.files);
  if (event?.target) event.target.value = "";
  if (!files.length || !uploadQueue) return;
  await uploadQueue.addFiles(files, { config: config.value });
  refreshQueue();
  await uploadQueue.pump();
}

onMounted(async () => {
  config.value = await loadPhotoConfig();
  if (desktopMode) {
    const saved = await loadToolbox("photo-archive", {});
    if (typeof saved?.dir === "string") dir.value = saved.dir;
    unlistenProgress = await listen("photo:progress", (event) => {
      const payload = event?.payload;
      if (!payload || payload.id !== archiveId) return;
      progress.value = payload;
    });
    unlistenFinished = await listen("photo:finished", (event) => {
      const payload = event?.payload;
      if (!payload || payload.id !== archiveId) return;
      archiving.value = false;
      progress.value = null;
      archiveId = "";
      const downloaded = Math.max((payload.processed || 0) - (payload.skipped || 0), 0);
      if (payload.canceled) {
        resultNote.value = t("toolbox.photo.canceledNote");
      } else if (payload.ok) {
        resultNote.value = t("toolbox.photo.finishedOk", { downloaded, skipped: payload.skipped || 0 });
        selected.value = {};
      } else {
        resultNote.value = t("toolbox.photo.finishedFail", { failed: payload.failedCount || 0 });
      }
      failedNotes.value = (payload.failed || []).slice(0, 5).map((row) => `${baseName(row.key)} — ${row.error}`);
      loadManifest();
    });
    if (configured.value) await refreshList();
  } else {
    uploadQueue = await createUploadQueue({ onUpdate: () => refreshQueue() });
    uploadQueue.setConfig(config.value);
    refreshQueue();
    await uploadQueue.pump();
  }
});

onBeforeUnmount(() => {
  if (unlistenProgress) unlistenProgress();
  if (unlistenFinished) unlistenFinished();
});
</script>

<template>
  <div class="tool-photo">
    <!-- 存储配置（两端共用一份配置） -->
    <section class="panel config-panel">
      <header class="panel-head">
        <b>{{ t("toolbox.photo.configTitle") }}</b>
        <span class="panel-meta">{{ currentProvider?.label }}</span>
        <div class="head-actions">
          <button v-if="!editing" class="btn-outline" type="button" data-role="config-edit" @click="startEdit">
            {{ configured ? t("toolbox.photo.configEdit") : t("toolbox.photo.configOpen") }}
          </button>
          <button v-if="!editing" class="btn-outline" type="button" :disabled="!configured || testing || !canTest" data-role="config-test" @click="runTest">
            {{ testing ? t("toolbox.photo.configTesting") : t("toolbox.photo.configTest") }}
          </button>
        </div>
      </header>
      <div class="config-body">
        <template v-if="!editing">
          <p v-if="configured" class="hint" data-role="config-summary">{{ configSummary }}</p>
          <p v-else class="hint warn" data-role="config-missing">{{ t("toolbox.photo.notConfigured") }}</p>
          <p v-if="!canTest" class="hint" data-role="test-desktop-only">{{ t("toolbox.photo.configTestDesktopOnly") }}</p>
          <p v-if="testResult" class="hint ok" data-role="test-result">{{ testResult }}</p>
          <p v-if="testError" class="hint bad" data-role="test-error">{{ testError }}</p>
          <p class="hint" data-role="transfer-hint">{{ t("toolbox.photo.transferHint") }}</p>
          <div class="inline-actions">
            <button class="btn-outline" type="button" data-role="config-export" @click="openExport">{{ t("toolbox.photo.exportBtn") }}</button>
            <button class="btn-outline" type="button" data-role="config-import" @click="openImport">{{ t("toolbox.photo.importBtn") }}</button>
          </div>

          <!-- 导出 / 导入面板：同一套配置在多台设备间复制，不用逐字段重敲 -->
          <div v-if="transferMode" class="transfer-box" data-role="transfer-box">
            <p class="hint" style="padding: 0">{{ transferMode === "export" ? t("toolbox.photo.exportHint") : t("toolbox.photo.importHint") }}</p>
            <textarea
              v-model="transferText"
              class="mono transfer-text"
              :readonly="transferMode === 'export'"
              data-role="transfer-text"
              spellcheck="false"
            ></textarea>
            <p v-if="transferError" class="hint bad" style="padding: 0" data-role="transfer-error">{{ transferError }}</p>
            <p v-if="transferOk" class="hint ok" style="padding: 0" data-role="transfer-ok">{{ transferOk }}</p>
            <p v-if="copyState === 'fail'" class="hint bad" style="padding: 0" data-role="copy-fail">{{ t("toolbox.photo.copyFail") }}</p>
            <div class="inline-actions">
              <button v-if="transferMode === 'export'" class="btn-primary sm" type="button" data-role="transfer-copy" @click="copyExport">
                {{ copyState === "ok" ? t("toolbox.photo.copied") : t("toolbox.photo.copyBtn") }}
              </button>
              <button
                v-else
                class="btn-primary sm"
                type="button"
                data-role="transfer-apply"
                :disabled="!transferText.trim()"
                @click="applyImported"
              >
                {{ t("toolbox.photo.importApply") }}
              </button>
              <button class="btn-outline" type="button" data-role="transfer-close" @click="closeTransfer">{{ t("toolbox.photo.closeBtn") }}</button>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="field-grid">
            <label class="field span2">
              <span>{{ t("toolbox.photo.fieldProvider") }}</span>
              <select v-model="draft.provider" data-role="provider">
                <option v-for="item in providers" :key="item.key" :value="item.key">{{ item.label }}</option>
              </select>
            </label>
          </div>
          <p class="hint" data-role="provider-hint">{{ t(draftProvider?.hintKey || "toolbox.photo.providerS3Hint") }}</p>
          <template v-for="f in draftFields" :key="f.key">
            <label v-if="f.type === 'checkbox'" class="check-row">
              <input v-model="draft[f.key]" type="checkbox" :data-role="`field-${f.kebab}`" />
              <span>{{ t(f.labelKey) }}</span>
            </label>
            <label v-else class="field inline-field">
              <span>{{ t(f.labelKey) }}</span>
              <input
                v-model="draft[f.key]"
                :type="f.type === 'password' ? 'password' : 'text'"
                :class="{ mono: f.mono }"
                :data-role="`field-${f.kebab}`"
                :placeholder="f.phKey ? t(f.phKey) : ''"
                spellcheck="false"
                autocomplete="off"
              />
            </label>
            <p v-if="fieldError(f.key)" class="hint bad" :data-role="`err-${f.kebab}`">{{ fieldError(f.key) }}</p>
          </template>
          <div class="inline-actions">
            <button class="btn-primary sm" type="button" data-role="config-save" @click="saveConfig">{{ t("toolbox.photo.configSave") }}</button>
            <button class="btn-outline" type="button" data-role="config-cancel" @click="cancelEdit">{{ t("toolbox.photo.configCancel") }}</button>
          </div>
        </template>
      </div>
    </section>

    <!-- 桌面：云端列表 + 归档 -->
    <template v-if="desktopMode">
      <section class="panel archive-panel">
        <header class="panel-head">
          <b>{{ t("toolbox.photo.cloudTitle") }}</b>
          <span v-if="objects.length" class="panel-meta" data-role="list-meta">
            {{ t("toolbox.photo.listMeta", { total: objects.length, archived: objects.length - freshKeys.length, fresh: freshKeys.length }) }}
          </span>
          <div class="head-actions">
            <button class="btn-outline" type="button" :disabled="loading || !configured" data-role="refresh" @click="refreshList">
              <Icon name="refresh" :size="14" /> {{ t("toolbox.photo.refresh") }}
            </button>
            <button class="btn-ghost" type="button" :disabled="!freshKeys.length" data-role="select-new" @click="selectAllNew">
              {{ t("toolbox.photo.selectNew") }}
            </button>
            <button class="btn-ghost" type="button" :disabled="!selectedKeys.length" data-role="clear-selection" @click="clearSelection">
              {{ t("toolbox.photo.clearSelection") }}
            </button>
          </div>
        </header>

        <div class="archive-bar">
          <label class="field grow">
            <span>{{ t("toolbox.photo.archiveDir") }}</span>
            <div class="dir-input">
              <input v-model="dir" class="mono" data-role="archive-dir" spellcheck="false" :placeholder="t('toolbox.photo.archiveDirPh')" @change="onDirChanged" />
              <button class="icon-btn xs" type="button" :title="t('toolbox.photo.pickDir')" data-role="pick-dir" @click="chooseDir">
                <Icon name="folder" :size="13" />
              </button>
              <button class="icon-btn xs" type="button" :disabled="!dir" :title="t('toolbox.photo.openDir')" data-role="open-dir" @click="openDir">
                <Icon name="link" :size="13" />
              </button>
            </div>
          </label>
          <div class="archive-actions">
            <span v-if="selectedKeys.length" class="count-chip" data-role="selected-count">{{ t("toolbox.photo.selectedCount", { n: selectedKeys.length }) }}</span>
            <button class="btn-primary sm" type="button" :disabled="archiving || !selectedKeys.length" data-role="start-archive" @click="startArchive">
              <Icon name="download" :size="14" /> {{ t("toolbox.photo.startArchive") }}
            </button>
            <button class="btn-outline" type="button" :disabled="!archiving" data-role="cancel-archive" @click="cancelArchive">
              {{ t("toolbox.photo.cancelArchive") }}
            </button>
          </div>
        </div>

        <div v-if="archiving && progress" class="progress-box" data-role="progress">
          <div class="bar"><div class="bar-fill" :style="{ width: progress.total ? (progress.done / progress.total) * 100 + '%' : '0%' }"></div></div>
          <div class="progress-text">
            <span>{{ t("toolbox.photo.progressMeta", { done: progress.done, total: progress.total }) }}</span>
            <span v-if="progress.currentKey" class="mono">{{ t("toolbox.photo.currentFile") }}：{{ baseName(progress.currentKey) }}</span>
            <span v-if="progress.fileTotal" class="mono">{{ formatBytes(progress.fileDone || 0) }} / {{ formatBytes(progress.fileTotal) }}</span>
          </div>
        </div>

        <p v-if="resultNote" class="hint ok" data-role="result-note">{{ resultNote }}</p>
        <ul v-if="failedNotes.length" class="failed-list" data-role="failed-list">
          <li v-for="(note, index) in failedNotes" :key="index" class="hint bad">{{ note }}</li>
        </ul>
        <p v-if="listError" class="hint bad" data-role="list-error">{{ listError }}</p>
        <p v-if="loading" class="hint" data-role="loading">{{ t("toolbox.photo.loading") }}</p>

        <div v-if="!loading && !objects.length && !listError" class="blank-state" data-role="empty">
          <Icon name="camera" :size="22" />
          <p>{{ t("toolbox.photo.emptyCloud") }}</p>
        </div>

        <ul v-else class="photo-list">
          <template v-for="group in groups" :key="group.date">
            <li class="date-head">{{ group.date }}</li>
            <li v-for="row in group.rows" :key="row.key" class="photo-row" :data-archived="manifestByKey.has(row.key)">
              <!-- 整行是一个 label：点名字、点缩略图、点空白处都能勾选 -->
              <label class="photo-row-main">
                <input
                  type="checkbox"
                  class="photo-check"
                  :checked="!!selected[row.key]"
                  :data-role="`pick-${baseName(row.key)}`"
                  @change="toggle(row.key)"
                />
                <PhotoThumb :key="thumbKey(row)" :config="thumbConfig" :photo-key="row.key" />
                <span class="photo-text">
                  <span class="photo-name" :title="row.key">{{ baseName(row.key) }}</span>
                  <span class="photo-meta">{{ rowMeta(row) }}</span>
                </span>
                <span class="photo-size">{{ formatBytes(row.size) }}</span>
                <span v-if="manifestByKey.has(row.key)" class="st-chip ok" data-role="archived-chip">{{ t("toolbox.photo.archivedChip") }}</span>
                <span v-else class="st-chip" data-role="fresh-chip">{{ t("toolbox.photo.freshChip") }}</span>
              </label>
            </li>
          </template>
        </ul>
      </section>
    </template>

    <!-- 浏览器：上传本机照片 -->
    <template v-else>
      <section class="panel upload-panel">
        <header class="panel-head">
          <b>{{ t("toolbox.photo.uploadTitle") }}</b>
          <span v-if="queueStats.total" class="panel-meta" data-role="queue-meta">{{ t("toolbox.photo.queueMeta", { done: queueStats.done, total: queueStats.total }) }}</span>
          <div class="head-actions">
            <button class="btn-primary sm" type="button" data-role="upload-pick" @click="uploadInput.click()">
              <Icon name="plus" :size="14" /> {{ t("toolbox.photo.uploadPick") }}
            </button>
            <button v-if="queueStats.error" class="btn-outline" type="button" data-role="retry-all" @click="uploadQueue?.retryAllErrors().then(refreshQueue)">
              {{ t("toolbox.photo.retryAll") }}
            </button>
            <button v-if="queueStats.done" class="btn-ghost" type="button" data-role="clear-done" @click="uploadQueue?.clearDone().then(refreshQueue)">
              {{ t("toolbox.photo.clearDone") }}
            </button>
          </div>
        </header>
        <input ref="uploadInput" type="file" accept="image/*" multiple class="hidden-input" data-role="upload-input" @change="onUploadPicked" />
        <p class="hint">{{ t("toolbox.photo.uploadHint") }}</p>
        <p v-if="!queueItems.length" class="hint" data-role="empty">{{ t("toolbox.photo.emptyQueue") }}</p>
        <ul v-else class="photo-list compact">
          <li v-for="item in queueItems" :key="item.id" class="photo-row" :data-state="item.status">
            <span class="photo-name" :title="item.key">{{ item.name }}</span>
            <span class="photo-size">{{ formatBytes(item.size) }}</span>
            <span class="st-chip" :data-state="item.status">{{ queueStateLabel(item) }}</span>
            <span v-if="item.error" class="hint bad" data-role="item-error">{{ item.error }}</span>
            <div class="row-actions">
              <button v-if="item.status === QUEUE_STATE.error" class="icon-btn xs" type="button" data-role="item-retry" @click="uploadQueue?.retry(item.id).then(refreshQueue)">
                <Icon name="refresh" :size="13" />
              </button>
              <button v-if="item.status !== QUEUE_STATE.uploading" class="icon-btn xs" type="button" data-role="item-remove" @click="uploadQueue?.remove(item.id).then(refreshQueue)">
                <Icon name="x" :size="13" />
              </button>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.tool-photo {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  /* 配置表单展开后可能超过可用高度：整页可滚。
     矮窗口（笔记本半屏、嵌入主窗口的窄工具区）里不做这件事，面板会被祖先的
     overflow:hidden 直接裁掉——表现为"存储设置滑不下去、保存按钮看不到"。 */
  overflow-y: auto;
}

.panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  background: var(--card);
  overflow: hidden;
}

.config-panel {
  flex-shrink: 0;
}

.archive-panel,
.upload-panel {
  flex: 1;
  /* 配置表单展开时列表也保持一个可用高度（不被挤成一条缝），差额交给根级滚动 */
  min-height: 320px;
}

.panel-head {
  flex-shrink: 0;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  border-bottom: 1px solid var(--border);
  background: var(--card-soft);
}

.panel-head b {
  font-size: var(--fs-md);
}

.panel-meta {
  color: var(--muted);
  font-family: var(--font-num);
  font-size: var(--fs-xs);
}

.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.config-body {
  padding: var(--sp-3) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-3);
}

.field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.field.span2 {
  grid-column: span 2;
}

.field > span {
  color: var(--text-weak);
  font-size: var(--fs-sm);
  font-weight: 600;
}

.field input,
.field select {
  min-width: 0;
  width: 100%;
  height: 32px;
  padding: 0 var(--sp-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  outline: none;
  background: var(--card);
  color: var(--text);
  font-size: var(--fs-md);
}

.field input:focus,
.field select:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}

.field.inline-field {
  max-width: 560px;
}

.transfer-box {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px dashed var(--border-strong);
}

.transfer-text {
  width: 100%;
  min-height: 150px;
  max-height: 260px;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  outline: none;
  background: var(--ghost);
  color: var(--text);
  font-size: var(--fs-sm);
  line-height: 1.5;
  resize: vertical;
}

.transfer-text:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}

.check-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--text-weak);
}

.inline-actions,
.archive-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.archive-bar {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.field.grow {
  flex: 1;
  min-width: 260px;
}

.dir-input {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.dir-input input {
  flex: 1;
}

.progress-box {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border);
}

.bar {
  height: 5px;
  border-radius: var(--r-pill);
  background: var(--ghost);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: var(--r-pill);
  background: var(--primary);
  transition: width 0.25s ease;
}

.progress-text {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  color: var(--muted);
  font-size: var(--fs-xs);
}

.photo-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: var(--sp-2) var(--sp-3) var(--sp-3);
  list-style: none;
  overflow: auto;
}

.photo-list.compact {
  padding-top: var(--sp-2);
}

.date-head {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: var(--sp-2) var(--sp-3) var(--sp-1);
  background: var(--card);
  color: var(--muted);
  font-family: var(--font-num);
  font-size: var(--fs-xs);
  font-weight: 600;
}

.photo-row {
  border-radius: var(--r-sm);
}

.photo-row:hover {
  background: var(--ghost);
}

.photo-row + .photo-row {
  border-top: 1px solid var(--border);
}

/* 整行是一个 label（点名字/缩略图/空白都能勾选），所以内边距放在这里 */
.photo-row-main {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  cursor: pointer;
}

.photo-check {
  flex-shrink: 0;
}

.photo-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.photo-name {
  overflow: hidden;
  font-size: var(--fs-md);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.photo-row[data-archived="true"] .photo-name {
  color: var(--text-weak);
}

.photo-meta {
  overflow: hidden;
  color: var(--muted);
  font-family: var(--font-num);
  font-size: var(--fs-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.photo-size {
  flex-shrink: 0;
  color: var(--text-weak);
  font-family: var(--font-num);
  font-size: var(--fs-xs);
}

.st-chip {
  flex-shrink: 0;
  padding: 1px var(--sp-2);
  border-radius: var(--r-pill);
  background: var(--ghost);
  color: var(--text-weak);
  font-size: var(--fs-xs);
}

.st-chip.ok {
  background: var(--ok-soft, var(--ghost));
  color: var(--ok);
}

.st-chip[data-state="uploading"] {
  background: var(--primary-soft);
  color: var(--primary);
}

.st-chip[data-state="done"] {
  background: var(--ok-soft, var(--ghost));
  color: var(--ok);
}

.st-chip[data-state="error"] {
  background: var(--danger-soft);
  color: var(--danger-deep);
}

.row-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex-shrink: 0;
}

.failed-list {
  flex-shrink: 0;
  margin: 0;
  padding: 0 var(--sp-4);
  list-style: none;
}

.blank-state {
  flex: 1;
  min-height: 130px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-1);
  color: var(--muted);
  font-size: var(--fs-sm);
  text-align: center;
  padding: var(--sp-4);
}

.blank-state p {
  margin: 0;
}

.hidden-input {
  display: none;
}

.mono {
  font-family: var(--font-mono);
}

.hint {
  margin: 0;
  padding: 0 var(--sp-4) var(--sp-2);
  color: var(--muted);
  font-size: var(--fs-sm);
}

.hint.warn {
  color: var(--warn-deep, var(--danger));
}

.hint.ok {
  color: var(--ok);
}

.hint.bad {
  color: var(--danger-deep);
}
</style>
