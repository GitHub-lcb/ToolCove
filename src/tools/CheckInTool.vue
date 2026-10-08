<script setup>
// 自动签到（桌面端）：按站点描述文件定时调用第三方签到接口。
//
// 为什么不把某个站点的接口写死在代码里：这些产品的签到端点不公开、也会变。
// 所以「发什么请求、怎么从响应里读状态」全部由用户填的一份 JSON（站点描述）决定，
// 工具负责校验、加密凭据、定时、幂等与如实展示结果。
//
// 三条设计红线（改动时别破坏）：
// 1. **不谎报成功**：HTTP 200 不等于签到成功，业务码与字段读不出来时一律显示「无法判定」。
// 2. **不越权**：只发用户自己配置的请求；baseUrl 强制 https；描述填错时一次请求都不发。
// 3. **不多签**：本地按日期幂等 + 同站点并发去重 + 当日次数上限。
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { isDesktop } from "../platform/env.js";
import { DESCRIPTOR_TEMPLATE, parseDescriptorText, validateDescriptor } from "../checkin/descriptor.js";
import { DEFAULT_POLICY, planDailyRun } from "../checkin/daily.js";
import { loadPolicy, loadSites, loadStates, runAllNow, runSiteNow, savePolicy, saveSites, SITES_CHANGED_EVENT } from "../checkin/index.js";
import { listen } from "../platform/events.js";
import { isTodayDone, STATUS_EVENT } from "../checkin/schedule.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const sites = ref([]);
const states = ref({});
const policy = ref({ ...DEFAULT_POLICY });
const autostart = ref(false);
const busyKey = ref("");
const busyAll = ref(false);
const editing = ref(null); // 正在编辑的站点 key
const draft = ref("");
const draftErrors = ref([]);
const draftHint = ref("");

const OUTCOME_LABEL = {
  ok: "outcomeOk",
  already: "outcomeAlready",
  failed: "outcomeFailed",
  unknown: "outcomeUnknown",
  auth: "outcomeAuth",
  "rate-limited": "outcomeRateLimited",
  server: "outcomeServer",
  client: "outcomeClient",
  "not-json": "outcomeNotJson",
  network: "outcomeNetwork",
  "bad-descriptor": "outcomeBadDescriptor",
  skipped: "outcomeSkipped",
};

// 结果 → 徽章配色。只有 ok / already 走成功色；读不出状态一律中性色，不能给绿的。
const OUTCOME_TONE = {
  ok: "ok",
  already: "ok",
  failed: "bad",
  auth: "bad",
  "rate-limited": "warn",
  server: "bad",
  client: "bad",
  "not-json": "bad",
  network: "warn",
  "bad-descriptor": "bad",
  unknown: "warn",
  skipped: "muted",
};

function outcomeLabel(site) {
  const state = states.value[site.key];
  if (isTodayDone(state, Date.now(), policy.value.offsetMinutes)) return t("checkin.outcomeAlready");
  if (!state || !state.lastOutcome) return t("checkin.neverRun");
  const key = OUTCOME_LABEL[state.lastOutcome] || "outcomeUnknown";
  return t(`checkin.${key}`);
}

function toneOf(site) {
  const state = states.value[site.key];
  if (isTodayDone(state, Date.now(), policy.value.offsetMinutes)) return "ok";
  if (!state || !state.lastOutcome) return "muted";
  return OUTCOME_TONE[state.lastOutcome] || "muted";
}

function detailOf(site) {
  const state = states.value[site.key];
  if (!state) return "";
  if (state.lastError) return state.lastError;
  if (!state.lastAt) return "";
  return `${t("checkin.lastRun")} ${new Date(state.lastAt).toLocaleString()}`;
}

const nextRunText = computed(() => {
  if (!policy.value.enabled) return t("checkin.scheduleOff");
  const soonest = sites.value
    .filter((site) => site.enabled !== false)
    .map((site) => {
      const plan = planDailyRun(states.value[site.key], policy.value, Date.now());
      return plan.due ? 0 : plan.at;
    })
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)[0];
  if (soonest == null) return t("checkin.noSites");
  const ms = soonest - Date.now();
  if (ms <= 0) return t("checkin.runNow");
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.round((ms % 3600000) / 60000);
  return hours > 0 ? t("checkin.inHours", { h: hours, m: minutes }) : t("checkin.inMinutes", { m: Math.max(minutes, 1) });
});

