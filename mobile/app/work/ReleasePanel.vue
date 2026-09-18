<script setup>
// 发布（手机端）：发布池列表 + 每条的发布状态与步骤进度。
//
// 与桌面端 ReleaseView 的关系：**数据模型与纯逻辑完全一致**——
// release-pools 是 `{ active, archived }` 对象（repository 的 releases 类别），
// 状态徽标与步骤进度直接用 src/publishState.js（releaseBadge / releaseDetail /
// RELEASE_STEPS / doneStepsCount），所以"什么算发布成功、进行到第几步"两端同一套判定。
//
// **刻意不做**的桌面专属能力（不是偷懒，是平台上没有）：
//   · 从 Coding 拉项目列表（要平台账号 + 桌面端已配好的凭据）
//   · 批量导入仓库路径、git pull（安卓上没有本地仓库）
//   · 真实部署（桌面端把命令下发到构建机；手机端只做**状态记录与查看**）
// 手机端保留的是"在手机上最需要的那部分"：看哪个池发到哪一步了、改状态、记录结果。
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { load as loadKind, mutate, onDataChanged } from "../../../src/data/repository.js";
import { RELEASE_STEPS, doneStepsCount, releaseBadge, releaseDetail } from "../../../src/publishState.js";
import { DEPLOY_TYPES, makeLocalPool, nameConflict, poolDeployMode } from "../../../src/releasePools.js";

const { t } = useI18n();

const active = ref([]);
const archived = ref([]);
const loading = ref(true);
const error = ref("");
const notice = ref("");
const tab = ref("active"); // active | archived
const expanded = ref({}); // poolId -> 是否展开步骤

const form = reactive({ open: false, id: "", name: "", deployType: "auto" });
const confirmState = reactive({ open: false, id: "", name: "" });

