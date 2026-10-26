<script setup>
import { computed, onMounted, onBeforeUnmount, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { mutate, onDataChanged } from "../data/repository.js";
import Icon from "../ui/Icon.vue";
import { errText } from "../shared/errors.js";
import { DEFAULT_DAY_HOURS, createRequirementItem, parseEstimateInput, requirementMetrics } from "../requirementMetrics.js";
import { vDialog } from '../ui/dialog.js'; // 模板里的 v-dialog 由 <script setup> 就地解析（SSR 渲染测试也能用）

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["navigate"]);
const { t } = useI18n();

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

// 分档标题与区间说明都进字典：中文是「小需求 / < 10 天」，英文同样要能独立成立
const COLUMNS = computed(() => [
  { key: "small", label: t("requirement.colSmall"), range: t("requirement.colSmallRange") },
  { key: "medium", label: t("requirement.colMedium"), range: t("requirement.colMediumRange") },
  { key: "large", label: t("requirement.colLarge"), range: t("requirement.colLargeRange") },
  { key: "unestimated", label: t("requirement.colUnestimated"), range: t("requirement.colUnestimatedRange") },
]);

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
    props.showToast(t("requirement.loadFailed", { err: errText(e) }));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
// Agent / 迭代页 / 任务页改了迭代：无录入弹窗时重新加载；弹窗打开时保持不动（表单独立 ref）
let offDataChanged = null;
onMounted(() => {
  offDataChanged = onDataChanged(async ({ kind, source }) => {
    if (kind !== "iterations" || source === "view" || showCreate.value) return;
    await load();
  });
});
onBeforeUnmount(() => offDataChanged?.());