async function refresh() {
  const [loadedSites, loadedStates, loadedPolicy] = await Promise.all([loadSites(), loadStates(), loadPolicy()]);
  sites.value = Array.isArray(loadedSites) ? loadedSites : [];
  states.value = loadedStates || {};
  policy.value = { ...DEFAULT_POLICY, ...(loadedPolicy || {}) };
  if (isDesktop) {
    autostart.value = await invoke("autostart_status").catch(() => false);
  }
}

function onStatus(event) {
  // 定时任务在主窗口跑完会广播结果，这里只刷新状态，不弹 toast 打扰用户
  refresh();
  void event;
}

let unlistenSites = () => {};

onMounted(async () => {
  await refresh();
  window.addEventListener(STATUS_EVENT, onStatus);
  // 抓包工具在**另一个窗口**里加站点时，这里不会收到上面的 STATUS_EVENT（那是同窗口广播）。
  // 不监听的话，已经开着的签到窗口会一直显示旧列表，用户会以为「加不进去」。
  unlistenSites = await listen(SITES_CHANGED_EVENT, onStatus);
});
onUnmounted(() => {
  window.removeEventListener(STATUS_EVENT, onStatus);
  unlistenSites();
});

async function runAll() {
  if (busyAll.value) return;
  busyAll.value = true;
  try {
    const { results } = await runAllNow();
    await refresh();
    const okCount = results.filter((r) => r.outcome === "ok" || r.outcome === "already").length;
    const bad = results.filter((r) => r.outcome === "bad-descriptor").length;
    if (bad) props.showToast(t("checkin.toastBadDescriptor", { n: bad }));
    else props.showToast(t("checkin.toastDone", { ok: okCount, total: results.length }));
  } catch (error) {
    props.showToast(`${t("checkin.runFailed")}：${error?.message || error}`);
  } finally {
    busyAll.value = false;
  }
}

async function runOne(site) {
  if (busyKey.value) return;
  busyKey.value = site.key;
  try {
    const result = await runSiteNow(site.key);
    await refresh();
    if (!result) return;
    props.showToast(t(`checkin.${OUTCOME_LABEL[result.outcome] || "outcomeUnknown"}`) + (result.points != null ? ` · ${result.points}` : ""));
  } catch (error) {
    props.showToast(`${t("checkin.runFailed")}：${error?.message || error}`);
  } finally {
    busyKey.value = "";
  }
}

function openEditor(site) {
  editing.value = site.key;
  draft.value = JSON.stringify(site, null, 2);
  draftErrors.value = [];
  draftHint.value = "";
}

function newSite() {
  editing.value = "__new__";
  draft.value = DESCRIPTOR_TEMPLATE;
  draftErrors.value = [];
  draftHint.value = "";
}

function closeEditor() {
  editing.value = null;
  draftErrors.value = [];
  draftHint.value = "";
}

/** 校验草稿：填错时逐条列出，且**不保存**——坏描述不该落盘。 */
function validateDraft() {
  const parsed = parseDescriptorText(draft.value);
  if (!parsed.ok) {
    draftErrors.value = [{ field: "json", code: parsed.errors[0].code }];
    draftHint.value = parsed.hint || "";
    return null;
  }
  const existingKeys = sites.value.map((s) => s.key).filter((k) => k !== editing.value);
  const checked = validateDescriptor(parsed.value, { existingKeys });
  draftErrors.value = checked.errors;
  draftHint.value = "";
  return checked.ok ? checked.value : null;
}

async function saveDraft() {
  const value = validateDraft();
  if (!value) {
    props.showToast(t("checkin.fixErrors"));
    return;
  }
  const next = editing.value === "__new__" ? [...sites.value, value] : sites.value.map((s) => (s.key === editing.value ? value : s));
  sites.value = next;
  saveSites(next);
  closeEditor();
  props.showToast(t("checkin.saved"));
  await refresh();
}

async function removeSite(site) {
  const next = sites.value.filter((s) => s.key !== site.key);
  sites.value = next;
  saveSites(next);
  const rest = { ...states.value };
  delete rest[site.key];
  states.value = rest;
  props.showToast(t("checkin.removed", { label: site.label }));
}

async function toggleSite(site) {
  const next = sites.value.map((s) => (s.key === site.key ? { ...s, enabled: s.enabled === false } : s));
  sites.value = next;
  saveSites(next);
}

function saveSchedule() {
  savePolicy(policy.value);
  props.showToast(t("checkin.scheduleSaved"));
}

