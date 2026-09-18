<script setup>
// 记录页（手机端）：速记 / 问题两个分段，列表 + 搜索 + 全屏编辑表单。
//
// 关键点：数据全程走**桌面端同一个** `repository`（平台层分发到 IndexedDB 或安卓桥），
// 所以这一页同时是「数据层真的平台无关」的验证——写一条速记后，桌面端/网页端读的是同一套语义。
// 逻辑判断都在 records.js 的纯函数里（已单测），这里只负责渲染与调用。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { create, load as loadKind, onDataChanged, remove, update } from "@/src/data/repository.js";
import { RECORD_KINDS, filterByStatus, filterRecords, recordSummary, sortRecords, toPayload } from "./records.js";

const { t } = useI18n();

const kind = ref("snippets"); // snippets | problems
const keyword = ref("");
const status = ref("open"); // 仅问题分段使用
const raw = ref([]);
const loading = ref(true);
const error = ref("");

const form = reactive({ open: false, id: "", title: "", category: "", content: "", note: "", status: "open" });
const confirmState = reactive({ open: false, id: "" });

const meta = computed(() => RECORD_KINDS[kind.value]);

const records = computed(() => {
  const filtered = kind.value === "problems" ? filterByStatus(raw.value, status.value) : raw.value;
  return sortRecords(filterRecords(filtered, keyword.value));
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    // 刻意用 load() 而不是 list()：list() 带 TTL 缓存（那是给 Agent 单次运行内连续读用的），
    // 写完立刻刷新会读到旧值——实测「新建后列表不出现、删除后条目还在」就是这么来的。
    // 过滤与排序放在本页的纯函数里（见 records.js），因此不需要 list() 的查询能力。
    const records = await loadKind(kind.value);
    raw.value = Array.isArray(records) ? records : [];
  } catch (e) {
    error.value = e?.message || String(e);
    raw.value = [];
  } finally {
    loading.value = false;
  }
}

// 切换分段/状态时重新取数；关键词只在本地过滤（不重复读盘）
watch([kind, status], load, { immediate: false });

// 其他窗口/Agent 写入后自动刷新（与桌面视图同一套通知机制）
let unsubscribe = null;
onMounted(async () => {
  await load();
  unsubscribe = onDataChanged(({ kind: changed, source }) => {
    if (changed === kind.value && source !== "view") load();
  });
});
onBeforeUnmount(() => unsubscribe?.());

function openCreate() {
  Object.assign(form, { open: true, id: "", title: "", category: "", content: "", note: "", status: "open" });
}

function openEdit(record) {
  Object.assign(form, {
    open: true,
    id: record.id,
    title: record.title || "",
    category: record.category || "",
    content: record.content || "",
    note: record.note || "",
    status: record.status || "open",
  });
}

function closeForm() {
  form.open = false;
}

