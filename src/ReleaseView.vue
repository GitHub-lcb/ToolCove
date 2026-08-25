<script setup>
// 发布工作台：侧边栏「发布」= 领域下所有 Pool 的发布总览 + 临时 Pool（免领域建档，独立数据源，优先展示）。
// 总览卡（KPI 大数字 + 可点击状态格 + 分段脉搏条）一眼看清发布健康度，点状态格即过滤列表；
// 每个 Pool 行内展示本地发布记录状态（pool.lastRelease 推导，纯本地数据，无云端依赖）；
// 点击发布按钮打开 PoolPublish 弹窗：按 打包→上传→发布→验证 逐项记录发布时间。
import { ref, computed, onMounted, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon.vue";
import PoolPublish from "./PoolPublish.vue";
import PoolStatus from "./PoolStatus.vue";
import { releaseBadge, releaseDetail } from "./publishState.js";
import { askConfirm } from "./confirm.js";
import { relativeTime } from "./shared.js";
import { parsePoolLines, splitNewPools, localPoolNames, makeLocalPool, nameConflict } from "./releasePools.js";

const props = defineProps({ showToast: { type: Function, default: () => {} } });
const emit = defineEmits(["navigate"]);

const domains = ref([]);
const pools = ref([]);
const search = ref("");
const LOCAL_SCOPE = "__local";
const domainFilter = ref(""); // "" 为全部范围，__local 为临时 Pool，其余为领域 id
const statusFilter = ref(""); // "" | deploying | success | failed | idle（点状态格过滤列表）
const publishPool = ref(null); // 正在发布的 Pool（非空时弹发布弹窗）

// ------- 临时 Pool的 Pool（独立数据源，优先展示，区别于领域 Pool） -------
// 持久化 key：release-pools = { active: [...], archived: [...] }；纯本地数据，发布状态记在 pool.lastRelease
const localActive = ref([]);
const localArchived = ref([]);
const showInput = ref(false); // 批量输入区默认收起，点「新增 Pool」展开
const batchTa = ref(null);
const batchText = ref("");
const editingId = ref("");
const editForm = ref({ name: "" });
const archOpen = ref(false);

async function loadLocal() {
  try {
    const raw = (await invoke("load_data", { key: "release-pools" })) || {};
    localActive.value = Array.isArray(raw.active) ? raw.active : [];
    localArchived.value = Array.isArray(raw.archived) ? raw.archived : [];
  } catch { /* 读取失败按空处理，不阻断工作台 */ }
}
async function saveLocal() {
  try {
    await invoke("save_data", { key: "release-pools", data: { active: localActive.value, archived: localArchived.value } });
    return true;
  } catch (e) {
    props.showToast("保存失败：" + e);
    return false;
  }
}

// 批量新增只排除已有临时 Pool；领域同名 Pool 允许再次加入发布工作台。
function allExistingNames() {
  return localPoolNames(localActive.value, localArchived.value);
}

// 展开/收起批量输入区（展开后聚焦输入框）
function toggleInput() {
  showInput.value = !showInput.value;
  if (showInput.value) nextTick(() => batchTa.value?.focus());
}

function openLocalInput() {
  domainFilter.value = LOCAL_SCOPE;
  showInput.value = true;
  nextTick(() => batchTa.value?.focus());
}

// 批量添加：多行解析 → 去重 → 入库（纯本地，无云端识别）
async function addBatch() {
  const names = parsePoolLines(batchText.value);
  if (!names.length) return props.showToast("请粘贴至少一个 Pool 名，每行一个");
  const { addable, skipped } = splitNewPools(names, allExistingNames());
  if (!addable.length) return props.showToast("这些 Pool 都已存在（临时 Pool中）");
  const added = addable.map((name) => makeLocalPool(name));
  const previousActive = localActive.value;
  localActive.value = [...added, ...localActive.value];
  const saved = await saveLocal();
  if (!saved) {
    localActive.value = previousActive;
    return;
  }
  batchText.value = "";
  showInput.value = false; // 添加完成收起输入区，保持工作台简洁
  const parts = [`已添加 ${added.length} 个 Pool`];
  if (skipped.length) parts.push(`跳过已存在 ${skipped.length} 个临时 Pool`);
  props.showToast(parts.join("；"));
}

// 行内编辑
function startEdit(p) {
  editingId.value = p.id;
  editForm.value = { name: p.name };
}
function cancelEdit() {
  editingId.value = "";
}
async function saveEdit(p) {
  const name = editForm.value.name.trim();
  if (!name) return props.showToast("Pool 名不能为空");
  const conflicts = nameConflict(
    name,
    [...localActive.value, ...localArchived.value, ...pools.value.map((x) => ({ id: x.id, name: x.name }))],
    p.id
  );
  if (conflicts) return props.showToast("该名称已存在（领域或临时 Pool中）");
  p.name = name;
  p.updatedAt = Date.now();
  await saveLocal();
  editingId.value = "";
  props.showToast("已保存修改");
}

// 删除（仅从临时 Pool列表移除，不影响领域数据）
async function removeLocal(p) {
  const ok = await askConfirm({
    title: "删除 Pool",
    message: `将从临时 Pool列表删除「${p.name}」（不影响领域模块数据）。确定删除吗？`,
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  localActive.value = localActive.value.filter((x) => x.id !== p.id);
  await saveLocal();
  props.showToast("已删除");
}

// 单行归档（可恢复，无需确认）
async function archiveOne(p) {
  localActive.value = localActive.value.filter((x) => x.id !== p.id);
  localArchived.value = [{ ...p, archivedAt: Date.now() }, ...localArchived.value];
  await saveLocal();
  props.showToast(`已归档「${p.name}」，可在底部「已归档」恢复`);
}

// 当前活跃的本地 Pool 一次性全部归档（归档后可继续新增，归档项可恢复或彻底删除）
async function archiveAll() {
  if (!localActive.value.length) return;
  const ok = await askConfirm({
    title: "归档全部 Pool",
    message: `将当前批次的 ${localActive.value.length} 个临时 Pool 全部归档：归档后不再参与列表与发布统计，可在底部「已归档」分组恢复或彻底删除。`,
    okText: "全部归档",
  });
  if (!ok) return;
  const now = Date.now();
  localArchived.value = [...localActive.value.map((p) => ({ ...p, archivedAt: now })), ...localArchived.value];
  localActive.value = [];
  await saveLocal();
  props.showToast("已全部归档，可继续新增 Pool");
}

// 归档池回退到临时 Pool（可再次发布）
async function restoreArchived(p) {
  const { archivedAt, ...rest } = p;
  const item = { ...rest, updatedAt: Date.now() };
  localActive.value = [item, ...localActive.value];
  localArchived.value = localArchived.value.filter((x) => x.id !== p.id);
  await saveLocal();
  props.showToast(`已回退「${p.name}」到临时 Pool`);
}

// 归档池彻底删除（不可恢复）
async function removeArchived(p) {
  const ok = await askConfirm({
    title: "彻底删除",
    message: `将永久删除归档 Pool「${p.name}」，不可恢复。确定吗？`,
    okText: "彻底删除",
    danger: true,
  });
  if (!ok) return;
  localArchived.value = localArchived.value.filter((x) => x.id !== p.id);
  await saveLocal();
  props.showToast("已彻底删除");
}

// ------- 加载 -------
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
  await loadLocal(); // 临时 Pool 一并刷新（工具栏「刷新列表」预期刷新全部数据源）
}
onMounted(async () => {
  await load(); // 含领域 / Pool / 临时 Pool 三个数据源
});

// ------- 状态元信息（徽章 / 统计格 / 脉搏条共用的单一事实源） -------
const STATUS_LIST = [
  { key: "deploying", label: "发布中", color: "var(--amber)", cls: "st-pending" },
  { key: "success", label: "已发布", color: "var(--success)", cls: "st-live" },
  { key: "failed", label: "发布失败", color: "var(--danger)", cls: "st-fail" },
  { key: "idle", label: "未发布", color: "var(--border-strong)", cls: "idle-chip" },
];
const STATUS_META = Object.fromEntries(STATUS_LIST.map((m) => [m.key, m]));

// ------- 派生 -------
const statusKeyOf = (p) => releaseBadge(p) || "idle";
const searchKeyword = computed(() => search.value.trim().toLowerCase());
const showLocalScope = computed(() => domainFilter.value === "" || domainFilter.value === LOCAL_SCOPE);
const localHit = (p, kw) => !kw || p.name.toLowerCase().includes(kw) || (p.note || "").toLowerCase().includes(kw);
const domainHit = (p, kw) => !kw || p.name.toLowerCase().includes(kw) || (p.note || "").toLowerCase().includes(kw);

const filteredPools = computed(() => {
  if (domainFilter.value === LOCAL_SCOPE) return [];
  const kw = searchKeyword.value;
  return pools.value
    .filter((p) => (domainFilter.value ? p.domainId === domainFilter.value : true))
    .filter((p) => (statusFilter.value ? statusKeyOf(p) === statusFilter.value : true))
    .filter((p) => domainHit(p, kw))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
});
// 按领域分组（保持领域顺序，空组隐藏）
const groups = computed(() => {
  return domains.value
    .map((d) => ({ domain: d, pools: filteredPools.value.filter((p) => p.domainId === d.id) }))
    .filter((g) => g.pools.length);
});

// 临时 Pool：只在「全部 / 临时」范围展示；搜索命中名称、项目标识或项目显示名
const filteredLocal = computed(() =>
  showLocalScope.value
    ? localActive.value.filter(
        (p) => (!statusFilter.value || statusKeyOf(p) === statusFilter.value) && localHit(p, searchKeyword.value)
      )
    : []
);
const filteredArchived = computed(() =>
  showLocalScope.value && !statusFilter.value
    ? localArchived.value.filter((p) => localHit(p, searchKeyword.value))
    : []
);
const showArchivedSection = computed(
  () => showLocalScope.value && localArchived.value.length && (!searchKeyword.value || filteredArchived.value.length)
);

// 总览跟随范围和搜索，但不跟随状态筛选，避免选中某状态后其他状态计数全部归零
const summaryPools = computed(() => {
  const domainPools =
    domainFilter.value === LOCAL_SCOPE
      ? []
      : pools.value.filter((p) => (!domainFilter.value || p.domainId === domainFilter.value) && domainHit(p, searchKeyword.value));
  const localPools = showLocalScope.value ? localActive.value.filter((p) => localHit(p, searchKeyword.value)) : [];
  return [...localPools, ...domainPools];
});
const hasAnyPoolData = computed(() => !!(pools.value.length || localActive.value.length || localArchived.value.length));
const hasVisibleResults = computed(
  () => !!(groups.value.length || filteredLocal.value.length || (showArchivedSection.value && filteredArchived.value.length))
);
const showLocalSection = computed(() => {
  if (!showLocalScope.value) return false;
  if (showInput.value) return true;
  if (!hasAnyPoolData.value) return false;
  if (!searchKeyword.value && !statusFilter.value) return true;
  return filteredLocal.value.length > 0;
});
const showNoResults = computed(() => {
  if (!hasAnyPoolData.value || hasVisibleResults.value) return false;
  if (searchKeyword.value || statusFilter.value) return true;
  return domainFilter.value !== "" && domainFilter.value !== LOCAL_SCOPE;
});
function clearViewFilters() {
  search.value = "";
  statusFilter.value = "";
  domainFilter.value = "";
}

// 领域分组折叠：进入页面默认全部收起（临时 Pool 置顶常开，领域 Pool 需要时再展开）；
// 搜索 / 状态筛选激活时自动展开，保证命中结果可见；清空筛选后回到用户手动的收起/展开状态
const expandedDomains = ref(new Set());
const filtersActive = computed(() => !!(searchKeyword.value || statusFilter.value || domainFilter.value));
const isGroupOpen = (id) => filtersActive.value || expandedDomains.value.has(id);
function toggleGroup(id) {
  const next = new Set(expandedDomains.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedDomains.value = next;
}

// ------- 发布状态 -------
function badgeCls(p) {
  return STATUS_META[statusKeyOf(p)].cls;
}
// 行内发布详情：发布进度 / 结果 + 最近动作时间（纯本地记录）
function pubDetail(p) {
  const r = p.lastRelease;
  if (!r) return "";
  const parts = [releaseDetail(p)];
  const t = r.status === "doing" ? r.startedAt : r.finishedAt;
  if (t) parts.push(relativeTime(t));
  return parts.join(" · ");
}
// 统计总览（各状态计数，供状态格与脉搏条共用；跟随当前范围与搜索）
const stats = computed(() => {
  const s = { total: summaryPools.value.length };
  STATUS_LIST.forEach((m) => (s[m.key] = 0));
  summaryPools.value.forEach((p) => s[statusKeyOf(p)]++);
  return s;
});
// 脉搏条分段（按占比着色，随状态流转平滑过渡）
const pulseSegs = computed(() => {
  const total = summaryPools.value.length;
  if (!total) return [];
  return STATUS_LIST.filter((m) => stats.value[m.key] > 0).map((m) => ({
    ...m,
    count: stats.value[m.key],
    w: (stats.value[m.key] / total) * 100,
  }));
});
function toggleFilter(key) {
  statusFilter.value = statusFilter.value === key ? "" : key;
}

// ------- 发布 -------
const publishLabelOf = (p) =>
  statusKeyOf(p) === "idle" ? "发布" : statusKeyOf(p) === "deploying" ? "查看进度" : "重新发布";
const publishTitleOf = (p) =>
  statusKeyOf(p) === "idle"
    ? "发布（记录本地发布步骤）"
    : statusKeyOf(p) === "deploying"
      ? "查看发布进度 / 继续操作"
      : "查看上次发布记录 / 重新发布";
const publishIconOf = (p) => (statusKeyOf(p) === "deploying" || statusKeyOf(p) === "success" ? "bar-chart" : "upload");

function openPublish(p) {
  publishPool.value = p;
}

// 发布记录已写入 pool.lastRelease：临时 Pool 与领域 Pool 各自数据源落盘
async function onPublishSaved() {
  const local = localActive.value.find((x) => x.id === publishPool.value?.id);
  if (local) {
    await saveLocal();
    return;
  }
  try {
    await invoke("save_data", { key: "pools", data: pools.value });
  } catch (e) {
    props.showToast("保存失败：" + e);
  }
}

// ------- 复制 Pool 名 -------
const copiedId = ref("");
let copiedTimer = null;
async function copyPool(p) {
  try {
    await navigator.clipboard.writeText(p.name);
    copiedId.value = p.id;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedId.value = null), 1500);
    props.showToast(`已复制「${p.name}」`);
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}
</script>

<template>
  <div class="toolbar">
    <div class="tb-left">
      <h3 class="section-title">Pool 发布工作台</h3>
      <div class="search-mini">
        <Icon name="search" :size="15" class="s-icon" />
        <input v-model="search" placeholder="搜索 Pool / 备注..." />
      </div>
      <!-- 范围筛选同时驱动列表与总览：全部、临时 Pool、各领域 -->
      <div v-if="domains.length" class="domain-seg">
        <span class="seg-label"><Icon name="layers" :size="13" /> 范围</span>
        <button type="button" :class="{ on: domainFilter === '' }" :aria-pressed="domainFilter === ''" @click="domainFilter = ''">全部</button>
        <button type="button" :class="{ on: domainFilter === LOCAL_SCOPE }" :aria-pressed="domainFilter === LOCAL_SCOPE" @click="domainFilter = LOCAL_SCOPE">临时</button>
        <button
          v-for="d in domains"
          :key="d.id"
          type="button"
          :class="{ on: domainFilter === d.id }"
          :aria-pressed="domainFilter === d.id"
          :title="d.name"
          @click="domainFilter = d.id"
        >{{ d.name }}</button>
      </div>
      <span v-if="statusFilter" class="filter-chip">
        只看：{{ STATUS_META[statusFilter].label }}
        <button class="fc-x" title="清除状态筛选" @click="statusFilter = ''"><Icon name="x" :size="12" /></button>
      </span>
    </div>
    <div class="tb-right">
      <button class="btn-ghost sm" @click="load"><Icon name="repeat" :size="15" /> 刷新列表</button>
    </div>
  </div>

  <!-- 发布健康度总览卡：KPI 大数字 + 可点击状态格（即图例）+ 分段脉搏条 -->
  <div class="pulse-card">
    <div class="pulse-head">
      <div class="pulse-kpi">
        <span class="pulse-ico"><Icon name="layers" :size="20" /></span>
        <div class="pulse-kpi-main">
          <span class="pulse-num">{{ stats.total }}</span>
          <span class="pulse-label">Pool 总数</span>
        </div>
      </div>
      <div class="pulse-cells">
        <button
          v-for="m in STATUS_LIST"
          :key="m.key"
          type="button"
          class="pulse-cell"
          :class="{ on: statusFilter === m.key }"
          :aria-pressed="statusFilter === m.key"
          :title="'只看：' + m.label"
          @click="toggleFilter(m.key)"
        >
          <span class="cell-num" :style="{ color: m.color }">{{ stats[m.key] }}</span>
          <span class="cell-label">{{ m.label }}</span>
        </button>
      </div>
    </div>
    <div v-if="summaryPools.length" class="pulse-bar">
      <span
        v-for="seg in pulseSegs"
        :key="seg.key"
        class="pulse-seg"
        :style="{ width: seg.w + '%', background: seg.color }"
        :title="seg.label + ' ' + seg.count"
      />
    </div>
  </div>

  <main class="content">
    <!-- 临时 Pool 区：免领域建档的独立数据源（release-pools），优先于领域 Pool 展示 -->
    <section v-if="showLocalSection" class="local-sec">
      <div class="group-head local-head">
        <span class="group-title"><Icon name="zap" :size="15" /> 临时 Pool <em>{{ localActive.length }}</em></span>
        <span class="local-desc">未纳入领域的 Pool 可在这里快速发布</span>
        <div class="local-actions">
          <button v-if="localActive.length" class="btn-ghost sm" @click="archiveAll"><Icon name="archive" :size="14" /> 全部归档</button>
          <button class="btn-ghost sm" :class="{ on: showInput }" @click="toggleInput">
            <Icon :name="showInput ? 'x' : 'plus'" :size="14" /> {{ showInput ? "收起" : "添加 Pool" }}
          </button>
        </div>
      </div>
      <div v-if="showInput" class="local-input">
        <div class="batch-field">
          <textarea
            ref="batchTa"
            v-model="batchText"
            class="batch-ta"
            rows="3"
            spellcheck="false"
            placeholder="粘贴 Pool 名，每行一个，例如：&#10;云仓&#10;ops-yuncang"
            @keydown.ctrl.enter.prevent="addBatch"
          ></textarea>
        </div>
        <button class="btn-primary sm" :disabled="!batchText.trim()" @click="addBatch">
          <Icon name="plus" :size="14" /> 添加
        </button>
      </div>
      <div v-if="filteredLocal.length" class="pool-list">
        <div v-for="p in filteredLocal" :key="p.id" class="pool-row">
          <template v-if="editingId === p.id">
            <div class="edit-row">
              <input v-model="editForm.name" class="edit-input" placeholder="Pool 名" />
              <span class="edit-acts">
                <button class="btn-ghost xs" @click="cancelEdit">取消</button>
                <button class="btn-primary sm" @click="saveEdit(p)">保存</button>
              </span>
            </div>
          </template>
          <template v-else>
            <div class="pool-main">
              <span class="pool-name">{{ p.name }}</span>
            </div>
            <PoolStatus
              :status-key="statusKeyOf(p)"
              :badge-cls="badgeCls(p)"
              :label="STATUS_META[statusKeyOf(p)].label"
              :detail="pubDetail(p)"
              :publish-label="publishLabelOf(p)"
              :publish-title="publishTitleOf(p)"
              :publish-icon="publishIconOf(p)"
              @publish="openPublish(p)"
            />
            <div class="pool-ops">
              <button class="icon-btn op-aux" title="归档（可恢复）" @click="archiveOne(p)"><Icon name="archive" :size="15" /></button>
              <button class="icon-btn op-aux" title="编辑" @click="startEdit(p)"><Icon name="edit" :size="15" /></button>
              <button class="icon-btn op-aux danger" title="删除" @click="removeLocal(p)"><Icon name="trash" :size="15" /></button>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- 领域分组（领域模块维护的 Pool；默认收起，点击标题展开） -->
    <template v-if="groups.length">
      <section v-for="g in groups" :key="g.domain.id">
        <div class="group-head domain-head">
          <button class="group-toggle" type="button" :title="isGroupOpen(g.domain.id) ? '收起该领域' : '展开该领域'" @click="toggleGroup(g.domain.id)">
            <Icon :name="isGroupOpen(g.domain.id) ? 'chevron' : 'chevron-right'" :size="14" class="gr-caret" />
            <span class="group-title"><Icon name="layers" :size="15" /> {{ g.domain.name }} <em>{{ g.pools.length }}</em></span>
          </button>
        </div>
        <div v-if="isGroupOpen(g.domain.id)" class="pool-list">
          <div v-for="p in g.pools" :key="p.id" class="pool-row">
            <div class="pool-main">
              <span class="pool-name">{{ p.name }}</span>
              <span v-if="p.note" class="pool-note">{{ p.note }}</span>
            </div>
            <PoolStatus
              :status-key="statusKeyOf(p)"
              :badge-cls="badgeCls(p)"
              :label="STATUS_META[statusKeyOf(p)].label"
              :detail="pubDetail(p)"
              :publish-label="publishLabelOf(p)"
              :publish-title="publishTitleOf(p)"
              :publish-icon="publishIconOf(p)"
              @publish="openPublish(p)"
            />
            <div class="pool-ops">
              <button class="icon-btn op-aux" :class="{ done: copiedId === p.id }" :title="copiedId === p.id ? '已复制' : '复制名称'" @click="copyPool(p)"><Icon :name="copiedId === p.id ? 'check' : 'copy'" :size="15" /></button>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- 已归档分组（默认收起，可彻底删除） -->
    <section v-if="showArchivedSection" class="arch-sec">
      <button class="group-head arch-head" :title="(archOpen ? '收起' : '展开') + '；归档项可恢复到临时 Pool 或彻底删除'" @click="archOpen = !archOpen">
        <span class="group-title"><Icon name="archive" :size="15" /> 已归档 <em>{{ localArchived.length }}</em></span>
        <Icon :name="archOpen ? 'chevron' : 'chevron-right'" :size="14" class="arch-caret" />
      </button>
      <div v-if="archOpen" class="pool-list">
        <div v-for="p in filteredArchived" :key="p.id" class="pool-row arch-row">
          <div class="pool-main">
            <span class="pool-name">{{ p.name }}</span>
            <span class="pool-sub">
              <span class="arch-time">归档于 {{ relativeTime(p.archivedAt) }}</span>
            </span>
          </div>
          <div class="pool-ops">
            <button class="btn-ghost sm" title="回退到临时 Pool，可再次发布" @click="restoreArchived(p)"><Icon name="rotate-left" :size="13" /> 恢复</button>
            <button class="btn-ghost sm danger" @click="removeArchived(p)"><Icon name="trash" :size="13" /> 彻底删除</button>
          </div>
        </div>
      </div>
    </section>

    <div v-if="!hasAnyPoolData && !showInput" class="empty">
      <span class="empty-ico"><Icon name="upload" :size="32" /></span>
      <h2>还没有 Pool</h2>
      <p>先添加临时 Pool 快速发布；需要长期维护的 Pool 可在「领域」模块建档。</p>
      <button class="btn-outline lg" @click="openLocalInput"><Icon name="plus" :size="16" /> 添加第一个临时 Pool</button>
    </div>

    <div v-else-if="showNoResults" class="empty result-empty">
      <span class="empty-ico"><Icon name="search" :size="32" /></span>
      <h2>没有匹配的 Pool</h2>
      <p>当前范围、关键词或发布状态下没有结果。</p>
      <button class="btn-outline" @click="clearViewFilters"><Icon name="x" :size="15" /> 清除筛选</button>
    </div>
  </main>

  <!-- 发布弹窗（与领域模块同款，本地发布步骤记录，@saved 后各自数据源落盘） -->
  <PoolPublish
    v-if="publishPool"
    :pool="publishPool"
    :show-toast="showToast"
    @close="publishPool = null"
    @saved="onPublishSaved"
  />
</template>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-6) 28px; flex-wrap: wrap; }
.section-title { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
.tb-left { display: flex; align-items: center; gap: var(--sp-5); flex-wrap: wrap; }
.tb-right { display: flex; align-items: center; gap: var(--sp-3); }
.search-mini { position: relative; display: flex; align-items: center; }
.search-mini .s-icon { position: absolute; left: 10px; color: var(--muted); pointer-events: none; }
.search-mini input { padding: 7px 12px 7px 30px; border: 1px solid transparent; border-radius: var(--r-sm); font-size: var(--fs-md); background: color-mix(in srgb, var(--text-weak) 9%, transparent); color: var(--text); outline: none; width: 190px; transition: background 0.15s, border-color 0.15s; }
.search-mini input:focus { background: var(--card); border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
/* 范围筛选：胶囊分段控件（全部 / 临时 / 各领域），同时驱动列表与总览 */
.domain-seg { display: inline-flex; align-items: center; gap: 3px; padding: 3px; background: var(--well); border-radius: var(--r-pill); max-width: 420px; overflow-x: auto; }
.domain-seg::-webkit-scrollbar { height: 4px; }
.domain-seg::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: var(--r-pill); }
.seg-label { display: inline-flex; align-items: center; gap: 4px; padding: 0 9px 0 11px; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); flex-shrink: 0; }
.domain-seg button { flex-shrink: 0; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 12px; border: none; background: transparent; color: var(--muted); font-size: var(--fs-sm); font-weight: 600; border-radius: var(--r-pill); cursor: pointer; transition: background 0.15s, color 0.15s; }
.domain-seg button:hover { color: var(--primary); }
.domain-seg button.on { background: var(--card); color: var(--primary); }
.domain-seg button:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.filter-chip { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); font-weight: 600; color: var(--primary); background: var(--primary-soft); padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-4); border-radius: var(--r-pill); }
.fc-x { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: none; border-radius: 50%; background: color-mix(in srgb, var(--primary) 16%, transparent); color: var(--primary); cursor: pointer; }
.fc-x:hover { background: var(--primary); color: var(--text-invert); }

