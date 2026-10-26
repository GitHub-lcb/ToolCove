<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { capabilities } from "../platform/env.js";
import { mergeRecords, mutate, onDataChanged } from "../data/repository.js";
import { open } from "../platform/dialog.js";
import Icon from "../ui/Icon.vue";
import { askConfirm } from "../ui/confirm.js";
import AiExtract from "./AiExtract.vue";
import PoolPublish from "./PoolPublish.vue";
import { releaseBadge } from "../publishState.js";
import { errText } from "../shared/errors.js";
import { DOMAIN_COLORS } from "../shared/workMeta.js";
import { vDialog } from '../ui/dialog.js'; // 模板里的 v-dialog 由 <script setup> 就地解析（SSR 渲染测试也能用）

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});

const { t } = useI18n();

// 领域配色（循环取用，定义在 src/shared/workMeta.js：只用中性主色与领域色板，不混入 danger/success 语义色）
// 令牌 → 基准 hex（hueShiftOf 解析 var() 引用用）。**这份抄写由 uiSpec.test.js 逐条比对 tokens.css 的浅色值**：
// 之前它靠注释提醒人同步，实测 --amber 已经漂了一个色相（抄的是 #d97706，令牌早就是 #9a6700），
// 表现是琥珀色领域的徽章底色 hue 与它的色点不一致——不报错、不红灯，只是看着不对。
const TOKEN_HEX = {
  "--primary": "#0969da",
  "--teal": "#0d9488",
  "--primary-hover": "#0550ae",
  // 历史领域色可能存的是退役令牌引用，保留映射（值已同步为主色蓝系）
  "--accent-hover": "#0550ae",
  "--amber": "#9a6700",
  "--fuchsia": "#db2777",
  "--green": "#10b981",
  "--orange": "#f97316",
  "--sky": "#0ea5e9",
};

const domains = ref([]);
const pools = ref([]);
const currentId = ref(null); // 进入的领域详情
const search = ref("");

const showDomainForm = ref(false);
const domainForm = ref({ id: "", name: "", note: "" });

const showPoolForm = ref(false);
const poolForm = ref({ id: "", domainId: "", name: "", note: "", path: "" });

const showBatch = ref(false);
const batchText = ref("");

const showImport = ref(false);
const legacyProjects = ref([]);
const importSel = ref({});
const pulling = ref({}); // poolId -> bool（拉取中）
const pullingAll = ref(false);
const publishPool = ref(null); // 正在发布的 Pool（非空时弹发布弹窗）
const badgeOf = (p) => releaseBadge(p); // 角标按本地发布记录（lastRelease）推导
// 发布按钮 title：按角标状态取文案，无记录即「发布（记录本地发布步骤）」
const BADGE_TITLE_KEYS = { deploying: "domain.publishDoing", success: "domain.publishDone", failed: "domain.publishFail" };
function badgeTitle(p) {
  const key = BADGE_TITLE_KEYS[badgeOf(p)];
  return key ? t(key) : t("domain.publishIdle");
}

// ------- 加载 / 保存 -------
// 上次读盘见过的 id（按 key 分开记）：用来区分「用户在这页删掉的行」和
// 「别人在我们读盘之后新增的行」——前者要丢掉，后者要留下。
const seenIds = { domains: new Set(), pools: new Set() };

function idsOf(list) {
  return new Set((list || []).map((r) => r && r.id));
}

async function load() {
  try {
    domains.value = (await invoke("load_data", { key: "domains" })) || [];
    seenIds.domains = idsOf(domains.value);
  } catch (e) {
    props.showToast(t("domain.loadFailed", { err: errText(e) }));
  }
  try {
    pools.value = (await invoke("load_data", { key: "pools" })) || [];
    seenIds.pools = idsOf(pools.value);
  } catch (e) {
    props.showToast(t("domain.poolLoadFailed", { err: errText(e) }));
  }
}

