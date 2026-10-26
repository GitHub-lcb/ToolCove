<script setup>
// 知识库工具（桌面端 / 浏览器端）：条目增删改 + 标签分类 + 全文检索 + 文本文件导入。
//
// 与相邻工具的边界（刻意划清，避免功能重叠）：
//   · 不做通用文本处理与 Markdown 渲染 → 那是 markdown / text 工具
//   · 不做结构化解析 → 那是 json / table 工具
//   这里只管「把值得留下的文本收起来，并且能找回来」。
//
// 存储走 data/repository.js 的 kb 类别：单条读写（create/update/remove）而不是自己 invoke 整表覆盖，
// 因此条目的写入会自动入队云同步；Agent 侧经通用 data.* 工具读写同一批数据（见 ./contract.js 的豁免说明）。
// 标签解析/筛选/摘要等纯逻辑在 ./logic.js（三端共用，见 logic.test.js）。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../../ui/Icon.vue";
import { askConfirm } from "../../ui/confirm.js";
import { isDesktop } from "../../platform/env.js";
import { invoke } from "../../platform/invoke.js";
import { open as openDialog } from "../../platform/dialog.js";
import { create, load as loadRecords, onDataChanged, remove as removeRecord, update as updateRecord } from "../../data/repository.js";
import { collectTags, excerpt, filterEntries, formatTags, parseTags, TEXT_EXTENSIONS, textStats, titleFromFile } from "./logic.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const entries = ref([]);
const keyword = ref("");
const activeTag = ref("");
const selectedId = ref("");
const form = ref(newForm());
const busy = ref(false);
const fileInput = ref(null);

const ACCEPT = TEXT_EXTENSIONS.map((ext) => `.${ext}`).join(",");

function newForm() {
  return { title: "", content: "", tags: "" };
}

const tags = computed(() => collectTags(entries.value));
const visible = computed(() => filterEntries(entries.value, { keyword: keyword.value, tag: activeTag.value }));
const selected = computed(() => entries.value.find((e) => e.id === selectedId.value) || null);
const isNew = computed(() => !selectedId.value);
const formStats = computed(() => textStats(form.value.content));

const errorMessage = (e) => e?.message || String(e);

async function load() {
  try {
    entries.value = await loadRecords("kb");
  } catch (e) {
    props.showToast(t("toolbox.kb.loadFailed", { err: errorMessage(e) }));
  }
}

let offDataChanged = null;
onMounted(async () => {
  await load();
  // Agent / 云同步 / 另一窗口改了数据 → 重新加载；正在编辑的那条以用户手上的输入为准（表单持有自己的副本）
  offDataChanged = onDataChanged(async ({ kind, source }) => {
    if (kind !== "kb" || source === "view") return;
    await load();
    const current = entries.value.find((e) => e.id === selectedId.value);
    if (current) props.showToast(t("toolbox.kb.saved"));
  });
});
onBeforeUnmount(() => offDataChanged?.());

function select(entry) {
  selectedId.value = entry.id;
  form.value = { title: entry.title || "", content: entry.content || "", tags: formatTags(entry.tags) };
}

function startNew() {
  selectedId.value = "";
  form.value = newForm();
  keyword.value = "";
  activeTag.value = "";
}

async function save() {
  const title = form.value.title.trim() || excerpt(form.value.content, 40);
  if (!title) return props.showToast(t("toolbox.kb.errNoTitle"));
  const payload = { title, content: form.value.content, tags: parseTags(form.value.tags) };
  busy.value = true;
  try {
    if (selectedId.value) {
      await updateRecord("kb", selectedId.value, payload, { source: "view" });
    } else {
      const record = await create("kb", payload, { source: "view" });
      selectedId.value = record.id;
    }
    await load();
    props.showToast(t("toolbox.kb.saved"));
  } catch (e) {
    props.showToast(t("toolbox.kb.saveFailed", { err: errorMessage(e) }));
  } finally {
    busy.value = false;
  }
}

async function removeSelected() {
  const entry = selected.value;
  if (!entry) return;
  const ok = await askConfirm({
    title: t("toolbox.kb.deleteTitle"),
    message: t("toolbox.kb.deleteMsg", { title: entry.title || t("toolbox.kb.untitled") }),
    okText: t("toolbox.kb.delete"),
  });
  if (!ok) return;
  try {
    await removeRecord("kb", entry.id, { source: "view" });
    startNew();
    await load();
    props.showToast(t("toolbox.kb.deleted"));
  } catch (e) {
    props.showToast(t("toolbox.kb.deleteFailed", { err: errorMessage(e) }));
  }
}

