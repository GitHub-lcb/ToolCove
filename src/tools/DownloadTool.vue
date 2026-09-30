<script setup>
// 大文件多线程分片下载（桌面端）：批量地址入队 → 逐个下载 → 断点续传。
//
// 为什么单独成工具而不是并进网络工具：网络工具做的是"发请求看响应"（请求体几百 KB 以内，
// 走 network::http_request 一次性读完）。而这里要处理十几 GB 的模型权重——必须流式落盘、
// 分片、可续传，两者的内存模型和交互形态（队列 vs 表单）都不同，混在一起两边都变难用。
//
// 队列串行而不是并发：这些文件本身就把带宽吃满了，并发只会让每个都变慢、
// 进度条互相跳，用户反而看不出哪个快。用户要并行可以用多个窗口。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import { invoke } from "../platform/invoke.js";
import { listen } from "../platform/events.js";
import { open as openDialog } from "../platform/dialog.js";
import { loadToolbox, saveToolbox } from "../toolboxStore.js";
import {
  DEFAULT_CONNS,
  ITEM_STATE,
  MAX_CONNS,
  MIN_CONNS,
  applyProbe,
  applyProgress,
  clampConns,
  createItem,
  dedupeByFileName,
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  hasActiveWork,
  joinDest,
  nextWaiting,
  parseUrlList,
  planParts,
  queueProgress,
  queueSpeed,
  validateDest,
} from "../downloader.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const urlText = ref("");
const dir = ref("");
const conns = ref(DEFAULT_CONNS);
const items = ref([]);
const error = ref("");
const starting = ref(false);
let unlistenProgress = null;
let unlistenFinished = null;

const CONNS_PRESETS = [1, 4, 8, 16];

const parsedUrls = computed(() => parseUrlList(urlText.value));
const progress = computed(() => queueProgress(items.value));
const speed = computed(() => queueSpeed(items.value));
const busy = computed(() => items.value.some((item) => item.state === ITEM_STATE.running));
const hasItems = computed(() => items.value.length > 0);
const doneCount = computed(() => items.value.filter((item) => item.state === ITEM_STATE.done).length);

// 单项剩余时间：只有真正在跑的时候才估，暂停项的 ETA 是假的
function itemEta(item) {
  if (item.state !== ITEM_STATE.running) return "";
  return formatEta(item.downloaded, item.total, item.speed);
}

function itemStateLabel(item) {
  if (item.state === ITEM_STATE.waiting) return t("toolbox.downloader.stateWaiting");
  if (item.state === ITEM_STATE.running) return t("toolbox.downloader.stateRunning");
  if (item.state === ITEM_STATE.paused) return t("toolbox.downloader.statePaused");
  if (item.state === ITEM_STATE.done) return t("toolbox.downloader.stateDone");
  return t("toolbox.downloader.stateError");
}

const dirCheck = computed(() => validateDest(dir.value, ""));
const destHint = computed(() => {
  if (!dirCheck.value.ok) {
    if (dirCheck.value.reason === "empty") return t("toolbox.downloader.dirEmpty");
    if (dirCheck.value.reason === "relative") return t("toolbox.downloader.dirRelative");
    return t("toolbox.downloader.dirIllegal");
  }
  return "";
});

/** 线程数对应的分片数，让用户直观看到"8 线程"切成几段。 */
const partPreview = computed(() => {
  const first = items.value.find((item) => item.total > 0);
  if (!first) return [];
  return planParts(first.total, conns.value);
});

async function chooseDir() {
  const picked = await openDialog({ directory: true, multiple: false, title: t("toolbox.downloader.pickDir") });
  const value = Array.isArray(picked) ? picked[0] : picked;
  if (typeof value === "string" && value) dir.value = value;
}

