<script setup>
import { ref, computed, onMounted, onBeforeUnmount, onUnmounted, watch, inject } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { imageSrc } from "../platform/image.js";
import { mergeRecords, mutate, load as loadRecords, onDataChanged } from "../data/repository.js";
import Icon from "../ui/Icon.vue";
import AiExtract from "./AiExtract.vue";
import ReleasePackage from "./ReleasePackage.vue";
import { openPath, openUrl } from "../platform/shell.js";
import { fmtDate, nextReleaseDate, weekday } from "../shared/dates.js";
import { errText } from "../shared/errors.js";
import { subLogsByDate, subPushedHours } from "../shared/hours.js";
import { bugStatusInfo, extractCode, parseIssueUrl } from "../shared/links.js";
import { DOMAIN_COLORS } from "../shared/workMeta.js";
import { askConfirm } from "../ui/confirm.js";
import { useDragSort } from "../ui/dragsort.js";
import { cloneJsonData } from "../jsonData.js";
import { normalizeEstimateDays, requirementActualHours, requirementMetrics, iterationProgress as progress } from "../requirementMetrics.js";
import { vDialog } from '../ui/dialog.js'; // 模板里的 v-dialog 由 <script setup> 就地解析（SSR 渲染测试也能用）

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});

const { t } = useI18n();

// 迭代状态阶段（label 走 i18n，computed 保证语言切换后重新求值）
const STATUS_META = {
  plan: { icon: "target" },
  dev: { icon: "edit" },
  test: { icon: "check" },
  pending: { icon: "rocket" },
  live: { icon: "check" },
};
const STATUS = computed(() => ({
  plan: { label: t("iteration.statusPlan"), ...STATUS_META.plan },
  dev: { label: t("iteration.statusDev"), ...STATUS_META.dev },
  test: { label: t("iteration.statusTest"), ...STATUS_META.test },
  pending: { label: t("iteration.statusPending"), ...STATUS_META.pending },
  live: { label: t("iteration.statusLive"), ...STATUS_META.live },
}));
const STATUS_ORDER = ["plan", "dev", "test", "pending", "live"];
// 老数据 / 外部写入可能带未知阶段：直接索引会抛异常并让整页停止渲染
const statusMeta = (s) =>
  STATUS.value[s] || { label: typeof s === "string" && s ? s : t("iteration.statusUnset"), icon: "target" };

const FILTERS = computed(() => [
  { key: "active", label: t("iteration.filterActive") },
  { key: "live", label: t("iteration.filterLive") },
  { key: "all", label: t("iteration.filterAll") },
]);

// 文档 / 会议纪要类型
const DOC_TYPES = computed(() => ({
  prd: { label: t("iteration.docPrd"), icon: "note" },
  proto: { label: t("iteration.docProto"), icon: "grid" },
  testcase: { label: t("iteration.docTestcase"), icon: "check" },
  review: { label: t("iteration.docReview"), icon: "note" },
  other: { label: t("iteration.docOther"), icon: "folder" },
}));

const iterations = ref([]);
let iterationsSaveQueue = Promise.resolve();
let iterationsStale = false;
const domains = ref([]);
const currentId = ref(null);
const search = ref("");
const filter = ref("active");
const showForm = ref(false);
const form = ref(newForm());
const addName = ref("");
const addUrl = ref("");
const addEstimateDays = ref("");
const expanded = ref({}); // reqId -> bool
const subInput = ref({}); // reqId -> string
const subUrlInput = ref({}); // reqId -> string（Coding 链接/编号）
const subLinkOpen = ref({}); // reqId -> bool（低频 Coding 关联字段按需展开）
const subHourInput = ref({}); // reqId -> 工时（推送用）
const subDateInput = ref({}); // reqId -> 归属日 YYYY-MM-DD（空 = 今天；可选未来日期，工时落到指定日）
const subFilterPerson = ref({}); // reqId -> '' 全部 | '@un' 未分配 | 处理人姓名（子任务筛选）
const subFilterDate = ref({}); // reqId -> '' 全部 | YYYY-MM-DD（子任务按归属日筛选）
const qInput = ref({}); // reqId -> string（待确认问题）
const bugInput = ref({}); // reqId -> string（bug 名称或链接）
const hoursTarget = ref(8); // 每日工时目标（设置里可配，默认 8）
const showDocForm = ref(false);
const docForm = ref({ id: "", type: "prd", title: "", url: "", note: "" });
const introDone = ref(false); // 首次入场动画是否已播完

// 该需求今日已填工时（logs 明细按登记日 + 无明细子任务按归属日兜底，口径与工时统计一致）
function todaySubHours(r) {
  const today = fmtDate(new Date());
  let sum = 0;
  for (const s of r.subtasks || []) {
    const detail = Array.isArray(s.logs) && s.logs.length ? s.logs : null;
    if (detail) {
      for (const l of detail) {
        if (l.date === today) sum += Number(l.hours) || 0;
      }
    } else if (s.date === today) {
      sum += Number(s.hours) || 0;
    }
  }
  return Math.round(sum * 100) / 100;
}
// 添加区工时快捷步进（±0.5，最小 0）
function stepHour(r, delta) {
  const cur = Number(subHourInput.value[r.id]) || 0;
  subHourInput.value[r.id] = Math.max(0, Math.round((cur + delta) * 10) / 10);
}
// 添加工时快捷键：↑/↓ 步进 0.5
function onHourKey(r, e) {
  if (e.key === "ArrowUp") {
    e.preventDefault();
    stepHour(r, 0.5);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    stepHour(r, -0.5);
  }
}

// ------- 全局右键菜单（App.vue provide）：需求行快捷操作 -------
const openCtxMenu = inject("openCtxMenu");
function onReqCtx(e, it) {
  openCtxMenu(e, [
    { label: t("iteration.ctxCopyTitle"), icon: "copy", fn: () => copyReqWithLink(it) },
    { label: t("iteration.ctxToggleDone"), icon: "check", fn: () => toggleReq(it) },
    { label: t("iteration.ctxEdit"), icon: "edit", fn: () => startEditReq(it) },
    { label: t("iteration.ctxDelete"), icon: "trash", danger: true, fn: () => removeReq(it) },
  ]);
}

// ------- 子任务筛选：按处理人 / 按归属日（局部，只影响列表展示） -------
function subAssigneeOptions(it) {
  // 该需求出现过的处理人，去重、按出现顺序
  return [...new Set((it.subtasks || []).map((s) => s.assignee).filter(Boolean))];
}
function filteredSubs(it) {
  const subs = it.subtasks || [];
  let p = subFilterPerson.value[it.id] || "";
  const d = subFilterDate.value[it.id] || "";
  // 选中的处理人/「未分配」已不存在时自动回落「全部」，避免筛选悬空
  const names = subAssigneeOptions(it);
  if (p && p !== "@un" && !names.includes(p)) p = "";
  if (p === "@un" && !subs.some((s) => !s.assignee)) p = "";
  if (p !== subFilterPerson.value[it.id]) subFilterPerson.value[it.id] = p;
  return subs.filter((s) => {
    const personOk = !p || (p === "@un" ? !s.assignee : s.assignee === p);
    const dateOk = !d || s.date === d;
    return personOk && dateOk;
  });
}
function toggleSubToday(it) {
  const today = fmtDate(new Date());
  subFilterDate.value[it.id] = subFilterDate.value[it.id] === today ? "" : today;
}

function newForm() {
  return {
    id: "",
    title: "",
    version: "",
    domainIds: [],
    status: "plan",
    releaseDate: nextReleaseDate(),
    goal: "",
    itemsText: "",
  };
}

// ------- 加载 / 保存 -------
async function load() {
  try {
    domains.value = await loadRecords("domains");
    const s = (await invoke("load_data", { key: "settings" })) || {};
    if (s.hoursReminder?.target) hoursTarget.value = Number(s.hoursReminder.target) || 8;
    const data = (await invoke("load_data", { key: "iterations" })) || [];
    data.forEach((it) => {
      if (!Array.isArray(it.docs)) it.docs = [];
      if (!Array.isArray(it.domainIds)) it.domainIds = it.domainId ? [it.domainId] : [];
      (it.items || []).forEach((r) => {
        if (typeof r.url !== "string") r.url = "";
        r.estimateDays = normalizeEstimateDays(r.estimateDays);
        if (!Array.isArray(r.subtasks)) r.subtasks = [];
        r.subtasks.forEach((s) => {
          if (typeof s.url !== "string") s.url = "";
          if (typeof s.code !== "string") s.code = "";
        });
        if (!Array.isArray(r.logs)) r.logs = [];
        if (!Array.isArray(r.questions)) r.questions = [];
        r.questions.forEach((q) => {
          if (!Array.isArray(q.images)) q.images = [];
        });
        if (!Array.isArray(r.bugs)) r.bugs = [];
      });
    });
    iterations.value = data;
  } catch (e) {
    props.showToast(t("iteration.loadFailed", { err: errText(e) }));
  }
}
function persist() {
  if (iterationsStale) {
    return Promise.reject(new Error(t("iteration.staleReload")));
  }
  const snapshot = cloneJsonData(iterations.value);
  const job = iterationsSaveQueue.then(async () => {
    // 与 Agent / 需求大盘 / 任务页共用 repository 的乐观锁：磁盘最新为底，本地改动按 updatedAt 叠上去，
    // 不再整表覆盖（同一数组的多个写者各自保存时不互相抹掉）。
    iterations.value = await mutate("iterations", (fresh) => mergeRecords(fresh, snapshot), { source: "view" });
  });
  iterationsSaveQueue = job.catch(() => {});
  return job.catch((e) => {
    iterationsStale = true;
    props.showToast(t("iteration.saveFailed", { err: errText(e) }));
    throw e;
  });
}
onMounted(async () => {
  await load();
  tryJump();
  // 入场错峰动画只在首次渲染播放，后续切筛选/切视图不再重复
  setTimeout(() => (introDone.value = true), 900);
});
// Agent / 另一窗口改了迭代：无未保存表单时重新加载；有表单时只提示，不打断输入
let offDataChanged = null;
onMounted(() => {
  offDataChanged = onDataChanged(async ({ kind, source }) => {
    if (kind !== "iterations" || source === "view") return;
    if (showForm.value || showDocForm.value) return props.showToast(t("iteration.updatedExternally"));
    await load();
  });
});
onBeforeUnmount(() => offDataChanged?.());
// 配置类弹窗：禁点遮罩关闭，仅 Esc 可关（表单较长，防误触丢输入）
function onEsc(e) {
  if (e.key !== "Escape") return;
  if (showForm.value) showForm.value = false;
  else if (showDocForm.value) showDocForm.value = false;
}
onMounted(() => window.addEventListener("keydown", onEsc));
onUnmounted(() => {
  window.removeEventListener("keydown", onEsc);
});

// ------- 全局搜索深链 -------
function tryJump() {
  const j = props.jumpId;
  if (!j || !j.id) return;
  if (iterations.value.some((r) => r.id === j.id)) currentId.value = j.id;
}
watch(() => props.jumpId, tryJump);

// 录入需求：名称必填；链接仅作记录（可留空）
async function addReq() {
  const name = addName.value.trim();
  if (!name || !current.value) return;
  if (!Array.isArray(current.value.items)) current.value.items = [];
  current.value.items.push({ id: crypto.randomUUID(), name, url: addUrl.value.trim(), estimateDays: normalizeEstimateDays(addEstimateDays.value), note: "", done: false, subtasks: [], logs: [] });
  current.value.updatedAt = Date.now();
  addName.value = "";
  addUrl.value = "";
  addEstimateDays.value = "";
  await persist();
}

// ------- 工具 -------
function domainName(did) {
  const d = domains.value.find((x) => x.id === did);
  return d ? d.name : "";
}
function domainNames(ids) {
  return (ids || []).map((id) => domainName(id)).filter(Boolean);
}
// 领域列表（含色点色）：按领域在 domains 中的下标循环取色（与 DomainView 卡片同源）
function domainList(ids) {
  return (ids || [])
    .map((id) => {
      const i = domains.value.findIndex((d) => d.id === id);
      const d = i >= 0 ? domains.value[i] : null;
      return d ? { id, name: d.name, color: DOMAIN_COLORS[i % DOMAIN_COLORS.length] } : null;
    })
    .filter(Boolean);
}
function toggleFormDomain(id) {
  if (!Array.isArray(form.value.domainIds)) form.value.domainIds = [];
  const arr = form.value.domainIds;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
}
// 迭代完成度 progress() 来自 requirementMetrics（与概览同源，见文件头 import 别名）
function round(n) {
  return Math.round(n * 100) / 100;
}
// 需求工时 = 子任务累计工时之和（子任务即工时）
function reqHours(r) {
  return requirementActualHours(r);
}
function reqMetrics(r) {
  return requirementMetrics(r, hoursTarget.value);
}
// 需求规模文案走 i18n（requirementMetrics 里只有中文 label，按 key 取词条）
const SIZE_LABEL_KEYS = {
  small: "iteration.sizeSmall",
  medium: "iteration.sizeMedium",
  large: "iteration.sizeLarge",
  unestimated: "iteration.sizeUnestimated",
};
function reqSizeLabel(size) {
  const key = SIZE_LABEL_KEYS[size?.key];
  return key ? t(key) : "";
}
function overrunSuffix(r) {
  const metrics = reqMetrics(r);
  return metrics.overrun ? t("iteration.overrunSuffix", { h: metrics.overHours }) : "";
}
function iterHours(it) {
  return round((it.items || []).reduce((s, r) => s + reqHours(r), 0));
}
// 卡片派生：上线包规模与进度语义色
function pkgInfo(it) {
  const p = it.pkg || {};
  const pools = (p.pools || []).length;
  const scripts = (p.dbScripts || []).length;
  return { pools, scripts, has: pools + (p.artifacts || []).length + scripts > 0 };
}
function barClass(it) {
  const { total, pct } = progress(it);
  if (!total) return "none";
  if (pct === 100) return "full";
  if (pct >= 50) return "mid";
  return "low";
}

