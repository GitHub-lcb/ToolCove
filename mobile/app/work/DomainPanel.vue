<script setup>
// 领域（手机端）：领域列表 → 领域下的 Pool（代码仓库）列表。
//
// 与桌面端 DomainView 的关系：**数据模型与纯逻辑完全一致**（domains / pools 两个集合，
// 字段 id/name/note/path），但**交互按手机重排**：
//   · 桌面端是「左列表 + 右详情」双栏 + 多窗口；手机上是两层钻取（领域 → Pool）。
//   · 桌面端的 git pull、AI 识图、批量导入是桌面工作流（要有本地仓库路径、要贴截图）；
//     手机端**不做**——安卓上没有本地仓库，贴图识别的入口在工具箱的 AI 对话里。
//     这不是偷懒：把桌面专属操作搬过来只会得到点了就报错的按钮。
//
// 刻意保留的能力：领域的增删改、Pool 的增删改（含 path 备注字段，纯文本，不碰文件系统）。
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { load as loadKind, mutate, onDataChanged } from "../../../src/data/repository.js";

const { t } = useI18n();

const domains = ref([]);
const pools = ref([]);
const loading = ref(true);
const error = ref("");
const notice = ref("");
const view = reactive({ level: "list", domainId: "" }); // list | domain

const domainForm = reactive({ open: false, id: "", name: "", note: "" });
const poolForm = reactive({ open: false, id: "", name: "", note: "", path: "" });
const confirmState = reactive({ open: false, kind: "", id: "", name: "" });

