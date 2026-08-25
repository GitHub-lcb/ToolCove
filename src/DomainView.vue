<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Icon from "./Icon.vue";
import { askConfirm } from "./confirm.js";
import AiExtract from "./AiExtract.vue";
import PoolPublish from "./PoolPublish.vue";
import { releaseBadge } from "./publishState.js";
import { DOMAIN_COLORS } from "./shared.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});

// 领域配色（循环取用，定义在 shared.js：只用中性主色与领域色板，不混入 danger/success 语义色）
// 令牌 → 基准 hex（hueShiftOf 解析 var() 引用用；改令牌值时同步更新这里）
const TOKEN_HEX = {
  "--primary": "#0969da",
  "--teal": "#0d9488",
  "--primary-hover": "#0550ae",
  // 历史领域色可能存的是退役令牌引用，保留映射（值已同步为主色蓝系）
  "--accent-hover": "#0550ae",
  "--amber": "#d97706",
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

// ------- 加载 / 保存 -------
async function load() {
  try {
    domains.value = (await invoke("load_data", { key: "domains" })) || [];
  } catch (e) {
    props.showToast("加载领域失败：" + e);
  }
  try {
    pools.value = (await invoke("load_data", { key: "pools" })) || [];
  } catch (e) {
    props.showToast("加载 Pool 失败：" + e);
  }
}
async function persistDomains() {
  try {
    await invoke("save_data", { key: "domains", data: domains.value });
  } catch (e) {
    props.showToast("保存失败：" + e);
  }
}
async function persistPools() {
  try {
    await invoke("save_data", { key: "pools", data: pools.value });
  } catch (e) {
    props.showToast("保存失败：" + e);
  }
}
onMounted(async () => {
  await load();
  tryJump();
});
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
  if (!f.name.trim()) return props.showToast("请填写领域名称");
  const now = Date.now();
  const existing = f.id ? domains.value.find((d) => d.id === f.id) : null;
  if (existing) {
    Object.assign(existing, { name: f.name.trim(), note: f.note.trim(), updatedAt: now });
  } else {
    domains.value.push({ id: crypto.randomUUID(), name: f.name.trim(), note: f.note.trim(), createdAt: now, updatedAt: now });
  }
  await persistDomains();
  showDomainForm.value = false;
  props.showToast(existing ? "已更新领域" : "已创建领域");
}
async function removeDomain(d) {
  const n = poolCount(d.id);
  const ok = await askConfirm({
    title: "删除领域",
    message: n ? `领域「${d.name}」下还有 ${n} 个 Pool，将一并移除，5 秒内可撤销。` : `领域「${d.name}」将被删除，5 秒内可撤销。`,
    okText: "删除",
  });
  if (!ok) return;
  const idx = domains.value.findIndex((x) => x.id === d.id);
  const removedPools = pools.value.filter((p) => p.domainId === d.id);
  domains.value = domains.value.filter((x) => x.id !== d.id);
  pools.value = pools.value.filter((p) => p.domainId !== d.id);
  if (currentId.value === d.id) currentId.value = null;
  await persistDomains();
  await persistPools();
  props.showToast("已删除领域", {
    actionLabel: "撤销",
    onAction: async () => {
      domains.value.splice(Math.min(Math.max(idx, 0), domains.value.length), 0, d);
      pools.value.push(...removedPools);
      await persistDomains();
      await persistPools();
      props.showToast("已恢复");
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

// AI 识图字段定义
const AI_FIELDS = [
  { key: "name", label: "Pool（代码仓库名）", desc: "仓库/项目名，如 warehouse.wms.outward.api" },
  { key: "note", label: "备注", desc: "该仓库的说明或用途", multiline: true },
];
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
  props.showToast(added ? `已新增 ${added} 个 Pool` : "没有新增（都已存在或为空）");
}
function openPoolEdit(p) {
  poolForm.value = { id: p.id, domainId: p.domainId, name: p.name, note: p.note || "", path: p.path || "" };
  showPoolForm.value = true;
}
async function savePool() {
  const f = poolForm.value;
  if (!f.name.trim()) return props.showToast("请填写 Pool（代码仓库）名称");
  const now = Date.now();
  const existing = f.id ? pools.value.find((p) => p.id === f.id) : null;
  if (existing) {
    Object.assign(existing, { name: f.name.trim(), note: f.note.trim(), path: (f.path || "").trim(), updatedAt: now });
  } else {
    pools.value.push({ id: crypto.randomUUID(), domainId: f.domainId || currentId.value, name: f.name.trim(), note: f.note.trim(), path: (f.path || "").trim(), createdAt: now, updatedAt: now });
  }
  await persistPools();
  showPoolForm.value = false;
  props.showToast(existing ? "已更新 Pool" : "已添加 Pool");
}
async function removePool(p) {
  const ok = await askConfirm({ title: "删除 Pool", message: `Pool「${p.name}」将被删除，5 秒内可撤销。`, okText: "删除" });
  if (!ok) return;
  const idx = pools.value.findIndex((x) => x.id === p.id);
  pools.value = pools.value.filter((x) => x.id !== p.id);
  await persistPools();
  props.showToast("已删除 Pool", {
    actionLabel: "撤销",
    onAction: async () => {
      pools.value.splice(Math.min(Math.max(idx, 0), pools.value.length), 0, p);
      await persistPools();
      props.showToast("已恢复");
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
    props.showToast(`已复制「${p.name}」`);
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}

// ------- 本地项目路径 / 拉取最新代码 -------
async function pickPath(p) {
  try {
    const dir = await open({ directory: true, title: `选择「${p.name}」的本地项目文件夹` });
    if (!dir) return;
    const target = pools.value.find((x) => x.id === p.id);
    if (target) target.path = dir;
    await persistPools();
    props.showToast("已设置项目路径");
  } catch (e) {
    props.showToast("设置路径失败：" + e);
  }
}
async function pickFormPath() {
  try {
    const dir = await open({ directory: true, title: "选择本地项目文件夹" });
    if (dir) poolForm.value.path = dir;
  } catch (e) {
    props.showToast("选择失败：" + e);
  }
}
async function pullPool(p) {
  if (!p.path) return props.showToast("请先设置该 Pool 的本地项目路径");
  if (pulling.value[p.id]) return;
  pulling.value[p.id] = true;
  try {
    const out = await invoke("git_pull", { path: p.path });
    const last = String(out || "").split("\n").filter(Boolean).pop() || "已完成";
    props.showToast(`「${p.name}」：${last}`);
  } catch (e) {
    props.showToast(`「${p.name}」拉取失败：` + e);
  } finally {
    pulling.value[p.id] = false;
  }
}
async function pullAll() {
  const targets = currentPools.value.filter((p) => p.path);
  if (!targets.length) return props.showToast("当前领域没有设置了本地路径的 Pool");
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
      props.showToast(`「${p.name}」失败：` + e);
    } finally {
      pulling.value[p.id] = false;
    }
  }
  pullingAll.value = false;
  props.showToast(`批量拉取完成：成功 ${ok}，失败 ${fail}`);
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
  if (!names.length) return props.showToast("请粘贴至少一个 Pool 名称");
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
  props.showToast(added ? `已新增 ${added} 个 Pool` : "没有新增（都已存在）");
}

// ------- 从旧资料库项目导入为 Pool -------
async function openImport() {
  let items = [];
  try {
    items = (await invoke("load_data", { key: "items" })) || [];
  } catch (e) {
    return props.showToast("读取旧资料库失败：" + e);
  }
  const exist = new Set(pools.value.filter((p) => p.domainId === currentId.value).map((p) => p.name));
  legacyProjects.value = items
    .filter((it) => it.type === "project")
    .map((it) => ({ id: it.id, name: it.title, imported: exist.has(it.title) }));
  importSel.value = {};
  legacyProjects.value.forEach((p) => (importSel.value[p.id] = !p.imported));
  if (!legacyProjects.value.length) return props.showToast("旧资料库里没有项目可导入");
  showImport.value = true;
}
async function saveImport() {
  const chosen = legacyProjects.value.filter((p) => importSel.value[p.id]);
  if (!chosen.length) return props.showToast("请至少勾选一个项目");
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
  props.showToast(added ? `已导入 ${added} 个 Pool` : "没有新增（都已存在）");
}
</script>

<template>
  <!-- ============ 领域详情（管理其下 Pool） ============ -->
  <template v-if="current">
    <div class="detail-bar">
      <button class="back-btn" @click="exit"><Icon name="chevron" :size="16" class="rot90" /> 返回领域列表</button>
    </div>

    <section class="hero">
      <span class="hero-icon"><Icon name="layers" :size="22" /></span>
      <div class="hero-main">
        <h2>{{ current.name }}</h2>
        <p v-if="current.note" class="hero-note">{{ current.note }}</p>
        <p class="prog-text">
          共 {{ currentPools.length }} 个 Pool（代码仓库）
        </p>
      </div>
      <div class="hero-ops">
        <button class="btn-outline" @click="openDomainEdit(current)"><Icon name="edit" :size="15" /> 编辑领域</button>
        <button class="btn-outline danger" @click="removeDomain(current)"><Icon name="trash" :size="15" /> 删除</button>
      </div>
    </section>

    <div class="toolbar">
      <div class="search-mini">
        <Icon name="search" :size="15" class="s-icon" />
        <input v-model="search" placeholder="搜索 Pool..." />
      </div>
      <div class="tb-right">
        <button class="btn-ghost sm" :disabled="pullingAll" @click="pullAll"><Icon name="download" :size="15" :class="{ spin: pullingAll }" /> {{ pullingAll ? '拉取中…' : '拉取全部最新' }}</button>
        <button class="btn-ghost sm" @click="openImport"><Icon name="copy" :size="15" /> 从旧项目导入</button>
        <button class="btn-ghost sm" @click="openBatch"><Icon name="copy" :size="15" /> 批量录入</button>
        <button class="btn-primary sm" @click="openPoolCreate"><Icon name="plus" :size="15" /> 添加 Pool</button>
                <AiExtract :fields="AI_FIELDS" :multiple="true" dedupe-key="name" :existing="pools.filter((p) => p.domainId === currentId).map((p) => p.name)" hint="这是一张包含代码仓库/项目信息的截图，可能是列表，请把其中每一个仓库提取为一条记录（Pool 仓库名与备注）。" title="AI 识图录入 Pool" :show-toast="showToast" @apply="createPoolsFromAI" />
      </div>
    </div>

    <main class="content">
      <div v-if="currentPools.length" class="pool-list">
        <div v-for="p in currentPools" :key="p.id" class="pool-row">
          <span class="pool-icon"><Icon name="box" :size="16" /></span>
          <div class="pool-main">
            <span class="pool-name" title="点击复制" @click="copyPool(p)">{{ p.name }}</span>
            <span v-if="p.note" class="pool-note">{{ p.note }}</span>
            <span v-if="p.path" class="pool-path" :title="p.path"><Icon name="folder" :size="11" /> {{ p.path }}</span>
          </div>
          <div class="pool-ops">
            <button
              class="icon-btn publish"
              :title="({ deploying: '发布中，点击查看进度', success: '发布成功，点击查看记录', failed: '发布失败，点击查看记录' })[badgeOf(p)] || '发布（记录本地发布步骤）'"
              @click="openPublish(p)"
            >
              <Icon name="upload" :size="15" />
              <span v-if="badgeOf(p)" class="pub-dot" :class="badgeOf(p)"></span>
            </button>
            <button class="icon-btn" :class="{ done: copiedPoolId === p.id }" :title="copiedPoolId === p.id ? '已复制' : '复制名称'" @click="copyPool(p)"><Icon :name="copiedPoolId === p.id ? 'check' : 'copy'" :size="15" /></button>
            <button class="icon-btn" :class="{ spinning: pulling[p.id] }" :disabled="!p.path || pulling[p.id]" :title="p.path ? '拉取最新代码' : '请先设置本地项目路径'" @click="pullPool(p)"><Icon :name="pulling[p.id] ? 'repeat' : 'download'" :size="15" :class="{ spin: pulling[p.id] }" /></button>
            <button class="icon-btn" :class="{ done: p.path }" :title="p.path ? '修改本地项目路径' : '设置本地项目路径'" @click="pickPath(p)"><Icon name="folder" :size="15" /></button>
            <button class="icon-btn" title="编辑" @click="openPoolEdit(p)"><Icon name="edit" :size="15" /></button>
            <button class="icon-btn" title="删除" @click="removePool(p)"><Icon name="trash" :size="15" /></button>
          </div>
        </div>
      </div>
      <div v-else class="empty">
          <span class="empty-ico"><Icon name="box" :size="32" /></span>
        <h2>该领域下还没有 Pool</h2>
        <p>Pool 就是代码仓库项目名（如 warehouse.wms.outward.api）。批量粘贴或从旧项目导入吧。</p>
        <button class="btn-outline lg" @click="openPoolCreate"><Icon name="plus" :size="16" /> 添加第一个 Pool</button>
      </div>
    </main>
  </template>

  <!-- ============ 领域列表 ============ -->
  <template v-else>
    <div class="toolbar">
      <div class="tb-left">
        <h3 class="section-title">领域 · {{ domains.length }}</h3>
        <div class="search-mini">
          <Icon name="search" :size="15" class="s-icon" />
          <input v-model="search" placeholder="搜索领域..." />
        </div>
      </div>
      <div class="tb-right">
        <button class="btn-primary sm" @click="openDomainCreate"><Icon name="plus" :size="15" /> 新建领域</button>
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
            <button class="op del" title="删除" @click.stop="removeDomain(d)"><Icon name="trash" :size="15" /></button>
            <button class="op" title="编辑" @click.stop="openDomainEdit(d)"><Icon name="edit" :size="15" /></button>
          </div>
          <div class="dom-emblem">
            <span class="emblem-tile" :style="{ '--hue': hueShiftOf(colorOf(d, i)) + 'deg' }"><Icon name="layers" :size="18" /></span>
          </div>
          <h4 class="dom-name">{{ d.name }}</h4>
          <p v-if="d.note" class="dom-note">{{ d.note }}</p>
          <div class="dom-foot">
            <span class="pool-chip"><Icon name="box" :size="13" /> {{ poolCount(d.id) }} 个 Pool</span>
            <span class="enter-hint"><Icon name="chevron" :size="16" /></span>
          </div>
        </div>
      </div>
      <div v-else class="empty">
          <span class="empty-ico"><Icon name="layers" :size="32" /></span>
        <h2>还没有领域</h2>
        <p>按业务线建立领域（如 云仓 / 发票 / 结算 / 销售），每个领域下维护它的代码仓库 Pool。</p>
        <button class="btn-outline lg" @click="openDomainCreate"><Icon name="plus" :size="16" /> 新建第一个领域</button>
      </div>
    </main>
  </template>

  <!-- ============ 领域 新建 / 编辑弹窗 ============ -->
  <div v-if="showDomainForm" class="modal-mask">
    <div class="modal">
      <h2>{{ domainForm.id ? "编辑领域" : "新建领域" }}</h2>
      <label class="field">
        <span>领域名称</span>
        <input v-model="domainForm.name" placeholder="例如：云仓 / 发票 / 结算 / 销售" />
      </label>
      <label class="field">
        <span>说明（可选）</span>
        <textarea v-model="domainForm.note" rows="2" placeholder="该领域的职责或范围"></textarea>
      </label>
      <div class="modal-foot">
        <button class="btn-ghost" @click="showDomainForm = false">取消</button>
        <button class="btn-primary" @click="saveDomain">保存</button>
      </div>
    </div>
  </div>

  <!-- ============ Pool 新建 / 编辑弹窗 ============ -->
  <div v-if="showPoolForm" class="modal-mask">
    <div class="modal">
      <h2>{{ poolForm.id ? "编辑 Pool" : "添加 Pool" }}</h2>
      <label class="field">
        <span>Pool（代码仓库名）</span>
        <input v-model="poolForm.name" placeholder="例如：warehouse.wms.outward.api" />
      </label>
      <label class="field">
        <span>备注（可选）</span>
        <textarea v-model="poolForm.note" rows="2" placeholder="职责说明 / 责任人等"></textarea>
      </label>
      <label class="field">
        <span>本地项目路径（可选，用于一键 git pull）</span>
        <div class="path-row">
          <input v-model="poolForm.path" placeholder="已与 Git 关联的本地仓库目录" />
          <button type="button" class="btn-outline sm" @click="pickFormPath"><Icon name="folder" :size="15" /> 选文件夹</button>
        </div>
      </label>
      <div class="modal-foot">
        <button class="btn-ghost" @click="showPoolForm = false">取消</button>
        <button class="btn-primary" @click="savePool">保存</button>
      </div>
    </div>
  </div>

  <!-- ============ 批量录入 Pool 弹窗 ============ -->
  <div v-if="showBatch" class="modal-mask">
    <div class="modal">
      <h2>批量录入 Pool</h2>
      <label class="field">
        <span>每行一个仓库名（自动去重）</span>
        <textarea v-model="batchText" rows="8" placeholder="warehouse.wms.outward.api&#10;online.base.connector.ui&#10;online.base.connector.service"></textarea>
      </label>
      <div class="modal-foot">
        <button class="btn-ghost" @click="showBatch = false">取消</button>
        <button class="btn-primary" @click="saveBatch">导入</button>
      </div>
    </div>
  </div>

  <!-- ============ 发布弹窗 ============ -->
  <PoolPublish v-if="publishPool" :pool="publishPool" :show-toast="showToast" @close="publishPool = null" @saved="onPublishSaved" />

  <!-- ============ 从旧项目导入弹窗 ============ -->
  <div v-if="showImport" class="modal-mask">
    <div class="modal">
      <h2>从旧资料库项目导入为 Pool</h2>
      <p class="import-tip">勾选要导入到「{{ current?.name }}」的项目（已导入的默认不勾）。</p>
      <div class="pick-list">
        <label v-for="p in legacyProjects" :key="p.id" class="pick-row">
          <input type="checkbox" v-model="importSel[p.id]" />
          <span class="pick-name">{{ p.name }}</span>
          <span v-if="p.imported" class="pick-note">（已存在）</span>
        </label>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" @click="showImport = false">取消</button>
        <button class="btn-primary" @click="saveImport">导入所选</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-bar { padding: 14px 28px 0; }
.back-btn { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; color: var(--muted); font-size: var(--fs-base); cursor: pointer; padding: 4px 0; }
.back-btn:hover { color: var(--primary); }
.rot90 { transform: rotate(90deg); }

/* hero */
.hero { display: flex; gap: 16px; align-items: flex-start; margin: 12px 28px 0; padding: 20px 22px; background: var(--card); border: 1px solid var(--card-border); border-left: 4px solid var(--primary); border-radius: var(--r-lg); box-shadow: var(--shadow); }
.hero-icon { width: 46px; height: 46px; flex-shrink: 0; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary); display: grid; place-items: center; }
.hero-main { flex: 1; min-width: 0; }
.hero-main h2 { margin: 0 0 6px; font-size: var(--fs-xl); }
.hero-note { margin: 0 0 6px; color: var(--muted); font-size: var(--fs-md); }
.hero-ops { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
.prog-text { margin: 4px 0 0; font-size: var(--fs-md); color: var(--muted); }

/* toolbar */
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 28px; flex-wrap: wrap; }
.section-title { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
.tb-left { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.tb-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.search-mini { position: relative; display: flex; align-items: center; }
.search-mini .s-icon { position: absolute; left: 10px; color: var(--muted); pointer-events: none; }
.search-mini input { padding: 7px 12px 7px 30px; border: 1px solid transparent; border-radius: var(--r-sm); font-size: var(--fs-md); background: color-mix(in srgb, var(--text-weak) 9%, transparent); color: var(--text); outline: none; width: 180px; transition: background 0.15s, border-color 0.15s; }
.search-mini input:focus { background: var(--card); border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }

/* content */
.content { flex: 1; padding: 16px 28px 36px; }

/* 领域网格 */
.dom-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(272px, 1fr)); gap: 20px; }
.dom-card { position: relative; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 20px 20px 18px; box-shadow: var(--shadow); cursor: pointer; overflow: hidden; opacity: 0; transform: translateY(14px); animation: cardIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards; transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s, border-color 0.25s; }
@keyframes cardIn { to { opacity: 1; transform: none; } }
.dom-card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--dc, var(--primary)) 35%, var(--card)); box-shadow: 0 14px 34px color-mix(in srgb, var(--dc, var(--primary)) 16%, rgba(35, 43, 66, 0.1)); }
.dom-ops { position: absolute; top: 16px; right: 16px; display: flex; gap: 6px; opacity: 0; transform: translateY(-4px); transition: opacity 0.15s, transform 0.15s; z-index: 3; }
.dom-card:hover .dom-ops { opacity: 1; transform: none; }
.op { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; border: 1px solid var(--card-border); background: var(--card); border-radius: var(--r-sm); color: var(--muted); cursor: pointer; transition: all 0.15s; }
.op:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }
.op.del:hover { color: var(--danger); border-color: var(--border-danger); background: var(--danger-soft); }

