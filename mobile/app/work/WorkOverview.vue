<script setup>
// 工作台概览（手机端）：迭代进度、待处理、未闭问题、工时、最近活动。
//
// 与桌面端 WorkOverviewView 的关系：**数据读取与统计口径完全一致**——
// 只读 iterations / problems / settings 三个键，活动与工时都是从迭代子任务与问题日志
// **聚合**出来的（不是独立数据键）。这样两端的数字不会漂。
//
// 界面按手机重排：KPI 两列网格、进度用横条、活动取最近 6 条。
// 刻意不做桌面端的问候语/每日一句/新手引导——手机看概览通常只有几秒，
// 装饰会把真正要看的数据挤出屏幕。
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { load as loadKind, onDataChanged } from "../../../src/data/repository.js";
import { invoke } from "../../../src/platform/invoke.js";
import { fmtDate, isWorkday } from "../../../src/shared/dates.js";
import { collectDayLogs, sumHoursByDate } from "../../../src/shared/hours.js";
// 迭代完成度的唯一实现：桌面概览、迭代页、手机概览都从这一处算
import { iterationProgress } from "../../../src/requirementMetrics.js";

const { t } = useI18n();

const iterations = ref([]);
const problems = ref([]);
const settings = ref({});
const loading = ref(true);
const error = ref("");

/**
 * 读业务数据用 repository.load(kind)，而不是直接 invoke("load_data")。
 * 理由：repository 是平台无关层，且带**变更通知**（onDataChanged）——
 * 在别处改了迭代/问题，概览能自动跟上，不需要轮询。
 *
 * ⚠️ 但 **settings 不在 repository 的 KINDS 里**（它只收录业务集合：snippets/problems/
 * iterations/domains/pools/releases）。早先把 settings 也交给 loadKind，它抛"未知数据类别"，
 * 而 Promise.all 一个失败就全失败——表现为 KPI 全是 0（实测踩过）。
 * 设置属于配置而非集合数据，直接走 invoke 读。
 */
