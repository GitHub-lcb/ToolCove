<script setup>
// 知识库工具（手机端）：条目增删改 + 标签筛选 + 全文检索 + 文本文件导入。
//
// 与桌面端**共用同一份纯逻辑**（src/tools/kb/logic.js，标签解析/筛选/摘要）与**同一个数据类别**
// （data/repository.js 的 kb，因此手机上写的条目会随云同步到桌面端）。
//
// 界面按手机重排：393px 放不下「列表 + 编辑」并排，所以改成列表 ⇄ 编辑两个态切换；
// 操作收进 chips；标签筛选横滑（不换行，否则标签一多就把列表挤没了）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { create, load as loadRecords, onDataChanged, remove as removeRecord, update as updateRecord } from "../../../src/data/repository.js";
import { collectTags, excerpt, filterEntries, formatTags, parseTags, TEXT_EXTENSIONS, textStats, titleFromFile } from "../../../src/tools/kb/logic.js";
import { invoke } from "../../../src/platform/invoke.js";
import { nativeAvailable, pickFile } from "../platform/bridge.js";

const { t } = useI18n();

const ACCEPT = TEXT_EXTENSIONS.map((ext) => `.${ext}`).join(",");

const entries = ref([]);
const keyword = ref("");
const activeTag = ref("");
const view = ref("list"); // list | edit
const editingId = ref("");
const form = ref(newForm());
const notice = ref("");
const confirmOpen = ref(false);
const busy = ref(false);
const fileInput = ref(null);

function newForm() {
  return { title: "", content: "", tags: "" };
}

const tags = computed(() => collectTags(entries.value));
const visible = computed(() => filterEntries(entries.value, { keyword: keyword.value, tag: activeTag.value }));
const formStats = computed(() => textStats(form.value.content));
const isNew = computed(() => !editingId.value);
/** 当前编辑条目的来源文件名（导入进来的才有，手写条目为空） */
const entrySource = computed(() => entries.value.find((e) => e.id === editingId.value)?.source || "");

function flash(message) {
  notice.value = message;
  setTimeout(() => (notice.value = ""), 2000);
}

async function load() {
  try {
    entries.value = await loadRecords("kb");
  } catch (e) {
    flash(t("toolbox.kb.loadFailed", { err: e?.message || String(e) }));
  }
}

onMounted(async () => {
  await load();
  offDataChanged = onDataChanged(async ({ kind, source }) => {
    if (kind !== "kb" || source === "view") return;
    await load();
  });
});
let offDataChanged = null;
onBeforeUnmount(() => offDataChanged?.());

function startNew() {
  editingId.value = "";
  form.value = newForm();
  view.value = "edit";
}

function openEntry(entry) {
  editingId.value = entry.id;
  form.value = { title: entry.title || "", content: entry.content || "", tags: formatTags(entry.tags) };
  view.value = "edit";
}

function backToList() {
  view.value = "list";
}

async function save() {
  const title = form.value.title.trim() || excerpt(form.value.content, 40);
  if (!title) return flash(t("toolbox.kb.errNoTitle"));
  const payload = { title, content: form.value.content, tags: parseTags(form.value.tags) };
  busy.value = true;
  try {
    if (editingId.value) {
      await updateRecord("kb", editingId.value, payload, { source: "view" });
    } else {
      const record = await create("kb", payload, { source: "view" });
      editingId.value = record.id;
    }
    await load();
    view.value = "list";
    flash(t("toolbox.kb.saved"));
  } catch (e) {
    flash(t("toolbox.kb.saveFailed", { err: e?.message || String(e) }));
  } finally {
    busy.value = false;
  }
}

async function doRemove() {
  confirmOpen.value = false;
  if (!editingId.value) return;
  try {
    await removeRecord("kb", editingId.value, { source: "view" });
    editingId.value = "";
    form.value = newForm();
    await load();
    view.value = "list";
    flash(t("toolbox.kb.deleted"));
  } catch (e) {
    flash(t("toolbox.kb.deleteFailed", { err: e?.message || String(e) }));
  }
}