/* 发布健康度总览卡（独立实体用白卡：KPI + 状态格 + 分段脉搏条） */
.pulse-card { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); box-shadow: var(--shadow); padding: var(--sp-6) var(--sp-7) var(--sp-6); margin: 0 28px; }
.pulse-head { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--sp-7); }
.pulse-kpi { display: flex; align-items: center; gap: var(--sp-4); flex-shrink: 0; }
.pulse-ico { width: 44px; height: 44px; display: grid; place-items: center; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary-hover); }
.pulse-kpi-main { display: flex; flex-direction: column; line-height: 1.2; }
.pulse-num { font-family: var(--font-num); font-size: var(--fs-num); font-weight: 700; color: var(--text); }
.pulse-label { font-size: var(--fs-xs); color: var(--muted); }
.pulse-cells { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-2); min-width: 0; }
.pulse-cell { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: var(--sp-1) var(--sp-5); border: 1px solid transparent; border-radius: var(--r-md); background: var(--well); cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.pulse-cell:hover { background: var(--well-hover); }
.pulse-cell.on { border-color: var(--primary); background: var(--primary-soft); }
.cell-num { font-family: var(--font-num); font-size: var(--fs-xl); font-weight: 700; line-height: 1.15; }
.cell-label { font-size: var(--fs-xs); color: var(--muted); }
.pulse-cell.on .cell-label { color: var(--primary); }
.pulse-cell:focus-visible, .fc-x:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.pulse-bar { display: flex; height: var(--sp-1); border-radius: var(--r-pill); background: var(--well); overflow: hidden; margin-top: var(--sp-5); }
.pulse-seg { height: 100%; transition: width 0.25s cubic-bezier(0.22, 1, 0.36, 1); }

/* 领域分组（列表平铺在背景上：行分隔线分组，不套白卡；领域名作为分组标题行） */
.content { flex: 1; padding: var(--sp-7) 28px 36px; display: flex; flex-direction: column; gap: var(--sp-7); }
.group-head { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-4) var(--sp-6); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
/* 领域分组头：可点击折叠（临时 Pool 置顶常开不受影响） */
.domain-head { border-radius: var(--r-sm); transition: background 0.15s; }
.domain-head:hover { background: color-mix(in srgb, var(--primary) 3%, transparent); }
.group-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 0; border: none; background: none; cursor: pointer; color: inherit; text-align: left; }
.group-toggle:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: var(--r-xs); }
.group-toggle:hover .group-title { color: var(--primary); }
.gr-caret { color: var(--muted); flex-shrink: 0; }
.group-title { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-base); font-weight: 700; }
.group-title em { font-style: normal; font-weight: 600; font-size: var(--fs-sm); color: var(--muted); background: var(--well); padding: 1px var(--sp-2); border-radius: var(--r-pill); }