// ------- 派生 -------
const current = computed(() => iterations.value.find((r) => r.id === currentId.value) || null);

// 需求列表拖拽排序
const reqDrag = useDragSort(
  () => (current.value ? current.value.items || [] : []),
  () => void persist().catch(() => {})
);
// 需求状态筛选（本地状态，与 Coding 无关）：默认只看进行中，点「已完成」查看已完成的
const reqFilter = ref("active"); // active | done | all
const reqCounts = computed(() => {
  const items = current.value?.items || [];
  return { active: items.filter((x) => !x.done).length, done: items.filter((x) => x.done).length, all: items.length };
});
const visibleReqs = computed(() => {
  const items = current.value?.items || [];
  if (reqFilter.value === "done") return items.filter((x) => x.done);
  if (reqFilter.value === "all") return items;
  return items.filter((x) => !x.done);
});
const reqEmptyText = computed(() => {
  if (reqFilter.value === "done") return t("iteration.reqEmptyDone");
  if (reqFilter.value === "all") return t("iteration.reqEmptyAll");
  return t("iteration.reqEmptyActive");
});
const counts = computed(() => ({
  active: iterations.value.filter((r) => r.status !== "live").length,
  live: iterations.value.filter((r) => r.status === "live").length,
  all: iterations.value.length,
}));
const pendingCount = computed(() => iterations.value.filter((r) => r.status === "pending").length);
const filteredList = computed(() => {
  const kw = search.value.trim().toLowerCase();
  return [...iterations.value]
    .filter((r) =>
      filter.value === "all" ? true : filter.value === "live" ? r.status === "live" : filter.value === "pending" ? r.status === "pending" : r.status !== "live"
    )
    .filter(
      (r) =>
        !kw ||
        r.title.toLowerCase().includes(kw) ||
        (r.version || "").toLowerCase().includes(kw) ||
        domainNames(r.domainIds).join(" ").toLowerCase().includes(kw)
    )
    .sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status);
      const bi = STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
});

// ------- 时间轴视图（按上线周分组） -------
const viewMode = ref("card"); // card | timeline

function weekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = (d.getDay() + 6) % 7; // 周一为一周起点
  d.setDate(d.getDate() - day);
  return d;
}
function mmdd(dateStr) {
  return dateStr ? dateStr.slice(5).replace("-", "/") : "";
}
function isLate(r) {
  return r.releaseDate && r.status !== "live" && r.releaseDate < fmtDate(new Date());
}
// 倒计时徽标：距上线日剩余/逾期天数（已上线不显示）
function countdown(r) {
  if (!r.releaseDate || r.status === "live") return null;
  const days = Math.round((new Date(r.releaseDate + "T00:00:00") - new Date(fmtDate(new Date()) + "T00:00:00")) / 86400000);
  if (days < 0) return { text: t("iteration.countdownLate", { days: -days }), cls: "late" };
  if (days === 0) return { text: t("iteration.countdownToday"), cls: "today" };
  if (days <= 2) return { text: t("iteration.countdownLeft", { days }), cls: "soon" };
  return { text: t("iteration.countdownLeft", { days }), cls: "far" };
}
const timelineGroups = computed(() => {
  const map = new Map();
  const noDate = [];
  for (const r of filteredList.value) {
    if (!r.releaseDate) {
      noDate.push(r);
      continue;
    }
    const ws = weekStart(r.releaseDate);
    const key = fmtDate(ws);
    if (!map.has(key)) map.set(key, { key, start: ws, items: [] });
    map.get(key).items.push(r);
  }
  const curWs = weekStart(fmtDate(new Date()));
  const groups = [...map.values()]
    .sort((a, b) => a.start - b.start)
    .map((g) => {
      const end = new Date(g.start);
      end.setDate(end.getDate() + 6);
      const diff = Math.round((g.start - curWs) / 604800000);
      const label = diff === 0 ? t("iteration.weekThis") : diff === 1 ? t("iteration.weekNext") : diff === -1 ? t("iteration.weekLast") : "";
      g.items.sort((a, b) => (a.releaseDate < b.releaseDate ? -1 : a.releaseDate > b.releaseDate ? 1 : 0));
      return { ...g, label, range: mmdd(fmtDate(g.start)) + " - " + mmdd(fmtDate(end)), isCur: diff === 0, isPast: diff < 0 };
    });
  if (noDate.length) groups.push({ key: "nodate", label: t("iteration.weekUnscheduled"), range: "", isCur: false, isPast: false, items: noDate });
  return groups;
});

// ------- 新建 / 编辑 -------
function openCreate() {
  form.value = newForm();
  showForm.value = true;
}

