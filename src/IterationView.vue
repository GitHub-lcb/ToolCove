<script setup>
import { ref, computed, onMounted, onUnmounted, watch, inject } from "vue";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon.vue";
import AiExtract from "./AiExtract.vue";
import ReleasePackage from "./ReleasePackage.vue";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { weekday, nextReleaseDate, fmtDate, subLogsByDate, subRemaining, subPushedHours, DOMAIN_COLORS, extractCode, parseIssueUrl, bugStatusInfo, errText } from "./shared.js";
import { askConfirm } from "./confirm.js";
import { useDragSort } from "./dragsort.js";
import { cloneJsonData } from "./jsonData.js";
import { normalizeEstimateDays, requirementActualHours, requirementMetrics } from "./requirementMetrics.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});

// 迭代状态阶段
const STATUS = {
  plan: { label: "规划", icon: "target" },
  dev: { label: "开发", icon: "edit" },
  test: { label: "测试", icon: "check" },
  pending: { label: "待上线", icon: "rocket" },
  live: { label: "已上线", icon: "check" },
};
const STATUS_ORDER = ["plan", "dev", "test", "pending", "live"];

const FILTERS = [
  { key: "active", label: "进行中" },
  { key: "live", label: "已上线" },
  { key: "all", label: "全部" },
];

// 文档 / 会议纪要类型
const DOC_TYPES = {
  prd: { label: "PRD", icon: "note" },
  proto: { label: "原型", icon: "grid" },
  testcase: { label: "测试用例", icon: "check" },
  review: { label: "评审纪要", icon: "note" },
  other: { label: "其他", icon: "folder" },
};

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
    { label: "复制标题 + Coding 链接", icon: "copy", fn: () => copyReqWithLink(it) },
    { label: "切换完成状态", icon: "check", fn: () => toggleReq(it) },
    { label: "编辑需求信息", icon: "edit", fn: () => startEditReq(it) },
    { label: "删除需求", icon: "trash", danger: true, fn: () => removeReq(it) },
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
    domains.value = (await invoke("load_data", { key: "domains" })) || [];
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
    props.showToast("加载迭代失败：" + errText(e));
  }
}
function persist() {
  if (iterationsStale) {
    return Promise.reject(new Error("迭代数据已更新，请重新进入迭代页后再修改"));
  }
  const snapshot = cloneJsonData(iterations.value);
  const job = iterationsSaveQueue.then(async () => {
    await invoke("save_data", { key: "iterations", data: snapshot });
  });
  iterationsSaveQueue = job.catch(() => {});
  return job.catch((e) => {
    iterationsStale = true;
    props.showToast("保存失败：" + errText(e));
    throw e;
  });
}
onMounted(async () => {
  await load();
  tryJump();
  // 入场错峰动画只在首次渲染播放，后续切筛选/切视图不再重复
  setTimeout(() => (introDone.value = true), 900);
});
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
function progress(it) {
  const list = it.items || [];
  const total = list.length;
  const done = list.filter((x) => x.done).length;
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}
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
function overrunSuffix(r) {
  const metrics = reqMetrics(r);
  return metrics.overrun ? `；告警：已超预估 ${metrics.overHours}h` : "";
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
  if (reqFilter.value === "done") return "还没有已完成的需求";
  if (reqFilter.value === "all") return "还没有需求，先新增一个吧";
  return "暂无进行中的需求，在下方新增一个吧";
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
  if (days < 0) return { text: `逾期 ${-days} 天`, cls: "late" };
  if (days === 0) return { text: "今天上线", cls: "today" };
  if (days <= 2) return { text: `还剩 ${days} 天`, cls: "soon" };
  return { text: `还剩 ${days} 天`, cls: "far" };
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
      const label = diff === 0 ? "本周" : diff === 1 ? "下周" : diff === -1 ? "上周" : "";
      g.items.sort((a, b) => (a.releaseDate < b.releaseDate ? -1 : a.releaseDate > b.releaseDate ? 1 : 0));
      return { ...g, label, range: mmdd(fmtDate(g.start)) + " - " + mmdd(fmtDate(end)), isCur: diff === 0, isPast: diff < 0 };
    });
  if (noDate.length) groups.push({ key: "nodate", label: "未排期", range: "", isCur: false, isPast: false, items: noDate });
  return groups;
});

// ------- 新建 / 编辑 -------
function openCreate() {
  form.value = newForm();
  showForm.value = true;
}