// 整表裸写会把这段时间里别人（Agent 的 data.*、另一台设备同步下来）新增的行抹掉，
// 所以改走数据层：读磁盘最新 → 带修订号写回（CAS）→ 按 id 合并而非覆盖。
// 只合并还不够：合并会把用户在这页删掉的行从磁盘快照里复活，所以按 seenIds 丢掉真删除。
async function persistTable(kind, listRef) {
  try {
    listRef.value = await mutate(
      kind,
      (fresh) => {
        const keep = idsOf(listRef.value);
        return mergeRecords(fresh, listRef.value).filter((r) => keep.has(r?.id) || !seenIds[kind].has(r?.id));
      },
      { source: "view" }
    );
    seenIds[kind] = idsOf(listRef.value);
  } catch (e) {
    props.showToast(t("domain.saveFailed", { err: errText(e) }));
  }
}
const persistDomains = () => persistTable("domains", domains);
const persistPools = () => persistTable("pools", pools);
let offDataChanged = null;
onMounted(async () => {
  await load();
  tryJump();
  // 别的写入者改了领域/Pool 时重新读盘，页面里留着的旧快照才不会写脏
  offDataChanged = onDataChanged(async ({ kind, source }) => {
    if (source === "view") return;
    if (kind !== "domains" && kind !== "pools") return;
    await load();
  });
});
onUnmounted(() => offDataChanged?.());
// 配置类弹窗：禁点遮罩关闭，仅 Esc 可关（表单较长，防误触丢输入）
function onEsc(e) {
  if (e.key !== "Escape") return;
  if (showDomainForm.value) showDomainForm.value = false;
  else if (showPoolForm.value) showPoolForm.value = false;
  else if (showBatch.value) showBatch.value = false;
  else if (showImport.value) showImport.value = false;
}
onMounted(() => window.addEventListener("keydown", onEsc));
onUnmounted(() => window.removeEventListener("keydown", onEsc));

// ------- 全局搜索深链 -------
function tryJump() {
  const j = props.jumpId;
  if (!j || !j.id) return;
  if (domains.value.some((d) => d.id === j.id)) currentId.value = j.id;
}
watch(() => props.jumpId, tryJump);

// ------- 派生 -------
const current = computed(() => domains.value.find((d) => d.id === currentId.value) || null);
function poolCount(did) {
  return pools.value.filter((p) => p.domainId === did).length;
}
function colorOf(d, idx) {
  return d.color || DOMAIN_COLORS[idx % DOMAIN_COLORS.length];
}
// 领域标徽用 mod-domain 素材（基准蓝色），按领域主题色做色相旋转保留配色识别
const MOD_DOMAIN_HUE = 217;
function hueShiftOf(color) {
  const hex = TOKEN_HEX[color] || (color || "").trim();
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round(h * 60) - MOD_DOMAIN_HUE;
}
const filteredDomains = computed(() => {
  const kw = search.value.trim().toLowerCase();
  return [...domains.value]
    .filter((d) => !kw || d.name.toLowerCase().includes(kw) || (d.note || "").toLowerCase().includes(kw))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
});
const currentPools = computed(() => {
  if (!current.value) return [];
  const kw = search.value.trim().toLowerCase();
  return pools.value
    .filter((p) => p.domainId === currentId.value)
    .filter((p) => !kw || p.name.toLowerCase().includes(kw) || (p.note || "").toLowerCase().includes(kw))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
});

// ------- 领域 CRUD -------
function openDomainCreate() {
  domainForm.value = { id: "", name: "", note: "" };
  showDomainForm.value = true;
}
function openDomainEdit(d) {
  domainForm.value = { id: d.id, name: d.name, note: d.note || "" };
  showDomainForm.value = true;
}
async function saveDomain() {
  const f = domainForm.value;
  if (!f.name.trim()) return props.showToast(t("domain.needName"));
  const now = Date.now();
  const existing = f.id ? domains.value.find((d) => d.id === f.id) : null;
  if (existing) {
    Object.assign(existing, { name: f.name.trim(), note: f.note.trim(), updatedAt: now });
  } else {
    domains.value.push({ id: crypto.randomUUID(), name: f.name.trim(), note: f.note.trim(), createdAt: now, updatedAt: now });
  }
  await persistDomains();
  showDomainForm.value = false;
  props.showToast(existing ? t("domain.updated") : t("domain.created"));
}
async function removeDomain(d) {
  const n = poolCount(d.id);
  const ok = await askConfirm({
    title: t("domain.deleteTitle"),
    message: n
      ? t("domain.deleteWithPools", { name: d.name, count: n })
      : t("domain.deleteMsg", { name: d.name }),
    okText: t("common.delete"),
  });
  if (!ok) return;
  const idx = domains.value.findIndex((x) => x.id === d.id);
  const removedPools = pools.value.filter((p) => p.domainId === d.id);
  domains.value = domains.value.filter((x) => x.id !== d.id);
  pools.value = pools.value.filter((p) => p.domainId !== d.id);
  if (currentId.value === d.id) currentId.value = null;
  await persistDomains();
  await persistPools();
  props.showToast(t("domain.deleted"), {
    actionLabel: t("domain.undo"),
    onAction: async () => {
      domains.value.splice(Math.min(Math.max(idx, 0), domains.value.length), 0, d);
      pools.value.push(...removedPools);
      await persistDomains();
      await persistPools();
      props.showToast(t("domain.restored"));
    },
  });
}

// ------- 进入 / 退出领域 -------
function enter(d) {
  currentId.value = d.id;
  search.value = "";
}
function exit() {
  currentId.value = null;
  search.value = "";
}