/* 领域标徽（线性图标 + 领域色底，色相由领域色令牌驱动） */
.dom-emblem { width: 54px; height: 54px; margin-bottom: 16px; }
.emblem-tile { display: grid; place-items: center; width: 100%; height: 100%; border-radius: var(--r-md); background: color-mix(in srgb, var(--dc, var(--primary)) 14%, var(--card)); color: var(--dc, var(--primary)); box-shadow: 0 5px 14px color-mix(in srgb, var(--dc, var(--primary)) 32%, transparent); transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1); }
.dom-card:hover .emblem-tile { transform: translateY(-2px); }

.dom-name { margin: 0 0 6px; font-size: var(--fs-lg); font-weight: 700; }
.dom-note { margin: 0 0 14px; font-size: var(--fs-sm); color: var(--muted); }
.dom-foot { display: flex; align-items: center; justify-content: space-between; }
.enter-hint { display: grid; place-items: center; color: var(--dc, var(--primary)); opacity: 0; transform: translateX(-6px) rotate(-90deg); transition: opacity 0.2s, transform 0.2s; }
.dom-card:hover .enter-hint { opacity: 1; transform: translateX(0) rotate(-90deg); }
.pool-chip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--text-soft); background: var(--well); padding: 3px 10px; border-radius: var(--r-pill); }

