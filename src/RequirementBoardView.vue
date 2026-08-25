<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon.vue";
import { cloneJsonData } from "./jsonData.js";
import { errText } from "./shared.js";
import { DEFAULT_DAY_HOURS, createRequirementItem, parseEstimateInput, requirementMetrics } from "./requirementMetrics.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["navigate"]);

const iterations = ref([]);
const dayHours = ref(DEFAULT_DAY_HOURS);
const loading = ref(true);
const search = ref("");
const iterationId = ref("");
const status = ref("all");
const showCreate = ref(false);
const createNameRef = ref(null);
const createIterationId = ref("");
const createName = ref("");
const createUrl = ref("");
const createEstimate = ref(""); // 预估天数原始字符串（先经 parseEstimateInput 门禁）
const saving = ref(false);

const COLUMNS = [
  { key: "small", label: "小需求", range: "< 10 天" },
  { key: "medium", label: "中需求", range: "10 - 29.99 天" },
  { key: "large", label: "大需求", range: "30 天及以上" },
  { key: "unestimated", label: "未评估", range: "暂无工时" },
];

async function load() {
  loading.value = true;
  try {
    const [data, settings] = await Promise.all([
      invoke("load_data", { key: "iterations" }),
      invoke("load_data", { key: "settings" }),
    ]);
    iterations.value = data || [];
    dayHours.value = Number(settings?.hoursReminder?.target) || DEFAULT_DAY_HOURS;
  } catch (e) {
    props.showToast("加载需求大盘失败：" + errText(e));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const allRequirements = computed(() => {
  const rows = [];
  for (const iteration of iterations.value) {
    for (const requirement of iteration.items || []) {
      rows.push({
        id: requirement.id,
        name: requirement.name || "未命名需求",
        url: requirement.url || "",
        done: !!requirement.done,
        iterationId: iteration.id,
        iterationTitle: iteration.title || "未命名迭代",
        iterationVersion: iteration.version || "",
        iterationStatus: iteration.status || "plan",
        metrics: requirementMetrics(requirement, dayHours.value),
      });
    }
  }
  return rows;
});

const filteredRequirements = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return allRequirements.value.filter((row) => {
    if (iterationId.value && row.iterationId !== iterationId.value) return false;
    if (status.value === "active" && row.done) return false;
    if (status.value === "done" && !row.done) return false;
    if (keyword && !`${row.name} ${row.iterationTitle} ${row.iterationVersion}`.toLowerCase().includes(keyword)) return false;
    return true;
  });
});

const grouped = computed(() => {
  const result = Object.fromEntries(COLUMNS.map((column) => [column.key, []]));
  for (const row of filteredRequirements.value) result[row.metrics.size.key].push(row);
  for (const list of Object.values(result)) {
    list.sort((a, b) => Number(b.metrics.overrun) - Number(a.metrics.overrun) || b.metrics.actualDays - a.metrics.actualDays || a.name.localeCompare(b.name, "zh-CN"));
  }
  return result;
});

const summary = computed(() => {
  let estimateDays = 0;
  let actualDays = 0;
  let completedDays = 0;
  let overrun = 0;
  for (const row of filteredRequirements.value) {
    if (row.metrics.estimateDays != null) {
      estimateDays += row.metrics.estimateDays;
    }
    actualDays += row.metrics.actualDays;
    completedDays += row.metrics.completedDays;
    if (row.metrics.overrun) overrun++;
  }
  return {
    total: filteredRequirements.value.length,
    estimateDays: round(estimateDays),
    actualDays: round(actualDays),
    completedDays: round(completedDays),
    overrun,
  };
});

function round(value) {
  return Math.round(value * 100) / 100;
}

function progressWidth(row) {
  return row.metrics.utilization == null ? 0 : Math.min(100, row.metrics.utilization);
}

function openRequirement(row) {
  emit("navigate", { module: "iteration", id: row.iterationId });
}