// ------- Pool CRUD -------
function openPoolCreate() {
  poolForm.value = { id: "", domainId: currentId.value, name: "", note: "", path: "" };
  showPoolForm.value = true;
}

// AI 识图字段定义（computed：语言切换后重新求值）
const AI_FIELDS = computed(() => [
  { key: "name", label: t("domain.aiFieldName"), desc: t("domain.aiFieldNameDesc") },
  { key: "note", label: t("domain.aiFieldNote"), desc: t("domain.aiFieldNoteDesc"), multiline: true },
]);
async function createPoolsFromAI(list) {
  const rows = Array.isArray(list) ? list : [list];
  const now = Date.now();
  const existNames = new Set(pools.value.filter((p) => p.domainId === currentId.value).map((p) => p.name));
  let added = 0;
  for (const r of rows) {
    const name = (r.name || "").trim();
    if (!name || existNames.has(name)) continue;
    existNames.add(name);
    pools.value.push({ id: crypto.randomUUID(), domainId: currentId.value, name, note: (r.note || "").trim(), path: "", createdAt: now, updatedAt: now });
    added++;
  }
  await persistPools();
  props.showToast(added ? t("domain.aiAdded", { count: added }) : t("domain.aiNothing"));
}
function openPoolEdit(p) {
  poolForm.value = { id: p.id, domainId: p.domainId, name: p.name, note: p.note || "", path: p.path || "" };
  showPoolForm.value = true;
}
async function savePool() {
  const f = poolForm.value;
  if (!f.name.trim()) return props.showToast(t("domain.poolNeedName"));
  const now = Date.now();
  const existing = f.id ? pools.value.find((p) => p.id === f.id) : null;
  if (existing) {
    Object.assign(existing, { name: f.name.trim(), note: f.note.trim(), path: (f.path || "").trim(), updatedAt: now });
  } else {
    pools.value.push({ id: crypto.randomUUID(), domainId: f.domainId || currentId.value, name: f.name.trim(), note: f.note.trim(), path: (f.path || "").trim(), createdAt: now, updatedAt: now });
  }
  await persistPools();
  showPoolForm.value = false;
  props.showToast(existing ? t("domain.poolUpdated") : t("domain.poolAdded"));
}
async function removePool(p) {
  const ok = await askConfirm({
    title: t("domain.poolDeleteTitle"),
    message: t("domain.poolDeleteMsg", { name: p.name }),
    okText: t("common.delete"),
  });
  if (!ok) return;
  const idx = pools.value.findIndex((x) => x.id === p.id);
  pools.value = pools.value.filter((x) => x.id !== p.id);
  await persistPools();
  props.showToast(t("domain.poolDeleted"), {
    actionLabel: t("domain.undo"),
    onAction: async () => {
      pools.value.splice(Math.min(Math.max(idx, 0), pools.value.length), 0, p);
      await persistPools();
      props.showToast(t("domain.restored"));
    },
  });
}
const copiedPoolId = ref(null); // 刚复制的 Pool id（瞬态打勾）
let copiedPoolTimer = null;
async function copyPool(p) {
  try {
    await navigator.clipboard.writeText(p.name);
    copiedPoolId.value = p.id;
    clearTimeout(copiedPoolTimer);
    copiedPoolTimer = setTimeout(() => (copiedPoolId.value = null), 1500);
    props.showToast(t("domain.copied", { name: p.name }));
  } catch (e) {
    props.showToast(t("domain.copyFailed", { err: errText(e) }));
  }
}

// ------- 本地项目路径 / 拉取最新代码 -------
async function pickPath(p) {
  try {
    const dir = await open({ directory: true, title: t("domain.pickPathTitle", { name: p.name }) });
    if (!dir) return;
    const target = pools.value.find((x) => x.id === p.id);
    if (target) target.path = dir;
    await persistPools();
    props.showToast(t("domain.pathSet"));
  } catch (e) {
    props.showToast(t("domain.pathSetFailed", { err: errText(e) }));
  }
}
async function pickFormPath() {
  try {
    const dir = await open({ directory: true, title: t("domain.pickFormPathTitle") });
    if (dir) poolForm.value.path = dir;
  } catch (e) {
    props.showToast(t("domain.pickFailed", { err: errText(e) }));
  }
}
async function pullPool(p) {
  if (!p.path) return props.showToast(t("domain.needPathFirst"));
  if (pulling.value[p.id]) return;
  pulling.value[p.id] = true;
  try {
    const out = await invoke("git_pull", { path: p.path });
    const last = String(out || "").split("\n").filter(Boolean).pop() || t("domain.pullDone");
    props.showToast(t("domain.pullResult", { name: p.name, msg: last }));
  } catch (e) {
    props.showToast(t("domain.pullFailed", { name: p.name, err: errText(e) }));
  } finally {
    pulling.value[p.id] = false;
  }
}
async function pullAll() {
  const targets = currentPools.value.filter((p) => p.path);
  if (!targets.length) return props.showToast(t("domain.pullAllNoPath"));
  if (pullingAll.value) return;
  pullingAll.value = true;
  let ok = 0;
  let fail = 0;
  for (const p of targets) {
    pulling.value[p.id] = true;
    try {
      await invoke("git_pull", { path: p.path });
      ok++;
    } catch (e) {
      fail++;
      props.showToast(t("domain.pullFailed", { name: p.name, err: errText(e) }));
    } finally {
      pulling.value[p.id] = false;
    }
  }
  pullingAll.value = false;
  props.showToast(t("domain.pullAllDone", { ok, fail }));
}