// AI 识图字段定义
const AI_FIELDS = [
  { key: "title", label: "迭代名称", desc: "迭代/版本的名称，如“对账中心 7 月迭代”" },
  { key: "version", label: "版本号", desc: "如 v1.2.0，无则留空" },
  { key: "releaseDate", label: "上线日期", desc: "格式 YYYY-MM-DD，无法确定则留空" },
  { key: "goal", label: "迭代目标", desc: "迭代要达成的目标/背景描述", multiline: true },
  { key: "itemsText", label: "需求清单", desc: "需求条目，每行一条", multiline: true },
];
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
const AI_ITEM_FIELDS = [
  { key: "item", label: "需求项", desc: "一条需求/任务的简短描述" },
];
function appendItemsFromAI(list) {
  const rows = Array.isArray(list) ? list : [list];
  const lines = rows.map((r) => (r.item || "").trim()).filter(Boolean);
  if (!lines.length) return props.showToast("没有识别到需求项");
  const cur = (form.value.itemsText || "").trim();
  form.value.itemsText = cur ? cur + "\n" + lines.join("\n") : lines.join("\n");
  props.showToast(`已追加 ${lines.length} 条需求`);
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
  if (!f.title.trim()) return props.showToast("请填写迭代名称");
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
  props.showToast(existing ? "已更新迭代" : "已创建迭代");
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
    props.showToast(url ? "已复制标题 + Coding 链接" : "已复制标题（该需求未填链接）");
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}
async function toggleReq(it) {
  it.done = !it.done;
  if (current.value) current.value.updatedAt = Date.now();
  await persist();
  props.showToast(it.done ? `已标记「${it.name}」为完成（可在「已完成」里查看）` : `已恢复「${it.name}」为进行中`);
}
async function removeReq(it) {
  if (!current.value) return;
  const host = current.value;
  const idx = (host.items || []).findIndex((x) => x.id === it.id);
  if (idx < 0) return;
  host.items.splice(idx, 1);
  host.updatedAt = Date.now();
  await persist();
  props.showToast(`已删除需求「${it.name}」`, {
    actionLabel: "撤销",
    onAction: async () => {
      host.items.splice(Math.min(idx, host.items.length), 0, it);
      host.updatedAt = Date.now();
      await persist();
      props.showToast("已恢复");
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
  if (!name) return props.showToast("需求标题不能为空");
  it.name = name;
  it.url = reqEdit.value.url.trim();
  it.estimateDays = normalizeEstimateDays(reqEdit.value.estimateDays);
  touch();
  cancelEditReq();
  await persist();
  props.showToast("已更新需求" + overrunSuffix(it));
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
  if (reqMetrics(r).overrun) props.showToast(`子任务已添加${overrunSuffix(r)}`);
}
async function toggleSub(s) {
  s.done = !s.done;
  touch();
  await persist();
}
function subLogsTitle(s) {
  const parts = subLogsByDate(s).map((l) => `${l.date} ${l.hours}h`);
  return parts.length ? `工时登记明细：${parts.join("、")}` : "";
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
  if (!name) return props.showToast("子任务名称不能为空");
  s.name = name;
  s.hours = Math.max(0, Number(subEdit.value.hours) || 0);
  s.date = subEdit.value.date || fmtDate(new Date());
  const raw = subEdit.value.url.trim();
  s.url = /^https?:\/\//.test(raw) ? raw : "";
  if (!s.code) s.code = extractCode(raw); // 编辑时补了 Coding 链接，顺带提取编号
  touch();
  await persist();
  cancelEditSub();
  props.showToast("已更新子任务" + overrunSuffix(r));
}
async function removeSub(r, s) {
  const idx = (r.subtasks || []).findIndex((x) => x.id === s.id);
  if (idx < 0) return;
  r.subtasks.splice(idx, 1);
  touch();
  await persist();
  props.showToast(`已删除子任务「${s.name}」`, {
    actionLabel: "撤销",
    onAction: async () => {
      r.subtasks.splice(Math.min(idx, r.subtasks.length), 0, s);
      touch();
      await persist();
      props.showToast("已恢复");
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
  const head = `【待产品确认】${current.value.version ? current.value.version + " " : ""}${current.value.title} / ${r.name}`;
  const lines = list.map((q, i) => `${i + 1}. ${q.text}`);
  return head + "\n" + lines.join("\n");
}
async function copyQuestions(r) {
  const text = buildQuestionText(r);
  if (!text) return props.showToast("该需求没有待确认的问题");
  try {
    await navigator.clipboard.writeText(text);
    props.showToast("已复制待确认清单，可直接发给产品");
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}
async function copyAllQuestions() {
  const blocks = (current.value.items || []).map(buildQuestionText).filter(Boolean);
  if (!blocks.length) return props.showToast("本迭代没有待确认的问题");
  try {
    await navigator.clipboard.writeText(blocks.join("\n\n"));
    props.showToast("已复制本迭代全部待确认");
  } catch (e) {
    props.showToast("复制失败：" + e);
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
  const head = `【缺陷清单】${current.value.version ? current.value.version + " " : ""}${current.value.title} / ${r.name}`;
  const lines = list.map((b, i) => `${i + 1}. #${b.code || b.url}${b.name ? " " + b.name : ""}${b.statusName ? "（" + b.statusName + "）" : ""}`);
  return head + "\n" + lines.join("\n");
}
async function copyBugs(r) {
  const text = buildBugText(r);
  if (!text) return props.showToast("该需求没有未关闭的 bug");
  try {
    await navigator.clipboard.writeText(text);
    props.showToast("已复制缺陷清单");
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}
async function copyAllBugs() {
  const blocks = (current.value.items || []).map(buildBugText).filter(Boolean);
  if (!blocks.length) return props.showToast("本迭代没有未关闭的 bug");
  try {
    await navigator.clipboard.writeText(blocks.join("\n\n"));
    props.showToast("已复制本迭代全部未关闭 bug");
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}
const currentOpenBugs = computed(() => (current.value?.items || []).reduce((s, r) => s + openBugs(r), 0));

// ------- 待确认问题截图附件（复用 ProblemView 的 save_image 机制：图片单独落盘，JSON 只存元数据） -------
const qImgCache = ref({}); // name -> dataURL
const qPreviewSrc = ref("");

function qMimeOf(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
}
// 展开需求时懒加载其下所有问题的截图
async function loadQImages(r) {
  for (const q of r.questions || []) {
    for (const img of q.images || []) {
      if (qImgCache.value[img.name] !== undefined) continue;
      try {
        const b64 = await invoke("load_image", { name: img.name });
        qImgCache.value[img.name] = `data:${qMimeOf(img.name)};base64,${b64}`;
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
    props.showToast(`已添加 ${files.length} 张截图`);
  } catch (err) {
    props.showToast("保存截图失败：" + err);
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
    if (!added) return props.showToast("剪贴板里没有图片");
    touch();
    await persist();
    props.showToast(`已粘贴 ${added} 张截图`);
  } catch (err) {
    props.showToast("读取剪贴板失败：" + err);
  }
}
async function removeQImage(q, img) {
  const idx = (q.images || []).findIndex((x) => x.id === img.id);
  q.images = (q.images || []).filter((x) => x.id !== img.id);
  touch();
  await persist();
  props.showToast("已删除截图", {
    actionLabel: "撤销",
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
  if (!f.title.trim()) return props.showToast("请填写文档标题");
  if (!Array.isArray(current.value.docs)) current.value.docs = [];
  const existing = f.id ? current.value.docs.find((d) => d.id === f.id) : null;
  if (existing) Object.assign(existing, { type: f.type, title: f.title.trim(), url: f.url.trim(), note: f.note.trim() });
  else current.value.docs.push({ id: crypto.randomUUID(), type: f.type, title: f.title.trim(), url: f.url.trim(), note: f.note.trim() });
  touch();
  await persist();
  showDocForm.value = false;
  props.showToast(existing ? "已更新文档" : "已添加文档");
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
    props.showToast("打开失败：" + e);
  }
}
async function removeIteration(r) {
  const ok = await askConfirm({ title: "删除迭代", message: `迭代「${r.title}」及其需求、子任务将被删除，5 秒内可撤销。`, okText: "删除" });
  if (!ok) return;
  const idx = iterations.value.findIndex((x) => x.id === r.id);
  iterations.value = iterations.value.filter((x) => x.id !== r.id);
  if (currentId.value === r.id) currentId.value = null;
  await persist();
  props.showToast("已删除迭代", {
    actionLabel: "撤销",
    onAction: async () => {
      iterations.value.splice(Math.min(Math.max(idx, 0), iterations.value.length), 0, r);
      await persist();
      props.showToast("已恢复");
    },
  });
}

</script>

<template>
  <!-- ============ 迭代详情 ============ -->
  <template v-if="current">
    <div class="detail-bar">
      <button class="back-btn" @click="exit"><Icon name="chevron" :size="16" class="rot90" /> 返回迭代列表</button>
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
          <span class="st-chip" :class="'st-' + current.status">{{ STATUS[current.status].label }}</span>
        </div>
        <p v-if="current.goal" class="hero-goal">{{ current.goal }}</p>
        <div class="bar"><i :style="{ width: progress(current).pct + '%' }"></i></div>
        <p class="prog-text">需求完成 {{ progress(current).done }} / {{ progress(current).total }} 项 · 累计工时 {{ iterHours(current) }}h</p>
      </div>
      <div class="hero-ops">
        <button class="btn-outline" @click="openEdit(current)"><Icon name="edit" :size="15" /> 编辑</button>
        <button class="btn-outline danger" @click="removeIteration(current)"><Icon name="trash" :size="15" /> 删除</button>
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
        <Icon :name="STATUS[s].icon" :size="14" /> {{ STATUS[s].label }}
      </button>
    </div>

    <main class="content">
      <h3 class="list-title"><Icon name="note" :size="16" /> 需求清单 <em class="hcount">累计 {{ iterHours(current) }}h</em>
        <button v-if="currentOpenQ" class="btn-ghost xs" style="margin-left: auto;" title="复制本迭代全部待确认，发给产品" @click="copyAllQuestions">
          <Icon name="copy" :size="13" /> 复制全部待确认 {{ currentOpenQ }}
        </button>
        <button v-if="currentOpenBugs" class="btn-ghost xs" title="复制本迭代全部未关闭 bug" @click="copyAllBugs">
          <Icon name="copy" :size="13" /> 复制全部未关闭 {{ currentOpenBugs }}
        </button>
      </h3>
      <div class="req-filter">
        <button class="chip xs" :class="{ active: reqFilter === 'active' }" :title="'只看进行中的需求'" @click="reqFilter = 'active'">进行中<em class="count">{{ reqCounts.active }}</em></button>
        <button class="chip xs" :class="{ active: reqFilter === 'done' }" :title="'只看已标记完成的需求'" @click="reqFilter = 'done'">已完成<em class="count">{{ reqCounts.done }}</em></button>
        <button class="chip xs" :class="{ active: reqFilter === 'all' }" :title="'显示全部需求'" @click="reqFilter = 'all'">全部<em class="count">{{ reqCounts.all }}</em></button>
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
              title="拖拽排序"
              draggable="true"
              @dragstart="reqDrag.onDragStart($event, it.id)"
              @dragend="reqDrag.onDragEnd()"
            ><Icon name="sort" :size="13" /></span>
            <button class="check" :class="{ on: it.done }" @click="toggleReq(it)">
              <Icon v-if="it.done" name="check" :size="14" />
            </button>
            <div v-if="reqEdit.id === it.id" class="req-main req-edit" @click.stop>
              <input v-model="reqEdit.name" class="req-edit-name" placeholder="需求标题" @keyup.enter="saveEditReq(it)" @keyup.esc="cancelEditReq" />
              <input v-model="reqEdit.estimateDays" class="req-edit-days" type="number" min="0.5" step="0.5" placeholder="预估人天" title="预估人天；留空时按实际人天判断需求规模" @keyup.enter="saveEditReq(it)" @keyup.esc="cancelEditReq" />
              <input v-model="reqEdit.url" class="req-edit-url" placeholder="Coding 需求链接（可选）" @keyup.enter="saveEditReq(it)" @keyup.esc="cancelEditReq" />
              <button class="btn-ghost sm" @click="saveEditReq(it)"><Icon name="check" :size="14" /> 保存</button>
              <button class="icon-btn" title="取消" @click="cancelEditReq"><Icon name="x" :size="14" /></button>
            </div>
            <div v-else class="req-main" @click="toggleExpand(it)">
              <span class="req-name" :title="it.name">{{ it.name }}</span>
              <span class="req-sub">
                <span class="req-status" :class="{ on: it.done }" :title="it.done ? '已完成（本地状态），点击恢复为进行中' : '进行中（本地状态），点击标记完成'" @click.stop="toggleReq(it)">
                  <Icon :name="it.done ? 'check' : 'clock'" :size="11" /> {{ it.done ? "已完成" : "进行中" }}
                </span>
                <span class="req-size" :class="reqMetrics(it).size.key" :title="reqMetrics(it).sizeSource === 'actual' ? '未填写预估人天，当前按实际人天判断规模' : '按预估人天判断规模'">
                  {{ reqMetrics(it).size.label }}<template v-if="reqMetrics(it).sizeSource === 'actual'">（实际）</template>
                </span>
                <span v-if="reqMetrics(it).estimateDays != null" class="mini-chip estimate" title="需求预估人天">预估 {{ reqMetrics(it).estimateDays }}天</span>
                <span v-if="(it.subtasks || []).length" class="mini-chip">子任务 {{ (it.subtasks || []).filter((s) => s.done).length }}/{{ (it.subtasks || []).length }}</span>
                <span v-if="reqHours(it)" class="mini-chip hrs" title="子任务累计实际工时">实际 {{ reqMetrics(it).actualDays }}天 · {{ reqHours(it) }}h</span>
                <span v-if="(it.subtasks || []).length" class="mini-chip completed" :title="'已完成子任务合计 ' + reqMetrics(it).completedHours + 'h'">已完成 {{ reqMetrics(it).completedDays }}天</span>
                <span v-if="reqMetrics(it).overrun" class="req-overrun" :title="'实际 ' + reqMetrics(it).actualHours + 'h，已超过预估 ' + reqMetrics(it).estimateHours + 'h'">
                  <Icon name="alert" :size="11" /> 超预估 {{ reqMetrics(it).overHours }}h
                </span>
                <span v-if="openQ(it)" class="stat-dot warn" :title="openQ(it) + ' 个待产品确认'">{{ openQ(it) }}</span>
                <span v-if="openBugs(it)" class="stat-dot danger" :title="openBugs(it) + ' 个未关闭 bug'">{{ openBugs(it) }}</span>
              </span>
            </div>
            <button v-if="reqEdit.id !== it.id" class="icon-btn" title="编辑标题、预估人天和链接" @click="startEditReq(it)"><Icon name="edit" :size="14" /></button>
            <button class="icon-btn" title="复制标题 + Coding 链接" @click="copyReqWithLink(it)"><Icon name="copy" :size="14" /></button>
            <button v-if="it.url" class="icon-btn" title="打开 Coding 需求" @click="openLink(it.url)"><Icon name="link" :size="15" /></button>
            <button class="icon-btn" :title="expanded[it.id] ? '收起' : '展开子任务'" @click="toggleExpand(it)">
              <Icon name="chevron" :size="15" :class="{ rot180: expanded[it.id] }" />
            </button>
            <button class="icon-btn" title="删除" @click="removeReq(it)"><Icon name="x" :size="14" /></button>
          </div>

          <div v-if="expanded[it.id]" class="req-detail">
            <div class="sub-sec">
              <div class="sub-title">
                <Icon name="check" :size="13" /> 子任务 <em v-if="(it.subtasks || []).length">{{ (it.subtasks || []).filter((s) => s.done).length }}/{{ (it.subtasks || []).length }}</em>
                <span v-if="reqMetrics(it).overrun" class="req-overrun" :title="'预估 ' + reqMetrics(it).estimateHours + 'h，实际 ' + reqMetrics(it).actualHours + 'h'">
                  <Icon name="alert" :size="11" /> 已超预估 {{ reqMetrics(it).overHours }}h
                </span>
                <span class="today-hours" :class="{ ok: todaySubHours(it) >= hoursTarget }" :title="'今日已填 ' + todaySubHours(it) + 'h / 目标 ' + hoursTarget + 'h（口径与工时统计一致）'">
                  <Icon name="clock" :size="12" /> 今日 {{ todaySubHours(it) }}h / {{ hoursTarget }}h
                </span>
              </div>
              <div v-if="(it.subtasks || []).length" class="sub-filter">
                <div class="sub-filter-chips">
                  <button class="chip xs" :class="{ active: !subFilterPerson[it.id] }" title="显示全部子任务" @click="subFilterPerson[it.id] = ''">全部<em class="count">{{ (it.subtasks || []).length }}</em></button>
                  <button v-for="p in subAssigneeOptions(it)" :key="p" class="chip xs" :class="{ active: subFilterPerson[it.id] === p }" :title="'只看 ' + p + ' 的子任务'" @click="subFilterPerson[it.id] = subFilterPerson[it.id] === p ? '' : p">{{ p }}<em class="count">{{ (it.subtasks || []).filter((s) => s.assignee === p).length }}</em></button>
                  <button v-if="(it.subtasks || []).some((s) => !s.assignee)" class="chip xs" :class="{ active: subFilterPerson[it.id] === '@un' }" title="只看未分配处理人的子任务（本地未推送）" @click="subFilterPerson[it.id] = subFilterPerson[it.id] === '@un' ? '' : '@un'">未分配<em class="count">{{ (it.subtasks || []).filter((s) => !s.assignee).length }}</em></button>
                </div>
                <div class="sub-filter-date">
                  <input v-model="subFilterDate[it.id]" type="date" class="sub-filter-input" title="按工时归属日筛选（空 = 全部）" />
                  <button class="chip xs" :class="{ active: subFilterDate[it.id] === fmtDate(new Date()) }" title="只看今天的子任务，再点恢复全部" @click="toggleSubToday(it)">今天</button>
                </div>
              </div>
              <template v-for="s in filteredSubs(it)" :key="s.id">
                <div v-if="subEdit.id !== s.id" class="sub-row" :class="{ done: s.done }">
                  <button class="check sm" :class="{ on: s.done }" @click="toggleSub(s)"><Icon v-if="s.done" name="check" :size="12" /></button>
                  <span class="sub-name" @click="toggleSub(s)">{{ s.name }}</span>
                  <span v-if="s.assignee" class="sub-assignee" title="处理人"><Icon name="briefcase" :size="11" /> {{ s.assignee }}</span>
                  <span v-if="s.hours && !subPushedHours(s)" class="sub-hours" title="总工时">{{ s.hours }}h</span>
                  <span v-if="subPushedHours(s) > 0" class="sub-done-hours" title="已登记的工时明细">{{ subPushedHours(s) }}h 已完成</span>
                  <span v-if="subLogsByDate(s).length" class="sub-logs" :title="subLogsTitle(s)">
                    <span v-for="l in subLogsByDate(s)" :key="l.date" class="sub-date" :class="{ today: l.date === fmtDate(new Date()) }"><Icon name="calendar" :size="11" /> {{ l.date.slice(5) }} {{ l.hours }}h</span>
                  </span>
                  <span v-else-if="s.date" class="sub-date" :class="{ today: s.date === fmtDate(new Date()) }" title="工时归属日"><Icon name="calendar" :size="11" /> {{ s.date.slice(5) }}</span>
                  <input v-model="s.date" type="date" class="sub-row-date" title="工时归属日：可改成明天或更晚，登记工时按此日期" @change="saveSubDate" />
                  <a v-if="s.url" class="sub-code link" @click.stop="openLink(s.url)" :title="s.url">
                    <Icon name="link" :size="11" /> 链接
                  </a>
                  <button class="icon-btn xs" title="编辑名称/工时/归属日/链接" @click="startEditSub(s)"><Icon name="edit" :size="13" /></button>
                  <button class="icon-btn xs" title="删除" @click="removeSub(it, s)"><Icon name="x" :size="13" /></button>
                </div>
                <div v-else class="sub-row sub-editing">
                  <button class="check sm" :class="{ on: s.done }" disabled title="编辑中，保存或取消后恢复操作"><Icon v-if="s.done" name="check" :size="12" /></button>
                  <input v-model="subEdit.name" class="sub-edit-name" placeholder="子任务名称" @keyup.enter="saveEditSub(it, s)" @keyup.esc="cancelEditSub" />
                  <input v-model="subEdit.hours" type="number" class="sub-edit-hours" min="0" step="0.5" placeholder="工时h" title="总工时" @keyup.enter="saveEditSub(it, s)" @keyup.esc="cancelEditSub" />
                  <input v-model="subEdit.date" type="date" class="sub-row-date" title="工时归属日" @keyup.enter="saveEditSub(it, s)" @keyup.esc="cancelEditSub" />
                  <input v-model="subEdit.url" class="sub-edit-url" placeholder="Coding 链接（可选）" @keyup.enter="saveEditSub(it, s)" @keyup.esc="cancelEditSub" />
                  <button class="btn-ghost xs" @click="saveEditSub(it, s)"><Icon name="check" :size="11" /> 保存</button>
                  <button class="btn-ghost xs" @click="cancelEditSub">取消</button>
                </div>
              </template>
              <div v-if="(it.subtasks || []).length && !filteredSubs(it).length" class="sub-empty">无符合条件的子任务</div>
              <div class="sub-add task-sub-add">
                <div class="sub-add-main">
                  <input v-model="subInput[it.id]" class="sub-add-name" placeholder="子任务名称" @focus="prefillSub(it)" @keyup.enter="addSub(it)" />
                  <button
                    v-if="!subLinkOpen[it.id]"
                    type="button"
                    class="btn-ghost xs sub-link-toggle"
                    :class="{ linked: subUrlInput[it.id] }"
                    :title="subUrlInput[it.id] ? '已填写链接或编号，点击查看' : '可选：填写链接或编号作出处记录'"
                    :aria-expanded="false"
                    :aria-controls="`sub-link-${it.id}`"
                    @click="subLinkOpen[it.id] = true"
                  >
                    <Icon name="link" :size="12" /> {{ subUrlInput[it.id] ? "已填链接" : "填链接" }}
                  </button>
                  <div class="hour-box">
                    <input v-model="subHourInput[it.id]" class="sub-add-hour" type="number" min="0" step="0.5" placeholder="工时h" title="↑/↓ 快速步进 0.5" @keydown="onHourKey(it, $event)" @keyup.enter="addSub(it)" />
                    <span class="hour-steps">
                      <button type="button" class="hour-btn" title="工时 -0.5" @click="stepHour(it, -0.5)">−</button>
                      <button type="button" class="hour-btn" title="工时 +0.5" @click="stepHour(it, 0.5)">+</button>
                    </span>
                    <span class="hour-quick">
                      <button v-for="h in [1, 2, 4, 8]" :key="h" type="button" class="hour-chip" :title="'填入 ' + h + 'h'" @click="subHourInput[it.id] = h">{{ h }}h</button>
                    </span>
                  </div>
                  <input v-model="subDateInput[it.id]" type="date" class="sub-add-date" title="工时归属日：默认今天，可选明天或更晚，工时会落到所选日期" @keyup.enter="addSub(it)" />
                  <button class="btn-ghost sm" @click="addSub(it)"><Icon name="plus" :size="14" /> 添加</button>
                </div>
                <div v-if="subLinkOpen[it.id]" :id="`sub-link-${it.id}`" class="sub-link-extra">
                  <Icon name="link" :size="13" />
                  <input v-model="subUrlInput[it.id]" class="sub-add-url" placeholder="粘贴链接或输入编号（可选）" autofocus @keyup.enter="addSub(it)" />
                  <button type="button" class="icon-btn xs" title="收起链接" aria-label="收起链接" @click="subLinkOpen[it.id] = false"><Icon name="chevron" :size="12" :class="{ rot180: true }" /></button>
                </div>
              </div>
            </div>
            <div class="sub-sec">
              <div class="sub-title">
                <Icon name="alert" :size="13" /> 待产品确认 <em v-if="openQ(it)">{{ openQ(it) }} 待确认</em>
                <button v-if="openQ(it)" class="btn-ghost xs sync-btn" title="复制待确认清单，发给产品" @click="copyQuestions(it)">
                  <Icon name="copy" :size="12" /> 复制发产品
                </button>
              </div>
              <div v-for="q in it.questions || []" :key="q.id" class="q-row" :class="{ resolved: q.status === 'resolved' }">
                <button class="check sm" :class="{ on: q.status === 'resolved' }" :title="q.status === 'resolved' ? '标记为待确认' : '标记已确认'" @click="toggleQuestion(q)"><Icon v-if="q.status === 'resolved'" name="check" :size="12" /></button>
                <div class="q-main">
                  <span class="q-text">{{ q.text }}</span>
                  <input v-model="q.answer" class="q-answer" placeholder="产品答复（可选）" @change="persist" />
                  <div class="q-imgs">
                    <div v-for="img in q.images || []" :key="img.id" class="q-img-cell">
                      <img v-if="qImgCache[img.name]" :src="qImgCache[img.name]" title="点击放大" @click="qPreviewSrc = qImgCache[img.name]" />
                      <span v-else class="q-img-miss"><Icon name="image" :size="14" /></span>
                      <button class="q-img-del" title="删除截图" @click="removeQImage(q, img)"><Icon name="x" :size="10" /></button>
                    </div>
                    <label class="q-img-add" title="上传截图，方便后续查看">
                      <Icon name="plus" :size="12" /> 选图
                      <input type="file" accept="image/*" multiple hidden @change="onPickQImages(q, $event)" />
                    </label>
                    <button class="q-img-add" title="粘贴剪贴板截图" @click="pasteQImages(q)"><Icon name="copy" :size="11" /> 粘贴</button>
                  </div>
                </div>
                <button class="icon-btn xs" title="删除" @click="removeQuestion(it, q)"><Icon name="x" :size="13" /></button>
              </div>
              <div class="sub-add">
                <input v-model="qInput[it.id]" class="sub-add-name" placeholder="要产品确认的问题" @keyup.enter="addQuestion(it)" />
                <button class="btn-ghost sm" @click="addQuestion(it)"><Icon name="plus" :size="14" /> 添加问题</button>
              </div>
            </div>
            <div class="sub-sec">
              <div class="sub-title">
                <Icon name="alert" :size="13" /> 缺陷跟踪 <em v-if="openBugs(it)">{{ openBugs(it) }} 未关闭</em>
                <button v-if="openBugs(it)" class="btn-ghost xs" title="复制缺陷清单，发给相关人" @click="copyBugs(it)">
                  <Icon name="copy" :size="12" /> 复制缺陷
                </button>
              </div>
              <div v-for="b in it.bugs || []" :key="b.id" class="bug-row">
                <span class="bug-tone" :class="bugToneClass(b)"></span>
                <div class="bug-main">
                  <span class="bug-name" :title="b.url">{{ b.code ? "#" + b.code + " " : "" }}{{ b.name || "未命名" }}</span>
                </div>
                <span class="bug-status" :class="{ muted: !b.done }">{{ b.done ? "已关闭" : "进行中" }}</span>
                <button v-if="b.url" class="icon-btn xs" title="打开链接" @click="openLink(b.url)"><Icon name="link" :size="13" /></button>
                <button class="icon-btn xs" title="删除" @click="removeBug(it, b)"><Icon name="x" :size="13" /></button>
              </div>
              <div class="sub-add">
                <input v-model="bugInput[it.id]" class="sub-add-name" placeholder="bug 名称或链接，回车添加" @keyup.enter="addBug(it)" />
                <button class="btn-ghost sm" @click="addBug(it)"><Icon name="plus" :size="14" /> 添加 bug</button>
              </div>
            </div>
          </div>
        </div>

        <div class="req-add">
          <div class="req-add-link">
            <Icon name="link" :size="13" />
            <input v-model="addUrl" class="req-add-url" placeholder="链接（可选，仅记录）" @keyup.enter="addReq" />
          </div>
          <div class="req-add-title">
            <input v-model="addName" class="req-add-name" placeholder="需求标题" @keyup.enter="addReq" />
          </div>
          <input v-model="addEstimateDays" class="req-add-days" type="number" min="0.5" step="0.5" placeholder="预估人天" title="可选；留空时按实际人天判断需求规模" @keyup.enter="addReq" />
          <button class="btn-ghost sm" @click="addReq"><Icon name="plus" :size="15" /> 添加需求</button>
        </div>
      </div>

      <div class="doc-head">
        <h3 class="list-title"><Icon name="folder" :size="16" /> 文档 & 会议纪要</h3>
        <button class="btn-ghost sm" @click="openDocCreate"><Icon name="plus" :size="14" /> 添加文档</button>
      </div>
      <div v-if="(current.docs || []).length" class="doc-list">
        <div v-for="d in current.docs" :key="d.id" class="doc-row">
          <span class="doc-type"><Icon :name="DOC_TYPES[d.type]?.icon || 'note'" :size="14" /> {{ DOC_TYPES[d.type]?.label || "其他" }}</span>
          <span class="doc-title" :class="{ link: d.url }" @click="openLink(d.url)">{{ d.title }}</span>
          <span v-if="d.note" class="doc-note">{{ d.note }}</span>
          <span class="doc-ops">
            <button v-if="d.url" class="icon-btn" title="打开" @click="openLink(d.url)"><Icon name="open" :size="14" /></button>
            <button class="icon-btn" title="编辑" @click="openDocEdit(d)"><Icon name="edit" :size="14" /></button>
            <button class="icon-btn" title="删除" @click="removeDoc(d)"><Icon name="x" :size="13" /></button>
          </span>
        </div>
      </div>
      <p v-else class="doc-empty">还没有文档。把 PRD、原型、测试用例、评审纪要的链接挂在这里。</p>

      <ReleasePackage :iteration="current" :persist="persist" :show-toast="showToast" />
    </main>
  </template>

  <!-- ============ 迭代列表 ============ -->
  <template v-else>
    <div class="toolbar">
      <div class="tb-left">
        <h3 class="section-title">个人迭代</h3>
        <div class="filters">
          <button v-for="f in FILTERS" :key="f.key" class="chip" :class="{ active: filter === f.key }" @click="filter = f.key">
            {{ f.label }}<em class="count">{{ counts[f.key] }}</em>
          </button>
        </div>
        <div class="search-mini">
          <Icon name="search" :size="15" class="s-icon" />
          <input v-model="search" placeholder="搜索迭代 / 版本 / 项目..." />
        </div>
      </div>
      <div class="tb-right">
        <div class="view-toggle">
          <button class="vt-btn" :class="{ on: viewMode === 'card' }" title="卡片视图" @click="viewMode = 'card'"><Icon name="grid" :size="14" /></button>
          <button class="vt-btn" :class="{ on: viewMode === 'timeline' }" title="时间轴视图（按上线周）" @click="viewMode = 'timeline'"><Icon name="clock" :size="14" /></button>
        </div>
        <button class="btn-primary sm" @click="openCreate"><Icon name="plus" :size="15" /> 新建迭代</button>
                <AiExtract :fields="AI_FIELDS" hint="这是一张需求文档/迭代规划/Coding 截图，请提取迭代名称、版本、上线日期、目标与需求清单（每行一条）。" title="AI 识图录入迭代" :show-toast="showToast" @apply="openCreateFromAI" />
      </div>
    </div>

    <div class="summary">
      <button class="stat" :class="{ on: filter === 'active' }" @click="filter = 'active'"><span class="num">{{ counts.active }}</span><span class="lbl">进行中迭代</span></button>
      <button class="stat pend" :class="{ on: filter === 'pending' }" @click="filter = 'pending'"><span class="num">{{ pendingCount }}</span><span class="lbl">待上线</span></button>
      <button class="stat live" :class="{ on: filter === 'live' }" @click="filter = 'live'"><span class="num">{{ counts.live }}</span><span class="lbl">已上线</span></button>
    </div>

    <main class="content">
      <!-- 时间轴视图 -->
      <div v-if="filteredList.length && viewMode === 'timeline'" class="tl">
        <div v-for="g in timelineGroups" :key="g.key" class="tl-group" :class="{ cur: g.isCur, past: g.isPast }">
          <div class="tl-week">
            <span class="tl-dot"></span>
            <span class="tl-week-name">{{ g.label || "周 " + g.range.slice(0, 5) }}</span>
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
                <Icon :name="STATUS[r.status].icon" :size="11" /> {{ STATUS[r.status].label }}
              </span>
              <span class="tl-title" :title="(r.version ? r.version + ' ' : '') + r.title">
                <em v-if="r.version" class="ver-chip">{{ r.version }}</em>
                {{ r.title }}
                <i v-if="isLate(r)" class="tl-late-tag">逾期</i>
              </span>
              <span class="tl-right">
                <span class="prog-text" :class="barClass(r)">{{ progress(r).done }}/{{ progress(r).total }}</span>
                <span class="tl-minibar" :class="barClass(r)"><i :style="{ width: progress(r).pct + '%' }"></i></span>
                <span v-if="pkgInfo(r).has || r.releaseId" class="tl-pkg" :title="r.releaseId ? '已关联发布单' : '已建上线包'"><Icon name="rocket" :size="12" /></span>
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
              <Icon :name="STATUS[r.status].icon" :size="12" /> {{ STATUS[r.status].label }}
            </span>
            <button class="icon-btn" title="删除" @click.stop="removeIteration(r)"><Icon name="trash" :size="15" /></button>
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
            <span class="prog-text" :class="barClass(r)">需求 {{ progress(r).done }} / {{ progress(r).total }}<template v-if="progress(r).total"> · {{ progress(r).pct }}%</template></span>
            <span class="foot-chips">
              <template v-if="pkgInfo(r).has || r.releaseId">
                <span v-if="r.releaseId" class="linked-mini"><Icon name="rocket" :size="12" /> 发布单</span>
                <span v-else class="linked-mini pkg"><Icon name="rocket" :size="12" /> 已建上线包</span>
              </template>
              <span v-if="pkgInfo(r).pools || pkgInfo(r).scripts" class="mini-chip" title="上线包规模">{{ pkgInfo(r).pools }} Pool<template v-if="pkgInfo(r).scripts"> · {{ pkgInfo(r).scripts }} 脚本</template></span>
              <span v-if="iterHours(r)" class="mini-chip hrs" title="累计工时">{{ iterHours(r) }}h</span>
            </span>
          </div>
        </div>
      </div>
      <div v-else class="empty">
          <span class="empty-ico"><Icon name="repeat" :size="32" /></span>
        <h2>还没有迭代</h2>
        <p>把每个版本迭代记在这里：列需求清单、推进状态，到点一键生成发布单去上线。</p>
        <button class="btn-outline lg" @click="openCreate"><Icon name="plus" :size="16" /> 新建第一个迭代</button>
      </div>
    </main>
  </template>

  <!-- ============ 新建 / 编辑弹窗 ============ -->
  <div v-if="showForm" class="modal-mask">
    <div class="modal">
      <h2>{{ form.id ? "编辑迭代" : "新建迭代" }}</h2>

      <div class="row2">
        <label class="field grow">
          <span>迭代名称</span>
          <input v-model="form.title" placeholder="例如：对账中心 7 月迭代" />
        </label>
        <label class="field">
          <span>版本号（可选）</span>
          <input v-model="form.version" placeholder="例如：v2.3.0" />
        </label>
      </div>

      <div class="row2">
        <label class="field">
          <span>关联领域（可多选，本次一起上线）</span>
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
            <span v-if="!domains.length" class="dp-empty">还没有领域，请先到「领域」模块创建</span>
          </div>
        </label>
        <label class="field">
          <span>计划上线日期</span>
          <input v-model="form.releaseDate" type="date" />
        </label>
      </div>

      <label class="field">
        <span>当前状态</span>
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
        <span>迭代目标（可选）</span>
        <textarea v-model="form.goal" rows="2" placeholder="这个迭代要交付什么"></textarea>
      </label>

      <label v-if="!form.id" class="field">
        <span class="field-hd">
          初始需求清单（每行一条，可选）
          <AiExtract :fields="AI_ITEM_FIELDS" :multiple="true" button-label="AI 识图加需求" dedupe-key="item" :existing="(form.itemsText || '').split('\n').map((s) => s.trim()).filter(Boolean)" hint="这是一张需求列表/任务看板截图，请把每一条需求提取为一条记录。" title="AI 识图添加需求" :show-toast="showToast" @apply="appendItemsFromAI" />
        </span>
        <textarea v-model="form.itemsText" rows="4" placeholder="被动对账接口&#10;导出报表优化&#10;修复金额精度问题"></textarea>
      </label>

      <div class="modal-foot">
        <button class="btn-ghost" @click="showForm = false">取消</button>
        <button class="btn-primary" @click="saveForm">保存</button>
      </div>
    </div>
  </div>

  <!-- ============ 文档 / 会议纪要弹窗 ============ -->
  <div v-if="showDocForm" class="modal-mask">
    <div class="modal">
      <h2>{{ docForm.id ? "编辑文档" : "添加文档 / 会议纪要" }}</h2>

      <label class="field">
        <span>类型</span>
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
        <span>标题</span>
        <input v-model="docForm.title" placeholder="例如：对账中心 PRD 评审纪要" @keyup.enter="saveDoc" />
      </label>

      <label class="field">
        <span>链接 / 本地路径（可选）</span>
        <input v-model="docForm.url" placeholder="http:// 或本地文件路径" @keyup.enter="saveDoc" />
      </label>

      <label class="field">
        <span>备注（可选）</span>
        <textarea v-model="docForm.note" rows="2" placeholder="简要说明"></textarea>
      </label>

      <div class="modal-foot">
        <button class="btn-ghost" @click="showDocForm = false">取消</button>
        <button class="btn-primary" @click="saveDoc">保存</button>
      </div>
    </div>
  </div>

  <!-- 待确认问题截图放大预览 -->
  <div v-if="qPreviewSrc" class="img-preview" @click="qPreviewSrc = ''">
    <img :src="qPreviewSrc" />
  </div>
</template>

<style scoped>
.detail-bar { padding: 14px 28px 0; }
.back-btn { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; color: var(--muted); font-size: var(--fs-base); cursor: pointer; padding: 4px 0; }
.back-btn:hover { color: var(--primary); }
.rot90 { transform: rotate(90deg); }

/* hero */
.hero { display: flex; gap: 16px; align-items: flex-start; margin: 12px 28px 0; padding: 20px 22px; background: var(--card); border: 1px solid var(--card-border); border-left: 4px solid var(--primary); border-radius: var(--r-lg); box-shadow: var(--shadow); }
.hero-icon { width: 46px; height: 46px; flex-shrink: 0; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary); display: grid; place-items: center; }
.hero-main { flex: 1; min-width: 0; }
.hero-title-line { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.hero-title-line h2 { margin: 0; font-size: var(--fs-xl); }
.hero-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.hero-goal { margin: 0 0 12px; font-size: var(--fs-md); color: var(--text-weak); line-height: var(--lh-body); }
.hero-ops { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }

.ver-chip { font-size: var(--fs-sm); font-weight: 700; color: var(--accent-hover); background: var(--accent-soft); padding: 2px 10px; border-radius: var(--r-pill); font-family: var(--font-num); } /* 版本号胶囊：DESIGN §2.3 强制规范指定用法 */
.date-chip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--text-soft); background: var(--well); padding: 3px 10px; border-radius: var(--r-pill); white-space: nowrap; }
/* 时间胶囊（日期 + 倒计时合并）：颜色跟随倒计时状态 */
.date-chip.far { color: var(--primary); background: var(--primary-soft); }
.date-chip.soon { color: var(--warn-deep); background: var(--warn-soft); }
.date-chip.today { color: var(--success-deep); background: var(--success-soft); }
.date-chip.late { color: var(--danger-deep); background: var(--danger-soft); }
.proj-chip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--primary); background: var(--primary-soft); padding: 3px 10px; border-radius: var(--r-pill); }
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
.tl-group { position: relative; padding: 0 0 18px 22px; border-left: 2px solid var(--border); margin-left: 8px; }
.tl-group:last-child { padding-bottom: 4px; }
.tl-group.past { opacity: 0.72; }
.tl-week { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.tl-dot { position: absolute; left: -7px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: var(--card); border: 3px solid var(--border-steel); }
.tl-group.cur { border-left-color: var(--primary); }
.tl-group.cur .tl-dot { border-color: var(--primary); box-shadow: 0 0 0 4px var(--primary-soft); }
.tl-week-name { font-size: var(--fs-base); font-weight: 700; color: var(--text); }
.tl-group.cur .tl-week-name { color: var(--primary); }
.tl-week-range { font-size: var(--fs-sm); color: var(--muted); }
.tl-count { font-style: normal; font-size: var(--fs-xs); font-weight: 700; color: var(--muted); background: var(--well); padding: 1px 8px; border-radius: var(--r-pill); }
.tl-items { display: flex; flex-direction: column; gap: 8px; }
.tl-item { display: flex; align-items: center; gap: 10px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); padding: 10px 14px; cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s; }
.tl-item:hover { border-color: var(--primary); box-shadow: 0 6px 18px color-mix(in srgb, var(--primary) 12%, transparent); transform: translateX(2px); }
.tl-date { flex-shrink: 0; width: 86px; font-size: var(--fs-sm); font-weight: 600; color: var(--text-soft); font-variant-numeric: tabular-nums; }
.tl-date.late { color: var(--danger-deep); }
.tl-title { flex: 1; min-width: 0; font-size: var(--fs-base); font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tl-title .ver-chip { font-style: normal; flex-shrink: 0; }
.tl-late-tag { font-style: normal; flex-shrink: 0; font-size: var(--fs-xs); font-weight: 700; color: var(--danger-deep); background: var(--danger-soft); padding: 1px 8px; border-radius: var(--r-pill); }
.tl-right { flex-shrink: 0; display: flex; align-items: center; gap: 10px; }
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
.prog-text { margin: 8px 0 0; font-size: var(--fs-md); color: var(--muted); }
.prog-text.full { color: var(--success-deep); font-weight: 600; }
.prog-text.low { color: var(--warn-deep); }

/* 状态阶段条 */
.stepper { display: flex; gap: 8px; padding: 16px 28px 0; flex-wrap: wrap; }
.step-pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border-strong); background: var(--card); color: var(--text-dim); padding: 8px 14px; border-radius: var(--r-pill); font-size: var(--fs-md); font-weight: 600; cursor: pointer; transition: all 0.15s; }
.step-pill:hover { border-color: var(--primary); color: var(--primary-hover); }
.step-pill.past { color: var(--primary-hover); border-color: var(--border-blue); background: var(--primary-soft); }
.step-pill.on { color: var(--text-invert); background: var(--primary-hover); border-color: var(--primary-hover); }

/* 操作行 */
.action-row { display: flex; align-items: center; gap: 12px; padding: 16px 28px 0; flex-wrap: wrap; }
.linked-tip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-md); color: var(--success); }

/* 需求清单 */
.content { flex: 1; padding: 16px 28px 36px; }
.list-title { display: flex; align-items: center; gap: 7px; margin: 0 0 10px; font-size: var(--fs-base); font-weight: 700; }
/* 需求状态筛选：进行中（默认）/ 已完成 / 全部 */
.req-filter { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 10px; }
.req-empty { padding: 20px 16px; font-size: var(--fs-md); color: var(--text-dim); text-align: center; }
.req-list { display: flex; flex-direction: column; }
/* 列表平铺：主列表不设容器（背景层），行分隔线分组，与独立卡片形成层级对比 */
.req-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); transition: background 0.15s, box-shadow 0.15s; }
.req-row:last-child { border-bottom: none; }
.req-row:hover { background: color-mix(in srgb, var(--primary) 5%, transparent); box-shadow: inset 2px 0 0 var(--primary); }
.req-row.overrun { background: color-mix(in srgb, var(--danger) 5%, transparent); box-shadow: inset 2px 0 0 var(--danger); }
.req-row.done .req-name { color: var(--muted); text-decoration: line-through; }
.check { width: 22px; height: 22px; flex-shrink: 0; padding: 0; border: 1.5px solid var(--border-strong); border-radius: var(--r-xs); background: var(--card); cursor: pointer; display: grid; place-items: center; color: var(--text-invert); }
.check.on { background: var(--primary); border-color: var(--primary); }
.req-name { flex: 1; min-width: 0; font-size: var(--fs-md); cursor: pointer; word-break: break-word; }
.req-add { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--card-soft); flex-wrap: wrap; }
.req-add input { flex: 1; padding: 9px 12px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-md); outline: none; background: var(--card); color: var(--text); }
.req-add input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
/* 链接是主输入：前置图标 + 识别中提示 */
.req-add-link { display: flex; align-items: center; gap: 7px; flex: 3; min-width: 220px; color: var(--muted); }
.req-add-link input { flex: 1; min-width: 0; }
.req-add-loading { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--muted); flex-shrink: 0; }
/* 标题框：自动带出时绿色勾 + 浅绿底，提示可直接修改 */
.req-add-title { display: flex; align-items: center; gap: 6px; flex: 2; min-width: 160px; color: var(--success-deep); }
.req-add-title input { flex: 1; min-width: 0; }
.req-add-title.auto input { border-color: var(--success-border); background: var(--success-tint); }
.req-add-title.auto input:focus { border-color: var(--success); box-shadow: 0 0 0 3px var(--success-soft); }
.req-add .req-add-days { flex: 0 0 112px; min-width: 112px; }
@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 0.9s linear infinite; }

