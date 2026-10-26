<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { save as saveDialog } from "../platform/dialog.js";
import Icon from "../ui/Icon.vue";
import { fmtDate, relativeTime, weekday } from "../shared/dates.js";
import { errText } from "../shared/errors.js";
import { WORK_SOURCES, collectDayLogs, partitionDayLogs, sumHoursByDate } from "../shared/hours.js";
import { renderMarkdown } from "../shared/markdown.js";
import { buildWorkHoursXlsx } from "../shared/xlsx.js";
import { aiChat, aiComplete, isAIConfigured } from "../ai.js";
import { askConfirm } from "../ui/confirm.js";
import { buildReportSystem, buildDistillPrompt, splitReportSamples, truncate, buildHeartPrompt, extractReportSection, replaceReportSection, REPORT_SECTIONS, HEART_IMAGE_MAX, TEMPLATE_MAX, STYLE_MAX, REPORT_STATUS, advanceReportStatus, recoverReportStatus, upsertReport, updateReportStatus } from "../weeklyReport.js";
import { load as loadRecords, mutate, onDataChanged } from "../data/repository.js";
import { weekRange, buildReportMaterial } from "../report/material.js";
import { loadWeeklyPolicy, saveWeeklyPolicy, generateWeeklyDraft, archiveDraftToSnippet } from "../report/index.js";
import WeeklySchedulePanel from "../report/WeeklySchedulePanel.vue";
import { newIteration, newRequirement, newSubTask, addIteration, addRequirement, addSubTask, updateSubTask, removeSubTask, findIteration } from "../iterations.js";
import { vDialog } from '../ui/dialog.js'; // 模板里的 v-dialog 由 <script setup> 就地解析（SSR 渲染测试也能用）

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["open-settings"]);

const { t } = useI18n();

const iterations = ref([]);
const problems = ref([]);
let iterationsSaveQueue = Promise.resolve();
let iterationsStale = false;

// ------- 加载 -------
async function load() {
  try {
    // 迭代结构由 migrate.js 启动时一次性升级；数据统一走 repository（与 Agent / 云同步共用乐观锁）
    const [its, probs] = await Promise.all([loadRecords("iterations"), loadRecords("problems")]);
    iterations.value = its;
    problems.value = probs;
  } catch (e) {
    props.showToast(t("task.loadFailed", { err: errText(e) }));
  }
}
onMounted(async () => {
  await load();
  refreshUserName();
  // 换了设置保存后按新配置刷新（显示名等）
  window.addEventListener("settings-saved", onSettingsSaved);
});
// Agent / 另一窗口改了工时或问题：无未保存编辑时重新加载；编辑中只提示，不打断输入
let offDataChanged = null;
onMounted(() => {
  offDataChanged = onDataChanged(async ({ kind, source }) => {
    if (source === "view" || (kind !== "iterations" && kind !== "problems")) return;
    if (subEdit.value.id || showAddTask.value) return props.showToast(t("task.dataUpdatedExternally"));
    await load();
  });
});
// 配置类弹窗：禁点遮罩关闭（带未保存编辑态，防误触丢失），但 Esc 必须能关——
// 规范 §3.3「遮罩必须能被 Escape 关闭」。此前只接了周报，添加工时弹窗只能靠「取消」出去。
function onEsc(e) {
  if (e.key !== "Escape") return;
  if (showReport.value) {
    showReport.value = false;
    return;
  }
  if (showAddTask.value) showAddTask.value = false;
}
onMounted(() => window.addEventListener("keydown", onEsc));
onUnmounted(() => {
  offDataChanged?.();
  window.removeEventListener("settings-saved", onSettingsSaved);
  window.removeEventListener("keydown", onEsc);
  if (editSaveTimer) clearTimeout(editSaveTimer);
});
const userName = ref("");
// 本地化：身份显示名取设置项，不再依赖 Coding 令牌
async function refreshUserName() {
  try {
    const settings = (await invoke("load_data", { key: "settings" })) || {};
    userName.value = settings.displayName || "";
  } catch {
    userName.value = "";
  }
}
function onSettingsSaved() {
  refreshUserName();
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function chartHours(value) {
  const hours = Number(value) || 0;
  return String(round(hours));
}

// ------- 本地数据（纯本地迭代/需求/子任务，无 Coding 依赖）-------
// ------- 未提交工时（本地子任务）：编辑 + 删除 -------
// 统计条目对应的子任务：就地展示编辑/删除操作
function isEditable(e) {
  return e.source === "iteration";
}
// 写迭代数据：串行队列 + repository 乐观锁（读最新 → 变换 → 冲突重放），
// 与 Agent / 迭代页 / 需求大盘共用一个写入口，不再整表覆盖
function persistIterations(apply) {
  if (iterationsStale) {
    return Promise.reject(new Error(t("task.staleData")));
  }
  const job = iterationsSaveQueue.then(async () => {
    iterations.value = await mutate("iterations", (fresh) => apply(fresh), { source: "view" });
  });
  iterationsSaveQueue = job.catch(() => {});
  return job.catch((e) => {
    iterationsStale = true;
    props.showToast(t("task.saveFailed", { err: errText(e) }));
    throw e;
  });
}
// 行内编辑（本地子任务：名称/工时/归属日）
const subEdit = ref({ id: "", name: "", hours: "", date: "" });
function startEditSub(s) {
  subEdit.value = { id: s.id, name: s.name, hours: s.hours || "", date: s.date || fmtDate(new Date()) };
}
function cancelEditSub() {
  subEdit.value = { id: "", name: "", hours: "", date: "" };
}
async function saveEditSub(x) {
  const { r, s } = x;
  const name = subEdit.value.name.trim();
  if (!name) return props.showToast(t("task.subNameRequired"));
  const hours = Math.max(0, Number(subEdit.value.hours) || 0);
  const date = subEdit.value.date || fmtDate(new Date());
  cancelEditSub();
  await persistIterations((fresh) => updateSubTask(fresh, x.it.id, r.id, s.id, { name, hours, date }));
  props.showToast(t("task.entryUpdated"));
}
// 删除子任务（撤销可恢复）
async function removeSub(x) {
  const { it, r, s } = x;
  const idx = (r.subtasks || []).findIndex((x) => x.id === s.id);
  if (idx < 0) return;
  await persistIterations((fresh) => removeSubTask(fresh, it.id, r.id, s.id));
  props.showToast(t("task.subDeleted", { name: s.name }), {
    actionLabel: t("task.undo"),
    onAction: async () => {
      await persistIterations((fresh) => addSubTask(fresh, it.id, r.id, s));
      props.showToast(t("task.restored"));
    },
  });
}

// ------- 工时统计（跨迭代需求 + 问题）-------
const WORK_SOURCES_MAP = WORK_SOURCES;
const dayLogs = computed(() => collectDayLogs(iterations.value, problems.value, userName.value));
// 按日聚合，用于当前月份的图表和导出。
const dailyTotals = computed(() => {
  const map = {};
  dayLogs.value.forEach((e) => {
    if (!map[e.date]) map[e.date] = { date: e.date, total: 0, iteration: 0, problem: 0, entries: [] };
    map[e.date].total += e.hours;
    map[e.date][e.source] += e.hours;
    map[e.date].entries.push(e);
  });
  const arr = Object.values(map).sort((a, b) => (a.date < b.date ? 1 : -1));
  arr.forEach((d) => {
    d.total = round(d.total);
    d.iteration = round(d.iteration);
    d.problem = round(d.problem);
    d.entries.sort((a, b) => b.hours - a.hours);
  });
  return arr;
});
// ------- 月度工时图（日期横轴、工时纵轴，超过 8h 的部分标记为加班） -------
const STANDARD_HOURS = 8;
// 图表横轴的星期名：直接复用 common.weekXxx（zh「周一」/ en「Mon」），不拼中文「周」字
const CHART_WEEKDAY_KEYS = ["common.weekSun", "common.weekMon", "common.weekTue", "common.weekWed", "common.weekThu", "common.weekFri", "common.weekSat"];
const selectedDate = ref(fmtDate(new Date()));
const selectedMonth = ref(selectedDate.value.slice(0, 7));
const monthTotals = computed(() => sumHoursByDate(dayLogs.value));
const calendarDays = computed(() => {
  const [year, month] = selectedMonth.value.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = fmtDate(new Date());
  return Array.from({ length: daysInMonth }, (_, index) => {
    const date = `${selectedMonth.value}-${String(index + 1).padStart(2, "0")}`;
    const dayOfWeek = new Date(`${date}T12:00:00`).getDay();
    return {
      date,
      day: index + 1,
      weekday: CHART_WEEKDAY_KEYS[dayOfWeek],
      isToday: date === today,
      isFuture: date > today,
      isWeekend: [0, 6].includes(dayOfWeek),
      isWeekStart: dayOfWeek === 1 && index > 0,
    };
  });
});
const monthDays = computed(() =>
  calendarDays.value.map((day) => {
    const total = round(monthTotals.value[day.date] || 0);
    return {
      ...day,
      total,
      regular: Math.min(STANDARD_HOURS, total),
      overtime: round(Math.max(0, total - STANDARD_HOURS)),
    };
  })
);
const chartDays = computed(() => monthDays.value);
const chartMax = computed(() => {
  const highest = Math.max(STANDARD_HOURS, ...chartDays.value.map((day) => day.total));
  return Math.max(12, Math.ceil(highest / 4) * 4);
});
const chartTicks = computed(() => {
  const ticks = [];
  for (let value = chartMax.value; value >= 0; value -= 4) ticks.push(value);
  return ticks;
});
const selectedMonthLabel = computed(() => {
  const [year, month] = selectedMonth.value.split("-").map(Number);
  return t("task.monthLabel", { year, month });
});
const isCurrentMonth = computed(() => selectedMonth.value === fmtDate(new Date()).slice(0, 7));
const selectedMonthRange = computed(() => {
  const lastDay = calendarDays.value.at(-1)?.date || `${selectedMonth.value}-01`;
  return [`${selectedMonth.value}-01`, isCurrentMonth.value ? fmtDate(new Date()) : lastDay];
});
const monthPersonalTotal = computed(() => round(monthDays.value.reduce((sum, day) => sum + day.total, 0)));
const monthPersonalOvertime = computed(() => round(monthDays.value.reduce((sum, day) => sum + day.overtime, 0)));
const monthSummary = computed(() => t("task.monthSummary", { total: monthPersonalTotal.value, overtime: monthPersonalOvertime.value }));
function selectMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  const currentMonth = fmtDate(new Date()).slice(0, 7);
  if (month > currentMonth) return;
  selectedMonth.value = month;
  const today = fmtDate(new Date());
  const withLogs = monthDays.value.filter((day) => day.total > 0 && !day.isFuture);
  selectedDate.value = month === today.slice(0, 7)
    ? today
    : withLogs.at(-1)?.date || `${month}-01`;
}
function moveMonth(offset) {
  const [year, month] = selectedMonth.value.split("-").map(Number);
  const target = new Date(year, month - 1 + offset, 1);
  selectMonth(`${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`);
}
function goCurrentMonth() {
  selectMonth(fmtDate(new Date()).slice(0, 7));
}
const selectedEntries = computed(() =>
  dayLogs.value
    .filter((entry) => entry.date === selectedDate.value)
    .sort((a, b) => a.source.localeCompare(b.source) || b.hours - a.hours)
);
const selectedIterationEntries = computed(() => selectedEntries.value.filter((entry) => entry.source === "iteration"));
const selectedProblemEntries = computed(() => selectedEntries.value.filter((entry) => entry.source === "problem"));
// 子任务行可就地编辑/删除；历史「记一笔」没有子任务引用，只读展示。
// 之前模板对所有 iteration 条目都取 `e.s.id`，只要某条需求留着旧 logs 就会 TypeError 白屏。
const selectedSubEntries = computed(() => partitionDayLogs(selectedIterationEntries.value).editable);
const selectedLegacyEntries = computed(() => partitionDayLogs(selectedIterationEntries.value).readOnly);
const selectedDateTitle = computed(() => {
  const today = fmtDate(new Date());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const prefix = selectedDate.value === today ? t("task.today") : selectedDate.value === fmtDate(yesterday) ? t("task.yesterday") : weekday(selectedDate.value);
  return `${prefix} · ${selectedDate.value}`;
});
// ------- 添加工时（本地快速录入：迭代/需求/子任务）-------
const showAddTask = ref(false);
const addIterationId = ref(""); // 选中迭代 id；"__new" 表示新建
const addNewIteration = ref(""); // 新建迭代标题
const addRequirementId = ref(""); // 选中需求 id；"__new" 表示新建
const addNewRequirement = ref(""); // 新建需求名称
const addSubName = ref("");
const addSubHours = ref("");
const addSubDate = ref(fmtDate(new Date()));
const addSaving = ref(false);