/* Pool 列表 */
.pool-list { display: flex; flex-direction: column; }
/* 列表平铺：Pool 列表不设容器（背景层），行分隔线分组 */
.pool-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.pool-row:last-child { border-bottom: none; }
.pool-icon { width: 30px; height: 30px; flex-shrink: 0; border-radius: var(--r-sm); background: var(--primary-soft); color: var(--primary); display: grid; place-items: center; }
.pool-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pool-name { font-size: var(--fs-md); font-weight: 600; font-family: var(--font-mono); word-break: break-all; cursor: pointer; transition: color 0.15s; }
.pool-name:hover { color: var(--primary); text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
.pool-note { font-size: var(--fs-sm); color: var(--muted); }
.pool-path { font-size: var(--fs-sm); color: var(--muted); display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.pool-path :deep(svg) { flex-shrink: 0; }
.path-row { display: flex; gap: 8px; align-items: center; }
.path-row input { flex: 1; min-width: 0; }
.pool-ops { display: flex; gap: 6px; flex-shrink: 0; }

/* 按钮（基础样式已全局统一，见 App.vue；这里仅保留领域专属变体） */
.pub-dot { position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border-radius: var(--r-pill); border: 1.5px solid var(--text-invert); }
.pub-dot.deploying { background: var(--amber-bright); animation: pub-pulse 1.2s ease-in-out infinite; }
.pub-dot.success { background: var(--success); }
.pub-dot.failed { background: var(--danger); }
@keyframes pub-pulse { 50% { opacity: 0.35; } }
.icon-btn.done { color: var(--success-deep); border-color: var(--success); background: var(--success-tint); }
.icon-btn.publish:hover { color: var(--amber); border-color: var(--amber); background: var(--amber-soft); }
@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 0.9s linear infinite; }

/* 空状态 */
.empty { text-align: center; padding: 56px 20px; }
.empty-ico { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 50%; background: var(--primary-soft); color: var(--primary); margin-bottom: 6px; }
.empty h2 { font-size: var(--fs-xl); margin: 8px 0 6px; font-weight: 700; }
.empty p { color: var(--muted); font-size: var(--fs-base); margin: 0 0 22px; max-width: 460px; margin-left: auto; margin-right: auto; }

/* 弹窗（基础样式已全局统一，见 App.vue） */
.modal { width: 500px; }
.field { display: block; margin-bottom: 16px; }
.field > span { display: block; font-size: var(--fs-md); color: var(--muted); margin-bottom: 7px; font-weight: 600; }
.field input, .field textarea { width: 100%; padding: 10px 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; resize: vertical; background: var(--card); color: var(--text); transition: border-color 0.15s, box-shadow 0.15s; }
.field input:focus, .field textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.import-tip { margin: -8px 0 12px; font-size: var(--fs-md); color: var(--muted); }
.pick-list { max-height: 320px; overflow-y: auto; border: 1px solid var(--border-strong); border-radius: var(--r-sm); margin-bottom: 8px; }
.pick-row { display: flex; align-items: center; gap: 9px; padding: 9px 12px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s, box-shadow 0.15s; }
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