async function load() {
  error.value = "";
  try {
    const [domainList, poolList] = await Promise.all([loadKind("domains"), loadKind("pools")]);
    domains.value = Array.isArray(domainList) ? domainList : [];
    pools.value = Array.isArray(poolList) ? poolList : [];
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

let offChanged = null;
onMounted(() => {
  load();
  // 忽略 source === "view"：那是本页自己写的，否则会形成"改 → 刷新 → 改"的循环
  offChanged = onDataChanged(({ source }) => {
    if (source !== "view") load();
  });
});
onUnmounted(() => offChanged?.());

const currentDomain = computed(() => domains.value.find((item) => item.id === view.domainId) || null);

/** 每个领域下的 Pool 数量（列表上要显示，否则不知道点进去有什么）。 */
function poolCount(domainId) {
  return pools.value.filter((pool) => pool.domainId === domainId).length;
}

const currentPools = computed(() =>
  pools.value
    .filter((pool) => pool.domainId === view.domainId)
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
);

function openDomain(domain) {
  view.level = "domain";
  view.domainId = domain.id;
}

/** 返回上一层；已到顶层返回 false，交给安卓侧决定是否退出应用。 */
function goBack() {
  if (view.level === "domain") {
    view.level = "list";
    view.domainId = "";
    return true;
  }
  return false;
}
defineExpose({ goBack });

// ---------- 领域增删改 ----------
function openDomainCreate() {
  Object.assign(domainForm, { open: true, id: "", name: "", note: "" });
}
function openDomainEdit(domain) {
  Object.assign(domainForm, { open: true, id: domain.id, name: domain.name, note: domain.note || "" });
}

async function saveDomain() {
  const name = domainForm.name.trim();
  if (!name) {
    error.value = t("mobile.domainNeedName");
    return;
  }
  error.value = "";
  try {
    if (domainForm.id) {
      await mutate("domains", (list) => list.map((item) => (item.id === domainForm.id ? { ...item, name, note: domainForm.note.trim(), updatedAt: Date.now() } : item)), { source: "view" });
    } else {
      await mutate("domains", (list) => [...list, { id: crypto.randomUUID(), name, note: domainForm.note.trim(), createdAt: Date.now(), updatedAt: Date.now() }], { source: "view" });
    }
    domainForm.open = false;
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

function askRemoveDomain(domain) {
  Object.assign(confirmState, { open: true, kind: "domain", id: domain.id, name: domain.name });
}

async function doRemove() {
  const { kind, id } = confirmState;
  confirmState.open = false;
  error.value = "";
  try {
    if (kind === "domain") {
      // 删领域要连它的 Pool 一起删：留下孤儿 Pool 在界面上再也看不到，等于数据丢失
      await mutate("domains", (list) => list.filter((item) => item.id !== id), { source: "view" });
      await mutate("pools", (list) => list.filter((item) => item.domainId !== id), { source: "view" });
      if (view.domainId === id) {
        view.level = "list";
        view.domainId = "";
      }
      notice.value = t("mobile.domainRemoved");
    } else {
      await mutate("pools", (list) => list.filter((item) => item.id !== id), { source: "view" });
      notice.value = t("mobile.poolRemoved");
    }
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

// ---------- Pool 增删改 ----------
function openPoolCreate() {
  Object.assign(poolForm, { open: true, id: "", name: "", note: "", path: "" });
}
function openPoolEdit(pool) {
  Object.assign(poolForm, { open: true, id: pool.id, name: pool.name, note: pool.note || "", path: pool.path || "" });
}

async function savePool() {
  const name = poolForm.name.trim();
  if (!name) {
    error.value = t("mobile.poolNeedName");
    return;
  }
  error.value = "";
  try {
    if (poolForm.id) {
      await mutate("pools", (list) => list.map((item) => (item.id === poolForm.id ? { ...item, name, note: poolForm.note.trim(), path: poolForm.path.trim(), updatedAt: Date.now() } : item)), { source: "view" });
    } else {
      await mutate("pools", (list) => [...list, { id: crypto.randomUUID(), domainId: view.domainId, name, note: poolForm.note.trim(), path: poolForm.path.trim(), createdAt: Date.now(), updatedAt: Date.now() }], { source: "view" });
    }
    poolForm.open = false;
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}
</script>

<template>
  <section class="m-domain" :data-level="view.level">
    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
    <p v-if="loading" class="m-empty">{{ t("common.loading") }}</p>

    <template v-else>
      <!-- 第一层：领域列表 -->
      <template v-if="view.level === 'list'">
        <div class="m-tools">
          <h2 class="m-h2">{{ t("nav.domain") }}</h2>
          <button class="m-add" :title="t('mobile.domainAdd')" data-role="add-domain" @click="openDomainCreate">＋</button>
        </div>

        <div v-if="!domains.length" class="m-empty-box">
          <p class="m-empty-title">{{ t("mobile.domainEmpty") }}</p>
          <button class="m-empty-btn" data-role="empty-add-domain" @click="openDomainCreate">{{ t("mobile.domainAdd") }}</button>
        </div>

        <ul v-else class="m-list" data-role="domains">
          <li v-for="domain in domains" :key="domain.id" class="m-item" :data-domain="domain.id">
            <button class="m-item-main" data-role="domain-name" @click="openDomain(domain)">
              <span class="m-item-title">{{ domain.name }}</span>
              <span class="m-item-sub">{{ t("mobile.domainPoolCount", { n: poolCount(domain.id) }) }}<template v-if="domain.note"> · {{ domain.note }}</template></span>
            </button>
            <div class="m-item-ops">
              <button class="m-op" data-role="edit-domain" @click="openDomainEdit(domain)">{{ t("common.edit") }}</button>
              <button class="m-op danger" data-role="remove-domain" @click="askRemoveDomain(domain)">{{ t("common.delete") }}</button>
            </div>
          </li>
        </ul>
      </template>

      <!-- 第二层：领域下的 Pool -->
      <template v-else>
        <div class="m-tools">
          <button class="m-back" data-role="back" @click="goBack()">‹</button>
          <h2 class="m-h2">{{ currentDomain?.name }}</h2>
          <button class="m-add" :title="t('mobile.poolAdd')" data-role="add-pool" @click="openPoolCreate">＋</button>
        </div>

        <p v-if="!currentPools.length" class="m-hint-sm" data-role="no-pools">{{ t("mobile.poolEmpty") }}</p>
        <ul v-else class="m-list" data-role="pools">
          <li v-for="pool in currentPools" :key="pool.id" class="m-item" :data-pool="pool.id">
            <div class="m-item-main">
              <span class="m-item-title">{{ pool.name }}</span>
              <span v-if="pool.note || pool.path" class="m-item-sub">{{ pool.note || pool.path }}</span>
            </div>
            <div class="m-item-ops">
              <button class="m-op" data-role="edit-pool" @click="openPoolEdit(pool)">{{ t("common.edit") }}</button>
              <button class="m-op danger" data-role="remove-pool" @click="Object.assign(confirmState, { open: true, kind: 'pool', id: pool.id, name: pool.name })">{{ t("common.delete") }}</button>
            </div>
          </li>
        </ul>
      </template>
    </template>

    <!-- 领域表单 -->
    <div v-if="domainForm.open" class="m-sheet" data-role="domain-form">
      <header class="m-sheet-head">
        <button class="m-sheet-cancel" @click="domainForm.open = false">{{ t("common.cancel") }}</button>
        <b>{{ domainForm.id ? t("common.edit") : t("mobile.domainAdd") }}</b>
        <button class="m-sheet-save" data-role="save-domain" @click="saveDomain">{{ t("common.confirm") }}</button>
      </header>
      <div class="m-sheet-body">
        <label class="m-field">
          <span>{{ t("mobile.domainName") }}</span>
          <input v-model="domainForm.name" data-role="domain-name-input" />
        </label>
        <label class="m-field">
          <span>{{ t("mobile.domainNote") }}</span>
          <textarea v-model="domainForm.note" rows="3" data-role="domain-note-input"></textarea>
        </label>
      </div>
    </div>

    <!-- Pool 表单 -->
    <div v-if="poolForm.open" class="m-sheet" data-role="pool-form">
      <header class="m-sheet-head">
        <button class="m-sheet-cancel" @click="poolForm.open = false">{{ t("common.cancel") }}</button>
        <b>{{ poolForm.id ? t("common.edit") : t("mobile.poolAdd") }}</b>
        <button class="m-sheet-save" data-role="save-pool" @click="savePool">{{ t("common.confirm") }}</button>
      </header>
      <div class="m-sheet-body">
        <label class="m-field">
          <span>{{ t("mobile.poolName") }}</span>
          <input v-model="poolForm.name" data-role="pool-name-input" placeholder="warehouse.wms.outward.api" />
        </label>
        <label class="m-field">
          <span>{{ t("mobile.poolNote") }}</span>
          <textarea v-model="poolForm.note" rows="2" data-role="pool-note-input"></textarea>
        </label>
        <label class="m-field">
          <span>{{ t("mobile.poolPath") }}</span>
          <input v-model="poolForm.path" data-role="pool-path-input" placeholder="C:\\code\\…" />
        </label>
        <p class="m-hint-sm">{{ t("mobile.poolPathNote") }}</p>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="confirmState.open" class="m-modal" data-role="confirm">
      <div class="m-modal-card">
        <b>{{ t("common.delete") }}</b>
        <p>{{ confirmState.kind === "domain" ? t("mobile.domainRemoveMsg", { name: confirmState.name }) : t("mobile.poolRemoveMsg", { name: confirmState.name }) }}</p>
        <div class="m-modal-ops">
          <button class="m-modal-cancel" data-role="confirm-cancel" @click="confirmState.open = false">{{ t("common.cancel") }}</button>
          <button class="m-modal-ok" data-role="confirm-ok" @click="doRemove">{{ t("common.confirm") }}</button>
        </div>
      </div>
    </div>

    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
  </section>
</template>
