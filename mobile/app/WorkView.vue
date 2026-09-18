<script setup>
// 工作台（手机端）：迭代列表 → 迭代详情（需求）→ 需求详情（子任务）。
//
// 三层导航用应用内状态而不是路由：安卓上没有浏览器地址栏，返回键由 update 后的层级回退处理；
// 这与桌面端「多窗口 + 自由布局」是**有意的差异**（见 docs/mobile-app-plan.md §5）。
//
// 逻辑全部复用共享层：集合增删改走 src/tasks.js，工时/规模走 src/requirementMetrics.js，
// 汇总与排序在本页纯函数 work.js 里（已单测）。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { load as loadKind, mutate, onDataChanged } from "../../src/data/repository.js";
import { addIteration, addRequirement, addSubTask, newIteration, newRequirement, newSubTask, removeIteration, removeRequirement, removeSubTask, updateIteration, updateRequirement, updateSubTask } from "../../src/tasks.js";
import { ITERATION_STATUSES, filterRequirements, hoursText, iterationSummary, requirementLine, sortIterations } from "./work.js";

const { t } = useI18n();

const iterations = ref([]);
const loading = ref(true);
const error = ref("");
const view = reactive({ level: "list", iterId: "", reqId: "" }); // list | iter | req
const reqFilter = ref("active");
const draft = reactive({ open: false, kind: "", name: "", days: "" });
const confirmState = reactive({ open: false, kind: "", name: "" });

const currentIteration = computed(() => iterations.value.find((x) => x.id === view.iterId) || null);
const currentRequirement = computed(() => {
  const items = currentIteration.value?.items || [];
  return items.find((x) => x.id === view.reqId) || null;
});

const sorted = computed(() => sortIterations(iterations.value));
const visibleRequirements = computed(() => filterRequirements(currentIteration.value?.items || [], reqFilter.value));

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const records = await loadKind("iterations");
    iterations.value = Array.isArray(records) ? records : [];
  } catch (e) {
    error.value = e?.message || String(e);
    iterations.value = [];
  } finally {
    loading.value = false;
  }
}

/**
 * 所有写操作都经 repository.mutate：乐观锁 + 冲突重放 + 广播，与桌面视图同一写入口。
 *
 * ⚠️ tasks.js 的集合操作是**函数式**的（返回新数组，不就地改），所以必须把返回值交回 mutate。
 * 写成「就地修改 + 返回 undefined」会让改动被静默丢弃——不报错、界面也不变，极难排查（踩过一次）。
 */