/* Pool 行 */
.pool-list { display: flex; flex-direction: column; }
.pool-row { display: flex; align-items: center; gap: var(--sp-4); padding: var(--sp-4) var(--sp-6); border-bottom: 1px solid var(--border); transition: background 0.15s, box-shadow 0.15s; }
.pool-row:last-child { border-bottom: none; }
.pool-row:hover { background: color-mix(in srgb, var(--primary) 5%, transparent); box-shadow: inset 2px 0 0 var(--primary); }
.pool-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pool-name { font-size: var(--fs-md); font-weight: 600; font-family: var(--font-mono); word-break: break-all; }
.pool-note { font-size: var(--fs-sm); color: var(--muted); }
.pool-sub { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }

/* 操作区：次要操作 hover 渐显（focus-within 兜底键盘用户） */
.pool-ops { display: flex; align-items: center; gap: var(--sp-1); flex-shrink: 0; }
.pool-ops .op-aux { opacity: 0; transition: opacity 0.15s, color 0.15s, border-color 0.15s, background 0.15s; }
.pool-row:hover .op-aux, .pool-row:focus-within .op-aux { opacity: 1; }
.icon-btn.done { color: var(--success-deep); border-color: var(--success); background: var(--success-tint); }
.icon-btn.danger:hover { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
.btn-ghost.sm.danger { color: var(--danger); }
.btn-ghost.sm.danger:hover { color: var(--danger-deep); background: var(--danger-soft); }

/* ============ 临时 Pool区 ============ */
.local-sec { display: flex; flex-direction: column; gap: var(--sp-3); }
.local-head .local-desc { font-size: var(--fs-sm); color: var(--muted); }
.local-actions { margin-left: auto; display: flex; align-items: center; gap: var(--sp-2); }
.btn-ghost.sm.on { color: var(--primary); background: var(--primary-soft); }
.local-input { display: flex; gap: var(--sp-3); align-items: flex-start; }
.batch-field { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.batch-ta { width: 100%; min-width: 0; padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-md); line-height: var(--lh-body); background: var(--card); color: var(--text); outline: none; resize: vertical; box-sizing: border-box; }
.batch-ta:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.batch-ta::placeholder { color: var(--muted); }
/* 行内编辑 */
.edit-row { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-3); }
.edit-input { flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-md); background: var(--card); color: var(--text); outline: none; }
.edit-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.edit-acts { display: flex; gap: var(--sp-2); flex-shrink: 0; }