/** 地址入队。先探测拿真实文件名与体积，探测失败的项仍然入队（起下时报错更具体）。 */
async function addToQueue() {
  const urls = parsedUrls.value;
  if (!urls.length) {
    error.value = t("toolbox.downloader.noUrl");
    return;
  }
  if (!dirCheck.value.ok) {
    error.value = destHint.value;
    return;
  }
  error.value = "";
  starting.value = true;
  const base = items.value.length;
  const fresh = urls.map((url, index) => createItem(url, base + index, dir.value));
  // 同名文件会互相覆盖，同一批里先滤掉（连已有项一起判，避免跟队列里的旧项撞名）
  const merged = [...items.value, ...fresh];
  const kept = dedupeByFileName(merged);
  const dropped = merged.length - kept.length;
  items.value = kept;
  if (dropped > 0) props.showToast(t("toolbox.downloader.deduped", { n: dropped }));

  // 只探测这一批新加的
  for (const item of fresh) {
    const index = items.value.findIndex((row) => row.id === item.id);
    if (index === -1) continue;
    items.value[index] = { ...items.value[index], probing: true };
    try {
      const probe = await invoke("downloader_probe", { url: item.url });
      const at = items.value.findIndex((row) => row.id === item.id);
      if (at !== -1) items.value[at] = { ...applyProbe(items.value[at], probe), probing: false };
    } catch (e) {
      const at = items.value.findIndex((row) => row.id === item.id);
      if (at !== -1) {
        items.value[at] = {
          ...items.value[at],
          probing: false,
          state: ITEM_STATE.error,
          error: String(e?.message || e),
        };
      }
    }
  }
  urlText.value = "";
  starting.value = false;
}

function removeItem(id) {
  const item = items.value.find((row) => row.id === id);
  if (item && item.state === ITEM_STATE.running) cancelItem(id);
  items.value = items.value.filter((row) => row.id !== id);
}

function patchItem(id, patch) {
  const index = items.value.findIndex((row) => row.id === id);
  if (index === -1) return;
  items.value[index] = { ...items.value[index], ...patch };
}

async function cancelItem(id) {
  patchItem(id, { state: ITEM_STATE.paused, speed: 0 });
  try {
    await invoke("downloader_cancel", { id });
  } catch {
    // 任务可能已经结束，取消失败不影响界面状态
  }
}

/** 丢弃断点分片：用户不想续传、或换了线程数想从头下时用。 */
async function discardResume(item) {
  try {
    await invoke("downloader_discard", { dest: joinDest(item.dest || dir.value, item.fileName) });
    patchItem(item.id, { downloaded: 0, resumable: false, state: ITEM_STATE.waiting, error: "" });
  } catch (e) {
    props.showToast(String(e?.message || e));
  }
}

async function startItem(item) {
  const targetDir = item.dest || dir.value;
  const check = validateDest(targetDir, item.fileName);
  if (!check.ok) {
    patchItem(item.id, { state: ITEM_STATE.error, error: destHint.value || t("toolbox.downloader.dirIllegal") });
    return;
  }
  patchItem(item.id, { state: ITEM_STATE.running, error: "", speed: 0, dest: targetDir });
  try {
    await invoke("downloader_start", {
      id: item.id,
      url: item.url,
      dest: joinDest(targetDir, item.fileName),
      conns: clampConns(item.conns || conns.value),
    });
  } catch (e) {
    patchItem(item.id, { state: ITEM_STATE.error, error: String(e?.message || e), speed: 0 });
  }
}

/**
 * 队列推进：只跑一个，结束或出错后自动起下一个。
 * 逐项串行的理由见文件头注释。
 */
async function pump() {
  if (busy.value || starting.value) return;
  const next = nextWaiting(items.value);
  if (next) await startItem(next);
}

function startAll() {
  // 线程数应用到所有还没开始的项（已在跑的项不动，避免中途换布局毁掉续传）
  for (const item of items.value) {
    if (item.state === ITEM_STATE.waiting) item.conns = clampConns(conns.value);
  }
  pump();
}

function pauseAll() {
  for (const item of items.value) {
    if (item.state === ITEM_STATE.running) cancelItem(item.id);
  }
}

function clearFinished() {
  items.value = items.value.filter((item) => item.state !== ITEM_STATE.done);
}