/* 需求块（可展开） */
.req-block { border-bottom: 1px solid var(--border); }
.req-block:last-of-type { border-bottom: none; }
.req-block .req-row { border-bottom: none; }
.req-block.dragging { opacity: 0.45; }
.req-block.drag-over { box-shadow: inset 0 2px 0 var(--primary); }
.drag-handle { flex-shrink: 0; display: grid; place-items: center; width: 20px; height: 22px; color: var(--border-steel); cursor: grab; border-radius: var(--r-xs); }
.drag-handle:hover { color: var(--primary); background: var(--primary-soft); }
.drag-handle:active { cursor: grabbing; }
.req-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; cursor: pointer; }
/* 需求行内编辑态：标题 + 链接双输入框 */
.req-edit { flex-direction: row; align-items: center; gap: 8px; cursor: default; }
.req-edit input { padding: 7px 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-md); outline: none; background: var(--card); color: var(--text); }
.req-edit input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.req-edit-name { flex: 2; min-width: 0; }
.req-edit .req-edit-days { flex: 0 0 104px; min-width: 104px; }
.req-edit-url { flex: 3; min-width: 0; }
.req-sub { display: flex; gap: 6px; flex-wrap: wrap; }
/* 需求状态标签（本地状态）：进行中紫 / 已完成绿，点击切换 */
.req-status { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs); font-weight: 600; padding: 1px 8px; border-radius: var(--r-pill); cursor: pointer; user-select: none; transition: box-shadow 0.15s, transform 0.1s; }
.req-status:not(.on) { color: var(--primary-hover); background: var(--primary-soft); }
.req-status.on { color: var(--success-deep); background: var(--success-soft); }
/* 可点击反馈：hover 描边提示、按压下沉（对齐全局按钮语言） */
.req-status:not(.on):hover { box-shadow: inset 0 0 0 1px var(--border-blue); }
.req-status.on:hover { box-shadow: inset 0 0 0 1px var(--success-border); }
.req-status:active { transform: translateY(1px); }
.mini-chip { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs); color: var(--text-dim); background: var(--well); padding: 1px 8px; border-radius: var(--r-pill); }
.mini-chip.hrs { color: var(--primary-hover); background: var(--primary-soft); font-weight: 600; }
.mini-chip.estimate { color: var(--primary-hover); background: var(--primary-soft); font-weight: 600; }
.mini-chip.completed { color: var(--success-deep); background: var(--success-soft); font-weight: 600; }
.req-size, .req-overrun { display: inline-flex; align-items: center; gap: 3px; padding: 1px 8px; border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 600; }
.req-size.small { color: var(--teal-deep); background: var(--teal-soft); }
.req-size.medium { color: var(--warn-deep); background: var(--warn-soft); }
.req-size.large, .req-overrun { color: var(--danger-deep); background: var(--danger-soft); }
.req-size.unestimated { color: var(--text-dim); background: var(--well); }
/* 需求行计数点：待确认（琥珀）/ 未关闭 bug（红），数字胶囊替代长标签 */
.stat-dot { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 700; font-style: normal; }
.stat-dot.warn { color: var(--warn-deep); background: var(--warn-soft); }
.stat-dot.danger { color: var(--danger-deep); background: var(--danger-soft); }
.hcount { font-style: normal; font-size: var(--fs-sm); color: var(--primary-hover); background: var(--primary-soft); padding: 2px 9px; border-radius: var(--r-pill); font-weight: 600; margin-left: auto; }
.rot180 { transform: rotate(180deg); transition: transform 0.15s; }