/**
 * 导入文本文件。
 *
 * 有原生桥时走 SAF 选择器 + 桥的 file_tool_read_text（与文件工具同一套能力，能识别 GBK 等编码）；
 * 没有桥（浏览器里跑的手机视口 / 未来 Web 版）就回退到 <input type="file">，与桌面端浏览器形态一致。
 */
async function importFile() {
  if (!nativeAvailable()) {
    fileInput.value?.click();
    return;
  }
  busy.value = true;
  try {
    const uri = await pickFile("text/*");
    if (!uri) return;
    const result = await invoke("file_tool_read_text", { path: uri, encoding: "AUTO" });
    const name = result?.path || uri;
    await storeImported(titleFromFile(name), name, result?.text);
  } catch (e) {
    flash(t("toolbox.kb.importFailed", { err: e?.message || String(e) }));
  } finally {
    busy.value = false;
  }
}

async function onBrowserFile(event) {
  const file = event.target?.files?.[0];
  if (event.target) event.target.value = "";
  if (!file) return;
  try {
    await storeImported(titleFromFile(file.name), file.name, await file.text());
  } catch (e) {
    flash(t("toolbox.kb.importFailed", { err: e?.message || String(e) }));
  }
}

async function storeImported(title, name, text) {
  const content = String(text ?? "");
  if (!content.trim()) return flash(t("toolbox.kb.importEmpty"));
  const record = await create("kb", { title, content, tags: [], source: name }, { source: "view" });
  await load();
  const fresh = entries.value.find((e) => e.id === record.id);
  if (fresh) openEntry(fresh);
  flash(t("toolbox.kb.imported", { title }));
}

// 返回键：先在工具内从编辑态回到列表，再到 Shell 去处理模块切换
function goBack() {
  if (busy.value) return false;
  if (view.value === "edit") {
    view.value = "list";
    return true;
  }
  return false;
}
defineExpose({ goBack });

watch([keyword, activeTag], () => {
  // 筛选条件一变就回列表态：在编辑态里筛完看不到结果，用户会以为筛坏了
  if (view.value === "edit") view.value = "list";
});
</script>