onMounted(async () => {
  unlistenProgress = await listen("downloader:progress", (event) => {
    const payload = event?.payload;
    const index = items.value.findIndex((row) => row.id === payload?.id);
    if (index === -1) return;
    items.value[index] = applyProgress(items.value[index], payload);
  });
  unlistenFinished = await listen("downloader:finished", (event) => {
    const payload = event?.payload;
    const index = items.value.findIndex((row) => row.id === payload?.id);
    if (index === -1) return;
    if (payload?.ok) {
      items.value[index] = {
        ...items.value[index],
        state: ITEM_STATE.done,
        downloaded: Number(payload.downloaded) || items.value[index].downloaded,
        total: Number(payload.total) || items.value[index].total,
        speed: 0,
        resumable: false,
        error: "",
      };
    } else {
      items.value[index] = {
        ...items.value[index],
        // canceled 来自用户主动取消，不算失败：落回暂停态，「继续」按钮能接上断点
        state: payload?.canceled ? ITEM_STATE.paused : ITEM_STATE.error,
        speed: 0,
        error: payload?.canceled ? "" : String(payload?.error || t("toolbox.downloader.unknownError")),
        resumable: Boolean(payload?.resumable),
      };
    }
    pump();
  });
  const saved = await loadToolbox("downloader", {});
  if (saved && typeof saved === "object") {
    if (typeof saved.dir === "string") dir.value = saved.dir;
    if (saved.conns) conns.value = clampConns(saved.conns);
  }
});

onBeforeUnmount(() => {
  if (unlistenProgress) unlistenProgress();
  if (unlistenFinished) unlistenFinished();
  if (hasActiveWork(items.value)) saveToolbox("downloader", { dir: dir.value, conns: conns.value });
});
</script>