/**
 * 导入文本文件。
 *
 * 桌面端走原生读文本（file_tool_read_text 自带 UTF-8/UTF-16/GBK 识别，与文件工具同一套能力）；
 * 浏览器端没有系统文件选择器（platform/dialog.js 的 open 在浏览器端返回 null），
 * 回退到 <input type="file"> + File.text()。
 */
async function importFile() {
  if (!isDesktop) {
    fileInput.value?.click();
    return;
  }
  const path = await openDialog({
    title: t("toolbox.kb.importPick"),
    filters: [{ name: t("toolbox.kb.importTextFilter"), extensions: [...TEXT_EXTENSIONS] }],
  });
  if (!path) return;
  busy.value = true;
  try {
    const result = await invoke("file_tool_read_text", { path, encoding: "AUTO" });
    await storeImported(titleFromFile(path), path, result?.text);
  } catch (e) {
    props.showToast(t("toolbox.kb.importFailed", { err: errorMessage(e) }));
  } finally {
    busy.value = false;
  }
}

async function onBrowserFile(event) {
  const file = event.target?.files?.[0];
  // 同一个文件再选一次也要能触发 change，所以要清掉已选值
  if (event.target) event.target.value = "";
  if (!file) return;
  try {
    await storeImported(titleFromFile(file.name), file.name, await file.text());
  } catch (e) {
    props.showToast(t("toolbox.kb.importFailed", { err: errorMessage(e) }));
  }
}

async function storeImported(title, name, text) {
  const content = String(text ?? "");
  if (!content.trim()) return props.showToast(t("toolbox.kb.importEmpty"));
  const record = await create("kb", { title, content, tags: [], source: name }, { source: "view" });
  await load();
  const fresh = entries.value.find((e) => e.id === record.id);
  if (fresh) select(fresh);
  props.showToast(t("toolbox.kb.imported", { title }));
}
</script>

<template>
  <div class="tool-kb">
    <!-- 左栏：检索 + 标签 + 条目列表 + 新建/导入 -->
    <aside class="kb-side">
      <input v-model="keyword" class="kb-search" data-role="search" :placeholder="t('toolbox.kb.searchPh')" />

      <!-- data-role 不能与编辑表单的 tags 输入框重名：E2E 按这个属性定位，重名会触发 strict mode 歧义 -->
      <div class="kb-chips" data-role="tag-cloud">
        <button class="kb-chip" :class="{ on: !activeTag }" data-tag="" @click="activeTag = ''">{{ t("toolbox.kb.allTags") }}</button>
        <button
          v-for="tag in tags"
          :key="tag"
          class="kb-chip"
          :class="{ on: activeTag === tag }"
          :data-tag="tag"
          @click="activeTag = tag"
        >
          {{ tag }}
        </button>
      </div>

      <ul class="kb-list" data-role="list">
        <li v-if="!visible.length" class="kb-empty" data-role="empty">
          {{ entries.length ? t("toolbox.kb.noMatch") : t("toolbox.kb.empty") }}
        </li>
        <li v-for="entry in visible" :key="entry.id">
          <button
            class="kb-item"
            :class="{ on: entry.id === selectedId }"
            :data-id="entry.id"
            data-role="entry"
            @click="select(entry)"
          >
            <span class="kb-item-title">{{ entry.title || t("toolbox.kb.untitled") }}</span>
            <span v-if="entry.tags?.length" class="kb-item-tags">{{ entry.tags.join(" · ") }}</span>
            <span class="kb-item-excerpt">{{ excerpt(entry.content) }}</span>
          </button>
        </li>
      </ul>

      <div class="kb-side-foot">
        <button class="kb-btn" data-role="new" @click="startNew">
          <Icon name="plus" /> {{ t("toolbox.kb.newEntry") }}
        </button>
        <button class="kb-btn" data-role="import" :disabled="busy" @click="importFile">
          <Icon name="file" /> {{ t("toolbox.kb.import") }}
        </button>
        <!-- 浏览器端的文件入口：桌面端由原生对话框承担，但两种形态都留着，E2E 才不用分叉 -->
        <input ref="fileInput" class="kb-file" type="file" :accept="ACCEPT" data-role="file-input" @change="onBrowserFile" />
      </div>
    </aside>

    <!-- 右栏：编辑器 -->
    <section class="kb-main" :data-state="isNew ? 'new' : 'edit'">
      <div class="kb-bar">
        <input v-model="form.title" class="kb-title" data-role="title" :placeholder="t('toolbox.kb.titlePh')" />
        <button class="kb-btn primary" data-role="save" :disabled="busy" @click="save">{{ t("toolbox.kb.save") }}</button>
        <button class="kb-btn danger" data-role="delete" :disabled="isNew || busy" @click="removeSelected">
          <Icon name="trash" /> {{ t("toolbox.kb.delete") }}
        </button>
      </div>

      <label class="kb-field">
        <span>{{ t("toolbox.kb.tagsLabel") }}</span>
        <input v-model="form.tags" data-role="tags" :placeholder="t('toolbox.kb.tagsPh')" />
      </label>

      <textarea v-model="form.content" class="kb-editor" data-role="content" spellcheck="false" :placeholder="t('toolbox.kb.contentPh')"></textarea>

      <div class="kb-meta">
        <span data-role="stats">{{ t("toolbox.kb.statsChars", { n: formStats.chars }) }} · {{ t("toolbox.kb.statsLines", { n: formStats.lines }) }}</span>
        <span v-if="selected?.source" data-role="source">{{ t("toolbox.kb.sourceImported", { name: selected.source }) }}</span>
      </div>

      <p class="kb-hint" data-role="import-hint">{{ t("toolbox.kb.importSafety", { exts: [...TEXT_EXTENSIONS].join(" / ") }) }}</p>
      <p v-if="!entries.length" class="kb-welcome" data-role="welcome">{{ t("toolbox.kb.emptyHint") }}</p>
    </section>
  </div>