// ------- 发布（本地发布步骤记录） -------
function openPublish(p) {
  publishPool.value = p;
}

// 发布记录已写入 pool.lastRelease：落盘
async function onPublishSaved() {
  await persistPools();
}

// ------- 批量录入 Pool -------
function openBatch() {
  batchText.value = "";
  showBatch.value = true;
}
async function saveBatch() {
  const names = batchText.value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!names.length) return props.showToast(t("domain.batchNeedNames"));
  const now = Date.now();
  const existNames = new Set(pools.value.filter((p) => p.domainId === currentId.value).map((p) => p.name));
  let added = 0;
  for (const name of names) {
    if (existNames.has(name)) continue;
    existNames.add(name);
    pools.value.push({ id: crypto.randomUUID(), domainId: currentId.value, name, note: "", createdAt: now, updatedAt: now });
    added++;
  }
  await persistPools();
  showBatch.value = false;
  props.showToast(added ? t("domain.batchAdded", { count: added }) : t("domain.batchNothing"));
}

// ------- 从旧资料库项目导入为 Pool -------
async function openImport() {
  let items = [];
  try {
    items = (await invoke("load_data", { key: "items" })) || [];
  } catch (e) {
    return props.showToast(t("domain.legacyLoadFailed", { err: errText(e) }));
  }
  const exist = new Set(pools.value.filter((p) => p.domainId === currentId.value).map((p) => p.name));
  legacyProjects.value = items
    .filter((it) => it.type === "project")
    .map((it) => ({ id: it.id, name: it.title, imported: exist.has(it.title) }));
  importSel.value = {};
  legacyProjects.value.forEach((p) => (importSel.value[p.id] = !p.imported));
  if (!legacyProjects.value.length) return props.showToast(t("domain.legacyEmpty"));
  showImport.value = true;
}
async function saveImport() {
  const chosen = legacyProjects.value.filter((p) => importSel.value[p.id]);
  if (!chosen.length) return props.showToast(t("domain.importNeedPick"));
  const now = Date.now();
  const exist = new Set(pools.value.filter((p) => p.domainId === currentId.value).map((p) => p.name));
  let added = 0;
  for (const p of chosen) {
    if (exist.has(p.name)) continue;
    exist.add(p.name);
    pools.value.push({ id: crypto.randomUUID(), domainId: currentId.value, name: p.name, note: "", createdAt: now, updatedAt: now });
    added++;
  }
  await persistPools();
  showImport.value = false;
  props.showToast(added ? t("domain.imported", { count: added }) : t("domain.importNothing"));
}
</script>