<template>
  <div class="tool-downloader">
    <section class="panel add-panel">
      <header class="panel-head">
        <b>{{ t("toolbox.downloader.addTitle") }}</b>
        <span v-if="parsedUrls.length" class="count-chip" data-role="parsed-count">{{ parsedUrls.length }}</span>
      </header>
      <div class="add-body">
        <label class="field grow">
          <span>{{ t("toolbox.downloader.urlLabel") }}</span>
          <textarea
            v-model="urlText"
            class="text-editor mono"
            spellcheck="false"
            data-role="urls"
            :placeholder="t('toolbox.downloader.urlPh')"
          ></textarea>
        </label>
        <div class="add-row">
          <label class="field dir-field">
            <span>{{ t("toolbox.downloader.dirLabel") }}</span>
            <div class="dir-input">
              <input v-model="dir" class="mono" data-role="dir" spellcheck="false" :placeholder="t('toolbox.downloader.dirPh')" />
              <button class="icon-btn xs" type="button" :title="t('toolbox.downloader.pickDir')" data-role="pick-dir" @click="chooseDir">
                <Icon name="folder" :size="13" />
              </button>
            </div>
          </label>
          <label class="field conns-field">
            <span>{{ t("toolbox.downloader.connsLabel") }}</span>
            <div class="conns-row">
              <button
                v-for="preset in CONNS_PRESETS"
                :key="preset"
                type="button"
                class="conns-preset"
                :class="{ on: clampConns(conns) === preset }"
                :data-conns="preset"
                @click="conns = preset"
              >
                {{ preset }}
              </button>
              <input v-model.number="conns" type="number" class="mono conns-input" data-role="conns" :min="MIN_CONNS" :max="MAX_CONNS" />
            </div>
          </label>
        </div>
        <p v-if="destHint" class="hint warn" data-role="dir-error">{{ destHint }}</p>
        <div class="add-actions">
          <span v-if="partPreview.length" class="hint" data-role="part-preview">
            {{ t("toolbox.downloader.partsPreview", { n: partPreview.length }) }}
          </span>
          <span class="spacer"></span>
          <button class="btn-outline" type="button" :disabled="starting || !parsedUrls.length" data-role="add" @click="addToQueue">
            <Icon name="plus" :size="14" /> {{ t("toolbox.downloader.addBtn") }}
          </button>
        </div>
      </div>
    </section>

    <section class="panel queue-panel">
      <header class="panel-head">
        <b>{{ t("toolbox.downloader.queueTitle") }}</b>
        <span v-if="hasItems" class="panel-meta" data-role="queue-meta">
          {{ t("toolbox.downloader.queueMeta", { done: doneCount, total: items.length }) }}
        </span>
        <div class="head-actions">
          <button class="btn-primary sm" type="button" :disabled="busy || !items.length" data-role="start-all" @click="startAll">
            <Icon name="download" :size="14" /> {{ t("toolbox.downloader.startAll") }}
          </button>
          <button class="btn-outline" type="button" :disabled="!busy" data-role="pause-all" @click="pauseAll">
            <Icon name="square" :size="14" /> {{ t("toolbox.downloader.pauseAll") }}
          </button>
          <button class="btn-ghost" type="button" :disabled="!doneCount" data-role="clear" @click="clearFinished">
            {{ t("toolbox.downloader.clearDone") }}
          </button>
        </div>
      </header>

      <div v-if="hasItems" class="queue-summary" data-role="summary">
        <div class="bar"><div class="bar-fill" :style="{ width: progress.total ? (progress.downloaded / progress.total) * 100 + '%' : '0%' }"></div></div>
        <div class="summary-text">
          <span data-role="summary-text">
            {{ formatBytes(progress.downloaded) }} / {{ formatBytes(progress.total) }} · {{ formatPercent(progress.downloaded, progress.total) }}
          </span>
          <span v-if="speed" data-role="summary-speed">{{ formatSpeed(speed) }}</span>
        </div>
      </div>

      <div v-if="!hasItems" class="blank-state" data-role="empty">
        <Icon name="download" :size="22" />
        <p>{{ t("toolbox.downloader.emptyTitle") }}</p>
        <p class="hint">{{ t("toolbox.downloader.emptyHint") }}</p>
      </div>

      <ul v-else class="queue-list">
        <li v-for="item in items" :key="item.id" class="queue-item" :data-state="item.state" :data-role="`item-${item.id}`">
          <div class="item-main">
            <div class="item-head">
              <Icon :name="item.state === ITEM_STATE.done ? 'check' : item.state === ITEM_STATE.error ? 'alert' : 'download'" :size="14" class="item-icon" />
              <b class="item-name" :title="item.fileName">{{ item.fileName }}</b>
              <span class="state-chip" :data-state="item.state">{{ itemStateLabel(item) }}</span>
              <span v-if="item.resumable" class="st-chip sm" data-role="resumable">{{ t("toolbox.downloader.resumableChip") }}</span>
            </div>
            <div class="item-url" :title="item.url">{{ item.url }}</div>
            <div v-if="item.state === ITEM_STATE.running || item.state === ITEM_STATE.paused" class="bar">
              <div class="bar-fill" :style="{ width: item.total ? (item.downloaded / item.total) * 100 + '%' : '0%' }"></div>
            </div>
            <div class="item-meta">
              <span data-role="item-size">
                {{ formatBytes(item.downloaded) }}<template v-if="item.total"> / {{ formatBytes(item.total) }}</template>
              </span>
              <span v-if="item.state === ITEM_STATE.running && item.speed" data-role="item-speed">{{ formatSpeed(item.speed) }}</span>
              <span v-if="itemEta(item)" data-role="item-eta">{{ t("toolbox.downloader.eta", { time: itemEta(item) }) }}</span>
              <span v-if="item.state === ITEM_STATE.running" data-role="item-conns">{{ item.conns }} {{ t("toolbox.downloader.connsUnit") }}</span>
            </div>
            <p v-if="item.probing" class="hint" data-role="item-probing">{{ t("toolbox.downloader.probing") }}</p>
            <p v-if="item.error" class="hint bad" data-role="item-error">{{ item.error }}</p>
          </div>
          <div class="item-actions">
            <button
              v-if="item.state === ITEM_STATE.waiting"
              class="icon-btn xs"
              type="button"
              :title="t('toolbox.downloader.startOne')"
              :data-role="`start-${item.id}`"
              @click="startItem(item)"
            >
              <Icon name="download" :size="13" />
            </button>
            <button
              v-if="item.state === ITEM_STATE.paused"
              class="icon-btn xs"
              type="button"
              :title="t('toolbox.downloader.resumeOne')"
              :data-role="`resume-${item.id}`"
              @click="startItem(item)"
            >
              <Icon name="refresh" :size="13" />
            </button>
            <button
              v-if="item.state === ITEM_STATE.running"
              class="icon-btn xs"
              type="button"
              :title="t('toolbox.downloader.pauseOne')"
              :data-role="`pause-${item.id}`"
              @click="cancelItem(item.id)"
            >
              <Icon name="square" :size="13" />
            </button>
            <button
              v-if="item.resumable || item.downloaded > 0"
              class="icon-btn xs"
              type="button"
              :title="t('toolbox.downloader.discardTitle')"
              :data-role="`discard-${item.id}`"
              @click="discardResume(item)"
            >
              <Icon name="trash" :size="13" />
            </button>
            <button class="icon-btn xs" type="button" :title="t('toolbox.downloader.removeTitle')" :data-role="`remove-${item.id}`" @click="removeItem(item.id)">
              <Icon name="x" :size="13" />
            </button>
          </div>
        </li>
      </ul>
    </section>

    <p v-if="error" class="hint bad" data-role="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.tool-downloader {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
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