<template>
  <section class="m-tool" data-tool="kb" :data-view="view">
    <!-- 列表态 -->
    <template v-if="view === 'list'">
      <input v-model="keyword" class="m-kb-search" data-role="search" :placeholder="t('toolbox.kb.searchPh')" />

      <div class="m-kb-tags" data-role="tags">
        <button class="m-chip" :class="{ on: !activeTag }" data-tag="" @click="activeTag = ''">{{ t("toolbox.kb.allTags") }}</button>
        <button
          v-for="tag in tags"
          :key="tag"
          class="m-chip"
          :class="{ on: activeTag === tag }"
          :data-tag="tag"
          @click="activeTag = tag"
        >
          {{ tag }}
        </button>
      </div>

      <div class="m-chips" data-role="actions">
        <button class="m-chip" data-role="new" @click="startNew">{{ t("toolbox.kb.newEntry") }}</button>
        <button class="m-chip" data-role="import" :disabled="busy" @click="importFile">{{ t("toolbox.kb.import") }}</button>
      </div>

      <ul class="m-stats" data-role="list">
        <li v-if="!visible.length" class="m-hint-sm" data-role="empty">
          {{ entries.length ? t("toolbox.kb.noMatch") : t("toolbox.kb.empty") }}
        </li>
        <li v-for="entry in visible" :key="entry.id" :data-id="entry.id">
          <button class="m-kb-item" data-role="entry" @click="openEntry(entry)">
            <b>{{ entry.title || t("toolbox.kb.untitled") }}</b>
            <span v-if="entry.tags?.length" class="m-kb-item-tags">{{ entry.tags.join(" · ") }}</span>
            <span class="m-kb-item-excerpt">{{ excerpt(entry.content) }}</span>
          </button>
        </li>
      </ul>

      <p v-if="!entries.length" class="m-hint-sm" data-role="welcome">{{ t("toolbox.kb.emptyHint") }}</p>
    </template>

    <!-- 编辑态 -->
    <template v-else>
      <div class="m-chips" data-role="edit-actions">
        <button class="m-chip" data-role="back" @click="backToList">‹ {{ t("toolbox.kb.allTags") }}</button>
        <button class="m-chip" data-role="save" :disabled="busy" @click="save">{{ t("toolbox.kb.save") }}</button>
        <button class="m-chip" data-role="delete" :disabled="isNew || busy" @click="confirmOpen = true">{{ t("toolbox.kb.delete") }}</button>
      </div>

      <label class="m-field">
        <span>{{ t("toolbox.kb.titlePh") }}</span>
        <input v-model="form.title" data-role="title" />
      </label>

      <label class="m-field">
        <span>{{ t("toolbox.kb.tagsLabel") }}</span>
        <input v-model="form.tags" data-role="tags-input" :placeholder="t('toolbox.kb.tagsPh')" />
      </label>

      <label class="m-field">
        <span>{{ t("toolbox.kb.contentPh") }}</span>
        <textarea v-model="form.content" rows="12" spellcheck="false" data-role="content"></textarea>
      </label>

      <p class="m-hint-sm" data-role="stats">
        {{ t("toolbox.kb.statsChars", { n: formStats.chars }) }} · {{ t("toolbox.kb.statsLines", { n: formStats.lines }) }}
      </p>
      <p v-if="!isNew && entrySource" class="m-hint-sm" data-role="source">{{ t("toolbox.kb.sourceImported", { name: entrySource }) }}</p>
      <p class="m-hint-sm" data-role="import-hint">{{ t("toolbox.kb.importSafety", { exts: [...TEXT_EXTENSIONS].join(" / ") }) }}</p>
    </template>

    <!-- 浏览器形态下的文件入口（有原生桥时由 SAF 选择器承担） -->
    <input ref="fileInput" class="m-kb-file" type="file" :accept="ACCEPT" data-role="file-input" @change="onBrowserFile" />

    <div v-if="confirmOpen" class="m-modal" data-role="confirm">
      <div class="m-modal-card">
        <b>{{ t("toolbox.kb.deleteTitle") }}</b>
        <p>{{ t("toolbox.kb.deleteMsg", { title: form.title.trim() || t("toolbox.kb.untitled") }) }}</p>
        <div class="m-modal-ops">
          <button class="m-modal-cancel" data-role="confirm-cancel" @click="confirmOpen = false">{{ t("common.cancel") }}</button>
          <button class="m-modal-ok" data-role="confirm-ok" @click="doRemove">{{ t("toolbox.kb.delete") }}</button>
        </div>
      </div>
    </div>

    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
  </section>
</template>

<style scoped>
/* 只补知识库特有的几处结构：chip / field / stats / 模态框一律复用 shell.css 里的公共类 */
.m-kb-search {
  width: 100%;
  padding: 8px var(--m-gap);
  border: 1px solid var(--m-border);
  border-radius: var(--m-radius);
  background: var(--m-card);
  color: var(--m-text);
  font-size: 0.9rem;
  box-sizing: border-box;
}

/* 标签横滑不换行：标签一多换行会把列表挤到屏幕外 */
.m-kb-tags {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.m-kb-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--m-text);
  text-align: left;
  font: inherit;
}

.m-kb-item-tags {
  color: var(--m-primary);
  font-size: 0.75rem;
}

.m-kb-item-excerpt {
  color: var(--m-muted);
  font-size: 0.8rem;
  line-height: 1.5;
  word-break: break-word;
}

/* 浏览器形态的文件入口只做触发器，不进布局（有原生桥时由 SAF 选择器承担） */
.m-kb-file {
  display: none;
}
</style>