/* 需求详情：子任务 + 工时 */
.req-detail { padding: 4px 16px 14px 50px; display: flex; flex-direction: column; gap: 16px; background: var(--card-soft); border-top: 1px dashed var(--border); }
.sub-sec { display: flex; flex-direction: column; gap: 7px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); padding: 12px 14px; }
.sub-title { font-size: var(--fs-sm); font-weight: 700; color: var(--text-soft); display: flex; align-items: center; gap: 6px; }
.sub-title em { font-style: normal; font-weight: 600; color: var(--primary-hover); }
/* 今日工时完成度徽标：未达标琥珀、达标绿色 */
.today-hours { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); font-weight: 600; color: var(--warn-deep); background: var(--warn-soft); border-radius: var(--r-pill); padding: 1px 8px; }
.today-hours.ok { color: var(--success-deep); background: var(--success-soft); }
/* 子任务筛选条：人名 chips + 归属日 */
.sub-filter { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.sub-filter-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.sub-filter-date { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.sub-filter-input { width: 122px; padding: 2px 6px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-xs); background: var(--card); color: var(--text); outline: none; }
.sub-filter-input:focus { border-color: var(--primary); }
.sub-filter-input::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.55; }
.chip.xs { padding: 3px 9px; font-size: var(--fs-xs); border-radius: var(--r-sm); }
.chip.xs .count { font-size: var(--fs-xs); padding: 0 6px; }
.sub-empty { font-size: var(--fs-xs); color: var(--muted); padding: 2px 0 4px; }
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
.sub-code { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); background: var(--ghost); border: 1px solid var(--border-strong); border-radius: var(--r-xs); padding: 2px 7px; font-family: var(--font-mono); }
.sub-hours { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 700; color: var(--primary-hover); background: var(--primary-soft); border-radius: var(--r-xs); padding: 2px 7px; }
/* 分次推送进度徽标：已完成（绿）/ 剩余（琥珀） */
.sub-done-hours { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 700; color: var(--success-deep); background: var(--success-soft); border-radius: var(--r-xs); padding: 2px 7px; }
.sub-remain-hours { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 700; color: var(--warn-deep); background: var(--warn-soft); border-radius: var(--r-xs); padding: 2px 7px; }
.sub-assignee { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; font-size: var(--fs-xs); color: var(--teal-deep); background: var(--teal-soft); border-radius: var(--r-xs); padding: 2px 7px; }
.sub-unpushed { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--warn-deep); background: var(--warn-soft); border-radius: var(--r-pill); padding: 1px 7px; }
.sub-code.link { color: var(--primary); background: var(--primary-soft); border-color: var(--border-blue); cursor: pointer; }
.sub-code.link:hover { background: var(--primary-soft-hover); }
.sub-add { display: flex; gap: 8px; margin-top: 3px; flex-wrap: wrap; }
.sub-add input { padding: 7px 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-sm); outline: none; background: var(--card); color: var(--text); }
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
.hour-box { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.hour-steps { display: inline-flex; gap: 2px; }
.hour-btn { width: 22px; height: 26px; padding: 0; display: grid; place-items: center; border: 1px solid var(--border-strong); background: var(--card); color: var(--text-soft); border-radius: var(--r-xs); font-size: var(--fs-md); font-weight: 600; cursor: pointer; transition: all 0.15s; }
.hour-btn:hover { border-color: var(--primary); color: var(--primary); }
.hour-quick { display: inline-flex; gap: 3px; }
.hour-chip { padding: 2px 7px; border: 1px solid var(--border-strong); background: var(--card); color: var(--text-dim); border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 600; cursor: pointer; font-family: var(--font-num); transition: all 0.15s; }
.hour-chip:hover { border-color: var(--primary); color: var(--primary-hover); background: var(--primary-soft); }
.sub-logs { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
.sub-date { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs); color: var(--warn-deep); background: var(--amber-soft); border: 1px solid var(--warn-border); padding: 1px 7px; border-radius: var(--r-pill); flex-shrink: 0; }
/* 归属日是今天：灰色低调款，非今天才用黄色醒目款 */
.sub-date.today { color: var(--text-weak); background: var(--ghost); border-color: var(--border-strong); }
.sub-row-date { width: 118px; flex-shrink: 0; padding: 2px 6px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-xs); background: var(--card); color: var(--text-soft); outline: none; }
.sub-row-date:focus { border-color: var(--primary); color: var(--text); }
.sub-row-date::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.55; }