// AI 识图字段定义
const AI_FIELDS = computed(() => [
  { key: "title", label: t("iteration.aiFieldTitle"), desc: t("iteration.aiFieldTitleDesc") },
  { key: "version", label: t("iteration.aiFieldVersion"), desc: t("iteration.aiFieldVersionDesc") },
  { key: "releaseDate", label: t("iteration.aiFieldReleaseDate"), desc: t("iteration.aiFieldReleaseDateDesc") },
  { key: "goal", label: t("iteration.aiFieldGoal"), desc: t("iteration.aiFieldGoalDesc"), multiline: true },
  { key: "itemsText", label: t("iteration.aiFieldItems"), desc: t("iteration.aiFieldItemsDesc"), multiline: true },
]);
function openCreateFromAI(data) {
  form.value = {
    ...newForm(),
    title: data.title || "",
    version: data.version || "",
    releaseDate: data.releaseDate || newForm().releaseDate,
    goal: data.goal || "",
    itemsText: data.itemsText || "",
  };
  showForm.value = true;
}
// 迭代表单内：从需求列表截图批量识别需求项，追加到需求清单（每行一条）
const AI_ITEM_FIELDS = computed(() => [
  { key: "item", label: t("iteration.aiFieldItem"), desc: t("iteration.aiFieldItemDesc") },
]);
function appendItemsFromAI(list) {
  const rows = Array.isArray(list) ? list : [list];
  const lines = rows.map((r) => (r.item || "").trim()).filter(Boolean);
  if (!lines.length) return props.showToast(t("iteration.aiNoItems"));
  const cur = (form.value.itemsText || "").trim();
  form.value.itemsText = cur ? cur + "\n" + lines.join("\n") : lines.join("\n");
  props.showToast(t("iteration.aiItemsAdded", { count: lines.length }));
}
function openEdit(r) {
  form.value = {
    id: r.id,
    title: r.title,
    version: r.version || "",
    domainIds: Array.isArray(r.domainIds) ? [...r.domainIds] : r.domainId ? [r.domainId] : [],
    status: r.status,
    releaseDate: r.releaseDate || "",
    goal: r.goal || "",
    itemsText: "",
  };
  showForm.value = true;
}
async function saveForm() {
  const f = form.value;
  if (!f.title.trim()) return props.showToast(t("iteration.needName"));
  const now = Date.now();
  const existing = f.id ? iterations.value.find((r) => r.id === f.id) : null;
  if (existing) {
    Object.assign(existing, {
      title: f.title.trim(),
      version: f.version.trim(),
      domainIds: [...(f.domainIds || [])],
      status: f.status,
      releaseDate: f.releaseDate,
      goal: f.goal.trim(),
      updatedAt: now,
    });
  } else {
    const seeded = f.itemsText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((name) => ({ id: crypto.randomUUID(), name, url: "", estimateDays: null, note: "", done: false, subtasks: [], logs: [] }));
    iterations.value.push({
      id: crypto.randomUUID(),
      title: f.title.trim(),
      version: f.version.trim(),
      domainIds: [...(f.domainIds || [])],
      status: f.status,
      releaseDate: f.releaseDate,
      goal: f.goal.trim(),
      items: seeded,
      releaseId: "",
      liveAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  await persist();
  showForm.value = false;
  props.showToast(existing ? t("iteration.updated") : t("iteration.created"));
}

// ------- 详情 -------
function enter(r) {
  currentId.value = r.id;
}
function exit() {
  currentId.value = null;
}
async function setStatus(s) {
  if (!current.value) return;
  current.value.status = s;
  if (s === "live" && !current.value.liveAt) current.value.liveAt = Date.now();
  current.value.updatedAt = Date.now();
  await persist();
}

// 特殊复制：标题 + Coding 链接。同时写入纯文本与 HTML 富文本，
// 贴到 Excel 时落在同一单元格内换行且链接可点
async function copyReqWithLink(it) {
  const title = it.name || "";
  const url = (it.url || "").trim();
  const text = url ? `${title}\n${url}` : title;
  try {
    if (url && navigator.clipboard.write && window.ClipboardItem) {
      const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const html = `<div>${esc(title)}<br><a href="${esc(url)}">${esc(url)}</a></div>`;
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    props.showToast(url ? t("iteration.copiedWithLink") : t("iteration.copiedTitleNoLink"));
  } catch (e) {
    props.showToast(t("iteration.copyFailed", { err: e }));
  }
}
async function toggleReq(it) {
  it.done = !it.done;
  if (current.value) current.value.updatedAt = Date.now();
  await persist();
  props.showToast(it.done ? t("iteration.reqDone", { name: it.name }) : t("iteration.reqRestored", { name: it.name }));
}
async function removeReq(it) {
  if (!current.value) return;
  const host = current.value;
  const idx = (host.items || []).findIndex((x) => x.id === it.id);
  if (idx < 0) return;
  host.items.splice(idx, 1);
  host.updatedAt = Date.now();
  await persist();
  props.showToast(t("iteration.reqDeleted", { name: it.name }), {
    actionLabel: t("iteration.undo"),
    onAction: async () => {
      host.items.splice(Math.min(idx, host.items.length), 0, it);
      host.updatedAt = Date.now();
      await persist();
      props.showToast(t("iteration.restored"));
    },
  });
}
// 行内编辑需求标题与 Coding 链接
const reqEdit = ref({ id: "", name: "", url: "", estimateDays: "" });
function startEditReq(it) {
  reqEdit.value = { id: it.id, name: it.name, url: it.url || "", estimateDays: it.estimateDays || "" };
}
function cancelEditReq() {
  reqEdit.value = { id: "", name: "", url: "", estimateDays: "" };
}
async function saveEditReq(it) {
  const name = reqEdit.value.name.trim();
  if (!name) return props.showToast(t("iteration.reqNameRequired"));
  it.name = name;
  it.url = reqEdit.value.url.trim();
  it.estimateDays = normalizeEstimateDays(reqEdit.value.estimateDays);
  touch();
  cancelEditReq();
  await persist();
  props.showToast(t("iteration.reqUpdated", { suffix: overrunSuffix(it) }));
}
function touch() {
  if (current.value) current.value.updatedAt = Date.now();
}
function toggleExpand(r) {
  expanded.value[r.id] = !expanded.value[r.id];
  if (expanded.value[r.id]) loadQImages(r);
}

// ------- 子任务 -------
// 子任务名默认以「需求名：」开头（对齐 Coding 命名习惯）：聚焦空输入框时自动带出，不需要可直接删改
function prefillSub(r) {
  if (!(subInput.value[r.id] || "").trim() && (r.name || "").trim()) subInput.value[r.id] = r.name.trim() + "：";
}
async function addSub(r) {
  const name = (subInput.value[r.id] || "").trim();
  if (!name || name === r.name?.trim() + "：") return; // 只有预填前缀没写内容，视为未填
  const raw = (subUrlInput.value[r.id] || "").trim();
  const url = /^https?:\/\//.test(raw) ? raw : "";
  const code = extractCode(raw);
  const h = Number(subHourInput.value[r.id]) || 0;
  const date = subDateInput.value[r.id] || fmtDate(new Date());
  if (!Array.isArray(r.subtasks)) r.subtasks = [];
  r.subtasks.push({ id: crypto.randomUUID(), name, url, code, done: false, hours: h || 0, date });
  subInput.value[r.id] = "";
  subUrlInput.value[r.id] = "";
  subLinkOpen.value[r.id] = false;
  subHourInput.value[r.id] = "";
  subDateInput.value[r.id] = "";
  touch();
  await persist();
  if (reqMetrics(r).overrun) props.showToast(t("iteration.subAdded", { suffix: overrunSuffix(r) }));
}
async function toggleSub(s) {
  s.done = !s.done;
  touch();
  await persist();
}
function subLogsTitle(s) {
  const parts = subLogsByDate(s).map((l) => `${l.date} ${l.hours}h`);
  return parts.length ? t("iteration.subLogsTitle", { list: parts.join(t("iteration.listSep")) }) : "";
}
// 子任务归属日可直接改（行内日期框），改完即存
async function saveSubDate() {
  touch();
  await persist();
}
// 子任务行内编辑（名称/工时/归属日/链接）
const subEdit = ref({ id: "", name: "", hours: "", date: "", url: "" });
function startEditSub(s) {
  subEdit.value = { id: s.id, name: s.name, hours: s.hours || "", date: s.date || fmtDate(new Date()), url: s.url || "" };
}
function cancelEditSub() {
  subEdit.value = { id: "", name: "", hours: "", date: "", url: "" };
}
async function saveEditSub(r, s) {
  const name = subEdit.value.name.trim();
  if (!name) return props.showToast(t("iteration.subNameRequired"));
  s.name = name;
  s.hours = Math.max(0, Number(subEdit.value.hours) || 0);
  s.date = subEdit.value.date || fmtDate(new Date());
  const raw = subEdit.value.url.trim();
  s.url = /^https?:\/\//.test(raw) ? raw : "";
  if (!s.code) s.code = extractCode(raw); // 编辑时补了 Coding 链接，顺带提取编号
  touch();
  await persist();
  cancelEditSub();
  props.showToast(t("iteration.subUpdated", { suffix: overrunSuffix(r) }));
}
async function removeSub(r, s) {
  const idx = (r.subtasks || []).findIndex((x) => x.id === s.id);
  if (idx < 0) return;
  r.subtasks.splice(idx, 1);
  touch();
  await persist();
  props.showToast(t("iteration.subDeleted", { name: s.name }), {
    actionLabel: t("iteration.undo"),
    onAction: async () => {
      r.subtasks.splice(Math.min(idx, r.subtasks.length), 0, s);
      touch();
      await persist();
      props.showToast(t("iteration.restored"));
    },
  });
}

// ------- 待产品确认 -------
function openQ(r) {
  return (r.questions || []).filter((q) => q.status !== "resolved").length;
}
async function addQuestion(r) {
  const text = (qInput.value[r.id] || "").trim();
  if (!text) return;
  if (!Array.isArray(r.questions)) r.questions = [];
  r.questions.push({ id: crypto.randomUUID(), text, status: "open", answer: "", images: [], createdAt: Date.now() });
  qInput.value[r.id] = "";
  touch();
  await persist();
}
async function toggleQuestion(q) {
  q.status = q.status === "resolved" ? "open" : "resolved";
  q.resolvedAt = q.status === "resolved" ? Date.now() : null;
  touch();
  await persist();
}
async function removeQuestion(r, q) {
  r.questions = (r.questions || []).filter((x) => x.id !== q.id);
  touch();
  await persist();
  // 连带清理该问题的截图文件（失败不阻断）
  for (const img of q.images || []) {
    try {
      await invoke("delete_image", { name: img.name });
    } catch (e) {}
  }
}
function buildQuestionText(r) {
  const list = (r.questions || []).filter((q) => q.status !== "resolved");
  if (!list.length) return "";
  const head = t("iteration.questionHead", {
    prefix: current.value.version ? current.value.version + " " : "",
    title: current.value.title,
    req: r.name,
  });
  const lines = list.map((q, i) => `${i + 1}. ${q.text}`);
  return head + "\n" + lines.join("\n");
}
async function copyQuestions(r) {
  const text = buildQuestionText(r);
  if (!text) return props.showToast(t("iteration.reqNoQuestions"));
  try {
    await navigator.clipboard.writeText(text);
    props.showToast(t("iteration.questionsCopied"));
  } catch (e) {
    props.showToast(t("iteration.copyFailed", { err: e }));
  }
}
async function copyAllQuestions() {
  const blocks = (current.value.items || []).map(buildQuestionText).filter(Boolean);
  if (!blocks.length) return props.showToast(t("iteration.iterNoQuestions"));
  try {
    await navigator.clipboard.writeText(blocks.join("\n\n"));
    props.showToast(t("iteration.allQuestionsCopied"));
  } catch (e) {
    props.showToast(t("iteration.copyFailed", { err: e }));
  }
}
const currentOpenQ = computed(() => (current.value?.items || []).reduce((s, r) => s + openQ(r), 0));

// ------- 缺陷跟踪（本地 bug 记录：名称或链接二选一） -------
function openBugs(r) {
  return (r.bugs || []).filter((b) => !b.done).length;
}
async function addBug(r) {
  const raw = (bugInput.value[r.id] || "").trim();
  if (!raw) return;
  const ref = parseIssueUrl(raw);
  const url = /^https?:\/\//.test(raw) ? raw : "";
  if (!Array.isArray(r.bugs)) r.bugs = [];
  r.bugs.push({
    id: crypto.randomUUID(),
    url,
    code: ref ? String(ref.issueCode) : "",
    name: ref ? "" : raw, // 纯文本视为名称；链接留空（标题打开链接可见）
    statusName: "",
    done: false,
    syncedAt: 0,
    lastError: "",
    createdAt: Date.now(),
  });
  bugInput.value[r.id] = "";
  touch();
  await persist();
}
async function removeBug(r, b) {
  r.bugs = (r.bugs || []).filter((x) => x.id !== b.id);
  touch();
  await persist();
}
// 状态徽标色调：本地关闭绿 > 兼容老数据（有平台状态时按状态归类）> 进行中蓝
function bugToneClass(b) {
  if (b.done) return "done";
  if (b.syncedAt && b.statusName) return bugStatusInfo(b.statusName).tone;
  return "active";
}
function buildBugText(r) {
  const list = (r.bugs || []).filter((b) => !b.done);
  if (!list.length) return "";
  const head = t("iteration.bugHead", {
    prefix: current.value.version ? current.value.version + " " : "",
    title: current.value.title,
    req: r.name,
  });
  const lines = list.map((b, i) => t("iteration.bugLine", {
    index: i + 1,
    ref: b.code || b.url,
    name: b.name ? " " + b.name : "",
    status: b.statusName ? t("iteration.bugStatusSuffix", { status: b.statusName }) : "",
  }));
  return head + "\n" + lines.join("\n");
}
async function copyBugs(r) {
  const text = buildBugText(r);
  if (!text) return props.showToast(t("iteration.reqNoBugs"));
  try {
    await navigator.clipboard.writeText(text);
    props.showToast(t("iteration.bugsCopied"));
  } catch (e) {
    props.showToast(t("iteration.copyFailed", { err: e }));
  }
}
async function copyAllBugs() {
  const blocks = (current.value.items || []).map(buildBugText).filter(Boolean);
  if (!blocks.length) return props.showToast(t("iteration.iterNoBugs"));
  try {
    await navigator.clipboard.writeText(blocks.join("\n\n"));
    props.showToast(t("iteration.allBugsCopied"));
  } catch (e) {
    props.showToast(t("iteration.copyFailed", { err: e }));
  }
}
const currentOpenBugs = computed(() => (current.value?.items || []).reduce((s, r) => s + openBugs(r), 0));

// ------- 待确认问题截图附件（复用 ProblemView 的 save_image 机制：图片单独落盘，JSON 只存元数据） -------
const qImgCache = ref({}); // name -> 显示 URL（桌面 asset 协议 / 浏览器 dataURL）
const qPreviewSrc = ref("");

// 展开需求时懒加载其下所有问题的截图
async function loadQImages(r) {
  for (const q of r.questions || []) {
    for (const img of q.images || []) {
      if (qImgCache.value[img.name] !== undefined) continue;
      try {
        qImgCache.value[img.name] = await imageSrc(img.name);
      } catch (e) {
        qImgCache.value[img.name] = "";
      }
    }
  }
}
function qBlobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
async function addQImageBlob(q, blob, mime) {
  const ext = (mime || "").includes("jpeg") ? "jpg" : (mime || "").includes("webp") ? "webp" : "png";
  const name = `q-${q.id.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const b64 = await qBlobToB64(blob);
  await invoke("save_image", { name, dataB64: b64 });
  if (!Array.isArray(q.images)) q.images = [];
  q.images.push({ id: crypto.randomUUID(), name, createdAt: Date.now() });
  qImgCache.value[name] = `data:${mime || "image/png"};base64,${b64}`;
}
async function onPickQImages(q, e) {
  const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
  e.target.value = "";
  if (!files.length) return;
  try {
    for (const f of files) await addQImageBlob(q, f, f.type);
    touch();
    await persist();
    props.showToast(t("iteration.imagesAdded", { count: files.length }));
  } catch (err) {
    props.showToast(t("iteration.saveImageFailed", { err }));
  }
}
async function pasteQImages(q) {
  try {
    const items = await navigator.clipboard.read();
    let added = 0;
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await it.getType(type);
      await addQImageBlob(q, blob, type);
      added++;
    }
    if (!added) return props.showToast(t("iteration.clipboardNoImage"));
    touch();
    await persist();
    props.showToast(t("iteration.imagesPasted", { count: added }));
  } catch (err) {
    props.showToast(t("iteration.clipboardReadFailed", { err }));
  }
}
async function removeQImage(q, img) {
  const idx = (q.images || []).findIndex((x) => x.id === img.id);
  q.images = (q.images || []).filter((x) => x.id !== img.id);
  touch();
  await persist();
  props.showToast(t("iteration.imageDeleted"), {
    actionLabel: t("iteration.undo"),
    onAction: async () => {
      q.images.splice(Math.min(Math.max(idx, 0), q.images.length), 0, img);
      touch();
      await persist();
    },
    // 撤销窗口结束后才删文件
    onExpire: async () => {
      try {
        await invoke("delete_image", { name: img.name });
      } catch (e) {}
    },
  });
}

// ------- 文档 / 会议纪要 -------
function openDocCreate() {
  docForm.value = { id: "", type: "prd", title: "", url: "", note: "" };
  showDocForm.value = true;
}
function openDocEdit(d) {
  docForm.value = { id: d.id, type: d.type, title: d.title, url: d.url || "", note: d.note || "" };
  showDocForm.value = true;
}
async function saveDoc() {
  if (!current.value) return;
  const f = docForm.value;
  if (!f.title.trim()) return props.showToast(t("iteration.docTitleRequired"));
  if (!Array.isArray(current.value.docs)) current.value.docs = [];
  const existing = f.id ? current.value.docs.find((d) => d.id === f.id) : null;
  if (existing) Object.assign(existing, { type: f.type, title: f.title.trim(), url: f.url.trim(), note: f.note.trim() });
  else current.value.docs.push({ id: crypto.randomUUID(), type: f.type, title: f.title.trim(), url: f.url.trim(), note: f.note.trim() });
  touch();
  await persist();
  showDocForm.value = false;
  props.showToast(existing ? t("iteration.docUpdated") : t("iteration.docAdded"));
}
async function removeDoc(d) {
  if (!current.value) return;
  current.value.docs = (current.value.docs || []).filter((x) => x.id !== d.id);
  touch();
  await persist();
}

async function openLink(url) {
  if (!url) return;
  try {
    if (/^https?:\/\//i.test(url)) await openUrl(url);
    else await openPath(url);
  } catch (e) {
    props.showToast(t("iteration.openFailed", { err: e }));
  }
}
async function removeIteration(r) {
  const ok = await askConfirm({
    title: t("iteration.deleteTitle"),
    message: t("iteration.deleteMsg", { title: r.title }),
    okText: t("iteration.deleteOk"),
  });
  if (!ok) return;
  const idx = iterations.value.findIndex((x) => x.id === r.id);
  iterations.value = iterations.value.filter((x) => x.id !== r.id);
  if (currentId.value === r.id) currentId.value = null;
  await persist();
  props.showToast(t("iteration.deleted"), {
    actionLabel: t("iteration.undo"),
    onAction: async () => {
      iterations.value.splice(Math.min(Math.max(idx, 0), iterations.value.length), 0, r);
      await persist();
      props.showToast(t("iteration.restored"));
    },
  });
}

</script>

<template>
  <!-- ============ 迭代详情 ============ -->
  <template v-if="current">
    <div class="detail-bar">
      <button class="back-btn" @click="exit"><Icon name="chevron" :size="16" class="rot90" /> {{ t("iteration.backToList") }}</button>
    </div>

    <section class="hero">
      <span class="hero-icon"><Icon name="repeat" :size="22" /></span>
      <div class="hero-main">
        <div class="hero-title-line">
          <span v-if="current.version" class="ver-chip">{{ current.version }}</span>
          <h2>{{ current.title }}</h2>
        </div>
        <div class="hero-meta">
          <span v-if="current.releaseDate" class="date-chip" :class="countdown(current) ? countdown(current).cls : ''">
            <Icon name="clock" :size="14" /> {{ current.releaseDate }} {{ weekday(current.releaseDate) }}<template v-if="countdown(current)"> · {{ countdown(current).text }}</template>
          </span>
          <span v-for="dn in domainNames(current.domainIds)" :key="dn" class="proj-chip"><Icon name="layers" :size="13" /> {{ dn }}</span>
          <span class="st-chip" :class="'st-' + current.status">{{ statusMeta(current.status).label }}</span>
        </div>
        <p v-if="current.goal" class="hero-goal">{{ current.goal }}</p>
        <div class="bar"><i :style="{ width: progress(current).pct + '%' }"></i></div>
        <p class="prog-text">{{ t("iteration.progressText", { done: progress(current).done, total: progress(current).total, hours: iterHours(current) }) }}</p>
      </div>
      <div class="hero-ops">
        <button class="btn-outline" @click="openEdit(current)"><Icon name="edit" :size="15" /> {{ t("common.edit") }}</button>
        <button class="btn-outline danger" @click="removeIteration(current)"><Icon name="trash" :size="15" /> {{ t("common.delete") }}</button>
      </div>
    </section>

    <!-- 状态阶段条 -->
    <div class="stepper">
      <button
        v-for="(s, i) in STATUS_ORDER"
        :key="s"
        class="step-pill"
        :class="{ on: current.status === s, past: STATUS_ORDER.indexOf(current.status) > i }"
        @click="setStatus(s)"
      >
        <Icon :name="statusMeta(s).icon" :size="14" /> {{ statusMeta(s).label }}
      </button>
    </div>

    <main class="content">
      <h3 class="list-title"><Icon name="note" :size="16" /> {{ t("iteration.reqListTitle") }} <em class="hcount">{{ t("iteration.hoursAccum", { hours: iterHours(current) }) }}</em>
        <button v-if="currentOpenQ" class="btn-ghost xs" style="margin-left: auto;" :title="t('iteration.copyAllQuestionsTitle')" @click="copyAllQuestions">
          <Icon name="copy" :size="13" /> {{ t("iteration.copyAllQuestions", { count: currentOpenQ }) }}
        </button>
        <button v-if="currentOpenBugs" class="btn-ghost xs" :title="t('iteration.copyAllBugsTitle')" @click="copyAllBugs">
          <Icon name="copy" :size="13" /> {{ t("iteration.copyAllBugs", { count: currentOpenBugs }) }}
        </button>
      </h3>
      <div class="req-filter">
        <button class="chip xs" :class="{ active: reqFilter === 'active' }" :title="t('iteration.reqFilterActiveTitle')" @click="reqFilter = 'active'">{{ t("iteration.reqFilterActive") }}<em class="count">{{ reqCounts.active }}</em></button>
        <button class="chip xs" :class="{ active: reqFilter === 'done' }" :title="t('iteration.reqFilterDoneTitle')" @click="reqFilter = 'done'">{{ t("iteration.reqFilterDone") }}<em class="count">{{ reqCounts.done }}</em></button>
        <button class="chip xs" :class="{ active: reqFilter === 'all' }" :title="t('iteration.reqFilterAllTitle')" @click="reqFilter = 'all'">{{ t("iteration.reqFilterAll") }}<em class="count">{{ reqCounts.all }}</em></button>
      </div>
      <div class="req-list">
        <div v-if="!visibleReqs.length" class="req-empty">{{ reqEmptyText }}</div>
        <div
          v-for="it in visibleReqs"
          :key="it.id"
          class="req-block"
          :class="{ 'drag-over': reqDrag.overId.value === it.id, dragging: reqDrag.dragId.value === it.id }"
          @dragover="reqDrag.onDragOver($event, it.id)"
          @drop="reqDrag.onDrop($event, it.id)"
        >
          <div class="req-row" :class="{ done: it.done, overrun: reqMetrics(it).overrun }" @contextmenu.prevent="onReqCtx($event, it)">
            <span
              class="drag-handle"
              :title="t('iteration.dragSort')"
              draggable="true"
              @dragstart="reqDrag.onDragStart($event, it.id)"
              @dragend="reqDrag.onDragEnd()"
            ><Icon name="sort" :size="13" /></span>
            <button class="check" :class="{ on: it.done }" @click="toggleReq(it)">
              <Icon v-if="it.done" name="check" :size="14" />
            </button>
            <div v-if="reqEdit.id === it.id" class="req-main req-edit" @click.stop>
              <input v-model="reqEdit.name" class="req-edit-name" :placeholder="t('iteration.formReqTitle')" @keyup.enter="saveEditReq(it)" @keyup.esc="cancelEditReq" />
              <input v-model="reqEdit.estimateDays" class="req-edit-days" type="number" min="0.5" step="0.5" :placeholder="t('iteration.estimateDays')" :title="t('iteration.estimateDaysHint')" @keyup.enter="saveEditReq(it)" @keyup.esc="cancelEditReq" />
              <input v-model="reqEdit.url" class="req-edit-url" :placeholder="t('iteration.reqUrlPh')" @keyup.enter="saveEditReq(it)" @keyup.esc="cancelEditReq" />
              <button class="btn-ghost sm" @click="saveEditReq(it)"><Icon name="check" :size="14" /> {{ t("iteration.save") }}</button>
              <button class="icon-btn" :title="t('common.cancel')" @click="cancelEditReq"><Icon name="x" :size="14" /></button>
            </div>
            <div v-else class="req-main" @click="toggleExpand(it)">
              <span class="req-name" :title="it.name">{{ it.name }}</span>
              <span class="req-sub">
                <span class="req-status" :class="{ on: it.done }" :title="it.done ? t('iteration.reqDoneTitle') : t('iteration.reqActiveTitle')" @click.stop="toggleReq(it)">
                  <Icon :name="it.done ? 'check' : 'clock'" :size="11" /> {{ it.done ? t("iteration.stateDone") : t("iteration.stateActive") }}
                </span>
                <span class="req-size" :class="reqMetrics(it).size.key" :title="reqMetrics(it).sizeSource === 'actual' ? t('iteration.sizeActualHint') : t('iteration.sizeEstimateHint')">
                  {{ reqSizeLabel(reqMetrics(it).size) }}<template v-if="reqMetrics(it).sizeSource === 'actual'">{{ t("iteration.sizeActualSuffix") }}</template>
                </span>
                <span v-if="reqMetrics(it).estimateDays != null" class="mini-chip estimate" :title="t('iteration.reqEstimateTitle')">{{ t("iteration.reqEstimate", { days: reqMetrics(it).estimateDays }) }}</span>
                <span v-if="(it.subtasks || []).length" class="mini-chip">{{ t("iteration.subtaskCount", { done: (it.subtasks || []).filter((s) => s.done).length, total: (it.subtasks || []).length }) }}</span>
                <span v-if="reqHours(it)" class="mini-chip hrs" :title="t('iteration.subHoursTitle')">{{ t("iteration.reqActual", { days: reqMetrics(it).actualDays, hours: reqHours(it) }) }}</span>
                <span v-if="(it.subtasks || []).length" class="mini-chip completed" :title="t('iteration.completedSubHours', { hours: reqMetrics(it).completedHours })">{{ t("iteration.subCompleted", { days: reqMetrics(it).completedDays }) }}</span>
                <span v-if="reqMetrics(it).overrun" class="req-overrun" :title="t('iteration.overrunTitle', { actual: reqMetrics(it).actualHours, estimate: reqMetrics(it).estimateHours })">
                  <Icon name="alert" :size="11" /> {{ t("iteration.overrun", { hours: reqMetrics(it).overHours }) }}
                </span>
                <span v-if="openQ(it)" class="stat-dot warn" :title="t('iteration.openQTitle', { count: openQ(it) })">{{ openQ(it) }}</span>
                <span v-if="openBugs(it)" class="stat-dot danger" :title="t('iteration.openBugsTitle', { count: openBugs(it) })">{{ openBugs(it) }}</span>
              </span>
            </div>
            <button v-if="reqEdit.id !== it.id" class="icon-btn" :title="t('iteration.editReqTitle')" @click="startEditReq(it)"><Icon name="edit" :size="14" /></button>
            <button class="icon-btn" :title="t('iteration.ctxCopyTitle')" @click="copyReqWithLink(it)"><Icon name="copy" :size="14" /></button>
            <button v-if="it.url" class="icon-btn" :title="t('iteration.openReqTitle')" @click="openLink(it.url)"><Icon name="link" :size="15" /></button>
            <button class="icon-btn" :title="expanded[it.id] ? t('nav.collapse') : t('iteration.expandSub')" @click="toggleExpand(it)">
              <Icon name="chevron" :size="15" :class="{ rot180: expanded[it.id] }" />
            </button>
            <button class="icon-btn" :title="t('common.delete')" @click="removeReq(it)"><Icon name="x" :size="14" /></button>
          </div>

          <div v-if="expanded[it.id]" class="req-detail">
            <div class="sub-sec">
              <div class="sub-title">
                <Icon name="check" :size="13" /> {{ t("iteration.subtaskSection") }} <em v-if="(it.subtasks || []).length">{{ (it.subtasks || []).filter((s) => s.done).length }}/{{ (it.subtasks || []).length }}</em>
                <span v-if="reqMetrics(it).overrun" class="req-overrun" :title="t('iteration.subOverrunTitle', { estimate: reqMetrics(it).estimateHours, actual: reqMetrics(it).actualHours })">
                  <Icon name="alert" :size="11" /> {{ t("iteration.subOverrun", { hours: reqMetrics(it).overHours }) }}
                </span>
                <span class="today-hours" :class="{ ok: todaySubHours(it) >= hoursTarget }" :title="t('iteration.todayHoursTitle', { done: todaySubHours(it), target: hoursTarget })">
                  <Icon name="clock" :size="12" /> {{ t("iteration.todayHours", { done: todaySubHours(it), target: hoursTarget }) }}
                </span>
              </div>
              <div v-if="(it.subtasks || []).length" class="sub-filter">
                <div class="sub-filter-chips">
                  <button class="chip xs" :class="{ active: !subFilterPerson[it.id] }" :title="t('iteration.showAllSubs')" @click="subFilterPerson[it.id] = ''">{{ t("iteration.all") }}<em class="count">{{ (it.subtasks || []).length }}</em></button>
                  <button v-for="p in subAssigneeOptions(it)" :key="p" class="chip xs" :class="{ active: subFilterPerson[it.id] === p }" :title="t('iteration.onlyPersonSubs', { name: p })" @click="subFilterPerson[it.id] = subFilterPerson[it.id] === p ? '' : p">{{ p }}<em class="count">{{ (it.subtasks || []).filter((s) => s.assignee === p).length }}</em></button>
                  <button v-if="(it.subtasks || []).some((s) => !s.assignee)" class="chip xs" :class="{ active: subFilterPerson[it.id] === '@un' }" :title="t('iteration.onlyUnassignedTitle')" @click="subFilterPerson[it.id] = subFilterPerson[it.id] === '@un' ? '' : '@un'">{{ t("iteration.unassigned") }}<em class="count">{{ (it.subtasks || []).filter((s) => !s.assignee).length }}</em></button>
                </div>
                <div class="sub-filter-date">
                  <input v-model="subFilterDate[it.id]" type="date" class="sub-filter-input" :title="t('iteration.filterByDate')" />
                  <button class="chip xs" :class="{ active: subFilterDate[it.id] === fmtDate(new Date()) }" :title="t('iteration.onlyTodayTitle')" @click="toggleSubToday(it)">{{ t("iteration.today") }}</button>
                </div>
              </div>
              <template v-for="s in filteredSubs(it)" :key="s.id">
                <div v-if="subEdit.id !== s.id" class="sub-row" :class="{ done: s.done }">
                  <button class="check sm" :class="{ on: s.done }" @click="toggleSub(s)"><Icon v-if="s.done" name="check" :size="12" /></button>
                  <span class="sub-name" @click="toggleSub(s)">{{ s.name }}</span>
                  <span v-if="s.assignee" class="sub-assignee" :title="t('iteration.assignee')"><Icon name="briefcase" :size="11" /> {{ s.assignee }}</span>
                  <span v-if="s.hours && !subPushedHours(s)" class="sub-hours" :title="t('iteration.totalHours')">{{ s.hours }}h</span>
                  <span v-if="subPushedHours(s) > 0" class="sub-done-hours" :title="t('iteration.loggedHoursTitle')">{{ t("iteration.subHoursDone", { hours: subPushedHours(s) }) }}</span>
                  <span v-if="subLogsByDate(s).length" class="sub-logs" :title="subLogsTitle(s)">
                    <span v-for="l in subLogsByDate(s)" :key="l.date" class="sub-date" :class="{ today: l.date === fmtDate(new Date()) }"><Icon name="calendar" :size="11" /> {{ l.date.slice(5) }} {{ l.hours }}h</span>
                  </span>
                  <span v-else-if="s.date" class="sub-date" :class="{ today: s.date === fmtDate(new Date()) }" :title="t('iteration.dateBelong')"><Icon name="calendar" :size="11" /> {{ s.date.slice(5) }}</span>
                  <input v-model="s.date" type="date" class="sub-row-date" :title="t('iteration.dateBelongHint')" @change="saveSubDate" />
                  <a v-if="s.url" class="sub-code link" @click.stop="openLink(s.url)" :title="s.url">
                    <Icon name="link" :size="11" /> {{ t("iteration.link") }}
                  </a>
                  <button class="icon-btn xs" :title="t('iteration.editSubTitle')" @click="startEditSub(s)"><Icon name="edit" :size="13" /></button>
                  <button class="icon-btn xs" :title="t('common.delete')" @click="removeSub(it, s)"><Icon name="x" :size="13" /></button>
                </div>
                <div v-else class="sub-row sub-editing">
                  <button class="check sm" :class="{ on: s.done }" disabled :title="t('iteration.editingHint')"><Icon v-if="s.done" name="check" :size="12" /></button>
                  <input v-model="subEdit.name" class="sub-edit-name" :placeholder="t('iteration.subName')" @keyup.enter="saveEditSub(it, s)" @keyup.esc="cancelEditSub" />
                  <input v-model="subEdit.hours" type="number" class="sub-edit-hours" min="0" step="0.5" :placeholder="t('iteration.hoursPh')" :title="t('iteration.totalHours')" @keyup.enter="saveEditSub(it, s)" @keyup.esc="cancelEditSub" />
                  <input v-model="subEdit.date" type="date" class="sub-row-date" :title="t('iteration.dateBelong')" @keyup.enter="saveEditSub(it, s)" @keyup.esc="cancelEditSub" />
                  <input v-model="subEdit.url" class="sub-edit-url" :placeholder="t('iteration.subUrlPh')" @keyup.enter="saveEditSub(it, s)" @keyup.esc="cancelEditSub" />
                  <button class="btn-ghost xs" @click="saveEditSub(it, s)"><Icon name="check" :size="11" /> {{ t("iteration.save") }}</button>
                  <button class="btn-ghost xs" @click="cancelEditSub">{{ t("common.cancel") }}</button>
                </div>
              </template>
              <div v-if="(it.subtasks || []).length && !filteredSubs(it).length" class="sub-empty">{{ t("iteration.subEmpty") }}</div>
              <div class="sub-add task-sub-add">
                <div class="sub-add-main">
                  <input v-model="subInput[it.id]" class="sub-add-name" :placeholder="t('iteration.subName')" @focus="prefillSub(it)" @keyup.enter="addSub(it)" />
                  <button
                    v-if="!subLinkOpen[it.id]"
                    type="button"
                    class="btn-ghost xs sub-link-toggle"
                    :class="{ linked: subUrlInput[it.id] }"
                    :title="subUrlInput[it.id] ? t('iteration.linkFilledTitle') : t('iteration.linkOptionalTitle')"
                    :aria-expanded="false"
                    :aria-controls="`sub-link-${it.id}`"
                    @click="subLinkOpen[it.id] = true"
                  >
                    <Icon name="link" :size="12" /> {{ subUrlInput[it.id] ? t("iteration.linkFilled") : t("iteration.linkAdd") }}
                  </button>
                  <div class="hour-box">
                    <input v-model="subHourInput[it.id]" class="sub-add-hour" type="number" min="0" step="0.5" :placeholder="t('iteration.hoursPh')" :title="t('iteration.hourStepHint')" @keydown="onHourKey(it, $event)" @keyup.enter="addSub(it)" />
                    <span class="hour-steps">
                      <button type="button" class="hour-btn" :title="t('iteration.hourMinus')" @click="stepHour(it, -0.5)">−</button>
                      <button type="button" class="hour-btn" :title="t('iteration.hourPlus')" @click="stepHour(it, 0.5)">+</button>
                    </span>
                    <span class="hour-quick">
                      <button v-for="h in [1, 2, 4, 8]" :key="h" type="button" class="hour-chip" :title="t('iteration.fillHours', { h })" @click="subHourInput[it.id] = h">{{ h }}h</button>
                    </span>
                  </div>
                  <input v-model="subDateInput[it.id]" type="date" class="sub-add-date" :title="t('iteration.dateBelongDefaultHint')" @keyup.enter="addSub(it)" />
                  <button class="btn-ghost sm" @click="addSub(it)"><Icon name="plus" :size="14" /> {{ t("iteration.add") }}</button>
                </div>
                <div v-if="subLinkOpen[it.id]" :id="`sub-link-${it.id}`" class="sub-link-extra">
                  <Icon name="link" :size="13" />
                  <input v-model="subUrlInput[it.id]" class="sub-add-url" :placeholder="t('iteration.subUrlPhInput')" autofocus @keyup.enter="addSub(it)" />
                  <button type="button" class="icon-btn xs" :title="t('iteration.collapseLink')" :aria-label="t('iteration.collapseLink')" @click="subLinkOpen[it.id] = false"><Icon name="chevron" :size="12" :class="{ rot180: true }" /></button>
                </div>
              </div>
            </div>
            <div class="sub-sec">
              <div class="sub-title">
                <Icon name="alert" :size="13" /> {{ t("iteration.questionsSection") }} <em v-if="openQ(it)">{{ t("iteration.questionsOpen", { count: openQ(it) }) }}</em>
                <button v-if="openQ(it)" class="btn-ghost xs sync-btn" :title="t('iteration.copyQuestionsTitle')" @click="copyQuestions(it)">
                  <Icon name="copy" :size="12" /> {{ t("iteration.copyQuestionsBtn") }}
                </button>
              </div>
              <div v-for="q in it.questions || []" :key="q.id" class="q-row" :class="{ resolved: q.status === 'resolved' }">
                <button class="check sm" :class="{ on: q.status === 'resolved' }" :title="q.status === 'resolved' ? t('iteration.markOpenTitle') : t('iteration.markResolvedTitle')" @click="toggleQuestion(q)"><Icon v-if="q.status === 'resolved'" name="check" :size="12" /></button>
                <div class="q-main">
                  <span class="q-text">{{ q.text }}</span>
                  <input v-model="q.answer" class="q-answer" :placeholder="t('iteration.answerPh')" @change="persist" />
                  <div class="q-imgs">
                    <div v-for="img in q.images || []" :key="img.id" class="q-img-cell">
                      <img v-if="qImgCache[img.name]" :src="qImgCache[img.name]" :title="t('iteration.zoomIn')" @click="qPreviewSrc = qImgCache[img.name]" />
                      <span v-else class="q-img-miss"><Icon name="image" :size="14" /></span>
                      <button class="q-img-del" :title="t('iteration.deleteImage')" @click="removeQImage(q, img)"><Icon name="x" :size="10" /></button>
                    </div>
                    <label class="q-img-add" :title="t('iteration.uploadImageTitle')">
                      <Icon name="plus" :size="12" /> {{ t("iteration.pickImage") }}
                      <input type="file" accept="image/*" multiple hidden @change="onPickQImages(q, $event)" />
                    </label>
                    <button class="q-img-add" :title="t('iteration.pasteImageTitle')" @click="pasteQImages(q)"><Icon name="copy" :size="11" /> {{ t("iteration.paste") }}</button>
                  </div>
                </div>
                <button class="icon-btn xs" :title="t('common.delete')" @click="removeQuestion(it, q)"><Icon name="x" :size="13" /></button>
              </div>
              <div class="sub-add">
                <input v-model="qInput[it.id]" class="sub-add-name" :placeholder="t('iteration.questionPh')" @keyup.enter="addQuestion(it)" />
                <button class="btn-ghost sm" @click="addQuestion(it)"><Icon name="plus" :size="14" /> {{ t("iteration.addQuestion") }}</button>
              </div>
            </div>
            <div class="sub-sec">
              <div class="sub-title">
                <Icon name="alert" :size="13" /> {{ t("iteration.bugsSection") }} <em v-if="openBugs(it)">{{ t("iteration.bugsOpen", { count: openBugs(it) }) }}</em>
                <button v-if="openBugs(it)" class="btn-ghost xs" :title="t('iteration.copyBugsTitle')" @click="copyBugs(it)">
                  <Icon name="copy" :size="12" /> {{ t("iteration.copyBugsBtn") }}
                </button>
              </div>
              <div v-for="b in it.bugs || []" :key="b.id" class="bug-row">
                <span class="bug-tone" :class="bugToneClass(b)"></span>
                <div class="bug-main">
                  <span class="bug-name" :title="b.url">{{ b.code ? "#" + b.code + " " : "" }}{{ b.name || t("iteration.bugUnnamed") }}</span>
                </div>
                <span class="bug-status" :class="{ muted: !b.done }">{{ b.done ? t("iteration.bugClosed") : t("iteration.stateActive") }}</span>
                <button v-if="b.url" class="icon-btn xs" :title="t('iteration.openLink')" @click="openLink(b.url)"><Icon name="link" :size="13" /></button>
                <button class="icon-btn xs" :title="t('common.delete')" @click="removeBug(it, b)"><Icon name="x" :size="13" /></button>
              </div>
              <div class="sub-add">
                <input v-model="bugInput[it.id]" class="sub-add-name" :placeholder="t('iteration.bugPh')" @keyup.enter="addBug(it)" />
                <button class="btn-ghost sm" @click="addBug(it)"><Icon name="plus" :size="14" /> {{ t("iteration.addBug") }}</button>
              </div>
            </div>
          </div>
        </div>

        <div class="req-add">
          <div class="req-add-link">
            <Icon name="link" :size="13" />
            <input v-model="addUrl" class="req-add-url" :placeholder="t('iteration.reqUrlPhShort')" @keyup.enter="addReq" />
          </div>
          <div class="req-add-title">
            <input v-model="addName" class="req-add-name" :placeholder="t('iteration.formReqTitle')" @keyup.enter="addReq" />
          </div>
          <input v-model="addEstimateDays" class="req-add-days" type="number" min="0.5" step="0.5" :placeholder="t('iteration.estimateDays')" :title="t('iteration.estimateDaysOptionalHint')" @keyup.enter="addReq" />
          <button class="btn-ghost sm" @click="addReq"><Icon name="plus" :size="15" /> {{ t("iteration.addReq") }}</button>
        </div>
      </div>

      <div class="doc-head">
        <h3 class="list-title"><Icon name="folder" :size="16" /> {{ t("iteration.docsSection") }}</h3>
        <button class="btn-ghost sm" @click="openDocCreate"><Icon name="plus" :size="14" /> {{ t("iteration.addDoc") }}</button>
      </div>
      <div v-if="(current.docs || []).length" class="doc-list">
        <div v-for="d in current.docs" :key="d.id" class="doc-row">
          <span class="doc-type"><Icon :name="DOC_TYPES[d.type]?.icon || 'note'" :size="14" /> {{ DOC_TYPES[d.type]?.label || t("iteration.docOther") }}</span>
          <span class="doc-title" :class="{ link: d.url }" @click="openLink(d.url)">{{ d.title }}</span>
          <span v-if="d.note" class="doc-note">{{ d.note }}</span>
          <span class="doc-ops">
            <button v-if="d.url" class="icon-btn" :title="t('iteration.openLink')" @click="openLink(d.url)"><Icon name="open" :size="14" /></button>
            <button class="icon-btn" :title="t('common.edit')" @click="openDocEdit(d)"><Icon name="edit" :size="14" /></button>
            <button class="icon-btn" :title="t('common.delete')" @click="removeDoc(d)"><Icon name="x" :size="13" /></button>
          </span>
        </div>
      </div>
      <p v-else class="doc-empty">{{ t("iteration.docsEmpty") }}</p>

      <ReleasePackage :iteration="current" :persist="persist" :show-toast="showToast" />
    </main>
  </template>

  <!-- ============ 迭代列表 ============ -->
  <template v-else>
    <div class="toolbar">
      <div class="tb-left">
        <h3 class="section-title">{{ t("iteration.myIterations") }}</h3>
        <div class="filters">
          <button v-for="f in FILTERS" :key="f.key" class="chip" :class="{ active: filter === f.key }" @click="filter = f.key">
            {{ f.label }}<em class="count">{{ counts[f.key] }}</em>
          </button>
        </div>
        <div class="search-mini">
          <Icon name="search" :size="15" class="s-icon" />
          <input v-model="search" :placeholder="t('iteration.searchPh')" />
        </div>
      </div>
      <div class="tb-right">
        <div class="view-toggle">
          <button class="vt-btn" :class="{ on: viewMode === 'card' }" :title="t('iteration.viewCard')" @click="viewMode = 'card'"><Icon name="grid" :size="14" /></button>
          <button class="vt-btn" :class="{ on: viewMode === 'timeline' }" :title="t('iteration.viewTimeline')" @click="viewMode = 'timeline'"><Icon name="clock" :size="14" /></button>
        </div>
        <button class="btn-primary sm" @click="openCreate"><Icon name="plus" :size="15" /> {{ t("iteration.create") }}</button>
                <AiExtract :fields="AI_FIELDS" :hint="t('iteration.aiExtractHint')" :title="t('iteration.aiExtractTitle')" :show-toast="showToast" @apply="openCreateFromAI" />
      </div>
    </div>

    <div class="summary">
      <button class="stat" :class="{ on: filter === 'active' }" @click="filter = 'active'"><span class="num">{{ counts.active }}</span><span class="lbl">{{ t("iteration.statActive") }}</span></button>
      <button class="stat pend" :class="{ on: filter === 'pending' }" @click="filter = 'pending'"><span class="num">{{ pendingCount }}</span><span class="lbl">{{ t("iteration.statusPending") }}</span></button>
      <button class="stat live" :class="{ on: filter === 'live' }" @click="filter = 'live'"><span class="num">{{ counts.live }}</span><span class="lbl">{{ t("iteration.statusLive") }}</span></button>
    </div>

    <main class="content">
      <!-- 时间轴视图 -->
      <div v-if="filteredList.length && viewMode === 'timeline'" class="tl">
        <div v-for="g in timelineGroups" :key="g.key" class="tl-group" :class="{ cur: g.isCur, past: g.isPast }">
          <div class="tl-week">
            <span class="tl-dot"></span>
            <span class="tl-week-name">{{ g.label || t("iteration.weekOf", { date: g.range.slice(0, 5) }) }}</span>
            <span v-if="g.range" class="tl-week-range">{{ g.range }}</span>
            <em class="tl-count">{{ g.items.length }}</em>
          </div>
          <div class="tl-items">
            <div v-for="r in g.items" :key="r.id" class="tl-item" @click="enter(r)">
              <span class="tl-date" :class="{ late: isLate(r) }">
                <template v-if="r.releaseDate">{{ mmdd(r.releaseDate) }} {{ weekday(r.releaseDate) }}</template>
                <template v-else>-</template>
              </span>
              <span class="st-chip sm" :class="'st-' + r.status">
                <Icon :name="statusMeta(r.status).icon" :size="11" /> {{ statusMeta(r.status).label }}
              </span>
              <span class="tl-title" :title="(r.version ? r.version + ' ' : '') + r.title">
                <em v-if="r.version" class="ver-chip">{{ r.version }}</em>
                {{ r.title }}
                <i v-if="isLate(r)" class="tl-late-tag">{{ t("iteration.late") }}</i>
              </span>
              <span class="tl-right">
                <span class="prog-text" :class="barClass(r)">{{ progress(r).done }}/{{ progress(r).total }}</span>
                <span class="tl-minibar" :class="barClass(r)"><i :style="{ width: progress(r).pct + '%' }"></i></span>
                <span v-if="pkgInfo(r).has || r.releaseId" class="tl-pkg" :title="r.releaseId ? t('iteration.releaseLinked') : t('iteration.pkgBuilt')"><Icon name="rocket" :size="12" /></span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 卡片视图 -->
      <div v-else-if="filteredList.length" class="it-grid" :class="{ 'no-anim': introDone }">
        <div v-for="(r, i) in filteredList" :key="r.id" class="it-card" :style="{ animationDelay: i * 0.04 + 's' }" @click="enter(r)">
          <div class="it-head">
            <span class="st-chip" :class="'st-' + r.status">
              <Icon :name="statusMeta(r.status).icon" :size="12" /> {{ statusMeta(r.status).label }}
            </span>
            <button class="icon-btn" :title="t('common.delete')" @click.stop="removeIteration(r)"><Icon name="trash" :size="15" /></button>
          </div>
          <div class="it-title-line">
            <span v-if="r.version" class="ver-chip">{{ r.version }}</span>
            <h4 class="it-title">{{ r.title }}</h4>
          </div>
          <p v-if="r.goal" class="it-goal" :title="r.goal">{{ r.goal }}</p>
          <div class="it-meta">
            <span v-for="d in domainList(r.domainIds)" :key="d.id" class="dom-dot" :style="{ background: d.color }" :title="d.name"></span>
            <span v-if="r.releaseDate" class="date-chip" :class="countdown(r) ? countdown(r).cls : ''">
              <Icon name="clock" :size="12" /> {{ r.releaseDate.slice(5) }} {{ weekday(r.releaseDate) }}<template v-if="countdown(r)"> · {{ countdown(r).text }}</template>
            </span>
          </div>
          <div class="bar" :class="barClass(r)"><i :style="{ width: progress(r).pct + '%' }"></i></div>
          <div class="it-foot">
            <span class="prog-text" :class="barClass(r)">{{ t("iteration.reqProgress", { done: progress(r).done, total: progress(r).total }) }}<template v-if="progress(r).total"> · {{ progress(r).pct }}%</template></span>
            <span class="foot-chips">
              <template v-if="pkgInfo(r).has || r.releaseId">
                <span v-if="r.releaseId" class="linked-mini"><Icon name="rocket" :size="12" /> {{ t("iteration.releaseOrder") }}</span>
                <span v-else class="linked-mini pkg"><Icon name="rocket" :size="12" /> {{ t("iteration.pkgBuilt") }}</span>
              </template>
              <span v-if="pkgInfo(r).pools || pkgInfo(r).scripts" class="mini-chip" :title="t('iteration.pkgScaleTitle')">{{ pkgInfo(r).pools }} Pool<template v-if="pkgInfo(r).scripts"> · {{ t("iteration.pkgScripts", { count: pkgInfo(r).scripts }) }}</template></span>
              <span v-if="iterHours(r)" class="mini-chip hrs" :title="t('iteration.hoursTotalTitle')">{{ iterHours(r) }}h</span>
            </span>
          </div>
        </div>
      </div>
      <div v-else class="empty">
          <span class="empty-ico"><Icon name="repeat" :size="32" /></span>
        <h2>{{ t("iteration.emptyTitle") }}</h2>
        <p>{{ t("iteration.emptyDesc") }}</p>
        <button class="btn-outline lg" @click="openCreate"><Icon name="plus" :size="16" /> {{ t("iteration.emptyCreate") }}</button>
      </div>
    </main>
  </template>

  <!-- ============ 新建 / 编辑弹窗 ============ -->
  <div v-if="showForm" class="modal-mask">
    <div class="modal" v-dialog>
      <h2>{{ form.id ? t("iteration.formEditTitle") : t("iteration.formCreateTitle") }}</h2>

      <div class="row2">
        <label class="field grow">
          <span>{{ t("iteration.formName") }}</span>
          <input v-model="form.title" :placeholder="t('iteration.formNamePh')" />
        </label>
        <label class="field">
          <span>{{ t("iteration.formVersion") }}</span>
          <input v-model="form.version" :placeholder="t('iteration.formVersionPh')" />
        </label>
      </div>

      <div class="row2">
        <label class="field">
          <span>{{ t("iteration.formDomains") }}</span>
          <div class="domain-picker">
            <button
              v-for="d in domains"
              :key="d.id"
              type="button"
              class="dp-chip"
              :class="{ on: (form.domainIds || []).includes(d.id) }"
              @click="toggleFormDomain(d.id)"
            >
              <Icon v-if="(form.domainIds || []).includes(d.id)" name="check" :size="12" /> {{ d.name }}
            </button>
            <span v-if="!domains.length" class="dp-empty">{{ t("iteration.formNoDomains") }}</span>
          </div>
        </label>
        <label class="field">
          <span>{{ t("iteration.formReleaseDate") }}</span>
          <input v-model="form.releaseDate" type="date" />
        </label>
      </div>

      <label class="field">
        <span>{{ t("iteration.formStatus") }}</span>
        <div class="type-picker">
          <button
            v-for="s in STATUS_ORDER"
            :key="s"
            type="button"
            class="type-opt"
            :class="{ active: form.status === s }"
            @click="form.status = s"
          >
            <Icon :name="STATUS[s].icon" :size="14" /> {{ STATUS[s].label }}
          </button>
        </div>
      </label>

      <label class="field">
        <span>{{ t("iteration.formGoal") }}</span>
        <textarea v-model="form.goal" rows="2" :placeholder="t('iteration.formGoalPh')"></textarea>
      </label>

      <label v-if="!form.id" class="field">
        <span class="field-hd">
          {{ t("iteration.formItems") }}
          <AiExtract :fields="AI_ITEM_FIELDS" :multiple="true" :button-label="t('iteration.aiAddItemsBtn')" dedupe-key="item" :existing="(form.itemsText || '').split('\n').map((s) => s.trim()).filter(Boolean)" :hint="t('iteration.aiItemsHint')" :title="t('iteration.aiItemsTitle')" :show-toast="showToast" @apply="appendItemsFromAI" />
        </span>
        <textarea v-model="form.itemsText" rows="4" :placeholder="t('iteration.formItemsPh')"></textarea>
      </label>

      <div class="modal-foot">
        <button class="btn-ghost" @click="showForm = false">{{ t("common.cancel") }}</button>
        <button class="btn-primary" @click="saveForm">{{ t("iteration.save") }}</button>
      </div>
    </div>
  </div>

  <!-- ============ 文档 / 会议纪要弹窗 ============ -->
  <div v-if="showDocForm" class="modal-mask">
    <div class="modal" v-dialog>
      <h2>{{ docForm.id ? t("iteration.docFormEditTitle") : t("iteration.docFormCreateTitle") }}</h2>

      <label class="field">
        <span>{{ t("iteration.docFormType") }}</span>
        <div class="type-picker">
          <button
            v-for="(m, k) in DOC_TYPES"
            :key="k"
            type="button"
            class="type-opt"
            :class="{ active: docForm.type === k }"
            @click="docForm.type = k"
          >
            <Icon :name="m.icon" :size="14" /> {{ m.label }}
          </button>
        </div>
      </label>

      <label class="field">
        <span>{{ t("iteration.docFormTitle") }}</span>
        <input v-model="docForm.title" :placeholder="t('iteration.docFormTitlePh')" @keyup.enter="saveDoc" />
      </label>

      <label class="field">
        <span>{{ t("iteration.docFormUrl") }}</span>
        <input v-model="docForm.url" :placeholder="t('iteration.docFormUrlPh')" @keyup.enter="saveDoc" />
      </label>

      <label class="field">
        <span>{{ t("iteration.docFormNote") }}</span>
        <textarea v-model="docForm.note" rows="2" :placeholder="t('iteration.docFormNotePh')"></textarea>
      </label>

      <div class="modal-foot">
        <button class="btn-ghost" @click="showDocForm = false">{{ t("common.cancel") }}</button>
        <button class="btn-primary" @click="saveDoc">{{ t("iteration.save") }}</button>
      </div>
    </div>
  </div>

  <!-- 待确认问题截图放大预览 -->
  <div v-if="qPreviewSrc" class="modal-mask img-preview" v-dialog="{ label: t('common.preview') }" @click="qPreviewSrc = ''">
    <img :src="qPreviewSrc" />
  </div>
</template>

<style scoped>
.detail-bar { padding: var(--sp-5) 28px 0; }
.back-btn { display: inline-flex; align-items: center; gap: var(--sp-1); background: none; border: none; color: var(--muted); font-size: var(--fs-base); cursor: pointer; padding: var(--sp-05) 0; }
.back-btn:hover { color: var(--primary); }
.rot90 { transform: rotate(90deg); }

/* hero */
.hero { display: flex; gap: var(--sp-6); align-items: flex-start; margin: var(--sp-4) 28px 0; padding: var(--sp-7) 22px; background: var(--card); border: 1px solid var(--card-border); border-left: 4px solid var(--primary); border-radius: var(--r-lg); box-shadow: var(--shadow); }
.hero-icon { width: 46px; height: 46px; flex-shrink: 0; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary); display: grid; place-items: center; }
.hero-main { flex: 1; min-width: 0; }
.hero-title-line { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-2); flex-wrap: wrap; }
.hero-title-line h2 { margin: 0; font-size: var(--fs-xl); }
.hero-meta { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; margin-bottom: var(--sp-2); }
.hero-goal { margin: 0 0 var(--sp-4); font-size: var(--fs-md); color: var(--text-weak); line-height: var(--lh-body); }
.hero-ops { display: flex; flex-direction: column; gap: var(--sp-2); flex-shrink: 0; }

.ver-chip { font-size: var(--fs-sm); font-weight: 700; color: var(--accent-hover); background: var(--accent-soft); padding: 2px var(--sp-3); border-radius: var(--r-pill); font-family: var(--font-num); } /* 版本号胶囊：DESIGN §2.3 强制规范指定用法 */
.date-chip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--text-soft); background: var(--well); padding: 3px var(--sp-3); border-radius: var(--r-pill); white-space: nowrap; }
/* 时间胶囊（日期 + 倒计时合并）：颜色跟随倒计时状态 */
.date-chip.far { color: var(--primary); background: var(--primary-soft); }
.date-chip.soon { color: var(--warn-deep); background: var(--warn-soft); }
.date-chip.today { color: var(--success-deep); background: var(--success-soft); }
.date-chip.late { color: var(--danger-deep); background: var(--danger-soft); }
.proj-chip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--primary); background: var(--primary-soft); padding: 3px var(--sp-3); border-radius: var(--r-pill); }
/* 领域色点（卡片视图瘦身：领域 chip → 8px 色点，hover 显示名称） */
.dom-dot { width: 8px; height: 8px; border-radius: var(--r-pill); display: inline-block; flex-shrink: 0; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08); }

/* 视图切换 */
.view-toggle { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--r-sm); overflow: hidden; background: var(--card); }
.vt-btn { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: none; background: transparent; color: var(--muted); cursor: pointer; transition: all 0.15s; }
.vt-btn + .vt-btn { border-left: 1px solid var(--border); }
.vt-btn:hover { color: var(--primary); }
.vt-btn.on { background: var(--primary-soft); color: var(--primary); }

/* 时间轴视图 */
.tl { max-width: 900px; }
.tl-group { position: relative; padding: 0 0 18px 22px; border-left: 2px solid var(--border); margin-left: var(--sp-2); }
.tl-group:last-child { padding-bottom: var(--sp-05); }
.tl-group.past { opacity: 0.72; }
.tl-week { display: flex; align-items: baseline; gap: var(--sp-3); margin-bottom: var(--sp-3); }
.tl-dot { position: absolute; left: -7px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: var(--card); border: 3px solid var(--border-strong); }
.tl-group.cur { border-left-color: var(--primary); }
.tl-group.cur .tl-dot { border-color: var(--primary); box-shadow: 0 0 0 4px var(--primary-soft); }
.tl-week-name { font-size: var(--fs-base); font-weight: 700; color: var(--text); }
.tl-group.cur .tl-week-name { color: var(--primary); }
.tl-week-range { font-size: var(--fs-sm); color: var(--muted); }
.tl-count { font-style: normal; font-size: var(--fs-xs); font-weight: 700; color: var(--muted); background: var(--well); padding: 1px var(--sp-2); border-radius: var(--r-pill); }
.tl-items { display: flex; flex-direction: column; gap: var(--sp-2); }
.tl-item { display: flex; align-items: center; gap: var(--sp-3); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); padding: var(--sp-3) var(--sp-5); cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s; }
.tl-item:hover { border-color: var(--primary); box-shadow: 0 6px 18px color-mix(in srgb, var(--primary) 12%, transparent); transform: translateX(2px); }
.tl-date { flex-shrink: 0; width: 86px; font-size: var(--fs-sm); font-weight: 600; color: var(--text-soft); font-variant-numeric: tabular-nums; }
.tl-date.late { color: var(--danger-deep); }
.tl-title { flex: 1; min-width: 0; font-size: var(--fs-base); font-weight: 600; color: var(--text); display: flex; align-items: center; gap: var(--sp-2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tl-title .ver-chip { font-style: normal; flex-shrink: 0; }
.tl-late-tag { font-style: normal; flex-shrink: 0; font-size: var(--fs-xs); font-weight: 700; color: var(--danger-deep); background: var(--danger-soft); padding: 1px var(--sp-2); border-radius: var(--r-pill); }
.tl-right { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3); }
.tl-right .prog-text { margin: 0; font-size: var(--fs-sm); }
.tl-minibar { width: 64px; height: 6px; background: var(--well); border-radius: var(--r-pill); overflow: hidden; }
.tl-minibar i { display: block; height: 100%; background: linear-gradient(90deg, var(--primary), var(--accent-light)); border-radius: var(--r-pill); }
.tl-minibar.low i { background: linear-gradient(90deg, var(--amber-bright), var(--amber-light)); }
.tl-minibar.mid i { background: linear-gradient(90deg, var(--primary), var(--primary-light)); }
.tl-minibar.full i { background: linear-gradient(90deg, var(--success), var(--success-light)); }
.tl-pkg { display: grid; place-items: center; width: 24px; height: 24px; border-radius: var(--r-xs); color: var(--amber); background: var(--warn-soft); }

.bar { height: 7px; background: var(--well); border-radius: var(--r-pill); overflow: hidden; }
.bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--primary), var(--accent-light)); border-radius: var(--r-pill); transition: width 0.3s; }
.bar.low i { background: linear-gradient(90deg, var(--amber-bright), var(--amber-light)); }
.bar.mid i { background: linear-gradient(90deg, var(--primary), var(--primary-light)); }
.bar.full i { background: linear-gradient(90deg, var(--success), var(--success-light)); }
.prog-text { margin: var(--sp-2) 0 0; font-size: var(--fs-md); color: var(--muted); }
.prog-text.full { color: var(--success-deep); font-weight: 600; }
.prog-text.low { color: var(--warn-deep); }

/* 状态阶段条 */
.stepper { display: flex; gap: var(--sp-2); padding: var(--sp-6) 28px 0; flex-wrap: wrap; }
.step-pill { display: inline-flex; align-items: center; gap: var(--sp-1); border: 1px solid var(--border-strong); background: var(--card); color: var(--text-dim); padding: var(--sp-2) var(--sp-5); border-radius: var(--r-pill); font-size: var(--fs-md); font-weight: 600; cursor: pointer; transition: all 0.15s; }
.step-pill:hover { border-color: var(--primary); color: var(--primary-hover); }
.step-pill.past { color: var(--primary-hover); border-color: var(--border-blue); background: var(--primary-soft); }
.step-pill.on { color: var(--text-invert); background: var(--primary-hover); border-color: var(--primary-hover); }

/* 操作行 */
.action-row { display: flex; align-items: center; gap: var(--sp-4); padding: var(--sp-6) 28px 0; flex-wrap: wrap; }
.linked-tip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-md); color: var(--success); }

/* 需求清单 */
.content { flex: 1; padding: var(--sp-6) 28px 36px; }
.list-title { display: flex; align-items: center; gap: 7px; margin: 0 0 var(--sp-3); font-size: var(--fs-base); font-weight: 700; }
/* 需求状态筛选：进行中（默认）/ 已完成 / 全部 */
.req-filter { display: flex; gap: var(--sp-1); flex-wrap: wrap; margin: 0 0 var(--sp-3); }
.req-empty { padding: var(--sp-7) var(--sp-6); font-size: var(--fs-md); color: var(--text-dim); text-align: center; }
.req-list { display: flex; flex-direction: column; }
/* 列表平铺：主列表不设容器（背景层），行分隔线分组，与独立卡片形成层级对比 */
.req-row { display: flex; align-items: center; gap: var(--sp-4); padding: var(--sp-4) var(--sp-6); border-bottom: 1px solid var(--border); transition: background 0.15s, box-shadow 0.15s; }
.req-row:last-child { border-bottom: none; }
.req-row:hover { background: color-mix(in srgb, var(--primary) 5%, transparent); box-shadow: inset 2px 0 0 var(--primary); }
.req-row.overrun { background: color-mix(in srgb, var(--danger) 5%, transparent); box-shadow: inset 2px 0 0 var(--danger); }
.req-row.done .req-name { color: var(--muted); text-decoration: line-through; }
.check { width: 22px; height: 22px; flex-shrink: 0; padding: 0; border: 1.5px solid var(--border-strong); border-radius: var(--r-xs); background: var(--card); cursor: pointer; display: grid; place-items: center; color: var(--text-invert); }
.check.on { background: var(--primary); border-color: var(--primary); }
.req-name { flex: 1; min-width: 0; font-size: var(--fs-md); cursor: pointer; word-break: break-word; }
.req-add { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-4) var(--sp-6); background: var(--card-soft); flex-wrap: wrap; }
.req-add input { flex: 1; padding: 9px var(--sp-4); border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-md); outline: none; background: var(--card); color: var(--text); }
.req-add input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
/* 链接是主输入：前置图标 + 识别中提示 */
.req-add-link { display: flex; align-items: center; gap: 7px; flex: 3; min-width: 220px; color: var(--muted); }
.req-add-link input { flex: 1; min-width: 0; }
.req-add-loading { display: inline-flex; align-items: center; gap: var(--sp-05); font-size: var(--fs-xs); color: var(--muted); flex-shrink: 0; }
/* 标题框：自动带出时绿色勾 + 浅绿底，提示可直接修改 */
.req-add-title { display: flex; align-items: center; gap: var(--sp-1); flex: 2; min-width: 160px; color: var(--success-deep); }
.req-add-title input { flex: 1; min-width: 0; }
.req-add-title.auto input { border-color: var(--success-border); background: var(--success-tint); }
.req-add-title.auto input:focus { border-color: var(--success); box-shadow: 0 0 0 3px var(--success-soft); }
.req-add .req-add-days { flex: 0 0 112px; min-width: 112px; }

/* 需求块（可展开） */
.req-block { border-bottom: 1px solid var(--border); }
.req-block:last-of-type { border-bottom: none; }
.req-block .req-row { border-bottom: none; }
.req-block.dragging { opacity: 0.45; }
.req-block.drag-over { box-shadow: inset 0 2px 0 var(--primary); }
.drag-handle { flex-shrink: 0; display: grid; place-items: center; width: 20px; height: 22px; color: var(--border-strong); cursor: grab; border-radius: var(--r-xs); }
.drag-handle:hover { color: var(--primary); background: var(--primary-soft); }
.drag-handle:active { cursor: grabbing; }
.req-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; cursor: pointer; }
/* 需求行内编辑态：标题 + 链接双输入框 */
.req-edit { flex-direction: row; align-items: center; gap: var(--sp-2); cursor: default; }
.req-edit input { padding: 7px var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-md); outline: none; background: var(--card); color: var(--text); }
.req-edit input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.req-edit-name { flex: 2; min-width: 0; }
.req-edit .req-edit-days { flex: 0 0 104px; min-width: 104px; }
.req-edit-url { flex: 3; min-width: 0; }
.req-sub { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
/* 需求状态标签（本地状态）：进行中紫 / 已完成绿，点击切换 */
.req-status { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs); font-weight: 600; padding: 1px var(--sp-2); border-radius: var(--r-pill); cursor: pointer; user-select: none; transition: box-shadow 0.15s, transform 0.1s; }
.req-status:not(.on) { color: var(--primary-hover); background: var(--primary-soft); }
.req-status.on { color: var(--success-deep); background: var(--success-soft); }
/* 可点击反馈：hover 描边提示、按压下沉（对齐全局按钮语言） */
.req-status:not(.on):hover { box-shadow: inset 0 0 0 1px var(--border-blue); }
.req-status.on:hover { box-shadow: inset 0 0 0 1px var(--success-border); }
.req-status:active { transform: translateY(1px); }
.mini-chip { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs); color: var(--text-dim); background: var(--well); padding: 1px var(--sp-2); border-radius: var(--r-pill); }
.mini-chip.hrs { color: var(--primary-hover); background: var(--primary-soft); font-weight: 600; }
.mini-chip.estimate { color: var(--primary-hover); background: var(--primary-soft); font-weight: 600; }
.mini-chip.completed { color: var(--success-deep); background: var(--success-soft); font-weight: 600; }
.req-size, .req-overrun { display: inline-flex; align-items: center; gap: 3px; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 600; }
.req-size.small { color: var(--teal-deep); background: var(--teal-soft); }
.req-size.medium { color: var(--warn-deep); background: var(--warn-soft); }
.req-size.large, .req-overrun { color: var(--danger-deep); background: var(--danger-soft); }
.req-size.unestimated { color: var(--text-dim); background: var(--well); }
/* 需求行计数点：待确认（琥珀）/ 未关闭 bug（红），数字胶囊替代长标签 */
.stat-dot { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 var(--sp-05); border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 700; font-style: normal; }
.stat-dot.warn { color: var(--warn-deep); background: var(--warn-soft); }
.stat-dot.danger { color: var(--danger-deep); background: var(--danger-soft); }
.hcount { font-style: normal; font-size: var(--fs-sm); color: var(--primary-hover); background: var(--primary-soft); padding: var(--sp-0) 9px; border-radius: var(--r-pill); font-weight: 600; margin-left: auto; }
.rot180 { transform: rotate(180deg); transition: transform 0.15s; }

/* 需求详情：子任务 + 工时 */
.req-detail { padding: 4px var(--sp-6) var(--sp-5) 50px; display: flex; flex-direction: column; gap: var(--sp-6); background: var(--card-soft); border-top: 1px dashed var(--border); }
.sub-sec { display: flex; flex-direction: column; gap: 7px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); padding: var(--sp-4) var(--sp-5); }
.sub-title { font-size: var(--fs-sm); font-weight: 700; color: var(--text-soft); display: flex; align-items: center; gap: var(--sp-1); }
.sub-title em { font-style: normal; font-weight: 600; color: var(--primary-hover); }
/* 今日工时完成度徽标：未达标琥珀、达标绿色 */
.today-hours { display: inline-flex; align-items: center; gap: var(--sp-05); font-size: var(--fs-xs); font-weight: 600; color: var(--warn-deep); background: var(--warn-soft); border-radius: var(--r-pill); padding: 1px var(--sp-2); }
.today-hours.ok { color: var(--success-deep); background: var(--success-soft); }
/* 子任务筛选条：人名 chips + 归属日 */
.sub-filter { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
.sub-filter-chips { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
.sub-filter-date { display: flex; align-items: center; gap: var(--sp-1); flex-shrink: 0; }
.sub-filter-input { width: 122px; padding: 2px var(--sp-1); border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-xs); background: var(--card); color: var(--text); outline: none; }
.sub-filter-input:focus { border-color: var(--primary); }
.sub-filter-input::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.55; }
.chip.xs { padding: 3px 9px; font-size: var(--fs-xs); border-radius: var(--r-sm); }
.chip.xs .count { font-size: var(--fs-xs); padding: 0 var(--sp-1); }
.sub-empty { font-size: var(--fs-xs); color: var(--muted); padding: var(--sp-0) 0 var(--sp-05); }
.sub-row { display: flex; align-items: center; gap: 9px; }
/* 未推送子任务行内编辑态：保持 sub-row 布局，字段在原位置就地变为输入框（日期框复用行内 .sub-row-date，零变化） */
.sub-row.sub-editing { flex-wrap: wrap; }
.sub-row.sub-editing .check:disabled { opacity: 0.4; cursor: not-allowed; }
.sub-edit-name, .sub-edit-hours, .sub-edit-url { padding: 5px 9px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-md); outline: none; background: var(--card); color: var(--text); }
.sub-edit-name:focus, .sub-edit-hours:focus, .sub-edit-url:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.sub-edit-name { flex: 1; min-width: 0; }
.sub-edit-hours { width: 80px; flex-shrink: 0; }
.sub-edit-url { flex: 2; min-width: 150px; }
.sub-row.done .sub-name { color: var(--muted); text-decoration: line-through; }
.check.sm { width: 18px; height: 18px; border-radius: var(--r-xs); }
.sub-name { flex: 1; min-width: 0; font-size: var(--fs-md); cursor: pointer; word-break: break-word; }
.sub-code { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); background: var(--ghost); border: 1px solid var(--border-strong); border-radius: var(--r-xs); padding: var(--sp-0) 7px; font-family: var(--font-mono); }
.sub-hours { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 700; color: var(--primary-hover); background: var(--primary-soft); border-radius: var(--r-xs); padding: var(--sp-0) 7px; }
/* 分次推送进度徽标：已完成（绿）/ 剩余（琥珀） */
.sub-done-hours { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 700; color: var(--success-deep); background: var(--success-soft); border-radius: var(--r-xs); padding: var(--sp-0) 7px; }
.sub-remain-hours { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 700; color: var(--warn-deep); background: var(--warn-soft); border-radius: var(--r-xs); padding: var(--sp-0) 7px; }
.sub-assignee { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; font-size: var(--fs-xs); color: var(--teal-deep); background: var(--teal-soft); border-radius: var(--r-xs); padding: var(--sp-0) 7px; }
.sub-unpushed { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--warn-deep); background: var(--warn-soft); border-radius: var(--r-pill); padding: 1px 7px; }
.sub-code.link { color: var(--primary); background: var(--primary-soft); border-color: var(--border-blue); cursor: pointer; }
.sub-code.link:hover { background: var(--primary-soft-hover); }
.sub-add { display: flex; gap: var(--sp-2); margin-top: 3px; flex-wrap: wrap; }
.sub-add input { padding: 7px var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-sm); outline: none; background: var(--card); color: var(--text); }
.sub-add input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.task-sub-add { display: flex; flex-direction: column; align-items: stretch; }
.sub-add-main { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.sub-add-name { flex: 1; min-width: 120px; }
.sub-link-toggle { flex-shrink: 0; }
.sub-link-toggle.linked { color: var(--primary); border-color: var(--border-blue); background: var(--primary-soft); }
.sub-link-extra { display: flex; align-items: center; gap: var(--sp-2); color: var(--primary); padding-left: var(--sp-1); }
.sub-link-extra .sub-add-url { flex: 1; min-width: 150px; }
.sub-add-hour { width: 68px; flex-shrink: 0; }
.sub-add-date { width: 128px; flex-shrink: 0; }
.sub-add-date::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.55; }
/* 工时快捷输入：±0.5 步进 + 1/2/4/8 快捷胶囊 */
.hour-box { display: flex; align-items: center; gap: var(--sp-05); flex-shrink: 0; }
.hour-steps { display: inline-flex; gap: var(--sp-0); }
.hour-btn { width: 22px; height: 26px; padding: 0; display: grid; place-items: center; border: 1px solid var(--border-strong); background: var(--card); color: var(--text-soft); border-radius: var(--r-xs); font-size: var(--fs-md); font-weight: 600; cursor: pointer; transition: all 0.15s; }
.hour-btn:hover { border-color: var(--primary); color: var(--primary); }
.hour-quick { display: inline-flex; gap: 3px; }
.hour-chip { padding: var(--sp-0) 7px; border: 1px solid var(--border-strong); background: var(--card); color: var(--text-dim); border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 600; cursor: pointer; font-family: var(--font-num); transition: all 0.15s; }
.hour-chip:hover { border-color: var(--primary); color: var(--primary-hover); background: var(--primary-soft); }
.sub-logs { display: inline-flex; align-items: center; gap: var(--sp-05); flex-shrink: 0; }
.sub-date { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs); color: var(--warn-deep); background: var(--amber-soft); border: 1px solid var(--warn-border); padding: 1px 7px; border-radius: var(--r-pill); flex-shrink: 0; }
/* 归属日是今天：灰色低调款，非今天才用黄色醒目款 */
.sub-date.today { color: var(--text-weak); background: var(--ghost); border-color: var(--border-strong); }
.sub-row-date { width: 118px; flex-shrink: 0; padding: 2px var(--sp-1); border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-xs); background: var(--card); color: var(--text-soft); outline: none; }
.sub-row-date:focus { border-color: var(--primary); color: var(--text); }
.sub-row-date::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.55; }

/* 待产品确认（需求行计数点见 .stat-dot） */
.q-row { display: flex; align-items: flex-start; gap: 9px; padding: 3px 0; }
.q-row .check.sm { margin-top: var(--sp-0); }
.q-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-05); }
.q-text { font-size: var(--fs-md); color: var(--text); word-break: break-word; }

/* 缺陷跟踪 */
.bug-row { display: flex; align-items: center; gap: 9px; padding: 3px 0; }
.bug-tone { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.bug-tone.done { background: var(--success); }
.bug-tone.active { background: var(--primary); }
.bug-tone.pending { background: var(--warn); }
.bug-tone.unknown { background: var(--muted); }
.bug-tone.err { background: var(--danger); }
.bug-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-0); }
.bug-name { font-size: var(--fs-md); color: var(--text); word-break: break-word; }
.bug-status { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); background: var(--well); border-radius: var(--r-pill); padding: 1px var(--sp-2); }
.bug-status.muted { color: var(--text-dim); }
.bug-err { font-size: var(--fs-xs); color: var(--danger-deep); word-break: break-all; }
.q-row.resolved .q-text { color: var(--muted); text-decoration: line-through; }
.q-answer { padding: 5px 9px; border: 1px solid var(--border-strong); border-radius: var(--r-xs); font-size: var(--fs-sm); outline: none; background: var(--card); color: var(--text); }
.q-answer:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.q-imgs { display: flex; flex-wrap: wrap; gap: var(--sp-1); align-items: center; }
.q-img-cell { position: relative; width: 52px; height: 52px; border-radius: var(--r-xs); overflow: hidden; border: 1px solid var(--border-strong); background: var(--ghost); }
.q-img-cell img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; display: block; }
.q-img-miss { width: 100%; height: 100%; display: grid; place-items: center; color: var(--muted); }
.q-img-del { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border: none; border-radius: 50%; background: rgba(10, 12, 16, 0.55); color: var(--text-invert); display: grid; place-items: center; cursor: pointer; padding: 0; }
.q-img-del:hover { background: var(--danger); }
.q-img-add { display: inline-flex; align-items: center; gap: 3px; padding: 4px var(--sp-2); border: 1px dashed var(--border-strong); border-radius: var(--r-xs); font-size: var(--fs-xs); color: var(--muted); background: none; cursor: pointer; }
.q-img-add:hover { color: var(--primary); border-color: var(--primary); }

.img-preview {
  z-index: var(--z-front);
  background: var(--overlay-strong);
  cursor: zoom-out;
}
.img-preview img { max-width: 100%; max-height: 100%; border-radius: var(--r-sm); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); }

/* 工时记录区已移除（子任务即工时） */
.sync-btn { margin-left: auto; }

/* 文档 & 会议纪要 */
.doc-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); margin: 26px 0 var(--sp-3); }
.doc-head .list-title { margin: 0; }
.doc-list { display: flex; flex-direction: column; }
/* 文档列表平铺：与需求清单同语言 */
.doc-row { display: flex; align-items: center; gap: var(--sp-4); padding: 11px var(--sp-6); border-bottom: 1px solid var(--border); }
.doc-row:last-child { border-bottom: none; }
.doc-type { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); font-weight: 600; color: var(--primary-hover); background: var(--primary-soft); padding: 3px var(--sp-3); border-radius: var(--r-pill); flex-shrink: 0; }
.doc-title { font-size: var(--fs-md); word-break: break-word; }
.doc-title.link { color: var(--primary); cursor: pointer; }
.doc-title.link:hover { text-decoration: underline; }
.doc-note { flex: 1; min-width: 0; font-size: var(--fs-sm); color: var(--muted); word-break: break-word; }
.doc-ops { display: flex; gap: var(--sp-1); margin-left: auto; flex-shrink: 0; }
.doc-empty { padding: 18px; text-align: center; font-size: var(--fs-md); color: var(--muted); background: var(--card); border: 1px dashed var(--border-strong); border-radius: var(--r-md); }

/* 列表工具栏 */
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-6) 28px; flex-wrap: wrap; }
.tb-left { display: flex; align-items: center; gap: var(--sp-6); flex-wrap: wrap; }
.section-title { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
.filters { display: flex; gap: var(--sp-2); }
.chip { display: inline-flex; align-items: center; gap: var(--sp-1); background: var(--card); border: 1px solid var(--border-strong); padding: var(--sp-2) 13px; border-radius: var(--r-sm); font-size: var(--fs-md); font-weight: 600; cursor: pointer; color: var(--text-soft); transition: all 0.15s; }
.chip:hover { border-color: var(--border-strong); }
.chip.active { background: var(--primary-hover); color: var(--text-invert); border-color: var(--primary-hover); }
.chip .count { font-style: normal; background: color-mix(in srgb, var(--text) 8%, transparent); padding: 1px 7px; border-radius: var(--r-pill); font-size: var(--fs-sm); font-weight: 600; }
.chip.active .count { background: rgba(255, 255, 255, 0.22); }
.tb-right { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.search-mini { position: relative; display: flex; align-items: center; }
.search-mini .s-icon { position: absolute; left: 10px; color: var(--muted); pointer-events: none; }
.search-mini input { padding: 7px var(--sp-4) 7px 30px; border: 1px solid transparent; border-radius: var(--r-sm); font-size: var(--fs-md); background: color-mix(in srgb, var(--text-weak) 9%, transparent); color: var(--text); outline: none; width: 180px; transition: background 0.15s, border-color 0.15s; }
.search-mini input:focus { background: var(--card); border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }

/* 汇总条：紧凑可点击，点击即筛选 */
.summary { display: flex; gap: var(--sp-3); padding: 0 28px; flex-wrap: wrap; }
.stat { display: inline-flex; align-items: baseline; gap: var(--sp-2); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); padding: var(--sp-2) var(--sp-6); box-shadow: var(--shadow); cursor: pointer; transition: border-color 0.15s, transform 0.15s; font-family: inherit; }
.stat:hover { transform: translateY(-1px); border-color: var(--accent-soft-text); }
.stat .num { font-size: var(--fs-xl); font-weight: 700; color: var(--primary); line-height: 1.1; }
.stat.pend .num { color: var(--amber); }
.stat.live .num { color: var(--success); }
.stat .lbl { font-size: var(--fs-sm); color: var(--muted); }
.stat.on { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 12%, transparent); }
.stat.pend.on { border-color: var(--amber); box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 12%, transparent); }
.stat.live.on { border-color: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 12%, transparent); }

/* 迭代卡片 */
.it-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
.it-card { position: relative; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 18px; box-shadow: var(--shadow); cursor: pointer; overflow: hidden; opacity: 0; transform: translateY(14px); animation: itIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards; transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s, border-color 0.25s; }
@keyframes itIn { to { opacity: 1; transform: none; } }
.it-grid.no-anim .it-card { animation: none; opacity: 1; transform: none; }
.it-grid.no-anim .it-card:hover { transform: translateY(-3px); }
.it-card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--primary) 40%, var(--card)); box-shadow: 0 16px 40px color-mix(in srgb, var(--primary) 16%, transparent); }
.it-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--sp-3); }
.it-title-line { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-bottom: var(--sp-1); }
.it-title { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
.it-goal { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.it-meta { display: flex; flex-wrap: wrap; gap: var(--sp-1); align-items: center; margin-bottom: var(--sp-4); }
.it-foot { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); }
.it-foot .prog-text { margin: 0; }
.foot-chips { display: inline-flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; justify-content: flex-end; }
.linked-mini { display: inline-flex; align-items: center; gap: var(--sp-05); font-size: var(--fs-xs); color: var(--warn-deep); }
.linked-mini.pkg { color: var(--primary-hover); }

/* 空状态：底座见 globals.css（.empty / .empty-ico），这里只留本页特有的间距 */
.empty-ico { margin-bottom: var(--sp-1); }
.empty h2 { font-size: var(--fs-xl); margin: var(--sp-2) 0 var(--sp-1); font-weight: 700; }
.empty p { color: var(--muted); font-size: var(--fs-base); margin: 0 0 22px; }

/* 弹窗（基础样式已全局统一，见 App.vue） */
.row2 { display: flex; gap: var(--sp-4); }
.row2 .field { flex: 1; }
.row2 .field.grow { flex: 2; }
.field { display: block; margin-bottom: var(--sp-6); }
.field > span { display: block; font-size: var(--fs-md); color: var(--muted); margin-bottom: 7px; font-weight: 600; }
.field > span.field-hd { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
.field input, .field textarea, .select { width: 100%; padding: var(--sp-3) 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; resize: vertical; background: var(--card); color: var(--text); transition: border-color 0.15s, box-shadow 0.15s; }
.field input:focus, .field textarea:focus, .select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.type-picker { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.type-opt { flex: 1; min-width: 72px; display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-1); padding: var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card-soft); cursor: pointer; font-size: var(--fs-md); color: var(--text-soft); }
.type-opt.active { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }
.domain-picker { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.dp-chip { display: inline-flex; align-items: center; gap: 5px; padding: var(--sp-2) 13px; border: 1px solid var(--border-strong); border-radius: var(--r-pill); background: var(--card-soft); cursor: pointer; font-size: var(--fs-md); color: var(--text-soft); transition: all 0.15s; }
.dp-chip:hover { border-color: var(--primary); color: var(--primary-hover); }
.dp-chip.on { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }
.dp-empty { font-size: var(--fs-sm); color: var(--muted); }

@media (prefers-color-scheme: dark) {
  .it-card { background: var(--card); border-color: var(--border-strong); }
  .it-card:hover { border-color: var(--primary); }
  .drag-handle { color: var(--text-soft); }
  .tl-date { color: var(--text-weak); }
  .tl-pkg { background: var(--warn-soft); color: var(--amber-light); }
  .tl-late-tag { background: var(--danger-soft); color: var(--danger-light); }
  .check, .field input, .field textarea, .select, .search-mini input, .icon-btn, .req-add input, .req-edit input, .step-pill { background: var(--card-raised); }
  .req-add { background: var(--card-inset); }
  .hero-icon, .empty-icon { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .ver-chip { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .date-chip { background: var(--well); color: var(--text-weak); }
  .date-chip.far { background: var(--primary-soft); color: var(--primary-light); }
  .date-chip.soon { background: var(--warn-soft); color: var(--amber-light); }
  .date-chip.today { background: var(--success-soft); color: var(--success-light); }
  .date-chip.late { background: var(--danger-soft); color: var(--danger-light); }
  .proj-chip { background: var(--primary-soft); color: var(--primary-light); }
  .step-pill.past { background: var(--accent-soft-deep-hover); border-color: var(--accent-border-deep); }
  .type-opt { background: var(--card-inset); color: var(--text-weak); }
  .type-opt.active { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .dp-chip { background: var(--card-inset); color: var(--text-weak); }
  .dp-chip.on { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .req-detail { background: var(--card-inset); }
  .sub-sec { background: var(--card-raised); border-color: var(--border-strong); }
  .sub-add input { background: var(--card-inset); }
  .sub-row-date { background: var(--card-inset); }
  .sub-code { background: var(--well); border-color: var(--border-blue); }
  .sub-hours { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .sub-done-hours { background: var(--success-soft); color: var(--success-light); }
  .sub-remain-hours { background: var(--warn-soft); color: var(--amber-light); }
  .sub-assignee { background: var(--teal-soft); color: var(--teal-light); }
  .sub-unpushed { background: var(--warn-soft); color: var(--amber-light); }
  .sub-date { background: var(--warn-soft); color: var(--amber-light); border-color: var(--warn-border); }
  .sub-date.today { background: var(--well); color: var(--text-weak); border-color: var(--border-strong); }
  .mini-chip { background: var(--well); color: var(--text-weak); }
  .mini-chip.hrs, .hcount, .doc-type { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .stat-dot.warn { background: var(--warn-soft); color: var(--amber-light); }
  .stat-dot.danger { background: var(--danger-soft); color: var(--danger-light); }
  .sub-title { color: var(--text-weak); }
  .bug-status { background: var(--well); color: var(--text-weak); }
  .doc-empty { background: var(--card-inset); }
}
</style>