.add-panel {
  flex-shrink: 0;
}

.queue-panel {
  flex: 1;
  min-height: 0;
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

.count-chip {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--primary-soft);
  color: var(--primary);
  font-family: var(--font-num);
  font-size: var(--fs-xs);
}

.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.add-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
}

.field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.field > span {
  color: var(--text-weak);
  font-size: var(--fs-sm);
  font-weight: 600;
}

.field.grow {
  flex: 1;
}

.field textarea {
  min-height: 84px;
  max-height: 160px;
}

.field input {
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
.text-editor:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}

.add-row {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-end;
  flex-wrap: wrap;
}

.dir-field {
  flex: 1;
  min-width: 220px;
}

.conns-field {
  flex: 0 0 auto;
}

.dir-input {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.dir-input input {
  flex: 1;
}

.conns-row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.conns-preset {
  min-width: 30px;
  height: 32px;
  padding: 0 var(--sp-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--card);
  color: var(--text-weak);
  font-size: var(--fs-md);
  cursor: pointer;
  font-family: var(--font-num);
}

.conns-preset:hover {
  border-color: var(--primary);
}

.conns-preset.on {
  background: var(--primary-soft);
  border-color: var(--border-blue);
  color: var(--primary);
  font-weight: 600;
}

.conns-input {
  width: 64px;
  text-align: center;
}

.add-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.spacer {
  flex: 1;
}

.mono,
code {
  font-family: var(--font-mono);
}

.hint {
  margin: 0;
  color: var(--muted);
  font-size: var(--fs-sm);
}

.hint.warn {
  color: var(--warn-deep, var(--danger));
}

.hint.bad {
  color: var(--danger-deep);
}

.queue-summary {
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

.summary-text {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  color: var(--muted);
  font-family: var(--font-num);
  font-size: var(--fs-xs);
}

.summary-text span:last-child {
  margin-left: auto;
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

.blank-state svg {
  color: var(--faint);
}

.blank-state p {
  margin: 0;
}

.queue-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  list-style: none;
  overflow: auto;
}

.queue-item {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
}

.queue-item:hover {
  background: var(--ghost);
}

.queue-item + .queue-item {
  border-top: 1px solid var(--border);
}

.queue-item[data-state="error"] {
  border-color: var(--border-danger);
  background: var(--danger-soft);
}

.queue-item[data-state="done"] .item-name {
  color: var(--text-weak);
}

.item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.item-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.item-icon {
  color: var(--primary);
  flex-shrink: 0;
}

.item-name {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-md);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-chip {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--ghost);
  color: var(--text-weak);
  font-size: var(--fs-xs);
}

.state-chip[data-state="running"] {
  background: var(--primary-soft);
  color: var(--primary);
}

.state-chip[data-state="done"] {
  background: var(--ok-soft, var(--ghost));
  color: var(--ok);
}

.state-chip[data-state="error"] {
  background: var(--danger-soft);
  color: var(--danger-deep);
}

.item-url {
  overflow: hidden;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  color: var(--text-weak);
  font-family: var(--font-num);
  font-size: var(--fs-xs);
}

.item-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex-shrink: 0;
}
</style>