const allRequirements = computed(() => {
  const rows = [];
  for (const iteration of iterations.value) {
    for (const requirement of iteration.items || []) {
      rows.push({
        id: requirement.id,
        name: requirement.name || t("requirement.untitledRequirement"),
        url: requirement.url || "",
        done: !!requirement.done,
        iterationId: iteration.id,
        iterationTitle: iteration.title || t("requirement.untitledIteration"),
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
  const result = Object.fromEntries(COLUMNS.value.map((column) => [column.key, []]));
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

/** 「按 N 小时折算 1 人天」——这条说明决定了一整列数字怎么读，所以它必须随语言走 */
const dayHoursHint = computed(() => t("requirement.dayHoursHint", { h: dayHours.value }));

function progressWidth(row) {
  return row.metrics.utilization == null ? 0 : Math.min(100, row.metrics.utilization);
}

function openRequirement(row) {
  emit("navigate", { module: "work", tab: "iteration", id: row.iterationId });
}

/** 没有迭代时的空态出口：把人送到「迭代」页，而不是给一个点了必然失败的「新建需求」 */
function goIteration() {
  emit("navigate", { module: "work", tab: "iteration", id: null });
}

// ------- 新建需求弹窗 -------
function openCreate() {
  if (!iterations.value.length) {
    props.showToast(t("requirement.needIterationFirst"));
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
  if (!name) return props.showToast(t("requirement.nameRequired"));
  const target = iterations.value.find((x) => x.id === createIterationId.value);
  if (!target) return props.showToast(t("requirement.pickIteration"));
  const parsed = parseEstimateInput(createEstimate.value);
  if (!parsed.valid) return props.showToast(t("requirement.estimateInvalid"));
  saving.value = true;
  try {
    const item = createRequirementItem({ name, url: createUrl.value.trim(), estimateDays: parsed.value });
    if (!item) throw new Error(t("requirement.badData"));
    const targetId = target.id;
    // 读最新 → 追加需求 → 带修订号写回：与迭代页/任务页/Agent 的写入不再整表互相覆盖
    iterations.value = await mutate("iterations", (fresh) => {
      const host = fresh.find((x) => x.id === targetId);
      if (!host) throw new Error(t("requirement.hostMissing"));
      host.items = Array.isArray(host.items) ? host.items : [];
      host.items.push(item);
      host.updatedAt = Date.now();
      return fresh;
    }, { source: "view" });
    props.showToast(t("requirement.added", { name }));
    closeCreate();
  } catch (e) {
    props.showToast(t("requirement.saveFailed", { err: errText(e) })); // 保留后端错误细节
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
          <input v-model="search" :placeholder="t('requirement.searchPh')" />
        </div>
        <select v-model="iterationId" class="board-select" :aria-label="t('requirement.filterIteration')">
          <option value="">{{ t("requirement.allIterations") }}</option>
          <option v-for="iteration in iterations" :key="iteration.id" :value="iteration.id">{{ iteration.title }}</option>
        </select>
        <div class="status-tabs">
          <button :class="{ active: status === 'active' }" @click="status = 'active'">{{ t("requirement.filterActive") }}</button>
          <button :class="{ active: status === 'done' }" @click="status = 'done'">{{ t("requirement.filterDone") }}</button>
          <button :class="{ active: status === 'all' }" @click="status = 'all'">{{ t("requirement.filterAll") }}</button>
        </div>
        <button class="btn-primary sm" @click="openCreate"><Icon name="plus" :size="14" /> {{ t("requirement.createBtn") }}</button>
        <button class="icon-btn" :title="t('requirement.refresh')" :disabled="loading" @click="load"><Icon name="repeat" :size="14" :class="{ spin: loading }" /></button>
      </div>
      <div class="metric-rail" :aria-label="dayHoursHint" :title="dayHoursHint">
        <div class="metric-item"><span>{{ t("requirement.mTotal") }}</span><b>{{ summary.total }}</b><em>{{ t("requirement.unitCount") }}</em></div>
        <div class="metric-item"><span>{{ t("requirement.mEstimate") }}</span><b>{{ summary.estimateDays }}</b><em>{{ t("requirement.unitDays") }}</em></div>
        <div class="metric-item"><span>{{ t("requirement.mActual") }}</span><b>{{ summary.actualDays }}</b><em>{{ t("requirement.unitDays") }}</em></div>
        <div class="metric-item success"><span>{{ t("requirement.mCompleted") }}</span><b>{{ summary.completedDays }}</b><em>{{ t("requirement.unitDays") }}</em></div>
        <div class="metric-item danger"><span>{{ t("requirement.mOverrun") }}</span><b>{{ summary.overrun }}</b><em>{{ t("requirement.unitCount") }}</em></div>
      </div>
    </div>

    <div v-if="loading" class="board-empty">{{ t("requirement.loading") }}</div>
    <!-- 一条迭代都没有时，四列各喊一遍「去迭代页」太吵：说明放在顶部一条，列里只留标题 -->
    <p v-if="!loading && !iterations.length" class="tc-note tc-note--info board-hint">
      <Icon name="repeat" :size="15" />
      <span>{{ t("requirement.needIterationFirst") }}</span>
      <button class="btn-outline sm" type="button" @click="goIteration">
        <Icon name="repeat" :size="13" />{{ t("requirement.openIterationBtn") }}
      </button>
    </p>
    <div v-if="!loading" class="board-columns">
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
              <span class="state-chip" :class="{ done: row.done }">{{ row.done ? t("requirement.stateDone") : t("requirement.stateActive") }}</span>
            </div>
            <div class="iteration-name" :title="row.iterationTitle">
              <Icon name="repeat" :size="11" /> {{ row.iterationTitle }}<template v-if="row.iterationVersion"> · {{ row.iterationVersion }}</template>
            </div>
            <div class="effort-grid">
              <div class="effort-item">
                <span>{{ t("requirement.eEstimate") }}</span>
                <b>{{ row.metrics.estimateDays == null ? t("requirement.notFilled") : row.metrics.estimateDays + " " + t("requirement.unitDays") }}</b>
              </div>
              <div class="effort-item">
                <span>{{ t("requirement.eActual") }}</span>
                <b>{{ row.metrics.actualDays }} {{ t("requirement.unitDays") }}</b>
                <em>{{ row.metrics.actualHours }}h</em>
              </div>
              <div class="effort-item completed">
                <span>{{ t("requirement.mCompleted") }}</span>
                <b>{{ row.metrics.completedDays }} {{ t("requirement.unitDays") }}</b>
              </div>
            </div>
            <div v-if="row.metrics.estimateDays != null" class="usage">
              <span><i :class="{ danger: row.metrics.overrun }" :style="{ width: progressWidth(row) + '%' }"></i></span>
              <b :class="{ danger: row.metrics.overrun }">{{ row.metrics.utilization }}%</b>
            </div>
            <div v-if="row.metrics.sizeSource !== 'estimate' || row.metrics.overrun" class="card-foot">
              <span v-if="row.metrics.sizeSource === 'actual'" class="source-chip">{{ t("requirement.sizedByActual") }}</span>
              <span v-else-if="row.metrics.sizeSource === 'none'" class="source-chip">{{ t("requirement.awaitingHours") }}</span>
              <span v-if="row.metrics.overrun" class="overrun-chip"><Icon name="alert" :size="11" /> {{ t("requirement.overBy", { h: row.metrics.overHours }) }}</span>
            </div>
          </button>
          <!-- 空态给下一步，而不是「暂无需求」四个字（规范 §4：空态文案的判据是这句话是不是废话）。
               没有迭代时按钮不打开一个必然保存失败的弹窗，而是把人送去迭代页。 -->
          <div v-if="!grouped[column.key].length" class="empty sm column-empty">
            <span class="empty-ico"><Icon :name="iterations.length ? 'plus' : 'layers'" :size="18" /></span>
            <p class="ce-title">{{ t("requirement.columnEmptyTitle", { label: column.label }) }}</p>
            <template v-if="iterations.length">
              <p class="ce-hint">{{ t("requirement.columnEmptyHint") }}</p>
              <button class="btn-ghost sm" type="button" @click="openCreate">
                <Icon name="plus" :size="13" />{{ t("requirement.createBtn") }}
              </button>
            </template>
          </div>
        </div>
      </section>
    </div>

    <!-- ============ 新建需求弹窗（配置类：禁点遮罩，Esc 关闭） ============ -->
    <div v-if="showCreate" class="modal-mask">
      <div class="modal create-req-modal" v-dialog>
        <h2>{{ t("requirement.createTitle") }}</h2>

        <label class="cr-field">
          <span>{{ t("requirement.targetIteration") }}</span>
          <select v-model="createIterationId" class="board-select cr-select" :aria-label="t('requirement.targetIteration')">
            <option v-for="iteration in iterations" :key="iteration.id" :value="iteration.id">{{ iteration.title }}<template v-if="iteration.version"> · {{ iteration.version }}</template></option>
          </select>
        </label>
        <label class="cr-field">
          <span>{{ t("requirement.nameLabel") }}</span>
          <input ref="createNameRef" v-model="createName" class="cr-input" :placeholder="t('requirement.namePh')" />
        </label>
        <label class="cr-field">
          <span>{{ t("requirement.urlLabel") }}</span>
          <input v-model="createUrl" class="cr-input" :placeholder="t('requirement.urlPh')" />
        </label>
        <label class="cr-field">
          <span>{{ t("requirement.estimateLabel") }}</span>
          <input v-model="createEstimate" class="cr-input" :placeholder="t('requirement.estimatePh')" />
        </label>

        <div class="modal-foot">
          <button class="btn-ghost" :disabled="saving" @click="closeCreate">{{ t("common.cancel") }}</button>
          <button class="btn-primary" :disabled="saving || !iterations.length" @click="saveCreate">{{ saving ? t("requirement.saving") : t("requirement.saveBtn") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.board-view { min-height: 100%; padding: var(--sp-7) 28px 28px; display: flex; flex-direction: column; gap: var(--sp-6); }
.board-commandbar { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-6); flex-wrap: wrap; padding-bottom: var(--sp-4); border-bottom: 1px solid var(--border); }
.board-controls { min-width: 0; display: flex; flex: 1 1 640px; align-items: center; gap: var(--sp-3); }
.search-mini { width: 300px; max-width: 100%; display: flex; flex: 1 1 240px; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-3); border: 1px solid transparent; border-radius: var(--r-sm); background: var(--well); color: var(--text-dim); }
.search-mini:focus-within { border-color: var(--primary); background: var(--card); box-shadow: 0 0 0 3px var(--primary-soft); }
.search-mini input { width: 100%; min-width: 0; padding: 9px 0; border: 0; outline: 0; color: var(--text); background: transparent; font-size: var(--fs-md); }
.board-select { min-height: 36px; padding: 0 var(--sp-4); border: 1px solid var(--border-strong); border-radius: var(--r-sm); color: var(--text); background: var(--card); font-size: var(--fs-md); outline: none; }
.board-select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.status-tabs { display: inline-flex; padding: 3px; gap: var(--sp-0); border-radius: var(--r-sm); background: var(--well); }
.status-tabs button { min-height: 28px; padding: 0 var(--sp-3); border: 0; border-radius: var(--r-xs); color: var(--text-dim); background: transparent; cursor: pointer; font-size: var(--fs-sm); }
.status-tabs button.active { color: var(--primary-hover); background: var(--card); box-shadow: var(--shadow); font-weight: 600; }
.metric-rail { display: flex; align-items: baseline; margin-left: auto; white-space: nowrap; }
.metric-item { display: flex; align-items: baseline; gap: var(--sp-05); padding: 0 var(--sp-4); }
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
.iteration-name { min-width: 0; display: flex; align-items: center; gap: var(--sp-05); overflow: hidden; color: var(--text-dim); font-size: var(--fs-xs); white-space: nowrap; text-overflow: ellipsis; }
.effort-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: var(--sp-2) 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.effort-item { min-width: 0; padding: 0 var(--sp-3); }
.effort-item:first-child { padding-left: 0; }
.effort-item:last-child { padding-right: 0; }
.effort-item + .effort-item { border-left: 1px solid var(--border); }
.effort-item span { display: block; color: var(--text-dim); font-size: var(--fs-xs); }
.effort-item b { display: block; margin-top: var(--sp-1); overflow: hidden; font-family: var(--font-num); font-size: var(--fs-md); text-overflow: ellipsis; white-space: nowrap; }
.effort-item em { display: block; margin-top: var(--sp-0); color: var(--text-dim); font-family: var(--font-num); font-size: var(--fs-xs); font-style: normal; }
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
.board-empty { padding: 32px var(--sp-4); text-align: center; color: var(--text-dim); font-size: var(--fs-sm); }
.board-hint { align-items: center; margin: 0 0 var(--sp-3); }
.board-hint > span { flex: 1; min-width: 0; }
/* 列内空态复用 .empty 的骨架（图标/标题/说明/动作），只压紧间距——一列只有约 300px 宽 */
.column-empty { padding: var(--sp-5) var(--sp-3); gap: var(--sp-2); }
.column-empty .ce-title { margin: 0; font-size: var(--fs-base); font-weight: 600; color: var(--text); }
.column-empty .ce-hint { margin: 0; font-size: var(--fs-sm); line-height: var(--lh-tight); color: var(--muted); }

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