<template>
  <!-- ============ 领域详情（管理其下 Pool） ============ -->
  <template v-if="current">
    <div class="detail-bar">
      <button class="back-btn" @click="exit"><Icon name="chevron" :size="16" class="rot90" /> {{ t("domain.backToList") }}</button>
    </div>

    <section class="hero">
      <span class="hero-icon"><Icon name="layers" :size="22" /></span>
      <div class="hero-main">
        <h2>{{ current.name }}</h2>
        <p v-if="current.note" class="hero-note">{{ current.note }}</p>
        <p class="prog-text">
          {{ t("domain.poolCountLong", { count: currentPools.length }) }}
        </p>
      </div>
      <div class="hero-ops">
        <button class="btn-outline" @click="openDomainEdit(current)"><Icon name="edit" :size="15" /> {{ t("domain.edit") }}</button>
        <button class="btn-outline danger" @click="removeDomain(current)"><Icon name="trash" :size="15" /> {{ t("common.delete") }}</button>
      </div>
    </section>

    <div class="toolbar">
      <div class="search-mini">
        <Icon name="search" :size="15" class="s-icon" />
        <input v-model="search" :placeholder="t('domain.poolSearchPh')" />
      </div>
      <div class="tb-right">
        <button v-if="capabilities.git" class="btn-ghost sm" :disabled="pullingAll" @click="pullAll"><Icon name="download" :size="15" :class="{ spin: pullingAll }" /> {{ pullingAll ? t('domain.pulling') : t('domain.pullAll') }}</button>
        <button class="btn-ghost sm" @click="openImport"><Icon name="copy" :size="15" /> {{ t("domain.importLegacy") }}</button>
        <button class="btn-ghost sm" @click="openBatch"><Icon name="copy" :size="15" /> {{ t("domain.batchEntry") }}</button>
        <button class="btn-primary sm" @click="openPoolCreate"><Icon name="plus" :size="15" /> {{ t("domain.poolAdd") }}</button>
                <AiExtract :fields="AI_FIELDS" :multiple="true" dedupe-key="name" :existing="pools.filter((p) => p.domainId === currentId).map((p) => p.name)" :hint="t('domain.extractHint')" :title="t('domain.extractTitle')" :show-toast="showToast" @apply="createPoolsFromAI" />
      </div>
    </div>

    <main class="content">
      <div v-if="currentPools.length" class="pool-list">
        <div v-for="p in currentPools" :key="p.id" class="pool-row">
          <span class="pool-icon"><Icon name="box" :size="16" /></span>
          <div class="pool-main">
            <span class="pool-name" :title="t('domain.clickCopy')" @click="copyPool(p)">{{ p.name }}</span>
            <span v-if="p.note" class="pool-note">{{ p.note }}</span>
            <span v-if="p.path" class="pool-path" :title="p.path"><Icon name="folder" :size="11" /> {{ p.path }}</span>
          </div>
          <div class="pool-ops">
            <button
              class="icon-btn publish"
              :title="badgeTitle(p)"
              @click="openPublish(p)"
            >
              <Icon name="upload" :size="15" />
              <span v-if="badgeOf(p)" class="pub-dot" :class="badgeOf(p)"></span>
            </button>
            <button class="icon-btn" :class="{ done: copiedPoolId === p.id }" :title="copiedPoolId === p.id ? t('domain.copiedTag') : t('domain.copyName')" @click="copyPool(p)"><Icon :name="copiedPoolId === p.id ? 'check' : 'copy'" :size="15" /></button>
            <button v-if="capabilities.git" class="icon-btn" :class="{ spinning: pulling[p.id] }" :disabled="!p.path || pulling[p.id]" :title="p.path ? t('domain.pullTip') : t('domain.needPathTip')" @click="pullPool(p)"><Icon :name="pulling[p.id] ? 'repeat' : 'download'" :size="15" :class="{ spin: pulling[p.id] }" /></button>
            <button v-if="capabilities.localFile" class="icon-btn" :class="{ done: p.path }" :title="p.path ? t('domain.changePathTip') : t('domain.setPathTip')" @click="pickPath(p)"><Icon name="folder" :size="15" /></button>
            <button class="icon-btn" :title="t('common.edit')" @click="openPoolEdit(p)"><Icon name="edit" :size="15" /></button>
            <button class="icon-btn" :title="t('common.delete')" @click="removePool(p)"><Icon name="trash" :size="15" /></button>
          </div>
        </div>
      </div>
      <div v-else class="empty">
          <span class="empty-ico"><Icon name="box" :size="32" /></span>
        <h2>{{ t("domain.poolEmptyTitle") }}</h2>
        <p>{{ t("domain.poolEmptyDesc") }}</p>
        <button class="btn-outline lg" @click="openPoolCreate"><Icon name="plus" :size="16" /> {{ t("domain.poolEmptyCreate") }}</button>
      </div>
    </main>
  </template>

  <!-- ============ 领域列表 ============ -->
  <template v-else>
    <div class="toolbar">
      <div class="tb-left">
        <h3 class="section-title">{{ t("nav.domain") }} · {{ domains.length }}</h3>
        <div class="search-mini">
          <Icon name="search" :size="15" class="s-icon" />
          <input v-model="search" :placeholder="t('domain.searchPh')" />
        </div>
      </div>
      <div class="tb-right">
        <button class="btn-primary sm" @click="openDomainCreate"><Icon name="plus" :size="15" /> {{ t("domain.add") }}</button>
      </div>
    </div>

    <main class="content">
      <div v-if="filteredDomains.length" class="dom-grid">
        <div
          v-for="(d, i) in filteredDomains"
          :key="d.id"
          class="dom-card"
          :style="{ '--dc': colorOf(d, i), animationDelay: i * 0.05 + 's' }"
          @click="enter(d)"
        >
          <div class="dom-ops">
            <button class="op del" :title="t('common.delete')" @click.stop="removeDomain(d)"><Icon name="trash" :size="15" /></button>
            <button class="op" :title="t('common.edit')" @click.stop="openDomainEdit(d)"><Icon name="edit" :size="15" /></button>
          </div>
          <div class="dom-emblem">
            <span class="emblem-tile" :style="{ '--hue': hueShiftOf(colorOf(d, i)) + 'deg' }"><Icon name="layers" :size="18" /></span>
          </div>
          <h4 class="dom-name">{{ d.name }}</h4>
          <p v-if="d.note" class="dom-note">{{ d.note }}</p>
          <div class="dom-foot">
            <span class="pool-chip"><Icon name="box" :size="13" /> {{ t("domain.poolCount", { n: poolCount(d.id) }) }}</span>
            <span class="enter-hint"><Icon name="chevron" :size="16" /></span>
          </div>
        </div>
      </div>
      <div v-else class="empty">
          <span class="empty-ico"><Icon name="layers" :size="32" /></span>
        <h2>{{ t("domain.emptyTitle") }}</h2>
        <p>{{ t("domain.emptyDesc") }}</p>
        <button class="btn-outline lg" @click="openDomainCreate"><Icon name="plus" :size="16" /> {{ t("domain.emptyCreate") }}</button>
      </div>
    </main>
  </template>

  <!-- ============ 领域 新建 / 编辑弹窗 ============ -->
  <div v-if="showDomainForm" class="modal-mask">
    <div class="modal" v-dialog>
      <h2>{{ domainForm.id ? t("domain.edit") : t("domain.add") }}</h2>
      <label class="field">
        <span>{{ t("domain.name") }}</span>
        <input v-model="domainForm.name" :placeholder="t('domain.namePh')" />
      </label>
      <label class="field">
        <span>{{ t("domain.note") }}</span>
        <textarea v-model="domainForm.note" rows="2" :placeholder="t('domain.notePh')"></textarea>
      </label>
      <div class="modal-foot">
        <button class="btn-ghost" @click="showDomainForm = false">{{ t("common.cancel") }}</button>
        <button class="btn-primary" @click="saveDomain">{{ t("domain.save") }}</button>
      </div>
    </div>
  </div>

  <!-- ============ Pool 新建 / 编辑弹窗 ============ -->
  <div v-if="showPoolForm" class="modal-mask">
    <div class="modal" v-dialog>
      <h2>{{ poolForm.id ? t("domain.poolEdit") : t("domain.poolAdd") }}</h2>
      <label class="field">
        <span>{{ t("domain.poolName") }}</span>
        <input v-model="poolForm.name" :placeholder="t('domain.poolNamePh')" />
      </label>
      <label class="field">
        <span>{{ t("domain.poolNote") }}</span>
        <textarea v-model="poolForm.note" rows="2" :placeholder="t('domain.poolNotePh')"></textarea>
      </label>
      <label v-if="capabilities.localFile" class="field">
        <span>{{ t("domain.poolPath") }}</span>
        <div class="path-row">
          <input v-model="poolForm.path" :placeholder="t('domain.poolPathPh')" />
          <button type="button" class="btn-outline sm" @click="pickFormPath"><Icon name="folder" :size="15" /> {{ t("domain.pickFolder") }}</button>
        </div>
      </label>
      <div class="modal-foot">
        <button class="btn-ghost" @click="showPoolForm = false">{{ t("common.cancel") }}</button>
        <button class="btn-primary" @click="savePool">{{ t("domain.save") }}</button>
      </div>
    </div>
  </div>

  <!-- ============ 批量录入 Pool 弹窗 ============ -->
  <div v-if="showBatch" class="modal-mask">
    <div class="modal" v-dialog>
      <h2>{{ t("domain.batchTitle") }}</h2>
      <label class="field">
        <span>{{ t("domain.batchHint") }}</span>
        <textarea v-model="batchText" rows="8" placeholder="warehouse.wms.outward.api&#10;online.base.connector.ui&#10;online.base.connector.service"></textarea>
      </label>
      <div class="modal-foot">
        <button class="btn-ghost" @click="showBatch = false">{{ t("common.cancel") }}</button>
        <button class="btn-primary" @click="saveBatch">{{ t("domain.import") }}</button>
      </div>
    </div>
  </div>

  <!-- ============ 发布弹窗 ============ -->
  <PoolPublish v-if="publishPool" :pool="publishPool" :show-toast="showToast" @close="publishPool = null" @saved="onPublishSaved" />

  <!-- ============ 从旧项目导入弹窗 ============ -->
  <div v-if="showImport" class="modal-mask">
    <div class="modal" v-dialog>
      <h2>{{ t("domain.importTitle") }}</h2>
      <p class="import-tip">{{ t("domain.importTip", { name: current?.name }) }}</p>
      <div class="pick-list">
        <label v-for="p in legacyProjects" :key="p.id" class="pick-row">
          <input type="checkbox" v-model="importSel[p.id]" />
          <span class="pick-name">{{ p.name }}</span>
          <span v-if="p.imported" class="pick-note">{{ t("domain.importExists") }}</span>
        </label>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" @click="showImport = false">{{ t("common.cancel") }}</button>
        <button class="btn-primary" @click="saveImport">{{ t("domain.importSelected") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-bar { padding: var(--sp-5) 28px 0; }
.back-btn { display: inline-flex; align-items: center; gap: var(--sp-1); background: none; border: none; color: var(--muted); font-size: var(--fs-base); cursor: pointer; padding: var(--sp-05) 0; }
.back-btn:hover { color: var(--primary); }
.rot90 { transform: rotate(90deg); }

/* hero */
.hero { display: flex; gap: var(--sp-6); align-items: flex-start; margin: var(--sp-4) 28px 0; padding: var(--sp-7) 22px; background: var(--card); border: 1px solid var(--card-border); border-left: 4px solid var(--primary); border-radius: var(--r-lg); box-shadow: var(--shadow); }
.hero-icon { width: 46px; height: 46px; flex-shrink: 0; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary); display: grid; place-items: center; }
.hero-main { flex: 1; min-width: 0; }
.hero-main h2 { margin: 0 0 var(--sp-1); font-size: var(--fs-xl); }
.hero-note { margin: 0 0 var(--sp-1); color: var(--muted); font-size: var(--fs-md); }
.hero-ops { display: flex; flex-direction: column; gap: var(--sp-2); flex-shrink: 0; }
.prog-text { margin: var(--sp-05) 0 0; font-size: var(--fs-md); color: var(--muted); }

/* toolbar */
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-6) 28px; flex-wrap: wrap; }
.section-title { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
.tb-left { display: flex; align-items: center; gap: var(--sp-6); flex-wrap: wrap; }
.tb-right { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.search-mini { position: relative; display: flex; align-items: center; }
.search-mini .s-icon { position: absolute; left: 10px; color: var(--muted); pointer-events: none; }
.search-mini input { padding: 7px var(--sp-4) 7px 30px; border: 1px solid transparent; border-radius: var(--r-sm); font-size: var(--fs-md); background: color-mix(in srgb, var(--text-weak) 9%, transparent); color: var(--text); outline: none; width: 180px; transition: background 0.15s, border-color 0.15s; }
.search-mini input:focus { background: var(--card); border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }

/* content */
.content { flex: 1; padding: var(--sp-6) 28px 36px; }

/* 领域网格 */
.dom-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(272px, 1fr)); gap: var(--sp-7); }
.dom-card { position: relative; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: var(--sp-7) var(--sp-7) 18px; box-shadow: var(--shadow); cursor: pointer; overflow: hidden; opacity: 0; transform: translateY(14px); animation: cardIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards; transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s, border-color 0.25s; }
@keyframes cardIn { to { opacity: 1; transform: none; } }
.dom-card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--dc, var(--primary)) 35%, var(--card)); box-shadow: 0 14px 34px color-mix(in srgb, var(--dc, var(--primary)) 16%, rgba(35, 43, 66, 0.1)); }
.dom-ops { position: absolute; top: 16px; right: 16px; display: flex; gap: var(--sp-1); opacity: 0; transform: translateY(-4px); transition: opacity 0.15s, transform 0.15s; z-index: 3; }
.dom-card:hover .dom-ops { opacity: 1; transform: none; }
.op { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; border: 1px solid var(--card-border); background: var(--card); border-radius: var(--r-sm); color: var(--muted); cursor: pointer; transition: all 0.15s; }
.op:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }
.op.del:hover { color: var(--danger); border-color: var(--border-danger); background: var(--danger-soft); }