/* ============ 已归档分组 ============ */
.arch-sec { display: flex; flex-direction: column; }
.arch-head { width: 100%; justify-content: space-between; background: none; border: none; border-bottom: 1px solid var(--border); border-radius: var(--r-sm); cursor: pointer; text-align: left; }
.arch-head:hover { background: color-mix(in srgb, var(--primary) 4%, transparent); }
.arch-caret { color: var(--faint); flex-shrink: 0; }
.arch-row { opacity: 0.75; }
.arch-row:hover { opacity: 1; }
.arch-time { font-size: var(--fs-xs); color: var(--muted); }

/* 空状态 */
.empty { text-align: center; padding: 56px 20px; }
.empty-ico { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 50%; background: var(--primary-soft); color: var(--primary); margin-bottom: var(--sp-1); }
.empty h2 { font-size: var(--fs-xl); margin: var(--sp-2) 0 var(--sp-1); font-weight: 700; }
.empty p { color: var(--muted); font-size: var(--fs-base); margin: 0 0 var(--sp-7); max-width: 480px; margin-left: auto; margin-right: auto; }
.result-empty { padding-top: var(--sp-7); }

@media (max-width: 1180px) {
  .pulse-head { grid-template-columns: 1fr; }
  .pulse-cells { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 820px) {
  .toolbar, .content { padding-left: var(--sp-6); padding-right: var(--sp-6); }
  .pulse-card { margin-left: var(--sp-6); margin-right: var(--sp-6); }
  .tb-left, .search-mini, .search-mini input, .domain-seg { width: 100%; max-width: none; }
  .tb-right { margin-left: auto; }
  .local-head .local-desc { flex-basis: 100%; order: 3; }
  .local-actions { margin-left: auto; }
  .local-input { flex-direction: column; }
  .local-input > .btn-primary { align-self: flex-end; }
  .pool-row { flex-wrap: wrap; }
  .pool-main { flex-basis: 100%; }
}

@media (max-width: 560px) {
  .pulse-cells { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .local-actions { width: 100%; margin-left: 0; }
  .pool-ops .op-aux { opacity: 1; }
  .edit-row { flex-wrap: wrap; }
  .edit-input { flex-basis: 100%; }
}

@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 0.9s linear infinite; }

@media (prefers-color-scheme: dark) {
  .search-mini input, .batch-ta, .edit-input { background: var(--card-raised); }
  .pulse-ico { background: var(--card-raised); color: var(--primary-light); }
  .icon-btn.done { background: var(--success-soft); color: var(--success-light); border-color: var(--success-light); }
}
</style>