async function save() {
  const payload =
    kind.value === "snippets"
      ? toPayload("snippets", { title: form.title, category: form.category, content: form.content })
      : toPayload("problems", { title: form.title, note: form.note, status: form.status });
  if (!payload) {
    error.value = t("snippet.saveRequire");
    return;
  }
  try {
    if (form.id) await update(kind.value, form.id, payload);
    else await create(kind.value, payload);
    form.open = false;
    error.value = "";
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

function askRemove(record) {
  confirmState.open = true;
  confirmState.id = record.id;
}

async function confirmRemove() {
  const id = confirmState.id;
  confirmState.open = false;
  confirmState.id = "";
  if (!id) return;
  try {
    await remove(kind.value, id);
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

async function togglePin(record) {
  if (kind.value !== "snippets") return;
  try {
    await update("snippets", record.id, { pinned: !record.pinned });
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}
</script>

<template>
  <section class="m-records" :data-kind="kind">
    <!-- 分段：速记 / 问题 -->
    <div class="m-seg" role="tablist">
      <button
        v-for="item in Object.values(RECORD_KINDS)"
        :key="item.key"
        class="m-seg-btn"
        role="tab"
        :aria-selected="kind === item.key"
        :class="{ on: kind === item.key }"
        @click="kind = item.key"
      >
        {{ t(item.labelKey) }}
      </button>
    </div>

    <div class="m-tools">
      <input v-model="keyword" class="m-search" type="search" :placeholder="t(meta.searchKey)" />
      <button class="m-add" :title="t('snippet.create')" @click="openCreate">＋</button>
    </div>

    <!-- 问题分段才有状态过滤 -->
    <div v-if="kind === 'problems'" class="m-chips">
      <button
        v-for="item in [
          { key: 'open', labelKey: 'problem.filterOpen' },
          { key: 'done', labelKey: 'problem.filterDone' },
          { key: 'all', labelKey: 'problem.filterAll' },
        ]"
        :key="item.key"
        class="m-chip"
        :class="{ on: status === item.key }"
        @click="status = item.key"
      >
        {{ t(item.labelKey) }}
      </button>
    </div>

    <p v-if="error" class="m-err">{{ error }}</p>

    <p v-if="loading" class="m-empty">{{ t("common.loading") }}</p>
    <div v-else-if="!records.length" class="m-empty-box">
      <p class="m-empty-title">{{ t(meta.emptyKey) }}</p>
      <button class="m-empty-btn" @click="openCreate">{{ t("snippet.emptyCreate") }}</button>
    </div>

    <ul v-else class="m-list">
      <li v-for="record in records" :key="record.id" class="m-item">
        <button class="m-item-main" @click="openEdit(record)">
          <span class="m-item-title">
            <span v-if="record.pinned" class="m-pin" aria-hidden="true">★</span>
            {{ record.title || t("snippet.untitled") }}
          </span>
          <span v-if="recordSummary(record)" class="m-item-sub">{{ recordSummary(record) }}</span>
          <span v-if="record.tags?.length" class="m-item-tags">{{ record.tags.join(" · ") }}</span>
        </button>
        <div class="m-item-ops">
          <button v-if="kind === 'snippets'" class="m-op" :class="{ on: record.pinned }" @click="togglePin(record)">
            {{ record.pinned ? t("snippet.unpin") : t("snippet.pin") }}
          </button>
          <button class="m-op danger" @click="askRemove(record)">{{ t("snippet.delete") }}</button>
        </div>
      </li>
    </ul>

    <!-- 全屏编辑表单：手机上没有多窗口，编辑就是整屏 -->
    <div v-if="form.open" class="m-sheet">
      <header class="m-sheet-head">
        <button class="m-sheet-cancel" @click="closeForm">{{ t("common.cancel") }}</button>
        <b>{{ t(form.id ? (kind === 'snippets' ? "snippet.formEditTitle" : "problem.formEditTitle") : kind === 'snippets' ? "snippet.formCreateTitle" : "problem.formCreateTitle") }}</b>
        <button class="m-sheet-save" @click="save">{{ t("snippet.saveBtn") }}</button>
      </header>
      <div class="m-sheet-body">
        <label class="m-field">
          <span>{{ t(kind === "snippets" ? "snippet.formTitle" : "problem.formTitle") }}</span>
          <input v-model="form.title" :placeholder="t(kind === 'snippets' ? 'snippet.formTitlePh' : 'problem.formTitlePh')" />
        </label>
        <label v-if="kind === 'snippets'" class="m-field">
          <span>{{ t("snippet.formCategory") }}</span>
          <input v-model="form.category" :placeholder="t('snippet.formCategoryPh')" />
        </label>
        <label class="m-field">
          <span>{{ t(kind === "snippets" ? "snippet.formContent" : "problem.formNote") }}</span>
          <!-- v-model 不支持动态目标（不能写 a ? x : y），这里按分段显式绑定 -->
          <textarea
            v-if="kind === 'snippets'"
            v-model="form.content"
            rows="8"
            :placeholder="t('snippet.formContentPh')"
          ></textarea>
          <textarea v-else v-model="form.note" rows="8" :placeholder="t('problem.formNotePh')"></textarea>
        </label>
        <label v-if="kind === 'problems'" class="m-field">
          <span>{{ t("problem.formStatus") }}</span>
          <select v-model="form.status">
            <option value="open">{{ t("problem.filterOpen") }}</option>
            <option value="done">{{ t("problem.filterDone") }}</option>
          </select>
        </label>
      </div>
    </div>

    <!-- 删除确认：手机上没有原生确认框，用应用内弹层（也便于自动化测试） -->
    <div v-if="confirmState.open" class="m-modal">
      <div class="m-modal-card">
        <b>{{ t("snippet.deleteTitle") }}</b>
        <p>{{ t("snippet.deleteMsg") }}</p>
        <div class="m-modal-ops">
          <button class="m-modal-cancel" @click="confirmState.open = false">{{ t("common.cancel") }}</button>
          <button class="m-modal-ok" @click="confirmRemove">{{ t("snippet.deleteOk") }}</button>
        </div>
      </div>
    </div>
  </section>
</template>