async function load() {
  error.value = "";
  try {
    const raw = await loadKind("releases");
    // repository 的 object 类归一化会保证拿到 {active, archived}，但仍要防脏数据
    active.value = Array.isArray(raw?.active) ? raw.active : [];
    archived.value = Array.isArray(raw?.archived) ? raw.archived : [];
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

let offChanged = null;
onMounted(() => {
  load();
  offChanged = onDataChanged(({ kind, source }) => {
    // 只关心发布池与领域 Pool 的变化；忽略自己写的（否则循环）
    if (source !== "view" && (kind === "releases" || kind === "pools")) load();
  });
});
onUnmounted(() => offChanged?.());

const list = computed(() => (tab.value === "active" ? active.value : archived.value));

/** 发布徽标（success/failed/deploying），没有发布记录时为 null。 */
const badgeOf = (pool) => releaseBadge(pool);

/** 步骤进度：已完成的步骤数与当前步骤名。 */
function stepProgress(pool) {
  const release = pool.lastRelease;
  if (!release) return null;
  const done = doneStepsCount(release);
  const detail = releaseDetail(pool);
  return { done, total: RELEASE_STEPS.length, detail };
}

/** 部署方式（容器 / 主机）——桌面端按名字前缀推断，这里用同一个函数。 */
const deployModeOf = (pool) => poolDeployMode(pool);

const STEPS = RELEASE_STEPS;

function toggle(pool) {
  expanded.value = { ...expanded.value, [pool.id]: !expanded.value[pool.id] };
}

// ---------- 新增 / 编辑 ----------
function openCreate() {
  Object.assign(form, { open: true, id: "", name: "", deployType: "auto" });
}
function openEdit(pool) {
  Object.assign(form, { open: true, id: pool.id, name: pool.name, deployType: pool.deployType || "auto" });
}

async function save() {
  const name = form.name.trim();
  if (!name) {
    error.value = t("mobile.releaseNeedName");
    return;
  }
  // 重名检查用共享的 nameConflict：桌面端也是这个规则（编辑时忽略自己）
  const others = [...active.value, ...archived.value];
  if (nameConflict(name, others, form.id)) {
    error.value = t("mobile.releaseDup", { name });
    return;
  }
  error.value = "";
  try {
    await mutate(
      "releases",
      (current) => {
        const currentActive = Array.isArray(current?.active) ? current.active : [];
        const currentArchived = Array.isArray(current?.archived) ? current.archived : [];
        if (form.id) {
          const patch = (pool) => (pool.id === form.id ? { ...pool, name, deployType: form.deployType, updatedAt: Date.now() } : pool);
          return { active: currentActive.map(patch), archived: currentArchived.map(patch) };
        }
        // 新建用共享的 makeLocalPool，保证字段与桌面端一致（id/createdAt/updatedAt/codingProject…）
        const created = { ...makeLocalPool(name), deployType: form.deployType };
        return { active: [created, ...currentActive], archived: currentArchived };
      },
      { source: "view" }
    );
    form.open = false;
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

// ---------- 归档 / 恢复 / 删除 ----------
async function move(id, toArchived) {
  error.value = "";
  try {
    await mutate(
      "releases",
      (current) => {
        const currentActive = Array.isArray(current?.active) ? current.active : [];
        const currentArchived = Array.isArray(current?.archived) ? current.archived : [];
        // ⚠️ 两个列表要**各自**增删，不能把两个列表拼起来再分配：
        // 拼起来后 `rest` 会同时包含原本已归档的项，把它们倒进 active（实测踩过：
        // 归档一条后 active 里凭空多出一条本该归档的记录，列表数量还不变）。
        const target = currentActive.find((pool) => pool.id === id) || currentArchived.find((pool) => pool.id === id);
        if (!target) return { active: currentActive, archived: currentArchived };
        if (toArchived) {
          return {
            active: currentActive.filter((pool) => pool.id !== id),
            archived: [target, ...currentArchived.filter((pool) => pool.id !== id)],
          };
        }
        return {
          active: [target, ...currentActive.filter((pool) => pool.id !== id)],
          archived: currentArchived.filter((pool) => pool.id !== id),
        };
      },
      { source: "view" }
    );
    notice.value = toArchived ? t("mobile.releaseArchived") : t("mobile.releaseRestored");
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

async function doRemove() {
  const { id } = confirmState;
  confirmState.open = false;
  error.value = "";
  try {
    await mutate(
      "releases",
      (current) => ({
        active: (Array.isArray(current?.active) ? current.active : []).filter((pool) => pool.id !== id),
        archived: (Array.isArray(current?.archived) ? current.archived : []).filter((pool) => pool.id !== id),
      }),
      { source: "view" }
    );
    notice.value = t("mobile.releaseRemoved");
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

// ---------- 发布状态记录（手机上最常用的动作） ----------
/**
 * 推进发布状态。桌面端的发布流程由构建机驱动，手机端只做**记录**：
 * 这让"我在外面想知道发到哪了/手动标记结果"成为可能，而不假装能触发部署。
 */
async function setStatus(pool, status) {
  error.value = "";
  const steps = STEPS.map((step) => ({ key: step.key, done: status === "done" ? true : Boolean((pool.lastRelease?.steps || []).find((s) => s.key === step.key)?.done) }));
  try {
    await mutate(
      "releases",
      (current) => {
        const patch = (item) =>
          item.id === pool.id
            ? { ...item, lastRelease: { status, steps, updatedAt: Date.now(), startedAt: item.lastRelease?.startedAt || Date.now() } }
            : item;
        return {
          active: (Array.isArray(current?.active) ? current.active : []).map(patch),
          archived: (Array.isArray(current?.archived) ? current.archived : []).map(patch),
        };
      },
      { source: "view" }
    );
    notice.value = t(`mobile.releaseStatus_${status}`);
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

/** 勾选单个步骤（进行中时逐步打勾）。 */
async function toggleStep(pool, stepKey) {
  const current = pool.lastRelease || { status: "doing", steps: [] };
  const steps = STEPS.map((step) => {
    const existing = (current.steps || []).find((s) => s.key === step.key);
    const done = step.key === stepKey ? !existing?.done : Boolean(existing?.done);
    return { key: step.key, done };
  });
  const allDone = steps.every((step) => step.done);
  try {
    await mutate(
      "releases",
      (data) => {
        const patch = (item) => (item.id === pool.id ? { ...item, lastRelease: { ...current, status: allDone ? "done" : "doing", steps, updatedAt: Date.now() } } : item);
        return {
          active: (Array.isArray(data?.active) ? data.active : []).map(patch),
          archived: (Array.isArray(data?.archived) ? data.archived : []).map(patch),
        };
      },
      { source: "view" }
    );
    await load();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}
</script>

<template>
  <section class="m-release" :data-tab="tab">
    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
    <p v-if="loading" class="m-empty">{{ t("common.loading") }}</p>

    <template v-else>
      <div class="m-tools">
        <h2 class="m-h2">{{ t("nav.release") }}</h2>
        <button class="m-add" :title="t('mobile.releaseAdd')" data-role="add-release" @click="openCreate">＋</button>
      </div>

      <!-- 面板内部标签用 data-release-tab，**不复用 data-nav**：
           data-nav 是工作台分段（概览/迭代/领域/发布）的标识，
           两处同名会让选择器与语义都产生歧义（实测踩过一次）。 -->
      <div class="m-chips" data-role="release-tabs">
        <button class="m-chip" :class="{ on: tab === 'active' }" data-release-tab="active" @click="tab = 'active'">
          {{ t("mobile.releaseActive") }} ({{ active.length }})
        </button>
        <button class="m-chip" :class="{ on: tab === 'archived' }" data-release-tab="archived" @click="tab = 'archived'">
          {{ t("mobile.releaseArchivedTab") }} ({{ archived.length }})
        </button>
      </div>

      <p v-if="!list.length" class="m-hint-sm" data-role="no-releases">{{ t("mobile.releaseEmpty") }}</p>
      <ul v-else class="m-list" data-role="releases">
        <li v-for="pool in list" :key="pool.id" class="m-item" :data-release="pool.id" :data-badge="badgeOf(pool) || 'none'">
          <button class="m-item-main" data-role="release-name" @click="toggle(pool)">
            <span class="m-item-title">
              {{ pool.name }}
              <!-- 状态徽标：一眼看出成功/失败/进行中 -->
              <span v-if="badgeOf(pool)" class="m-badge" :data-badge="badgeOf(pool)" data-role="badge">
                {{ t(`mobile.badge_${badgeOf(pool)}`) }}
              </span>
            </span>
            <span class="m-item-sub">
              {{ t(`mobile.deploy_${deployModeOf(pool)}`) }}
              <template v-if="stepProgress(pool)"> · {{ t("mobile.releaseSteps", { done: stepProgress(pool).done, total: stepProgress(pool).total }) }}</template>
            </span>
          </button>

          <div class="m-item-ops">
            <button class="m-op" data-role="edit-release" @click="openEdit(pool)">{{ t("common.edit") }}</button>
            <button class="m-op" data-role="toggle-archive" @click="move(pool.id, tab === 'active')">
              {{ tab === "active" ? t("mobile.releaseArchive") : t("mobile.releaseRestore") }}
            </button>
            <button class="m-op danger" data-role="remove-release" @click="Object.assign(confirmState, { open: true, id: pool.id, name: pool.name })">
              {{ t("common.delete") }}
            </button>
          </div>

          <!-- 展开：步骤勾选 + 状态记录 -->
          <div v-if="expanded[pool.id]" class="m-steps" data-role="steps">
            <ul class="m-stats">
              <li v-for="step in STEPS" :key="step.key" :data-step="step.key">
                <b>
                  <input
                    type="checkbox"
                    :checked="Boolean((pool.lastRelease?.steps || []).find((s) => s.key === step.key)?.done)"
                    :data-role="`step-${step.key}`"
                    @change="toggleStep(pool, step.key)"
                  />
                  {{ step.label }}
                </b>
                <span></span>
              </li>
            </ul>
            <div class="m-actions">
              <button class="m-btn" data-role="mark-doing" @click="setStatus(pool, 'doing')">{{ t("mobile.releaseMarkDoing") }}</button>
              <button class="m-btn primary" data-role="mark-done" @click="setStatus(pool, 'done')">{{ t("mobile.releaseMarkDone") }}</button>
              <button class="m-btn danger" data-role="mark-failed" @click="setStatus(pool, 'failed')">{{ t("mobile.releaseMarkFailed") }}</button>
            </div>
          </div>
        </li>
      </ul>

      <p class="m-hint-sm">{{ t("mobile.releaseNote") }}</p>
    </template>

    <!-- 表单 -->
    <div v-if="form.open" class="m-sheet" data-role="release-form">
      <header class="m-sheet-head">
        <button class="m-sheet-cancel" @click="form.open = false">{{ t("common.cancel") }}</button>
        <b>{{ form.id ? t("common.edit") : t("mobile.releaseAdd") }}</b>
        <button class="m-sheet-save" data-role="save-release" @click="save">{{ t("common.confirm") }}</button>
      </header>
      <div class="m-sheet-body">
        <label class="m-field">
          <span>{{ t("mobile.releaseName") }}</span>
          <input v-model="form.name" data-role="release-name-input" placeholder="online.wms.outward" />
        </label>
        <label class="m-field">
          <span>{{ t("mobile.releaseDeploy") }}</span>
          <select v-model="form.deployType" data-role="release-deploy">
            <option value="auto">{{ t("mobile.deployAuto") }}</option>
            <option v-for="type in DEPLOY_TYPES.filter((x) => x !== 'auto')" :key="type" :value="type">{{ t(`mobile.deploy_${type}`) }}</option>
          </select>
        </label>
        <p class="m-hint-sm">{{ t("mobile.releaseDeployNote") }}</p>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="confirmState.open" class="m-modal" data-role="confirm">
      <div class="m-modal-card">
        <b>{{ t("common.delete") }}</b>
        <p>{{ t("mobile.releaseRemoveMsg", { name: confirmState.name }) }}</p>
        <div class="m-modal-ops">
          <button class="m-modal-cancel" data-role="confirm-cancel" @click="confirmState.open = false">{{ t("common.cancel") }}</button>
          <button class="m-modal-ok" data-role="confirm-ok" @click="doRemove">{{ t("common.confirm") }}</button>
        </div>
      </div>
    </div>

    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
  </section>
</template>