async function write(transform) {
  try {
    await mutate("iterations", (fresh) => transform(Array.isArray(fresh) ? fresh : []));
    error.value = "";
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

let unsubscribe = null;
onMounted(async () => {
  await load();
  unsubscribe = onDataChanged(({ kind, source }) => {
    if (kind === "iterations" && source !== "view") load();
  });
});
onBeforeUnmount(() => unsubscribe?.());

/** 返回上一层；已到顶层返回 false，交给安卓侧决定是否退出应用。 */
function goBack() {
  if (view.level === "req") {
    view.level = "iter";
    view.reqId = "";
    return true;
  }
  if (view.level === "iter") {
    view.level = "list";
    view.iterId = "";
    return true;
  }
  return false;
}

function openIteration(iteration) {
  view.level = "iter";
  view.iterId = iteration.id;
}

function openRequirement(requirement) {
  view.level = "req";
  view.reqId = requirement.id;
}

function askAdd(kind) {
  Object.assign(draft, { open: true, kind, name: "", days: "" });
}

async function submitDraft() {
  const name = draft.name.trim();
  if (!name) {
    error.value = t("mobile.workNameRequired");
    return;
  }
  const kind = draft.kind;
  draft.open = false;
  if (kind === "iteration") {
    await write((list) => addIteration(list, newIteration({ title: name })));
  } else if (kind === "requirement") {
    await write((list) => addRequirement(list, view.iterId, newRequirement({ name })));
  } else {
    await write((list) => addSubTask(list, view.iterId, view.reqId, newSubTask({ name, hours: Number(draft.days) || 0 })));
  }
}

function askRemove(kind, name, id) {
  Object.assign(confirmState, { open: true, kind, name, id });
}

async function confirmRemove() {
  const { kind, id } = confirmState;
  Object.assign(confirmState, { open: false, kind: "", name: "", id: "" });
  if (kind === "iteration") {
    await write((list) => removeIteration(list, id));
    view.level = "list";
    view.iterId = "";
  } else if (kind === "requirement") {
    await write((list) => removeRequirement(list, view.iterId, id));
    view.level = "iter";
    view.reqId = "";
  } else {
    // 子任务：removeSubTask 在 tasks.js 里，和另外两层同一套集合 API
    await write((list) => removeSubTask(list, view.iterId, view.reqId, id));
  }
}

const toggleIterationStatus = (iteration) =>
  write((list) => {
    const next = ITERATION_STATUSES[(ITERATION_STATUSES.indexOf(iteration.status) + 1) % ITERATION_STATUSES.length];
    updateIteration(list, iteration.id, { status: next });
  });

const toggleRequirementDone = (requirement) =>
  write((list) => updateRequirement(list, view.iterId, requirement.id, { done: !requirement.done }));

const toggleSubtaskDone = (subtask) => write((list) => updateSubTask(list, view.iterId, view.reqId, subtask.id, { done: !subtask.done }));
</script>

<template>
  <section class="m-work" :data-level="view.level">
    <p v-if="error" class="m-err">{{ error }}</p>

    <!-- 第一层：迭代列表 -->
    <template v-if="view.level === 'list'">
      <div class="m-tools">
        <h2 class="m-h2">{{ t("nav.iteration") }}</h2>
        <button class="m-add" :title="t('mobile.workAddIteration')" @click="askAdd('iteration')">＋</button>
      </div>

      <p v-if="loading" class="m-empty">{{ t("common.loading") }}</p>
      <div v-else-if="!sorted.length" class="m-empty-box">
        <p class="m-empty-title">{{ t("mobile.workNoIteration") }}</p>
        <button class="m-empty-btn" @click="askAdd('iteration')">{{ t("mobile.workAddIteration") }}</button>
      </div>

      <ul v-else class="m-list">
        <li v-for="iteration in sorted" :key="iteration.id" class="m-item" :data-status="iteration.status">
          <button class="m-item-main" @click="openIteration(iteration)">
            <span class="m-item-title">{{ iteration.title || t("common.gsUntitled") }}</span>
            <span class="m-item-sub">
              <span class="m-status-chip" :data-status="iteration.status">{{ t(`mobile.status.${iteration.status}`) }}</span>
              {{ t("mobile.workReqProgress", { done: iterationSummary(iteration).done, total: iterationSummary(iteration).total }) }}
              · {{ hoursText(iterationSummary(iteration).actualHours) }}
            </span>
            <span class="m-bar" :aria-label="t('mobile.workProgress')"><i :style="{ width: iterationSummary(iteration).pct + '%' }"></i></span>
          </button>
          <div class="m-item-ops">
            <button class="m-op" @click="toggleIterationStatus(iteration)">{{ t("mobile.workNextStatus") }}</button>
            <button class="m-op danger" @click="askRemove('iteration', iteration.title, iteration.id)">{{ t("snippet.delete") }}</button>
          </div>
        </li>
      </ul>
    </template>

    <!-- 第二层：迭代详情（需求） -->
    <template v-else-if="view.level === 'iter' && currentIteration">
      <div class="m-tools">
        <button class="m-back" @click="goBack()">‹</button>
        <h2 class="m-h2">{{ currentIteration.title || t("common.gsUntitled") }}</h2>
        <button class="m-add" :title="t('mobile.workAddRequirement')" @click="askAdd('requirement')">＋</button>
      </div>

      <div class="m-chips">
        <button
          v-for="item in [
            { key: 'active', labelKey: 'problem.filterOpen' },
            { key: 'done', labelKey: 'problem.filterDone' },
            { key: 'all', labelKey: 'problem.filterAll' },
          ]"
          :key="item.key"
          class="m-chip"
          :class="{ on: reqFilter === item.key }"
          @click="reqFilter = item.key"
        >
          {{ t(item.labelKey) }}
        </button>
      </div>

      <p v-if="!visibleRequirements.length" class="m-empty">{{ t("mobile.workNoRequirement") }}</p>
      <ul v-else class="m-list">
        <li v-for="item in visibleRequirements" :key="item.id" class="m-item">
          <button class="m-item-main" @click="openRequirement(item)">
            <span class="m-item-title" :class="{ done: item.done }">{{ item.name || t("common.gsUntitled") }}</span>
            <span class="m-item-sub">
              <span v-if="requirementLine(item).size" class="m-size">{{ requirementLine(item).size }}</span>
              {{ t("mobile.workHours", { actual: hoursText(requirementLine(item).actualHours), estimate: requirementLine(item).estimateDays == null ? "—" : requirementLine(item).estimateDays + "d" }) }}
              <span v-if="requirementLine(item).overrun" class="m-over">{{ t("mobile.workOverrun", { hours: hoursText(requirementLine(item).overHours) }) }}</span>
            </span>
          </button>
          <div class="m-item-ops">
            <button class="m-op" :class="{ on: item.done }" @click="toggleRequirementDone(item)">{{ item.done ? t("problem.ctxReopen") : t("problem.ctxResolve") }}</button>
            <button class="m-op danger" @click="askRemove('requirement', item.name, item.id)">{{ t("snippet.delete") }}</button>
          </div>
        </li>
      </ul>
    </template>

    <!-- 第三层：需求详情（子任务） -->
    <template v-else-if="view.level === 'req' && currentRequirement">
      <div class="m-tools">
        <button class="m-back" @click="goBack()">‹</button>
        <h2 class="m-h2">{{ currentRequirement.name || t("common.gsUntitled") }}</h2>
        <button class="m-add" :title="t('mobile.workAddSubtask')" @click="askAdd('subtask')">＋</button>
      </div>

      <p v-if="!(currentRequirement.subtasks || []).length" class="m-empty">{{ t("mobile.workNoSubtask") }}</p>
      <ul v-else class="m-list">
        <li v-for="subtask in currentRequirement.subtasks || []" :key="subtask.id" class="m-item">
          <button class="m-item-main" @click="toggleSubtaskDone(subtask)">
            <span class="m-item-title" :class="{ done: subtask.done }">{{ subtask.done ? "✓ " : "○ " }}{{ subtask.name || t("common.gsUntitled") }}</span>
            <span class="m-item-sub">{{ hoursText(subtask.hours || 0) }} · {{ subtask.date || "" }}</span>
          </button>
          <div class="m-item-ops">
            <button class="m-op danger" @click="askRemove('subtask', subtask.name, subtask.id)">{{ t("snippet.delete") }}</button>
          </div>
        </li>
      </ul>
    </template>

    <!-- 新建弹层：三种层级共用（迭代 / 需求 / 子任务） -->
    <div v-if="draft.open" class="m-modal">
      <div class="m-modal-card">
        <b>{{ t(draft.kind === "iteration" ? "mobile.workAddIteration" : draft.kind === "requirement" ? "mobile.workAddRequirement" : "mobile.workAddSubtask") }}</b>
        <label class="m-field">
          <span>{{ t("snippet.formTitle") }}</span>
          <input v-model="draft.name" :placeholder="t('snippet.formTitlePh')" autofocus />
        </label>
        <label v-if="draft.kind === 'subtask'" class="m-field">
          <span>{{ t("mobile.workHoursLabel") }}</span>
          <input v-model="draft.days" type="number" min="0" step="0.5" inputmode="decimal" />
        </label>
        <div class="m-modal-ops">
          <button class="m-modal-cancel" @click="draft.open = false">{{ t("common.cancel") }}</button>
          <button class="m-modal-ok primary" @click="submitDraft">{{ t("snippet.saveBtn") }}</button>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="confirmState.open" class="m-modal">
      <div class="m-modal-card">
        <b>{{ t("snippet.deleteTitle") }}</b>
        <p>{{ confirmState.name }}</p>
        <div class="m-modal-ops">
          <button class="m-modal-cancel" @click="confirmState.open = false">{{ t("common.cancel") }}</button>
          <button class="m-modal-ok" @click="confirmRemove">{{ t("snippet.deleteOk") }}</button>
        </div>
      </div>
    </div>
  </section>
</template>