/* 待产品确认（需求行计数点见 .stat-dot） */
.q-row { display: flex; align-items: flex-start; gap: 9px; padding: 3px 0; }
.q-row .check.sm { margin-top: 2px; }
.q-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.q-text { font-size: var(--fs-md); color: var(--text); word-break: break-word; }

/* 缺陷跟踪 */
.bug-row { display: flex; align-items: center; gap: 9px; padding: 3px 0; }
.bug-tone { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.bug-tone.done { background: var(--success); }
.bug-tone.active { background: var(--primary); }
.bug-tone.pending { background: var(--warn); }
.bug-tone.unknown { background: var(--muted); }
.bug-tone.err { background: var(--danger); }
.bug-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.bug-name { font-size: var(--fs-md); color: var(--text); word-break: break-word; }
.bug-status { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); background: var(--well); border-radius: var(--r-pill); padding: 1px 8px; }
.bug-status.muted { color: var(--text-dim); }
.bug-err { font-size: var(--fs-xs); color: var(--danger-deep); word-break: break-all; }
.q-row.resolved .q-text { color: var(--muted); text-decoration: line-through; }
.q-answer { padding: 5px 9px; border: 1px solid var(--border-strong); border-radius: var(--r-xs); font-size: var(--fs-sm); outline: none; background: var(--card); color: var(--text); }
.q-answer:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.q-imgs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.q-img-cell { position: relative; width: 52px; height: 52px; border-radius: var(--r-xs); overflow: hidden; border: 1px solid var(--border-strong); background: var(--ghost); }
.q-img-cell img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; display: block; }
.q-img-miss { width: 100%; height: 100%; display: grid; place-items: center; color: var(--muted); }
.q-img-del { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border: none; border-radius: 50%; background: rgba(10, 12, 16, 0.55); color: var(--text-invert); display: grid; place-items: center; cursor: pointer; padding: 0; }
.q-img-del:hover { background: var(--danger); }
.q-img-add { display: inline-flex; align-items: center; gap: 3px; padding: 4px 8px; border: 1px dashed var(--border-strong); border-radius: var(--r-xs); font-size: var(--fs-xs); color: var(--muted); background: none; cursor: pointer; }
.q-img-add:hover { color: var(--primary); border-color: var(--primary); }