/* 领域标徽（线性图标 + 领域色底，色相由领域色令牌驱动） */
.dom-emblem { width: 54px; height: 54px; margin-bottom: var(--sp-6); }
.emblem-tile { display: grid; place-items: center; width: 100%; height: 100%; border-radius: var(--r-md); background: color-mix(in srgb, var(--dc, var(--primary)) 14%, var(--card)); color: var(--dc, var(--primary)); box-shadow: 0 5px 14px color-mix(in srgb, var(--dc, var(--primary)) 32%, transparent); transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1); }
.dom-card:hover .emblem-tile { transform: translateY(-2px); }

.dom-name { margin: 0 0 var(--sp-1); font-size: var(--fs-lg); font-weight: 700; }
.dom-note { margin: 0 0 var(--sp-5); font-size: var(--fs-sm); color: var(--muted); }
.dom-foot { display: flex; align-items: center; justify-content: space-between; }
.enter-hint { display: grid; place-items: center; color: var(--dc, var(--primary)); opacity: 0; transform: translateX(-6px) rotate(-90deg); transition: opacity 0.2s, transform 0.2s; }
.dom-card:hover .enter-hint { opacity: 1; transform: translateX(0) rotate(-90deg); }
.pool-chip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--text-soft); background: var(--well); padding: 3px var(--sp-3); border-radius: var(--r-pill); }