/** date 传字符串时按那一天录；工具栏的 @click 直接把它当事件传进来，此时落回今天 */
function openAddTask(date) {
  addIterationId.value = iterations.value.length ? iterations.value[0].id : "__new";
  const it = findIteration(iterations.value, addIterationId.value);
  addRequirementId.value = it && it.items?.length ? it.items[0].id : "__new";
  addNewIteration.value = "";
  addNewRequirement.value = "";
  addSubName.value = "";
  addSubHours.value = "";
  addSubDate.value = typeof date === "string" && date ? date : fmtDate(new Date());
  showAddTask.value = true;
}
function addIterationOptions() {
  return [{ id: "__new", label: t("task.newIterationOption") }, ...iterations.value.map((it) => ({ id: it.id, label: it.title }))];
}
function addRequirementOptions() {
  const it = findIteration(iterations.value, addIterationId.value);
  const reqs = it ? it.items || [] : [];
  return [{ id: "__new", label: t("task.newRequirementOption") }, ...reqs.map((r) => ({ id: r.id, label: r.name }))];
}
function onAddIterationChange() {
  // 换了迭代：需求选择重置为该迭代的第一个需求（或新建）
  const it = findIteration(iterations.value, addIterationId.value);
  addRequirementId.value = it && it.items?.length ? it.items[0].id : "__new";
}
async function saveAddTask() {
  const subName = addSubName.value.trim();
  const hours = Math.max(0, Number(addSubHours.value) || 0);
  if (!subName) return props.showToast(t("task.subNameRequired"));
  if (hours <= 0) return props.showToast(t("task.hoursRequired"));
  if (addIterationId.value === "__new" && !addNewIteration.value.trim()) return props.showToast(t("task.newIterationRequired"));
  if (addRequirementId.value === "__new" && !addNewRequirement.value.trim()) return props.showToast(t("task.newRequirementRequired"));
  addSaving.value = true;
  try {
    // 新对象在变换外生成一次：mutate 冲突重放时插的是同一份，id 稳定
    const newIt = addIterationId.value === "__new" ? newIteration({ title: addNewIteration.value.trim() }) : null;
    const newReq = addRequirementId.value === "__new" ? newRequirement({ name: addNewRequirement.value.trim() }) : null;
    const s = newSubTask({ name: subName, hours, date: addSubDate.value || fmtDate(new Date()) });
    await persistIterations((fresh) => {
      let list = fresh;
      const iterationId = newIt ? newIt.id : addIterationId.value;
      if (newIt) list = addIteration(list, newIt);
      const requirementId = newReq ? newReq.id : addRequirementId.value;
      if (newReq) list = addRequirement(list, iterationId, newReq);
      return addSubTask(list, iterationId, requirementId, s);
    });
    props.showToast(t("task.hoursRecorded", { hours, name: subName }));
    showAddTask.value = false;
  } catch (e) {
    props.showToast(t("task.saveFailedPlain", { err: errText(e) }));
  } finally {
    addSaving.value = false;
  }
}

// ------- 复制汇总 -------
async function copySummary() {
  const [from, to] = selectedMonthRange.value;
  const rows = dailyTotals.value.filter((day) => day.date >= from && day.date <= to);
  if (!rows.length) return props.showToast(t("task.copyEmpty"));
  const lines = rows.map((d) => {
    const items = d.entries
      .map((e) => t("task.copyEntryLine", { hours: e.hours, title: e.title, note: e.note ? t("task.copyNote", { note: e.note }) : "" }))
      .join("\n");
    return t("task.copyDayLine", { date: d.date, total: d.total, items });
  });
  const text = lines.join("\n") + t("task.copyMonthLine", { label: selectedMonthLabel.value, total: monthPersonalTotal.value });
  try {
    await navigator.clipboard.writeText(text);
    props.showToast(t("task.summaryCopied", { label: selectedMonthLabel.value }));
  } catch (e) {
    props.showToast(t("task.copyFailed", { err: e }));
  }
}