.img-preview { position: fixed; inset: 0; z-index: 200; background: rgba(10, 12, 16, 0.82); display: grid; place-items: center; cursor: zoom-out; padding: 32px; }
.img-preview img { max-width: 100%; max-height: 100%; border-radius: var(--r-sm); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); }

/* 工时记录区已移除（子任务即工时） */
.sync-btn { margin-left: auto; }

/* 文档 & 会议纪要 */
.doc-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 26px 0 10px; }
.doc-head .list-title { margin: 0; }
.doc-list { display: flex; flex-direction: column; }
/* 文档列表平铺：与需求清单同语言 */
.doc-row { display: flex; align-items: center; gap: 12px; padding: 11px 16px; border-bottom: 1px solid var(--border); }
.doc-row:last-child { border-bottom: none; }
.doc-type { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); font-weight: 600; color: var(--primary-hover); background: var(--primary-soft); padding: 3px 10px; border-radius: var(--r-pill); flex-shrink: 0; }
.doc-title { font-size: var(--fs-md); word-break: break-word; }
.doc-title.link { color: var(--primary); cursor: pointer; }
.doc-title.link:hover { text-decoration: underline; }
.doc-note { flex: 1; min-width: 0; font-size: var(--fs-sm); color: var(--muted); word-break: break-word; }
.doc-ops { display: flex; gap: 6px; margin-left: auto; flex-shrink: 0; }
.doc-empty { padding: 18px; text-align: center; font-size: var(--fs-md); color: var(--muted); background: var(--card); border: 1px dashed var(--border-strong); border-radius: var(--r-md); }

