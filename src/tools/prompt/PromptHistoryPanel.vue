<script setup>
// 生成历史：折叠行（状态/时间/提示词摘要/参数摘要），展开后看结果媒体与重试下载。
// 记录由外层持久化（toolboxStore prompt-history），本组件只负责展示与发出动作事件。
// 媒体预览按需加载（展开才读盘），100 条记录打开面板不会引发上百次 IPC。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../../platform/invoke.js";
import { askConfirm } from "../../ui/confirm.js";
import Icon from "../../ui/Icon.vue";
import { downloadOutput } from "./comfyClient.js";
import { mediaName, normalizeExt } from "./promptGen.js";
import { normalizeComfyBase } from "./comfy.js";
import PromptMediaCard from "./PromptMediaCard.vue";

const props = defineProps({
  history: { type: Array, default: () => [] },
  config: { type: Object, required: true },
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["rerun", "delete", "update"]);

const { t } = useI18n();
const expandedId = ref("");
const visibleCount = ref(30);
const retrying = ref(false);

const PAGE = 30;
const visibleRows = computed(() => (Array.isArray(props.history) ? props.history.slice(0, visibleCount.value) : []));
const hiddenCount = computed(() => Math.max(0, (props.history?.length ?? 0) - visibleCount.value));

const STATUS_KEY = {
  queued: "toolbox.prompt.histQueued",
  running: "toolbox.prompt.histRunning",
  done: "toolbox.prompt.histDone",
  error: "toolbox.prompt.histError",
  canceled: "toolbox.prompt.histCanceled",
};

function statusText(record) {
  return t(STATUS_KEY[record?.status] ?? "toolbox.prompt.histError");
}

function fmtTime(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function paramsText(record) {
  const params = record?.params || {};
  if (record?.mode === "cloud") return [params.model, params.size].filter(Boolean).join(" · ");
  if (record?.mode === "txt2img") {
    return [params.checkpoint, `${params.width}×${params.height}`, `steps ${params.steps}`].filter(Boolean).join(" · ");
  }
  return params.workflowName || record?.params?.workflowId || "";
}

function toggle(record) {
  expandedId.value = expandedId.value === record.id ? "" : record.id;
}

function failedOf(record) {
  return Array.isArray(record?.failed) ? record.failed : [];
}

async function retryDownload(record) {
  const failed = failedOf(record);
  const retryable = failed.filter((file) => file?.filename);
  if (!retryable.length || retrying.value) return;
  retrying.value = true;
  const base = normalizeComfyBase(props.config.comfy.baseUrl);
  const files = [...(record.files || [])];
  const rest = [];
  let okCount = 0;
  for (const file of failed) {
    if (!file?.filename) {
      rest.push(file);
      continue;
    }
    try {
      const saved = await downloadOutput(base, file, mediaName(normalizeExt(file.filename)));
      files.push({ ...file, name: saved.name, bytes: saved.bytes });
      okCount += 1;
    } catch {
      rest.push(file);
    }
  }
  retrying.value = false;
  emit("update", { id: record.id, patch: { files, failed: rest } });
  if (okCount) props.showToast(t("toolbox.prompt.histRetryOk"));
  else props.showToast(t("toolbox.prompt.histRetryFail", { message: "" }));
}

async function removeRecord(record) {
  const ok = await askConfirm({
    title: t("toolbox.prompt.histDeleteConfirmTitle"),
    message: t("toolbox.prompt.histDeleteConfirmMsg"),
    okText: t("toolbox.prompt.delete"),
  });
  if (!ok) return;
  for (const file of [...(record.files || []), ...failedOf(record)]) {
    if (!file?.name) continue;
    try {
      await invoke("media_delete", { name: file.name });
    } catch {
      // 文件删不掉不阻塞删记录（设置页提示可手动清理媒体目录）
    }
  }
  emit("delete", record.id);
}
</script>

<template>
  <div class="hist-panel">
    <p v-if="!history.length" class="empty" data-role="hist-empty">{{ t("toolbox.prompt.histEmpty") }}</p>
    <template v-else>
      <div v-for="record in visibleRows" :key="record.id" class="hist-row" data-role="hist-row" :data-status="record.status">
        <button type="button" class="head" data-role="hist-toggle" @click="toggle(record)">
          <span class="badge" :class="record.status">{{ statusText(record) }}</span>
          <span class="time">{{ fmtTime(record.ts) }}</span>
          <span class="text" :title="record.positive">{{ record.positive }}</span>
          <span class="params">{{ paramsText(record) }}</span>
          <Icon :name="expandedId === record.id ? 'chevron' : 'chevron-right'" :size="13" />
        </button>
        <div v-if="expandedId === record.id" class="detail" data-role="hist-detail">
          <p class="line"><span class="label">{{ t("toolbox.prompt.editorPositive") }}</span>{{ record.positive }}</p>
          <p v-if="record.negative" class="line"><span class="label">{{ t("toolbox.prompt.editorNegative") }}</span>{{ record.negative }}</p>
          <p class="line"><span class="label">{{ t("toolbox.prompt.elapsed") }}</span>{{ Math.round((record.durationMs || 0) / 100) / 10 }}s</p>
          <p v-if="record.error" class="line err" data-role="hist-error">{{ record.error }}</p>
          <div v-if="record.files?.length" class="media-grid">
            <PromptMediaCard v-for="file in record.files" :key="file.name" :name="file.name" :kind="file.kind" :show-toast="showToast" />
          </div>
          <p v-if="failedOf(record).length" class="line err">
            {{ t("toolbox.prompt.errDownloadFailed") }}：{{ failedOf(record).map((f) => f.filename).join("、") }}
          </p>
          <div class="actions">
            <button type="button" class="ghost" data-role="hist-rerun" @click.stop="emit('rerun', record)">
              <Icon name="refresh" :size="13" />
              {{ t("toolbox.prompt.histRerun") }}
            </button>
            <button v-if="failedOf(record).some((f) => f.filename)" type="button" class="ghost" :disabled="retrying" data-role="hist-retry" @click.stop="retryDownload(record)">
              <Icon name="download" :size="13" />
              {{ t("toolbox.prompt.histRetryDownload") }}
            </button>
            <button type="button" class="ghost danger" data-role="hist-del" @click.stop="removeRecord(record)">
              <Icon name="trash" :size="13" />
              {{ t("toolbox.prompt.delete") }}
            </button>
          </div>
        </div>
      </div>
      <button v-if="hiddenCount" type="button" class="ghost more" data-role="hist-more" @click="visibleCount += PAGE">
        {{ t("toolbox.prompt.histMore", { n: hiddenCount }) }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.hist-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.empty {
  margin: 24px 0;
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--text-weak);
}
.hist-row {
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm, 8px);
  background: var(--card);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  border: none;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  min-width: 0;
}
.head:hover {
  background: var(--ghost);
}
.badge {
  flex-shrink: 0;
  font-size: var(--fs-xs);
  padding: 2px var(--sp-1);
  border-radius: var(--r-pill, 999px);
  background: var(--well);
  color: var(--text-weak);
}
.badge.done {
  background: var(--success-soft);
  color: var(--success);
}
.badge.error {
  background: var(--danger-soft);
  color: var(--danger);
}
.badge.running {
  background: var(--primary-soft);
  color: var(--primary);
}
.time {
  flex-shrink: 0;
  font-size: var(--fs-xs);
  color: var(--text-weak);
}
.text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
}
.params {
  flex-shrink: 0;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-weak);
}
.detail {
  border-top: 1px solid var(--card-border);
  padding: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.line {
  margin: 0;
  font-size: var(--fs-sm);
  word-break: break-word;
}
.line.err {
  color: var(--danger);
}
.label {
  color: var(--text-weak);
  margin-right: var(--sp-2);
}
.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--sp-2);
}
.actions {
  display: flex;
  gap: var(--sp-2);
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
.ghost.danger {
  color: var(--danger);
  border-color: var(--border-danger, var(--border));
}
.more {
  align-self: center;
}
</style>