// ------- 导出工时 Excel（自己的工时，范围跟随当前月份）-------
async function exportHoursXlsx() {
  const [from, to] = selectedMonthRange.value;
  const entries = dayLogs.value.filter((e) => e.date >= from && e.date <= to);
  if (!entries.length) return props.showToast(t("task.exportEmpty"));
  // 「我」是文件名的一部分，走字典：英文用户不该看到中文字符
  const safe = (userName.value || t("common.me")).replace(/[\\/:*?"<>|]/g, "_");
  try {
    const path = await saveDialog({
      title: t("task.exportDialogTitle"),
      defaultPath: t("task.exportFileName", { safe, from, to }),
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (!path) return;
    const b64 = await buildWorkHoursXlsx({ entries, from, to, userName: userName.value });
    await invoke("export_file_b64", { path, contentB64: b64 });
    props.showToast(t("task.exported", { label: selectedMonthLabel.value }));
  } catch (e) {
    props.showToast(t("task.exportFailed", { err: e }));
  }
}

// ------- AI 周报 -------
const showReport = ref(false);
const reportRange = ref("this"); // this | last
const generating = ref(false);
const reportText = ref("");
const reportHtml = computed(() => (reportText.value ? renderMarkdown(reportText.value) : ""));
// 手动微调：编辑模式（textarea 改 Markdown 原文）；编辑中防抖自动落盘，关闭弹窗也不丢
const editingReport = ref(false);
let editSaveTimer = null;
watch(reportText, () => {
  if (!editingReport.value || !reportText.value) return;
  clearTimeout(editSaveTimer);
  editSaveTimer = setTimeout(() => autosaveReport(reportRange.value), 1200);
});

// 周报风格记忆（独立 key reportPrefs.json，避免被设置弹窗整体覆盖）：
// template=用户导入的模板原文；style=AI 从历史周报提炼的风格说明
const reportPrefs = ref({ template: "", style: "" });
const stylePanel = ref(""); // "" | "template" | "distill"：展开区
const templateDraft = ref("");
const samplesDraft = ref("");
const distilling = ref(false);
const hasReportPrefs = computed(() => !!(reportPrefs.value.template || reportPrefs.value.style));

async function loadReportPrefs() {
  try {
    const p = (await invoke("load_data", { key: "reportPrefs" })) || {};
    reportPrefs.value = { template: p.template || "", style: p.style || "" };
  } catch (e) {
    reportPrefs.value = { template: "", style: "" };
  }
}
async function saveReportPrefs() {
  await invoke("save_data", { key: "reportPrefs", data: reportPrefs.value });
}
// 保存用户导入的模板（超长截断，防撑爆上下文）
// 注意：局部变量不能叫 t —— 会遮蔽 i18n 的 t()，调用时抛 TypeError（i18nShadowing.test.js 守着这条）
async function saveTemplate() {
  const draft = templateDraft.value.trim();
  if (!draft) return;
  reportPrefs.value.template = truncate(draft, TEMPLATE_MAX);
  await saveReportPrefs();
  templateDraft.value = "";
  stylePanel.value = "";
  props.showToast(t("task.templateSaved"));
}
// 多份历史周报 → AI 提炼写作风格 → 保存
async function distillStyle() {
  const samples = splitReportSamples(samplesDraft.value);
  if (!samples.length) return props.showToast(t("task.distillNoSamples"));
  if (samples.length < 2) return props.showToast(t("task.distillFewSamples"));
  if (!(await isAIConfigured())) return props.showToast(t("task.aiNotConfigured"));
  distilling.value = true;
  try {
    const { system, user } = buildDistillPrompt(samples);
    const style = (await aiComplete(user, { system })) || "";
    reportPrefs.value.style = truncate(style.trim(), STYLE_MAX);
    await saveReportPrefs();
    samplesDraft.value = "";
    stylePanel.value = "";
    props.showToast(t("task.styleSaved"));
  } catch (e) {
    props.showToast(t("task.distillFailed", { err: errText(e) }));
  } finally {
    distilling.value = false;
  }
}
// 清除模板与风格，恢复默认提示词
async function clearReportPrefs() {
  const ok = await askConfirm({
    title: t("task.clearPrefsTitle"),
    message: t("task.clearPrefsMsg"),
  });
  if (!ok) return;
  reportPrefs.value = { template: "", style: "" };
  await saveReportPrefs();
  props.showToast(t("task.prefsCleared"));
}

// 周范围与素材拼接已抽到 ../report/material.js：定时生成（src/report/index.js）与界面手动生成
// 必须产出同一份素材，放在一处才不会漂。此处直接 import 使用（weekRange / buildReportMaterial）。

// ------- 定时生成（周报闭环的定时触发：策略设置 + 立即生成；生成逻辑在 src/report/index.js）-------
const weeklyPolicy = ref({ enabled: false, weekday: 5, hour: 17, minute: 0 });
const weeklyGenerating = ref(false);
// 星期选项复用图表横轴的同一套 common.weekXxx 词条（0=周日，与 policy.weekday 口径一致）
const WEEKDAY_OPTIONS = computed(() => CHART_WEEKDAY_KEYS.map((key, i) => ({ value: i, label: t(key) })));

async function loadWeekly() {
  weeklyPolicy.value = await loadWeeklyPolicy();
}
// 控件变更即落盘（开关/星期/时间），无需额外的「保存」按钮
async function onWeeklyChange(next) {
  weeklyPolicy.value = next;
  try {
    await saveWeeklyPolicy(next);
  } catch (e) {
    props.showToast(t("task.saveFailedPlain", { err: errText(e) }));
  }
}
// 立即生成：等同手动触发一次定时生成（本周草稿），并把结果刷进弹窗
async function generateWeeklyNow() {
  if (weeklyGenerating.value) return;
  weeklyGenerating.value = true;
  try {
    const res = await generateWeeklyDraft();
    if (!res.ok) {
      props.showToast(res.reason === "no-ai" ? t("task.aiNotConfigured") : t("task.weeklyNoMaterial"));
      return;
    }
    reportRange.value = "this"; // 定时生成固定针对「本周」，让弹窗与草稿对齐
    reportText.value = res.text;
    editingReport.value = false;
    clearHeartHistory();
    props.showToast(t("task.weeklyGenerated"));
  } catch (e) {
    props.showToast(t("task.generateFailed", { err: errText(e) }));
  } finally {
    weeklyGenerating.value = false;
  }
}

async function openReport() {
  if (!(await isAIConfigured())) return props.showToast(t("task.aiNotConfigured"));
  await Promise.all([loadReportPrefs(), loadWeekly()]);
  showReport.value = true;
  editingReport.value = false;
  clearHeartHistory(); // 重新打开弹窗：心得对话从新的一轮开始
  // 不自动生成：恢复该周已保存的草稿（没有则留空，由用户点「重新生成」）
  reportText.value = await loadSavedReport(reportRange.value);
}

async function generateReport() {
  const range = weekRange(reportRange.value, t);
  const mat = buildReportMaterial({ dayLogs: dayLogs.value, iterations: iterations.value }, range, t);
  if (!mat.hasLogs) return props.showToast(t("task.noLogsInRange", { label: range.label }));
  generating.value = true;
  try {
    const text = await aiComplete(mat.text, {
      system: buildReportSystem(reportPrefs.value),
    });
    reportText.value = (text || "").trim();
    if (reportText.value) {
      clearHeartHistory(); // 周报整体重写：心得旧对话上下文作废
      editingReport.value = false; // 生成完回到渲染视图看效果
      autosaveReport(reportRange.value); // 生成即存草稿，防止关闭后丢失
    }
  } catch (e) {
    props.showToast(t("task.generateFailed", { err: errText(e) }));
  } finally {
    generating.value = false;
  }
}

async function switchRange(kind) {
  if (reportRange.value === kind || generating.value) return;
  reportRange.value = kind;
  editingReport.value = false;
  clearHeartHistory(); // 切换周范围：心得对话上下文作废
  reportText.value = await loadSavedReport(kind);
}

async function copyReport() {
  if (!reportText.value) return;
  try {
    await navigator.clipboard.writeText(reportText.value);
    props.showToast(t("task.reportCopied"));
  } catch (e) {
    props.showToast(t("task.copyFailed", { err: errText(e) }));
  }
}

// 本周心得可单独指定主题方向重写（不限于工作内容），可附带多张图片交 AI 分析作为素材
const heartOpen = ref(false);
const heartTopic = ref("");
const heartImages = ref([]); // data URL 数组
const heartImageInput = ref(null);
const heartLoading = ref(false);
const HEART_SECTION = REPORT_SECTIONS[1]; // 本周心得
const canRewriteHeart = computed(() => !!extractReportSection(reportText.value, HEART_SECTION));

// 心得重写多轮对话：保留每轮的 user 消息与 AI 回复，下一轮全部带上，
// 让 AI 记得上一轮的主题、图片与结果，支持连续修改多次（仅内存，不落盘）。
// 周报被重新生成/切换时上下文作废，自动清空。
const heartHistory = ref([]); // [{ role: "user"|"assistant", content }]，不含 system
const HEART_HISTORY_MAX = 6; // 最多保留 6 条 = 3 轮历史（含图片轮次 token 较大，够用）
const heartRounds = computed(() => Math.floor(heartHistory.value.length / 2) + 1); // 当前是第几轮
function clearHeartHistory() {
  heartHistory.value = [];
}

// 多选图片 → FileReader 转 data URL（沿用 AiExtract 的浏览器文件选择链路）
async function addHeartImages(e) {
  const files = Array.from(e.target.files || []).filter((f) => f.type && f.type.startsWith("image/"));
  if (!files.length) return props.showToast(t("task.pickImageFiles"));
  const remain = HEART_IMAGE_MAX - heartImages.value.length;
  if (remain <= 0) return props.showToast(t("task.imagesLimitRemove", { max: HEART_IMAGE_MAX }));
  const pick = files.slice(0, remain);
  if (pick.length < files.length) props.showToast(t("task.imagesLimitTruncated", { max: HEART_IMAGE_MAX, count: pick.length }));
  try {
    const urls = await Promise.all(
      pick.map(
        (f) =>
          new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error(t("task.imageReadFailed")));
            r.readAsDataURL(f);
          })
      )
    );
    heartImages.value.push(...urls);
  } catch (err) {
    props.showToast(t("task.imageReadFailedErr", { err: errText(err) }));
  }
  e.target.value = ""; // 允许重复选同一文件
}
function removeHeartImage(i) {
  heartImages.value.splice(i, 1);
}

async function rewriteHeart() {
  const current = reportText.value;
  if (!extractReportSection(current, HEART_SECTION)) {
    return props.showToast(t("task.noHeartSection"));
  }
  if (!(await isAIConfigured())) return props.showToast(t("task.aiNotConfigured"));
  heartLoading.value = true;
  try {
    const { system, user } = buildHeartPrompt(heartTopic.value, current, heartImages.value);
    // 持续对话：system + 历史轮次（若有）+ 当前消息；带图时 user 是 content 块数组，须走 aiChat
    const messages = [
      { role: "system", content: system },
      ...heartHistory.value,
      { role: "user", content: user },
    ];
    const text = (await aiChat(messages)) || "";
    // AI 偶发会带上标题行/编号，剥掉后替换进原文
    const clean = text.replace(/^#+\s*[^\n]*\n?/, "").trim();
    if (!clean) return props.showToast(t("task.aiEmptyResult"));
    // 记录本轮对话，供下一轮继续修改时引用
    heartHistory.value.push({ role: "user", content: user }, { role: "assistant", content: clean });
    if (heartHistory.value.length > HEART_HISTORY_MAX) {
      heartHistory.value = heartHistory.value.slice(-HEART_HISTORY_MAX);
    }
    reportText.value = replaceReportSection(current, HEART_SECTION, clean);
    heartTopic.value = "";
    heartImages.value = [];
    heartOpen.value = false;
    autosaveReport(reportRange.value); // 重写后的心得也自动落盘
    props.showToast(
      heartHistory.value.length > 2
        ? t("task.heartRewrittenRound", { round: heartRounds.value })
        : t("task.heartRewritten")
    );
  } catch (e) {
    props.showToast(t("task.rewriteFailed", { err: errText(e) }));
  } finally {
    heartLoading.value = false;
  }
}

// ------- 周报历史管理（独立 key reports.json，状态：新建 → 确认 → 归档）-------
const reports = ref([]);
const showHistory = ref(false);
const historyFilter = ref("all"); // all | pending | confirmed | archived
const historyDetail = ref(null); // 正在查看详情的周报
// 周报状态显示名：状态值（pending/confirmed/archived）是存储值，只做键名映射，不进字典
const REPORT_STATUS_KEYS = { pending: "task.statusPending", confirmed: "task.statusConfirmed", archived: "task.statusArchived" };
function statusLabel(status) {
  return t(REPORT_STATUS_KEYS[status] || "task.statusPending");
}
// 周范围显示名：优先现取（语言切换后立即生效），老数据只存了中文 rangeLabel 时原样回退
function reportRangeLabel(item) {
  if (!item) return "";
  return item.range === "last" ? t("task.rangeLast") : item.range === "this" ? t("task.rangeThis") : item.rangeLabel || "";
}
// 筛选标签用 computed：语言切换后重新求值
const HISTORY_FILTERS = computed(() => [
  { key: "all", label: t("task.filterAll") },
  { key: "pending", label: statusLabel("pending") },
  { key: "confirmed", label: statusLabel("confirmed") },
  { key: "archived", label: statusLabel("archived") },
]);

async function loadReports() {
  reports.value = (await invoke("load_data", { key: "reports" })) || [];
}
async function persistReports() {
  await invoke("save_data", { key: "reports", data: reports.value });
}
// 打开/切换周时恢复该周最近一次保存的草稿：优先「新建」态，其次最近更新的任意一条；没有返回空串
async function loadSavedReport(kind) {
  const list = (await invoke("load_data", { key: "reports" })) || [];
  const same = list.filter((r) => r.range === kind);
  if (!same.length) return "";
  const byNew = [...same].sort((a, b) => ((b.updatedAt || "") < (a.updatedAt || "") ? -1 : 1));
  const draft = byNew.find((r) => r.status === "pending");
  return draft ? draft.text : byNew[0].text;
}
// 生成/重写心得后自动落盘草稿（状态：新建），防止关闭后丢失；失败仅静默
async function autosaveReport(kind) {
  try {
    await loadReports();
    const range = weekRange(kind, t);
    const { list } = upsertReport(reports.value, {
      range: kind,
      rangeLabel: range.label,
      text: reportText.value,
    });
    reports.value = list;
    await persistReports();
  } catch (e) {
    /* 自动保存失败不打断当前操作 */
  }
}
function relTime(iso) {
  return iso ? relativeTime(new Date(iso).getTime()) : "";
}
// 列表摘要：取正文第一行非标题行，超长截断
function reportSummary(text) {
  const s = String(text || "").trim();
  const line = s.split("\n").find((l) => l.trim() && !/^#/.test(l)) || s.slice(0, 60);
  return line.length > 42 ? line.slice(0, 42) + "…" : line;
}
const filteredReports = computed(() => {
  const list = [...reports.value].sort((a, b) =>
    (b.updatedAt || "") < (a.updatedAt || "") ? -1 : 1
  );
  return historyFilter.value === "all" ? list : list.filter((r) => r.status === historyFilter.value);
});

// 保存当前草稿：同范围已有「新建」草稿则更新内容，否则新增一条（状态：新建）
async function saveReport() {
  if (!reportText.value || generating.value) return;
  await loadReports();
  const range = weekRange(reportRange.value, t);
  const { list, created } = upsertReport(reports.value, {
    range: reportRange.value,
    rangeLabel: range.label,
    text: reportText.value,
  });
  reports.value = list;
  await persistReports();
  props.showToast(created ? t("task.reportSavedNew") : t("task.reportDraftUpdated"));
}
async function openHistory() {
  await loadReports();
  historyFilter.value = "all";
  historyDetail.value = null;
  showHistory.value = true;
}
async function historyAdvance(r) {
  const next = advanceReportStatus(r.status);
  reports.value = updateReportStatus(reports.value, r.id, next);
  await persistReports();
  props.showToast(t("task.statusAdvanced", { label: statusLabel(next) }));
  // 确认门禁：状态照常前进（语义不变），「确认」时额外问一句是否归档到速记；
  // 归档失败不阻断——它只是附加动作，不能反过来把已完成的确认回滚。
  if (next !== "confirmed") return;
  const ok = await askConfirm({
    title: t("task.weeklyArchiveConfirmTitle"),
    message: t("task.weeklyArchiveConfirmMsg"),
    danger: false,
  });
  if (!ok) return;
  try {
    await archiveDraftToSnippet(r);
    props.showToast(t("task.weeklyArchived"));
  } catch (e) {
    props.showToast(t("task.weeklyArchiveFailed", { err: errText(e) }));
  }
}
async function historyRecover(r) {
  reports.value = updateReportStatus(reports.value, r.id, recoverReportStatus(r.status));
  await persistReports();
  props.showToast(t("task.recoveredToConfirmed"));
}
async function historyRemove(r) {
  const ok = await askConfirm({
    title: t("task.deleteReportTitle"),
    message: t("task.deleteReportMsg", { label: r.rangeLabel }),
  });
  if (!ok) return;
  reports.value = reports.value.filter((x) => x.id !== r.id);
  await persistReports();
  if (historyDetail.value && historyDetail.value.id === r.id) historyDetail.value = null;
  props.showToast(t("task.reportDeleted"));
}
function historyCopy(r) {
  navigator.clipboard.writeText(r.text);
  props.showToast(t("task.markdownCopied"));
}
// 历史详情手动微调：编辑 Markdown 原文，保存后刷新更新时间
const historyEdit = ref(false);
async function historyEditSave() {
  if (!historyDetail.value) return;
  historyDetail.value.updatedAt = new Date().toISOString();
  await persistReports();
  historyEdit.value = false;
  props.showToast(t("task.changesSaved"));
}
</script>

<template>
  <main class="content">
    <div class="hm-card">
      <div class="hm-head">
        <div class="hm-heading">
          <h4 class="hm-title"><Icon name="calendar" :size="15" /> {{ t("task.monthTrendTitle") }}</h4>
          <p><span>{{ t("task.myHours") }}</span>{{ monthSummary }}</p>
        </div>
        <div class="hm-actions">
          <button class="btn-primary sm" @click="openAddTask"><Icon name="plus" :size="13" /> {{ t("task.addHours") }}</button>
          <button class="btn-ghost sm" @click="openReport"><Icon name="sparkles" :size="13" /> {{ t("task.generateReport") }}</button>
          <button class="btn-ghost sm" @click="exportHoursXlsx"><Icon name="download" :size="13" /> {{ t("task.export") }}</button>
          <button class="btn-ghost sm" @click="copySummary"><Icon name="copy" :size="13" /> {{ t("task.copySummary") }}</button>
        </div>
      </div>

      <div class="chart-toolbar">
          <div class="month-nav">
            <button class="icon-btn sm" :title="t('task.prevMonth')" @click="moveMonth(-1)"><Icon name="chevron-right" :size="14" /></button>
            <label class="month-picker">
              <span>{{ selectedMonthLabel }}</span>
              <input :value="selectedMonth" type="month" :max="fmtDate(new Date()).slice(0, 7)" :aria-label="t('task.monthPickerLabel')" @change="selectMonth($event.target.value)" />
            </label>
            <button class="icon-btn sm next" :title="t('task.nextMonth')" :disabled="isCurrentMonth" @click="moveMonth(1)"><Icon name="chevron-right" :size="14" /></button>
            <button v-if="!isCurrentMonth" class="btn-ghost sm" @click="goCurrentMonth">{{ t("task.currentMonth") }}</button>
          </div>
          <span class="chart-context">{{ t("task.logHoursDaily") }}</span>
        </div>
        <div class="hm-grid">
          <div class="hours-chart" :style="{ '--chart-max': chartMax }">
            <div class="chart-y-axis">
              <span v-for="tick in chartTicks" :key="tick" :style="{ bottom: (tick / chartMax * 100) + '%' }">{{ tick }}h</span>
            </div>
            <div class="chart-plot">
              <i v-for="tick in chartTicks" :key="tick" class="chart-line" :class="{ standard: tick === STANDARD_HOURS }" :style="{ bottom: `calc(38px + (100% - 38px) * ${tick / chartMax})` }">
                <em v-if="tick === STANDARD_HOURS">{{ t("task.standard8h") }}</em>
              </i>
              <div class="chart-columns" :style="{ '--month-days': chartDays.length }">
                <button
                  v-for="day in chartDays"
                  :key="day.date"
                  class="chart-day"
                  :class="{ selected: day.date === selectedDate, today: day.isToday, future: day.isFuture, weekend: day.isWeekend, 'week-start': day.isWeekStart, overtime: day.overtime > 0 }"
                  :disabled="day.isFuture"
                  :title="t('task.dayTooltip', { date: day.date, total: day.total, overtime: day.overtime ? t('task.overtimePart', { hours: day.overtime }) : '' })"
                  @click="selectedDate = day.date"
                >
                  <span class="chart-bar" :style="{ height: (day.total / chartMax * 100) + '%' }">
                    <span v-if="day.total" class="chart-value">{{ chartHours(day.total) }}</span>
                    <i v-if="day.overtime" class="overtime" :style="{ height: (day.overtime / day.total * 100) + '%' }"></i>
                    <i class="regular" :style="{ height: (day.total ? day.regular / day.total * 100 : 0) + '%' }"></i>
                  </span>
                  <span class="chart-label"><b>{{ day.day }}</b><small>{{ t(day.weekday) }}</small></span>
                </button>
              </div>
            </div>
          </div>
          <div class="chart-legend">
            <span><i class="regular"></i>{{ t("task.legendDaily") }}</span>
            <span><i class="overtime"></i>{{ t("task.legendOver8h") }}</span>
            <span class="legend-note">{{ t("task.legendClickHint") }}</span>
          </div>
        </div>
    </div>

    <div class="day-list">
      <div class="day-head">
        <h4><Icon name="repeat" :size="15" /> {{ t("task.dayIterationTitle", { prefix: selectedDateTitle }) }}</h4>
      </div>
      <div class="day-legend">
        <span><i class="dot it"></i> {{ t("common.sourceIteration") }} {{ round(selectedIterationEntries.reduce((sum, entry) => sum + entry.hours, 0)) }}h</span>
        <span v-if="selectedProblemEntries.length"><i class="dot pr"></i> {{ t("common.sourceProblem") }} {{ round(selectedProblemEntries.reduce((sum, entry) => sum + entry.hours, 0)) }}h</span>
      </div>
      <div v-if="selectedSubEntries.length || selectedLegacyEntries.length" class="day-item">
        <div v-if="selectedSubEntries.length" class="day-entries">
          <template v-for="(e, i) in selectedSubEntries" :key="i">
            <div v-if="subEdit.id !== e.s.id" class="day-entry-wrap">
              <span class="day-entry" :style="{ borderColor: WORK_SOURCES_MAP.iteration.color }">
                <em :style="{ color: WORK_SOURCES_MAP.iteration.color }">{{ e.hours }}h</em> {{ e.title }}<span v-if="e.note" class="de-note">{{ t("task.noteParen", { note: e.note }) }}</span>
              </span>
              <button class="icon-btn xs" :title="t('task.editSubTitle')" @click="startEditSub(e.s)"><Icon name="edit" :size="13" /></button>
              <button class="icon-btn xs" :title="t('common.delete')" @click="removeSub({ it: e.it, r: e.r, s: e.s })"><Icon name="x" :size="13" /></button>
            </div>
            <div v-else class="day-entry-wrap">
              <span class="day-entry editing" :style="{ borderColor: WORK_SOURCES_MAP.iteration.color }">
                <input v-model="subEdit.hours" type="number" class="de-edit-hours" min="0" step="0.5" :title="t('task.totalHours')" @keyup.enter="saveEditSub({ it: e.it, r: e.r, s: e.s })" @keyup.esc="cancelEditSub" /><i class="de-h">h</i>
                <span class="de-iter">{{ e.it.title }} · </span><input v-model="subEdit.name" class="de-edit-name" :placeholder="t('task.subNameLabel')" @keyup.enter="saveEditSub({ it: e.it, r: e.r, s: e.s })" @keyup.esc="cancelEditSub" />
                <span v-if="e.note" class="de-note">{{ t("task.noteParen", { note: e.note }) }}</span>
              </span>
              <input v-model="subEdit.date" type="date" class="de-edit-date" :title="t('task.hoursDate')" @keyup.enter="saveEditSub({ it: e.it, r: e.r, s: e.s })" @keyup.esc="cancelEditSub" />
              <button class="btn-ghost xs" @click="saveEditSub({ it: e.it, r: e.r, s: e.s })"><Icon name="check" :size="11" /> {{ t("task.save") }}</button>
              <button class="btn-ghost xs" @click="cancelEditSub">{{ t("common.cancel") }}</button>
            </div>
          </template>
        </div>
        <!-- 历史「记一笔」工时（录入入口已下线，旧数据仍在统计口径里）：
             它没有对应的子任务，所以只读——渲染成和子任务行同款的条目，但不给编辑/删除按钮。 -->
        <div v-if="selectedLegacyEntries.length" class="day-entries">
          <span v-for="(entry, index) in selectedLegacyEntries" :key="`legacy-${index}`" class="day-entry" :style="{ borderColor: WORK_SOURCES_MAP.iteration.color }">
            <em :style="{ color: WORK_SOURCES_MAP.iteration.color }">{{ entry.hours }}h</em> {{ entry.title }}<span v-if="entry.note" class="de-note">{{ t("task.noteParen", { note: entry.note }) }}</span>
          </span>
        </div>
      </div>
      <div v-else class="selected-empty">
        <Icon name="repeat" :size="26" />
        <h4>{{ t("task.emptyDayTitle") }}</h4>
        <p>{{ t("task.emptyDayDesc") }}</p>
        <!-- 就地给入口：说明里写着"点右上角"，但空态自己就能开录入，省一次视线移动 -->
        <button class="btn-ghost sm" type="button" @click="openAddTask(selectedDate)">
          <Icon name="plus" :size="13" />{{ t("task.addHours") }}
        </button>
      </div>
      <div v-if="selectedProblemEntries.length" class="problem-supplement">
        <h5><Icon name="alert" :size="13" /> {{ t("task.sameDayProblemHours") }}</h5>
        <div class="day-entries">
          <span v-for="(entry, index) in selectedProblemEntries" :key="index" class="day-entry" :style="{ borderColor: WORK_SOURCES_MAP.problem.color }">
            <em :style="{ color: WORK_SOURCES_MAP.problem.color }">{{ entry.hours }}h</em> {{ entry.title }}<span v-if="entry.note" class="de-note">{{ t("task.noteParen", { note: entry.note }) }}</span>
          </span>
        </div>
      </div>
    </div>

  </main>

  <!-- 添加工时弹窗（本地快速录入：迭代/需求/子任务） -->
  <div v-if="showAddTask" class="modal-mask">
    <div class="modal add-task-modal" v-dialog>
      <h2><Icon name="plus" :size="18" /> {{ t("task.addHours") }}</h2>
      <div class="add-form">
        <label class="add-field">
          <span>{{ t("common.iteration") }}</span>
          <div class="add-select-row">
            <select v-model="addIterationId" class="add-select" @change="onAddIterationChange">
              <option v-for="opt in addIterationOptions()" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
            </select>
            <input v-if="addIterationId === '__new'" v-model="addNewIteration" class="add-input" :placeholder="t('task.newIterationPh')" />
          </div>
        </label>
        <label class="add-field">
          <span>{{ t("task.requirement") }}</span>
          <div class="add-select-row">
            <select v-model="addRequirementId" class="add-select">
              <option v-for="opt in addRequirementOptions()" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
            </select>
            <input v-if="addRequirementId === '__new'" v-model="addNewRequirement" class="add-input" :placeholder="t('task.newRequirementPh')" />
          </div>
        </label>
        <label class="add-field">
          <span>{{ t("task.subNameLabel") }}</span>
          <input v-model="addSubName" class="add-input" :placeholder="t('task.subNamePh')" @keyup.enter="saveAddTask" />
        </label>
        <div class="add-row">
          <label class="add-field add-hours">
            <span>{{ t("task.hoursHours") }}</span>
            <input v-model="addSubHours" type="number" class="add-input" min="0" step="0.5" placeholder="0" @keyup.enter="saveAddTask" />
          </label>
          <label class="add-field">
            <span>{{ t("task.attributionDate") }}</span>
            <input v-model="addSubDate" type="date" class="add-input" :max="fmtDate(new Date())" />
          </label>
        </div>
        <p class="add-tip">{{ t("task.addTip") }}</p>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" @click="showAddTask = false">{{ t("common.cancel") }}</button>
        <button class="btn-primary" :disabled="addSaving" @click="saveAddTask"><Icon name="check" :size="14" /> {{ addSaving ? t("task.saving") : t("task.save") }}</button>
      </div>
    </div>
  </div>

  <!-- AI 周报弹窗 -->
  <div v-if="showReport" class="modal-mask">
    <div class="modal report-modal" v-dialog>
      <h2><Icon name="sparkles" :size="18" /> {{ t("task.reportModalTitle") }}</h2>
      <div class="report-ops">
        <div class="filters">
          <button class="chip" :class="{ active: reportRange === 'this' }" :disabled="generating" @click="switchRange('this')">{{ t("task.rangeThis") }}</button>
          <button class="chip" :class="{ active: reportRange === 'last' }" :disabled="generating" @click="switchRange('last')">{{ t("task.rangeLast") }}</button>
        </div>
        <div class="report-btns">
          <button class="btn-ghost sm" :disabled="generating" @click="generateReport"><Icon name="repeat" :size="14" /> {{ t("task.regenerate") }}</button>
          <button class="btn-ghost sm" :disabled="!reportText || generating" @click="editingReport = !editingReport"><Icon name="edit" :size="14" /> {{ editingReport ? t("task.finishTweak") : t("task.manualTweak") }}</button>
          <button class="btn-ghost sm" :disabled="!reportText || generating" @click="copyReport"><Icon name="copy" :size="14" /> {{ t("task.copyMarkdown") }}</button>
        </div>
      </div>
      <!-- 周报风格记忆：模板导入 / AI 提炼风格 -->
      <div class="style-bar">
        <span class="style-status">
          <Icon name="note" :size="13" />
          <template v-if="reportPrefs.template && reportPrefs.style">{{ t("task.styleBoth") }}</template>
          <template v-else-if="reportPrefs.template">{{ t("task.styleTemplateOnly") }}</template>
          <template v-else-if="reportPrefs.style">{{ t("task.styleStyleOnly") }}</template>
          <template v-else>{{ t("task.styleDefault") }}</template>
        </span>
        <div class="style-btns">
          <button class="btn-ghost sm" @click="stylePanel = stylePanel === 'template' ? '' : 'template'"><Icon name="note" :size="13" /> {{ t("task.importTemplate") }}</button>
          <button class="btn-ghost sm" @click="stylePanel = stylePanel === 'distill' ? '' : 'distill'"><Icon name="sparkles" :size="13" /> {{ t("task.distillStyle") }}</button>
          <button v-if="hasReportPrefs" class="btn-ghost sm" @click="clearReportPrefs"><Icon name="trash" :size="13" /> {{ t("task.clear") }}</button>
        </div>
      </div>
      <div v-if="stylePanel === 'template'" class="style-panel">
        <textarea v-model="templateDraft" :placeholder="t('task.templatePh')"></textarea>
        <div class="style-panel-foot">
          <span class="hint">{{ t("task.templateHint") }}</span>
          <button class="btn-ghost sm" :disabled="!templateDraft.trim()" @click="saveTemplate">{{ t("task.saveTemplate") }}</button>
        </div>
      </div>
      <div v-else-if="stylePanel === 'distill'" class="style-panel">
        <textarea v-model="samplesDraft" :placeholder="t('task.samplesPh')"></textarea>
        <div class="style-panel-foot">
          <span class="hint">{{ t("task.samplesHint") }}</span>
          <button class="btn-ghost sm" :disabled="!samplesDraft.trim() || distilling" @click="distillStyle">
            <Icon name="sparkles" :size="13" /> {{ distilling ? t("task.distilling") : t("task.distillAndSave") }}
          </button>
        </div>
      </div>
      <!-- 定时生成设置行：启用开关 + 星期 + 时间 + 立即生成（配置即落盘，见 src/report/index.js） -->
      <WeeklySchedulePanel
        :policy="weeklyPolicy"
        :weekday-options="WEEKDAY_OPTIONS"
        :generating="weeklyGenerating"
        @change="onWeeklyChange"
        @generate="generateWeeklyNow"
      />
      <div v-if="generating" class="report-loading"><Icon name="sparkles" :size="14" /> {{ t("task.generating") }}</div>
      <textarea v-else-if="editingReport" v-model="reportText" class="report-edit" spellcheck="false" :placeholder="t('task.reportEditPh')"></textarea>
      <!-- eslint-disable-next-line vue/no-v-html -- reportHtml 走 renderMarkdown（先 escapeHtml），来源是本地周报文本 -->
      <div v-else-if="reportText" class="report-body md" v-html="reportHtml"></div>
      <div v-else class="report-loading">{{ t("task.reportEmptyHint") }}</div>
      <!-- 本周心得：可指定主题方向单独重写 -->
      <div v-if="canRewriteHeart" class="heart-row">
        <button class="btn-ghost sm" @click="heartOpen = !heartOpen">
          <Icon name="sparkles" :size="13" /> {{ heartOpen ? t("task.collapse") : t("task.rewriteHeart") }}
        </button>
        <template v-if="heartOpen">
          <input v-model="heartTopic" class="heart-input" :placeholder="t('task.heartTopicPh')" @keydown.enter="rewriteHeart" />
          <button class="btn-ghost sm" @click="heartImageInput && heartImageInput.click()">
            <Icon name="image" :size="13" /> {{ t("task.imageBtn") }}<template v-if="heartImages.length">{{ t("common.badgeCount", { n: heartImages.length }) }}</template>
          </button>
          <input ref="heartImageInput" type="file" accept="image/*" multiple class="heart-file" @change="addHeartImages" />
          <span v-for="(img, i) in heartImages" :key="i" class="heart-thumb">
            <img :src="img" alt="" />
            <button type="button" class="heart-thumb-x" :title="t('task.removeImage')" @click="removeHeartImage(i)"><Icon name="x" :size="10" /></button>
          </span>
          <button class="btn-ghost sm" :disabled="heartLoading" @click="rewriteHeart">
            <Icon name="sparkles" :size="13" /> {{ heartLoading ? t("task.rewriting") : t("task.rewriteByDirection") }}
          </button>
          <span v-if="heartRounds > 1" class="heart-rounds"><Icon name="chat" :size="12" /> {{ t("task.roundsChatted", { n: heartRounds - 1 }) }}</span>
          <button v-if="heartRounds > 1" class="btn-ghost sm" :title="t('task.clearChatTitle')" @click="clearHeartHistory">
            <Icon name="trash" :size="13" /> {{ t("task.clearChat") }}
          </button>
        </template>
      </div>
      <p class="report-tip">{{ t("task.reportTip") }}</p>
      <div class="modal-foot">
        <button class="btn-ghost" @click="openHistory"><Icon name="folder" :size="14" /> {{ t("task.reportHistory") }}</button>
        <button class="btn-ghost" :disabled="!reportText || generating" @click="saveReport"><Icon name="check" :size="14" /> {{ t("task.saveReport") }}</button>
        <button class="btn-ghost" @click="showReport = false">{{ t("task.close") }}</button>
      </div>
    </div>
  </div>

  <!-- 周报历史管理弹窗（列表/详情，状态：新建 → 确认 → 归档） -->
  <div v-if="showHistory" class="modal-mask hist-mask" @click.self="showHistory = false">
    <div class="modal hist-modal" v-dialog>
      <h2><Icon name="folder" :size="18" /> {{ t("task.reportHistory") }} <em class="hist-count">{{ reports.length }}</em></h2>

      <div class="filters hist-filters">
        <button v-for="f in HISTORY_FILTERS" :key="f.key" class="chip" :class="{ active: historyFilter === f.key }" @click="historyFilter = f.key">{{ f.label }}</button>
      </div>

      <!-- 详情视图 -->
      <div v-if="historyDetail" class="hist-detail">
        <div class="hist-detail-hd">
          <span class="hist-badge" :class="'st-' + historyDetail.status">{{ statusLabel(historyDetail.status) }}</span>
          <span class="hist-detail-title">{{ t("task.updatedAt", { label: reportRangeLabel(historyDetail), time: relTime(historyDetail.updatedAt) }) }}</span>
        </div>
        <textarea v-if="historyEdit" v-model="historyDetail.text" class="hist-edit" spellcheck="false"></textarea>
        <!-- eslint-disable-next-line vue/no-v-html -- 与 MarkdownRender 同一渲染路径（先 escapeHtml） -->
        <div v-else class="report-body md" v-html="renderMarkdown(historyDetail.text)"></div>
        <div class="hist-detail-ops">
          <button v-if="!historyEdit" class="btn-ghost sm" @click="historyEdit = true"><Icon name="edit" :size="13" /> {{ t("task.manualTweak") }}</button>
          <button v-else class="btn-ghost sm" @click="historyEditSave"><Icon name="check" :size="13" /> {{ t("task.saveChanges") }}</button>
          <button class="btn-ghost sm" @click="historyCopy(historyDetail)"><Icon name="copy" :size="13" /> {{ t("task.copyMarkdown") }}</button>
          <button class="btn-ghost sm" @click="historyDetail = null; historyEdit = false">{{ t("task.backToList") }}</button>
        </div>
      </div>

      <!-- 列表视图 -->
      <div v-else class="hist-list">
        <div v-if="!filteredReports.length" class="hist-empty">
          <span v-if="historyFilter === 'all'">{{ t("task.historyEmptyAll") }}</span>
          <span v-else>{{ t("task.historyEmptyFiltered", { label: statusLabel(historyFilter) }) }}</span>
        </div>
        <div v-for="r in filteredReports" :key="r.id" class="hist-item">
          <span class="hist-badge" :class="'st-' + r.status">{{ statusLabel(r.status) }}</span>
          <div class="hist-item-main" @click="historyDetail = r">
            <span class="hist-title" :title="reportRangeLabel(r) + ' · ' + reportSummary(r.text)">{{ reportRangeLabel(r) }} · {{ reportSummary(r.text) }}</span>
            <span class="hist-time">{{ t("task.histTime", { time: relTime(r.updatedAt), count: r.text.length }) }}</span>
          </div>
          <div class="hist-item-ops">
            <button class="mini" :title="t('task.view')" @click="historyDetail = r"><Icon name="eye" :size="13" /></button>
            <button v-if="r.status === 'pending'" class="mini" :title="t('task.markConfirmed')" @click="historyAdvance(r)"><Icon name="check" :size="13" /></button>
            <button v-else-if="r.status === 'confirmed'" class="mini" :title="t('task.archive')" @click="historyAdvance(r)"><Icon name="folder" :size="13" /></button>
            <button v-else class="mini" :title="t('task.restoreToConfirmed')" @click="historyRecover(r)"><Icon name="repeat" :size="13" /></button>
            <button class="mini danger" :title="t('common.delete')" @click="historyRemove(r)"><Icon name="trash" :size="13" /></button>
          </div>
        </div>
      </div>

      <div class="modal-foot"><button class="btn-ghost" @click="showHistory = false">{{ t("task.close") }}</button></div>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: var(--sp-2); }
.chip { display: inline-flex; align-items: center; gap: var(--sp-1); background: var(--card); border: 1px solid var(--border-strong); padding: var(--sp-2) 13px; border-radius: var(--r-sm); font-size: var(--fs-md); font-weight: 600; cursor: pointer; color: var(--text-soft); transition: all 0.15s; }
.chip:hover { border-color: var(--border-strong); }
.chip.active { background: var(--accent-hover); color: var(--text-invert); border-color: var(--accent-hover); }

.content { flex: 1; padding: var(--sp-6) 28px 36px; display: flex; flex-direction: column; gap: var(--sp-6); }

/* 未提交工时：编辑态（本地子任务就地修改名称/工时/归属日） */
.day-entry-wrap { display: inline-flex; align-items: center; gap: var(--sp-05); }
.day-entry.editing { border-style: dashed; background: var(--warn-soft); }
/* 编辑态：chip 外观不变，仅工时数字与名称就地变为下划线输入框；日期框跟在条目后 */
.de-edit-hours, .de-edit-name { border: none; border-bottom: 1px solid var(--primary); border-radius: 0; background: transparent; outline: none; padding: 0 1px; font-size: var(--fs-xs); font-family: inherit; color: var(--text); }
.de-edit-hours { width: 40px; text-align: right; font-weight: 700; color: var(--accent-hover); }
.de-edit-name { width: 150px; }
.de-edit-hours:focus, .de-edit-name:focus { border-bottom-color: var(--primary-hover); }
.de-h { font-style: normal; font-weight: 700; color: var(--accent-hover); margin-right: var(--sp-05); }
.de-iter { color: var(--text-soft); }
.de-edit-date { padding: 3px var(--sp-1); border: 1px solid var(--border-strong); border-radius: var(--r-xs); font-size: var(--fs-xs); outline: none; background: var(--card); color: var(--text-soft); font-family: inherit; width: 116px; }
.de-edit-date:focus { border-color: var(--primary); color: var(--text); }

/* 月度工时图 */
.add-task-modal { width: 480px; }
.add-form { display: flex; flex-direction: column; gap: var(--sp-4); }
.add-field { display: flex; flex-direction: column; gap: 5px; font-size: var(--fs-sm); color: var(--text-soft); }
.add-field > span { font-weight: 600; }
.add-select-row { display: flex; gap: var(--sp-2); align-items: center; }
.add-select, .add-input { flex: 1; min-width: 0; background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-md); color: var(--text); font-family: inherit; }
.add-select:focus, .add-input:focus { outline: none; border-color: var(--primary); }
.add-row { display: flex; gap: var(--sp-4); }
.add-row .add-field { flex: 1; }
.add-tip { margin: 0; font-size: var(--fs-xs); color: var(--muted); }

/* 月度工时图 */
.hm-card { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 18px var(--sp-7) var(--sp-6); box-shadow: var(--shadow); }
.hm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: var(--sp-5); flex-wrap: wrap; }
.hm-heading { min-width: 180px; }
.hm-title { margin: 0; font-size: var(--fs-md); font-weight: 700; display: inline-flex; align-items: center; gap: var(--sp-1); }
.hm-heading p { margin: 5px 0 0; color: var(--muted); font-size: var(--fs-sm); }
.hm-heading p span { margin-right: var(--sp-2); color: var(--text); font-weight: 600; }
.hm-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2); flex-wrap: wrap; }
.chart-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-3) 0 var(--sp-2); border-top: 1px solid var(--border); }
.chart-context { color: var(--muted); font-size: var(--fs-xs); }
.month-nav { display: flex; align-items: center; gap: var(--sp-1); }
.month-nav .icon-btn.sm { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; }
.month-nav .icon-btn:first-child svg { transform: rotate(180deg); }
.month-nav .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.month-picker { position: relative; display: grid; place-items: center; min-width: 112px; height: 30px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card); color: var(--text); font-family: var(--font-num); font-size: var(--fs-sm); font-weight: 700; cursor: pointer; }
.month-picker input { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
.hm-grid { width: 100%; overflow-x: auto; }
.hours-chart { display: grid; grid-template-columns: 42px minmax(920px, 1fr); min-width: 962px; padding: var(--sp-6) 0 2px; }
.chart-y-axis { position: relative; height: 232px; }
.chart-y-axis span { position: absolute; right: 8px; transform: translateY(50%); color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.chart-plot { position: relative; height: 270px; padding-bottom: 38px; }
.chart-line { position: absolute; left: 0; right: 0; height: 1px; background: var(--border); pointer-events: none; }
.chart-line.standard { z-index: 2; height: 0; border-top: 1px dashed var(--warn); background: none; }
.chart-line em { position: absolute; right: 4px; bottom: 3px; color: var(--warn-deep); font-size: var(--fs-xs); font-style: normal; font-weight: 700; }
.chart-columns { position: absolute; inset: 0 0 38px; display: grid; grid-template-columns: repeat(var(--month-days), minmax(22px, 1fr)); align-items: end; gap: var(--sp-0); }
.chart-day { position: relative; height: 100%; padding: 0; border: none; border-radius: var(--r-xs) var(--r-xs) 0 0; background: transparent; cursor: pointer; }
.chart-day:hover:not(:disabled) { background: color-mix(in srgb, var(--primary) 6%, transparent); }
.chart-day.selected { background: var(--primary-soft); box-shadow: inset 0 -2px 0 var(--primary); }
.chart-day.weekend:not(.selected) { background: color-mix(in srgb, var(--well) 45%, transparent); }
.chart-day.week-start::before { content: ""; position: absolute; top: 0; bottom: 0; left: -2px; width: 1px; background: var(--border-strong); opacity: 0.65; }
.chart-day.selected .chart-label { color: var(--primary); font-weight: 600; }
.chart-day.today .chart-label { color: var(--primary); font-weight: 700; }
.chart-day.future { opacity: 0.35; cursor: default; }
.chart-day.weekend .chart-label { color: var(--text-dim); }
.chart-day:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.chart-bar { position: absolute; left: 24%; right: 24%; bottom: 0; display: flex; flex-direction: column; justify-content: flex-end; min-height: 0; overflow: visible; border-radius: var(--r-xs) var(--r-xs) 0 0; transition: height 0.2s ease; }
.chart-bar > i { display: block; width: 100%; }
.chart-bar .regular { background: var(--primary); }
.chart-bar .overtime { border-radius: var(--r-xs) var(--r-xs) 0 0; background: var(--amber); }
.chart-value { position: absolute; left: 50%; top: -17px; transform: translateX(-50%); color: var(--text-soft); font-family: var(--font-num); font-size: var(--fs-xs); font-weight: 700; white-space: nowrap; }
.chart-day.overtime .chart-value { color: var(--warn-deep); }
.chart-label { position: absolute; left: 0; right: 0; bottom: -35px; display: flex; flex-direction: column; align-items: center; gap: 1px; color: var(--muted); text-align: center; }
.chart-label b { font-family: var(--font-num); font-size: var(--fs-xs); font-weight: 600; line-height: 1; }
.chart-label small { position: relative; display: inline-flex; align-items: center; gap: var(--sp-0); font-size: var(--fs-xs); line-height: 1; white-space: nowrap; }
.chart-legend { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-6); margin-top: 7px; color: var(--muted); font-size: var(--fs-xs); }
.chart-legend span { display: inline-flex; align-items: center; gap: 5px; }
.chart-legend i { width: 10px; height: 10px; border-radius: var(--r-xs); }
.chart-legend .regular { background: var(--primary); }
.chart-legend .overtime { background: var(--amber); }
.chart-legend .legend-note { margin-left: auto; }
.day-list { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: var(--sp-6) 18px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: var(--sp-5); }
.day-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-6); }
.day-head h4 { margin: 0; display: flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-md); font-weight: 700; }
.day-legend { display: flex; align-items: center; gap: var(--sp-6); font-size: var(--fs-sm); color: var(--muted); padding-bottom: var(--sp-4); border-bottom: 1px dashed var(--border); flex-wrap: wrap; }
.day-legend span { display: inline-flex; align-items: center; gap: 5px; }
.day-legend .dot { width: 10px; height: 10px; border-radius: var(--r-xs); display: inline-block; }
.day-legend .dot.it { background: var(--accent); }
.day-legend .dot.pr { background: var(--danger); }
.day-item { display: flex; flex-direction: column; gap: var(--sp-1); }
.day-entries { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.day-entry { font-size: var(--fs-xs); color: var(--text-soft); background: var(--card); border: 1px solid var(--border-strong); border-left-width: 3px; border-radius: var(--r-xs); padding: 3px var(--sp-2); }
.day-entry em { font-style: normal; font-weight: 700; margin-right: var(--sp-05); }
.de-note { color: var(--muted); }
.selected-empty { display: flex; flex-direction: column; align-items: center; padding: 22px var(--sp-6); color: var(--muted); text-align: center; }
.selected-empty > svg { color: var(--faint); }
.selected-empty h4 { margin: var(--sp-2) 0 4px; color: var(--text-soft); font-size: var(--fs-md); }
.selected-empty p { margin: 0; font-size: var(--fs-sm); }
.selected-empty .btn-ghost { margin-top: var(--sp-3); }
.problem-supplement { padding-top: var(--sp-4); border-top: 1px dashed var(--border); }
.problem-supplement h5 { margin: 0 0 9px; display: flex; align-items: center; gap: 5px; color: var(--text-soft); font-size: var(--fs-sm); }

/* 空状态：底座见 globals.css（.empty / .empty-ico），这里只留本页特有的间距 */
.empty-ico { margin-bottom: var(--sp-1); }
.empty h2 { font-size: var(--fs-xl); margin: var(--sp-2) 0 var(--sp-1); font-weight: 700; }
.empty p { color: var(--muted); font-size: var(--fs-base); margin: 0 0 22px; max-width: 460px; margin-left: auto; margin-right: auto; }

/* AI 周报弹窗 */
.report-modal { width: 680px; }
.report-ops { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-5); }
.report-btns { display: flex; gap: var(--sp-2); }
.report-loading { display: flex; align-items: center; gap: 7px; padding: 26px var(--sp-05); color: var(--muted); font-size: var(--fs-md); justify-content: center; }
.report-tip { font-size: var(--fs-xs); color: var(--muted); margin: var(--sp-4) 0 0; }
.report-body { border: 1px solid var(--card-border); border-radius: var(--r-md); padding: var(--sp-05) 18px; background: var(--bg); font-size: var(--fs-md); line-height: var(--lh-body); max-height: 52vh; overflow-y: auto; }
.report-body :deep(h2), .report-body :deep(h3), .report-body :deep(h4) { font-size: var(--fs-base); margin: var(--sp-5) 0 var(--sp-1); }
.report-body :deep(p) { margin: var(--sp-2) 0; }
.report-body :deep(ul), .report-body :deep(ol) { margin: var(--sp-1) 0; padding-left: 22px; }
.report-body :deep(li) { margin: 3px 0; }
.report-body :deep(code) { background: var(--well); border-radius: var(--r-xs); padding: 1px 5px; font-size: var(--fs-sm); font-family: var(--font-mono); }
.report-body :deep(hr) { border: none; border-top: 1px dashed var(--border-strong); margin: var(--sp-4) 0; }