/* Pool 列表 */
.pool-list { display: flex; flex-direction: column; }
/* 列表平铺：Pool 列表不设容器（背景层），行分隔线分组 */
.pool-row { display: flex; align-items: center; gap: var(--sp-4); padding: var(--sp-4) var(--sp-6); border-bottom: 1px solid var(--border); }
.pool-row:last-child { border-bottom: none; }
.pool-icon { width: 30px; height: 30px; flex-shrink: 0; border-radius: var(--r-sm); background: var(--primary-soft); color: var(--primary); display: grid; place-items: center; }
.pool-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-0); }
.pool-name { font-size: var(--fs-md); font-weight: 600; font-family: var(--font-mono); word-break: break-all; cursor: pointer; transition: color 0.15s; }
.pool-name:hover { color: var(--primary); text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
.pool-note { font-size: var(--fs-sm); color: var(--muted); }
.pool-path { font-size: var(--fs-sm); color: var(--muted); display: inline-flex; align-items: center; gap: var(--sp-05); font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.pool-path :deep(svg) { flex-shrink: 0; }
.path-row { display: flex; gap: var(--sp-2); align-items: center; }
.path-row input { flex: 1; min-width: 0; }
.pool-ops { display: flex; gap: var(--sp-1); flex-shrink: 0; }

/* 按钮（基础样式已全局统一，见 App.vue；这里仅保留领域专属变体） */
.pub-dot { position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border-radius: var(--r-pill); border: 1.5px solid var(--text-invert); }
.pub-dot.deploying { background: var(--amber-bright); animation: pub-pulse 1.2s ease-in-out infinite; }
.pub-dot.success { background: var(--success); }
.pub-dot.failed { background: var(--danger); }
@keyframes pub-pulse { 50% { opacity: 0.35; } }
.icon-btn.done { color: var(--success-deep); border-color: var(--success); background: var(--success-tint); }
.icon-btn.publish:hover { color: var(--amber); border-color: var(--amber); background: var(--amber-soft); }

/* 空状态：底座（居中 / 间距 / 图标圆底 / 文字层级）由 globals.css 的 .empty / .empty-ico 提供，
   这里只留本页特有的 h2 / p 间距——此前 7 个视图各写了一份逐字相同的底座。 */
.empty-ico { margin-bottom: var(--sp-1); }
.empty h2 { font-size: var(--fs-xl); margin: var(--sp-2) 0 var(--sp-1); font-weight: 700; }
.empty p { color: var(--muted); font-size: var(--fs-base); margin: 0 0 22px; max-width: 460px; margin-left: auto; margin-right: auto; }

/* 弹窗（基础样式已全局统一，见 App.vue） */
.modal { width: 500px; }
.field { display: block; margin-bottom: var(--sp-6); }
.field > span { display: block; font-size: var(--fs-md); color: var(--muted); margin-bottom: 7px; font-weight: 600; }
.field input, .field textarea { width: 100%; padding: var(--sp-3) 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; resize: vertical; background: var(--card); color: var(--text); transition: border-color 0.15s, box-shadow 0.15s; }
.field input:focus, .field textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.import-tip { margin: -8px 0 var(--sp-4); font-size: var(--fs-md); color: var(--muted); }
.pick-list { max-height: 320px; overflow-y: auto; border: 1px solid var(--border-strong); border-radius: var(--r-sm); margin-bottom: var(--sp-2); }
.pick-row { display: flex; align-items: center; gap: 9px; padding: 9px var(--sp-4); border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s, box-shadow 0.15s; }
.pick-row:hover { background: color-mix(in srgb, var(--primary) 5%, transparent); box-shadow: inset 2px 0 0 var(--primary); }
.pick-row:last-child { border-bottom: none; }
.pick-row input { width: 16px; height: 16px; flex-shrink: 0; accent-color: var(--primary); }
.pick-name { font-size: var(--fs-md); word-break: break-all; }
.pick-note { font-size: var(--fs-sm); color: var(--muted); }

@media (prefers-color-scheme: dark) {
  .dom-card { background: var(--card); border-color: var(--border-strong); }
  .op { background: var(--card-raised); }
  .field input, .field textarea, .search-mini input, .icon-btn { background: var(--card-raised); }
  .icon-btn.done { background: var(--success-soft); color: var(--success-light); border-color: var(--success-light); }
  .icon-btn.publish:hover { background: var(--amber-soft); color: var(--amber-light); border-color: var(--warn); }
  .pub-dot { border-color: var(--card); }
  .pool-chip { background: var(--well); color: var(--text-weak); }
}
</style>