// ------- 新建需求弹窗 -------
function openCreate() {
  if (!iterations.value.length) {
    props.showToast("请先进入迭代页创建迭代");
    return;
  }
  createIterationId.value = iterationId.value || iterations.value[0].id;
  createName.value = "";
  createUrl.value = "";
  createEstimate.value = "";
  showCreate.value = true;
  window.addEventListener("keydown", onCreateEsc);
  setTimeout(() => createNameRef.value?.focus(), 30);
}
function closeCreate() {
  showCreate.value = false;
  window.removeEventListener("keydown", onCreateEsc);
  document.activeElement?.blur(); // 配置类弹窗关闭显式清焦点（DESIGN.md §3.3）
}
function onCreateEsc(e) {
  if (e.key === "Escape") closeCreate();
}
onUnmounted(() => {
  window.removeEventListener("keydown", onCreateEsc);
});

// 录入需求：名称必填，链接仅记录出处（本地化后不再从 Coding 自动带出标题）

async function saveCreate() {
  if (saving.value) return;
  const name = createName.value.trim();
  if (!name) return props.showToast("请填写需求名称");
  const target = iterations.value.find((x) => x.id === createIterationId.value);
  if (!target) return props.showToast("请选择目标迭代");
  const parsed = parseEstimateInput(createEstimate.value);
  if (!parsed.valid) return props.showToast("预估天数须为大于 0 的数字");
  saving.value = true;
  try {
    const snapshot = cloneJsonData(iterations.value);
    const host = snapshot.find((x) => x.id === target.id);
    if (!host) throw new Error("目标迭代不存在");
    const item = createRequirementItem({ name, url: createUrl.value.trim(), estimateDays: parsed.value });
    if (!item) throw new Error("需求数据无效");
    host.items = host.items || [];
    host.items.push(item);
    host.updatedAt = Date.now();
    const newRevision = await invoke("save_data", { key: "iterations", data: snapshot });
    iterations.value = snapshot; // 回写内存：computed 即时落列，无需刷新
    props.showToast(`已新增需求「${name}」`);
    closeCreate();
  } catch (e) {
    props.showToast("保存失败：" + errText(e)); // 保留后端错误细节
    await load(); // 重载最新数据；弹窗保持打开（表单独立 ref 不丢）
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="board-view">
    <div class="board-commandbar">
      <div class="board-controls">
        <div class="search-mini">
          <Icon name="search" :size="14" />
          <input v-model="search" placeholder="搜索需求或迭代" />
        </div>
        <select v-model="iterationId" class="board-select" aria-label="筛选迭代">
          <option value="">全部迭代</option>
          <option v-for="iteration in iterations" :key="iteration.id" :value="iteration.id">{{ iteration.title }}</option>
        </select>
        <div class="status-tabs">
          <button :class="{ active: status === 'active' }" @click="status = 'active'">进行中</button>
          <button :class="{ active: status === 'done' }" @click="status = 'done'">已完成</button>
          <button :class="{ active: status === 'all' }" @click="status = 'all'">全部</button>
        </div>
        <button class="btn-primary sm" @click="openCreate"><Icon name="plus" :size="14" /> 新建需求</button>
        <button class="icon-btn" title="刷新需求大盘" :disabled="loading" @click="load"><Icon name="repeat" :size="14" :class="{ spin: loading }" /></button>
      </div>
      <div class="metric-rail" :aria-label="`按 ${dayHours} 小时折算 1 人天`" :title="`按 ${dayHours} 小时折算 1 人天`">
        <div class="metric-item"><span>需求</span><b>{{ summary.total }}</b><em>项</em></div>
        <div class="metric-item"><span>预估</span><b>{{ summary.estimateDays }}</b><em>天</em></div>
        <div class="metric-item"><span>实际</span><b>{{ summary.actualDays }}</b><em>天</em></div>
        <div class="metric-item success"><span>已完成</span><b>{{ summary.completedDays }}</b><em>天</em></div>
        <div class="metric-item danger"><span>超额</span><b>{{ summary.overrun }}</b><em>项</em></div>
      </div>
    </div>

    <div v-if="loading" class="board-empty">正在加载需求...</div>
    <div v-else class="board-columns">
      <section v-for="column in COLUMNS" :key="column.key" class="board-column" :class="column.key">
        <header class="column-head">
          <div>
            <h3>{{ column.label }}</h3>
            <span>{{ column.range }}</span>
          </div>
          <b>{{ grouped[column.key].length }}</b>
        </header>

        <div class="column-list">
          <button v-for="row in grouped[column.key]" :key="row.iterationId + '-' + row.id" class="requirement-card" :class="{ overrun: row.metrics.overrun }" @click="openRequirement(row)">
            <div class="card-head">
              <span class="requirement-name" :title="row.name">{{ row.name }}</span>
              <span class="state-chip" :class="{ done: row.done }">{{ row.done ? "已完成" : "进行中" }}</span>
            </div>
            <div class="iteration-name" :title="row.iterationTitle">
              <Icon name="repeat" :size="11" /> {{ row.iterationTitle }}<template v-if="row.iterationVersion"> · {{ row.iterationVersion }}</template>
            </div>
            <div class="effort-grid">
              <div class="effort-item">
                <span>预估</span>
                <b>{{ row.metrics.estimateDays == null ? "未填写" : row.metrics.estimateDays + " 天" }}</b>
              </div>
              <div class="effort-item">
                <span>实际</span>
                <b>{{ row.metrics.actualDays }} 天</b>
                <em>{{ row.metrics.actualHours }}h</em>
              </div>
              <div class="effort-item completed">
                <span>已完成</span>
                <b>{{ row.metrics.completedDays }} 天</b>
              </div>
            </div>
            <div v-if="row.metrics.estimateDays != null" class="usage">
              <span><i :class="{ danger: row.metrics.overrun }" :style="{ width: progressWidth(row) + '%' }"></i></span>
              <b :class="{ danger: row.metrics.overrun }">{{ row.metrics.utilization }}%</b>
            </div>
            <div v-if="row.metrics.sizeSource !== 'estimate' || row.metrics.overrun" class="card-foot">
              <span v-if="row.metrics.sizeSource === 'actual'" class="source-chip">按实际人天定级</span>
              <span v-else-if="row.metrics.sizeSource === 'none'" class="source-chip">等待工时数据</span>
              <span v-if="row.metrics.overrun" class="overrun-chip"><Icon name="alert" :size="11" /> 超出 {{ row.metrics.overHours }}h</span>
            </div>
          </button>
          <div v-if="!grouped[column.key].length" class="column-empty">暂无需求</div>
        </div>
      </section>
    </div>

    <!-- ============ 新建需求弹窗（配置类：禁点遮罩，Esc 关闭） ============ -->
    <div v-if="showCreate" class="modal-mask">
      <div class="modal create-req-modal">
        <h2>新建需求</h2>

        <label class="cr-field">
          <span>目标迭代</span>
          <select v-model="createIterationId" class="board-select cr-select" aria-label="目标迭代">
            <option v-for="iteration in iterations" :key="iteration.id" :value="iteration.id">{{ iteration.title }}<template v-if="iteration.version"> · {{ iteration.version }}</template></option>
          </select>
        </label>
        <label class="cr-field">
          <span>需求名称</span>
          <input ref="createNameRef" v-model="createName" class="cr-input" placeholder="例如：对账中心导出优化" />
        </label>
        <label class="cr-field">
          <span>链接（可选，仅记录）</span>
          <input v-model="createUrl" class="cr-input" placeholder="粘贴需求链接或留空" />
        </label>
        <label class="cr-field">
          <span>预估天数（可选）</span>
          <input v-model="createEstimate" class="cr-input" placeholder="例如：3.5" />
        </label>

        <div class="modal-foot">
          <button class="btn-ghost" :disabled="saving" @click="closeCreate">取消</button>
          <button class="btn-primary" :disabled="saving || !iterations.length" @click="saveCreate">{{ saving ? "保存中..." : "保存" }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.board-view { min-height: 100%; padding: 20px 28px 28px; display: flex; flex-direction: column; gap: var(--sp-6); }
.board-commandbar { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-6); flex-wrap: wrap; padding-bottom: var(--sp-4); border-bottom: 1px solid var(--border); }
.board-controls { min-width: 0; display: flex; flex: 1 1 640px; align-items: center; gap: var(--sp-3); }
.search-mini { width: 300px; max-width: 100%; display: flex; flex: 1 1 240px; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-3); border: 1px solid transparent; border-radius: var(--r-sm); background: var(--well); color: var(--text-dim); }
.search-mini:focus-within { border-color: var(--primary); background: var(--card); box-shadow: 0 0 0 3px var(--primary-soft); }
.search-mini input { width: 100%; min-width: 0; padding: 9px 0; border: 0; outline: 0; color: var(--text); background: transparent; font-size: var(--fs-md); }
.board-select { min-height: 36px; padding: 0 var(--sp-4); border: 1px solid var(--border-strong); border-radius: var(--r-sm); color: var(--text); background: var(--card); font-size: var(--fs-md); outline: none; }
.board-select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.status-tabs { display: inline-flex; padding: 3px; gap: 2px; border-radius: var(--r-sm); background: var(--well); }
.status-tabs button { min-height: 28px; padding: 0 var(--sp-3); border: 0; border-radius: var(--r-xs); color: var(--text-dim); background: transparent; cursor: pointer; font-size: var(--fs-sm); }
.status-tabs button.active { color: var(--primary-hover); background: var(--card); box-shadow: var(--shadow); font-weight: 600; }
.metric-rail { display: flex; align-items: baseline; margin-left: auto; white-space: nowrap; }
.metric-item { display: flex; align-items: baseline; gap: 4px; padding: 0 var(--sp-4); }
.metric-item:first-child { padding-left: 0; }
.metric-item:last-child { padding-right: 0; }
.metric-item + .metric-item { border-left: 1px solid var(--border); }
.metric-item span { color: var(--text-dim); font-size: var(--fs-xs); }
.metric-item b { color: var(--text); font-family: var(--font-num); font-size: var(--fs-base); }
.metric-item em { color: var(--text-dim); font-size: var(--fs-xs); font-style: normal; }
.metric-item.success b { color: var(--success-deep); }
.metric-item.danger b { color: var(--danger-deep); }
.board-columns { flex: 1; min-height: 420px; display: grid; grid-template-columns: repeat(4, minmax(230px, 1fr)); gap: var(--sp-4); align-items: start; overflow-x: auto; padding-bottom: var(--sp-2); }
.board-column { min-width: 230px; display: flex; flex-direction: column; gap: var(--sp-3); }
.column-head { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: 0 var(--sp-3) var(--sp-2); border-bottom: 2px solid var(--border-strong); }
.board-column.small .column-head { border-color: var(--teal-deep); }
.board-column.medium .column-head { border-color: var(--warn-deep); }
.board-column.large .column-head { border-color: var(--danger-deep); }
.column-head h3 { margin: 0; font-size: var(--fs-base); }
.column-head span { color: var(--text-dim); font-size: var(--fs-xs); }
.column-head b { min-width: 24px; height: 24px; display: grid; place-items: center; padding: 0 var(--sp-2); border-radius: var(--r-pill); color: var(--text-soft); background: var(--well); font-family: var(--font-num); font-size: var(--fs-sm); }
.column-list { display: flex; flex-direction: column; gap: var(--sp-3); }
.requirement-card { width: 100%; min-height: 164px; padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); text-align: left; border: 1px solid var(--card-border); border-radius: var(--r-md); color: var(--text); background: var(--card); box-shadow: var(--shadow); cursor: pointer; transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s; }
.requirement-card:hover { transform: translateY(-2px); border-color: var(--border-blue); box-shadow: var(--shadow); }
.requirement-card.overrun { border-color: var(--border-danger); box-shadow: inset 3px 0 0 var(--danger), var(--shadow); }
.card-head { min-width: 0; display: flex; align-items: flex-start; gap: var(--sp-2); }
.requirement-name { flex: 1; min-width: 0; display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; font-weight: 600; font-size: var(--fs-md); line-height: 1.5; }
.state-chip, .source-chip, .overrun-chip { flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px; border-radius: var(--r-pill); font-size: var(--fs-xs); }
.state-chip { color: var(--primary-hover); background: var(--primary-soft); }
.state-chip.done { color: var(--success-deep); background: var(--success-soft); }
.iteration-name { min-width: 0; display: flex; align-items: center; gap: 4px; overflow: hidden; color: var(--text-dim); font-size: var(--fs-xs); white-space: nowrap; text-overflow: ellipsis; }
.effort-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: var(--sp-2) 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.effort-item { min-width: 0; padding: 0 var(--sp-3); }
.effort-item:first-child { padding-left: 0; }
.effort-item:last-child { padding-right: 0; }
.effort-item + .effort-item { border-left: 1px solid var(--border); }
.effort-item span { display: block; color: var(--text-dim); font-size: var(--fs-xs); }
.effort-item b { display: block; margin-top: var(--sp-1); overflow: hidden; font-family: var(--font-num); font-size: var(--fs-md); text-overflow: ellipsis; white-space: nowrap; }
.effort-item em { display: block; margin-top: 2px; color: var(--text-dim); font-family: var(--font-num); font-size: var(--fs-xs); font-style: normal; }
.effort-item.completed b { color: var(--success-deep); }
.usage { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: var(--sp-2); }
.usage > span { height: 5px; overflow: hidden; border-radius: var(--r-pill); background: var(--well); }
.usage i { height: 100%; display: block; border-radius: inherit; background: var(--primary); }
.usage i.danger { background: var(--danger); }
.usage b { color: var(--text-dim); font-family: var(--font-num); font-size: var(--fs-xs); }
.usage b.danger { color: var(--danger-deep); }
.card-foot { min-height: 20px; display: flex; justify-content: space-between; gap: var(--sp-2); margin-top: auto; }
.source-chip { color: var(--text-dim); background: var(--well); }
.overrun-chip { margin-left: auto; color: var(--danger-deep); background: var(--danger-soft); font-weight: 600; }
.column-empty, .board-empty { padding: 32px var(--sp-4); text-align: center; color: var(--text-dim); font-size: var(--fs-sm); }
@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 0.9s linear infinite; }

