<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import Icon from "./Icon.vue";
import { collectDayLogs, WORK_SOURCES, startOfWeek, fmtDate, weekday, renderMarkdown, relativeTime, buildWorkHoursXlsx, errText } from "./shared.js";
import { aiChat, aiComplete, isAIConfigured } from "./ai.js";
import { askConfirm } from "./confirm.js";
import { buildReportSystem, buildDistillPrompt, splitReportSamples, truncate, buildHeartPrompt, extractReportSection, replaceReportSection, REPORT_SECTIONS, HEART_IMAGE_MAX, TEMPLATE_MAX, STYLE_MAX, REPORT_STATUS, advanceReportStatus, recoverReportStatus, upsertReport, updateReportStatus } from "./weeklyReport.js";
import { cloneJsonData } from "./jsonData.js";
import { newIteration, newRequirement, newSubTask, addIteration, addRequirement, addSubTask, updateSubTask, removeSubTask, findIteration } from "./tasks.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["open-settings"]);

const iterations = ref([]);
const problems = ref([]);
let iterationsSaveQueue = Promise.resolve();
let iterationsStale = false;

// ------- 加载 -------
async function load() {
  try {
    // 迭代结构由 migrate.js 启动时一次性升级，这里直接读本地 JSON
    iterations.value = (await invoke("load_data", { key: "iterations" })) || [];
    problems.value = (await invoke("load_data", { key: "problems" })) || [];
  } catch (e) {
    props.showToast("加载工时失败：" + e);
  }
}
onMounted(async () => {
  await load();
  refreshUserName();
  // 换了设置保存后按新配置刷新（显示名等）
  window.addEventListener("settings-saved", onSettingsSaved);
});
// 配置类弹窗：禁点遮罩关闭，仅 Esc 可关（周报带未保存编辑态，防误触丢失）
function onEsc(e) {
  if (e.key === "Escape" && showReport.value) showReport.value = false;
}
onMounted(() => window.addEventListener("keydown", onEsc));
onUnmounted(() => {
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
function persistIterations(next) {
  if (iterationsStale) {
    return Promise.reject(new Error("迭代数据已更新，请重新进入工时页后再修改"));
  }
  const snapshot = cloneJsonData(next || iterations.value);
  // 串行队列防快速连续编辑丢写（本地写盘很快，队列主要是保证顺序）
  const job = iterationsSaveQueue.then(async () => {
    await invoke("save_data", { key: "iterations", data: snapshot });
    if (next) iterations.value = next;
  });
  iterationsSaveQueue = job.catch(() => {});
  return job.catch((e) => {
    iterationsStale = true;
    props.showToast("保存工时失败：" + errText(e));
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
  if (!name) return props.showToast("子任务名称不能为空");
  const hours = Math.max(0, Number(subEdit.value.hours) || 0);
  const date = subEdit.value.date || fmtDate(new Date());
  cancelEditSub();
  await persistIterations(updateSubTask(iterations.value, x.it.id, r.id, s.id, { name, hours, date }));
  props.showToast("已更新工时条目");
}
// 删除子任务（撤销可恢复）
async function removeSub(x) {
  const { it, r, s } = x;
  const idx = (r.subtasks || []).findIndex((t) => t.id === s.id);
  if (idx < 0) return;
  await persistIterations(removeSubTask(iterations.value, it.id, r.id, s.id));
  props.showToast(`已删除子任务「${s.name}」`, {
    actionLabel: "撤销",
    onAction: async () => {
      await persistIterations(addSubTask(iterations.value, it.id, r.id, s));
      props.showToast("已恢复");
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
const CHART_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const selectedDate = ref(fmtDate(new Date()));
const selectedMonth = ref(selectedDate.value.slice(0, 7));
const monthTotals = computed(() => {
  const totals = {};
  dayLogs.value.forEach((entry) => (totals[entry.date] = (totals[entry.date] || 0) + entry.hours));
  return totals;
});
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
      weekday: CHART_WEEKDAYS[dayOfWeek],
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
  return `${year} 年 ${month} 月`;
});
const isCurrentMonth = computed(() => selectedMonth.value === fmtDate(new Date()).slice(0, 7));
const selectedMonthRange = computed(() => {
  const lastDay = calendarDays.value.at(-1)?.date || `${selectedMonth.value}-01`;
  return [`${selectedMonth.value}-01`, isCurrentMonth.value ? fmtDate(new Date()) : lastDay];
});
const monthPersonalTotal = computed(() => round(monthDays.value.reduce((sum, day) => sum + day.total, 0)));
const monthPersonalOvertime = computed(() => round(monthDays.value.reduce((sum, day) => sum + day.overtime, 0)));
const monthSummary = computed(() => `本月 ${monthPersonalTotal.value}h · 加班 ${monthPersonalOvertime.value}h`);
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
const selectedDateTitle = computed(() => {
  const today = fmtDate(new Date());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const prefix = selectedDate.value === today ? "今天" : selectedDate.value === fmtDate(yesterday) ? "昨天" : weekday(selectedDate.value);
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

function openAddTask() {
  addIterationId.value = iterations.value.length ? iterations.value[0].id : "__new";
  const it = findIteration(iterations.value, addIterationId.value);
  addRequirementId.value = it && it.items?.length ? it.items[0].id : "__new";
  addNewIteration.value = "";
  addNewRequirement.value = "";
  addSubName.value = "";
  addSubHours.value = "";
  addSubDate.value = fmtDate(new Date());
  showAddTask.value = true;
}
function addIterationOptions() {
  return [{ id: "__new", label: "＋ 新建迭代…" }, ...iterations.value.map((it) => ({ id: it.id, label: it.title }))];
}
function addRequirementOptions() {
  const it = findIteration(iterations.value, addIterationId.value);
  const reqs = it ? it.items || [] : [];
  return [{ id: "__new", label: "＋ 新建需求…" }, ...reqs.map((r) => ({ id: r.id, label: r.name }))];
}
function onAddIterationChange() {
  // 换了迭代：需求选择重置为该迭代的第一个需求（或新建）
  const it = findIteration(iterations.value, addIterationId.value);
  addRequirementId.value = it && it.items?.length ? it.items[0].id : "__new";
}
async function saveAddTask() {
  const subName = addSubName.value.trim();
  const hours = Math.max(0, Number(addSubHours.value) || 0);
  if (!subName) return props.showToast("请输入子任务名称");
  if (hours <= 0) return props.showToast("请输入大于 0 的工时");
  if (addIterationId.value === "__new" && !addNewIteration.value.trim()) return props.showToast("请输入新迭代名称");
  if (addRequirementId.value === "__new" && !addNewRequirement.value.trim()) return props.showToast("请输入新需求名称");
  addSaving.value = true;
  try {
    let list = cloneJsonData(iterations.value);
    // 迭代：新建或复用
    let iterationId = addIterationId.value;
    if (iterationId === "__new") {
      const it = newIteration({ title: addNewIteration.value.trim() });
      list = addIteration(list, it);
      iterationId = it.id;
    }
    // 需求：新建或复用
    let requirementId = addRequirementId.value;
    if (requirementId === "__new") {
      const r = newRequirement({ name: addNewRequirement.value.trim() });
      list = addRequirement(list, iterationId, r);
      requirementId = r.id;
    }
    // 子任务（子任务即工时）
    const s = newSubTask({ name: subName, hours, date: addSubDate.value || fmtDate(new Date()) });
    list = addSubTask(list, iterationId, requirementId, s);
    await persistIterations(list);
    props.showToast(`已记录 ${hours}h：${subName}`);
    showAddTask.value = false;
  } catch (e) {
    props.showToast("保存失败：" + errText(e));
  } finally {
    addSaving.value = false;
  }
}

// ------- 复制汇总 -------
async function copySummary() {
  const [from, to] = selectedMonthRange.value;
  const rows = dailyTotals.value.filter((day) => day.date >= from && day.date <= to);
  if (!rows.length) return props.showToast("当前月份没有可复制的工时记录");
  const lines = rows.map((d) => {
    const items = d.entries.map((e) => `  ${e.hours}h ${e.title}${e.note ? "（" + e.note + "）" : ""}`).join("\n");
    return `${d.date}  合计 ${d.total}h\n${items}`;
  });
  const text = lines.join("\n") + `\n\n${selectedMonthLabel.value}合计 ${monthPersonalTotal.value}h`;
  try {
    await navigator.clipboard.writeText(text);
    props.showToast(`已复制 ${selectedMonthLabel.value}工时汇总`);
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}

// ------- 导出工时 Excel（自己的工时，范围跟随当前月份）-------
async function exportHoursXlsx() {
  const [from, to] = selectedMonthRange.value;
  const entries = dayLogs.value.filter((e) => e.date >= from && e.date <= to);
  if (!entries.length) return props.showToast("没有可导出的工时记录");
  const safe = (userName.value || "我").replace(/[\\/:*?"<>|]/g, "_");
  try {
    const path = await saveDialog({
      title: "导出工时 Excel",
      defaultPath: `${safe}_工时_${from}_${to}.xlsx`,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (!path) return;
    const b64 = await buildWorkHoursXlsx({ entries, from, to, userName: userName.value });
    await invoke("export_file_b64", { path, contentB64: b64 });
    props.showToast(`已导出 ${selectedMonthLabel.value}工时 Excel`);
  } catch (e) {
    props.showToast("导出失败：" + e);
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
async function saveTemplate() {
  const t = templateDraft.value.trim();
  if (!t) return;
  reportPrefs.value.template = truncate(t, TEMPLATE_MAX);
  await saveReportPrefs();
  templateDraft.value = "";
  stylePanel.value = "";
  props.showToast("已保存周报模板，下次生成将模仿该风格");
}
// 多份历史周报 → AI 提炼写作风格 → 保存
async function distillStyle() {
  const samples = splitReportSamples(samplesDraft.value);
  if (!samples.length) return props.showToast("请先粘贴历史周报");
  if (samples.length < 2) return props.showToast("请至少粘贴 2 份周报（用 --- 分隔），效果更好");
  if (!(await isAIConfigured())) return props.showToast("请先在右上角设置里配置 AI 模型");
  distilling.value = true;
  try {
    const { system, user } = buildDistillPrompt(samples);
    const style = (await aiComplete(user, { system })) || "";
    reportPrefs.value.style = truncate(style.trim(), STYLE_MAX);
    await saveReportPrefs();
    samplesDraft.value = "";
    stylePanel.value = "";
    props.showToast("已提炼并保存周报风格");
  } catch (e) {
    props.showToast("提炼失败：" + errText(e));
  } finally {
    distilling.value = false;
  }
}
// 清除模板与风格，恢复默认提示词
async function clearReportPrefs() {
  const ok = await askConfirm({
    title: "清除周报风格",
    message: "将删除导入的模板与提炼的风格说明，恢复默认提示词，确定吗？",
  });
  if (!ok) return;
  reportPrefs.value = { template: "", style: "" };
  await saveReportPrefs();
  props.showToast("已清除周报模板与风格");
}

// 周范围：本周（周一至今天）/ 上周（上周一至上周日）
function rangeDates(kind) {
  const mon = startOfWeek();
  if (kind === "last") {
    const from = new Date(mon);
    from.setDate(mon.getDate() - 7);
    const to = new Date(mon);
    to.setDate(mon.getDate() - 1);
    return { from: fmtDate(from), to: fmtDate(to), label: "上周" };
  }
  return { from: fmtDate(mon), to: fmtDate(new Date()), label: "本周" };
}

// 把范围内的工时/迭代/问题/未完成需求整理成给 AI 的素材文本
function buildReportMaterial(range) {
  const inRange = (d) => d && d >= range.from && d <= range.to;
  const lines = [`【统计区间】${range.from} 至 ${range.to}（${range.label}）`];

  const logs = dayLogs.value.filter((e) => inRange(e.date));
  const total = round(logs.reduce((s, e) => s + e.hours, 0));
  if (logs.length) {
    lines.push(`\n【工时明细】合计 ${total}h`);
    const byDay = {};
    logs.forEach((e) => (byDay[e.date] = byDay[e.date] || []).push(e));
    Object.keys(byDay)
      .sort()
      .forEach((d) => {
        lines.push(`${d}（${weekday(d)}）`);
        byDay[d].forEach((e) => lines.push(`  - ${e.hours}h ${e.title}${e.note ? "（" + e.note + "）" : ""}`));
      });
  } else {
    lines.push("\n【工时明细】区间内没有工时记录");
  }

  const rel = iterations.value.filter((it) => inRange(it.releaseDate));
  if (rel.length) {
    lines.push("\n【区间内计划上线的迭代】");
    rel.forEach((it) => lines.push(`- ${it.version ? it.version + " " : ""}${it.title}（${it.releaseDate}，${it.status === "live" ? "已上线" : "未上线"}）`));
  }

  const undone = [];
  iterations.value.forEach((it) => {
    if (it.status === "live") return;
    (it.items || []).forEach((r) => {
      if (!r.done) undone.push(`- ${it.title} / ${r.name}`);
    });
  });
  if (undone.length) {
    lines.push("\n【进行中/未完成的需求（下周计划素材）】");
    lines.push(...undone.slice(0, 20));
  }
  return { text: lines.join("\n"), hasLogs: logs.length > 0 };
}

async function openReport() {
  if (!(await isAIConfigured())) return props.showToast("请先在右上角设置里配置 AI 模型");
  await loadReportPrefs();
  showReport.value = true;
  editingReport.value = false;
  clearHeartHistory(); // 重新打开弹窗：心得对话从新的一轮开始
  // 不自动生成：恢复该周已保存的草稿（没有则留空，由用户点「重新生成」）
  reportText.value = await loadSavedReport(reportRange.value);
}

async function generateReport() {
  const range = rangeDates(reportRange.value);
  const mat = buildReportMaterial(range);
  if (!mat.hasLogs) return props.showToast(`${range.label}没有工时记录，暂无可写的内容`);
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
    props.showToast("生成失败：" + errText(e));
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
    props.showToast("已复制周报（Markdown）");
  } catch (e) {
    props.showToast("复制失败：" + errText(e));
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
  if (!files.length) return props.showToast("请选择图片文件");
  const remain = HEART_IMAGE_MAX - heartImages.value.length;
  if (remain <= 0) return props.showToast(`最多附带 ${HEART_IMAGE_MAX} 张图片，请先移除部分再添加`);
  const pick = files.slice(0, remain);
  if (pick.length < files.length) props.showToast(`最多附带 ${HEART_IMAGE_MAX} 张图片，已截取前 ${pick.length} 张`);
  try {
    const urls = await Promise.all(
      pick.map(
        (f) =>
          new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error("读取图片失败"));
            r.readAsDataURL(f);
          })
      )
    );
    heartImages.value.push(...urls);
  } catch (err) {
    props.showToast("读取图片失败：" + errText(err));
  }
  e.target.value = ""; // 允许重复选同一文件
}
function removeHeartImage(i) {
  heartImages.value.splice(i, 1);
}

async function rewriteHeart() {
  const current = reportText.value;
  if (!extractReportSection(current, HEART_SECTION)) {
    return props.showToast("当前周报没有独立的心得小节，无法单独重写，请点「重新生成」");
  }
  if (!(await isAIConfigured())) return props.showToast("请先在右上角设置里配置 AI 模型");
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
    if (!clean) return props.showToast("AI 返回内容为空，请重试");
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
    props.showToast(heartHistory.value.length > 2 ? "已按第 " + heartRounds.value + " 轮要求重写本周心得" : "已按新方向重写本周心得");
  } catch (e) {
    props.showToast("重写失败：" + errText(e));
  } finally {
    heartLoading.value = false;
  }
}

// ------- 周报历史管理（独立 key reports.json，状态：新建 → 确认 → 归档）-------
const reports = ref([]);
const showHistory = ref(false);
const historyFilter = ref("all"); // all | pending | confirmed | archived
const historyDetail = ref(null); // 正在查看详情的周报
const HISTORY_FILTERS = [
  { key: "all", label: "全部" },
  { key: "pending", label: "新建" },
  { key: "confirmed", label: "确认" },
  { key: "archived", label: "归档" },
];

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
    const range = rangeDates(kind);
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
  const range = rangeDates(reportRange.value);
  const { list, created } = upsertReport(reports.value, {
    range: reportRange.value,
    rangeLabel: range.label,
    text: reportText.value,
  });
  reports.value = list;
  await persistReports();
  props.showToast(created ? "已保存周报（状态：新建）" : "已更新周报草稿");
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
  props.showToast(`已${REPORT_STATUS[next]}`);
}
async function historyRecover(r) {
  reports.value = updateReportStatus(reports.value, r.id, recoverReportStatus(r.status));
  await persistReports();
  props.showToast("已恢复为「确认」");
}
async function historyRemove(r) {
  const ok = await askConfirm({
    title: "删除周报",
    message: `确定删除这条${r.rangeLabel}周报吗？删除后不可恢复。`,
  });
  if (!ok) return;
  reports.value = reports.value.filter((x) => x.id !== r.id);
  await persistReports();
  if (historyDetail.value && historyDetail.value.id === r.id) historyDetail.value = null;
  props.showToast("已删除该周报");
}
function historyCopy(r) {
  navigator.clipboard.writeText(r.text);
  props.showToast("已复制 Markdown");
}
// 历史详情手动微调：编辑 Markdown 原文，保存后刷新更新时间
const historyEdit = ref(false);
async function historyEditSave() {
  if (!historyDetail.value) return;
  historyDetail.value.updatedAt = new Date().toISOString();
  await persistReports();
  historyEdit.value = false;
  props.showToast("已保存修改");
}
</script>

<template>
  <main class="content">
    <div class="hm-card">
      <div class="hm-head">
        <div class="hm-heading">
          <h4 class="hm-title"><Icon name="calendar" :size="15" /> 月度工时趋势</h4>
          <p><span>我的工时</span>{{ monthSummary }}</p>
        </div>
        <div class="hm-actions">
          <button class="btn-primary sm" @click="openAddTask"><Icon name="plus" :size="13" /> 添加工时</button>
          <button class="btn-ghost sm" @click="openReport"><Icon name="sparkles" :size="13" /> 生成周报</button>
          <button class="btn-ghost sm" @click="exportHoursXlsx"><Icon name="download" :size="13" /> 导出</button>
          <button class="btn-ghost sm" @click="copySummary"><Icon name="copy" :size="13" /> 复制汇总</button>
        </div>
      </div>

      <div class="chart-toolbar">
          <div class="month-nav">
            <button class="icon-btn sm" title="上个月" @click="moveMonth(-1)"><Icon name="chevron-right" :size="14" /></button>
            <label class="month-picker">
              <span>{{ selectedMonthLabel }}</span>
              <input :value="selectedMonth" type="month" :max="fmtDate(new Date()).slice(0, 7)" aria-label="选择月份" @change="selectMonth($event.target.value)" />
            </label>
            <button class="icon-btn sm next" title="下个月" :disabled="isCurrentMonth" @click="moveMonth(1)"><Icon name="chevron-right" :size="14" /></button>
            <button v-if="!isCurrentMonth" class="btn-ghost sm" @click="goCurrentMonth">本月</button>
          </div>
          <span class="chart-context">每日登记工时</span>
        </div>
        <div class="hm-grid">
          <div class="hours-chart" :style="{ '--chart-max': chartMax }">
            <div class="chart-y-axis">
              <span v-for="tick in chartTicks" :key="tick" :style="{ bottom: (tick / chartMax * 100) + '%' }">{{ tick }}h</span>
            </div>
            <div class="chart-plot">
              <i v-for="tick in chartTicks" :key="tick" class="chart-line" :class="{ standard: tick === STANDARD_HOURS }" :style="{ bottom: `calc(38px + (100% - 38px) * ${tick / chartMax})` }">
                <em v-if="tick === STANDARD_HOURS">标准 8h</em>
              </i>
              <div class="chart-columns" :style="{ '--month-days': chartDays.length }">
                <button
                  v-for="day in chartDays"
                  :key="day.date"
                  class="chart-day"
                  :class="{ selected: day.date === selectedDate, today: day.isToday, future: day.isFuture, weekend: day.isWeekend, 'week-start': day.isWeekStart, overtime: day.overtime > 0 }"
                  :disabled="day.isFuture"
                  :title="day.date + '：' + day.total + 'h' + (day.overtime ? '（加班 ' + day.overtime + 'h）' : '')"
                  @click="selectedDate = day.date"
                >
                  <span class="chart-bar" :style="{ height: (day.total / chartMax * 100) + '%' }">
                    <span v-if="day.total" class="chart-value">{{ chartHours(day.total) }}</span>
                    <i v-if="day.overtime" class="overtime" :style="{ height: (day.overtime / day.total * 100) + '%' }"></i>
                    <i class="regular" :style="{ height: (day.total ? day.regular / day.total * 100 : 0) + '%' }"></i>
                  </span>
                  <span class="chart-label"><b>{{ day.day }}</b><small>周{{ day.weekday }}</small></span>
                </button>
              </div>
            </div>
          </div>
          <div class="chart-legend">
            <span><i class="regular"></i>每日工时</span>
            <span><i class="overtime"></i>超过 8h</span>
            <span class="legend-note">点击日期查看迭代需求</span>
          </div>
        </div>
    </div>

    <div class="day-list">
      <div class="day-head">
        <h4><Icon name="repeat" :size="15" /> {{ selectedDateTitle }}的迭代需求</h4>
      </div>
      <div class="day-legend">
        <span><i class="dot it"></i> 迭代需求 {{ round(selectedIterationEntries.reduce((sum, entry) => sum + entry.hours, 0)) }}h</span>
        <span v-if="selectedProblemEntries.length"><i class="dot pr"></i> 问题 {{ round(selectedProblemEntries.reduce((sum, entry) => sum + entry.hours, 0)) }}h</span>
      </div>
      <div v-if="selectedIterationEntries.length" class="day-item">
        <div class="day-entries">
          <template v-for="(e, i) in selectedIterationEntries" :key="i">
            <div v-if="subEdit.id !== e.s.id" class="day-entry-wrap">
              <span class="day-entry" :style="{ borderColor: WORK_SOURCES_MAP.iteration.color }">
                <em :style="{ color: WORK_SOURCES_MAP.iteration.color }">{{ e.hours }}h</em> {{ e.title }}<span v-if="e.note" class="de-note">（{{ e.note }}）</span>
              </span>
              <button class="icon-btn xs" title="编辑名称/工时/归属日" @click="startEditSub(e.s)"><Icon name="edit" :size="13" /></button>
              <button class="icon-btn xs" title="删除" @click="removeSub({ it: e.it, r: e.r, s: e.s })"><Icon name="x" :size="13" /></button>
            </div>
            <div v-else class="day-entry-wrap">
              <span class="day-entry editing" :style="{ borderColor: WORK_SOURCES_MAP.iteration.color }">
                <input v-model="subEdit.hours" type="number" class="de-edit-hours" min="0" step="0.5" title="总工时" @keyup.enter="saveEditSub({ it: e.it, r: e.r, s: e.s })" @keyup.esc="cancelEditSub" /><i class="de-h">h</i>
                <span class="de-iter">{{ e.it.title }} · </span><input v-model="subEdit.name" class="de-edit-name" placeholder="子任务名称" @keyup.enter="saveEditSub({ it: e.it, r: e.r, s: e.s })" @keyup.esc="cancelEditSub" />
                <span v-if="e.note" class="de-note">（{{ e.note }}）</span>
              </span>
              <input v-model="subEdit.date" type="date" class="de-edit-date" title="工时归属日" @keyup.enter="saveEditSub({ it: e.it, r: e.r, s: e.s })" @keyup.esc="cancelEditSub" />
              <button class="btn-ghost xs" @click="saveEditSub({ it: e.it, r: e.r, s: e.s })"><Icon name="check" :size="11" /> 保存</button>
              <button class="btn-ghost xs" @click="cancelEditSub">取消</button>
            </div>
          </template>
        </div>
      </div>
      <div v-else class="selected-empty">
        <Icon name="repeat" :size="26" />
        <h4>当天没有工时记录</h4>
        <p>点右上角「添加工时」登记子任务工时，或到问题页给问题补充工时。</p>
      </div>
      <div v-if="selectedProblemEntries.length" class="problem-supplement">
        <h5><Icon name="alert" :size="13" /> 同日问题工时</h5>
        <div class="day-entries">
          <span v-for="(entry, index) in selectedProblemEntries" :key="index" class="day-entry" :style="{ borderColor: WORK_SOURCES_MAP.problem.color }">
            <em :style="{ color: WORK_SOURCES_MAP.problem.color }">{{ entry.hours }}h</em> {{ entry.title }}<span v-if="entry.note" class="de-note">（{{ entry.note }}）</span>
          </span>
        </div>
      </div>
    </div>

  </main>

  <!-- 添加工时弹窗（本地快速录入：迭代/需求/子任务） -->
  <div v-if="showAddTask" class="modal-mask">
    <div class="modal add-task-modal">
      <h2><Icon name="plus" :size="18" /> 添加工时</h2>
      <div class="add-form">
        <label class="add-field">
          <span>迭代</span>
          <div class="add-select-row">
            <select v-model="addIterationId" class="add-select" @change="onAddIterationChange">
              <option v-for="opt in addIterationOptions()" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
            </select>
            <input v-if="addIterationId === '__new'" v-model="addNewIteration" class="add-input" placeholder="新迭代名称，如：9月迭代" />
          </div>
        </label>
        <label class="add-field">
          <span>需求</span>
          <div class="add-select-row">
            <select v-model="addRequirementId" class="add-select">
              <option v-for="opt in addRequirementOptions()" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
            </select>
            <input v-if="addRequirementId === '__new'" v-model="addNewRequirement" class="add-input" placeholder="新需求名称" />
          </div>
        </label>
        <label class="add-field">
          <span>子任务名称</span>
          <input v-model="addSubName" class="add-input" placeholder="如：xx 功能开发" @keyup.enter="saveAddTask" />
        </label>
        <div class="add-row">
          <label class="add-field add-hours">
            <span>工时（小时）</span>
            <input v-model="addSubHours" type="number" class="add-input" min="0" step="0.5" placeholder="0" @keyup.enter="saveAddTask" />
          </label>
          <label class="add-field">
            <span>归属日期</span>
            <input v-model="addSubDate" type="date" class="add-input" :max="fmtDate(new Date())" />
          </label>
        </div>
        <p class="add-tip">子任务即工时：登记后将计入「我的工时」月视图与周报素材。</p>
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" @click="showAddTask = false">取消</button>
        <button class="btn-primary" :disabled="addSaving" @click="saveAddTask"><Icon name="check" :size="14" /> {{ addSaving ? "保存中…" : "保存" }}</button>
      </div>
    </div>
  </div>

  <!-- AI 周报弹窗 -->
  <div v-if="showReport" class="modal-mask">
    <div class="modal report-modal">
      <h2><Icon name="sparkles" :size="18" /> AI 周报草稿</h2>
      <div class="report-ops">
        <div class="filters">
          <button class="chip" :class="{ active: reportRange === 'this' }" :disabled="generating" @click="switchRange('this')">本周</button>
          <button class="chip" :class="{ active: reportRange === 'last' }" :disabled="generating" @click="switchRange('last')">上周</button>
        </div>
        <div class="report-btns">
          <button class="btn-ghost sm" :disabled="generating" @click="generateReport"><Icon name="repeat" :size="14" /> 重新生成</button>
          <button class="btn-ghost sm" :disabled="!reportText || generating" @click="editingReport = !editingReport"><Icon name="edit" :size="14" /> {{ editingReport ? "完成微调" : "手动微调" }}</button>
          <button class="btn-ghost sm" :disabled="!reportText || generating" @click="copyReport"><Icon name="copy" :size="14" /> 复制 Markdown</button>
        </div>
      </div>
      <!-- 周报风格记忆：模板导入 / AI 提炼风格 -->
      <div class="style-bar">
        <span class="style-status">
          <Icon name="note" :size="13" />
          <template v-if="reportPrefs.template && reportPrefs.style">已导入模板 · 已提炼风格</template>
          <template v-else-if="reportPrefs.template">已导入模板</template>
          <template v-else-if="reportPrefs.style">已提炼风格</template>
          <template v-else>默认提示词</template>
        </span>
        <div class="style-btns">
          <button class="btn-ghost sm" @click="stylePanel = stylePanel === 'template' ? '' : 'template'"><Icon name="note" :size="13" /> 导入模板</button>
          <button class="btn-ghost sm" @click="stylePanel = stylePanel === 'distill' ? '' : 'distill'"><Icon name="sparkles" :size="13" /> AI 提炼风格</button>
          <button v-if="hasReportPrefs" class="btn-ghost sm" @click="clearReportPrefs"><Icon name="trash" :size="13" /> 清除</button>
        </div>
      </div>
      <div v-if="stylePanel === 'template'" class="style-panel">
        <textarea v-model="templateDraft" placeholder="粘贴一份你写过且满意的周报（Markdown / 纯文本均可），之后 AI 生成时会模仿它的结构与措辞。"></textarea>
        <div class="style-panel-foot">
          <span class="hint">最多保存 4000 字，超长自动截断；保存后点「重新生成」即可看到效果。</span>
          <button class="btn-ghost sm" :disabled="!templateDraft.trim()" @click="saveTemplate">保存模板</button>
        </div>
      </div>
      <div v-else-if="stylePanel === 'distill'" class="style-panel">
        <textarea v-model="samplesDraft" placeholder="粘贴多份历史周报，每份之间用 --- 分隔（至少 2 份效果更好）。AI 会提炼出你的写作风格并保存，之后生成都遵循该风格。"></textarea>
        <div class="style-panel-foot">
          <span class="hint">最多取 6 份，每份 2000 字以内；提炼结果可随时「清除」。</span>
          <button class="btn-ghost sm" :disabled="!samplesDraft.trim() || distilling" @click="distillStyle">
            <Icon name="sparkles" :size="13" /> {{ distilling ? "提炼中…" : "提炼并保存" }}
          </button>
        </div>
      </div>
      <div v-if="generating" class="report-loading"><Icon name="sparkles" :size="14" /> AI 正在根据工时与迭代数据撰写周报...</div>
      <textarea v-else-if="editingReport" v-model="reportText" class="report-edit" spellcheck="false" placeholder="直接修改 Markdown 原文，编辑过程中会自动保存草稿"></textarea>
      <div v-else-if="reportText" class="report-body md" v-html="reportHtml"></div>
      <div v-else class="report-loading">点“重新生成”开始撰写</div>
      <!-- 本周心得：可指定主题方向单独重写 -->
      <div v-if="canRewriteHeart" class="heart-row">
        <button class="btn-ghost sm" @click="heartOpen = !heartOpen">
          <Icon name="sparkles" :size="13" /> {{ heartOpen ? "收起" : "重写本周心得" }}
        </button>
        <template v-if="heartOpen">
          <input v-model="heartTopic" class="heart-input" placeholder="主题方向（可留空自由发挥），如：团队协作 / 成长收获 / 时间管理" @keydown.enter="rewriteHeart" />
          <button class="btn-ghost sm" @click="heartImageInput && heartImageInput.click()">
            <Icon name="image" :size="13" /> 图片{{ heartImages.length ? " (" + heartImages.length + ")" : "" }}
          </button>
          <input ref="heartImageInput" type="file" accept="image/*" multiple class="heart-file" @change="addHeartImages" />
          <span v-for="(img, i) in heartImages" :key="i" class="heart-thumb">
            <img :src="img" alt="" />
            <button type="button" class="heart-thumb-x" title="移除该图" @click="removeHeartImage(i)"><Icon name="x" :size="10" /></button>
          </span>
          <button class="btn-ghost sm" :disabled="heartLoading" @click="rewriteHeart">
            <Icon name="sparkles" :size="13" /> {{ heartLoading ? "重写中…" : "按此方向重写" }}
          </button>
          <span v-if="heartRounds > 1" class="heart-rounds"><Icon name="chat" :size="12" /> 已对话 {{ heartRounds - 1 }} 轮</span>
          <button v-if="heartRounds > 1" class="btn-ghost sm" title="清空对话历史，从新的一轮开始" @click="clearHeartHistory">
            <Icon name="trash" :size="13" /> 清空对话
          </button>
        </template>
      </div>
      <p class="report-tip">内容由 AI 根据工时、迭代与问题记录生成，发送前请核对。</p>
      <div class="modal-foot">
        <button class="btn-ghost" @click="openHistory"><Icon name="folder" :size="14" /> 周报历史</button>
        <button class="btn-ghost" :disabled="!reportText || generating" @click="saveReport"><Icon name="check" :size="14" /> 保存周报</button>
        <button class="btn-ghost" @click="showReport = false">关闭</button>
      </div>
    </div>
  </div>

  <!-- 周报历史管理弹窗（列表/详情，状态：新建 → 确认 → 归档） -->
  <div v-if="showHistory" class="modal-mask hist-mask" @click.self="showHistory = false">
    <div class="modal hist-modal">
      <h2><Icon name="folder" :size="18" /> 周报历史 <em class="hist-count">{{ reports.length }}</em></h2>

      <div class="filters hist-filters">
        <button v-for="f in HISTORY_FILTERS" :key="f.key" class="chip" :class="{ active: historyFilter === f.key }" @click="historyFilter = f.key">{{ f.label }}</button>
      </div>

      <!-- 详情视图 -->
      <div v-if="historyDetail" class="hist-detail">
        <div class="hist-detail-hd">
          <span class="hist-badge" :class="'st-' + historyDetail.status">{{ REPORT_STATUS[historyDetail.status] }}</span>
          <span class="hist-detail-title">{{ historyDetail.rangeLabel }} · 更新于 {{ relTime(historyDetail.updatedAt) }}</span>
        </div>
        <textarea v-if="historyEdit" v-model="historyDetail.text" class="hist-edit" spellcheck="false"></textarea>
        <div v-else class="report-body md" v-html="renderMarkdown(historyDetail.text)"></div>
        <div class="hist-detail-ops">
          <button v-if="!historyEdit" class="btn-ghost sm" @click="historyEdit = true"><Icon name="edit" :size="13" /> 手动微调</button>
          <button v-else class="btn-ghost sm" @click="historyEditSave"><Icon name="check" :size="13" /> 保存修改</button>
          <button class="btn-ghost sm" @click="historyCopy(historyDetail)"><Icon name="copy" :size="13" /> 复制 Markdown</button>
          <button class="btn-ghost sm" @click="historyDetail = null; historyEdit = false">返回列表</button>
        </div>
      </div>

      <!-- 列表视图 -->
      <div v-else class="hist-list">
        <div v-if="!filteredReports.length" class="hist-empty">
          暂无{{ historyFilter === "all" ? "" : "「" + (REPORT_STATUS[historyFilter] || "") + "」的" }}周报
        </div>
        <div v-for="r in filteredReports" :key="r.id" class="hist-item">
          <span class="hist-badge" :class="'st-' + r.status">{{ REPORT_STATUS[r.status] }}</span>
          <div class="hist-item-main" @click="historyDetail = r">
            <span class="hist-title" :title="r.rangeLabel + ' · ' + reportSummary(r.text)">{{ r.rangeLabel }} · {{ reportSummary(r.text) }}</span>
            <span class="hist-time">{{ relTime(r.updatedAt) }} · {{ r.text.length }} 字</span>
          </div>
          <div class="hist-item-ops">
            <button class="mini" title="查看" @click="historyDetail = r"><Icon name="eye" :size="13" /></button>
            <button v-if="r.status === 'pending'" class="mini" title="确认（已提交）" @click="historyAdvance(r)"><Icon name="check" :size="13" /></button>
            <button v-else-if="r.status === 'confirmed'" class="mini" title="归档" @click="historyAdvance(r)"><Icon name="folder" :size="13" /></button>
            <button v-else class="mini" title="恢复为确认" @click="historyRecover(r)"><Icon name="repeat" :size="13" /></button>
            <button class="mini danger" title="删除" @click="historyRemove(r)"><Icon name="trash" :size="13" /></button>
          </div>
        </div>
      </div>

      <div class="modal-foot"><button class="btn-ghost" @click="showHistory = false">关闭</button></div>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 6px; background: var(--card); border: 1px solid var(--border-strong); padding: 8px 13px; border-radius: var(--r-sm); font-size: var(--fs-md); font-weight: 600; cursor: pointer; color: var(--text-soft); transition: all 0.15s; }
.chip:hover { border-color: var(--border-steel); }
.chip.active { background: var(--accent-hover); color: var(--text-invert); border-color: var(--accent-hover); }

.content { flex: 1; padding: 16px 28px 36px; display: flex; flex-direction: column; gap: 16px; }

/* 未提交工时：编辑态（本地子任务就地修改名称/工时/归属日） */
.day-entry-wrap { display: inline-flex; align-items: center; gap: 4px; }
.day-entry.editing { border-style: dashed; background: var(--warn-soft); }
/* 编辑态：chip 外观不变，仅工时数字与名称就地变为下划线输入框；日期框跟在条目后 */
.de-edit-hours, .de-edit-name { border: none; border-bottom: 1px solid var(--primary); border-radius: 0; background: transparent; outline: none; padding: 0 1px; font-size: var(--fs-xs); font-family: inherit; color: var(--text); }
.de-edit-hours { width: 40px; text-align: right; font-weight: 700; color: var(--accent-hover); }
.de-edit-name { width: 150px; }
.de-edit-hours:focus, .de-edit-name:focus { border-bottom-color: var(--primary-hover); }
.de-h { font-style: normal; font-weight: 700; color: var(--accent-hover); margin-right: 4px; }
.de-iter { color: var(--text-soft); }
.de-edit-date { padding: 3px 6px; border: 1px solid var(--border-strong); border-radius: var(--r-xs); font-size: var(--fs-xs); outline: none; background: var(--card); color: var(--text-soft); font-family: inherit; width: 116px; }
.de-edit-date:focus { border-color: var(--primary); color: var(--text); }

/* 月度工时图 */
.add-task-modal { width: 480px; }
.add-form { display: flex; flex-direction: column; gap: 12px; }
.add-field { display: flex; flex-direction: column; gap: 5px; font-size: var(--fs-sm); color: var(--text-soft); }
.add-field > span { font-weight: 600; }
.add-select-row { display: flex; gap: 8px; align-items: center; }
.add-select, .add-input { flex: 1; min-width: 0; background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 8px 10px; font-size: var(--fs-md); color: var(--text); font-family: inherit; }
.add-select:focus, .add-input:focus { outline: none; border-color: var(--primary); }
.add-row { display: flex; gap: 12px; }
.add-row .add-field { flex: 1; }
.add-tip { margin: 0; font-size: var(--fs-xs); color: var(--muted); }

/* 月度工时图 */
.hm-card { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 18px 20px 16px; box-shadow: var(--shadow); }
.hm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 14px; flex-wrap: wrap; }
.hm-heading { min-width: 180px; }
.hm-title { margin: 0; font-size: var(--fs-md); font-weight: 700; display: inline-flex; align-items: center; gap: 6px; }
.hm-heading p { margin: 5px 0 0; color: var(--muted); font-size: var(--fs-sm); }
.hm-heading p span { margin-right: 8px; color: var(--text); font-weight: 600; }
.hm-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.chart-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0 8px; border-top: 1px solid var(--border); }
.chart-context { color: var(--muted); font-size: var(--fs-xs); }
.month-nav { display: flex; align-items: center; gap: 6px; }
.month-nav .icon-btn.sm { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; }
.month-nav .icon-btn:first-child svg { transform: rotate(180deg); }
.month-nav .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.month-picker { position: relative; display: grid; place-items: center; min-width: 112px; height: 30px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card); color: var(--text); font-family: var(--font-num); font-size: var(--fs-sm); font-weight: 700; cursor: pointer; }
.month-picker input { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
.hm-grid { width: 100%; overflow-x: auto; }
.hours-chart { display: grid; grid-template-columns: 42px minmax(920px, 1fr); min-width: 962px; padding: 16px 0 2px; }
.chart-y-axis { position: relative; height: 232px; }
.chart-y-axis span { position: absolute; right: 8px; transform: translateY(50%); color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.chart-plot { position: relative; height: 270px; padding-bottom: 38px; }
.chart-line { position: absolute; left: 0; right: 0; height: 1px; background: var(--border); pointer-events: none; }
.chart-line.standard { z-index: 2; height: 0; border-top: 1px dashed var(--warn); background: none; }
.chart-line em { position: absolute; right: 4px; bottom: 3px; color: var(--warn-deep); font-size: var(--fs-xs); font-style: normal; font-weight: 700; }
.chart-columns { position: absolute; inset: 0 0 38px; display: grid; grid-template-columns: repeat(var(--month-days), minmax(22px, 1fr)); align-items: end; gap: 2px; }
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
.chart-label small { position: relative; display: inline-flex; align-items: center; gap: 2px; font-size: var(--fs-xs); line-height: 1; white-space: nowrap; }
.chart-legend { display: flex; align-items: center; justify-content: flex-end; gap: 16px; margin-top: 7px; color: var(--muted); font-size: var(--fs-xs); }
.chart-legend span { display: inline-flex; align-items: center; gap: 5px; }
.chart-legend i { width: 10px; height: 10px; border-radius: var(--r-xs); }
.chart-legend .regular { background: var(--primary); }
.chart-legend .overtime { background: var(--amber); }
.chart-legend .legend-note { margin-left: auto; }
.day-list { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 16px 18px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 14px; }
.day-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.day-head h4 { margin: 0; display: flex; align-items: center; gap: 6px; font-size: var(--fs-md); font-weight: 700; }
.day-legend { display: flex; align-items: center; gap: 16px; font-size: var(--fs-sm); color: var(--muted); padding-bottom: 12px; border-bottom: 1px dashed var(--border); flex-wrap: wrap; }
.day-legend span { display: inline-flex; align-items: center; gap: 5px; }
.day-legend .dot { width: 10px; height: 10px; border-radius: var(--r-xs); display: inline-block; }
.day-legend .dot.it { background: var(--accent); }
.day-legend .dot.pr { background: var(--danger); }
.day-item { display: flex; flex-direction: column; gap: 6px; }
.day-entries { display: flex; flex-wrap: wrap; gap: 6px; }
.day-entry { font-size: var(--fs-xs); color: var(--text-soft); background: var(--card); border: 1px solid var(--border-strong); border-left-width: 3px; border-radius: var(--r-xs); padding: 3px 8px; }
.day-entry em { font-style: normal; font-weight: 700; margin-right: 4px; }
.de-note { color: var(--muted); }
.selected-empty { display: flex; flex-direction: column; align-items: center; padding: 22px 16px; color: var(--muted); text-align: center; }
.selected-empty > svg { color: var(--faint); }
.selected-empty h4 { margin: 8px 0 4px; color: var(--text-soft); font-size: var(--fs-md); }
.selected-empty p { margin: 0; font-size: var(--fs-sm); }
.problem-supplement { padding-top: 12px; border-top: 1px dashed var(--border); }
.problem-supplement h5 { margin: 0 0 9px; display: flex; align-items: center; gap: 5px; color: var(--text-soft); font-size: var(--fs-sm); }

/* 空状态 */
.empty { text-align: center; padding: 56px 20px; }
.empty-ico { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 50%; background: var(--primary-soft); color: var(--primary); margin-bottom: 6px; }
.empty h2 { font-size: var(--fs-xl); margin: 8px 0 6px; font-weight: 700; }
.empty p { color: var(--muted); font-size: var(--fs-base); margin: 0 0 22px; max-width: 460px; margin-left: auto; margin-right: auto; }

/* AI 周报弹窗 */
.report-modal { width: 680px; }
.report-ops { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.report-btns { display: flex; gap: 8px; }
.report-loading { display: flex; align-items: center; gap: 7px; padding: 26px 4px; color: var(--muted); font-size: var(--fs-md); justify-content: center; }
.report-tip { font-size: var(--fs-xs); color: var(--muted); margin: 12px 0 0; }
.report-body { border: 1px solid var(--card-border); border-radius: var(--r-md); padding: 4px 18px; background: var(--bg); font-size: var(--fs-md); line-height: var(--lh-body); max-height: 52vh; overflow-y: auto; }
.report-body :deep(h2), .report-body :deep(h3), .report-body :deep(h4) { font-size: var(--fs-base); margin: 14px 0 6px; }
.report-body :deep(p) { margin: 8px 0; }
.report-body :deep(ul), .report-body :deep(ol) { margin: 6px 0; padding-left: 22px; }
.report-body :deep(li) { margin: 3px 0; }
.report-body :deep(code) { background: var(--well); border-radius: var(--r-xs); padding: 1px 5px; font-size: var(--fs-sm); font-family: var(--font-mono); }
.report-body :deep(hr) { border: none; border-top: 1px dashed var(--border-strong); margin: 12px 0; }

/* 手动微调：Markdown 原文编辑框 */
.report-edit, .hist-edit { width: 100%; min-height: 320px; max-height: 52vh; box-sizing: border-box; background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-md); padding: 12px 16px; font-size: var(--fs-md); line-height: var(--lh-body); color: var(--text); resize: vertical; font-family: inherit; }
.report-edit:focus, .hist-edit:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.hist-edit { min-height: 200px; }

/* 周报历史管理弹窗 */
.hist-mask { z-index: 260; }
.hist-modal { width: 680px; }
.hist-modal h2 { display: flex; align-items: center; gap: 8px; }
.hist-count { font-style: normal; font-weight: 700; color: var(--accent-hover); background: var(--accent-soft); padding: 0 8px; border-radius: var(--r-pill); font-size: var(--fs-xs); }
.hist-filters { margin-bottom: 12px; }
.hist-list { max-height: 52vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
.hist-item { display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); border-radius: var(--r-md); padding: 10px 12px; }
.hist-item:hover { border-color: var(--border-strong); background: var(--card-soft); }
.hist-badge { flex: none; display: inline-flex; align-items: center; font-size: var(--fs-xs); font-weight: 700; padding: 2px 9px; border-radius: var(--r-pill); }
.hist-badge.st-pending { color: var(--primary); background: var(--primary-soft); }
.hist-badge.st-confirmed { color: var(--success-deep); background: var(--success-soft); }
.hist-badge.st-archived { color: var(--muted); background: color-mix(in srgb, var(--text) 8%, transparent); }
.hist-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; cursor: pointer; }
.hist-title { font-size: var(--fs-md); font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hist-time { font-size: var(--fs-xs); color: var(--muted); font-variant-numeric: tabular-nums; }
.hist-item-ops { flex: none; display: flex; gap: 4px; }
.mini { width: 26px; height: 26px; padding: 0; display: grid; place-items: center; border: none; background: transparent; color: var(--muted); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.mini:hover { background: var(--primary-soft); color: var(--primary); }
.mini:active { transform: translateY(1px); }
.mini.danger:hover { background: var(--danger-soft); color: var(--danger-deep); }
.hist-empty { text-align: center; color: var(--muted); font-size: var(--fs-md); padding: 30px 0; border: 1px dashed var(--border-strong); border-radius: var(--r-md); }
.hist-detail { max-height: 60vh; overflow-y: auto; }
.hist-detail-hd { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.hist-detail-title { font-size: var(--fs-md); font-weight: 600; color: var(--text); }
.hist-detail-ops { display: flex; gap: 10px; justify-content: flex-end; margin-top: 12px; }

/* 周报风格记忆 */
.style-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 8px 12px; margin-bottom: 14px; background: var(--card); border: 1px dashed var(--border-strong); border-radius: var(--r-md); }
.style-status { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--muted); }
.style-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.style-panel { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.style-panel textarea { width: 100%; min-height: 110px; resize: vertical; background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-md); padding: 10px 12px; font-size: var(--fs-md); color: var(--text); line-height: var(--lh-body); font-family: var(--font-mono); box-sizing: border-box; }
.style-panel textarea:focus { outline: none; border-color: var(--primary); }
.style-panel-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.style-panel-foot .hint { font-size: var(--fs-xs); color: var(--muted); }

/* 心得重写区 */
.heart-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.heart-input { flex: 1; min-width: 220px; background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 8px 12px; font-size: var(--fs-md); color: var(--text); }
.heart-input:focus { outline: none; border-color: var(--primary); }
.heart-file { display: none; }
.heart-rounds { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--muted); }
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