/* 手动微调：Markdown 原文编辑框 */
.report-edit, .hist-edit { width: 100%; min-height: 320px; max-height: 52vh; box-sizing: border-box; background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-md); padding: var(--sp-4) var(--sp-6); font-size: var(--fs-md); line-height: var(--lh-body); color: var(--text); resize: vertical; font-family: inherit; }
.report-edit:focus, .hist-edit:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.hist-edit { min-height: 200px; }

/* 周报历史管理弹窗 */
.hist-mask { z-index: var(--z-front); }
.hist-modal { width: 680px; }
.hist-modal h2 { display: flex; align-items: center; gap: var(--sp-2); }
.hist-count { font-style: normal; font-weight: 700; color: var(--accent-hover); background: var(--accent-soft); padding: 0 var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); }
.hist-filters { margin-bottom: var(--sp-4); }
.hist-list { max-height: 52vh; overflow-y: auto; display: flex; flex-direction: column; gap: var(--sp-2); padding-right: var(--sp-05); }
.hist-item { display: flex; align-items: center; gap: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--sp-3) var(--sp-4); }
.hist-item:hover { border-color: var(--border-strong); background: var(--card-soft); }
.hist-badge { flex: none; display: inline-flex; align-items: center; font-size: var(--fs-xs); font-weight: 700; padding: var(--sp-0) 9px; border-radius: var(--r-pill); }
.hist-badge.st-pending { color: var(--primary); background: var(--primary-soft); }
.hist-badge.st-confirmed { color: var(--success-deep); background: var(--success-soft); }
.hist-badge.st-archived { color: var(--muted); background: color-mix(in srgb, var(--text) 8%, transparent); }
.hist-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; cursor: pointer; }
.hist-title { font-size: var(--fs-md); font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hist-time { font-size: var(--fs-xs); color: var(--muted); font-variant-numeric: tabular-nums; }
.hist-item-ops { flex: none; display: flex; gap: var(--sp-05); }
.mini { width: 26px; height: 26px; padding: 0; display: grid; place-items: center; border: none; background: transparent; color: var(--muted); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.mini:hover { background: var(--primary-soft); color: var(--primary); }
.mini:active { transform: translateY(1px); }
.mini.danger:hover { background: var(--danger-soft); color: var(--danger-deep); }
.hist-empty { text-align: center; color: var(--muted); font-size: var(--fs-md); padding: 30px 0; border: 1px dashed var(--border-strong); border-radius: var(--r-md); }
.hist-detail { max-height: 60vh; overflow-y: auto; }
.hist-detail-hd { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-3); }
.hist-detail-title { font-size: var(--fs-md); font-weight: 600; color: var(--text); }
.hist-detail-ops { display: flex; gap: var(--sp-3); justify-content: flex-end; margin-top: var(--sp-4); }

/* 周报风格记忆 */
.style-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; padding: var(--sp-2) var(--sp-4); margin-bottom: var(--sp-5); background: var(--card); border: 1px dashed var(--border-strong); border-radius: var(--r-md); }
.style-status { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--muted); }
.style-btns { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.style-panel { display: flex; flex-direction: column; gap: var(--sp-2); margin-bottom: var(--sp-5); }
.style-panel textarea { width: 100%; min-height: 110px; resize: vertical; background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-md); padding: var(--sp-3) var(--sp-4); font-size: var(--fs-md); color: var(--text); line-height: var(--lh-body); font-family: var(--font-mono); box-sizing: border-box; }
.style-panel textarea:focus { outline: none; border-color: var(--primary); }
.style-panel-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
.style-panel-foot .hint { font-size: var(--fs-xs); color: var(--muted); }