</template>

<style scoped>
.tool-kb {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
}

.kb-side {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
}

.kb-search {
  padding: 6px var(--sp-3);
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text);
}

.kb-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-05);
}

.kb-chip {
  padding: 2px var(--sp-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card);
  color: var(--muted);
  cursor: pointer;
  font-size: 0.78rem;
}

.kb-chip.on {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.kb-list {
  flex: 1;
  margin: 0;
  padding: var(--sp-1);
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  overflow: auto;
  min-height: 120px;
}

.kb-empty {
  padding: var(--sp-3) var(--sp-2);
  color: var(--muted);
  font-size: 0.84rem;
}

.kb-item {
  display: flex;
  flex-direction: column;
  gap: var(--sp-0);
  width: 100%;
  padding: var(--sp-2);
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.kb-item:hover {
  background: var(--soft);
}

.kb-item.on {
  background: var(--primary-soft);
}

.kb-item-title {
  font-weight: 600;
  font-size: 0.86rem;
  word-break: break-word;
}

.kb-item-tags {
  color: var(--primary);
  font-size: 0.74rem;
}

.kb-item-excerpt {
  color: var(--muted);
  font-size: 0.78rem;
  line-height: 1.5;
  word-break: break-word;
}

.kb-side-foot {
  display: flex;
  gap: var(--sp-2);
}

/* 浏览器端的文件输入只做触发器，不进布局（桌面端由原生对话框承担） */
.kb-file {
  display: none;
}

.kb-main {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
}

.kb-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.kb-title {
  flex: 1;
  padding: 6px var(--sp-3);
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text);
  font-size: 1rem;
  font-weight: 600;
}

.kb-field {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: 0.84rem;
  color: var(--muted);
}

.kb-field input {
  flex: 1;
  padding: 5px var(--sp-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text);
}

.kb-editor {
  flex: 1;
  width: 100%;
  min-height: 240px;
  padding: var(--sp-4);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.84rem;
  line-height: 21px;
  resize: none;
}

.kb-meta {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-3);
  color: var(--muted);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}

.kb-hint,
.kb-welcome {
  margin: 0;
  color: var(--muted);
  font-size: 0.78rem;
  line-height: 1.6;
}

.kb-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-05);
  padding: 5px var(--sp-3);
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text);
  cursor: pointer;
  font-size: 0.85rem;
}

.kb-btn:hover {
  border-color: var(--primary);
}

.kb-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.kb-btn.primary {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.kb-btn.danger {
  color: var(--danger);
}
</style>