/* 新建需求弹窗 */
.create-req-modal { width: 460px; }
.cr-field { display: flex; flex-direction: column; gap: var(--sp-1); margin-bottom: var(--sp-4); }
.cr-field > span { font-size: var(--fs-sm); color: var(--text-dim); }
.cr-select { width: 100%; }
.cr-input { width: 100%; min-height: 36px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); color: var(--text); background: var(--card); font-size: var(--fs-md); outline: none; }
.cr-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
@media (prefers-color-scheme: dark) {
  .cr-input { background: var(--card-raised); }
}

@media (max-width: 1280px) {
  .board-commandbar { align-items: flex-start; }
  .board-controls { width: 100%; display: grid; grid-template-columns: minmax(180px, 1fr) minmax(120px, 180px) auto auto; }
  .search-mini { width: auto; }
  .board-select { width: 100%; min-width: 0; }
  .metric-rail { width: 100%; margin-left: 0; }
  .board-columns { grid-template-columns: repeat(4, minmax(250px, 1fr)); }
}

@media (max-width: 900px) {
  .board-controls { grid-template-columns: minmax(120px, 1fr) auto auto; }
  .search-mini { grid-column: 1 / -1; max-width: none; }
  .metric-rail { overflow-x: auto; padding-bottom: var(--sp-1); }
}
</style>