async function load() {
  error.value = "";
  try {
    const [iters, probs, conf] = await Promise.all([
      loadKind("iterations"),
      loadKind("problems"),
      // 设置读不到不该让整个概览失败：给个空对象，KPI 用默认目标工时
      invoke("load_data", { key: "settings" }).catch(() => ({})),
    ]);
    iterations.value = Array.isArray(iters) ? iters : [];
    problems.value = Array.isArray(probs) ? probs : [];
    settings.value = conf && typeof conf === "object" ? conf : {};
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

let offChanged = null;
let timer = null;
function onVisible() {
  // 回到前台时静默刷新：手机上切回来是常见动作，数据不该是旧的
  if (!document.hidden) load();
}
onMounted(() => {
  load();
  // 数据变更（同页内新增迭代/问题、同步拉到新数据）自动刷新。
  // ⚠️ 必须忽略 source === "view"：那是本页自己触发的变更，否则会形成"改 → 刷新 → 改"的循环
  // （WorkView 里也是这么处理的，口径保持一致）。
  offChanged = onDataChanged(({ source }) => {
    if (source !== "view") load();
  });
  document.addEventListener("visibilitychange", onVisible);
  // visibilitychange 在部分 WebView 上不触发，补一个低频兜底（不要更密：手机上费电）
  timer = setInterval(onVisible, 60_000);
});
onUnmounted(() => {
  offChanged?.();
  document.removeEventListener("visibilitychange", onVisible);
  if (timer) clearInterval(timer);
});

const today = fmtDate(new Date());
const workday = isWorkday(today);

/**
 * 最近活动与今日工时：**与桌面端同一口径、同一个实现**（`shared.collectDayLogs`）。
 * 这**不是**一个独立数据键（我一开始按 activityLogs 读，那是不存在的键）。
 *
 * 此前这里第三份重写了遍历，有两处与桌面端不一致：
 *   1) 同样缺 `subtasks[].logs` 明细分支（跨天登记的工时算错日）；
 *   2) 没有按「我的」过滤——桌面概览只算自己的工时，手机把全组的工时都算进来，
 *      于是两端同一个迭代显示两个数。现在传 displayName，与桌面一致。
 */
const mineName = computed(() => settings.value?.displayName || "");
const dayEntries = computed(() => collectDayLogs(iterations.value, problems.value, mineName.value));
const recentLogs = computed(() =>
  dayEntries.value
    .map((e) => ({
      date: e.date || "",
      hours: e.hours,
      note: e.s ? e.s.name : e.note,
      src: e.source === "problem" ? e.title : e.r?.name || "",
      from: e.source === "problem" ? t("nav.problem") : e.it?.title || "",
    }))
    .filter((item) => item.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
);

/** 迭代进度：已完成需求 / 总需求。百分比口径来自 requirementMetrics（桌面同一函数）。 */
function progress(iteration) {
  return iterationProgress(iteration).pct;
}

const activeIterations = computed(() => iterations.value.filter((item) => item.status !== "live"));
const pendingIterations = computed(() => iterations.value.filter((item) => item.status === "pending"));
const openProblems = computed(() => problems.value.filter((item) => item.status === "open"));

/** 本周内的迭代（周一起算）。 */
const weekIterations = computed(() => {
  const now = new Date();
  const offset = (now.getDay() + 6) % 7; // 周一 = 0
  const monday = new Date(now);
  monday.setDate(now.getDate() - offset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const from = fmtDate(monday);
  const to = fmtDate(sunday);
  return iterations.value
    .filter((item) => {
      const start = item.startDate || "";
      const end = item.endDate || "";
      if (!start && !end) return false;
      return (!end || end >= from) && (!start || start <= to);
    })
    .slice(0, 5);
});

/** 今日工时：与桌面概览同一处合计（shared.sumHoursByDate）。 */
const dayHoursMap = computed(() => sumHoursByDate(dayEntries.value));
const todayHours = computed(() => Math.round((dayHoursMap.value[today] || 0) * 10) / 10);
const targetHours = computed(() => Number(settings.value?.hoursReminder?.target) || 8);

const topLogs = computed(() => recentLogs.value.slice(0, 6));

const kpis = computed(() => [
  { key: "iterations", label: t("mobile.ovIterations"), value: activeIterations.value.length, hint: t("mobile.ovPending", { n: pendingIterations.value.length }) },
  { key: "problems", label: t("mobile.ovProblems"), value: openProblems.value.length, hint: t("mobile.ovOpen") },
  { key: "hours", label: t("mobile.ovHours"), value: todayHours.value, hint: workday ? t("mobile.ovTarget", { n: targetHours.value }) : t("mobile.ovRestDay") },
  { key: "week", label: t("mobile.ovWeek"), value: weekIterations.value.length, hint: t("mobile.ovWeekHint") },
]);
</script>

<template>
  <section class="m-overview" data-role="overview">
    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
    <p v-if="loading" class="m-empty">{{ t("common.loading") }}</p>

    <template v-else>
      <!-- KPI：手机上两列网格，一屏能看全 -->
      <ul class="m-kpi-grid" data-role="kpis">
        <li v-for="item in kpis" :key="item.key" class="m-kpi" :data-kpi="item.key">
          <b class="m-kpi-value" :data-role="`kpi-${item.key}`">{{ item.value }}</b>
          <span class="m-kpi-label">{{ item.label }}</span>
          <span class="m-kpi-hint">{{ item.hint }}</span>
        </li>
      </ul>

      <!-- 本周迭代 -->
      <div class="m-card">
        <div class="m-card-head">
          <b>{{ t("mobile.ovWeekTitle") }}</b>
          <span class="m-zone">{{ t("mobile.ovToday", { date: today }) }}</span>
        </div>
        <p v-if="!weekIterations.length" class="m-hint-sm" data-role="no-week">{{ t("mobile.ovNoWeek") }}</p>
        <ul v-else class="m-list" data-role="week-list">
          <li v-for="iteration in weekIterations" :key="iteration.id" class="m-item" :data-iteration="iteration.id">
            <div class="m-item-main">
              <span class="m-item-title">{{ iteration.title || iteration.name }}</span>
              <span class="m-item-sub">{{ iteration.startDate || "—" }} → {{ iteration.endDate || "—" }}</span>
            </div>
            <div class="m-bar" :data-pct="progress(iteration)">
              <span class="m-bar-fill" :style="{ width: `${progress(iteration)}%` }"></span>
            </div>
          </li>
        </ul>
      </div>

      <!-- 最近活动 -->
      <div class="m-card">
        <div class="m-card-head"><b>{{ t("mobile.ovRecent") }}</b></div>
        <p v-if="!topLogs.length" class="m-hint-sm" data-role="no-logs">{{ t("mobile.ovNoLogs") }}</p>
        <ul v-else class="m-stats" data-role="recent-logs">
          <li v-for="(entry, index) in topLogs" :key="index">
            <b>{{ entry.date }}</b>
            <span>{{ entry.note || entry.src }}{{ entry.hours ? ` · ${entry.hours}h` : "" }}</span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