/* 列表工具栏 */
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 28px; flex-wrap: wrap; }
.tb-left { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.section-title { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
.filters { display: flex; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 6px; background: var(--card); border: 1px solid var(--border-strong); padding: 8px 13px; border-radius: var(--r-sm); font-size: var(--fs-md); font-weight: 600; cursor: pointer; color: var(--text-soft); transition: all 0.15s; }
.chip:hover { border-color: var(--border-steel); }
.chip.active { background: var(--primary-hover); color: var(--text-invert); border-color: var(--primary-hover); }
.chip .count { font-style: normal; background: color-mix(in srgb, var(--text) 8%, transparent); padding: 1px 7px; border-radius: var(--r-pill); font-size: var(--fs-sm); font-weight: 600; }
.chip.active .count { background: rgba(255, 255, 255, 0.22); }
.tb-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.search-mini { position: relative; display: flex; align-items: center; }
.search-mini .s-icon { position: absolute; left: 10px; color: var(--muted); pointer-events: none; }
.search-mini input { padding: 7px 12px 7px 30px; border: 1px solid transparent; border-radius: var(--r-sm); font-size: var(--fs-md); background: color-mix(in srgb, var(--text-weak) 9%, transparent); color: var(--text); outline: none; width: 180px; transition: background 0.15s, border-color 0.15s; }
.search-mini input:focus { background: var(--card); border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }

/* 汇总条：紧凑可点击，点击即筛选 */
.summary { display: flex; gap: 10px; padding: 0 28px; flex-wrap: wrap; }
.stat { display: inline-flex; align-items: baseline; gap: 8px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); padding: 8px 16px; box-shadow: var(--shadow); cursor: pointer; transition: border-color 0.15s, transform 0.15s; font-family: inherit; }
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
.it-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.it-title-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.it-title { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
.it-goal { margin: 0 0 10px; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.it-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 12px; }
.it-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; }
.it-foot .prog-text { margin: 0; }
.foot-chips { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.linked-mini { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--warn-deep); }
.linked-mini.pkg { color: var(--primary-hover); }

/* 空状态 */
.empty { text-align: center; padding: 56px 20px; }
.empty-ico { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 50%; background: var(--primary-soft); color: var(--primary); margin-bottom: 6px; }
.empty h2 { font-size: var(--fs-xl); margin: 8px 0 6px; font-weight: 700; }
.empty p { color: var(--muted); font-size: var(--fs-base); margin: 0 0 22px; }

/* 弹窗（基础样式已全局统一，见 App.vue） */
.row2 { display: flex; gap: 12px; }
.row2 .field { flex: 1; }
.row2 .field.grow { flex: 2; }
.field { display: block; margin-bottom: 16px; }
.field > span { display: block; font-size: var(--fs-md); color: var(--muted); margin-bottom: 7px; font-weight: 600; }
.field > span.field-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.field input, .field textarea, .select { width: 100%; padding: 10px 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; resize: vertical; background: var(--card); color: var(--text); transition: border-color 0.15s, box-shadow 0.15s; }
.field input:focus, .field textarea:focus, .select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.type-picker { display: flex; gap: 8px; flex-wrap: wrap; }
.type-opt { flex: 1; min-width: 72px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card-soft); cursor: pointer; font-size: var(--fs-md); color: var(--text-soft); }
.type-opt.active { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }
.domain-picker { display: flex; gap: 8px; flex-wrap: wrap; }
.dp-chip { display: inline-flex; align-items: center; gap: 5px; padding: 8px 13px; border: 1px solid var(--border-strong); border-radius: var(--r-pill); background: var(--card-soft); cursor: pointer; font-size: var(--fs-md); color: var(--text-soft); transition: all 0.15s; }
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