async function toggleAutostart() {
  if (!isDesktop) return;
  const target = !autostart.value;
  try {
    await invoke("autostart_set", { enabled: target });
    autostart.value = target;
    props.showToast(t(target ? "checkin.autostartOn" : "checkin.autostartOff"));
  } catch (error) {
    props.showToast(`${t("checkin.autostartFailed")}：${error?.message || error}`);
  }
}

function historyOf(site) {
  return Array.isArray(states.value[site.key]?.history) ? states.value[site.key].history : [];
}

function fmtTime(at) {
  return at ? new Date(at).toLocaleString() : "—";
}
</script>

<template>
  <div class="ck">
    <header class="ck-head">
      <div class="ck-title">
        <h2>{{ t("checkin.title") }}</h2>
        <p class="ck-sub">{{ t("checkin.subtitle") }}</p>
      </div>
      <div class="ck-actions">
        <button class="btn primary" :disabled="busyAll || !sites.length" data-role="run-all" @click="runAll">
          {{ busyAll ? t("checkin.running") : t("checkin.runAll") }}
        </button>
        <button class="btn" data-role="add-site" @click="newSite">{{ t("checkin.addSite") }}</button>
      </div>
    </header>

    <section class="ck-sched">
      <label class="ck-switch">
        <input type="checkbox" v-model="policy.enabled" data-role="auto-toggle" @change="saveSchedule" />
        <span>{{ t("checkin.autoLabel") }}</span>
      </label>
      <label class="ck-field">
        <span>{{ t("checkin.autoAt") }}</span>
        <input type="time" v-model="policy.at" data-role="auto-at" @change="saveSchedule" />
      </label>
      <label class="ck-field">
        <span>{{ t("checkin.maxRuns") }}</span>
        <input type="number" min="1" max="20" v-model.number="policy.maxRunsPerDay" data-role="max-runs" @change="saveSchedule" />
      </label>
      <div class="ck-next">{{ nextRunText }}</div>
      <label v-if="isDesktop" class="ck-switch">
        <input type="checkbox" :checked="autostart" data-role="autostart" @change="toggleAutostart" />
        <span>{{ t("checkin.autostartLabel") }}</span>
      </label>
    </section>

    <p class="ck-warn">{{ t("checkin.autostartHint") }}</p>

    <ul class="ck-list">
      <li v-for="site in sites" :key="site.key" class="ck-item" :data-role="`site-${site.key}`">
        <div class="ck-item-main">
          <span class="ck-badge" :data-tone="toneOf(site)">{{ outcomeLabel(site) }}</span>
          <strong>{{ site.label }}</strong>
          <code class="ck-key">{{ site.key }}</code>
          <span v-if="states[site.key]?.points != null" class="ck-points">{{ states[site.key].points }}</span>
        </div>
        <div class="ck-item-meta">
          <span>{{ detailOf(site) }}</span>
          <span v-if="historyOf(site).length">{{ t("checkin.historyCount", { n: historyOf(site).length }) }}</span>
        </div>
        <div class="ck-item-actions">
          <button class="btn small" :disabled="busyKey === site.key" :data-role="`run-${site.key}`" @click="runOne(site)">
            {{ busyKey === site.key ? t("checkin.running") : t("checkin.runOne") }}
          </button>
          <button class="btn small" :data-role="`edit-${site.key}`" @click="openEditor(site)">{{ t("checkin.edit") }}</button>
          <button class="btn small" :data-role="`toggle-${site.key}`" @click="toggleSite(site)">
            {{ site.enabled === false ? t("checkin.enable") : t("checkin.disable") }}
          </button>
          <button class="btn small danger" :data-role="`remove-${site.key}`" @click="removeSite(site)">{{ t("checkin.remove") }}</button>
        </div>
        <details v-if="historyOf(site).length" class="ck-history">
          <summary>{{ t("checkin.history") }}</summary>
          <ul>
            <li v-for="(row, i) in historyOf(site)" :key="`${row.at}-${i}`">
              <span>{{ fmtTime(row.at) }}</span>
              <span>{{ t(`checkin.${OUTCOME_LABEL[row.outcome] || 'outcomeUnknown'}`) }}</span>
              <span v-if="row.points != null">{{ row.points }}</span>
              <span v-if="row.error" class="ck-err">{{ row.error }}</span>
            </li>
          </ul>
        </details>
      </li>
      <li v-if="!sites.length" class="ck-empty">{{ t("checkin.empty") }}</li>
    </ul>

    <section v-if="editing" class="ck-editor">
      <h3>{{ editing === "__new__" ? t("checkin.addSite") : t("checkin.edit") }}</h3>
      <textarea v-model="draft" rows="16" spellcheck="false" data-role="descriptor-editor"></textarea>
      <p v-if="draftHint" class="ck-err">{{ draftHint }}</p>
      <ul v-if="draftErrors.length" class="ck-errs" data-role="descriptor-errors">
        <li v-for="(e, i) in draftErrors" :key="i">
          <code>{{ e.field }}</code> {{ t(`checkin.err.${e.code}`, { field: e.field }) }}
        </li>
      </ul>
      <div class="ck-editor-actions">
        <button class="btn primary" data-role="descriptor-save" @click="saveDraft">{{ t("checkin.save") }}</button>
        <button class="btn" data-role="descriptor-cancel" @click="closeEditor">{{ t("checkin.cancel") }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ck { display: flex; flex-direction: column; gap: var(--fs-md); padding: var(--fs-md); height: 100%; overflow: auto; }
.ck-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--fs-md); }
.ck-title h2 { margin: 0 0 4px; font-size: var(--fs-lg); }
.ck-sub { margin: 0; color: var(--text-weak); font-size: var(--fs-sm); line-height: var(--lh-body); }
.ck-actions { display: flex; gap: var(--r-xs); }
.btn { padding: 5px 11px; border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--card); color: var(--text); cursor: pointer; font-size: var(--fs-sm); }
.btn:hover:not(:disabled) { border-color: var(--primary); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--text-invert); }
.btn.small { padding: 3px 8px; font-size: var(--fs-xs); }
.btn.danger { color: var(--danger); }
.ck-sched { display: flex; flex-wrap: wrap; align-items: center; gap: var(--fs-md); padding: var(--fs-sm) var(--fs-md); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--card); }
.ck-switch { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); cursor: pointer; }
.ck-field { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); }
.ck-field input { padding: 3px 6px; border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--bg); color: var(--text); }
.ck-next { margin-left: auto; font-size: var(--fs-sm); color: var(--text-weak); }
.ck-warn { margin: 0; font-size: var(--fs-xs); color: var(--text-weak); line-height: var(--lh-body); }
.ck-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.ck-item { padding: 10px var(--fs-md); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--card); }
.ck-item-main { display: flex; align-items: center; gap: var(--r-xs); }
.ck-item-meta { display: flex; gap: var(--fs-md); margin-top: 6px; font-size: var(--fs-xs); color: var(--text-weak); }
.ck-item-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--r-xs); }
.ck-badge { padding: 2px 8px; border-radius: var(--r-pill); font-size: var(--fs-xs); border: 1px solid transparent; }
.ck-badge[data-tone="ok"] { color: var(--success); border-color: var(--success-border); background: var(--success-tint); }
.ck-badge[data-tone="bad"] { color: var(--danger); border-color: var(--border-danger); background: var(--danger-soft); }
.ck-badge[data-tone="warn"] { color: var(--warn); border-color: var(--warn-border); background: var(--warn-tint); }
.ck-badge[data-tone="muted"] { color: var(--text-weak); border-color: var(--border); }
.ck-key { font-size: var(--fs-xs); color: var(--text-weak); font-family: var(--font-mono); }
.ck-points { margin-left: auto; font-weight: 600; font-family: var(--font-num); }
.ck-history { margin-top: var(--r-xs); font-size: var(--fs-xs); }
.ck-history summary { cursor: pointer; color: var(--text-weak); }
.ck-history ul { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ck-history li { display: flex; flex-wrap: wrap; gap: 10px; }
.ck-empty { padding: 18px; text-align: center; color: var(--text-weak); border: 1px dashed var(--border); border-radius: var(--r-sm); }
.ck-editor { display: flex; flex-direction: column; gap: var(--r-xs); padding: var(--fs-md); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--card); }
.ck-editor h3 { margin: 0; font-size: var(--fs-md); }
.ck-editor textarea { width: 100%; font-family: var(--font-mono); font-size: var(--fs-sm); padding: var(--r-xs); border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--bg); color: var(--text); resize: vertical; }
.ck-editor-actions { display: flex; gap: var(--r-xs); }
.ck-errs { margin: 0; padding-left: 18px; color: var(--danger); font-size: var(--fs-sm); }
.ck-errs code { color: var(--text-weak); font-family: var(--font-mono); }
.ck-err { color: var(--danger); font-size: var(--fs-sm); }
</style>