/* 心得重写区 */
.heart-row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-3); }
.heart-input { flex: 1; min-width: 220px; background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-4); font-size: var(--fs-md); color: var(--text); }
.heart-input:focus { outline: none; border-color: var(--primary); }
.heart-file { display: none; }
.heart-rounds { display: inline-flex; align-items: center; gap: var(--sp-05); font-size: var(--fs-xs); color: var(--muted); }
.heart-thumb { position: relative; width: 44px; height: 44px; flex: none; }
.heart-thumb img { width: 44px; height: 44px; object-fit: cover; border-radius: var(--r-xs); border: 1px solid var(--border-strong); display: block; }
.heart-thumb-x { position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; border-radius: var(--r-pill); background: var(--danger-deep); color: var(--text-invert); border: none; display: grid; place-items: center; cursor: pointer; padding: 0; }
.heart-thumb-x:hover { background: var(--danger); }

@media (prefers-color-scheme: dark) {
  .day-list { background: var(--card); border-color: var(--border-strong); }
  .hm-card { background: var(--card); border-color: var(--border-strong); }
  .search-mini input { background: var(--card-raised); }
  .day-entry { background: var(--card-raised); }
  .report-body { background: var(--card-inset); }
  .hist-item:hover { background: var(--card-inset); }
  .hist-badge.st-archived { background: var(--well); }
}

@media (max-width: 720px) {
  .hm-grid { width: 100%; }
  .hm-head { align-items: flex-start; }
  .hm-actions { justify-content: flex-start; }
  .month-nav { flex-wrap: wrap; }
}
</style>
