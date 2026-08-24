<script setup>
import { ref, computed, onMounted, onUnmounted, watch, inject } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon.vue";
import AiExtract from "./AiExtract.vue";
import { fmtDate, renderMarkdown, errText } from "./shared.js";
import { askConfirm } from "./confirm.js";
import { aiComplete } from "./ai.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});

const { t } = useI18n();

// 问题类型（label 走 i18n，computed 保证语言切换后重新求值）
const TYPE_META = {
  online: { icon: "alert", cls: "tc-danger" },
  meeting: { icon: "note", cls: "tc-primary" },
  temp: { icon: "clock", cls: "tc-amber" },
  other: { icon: "folder", cls: "tc-neutral" },
};
const TYPES = computed(() => ({
  online: { label: t("problem.typeOnline"), ...TYPE_META.online },
  meeting: { label: t("problem.typeMeeting"), ...TYPE_META.meeting },
  temp: { label: t("problem.typeTemp"), ...TYPE_META.temp },
  other: { label: t("problem.typeOther"), ...TYPE_META.other },
}));
const FILTERS = computed(() => [
  { key: "open", label: t("problem.filterOpen") },
  { key: "done", label: t("problem.filterDone") },
  { key: "all", label: t("problem.filterAll") },
]);

const problems = ref([]);
const search = ref("");
const filter = ref("open");
const showForm = ref(false);
const form = ref(newForm());
const expanded = ref({});
const logInput = ref({});

function newForm() {
  return { id: "", title: "", type: "online", status: "open", note: "", tags: [] };
}
function round(n) {
  return Math.round(n * 100) / 100;
}

// ------- 加载 / 保存 -------
async function load() {
  try {
    const data = (await invoke("load_data", { key: "problems" })) || [];
    data.forEach((p) => {
      if (!Array.isArray(p.logs)) p.logs = [];
      if (!Array.isArray(p.images)) p.images = [];
      if (!Array.isArray(p.tags)) p.tags = [];
      if (typeof p.resolution !== "string") p.resolution = "";
    });
    problems.value = data;
  } catch (e) {
    props.showToast(t("problem.loadFailed", { err: errText(e) }));
  }
}
async function persist() {
  try {
    await invoke("save_data", { key: "problems", data: problems.value });
  } catch (e) {
    props.showToast(t("problem.saveFailed", { err: errText(e) }));
  }
}
onMounted(async () => {
  await load();
  tryJump();
});

// ------- 全局搜索深链 -------
function tryJump() {
  const j = props.jumpId;
  if (!j || !j.id) return;
  const p = problems.value.find((x) => x.id === j.id);
  if (!p) return;
  filter.value = "all";
  search.value = "";
  expanded.value[p.id] = true;
  lastExpandedId.value = p.id;
  loadImages(p);
}
watch(() => props.jumpId, tryJump);

// ------- 工具 -------
// 全部已用标签（去重、按使用次数降序），供详情点选与表单联想
const allTags = computed(() => {
  const m = new Map();
  for (const p of problems.value) for (const t of p.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
});
function probHours(p) {
  return round((p.logs || []).reduce((s, l) => s + (Number(l.hours) || 0), 0));
}
function touch(p) {
  p.updatedAt = Date.now();
}

// ------- 派生 -------
const current = computed(() => problems.value.find((p) => p.id === currentId.value) || null);
const currentId = ref(null);
const counts = computed(() => ({
  open: problems.value.filter((p) => p.status === "open").length,
  done: problems.value.filter((p) => p.status === "done").length,
  all: problems.value.length,
}));
const totalHours = computed(() => round(problems.value.reduce((s, p) => s + probHours(p), 0)));
const filteredList = computed(() => {
  const kw = search.value.trim().toLowerCase();
  return [...problems.value]
    .filter((p) => (filter.value === "all" ? true : p.status === filter.value))
    .filter(
      (p) =>
        !kw ||
        p.title.toLowerCase().includes(kw) ||
        (p.note || "").toLowerCase().includes(kw) ||
        (p.resolution || "").toLowerCase().includes(kw) ||
        (p.tags || []).join(" ").toLowerCase().includes(kw)
    )
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
});

// ------- 新建 / 编辑 -------
function openCreate() {
  form.value = newForm();
  tagInput.value = "";
  showForm.value = true;
}

// AI 识图字段定义（computed：语言切换后重新求值）
const AI_FIELDS = computed(() => [
  { key: "title", label: t("problem.aiFieldTitle"), desc: t("problem.aiFieldTitleDesc") },
  { key: "type", label: t("problem.aiFieldType"), desc: t("problem.aiFieldTypeDesc"), enum: ["online", "meeting", "temp", "other"] },
  { key: "note", label: t("problem.aiFieldNote"), desc: t("problem.aiFieldNoteDesc"), multiline: true },
]);
// 识图结果→批量新建
async function createProblemsFromAI(list) {
  const rows = Array.isArray(list) ? list : [list];
  const now = Date.now();
  const types = ["online", "meeting", "temp", "other"];
  let added = 0;
  // 倒序 unshift 以保持图中原顺序
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const title = (r.title || "").trim();
    if (!title) continue;
    problems.value.unshift({
      id: crypto.randomUUID(),
      title,
      type: types.includes(r.type) ? r.type : "online",
      status: "open",
      tags: [],
      note: (r.note || "").trim(),
      logs: [],
      createdAt: now,
      updatedAt: now,
    });
    added++;
  }
  await persist();
  props.showToast(added ? t("problem.aiAdded", { count: added }) : t("problem.aiNothing"));
}
function openEdit(p) {
  form.value = { id: p.id, title: p.title, type: p.type, status: p.status, note: p.note || "", tags: [...(p.tags || [])] };
  tagInput.value = "";
  showForm.value = true;
}
async function saveForm() {
  const f = form.value;
  if (!f.title.trim()) return props.showToast(t("problem.titleRequired"));
  const now = Date.now();
  const existing = f.id ? problems.value.find((p) => p.id === f.id) : null;
  if (existing) {
    Object.assign(existing, { title: f.title.trim(), type: f.type, status: f.status, note: f.note.trim(), tags: [...f.tags], updatedAt: now });
  } else {
    problems.value.unshift({
      id: crypto.randomUUID(),
      title: f.title.trim(),
      type: f.type,
      status: f.status,
      note: f.note.trim(),
      tags: [...f.tags],
      logs: [],
      createdAt: now,
      updatedAt: now,
    });
  }
  await persist();
  showForm.value = false;
  props.showToast(existing ? t("problem.updated") : t("problem.added"));
}
// 表单标签编辑：输入框逗号/空格分隔批量添加 + 已有标签点选
const tagInput = ref("");
function applyTagInput() {
  // 支持中文逗号分隔（\uff0c 为「，」的 unicode 转义，源码保持纯 ASCII）
  const arr = tagInput.value.split(/[,\uff0c\s]+/).map((s) => s.trim()).filter(Boolean);
  for (const t of arr) if (!form.value.tags.includes(t)) form.value.tags.push(t);
  tagInput.value = "";
}
function toggleFormTag(t) {
  const i = form.value.tags.indexOf(t);
  if (i >= 0) form.value.tags.splice(i, 1);
  else form.value.tags.push(t);
}
async function toggleStatus(p) {
  p.status = p.status === "done" ? "open" : "done";
  if (p.status === "done") {
    p.resolvedAt = Date.now();
    if (!(p.resolution || "").trim()) {
      expanded.value[p.id] = true;
      lastExpandedId.value = p.id;
      loadImages(p);
      props.showToast(t("problem.resolvedHint"));
    }
  } else {
    p.resolvedAt = null;
  }
  touch(p);
  await persist();
}
async function removeProblem(p) {
  const ok = await askConfirm({
    title: t("problem.deleteTitle"),
    message: t("problem.deleteMsg", { title: p.title }),
    okText: t("problem.deleteOk"),
  });
  if (!ok) return;
  const idx = problems.value.findIndex((x) => x.id === p.id);
  problems.value = problems.value.filter((x) => x.id !== p.id);
  await persist();
  props.showToast(t("problem.deleted"), {
    actionLabel: t("problem.undo"),
    onAction: async () => {
      problems.value.splice(Math.min(Math.max(idx, 0), problems.value.length), 0, p);
      await persist();
      props.showToast(t("problem.restored"));
    },
    // 撤销窗口结束后才真正清理图片文件
    onExpire: async () => {
      for (const img of p.images || []) {
        try {
          await invoke("delete_image", { name: img.name });
        } catch (e) {}
      }
    },
  });
}
function toggleExpand(p) {
  expanded.value[p.id] = !expanded.value[p.id];
  if (expanded.value[p.id]) {
    lastExpandedId.value = p.id;
    loadImages(p);
  }
}

// ------- 多选批量（勾选 + 批量删除，撤销可恢复） -------
const batchMode = ref(false);
const checkedIds = ref(new Set());
function enterBatch() {
  batchMode.value = true;
  checkedIds.value = new Set();
}
function exitBatch() {
  batchMode.value = false;
  checkedIds.value = new Set();
}
function toggleCheck(p) {
  const s = new Set(checkedIds.value);
  if (s.has(p.id)) s.delete(p.id);
  else s.add(p.id);
  checkedIds.value = s;
}
const checkedList = computed(() => problems.value.filter((p) => checkedIds.value.has(p.id)));
const allChecked = computed(() => filteredList.value.length > 0 && filteredList.value.every((p) => checkedIds.value.has(p.id)));
function toggleAll() {
  const s = new Set(checkedIds.value);
  if (allChecked.value) filteredList.value.forEach((p) => s.delete(p.id));
  else filteredList.value.forEach((p) => s.add(p.id));
  checkedIds.value = s;
}
async function removeChecked() {
  const list = checkedList.value;
  if (!list.length) return;
  const ok = await askConfirm({
    title: t("problem.batchDeleteTitle"),
    message: t("problem.batchDeleteMsg", { count: list.length }),
    okText: t("problem.deleteOk"),
  });
  if (!ok) return;
  const ids = new Set(list.map((p) => p.id));
  const removed = problems.value.filter((p) => ids.has(p.id));
  const idx = problems.value.findIndex((p) => ids.has(p.id));
  problems.value = problems.value.filter((p) => !ids.has(p.id));
  await persist();
  exitBatch();
  props.showToast(t("problem.batchDeleted", { count: removed.length }), {
    actionLabel: t("problem.undo"),
    onAction: async () => {
      problems.value.splice(Math.min(Math.max(idx, 0), problems.value.length), 0, ...removed);
      await persist();
      props.showToast(t("problem.restored"));
    },
    onExpire: async () => {
      for (const p of removed) {
        for (const img of p.images || []) {
          try {
            await invoke("delete_image", { name: img.name });
          } catch (e) {}
        }
      }
    },
  });
}

// ------- 全局右键菜单（App.vue provide）：问题行快捷操作 -------
const openCtxMenu = inject("openCtxMenu");
async function copyProblemTitle(p) {
  try {
    await navigator.clipboard.writeText(p.title);
    props.showToast(t("problem.copiedTitle", { title: p.title }));
  } catch (e) {
    props.showToast(t("problem.copyFailed", { err: e }));
  }
}
function onProbCtx(e, p) {
  openCtxMenu(e, [
    { label: t("problem.ctxCopyTitle"), icon: "copy", fn: () => copyProblemTitle(p) },
    { label: p.status === "done" ? t("problem.ctxReopen") : t("problem.ctxResolve"), icon: "check", fn: () => toggleStatus(p) },
    { label: t("problem.ctxLogHours"), icon: "clock", fn: () => toggleExpand(p) },
    { label: t("problem.ctxEdit"), icon: "edit", fn: () => openEdit(p) },
    { label: t("problem.ctxDelete"), icon: "trash", danger: true, fn: () => removeProblem(p) },
  ]);
}

// ------- 工时记录 -------
function ensureLog(p) {
  if (!logInput.value[p.id]) logInput.value[p.id] = { date: fmtDate(new Date()), hours: 1, note: "" };
  return logInput.value[p.id];
}
async function addLog(p) {
  const f = ensureLog(p);
  const h = Number(f.hours) || 0;
  if (!f.date || h <= 0) return props.showToast(t("problem.logInvalid"));
  if (!Array.isArray(p.logs)) p.logs = [];
  p.logs.push({ id: crypto.randomUUID(), date: f.date, hours: round(h), note: (f.note || "").trim() });
  logInput.value[p.id] = { date: f.date, hours: 1, note: "" };
  touch(p);
  await persist();
}
async function removeLog(p, l) {
  const idx = (p.logs || []).findIndex((x) => x.id === l.id);
  p.logs = (p.logs || []).filter((x) => x.id !== l.id);
  touch(p);
  await persist();
  props.showToast(t("problem.logDeleted"), {
    actionLabel: t("problem.undo"),
    onAction: async () => {
      p.logs.splice(Math.min(Math.max(idx, 0), p.logs.length), 0, l);
      touch(p);
      await persist();
    },
  });
}

// ------- 结论 / 截图附件 -------
// 摘要行的结论/备注只显示一行，悬停给短预览；全文展开条目后在「结论/解决方案」里看
function notePreview(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > 160 ? s.slice(0, 160) + t("problem.noteExpandHint") : s;
}
const imgCache = ref({}); // name -> dataURL
const previewSrc = ref("");
const lastExpandedId = ref(null); // 最近展开的问题：Ctrl+V 贴图的目标

// 全局粘贴：剪贴板有图且有展开的问题时，直接作为附件录入
function onWinPaste(e) {
  const imgs = Array.from(e.clipboardData?.items || []).filter((it) => it.type.startsWith("image/"));
  if (!imgs.length) return;
  const pid = lastExpandedId.value;
  const p = pid && expanded.value[pid] ? problems.value.find((x) => x.id === pid) : null;
  if (!p) return;
  e.preventDefault();
  (async () => {
    try {
      let added = 0;
      for (const it of imgs) {
        const blob = it.getAsFile();
        if (!blob) continue;
        await addImageBlob(p, blob, it.type);
        added++;
      }
      if (added) {
        touch(p);
        await persist();
        props.showToast(t("problem.pastedImages", { count: added }));
      }
    } catch (err) {
      props.showToast(t("problem.saveImageFailed", { err }));
    }
  })();
}
onMounted(() => window.addEventListener("paste", onWinPaste));
onUnmounted(() => window.removeEventListener("paste", onWinPaste));

async function saveResolution(p) {
  touch(p);
  await persist();
}

// 详情内直接勾选/取消标签，自动保存
const newTagInput = ref("");
function toggleProbTag(p, t) {
  if (!Array.isArray(p.tags)) p.tags = [];
  const i = p.tags.indexOf(t);
  if (i >= 0) p.tags.splice(i, 1);
  else p.tags.push(t);
  touch(p);
  persist();
}
function addProbTag(p) {
  const t = newTagInput.value.trim();
  newTagInput.value = "";
  if (!t || (p.tags || []).includes(t)) return;
  if (!Array.isArray(p.tags)) p.tags = [];
  p.tags.push(t);
  touch(p);
  persist();
}

// ------- AI 分析 -------
const analyzing = ref({}); // pid -> true 时分析中
const runIds = {}; // pid -> 本次分析的 run token：丢弃过期结果

function buildAnalysisPrompt(p) {
  const lines = [];
  lines.push(t("prompt.problemAnalysisIntro"));
  lines.push("");
  lines.push(t("prompt.problemAnalysisTitle", { text: p.title }));
  lines.push(t("prompt.problemAnalysisType", { text: (TYPES.value[p.type] || {}).label || p.type }));
  if ((p.note || "").trim()) lines.push(t("prompt.problemAnalysisNote", { text: p.note.trim() }));
  if ((p.resolution || "").trim()) lines.push(t("prompt.problemAnalysisResolution", { text: p.resolution.trim() }));
  if ((p.tags || []).length) lines.push(t("prompt.problemAnalysisTags", { text: p.tags.join(t("prompt.problemAnalysisTagSep")) }));
  lines.push("");
  lines.push(t("prompt.problemAnalysisAsk"));
  return lines.join("\n");
}
async function analyzeProblem(p) {
  if (analyzing.value[p.id]) return;
  const runId = crypto.randomUUID();
  runIds[p.id] = runId;
  analyzing.value[p.id] = true;
  try {
    const text = await aiComplete(buildAnalysisPrompt(p));
    if (runIds[p.id] !== runId) return; // 已被中断，丢弃过期结果
    p.aiAnalysis = { at: Date.now(), text: (text || "").trim() };
    touch(p);
    await persist();
    props.showToast(t("problem.analysisDone"));
  } catch (e) {
    if (runIds[p.id] !== runId) return; // 中断导致的报错不提示
    props.showToast(t("problem.analysisFailed", { err: errText(e) }));
  } finally {
    if (runIds[p.id] === runId) {
      analyzing.value[p.id] = undefined;
      delete runIds[p.id];
    }
  }
}
// 中断分析：内置 AI 无法取消请求，仅丢弃返回结果
function cancelAnalysis(p) {
  if (!analyzing.value[p.id]) return;
  delete runIds[p.id]; // 先作废本次 run，过期结果不再写回
  analyzing.value[p.id] = undefined;
  props.showToast(t("problem.analysisCancelled"));
}
async function copyAnalysis(p) {
  try {
    await navigator.clipboard.writeText((p.aiAnalysis && p.aiAnalysis.text) || "");
    props.showToast(t("problem.analysisCopied"));
  } catch (e) {
    props.showToast(t("problem.copyFailed", { err: errText(e) }));
  }
}
async function clearAnalysis(p) {
  p.aiAnalysis = null;
  touch(p);
  await persist();
}
// Markdown 渲染缓存：模板里每次重渲染都会调用，文本不变时不重复全文解析
const mdCache = new Map(); // text -> html
function renderAnalysis(text) {
  let html = mdCache.get(text);
  if (html === undefined) {
    if (mdCache.size > 50) mdCache.clear(); // 防止旧文本长期驻留
    html = renderMarkdown(text);
    mdCache.set(text, html);
  }
  return html;
}
function mimeOf(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
}
async function loadImages(p) {
  for (const img of p.images || []) {
    if (imgCache.value[img.name] !== undefined) continue;
    try {
      const b64 = await invoke("load_image", { name: img.name });
      imgCache.value[img.name] = `data:${mimeOf(img.name)};base64,${b64}`;
    } catch (e) {
      imgCache.value[img.name] = "";
    }
  }
}
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
async function addImageBlob(p, blob, mime) {
  const ext = (mime || "").includes("jpeg") ? "jpg" : (mime || "").includes("webp") ? "webp" : "png";
  const name = `${p.id.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const b64 = await blobToB64(blob);
  await invoke("save_image", { name, dataB64: b64 });
  if (!Array.isArray(p.images)) p.images = [];
  // 未解决时上传默认标为「问题」，已解决后上传默认标为「解决」
  p.images.push({ id: crypto.randomUUID(), name, stage: p.status === "done" ? "after" : "before", createdAt: Date.now() });
  imgCache.value[name] = `data:${mime || "image/png"};base64,${b64}`;
}
async function onPickImages(p, e) {
  const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
  e.target.value = "";
  if (!files.length) return;
  try {
    for (const f of files) await addImageBlob(p, f, f.type);
    touch(p);
    await persist();
    props.showToast(t("problem.addedImages", { count: files.length }));
  } catch (err) {
    props.showToast(t("problem.saveImageFailed", { err }));
  }
}
async function pasteImages(p) {
  try {
    const items = await navigator.clipboard.read();
    let added = 0;
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await it.getType(type);
      await addImageBlob(p, blob, type);
      added++;
    }
    if (!added) return props.showToast(t("problem.clipboardNoImage"));
    touch(p);
    await persist();
    props.showToast(t("problem.pastedImages", { count: added }));
  } catch (err) {
    props.showToast(t("problem.clipboardReadFailed", { err }));
  }
}
async function removeImage(p, img) {
  const idx = (p.images || []).findIndex((x) => x.id === img.id);
  p.images = (p.images || []).filter((x) => x.id !== img.id);
  touch(p);
  await persist();
  props.showToast(t("problem.imageDeleted"), {
    actionLabel: t("problem.undo"),
    onAction: async () => {
      p.images.splice(Math.min(Math.max(idx, 0), p.images.length), 0, img);
      touch(p);
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
async function toggleStage(p, img) {
  img.stage = img.stage === "after" ? "before" : "after";
  touch(p);
  await persist();
}

// 配置类弹窗：禁点遮罩关闭，仅 Esc 可关（表单较长，防误触丢输入）
function onEsc(e) {
  if (e.key === "Escape" && showForm.value) showForm.value = false;
}
onMounted(() => window.addEventListener("keydown", onEsc));
onUnmounted(() => window.removeEventListener("keydown", onEsc));
// 托盘「快速记问题」：窗口唤起后先切到本视图，此监听在挂载后注册，App 侧延迟派发保证收到
onMounted(() => window.addEventListener("quick-note", openCreate));
onUnmounted(() => window.removeEventListener("quick-note", openCreate));

</script>

<template>
  <div class="toolbar">
    <div class="tb-left">
      <h3 class="section-title">{{ t("problem.sectionTitle") }}</h3>
      <div class="filters">
        <button v-for="f in FILTERS" :key="f.key" class="chip" :class="{ active: filter === f.key }" @click="filter = f.key">
          {{ f.label }}<em class="count">{{ counts[f.key] }}</em>
        </button>
      </div>
      <div class="search-mini">
        <Icon name="search" :size="15" class="s-icon" />
        <input v-model="search" :placeholder="t('problem.searchPh')" />
      </div>
    </div>
    <div class="tb-right">
      <template v-if="batchMode">
        <span class="batch-count">{{ t("problem.selectedCount", { count: checkedIds.size }) }}</span>
        <button class="btn-ghost sm" @click="toggleAll">{{ allChecked ? t("problem.unselectAll") : t("problem.selectAll") }}</button>
        <button class="btn-ghost sm danger" :disabled="!checkedIds.size" @click="removeChecked"><Icon name="trash" :size="14" /> {{ t("problem.batchDeleteBtn") }}</button>
        <button class="btn-ghost sm" @click="exitBatch">{{ t("problem.exitBatch") }}</button>
      </template>
      <template v-else>
        <button class="btn-ghost sm" :title="t('problem.batchBtnTitle')" @click="enterBatch"><Icon name="square" :size="14" /> {{ t("problem.batchBtn") }}</button>
        <button class="btn-primary sm" @click="openCreate"><Icon name="plus" :size="15" /> {{ t("problem.create") }}</button>
        <AiExtract :fields="AI_FIELDS" :multiple="true" dedupe-key="title" :existing="problems.map((p) => p.title)" :hint="t('prompt.problemExtractHint')" :title="t('problem.extractTitle')" :show-toast="showToast" @apply="createProblemsFromAI" />
      </template>
    </div>
  </div>

  <div class="summary">
    <div class="stat pend"><span class="stat-ico"><Icon name="clock" :size="17" /></span><span class="stat-main"><span class="num">{{ counts.open }}</span><span class="lbl">{{ t("problem.statOpen") }}</span></span></div>
    <div class="stat hrs"><span class="stat-ico"><Icon name="bar-chart" :size="17" /></span><span class="stat-main"><span class="num">{{ totalHours }}</span><span class="lbl">{{ t("problem.statHours") }}</span></span></div>
    <div class="stat all"><span class="stat-ico"><Icon name="alert" :size="17" /></span><span class="stat-main"><span class="num">{{ counts.all }}</span><span class="lbl">{{ t("problem.statAll") }}</span></span></div>
  </div>

  <main class="content">
    <div v-if="filteredList.length" class="prob-list">
      <div v-for="p in filteredList" :key="p.id" class="prob-block">
        <div class="prob-row" :class="{ done: p.status === 'done' }" @contextmenu.prevent="onProbCtx($event, p)">
          <button v-if="batchMode" class="sel-check" :class="{ on: checkedIds.has(p.id) }" :title="checkedIds.has(p.id) ? t('problem.uncheck') : t('problem.check')" @click.stop="toggleCheck(p)">
            <Icon v-if="checkedIds.has(p.id)" name="check" :size="13" />
          </button>
          <button class="check" :class="{ on: p.status === 'done' }" @click="toggleStatus(p)">
            <Icon v-if="p.status === 'done'" name="check" :size="14" />
          </button>
          <span class="tc-chip" :class="TYPES[p.type].cls">
            <Icon :name="TYPES[p.type].icon" :size="12" /> {{ TYPES[p.type].label }}
          </span>
          <div class="prob-main" @click="batchMode ? toggleCheck(p) : toggleExpand(p)">
            <span class="prob-title">{{ p.title }}</span>
            <span class="prob-sub">
              <span v-for="t in p.tags || []" :key="t" class="tag-chip"><Icon name="tag" :size="11" /> {{ t }}</span>
              <span v-if="probHours(p)" class="mini-chip hrs">{{ probHours(p) }}h</span>
              <span v-if="(p.images || []).length" class="mini-chip imgs"><Icon name="image" :size="11" /> {{ p.images.length }}</span>
              <span v-if="p.status === 'done' && p.resolvedAt" class="mini-chip ok"><Icon name="check" :size="11" /> {{ fmtDate(new Date(p.resolvedAt)) }}</span>
              <span v-if="p.status === 'done' && p.resolution" class="prob-note res" :title="notePreview(p.resolution)">{{ p.resolution }}</span>
              <span v-else-if="p.note" class="prob-note" :title="notePreview(p.note)">{{ p.note }}</span>
            </span>
          </div>
          <button class="icon-btn" :title="expanded[p.id] ? t('problem.collapse') : t('problem.logHoursBtn')" @click="toggleExpand(p)">
            <Icon name="chevron" :size="15" :class="{ rot180: expanded[p.id] }" />
          </button>
          <button class="icon-btn" :title="t('problem.edit')" @click="openEdit(p)"><Icon name="edit" :size="15" /></button>
          <button class="icon-btn" :title="t('problem.delete')" @click="removeProblem(p)"><Icon name="trash" :size="15" /></button>
        </div>

        <div v-if="expanded[p.id]" class="prob-detail">
          <div class="sub-title">{{ t("problem.hoursTitle") }} <em>{{ t("problem.hoursTotal", { hours: probHours(p) }) }}</em></div>
          <div v-for="l in p.logs || []" :key="l.id" class="log-row">
            <span class="log-date">{{ l.date }}</span>
            <span class="log-hours">{{ l.hours }}h</span>
            <span class="log-note">{{ l.note }}</span>
            <button class="icon-btn xs" :title="t('problem.delete')" @click="removeLog(p, l)"><Icon name="x" :size="13" /></button>
          </div>
          <div class="log-add">
            <input type="date" v-model="ensureLog(p).date" class="log-d" />
            <input type="number" min="0" step="0.5" v-model.number="ensureLog(p).hours" class="log-h" />
            <input v-model="ensureLog(p).note" :placeholder="t('problem.logNotePh')" class="log-n" @keyup.enter="addLog(p)" />
            <button class="btn-ghost sm" @click="addLog(p)"><Icon name="plus" :size="14" /> {{ t("problem.addLog") }}</button>
          </div>

          <div class="sub-title res-title">
            {{ t("problem.resolutionTitle") }}
            <em v-if="p.status === 'done' && p.resolvedAt" class="ok">{{ t("problem.resolvedAt", { date: fmtDate(new Date(p.resolvedAt)) }) }}</em>
          </div>
          <textarea
            v-model="p.resolution"
            class="res-input"
            rows="2"
            :placeholder="t('problem.resolutionPh')"
            @change="saveResolution(p)"
          ></textarea>

          <div class="sub-title res-title">
            {{ t("problem.tagsTitle") }}
            <em class="dom-hint">{{ t("problem.tagHint") }}</em>
          </div>
          <div class="dom-picker">
            <input
              v-model="newTagInput"
              class="tag-input"
              :placeholder="t('problem.tagInputPh')"
              @keyup.enter="addProbTag(p)"
            />
            <button
              v-for="t in allTags"
              :key="t"
              type="button"
              class="dom-toggle"
              :class="{ on: (p.tags || []).includes(t) }"
              @click="toggleProbTag(p, t)"
            >
              <Icon name="tag" :size="12" /> {{ t }}
            </button>
            <span v-if="!allTags.length" class="no-dom">{{ t("problem.noTags") }}</span>
          </div>

          <div class="sub-title res-title">
            {{ t("problem.aiTitle") }}
            <em v-if="p.aiAnalysis" class="ai-meta">{{ fmtDate(new Date(p.aiAnalysis.at)) }}</em>
            <span class="ai-actions">
              <button class="btn-ghost xs2" :disabled="!!analyzing[p.id]" :title="t('problem.aiBtnTitle')" @click="analyzeProblem(p)">
                <Icon name="sparkles" :size="12" /> {{ analyzing[p.id] ? t("problem.aiAnalyzing") : t("problem.aiAnalyze") }}
              </button>
              <template v-if="p.aiAnalysis">
                <button class="btn-ghost xs2" :title="t('problem.aiCopyBtnTitle')" @click="copyAnalysis(p)"><Icon name="copy" :size="12" /> {{ t("problem.aiCopyBtn") }}</button>
                <button class="btn-ghost xs2" :title="t('problem.aiClearTitle')" @click="clearAnalysis(p)"><Icon name="x" :size="12" /></button>
              </template>
            </span>
          </div>
          <div v-if="analyzing[p.id]" class="ai-running">
            <Icon name="sparkles" :size="13" /> {{ t("problem.aiRunning") }}
            <button class="btn-ghost xs2 ai-abort" :title="t('problem.aiAbortTitle')" @click="cancelAnalysis(p)"><Icon name="x" :size="12" /> {{ t("problem.aiAbort") }}</button>
          </div>
          <div v-if="p.aiAnalysis" class="ai-result md" v-html="renderAnalysis(p.aiAnalysis.text)"></div>

          <div class="sub-title res-title">{{ t("problem.imgsTitle") }} <em v-if="(p.images || []).length">{{ t("problem.imgsCount", { count: p.images.length }) }}</em></div>
          <div class="img-grid">
            <div v-for="img in p.images || []" :key="img.id" class="img-cell">
              <img v-if="imgCache[img.name]" :src="imgCache[img.name]" @click="previewSrc = imgCache[img.name]" />
              <span v-else class="img-miss"><Icon name="image" :size="18" /></span>
              <button class="img-stage" :class="img.stage" :title="t('problem.stageTitle')" @click="toggleStage(p, img)">
                {{ img.stage === "after" ? t("problem.stageAfter") : t("problem.stageBefore") }}
              </button>
              <button class="img-del" :title="t('problem.delete')" @click="removeImage(p, img)"><Icon name="x" :size="12" /></button>
            </div>
            <label class="img-add">
              <Icon name="plus" :size="15" /> {{ t("problem.pickImage") }}
              <input type="file" accept="image/*" multiple hidden @change="onPickImages(p, $event)" />
            </label>
            <button class="img-add" @click="pasteImages(p)"><Icon name="copy" :size="14" /> {{ t("problem.pasteImage") }}</button>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="empty">
          <span class="empty-ico"><Icon name="alert" :size="32" /></span>
      <h2>{{ t("problem.emptyTitle") }}</h2>
      <p>{{ t("problem.emptyDesc") }}</p>
      <button class="btn-outline lg" @click="openCreate"><Icon name="plus" :size="16" /> {{ t("problem.emptyCreate") }}</button>
    </div>
  </main>

  <!-- 新建 / 编辑弹窗 -->
  <div v-if="showForm" class="modal-mask">
    <div class="modal">
      <h2>{{ form.id ? t("problem.formEditTitle") : t("problem.formCreateTitle") }}</h2>

      <label class="field">
        <span>{{ t("problem.formTitle") }}</span>
        <input v-model="form.title" :placeholder="t('problem.formTitlePh')" />
      </label>

      <label class="field">
        <span>{{ t("problem.formType") }}</span>
        <div class="type-picker">
          <button
            v-for="(m, k) in TYPES"
            :key="k"
            type="button"
            class="type-opt"
            :class="{ active: form.type === k }"
            @click="form.type = k"
          >
            <Icon :name="m.icon" :size="14" /> {{ m.label }}
          </button>
        </div>
      </label>

      <label class="field">
        <span>{{ t("problem.formTagsLabel") }}</span>
        <div v-if="form.tags.length" class="picked-tags">
          <span v-for="tag in form.tags" :key="tag" class="tag-chip" :title="t('problem.formTagRemove')" @click="toggleFormTag(tag)"><Icon name="tag" :size="11" /> {{ tag }}<Icon name="x" :size="11" /></span>
        </div>
        <input v-model="tagInput" class="tag-input" :placeholder="t('problem.formTagPh')" @keyup.enter="applyTagInput" @blur="applyTagInput" />
        <div v-if="allTags.some((x) => !form.tags.includes(x))" class="type-picker">
          <button
            v-for="tag in allTags.filter((x) => !form.tags.includes(x))"
            :key="tag"
            type="button"
            class="type-opt dom"
            @click="toggleFormTag(tag)"
          >
            <Icon name="tag" :size="13" /> {{ tag }}
          </button>
        </div>
      </label>

      <label class="field">
        <span>{{ t("problem.formStatus") }}</span>
        <select v-model="form.status" class="select">
          <option value="open">{{ t("problem.filterOpen") }}</option>
          <option value="done">{{ t("problem.filterDone") }}</option>
        </select>
      </label>

      <label class="field">
        <span>{{ t("problem.formNote") }}</span>
        <textarea v-model="form.note" rows="2" :placeholder="t('problem.formNotePh')"></textarea>
      </label>

      <div class="modal-foot">
        <button class="btn-ghost" @click="showForm = false">{{ t("common.cancel") }}</button>
        <button class="btn-primary" @click="saveForm">{{ t("problem.saveBtn") }}</button>
      </div>
    </div>
  </div>

  <!-- 图片放大预览 -->
  <div v-if="previewSrc" class="img-preview" @click="previewSrc = ''">
    <img :src="previewSrc" />
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 28px; flex-wrap: wrap; }
.tb-left { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.section-title { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
.filters { display: flex; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 6px; background: var(--card); border: 1px solid var(--border-strong); padding: 8px 13px; border-radius: var(--r-sm); font-size: var(--fs-md); font-weight: 600; cursor: pointer; color: var(--text-soft); transition: all 0.15s; }
.chip:hover { border-color: var(--border-steel); }
.chip.active { background: var(--accent-hover); color: var(--text-invert); border-color: var(--accent-hover); }
.chip .count { font-style: normal; background: color-mix(in srgb, var(--text) 8%, transparent); padding: 1px 7px; border-radius: var(--r-pill); font-size: var(--fs-sm); font-weight: 600; }
.chip.active .count { background: rgba(255, 255, 255, 0.22); }
.tb-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.search-mini { position: relative; display: flex; align-items: center; }
.search-mini .s-icon { position: absolute; left: 10px; color: var(--muted); pointer-events: none; }
.search-mini input { padding: 7px 12px 7px 30px; border: 1px solid transparent; border-radius: var(--r-sm); font-size: var(--fs-md); background: color-mix(in srgb, var(--text-weak) 9%, transparent); color: var(--text); outline: none; width: 180px; transition: background 0.15s, border-color 0.15s; }
.search-mini input:focus { background: var(--card); border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }

.summary { display: flex; gap: 14px; padding: 0 28px; flex-wrap: wrap; }
.stat { flex: 1; min-width: 130px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 16px 18px; box-shadow: var(--shadow); display: flex; align-items: center; gap: 12px; }
.stat-ico { width: 38px; height: 38px; display: grid; place-items: center; border-radius: var(--r-sm); background: var(--primary-soft); color: var(--primary-hover); box-shadow: 0 3px 8px rgba(35, 43, 66, 0.14); flex-shrink: 0; }
.stat-main { display: flex; flex-direction: column; gap: 3px; }
.stat .num { font-size: var(--fs-num); font-weight: 700; color: var(--primary); line-height: 1.1; }
.stat.pend .num { color: var(--warn-deep); }
.stat.hrs .num { color: var(--accent-hover); }
.stat .lbl { font-size: var(--fs-sm); color: var(--muted); }

.content { flex: 1; padding: 18px 28px 36px; }
.prob-list { display: flex; flex-direction: column; }
/* 列表平铺：问题列表不设容器（背景层），行分隔线分组，与独立卡片形成层级对比 */
.prob-block { border-bottom: 1px solid var(--border); }
.prob-block:last-child { border-bottom: none; }
.prob-row { display: flex; align-items: center; gap: 12px; padding: 13px 16px; transition: background 0.15s, box-shadow 0.15s; }
.prob-row:hover { background: color-mix(in srgb, var(--primary) 5%, transparent); box-shadow: inset 2px 0 0 var(--primary); }
.prob-row.done .prob-title { color: var(--muted); text-decoration: line-through; }
.check { width: 22px; height: 22px; flex-shrink: 0; padding: 0; border: 1.5px solid var(--border-strong); border-radius: var(--r-xs); background: var(--card); cursor: pointer; display: grid; place-items: center; color: var(--text-invert); }
.check.on { background: var(--success); border-color: var(--success); }
/* 多选批量：勾选框与计数（选中态用主色蓝，与状态完成绿区分语义） */
.sel-check { width: 22px; height: 22px; flex-shrink: 0; padding: 0; border: 1.5px solid var(--border-strong); border-radius: var(--r-xs); background: var(--card); cursor: pointer; display: grid; place-items: center; color: var(--text-invert); transition: all 0.15s; }
.sel-check.on { background: var(--primary); border-color: var(--primary); }
.batch-count { font-size: var(--fs-sm); font-weight: 600; color: var(--primary); }
.type-chip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); font-weight: 600; padding: 3px 9px; border-radius: var(--r-pill); flex-shrink: 0; }
.prob-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; cursor: pointer; }
.prob-title { font-size: var(--fs-base); font-weight: 600; word-break: break-word; }
.prob-sub { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tag-chip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--accent-hover); background: var(--accent-soft); padding: 1px 8px; border-radius: var(--r-pill); font-weight: 600; cursor: pointer; }
.mini-chip { font-size: var(--fs-xs); color: var(--text-dim); background: var(--well); padding: 1px 8px; border-radius: var(--r-pill); }
.mini-chip.hrs { color: var(--danger-deep); background: var(--danger-soft); font-weight: 600; }
.prob-note { font-size: var(--fs-sm); color: var(--muted); flex: 0 1 auto; min-width: 0; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rot180 { transform: rotate(180deg); transition: transform 0.15s; }

.prob-detail { padding: 4px 16px 14px 50px; background: var(--card-soft); border-top: 1px dashed var(--border); }
.sub-title { font-size: var(--fs-sm); font-weight: 700; color: var(--text-dim); display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sub-title em { font-style: normal; font-weight: 600; color: var(--danger); }
.log-row { display: flex; align-items: center; gap: 10px; font-size: var(--fs-sm); padding: 4px 0; }
.log-date { color: var(--text-soft); font-family: var(--font-num); }
.log-hours { color: var(--danger); font-weight: 700; min-width: 40px; }
.log-note { flex: 1; min-width: 0; color: var(--muted); word-break: break-word; }
.log-add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.log-add input { padding: 7px 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-sm); outline: none; background: var(--card); color: var(--text); }
.log-add input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.log-d { width: 140px; }
.log-h { width: 72px; }
.log-n { flex: 1; min-width: 120px; }

.res-title { margin-top: 14px; }
.res-title .ok { color: var(--success-deep); }
.res-input { width: 100%; box-sizing: border-box; padding: 9px 12px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-md); font-family: inherit; outline: none; resize: vertical; background: var(--card); color: var(--text); }
.res-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.prob-note.res { color: var(--success-deep); }

/* AI 分析 */
.dom-hint { color: var(--muted) !important; font-weight: 600 !important; }
.dom-picker { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; align-items: center; }
.tag-input { padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: var(--r-pill); font-size: var(--fs-sm); outline: none; background: var(--card); color: var(--text); min-width: 140px; }
.tag-input:focus { border-color: var(--accent-light); }
.picked-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.dom-toggle { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border: 1px solid var(--border-strong); border-radius: var(--r-pill); background: var(--card); color: var(--text-soft); font-size: var(--fs-sm); cursor: pointer; transition: all 0.15s; }
.dom-toggle:hover { border-color: var(--accent-light); color: var(--accent-hover); }
.dom-toggle.on { background: var(--accent-soft); border-color: var(--accent-light); color: var(--accent-hover); font-weight: 600; }
.ai-meta { color: var(--accent-hover) !important; }
.ai-actions { display: inline-flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.btn-ghost.xs2 { padding: 4px 9px; font-size: var(--fs-sm); border-radius: var(--r-xs); gap: 4px; }
.btn-ghost.xs2:disabled { opacity: 0.6; cursor: default; }
.ai-result { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--text); background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 10px 13px; margin: 0 0 4px; max-height: 420px; overflow: auto; }
/* Markdown 渲染态：v-html 内容不带 scoped 属性，需 :deep() */
.ai-result.md { white-space: normal; }
.ai-result.md :deep(h3) { font-size: var(--fs-md); font-weight: 700; margin: 10px 0 4px; }
.ai-result.md :deep(h4) { font-size: var(--fs-md); font-weight: 700; margin: 8px 0 3px; }
.ai-result.md :deep(h5), .ai-result.md :deep(h6) { font-size: var(--fs-sm); font-weight: 700; margin: 6px 0 2px; }
.ai-result.md :deep(h3:first-child), .ai-result.md :deep(h4:first-child) { margin-top: 0; }
.ai-result.md :deep(p) { margin: 3px 0; }
.ai-result.md :deep(ul), .ai-result.md :deep(ol) { margin: 4px 0; padding-left: 20px; }
.ai-result.md :deep(li) { margin: 2px 0; }
.ai-result.md :deep(strong) { font-weight: 700; }
.ai-result.md :deep(code) { font-family: var(--font-mono); font-size: var(--fs-xs); background: var(--ghost); border-radius: var(--r-xs); padding: 1px 5px; }
.ai-result.md :deep(pre.md-code) { font-family: var(--font-mono); font-size: var(--fs-xs); line-height: var(--lh-body); background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-sm); padding: 8px 11px; margin: 6px 0; overflow-x: auto; white-space: pre; }
.ai-result.md :deep(pre.md-code) code { background: none; padding: 0; }
.ai-result.md :deep(hr) { border: none; border-top: 1px dashed var(--border-strong); margin: 8px 0; }
.ai-result.md :deep(blockquote) { margin: 4px 0; padding: 2px 10px; border-left: 3px solid var(--border-strong); color: var(--muted); }
.ai-result.md :deep(a) { color: var(--primary); }
.ai-running { display: flex; align-items: center; gap: 7px; font-size: var(--fs-sm); color: var(--accent-hover); background: var(--accent-soft); border-radius: var(--r-sm); padding: 9px 13px; margin-bottom: 4px; }
.ai-abort { margin-left: auto; flex-shrink: 0; color: var(--danger-deep); }
.no-dom { font-size: var(--fs-sm); color: var(--muted); align-self: center; }
.type-opt.dom { flex: none; min-width: 0; padding: 8px 13px; }
.mini-chip.imgs { display: inline-flex; align-items: center; gap: 3px; color: var(--primary); background: var(--primary-soft); font-weight: 600; }
.mini-chip.ok { display: inline-flex; align-items: center; gap: 3px; color: var(--success-deep); background: var(--success-soft); font-weight: 600; }

.img-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 4px; }
.img-cell { position: relative; width: 96px; height: 72px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); overflow: hidden; background: var(--card); }
.img-cell img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; display: block; }
.img-miss { display: grid; place-items: center; width: 100%; height: 100%; color: var(--muted); }
.img-stage { position: absolute; left: 4px; bottom: 4px; border: none; font-size: var(--fs-xs); font-weight: 700; padding: 1px 6px; border-radius: var(--r-pill); cursor: pointer; color: var(--text-invert); background: var(--danger-deep); }
.img-stage.after { background: var(--success-deep); }
.img-del { position: absolute; right: 4px; top: 4px; width: 18px; height: 18px; padding: 0; display: grid; place-items: center; border: none; border-radius: var(--r-xs); background: rgba(0, 0, 0, 0.45); color: var(--text-invert); cursor: pointer; }
.img-del:hover { background: var(--danger); }
.img-add { display: inline-flex; align-items: center; justify-content: center; gap: 5px; width: 96px; height: 72px; border: 1.5px dashed var(--border-strong); border-radius: var(--r-sm); background: transparent; color: var(--muted); font-size: var(--fs-sm); cursor: pointer; transition: all 0.15s; }
.img-add:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }

.img-preview { position: fixed; inset: 0; z-index: 200; background: rgba(10, 12, 16, 0.82); display: grid; place-items: center; cursor: zoom-out; padding: 32px; }
.img-preview img { max-width: 100%; max-height: 100%; border-radius: var(--r-sm); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); }

.empty { text-align: center; padding: 56px 20px; }
.empty-ico { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 50%; background: var(--primary-soft); color: var(--primary); margin-bottom: 6px; }
.empty h2 { font-size: var(--fs-xl); margin: 8px 0 6px; font-weight: 700; }
.empty p { color: var(--muted); font-size: var(--fs-base); margin: 0 0 22px; max-width: 460px; margin-left: auto; margin-right: auto; }

.modal { width: 500px; }
.field { display: block; margin-bottom: 16px; }
.field > span { display: block; font-size: var(--fs-md); color: var(--muted); margin-bottom: 7px; font-weight: 600; }
.field input, .field textarea, .select { width: 100%; padding: 10px 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; resize: vertical; background: var(--card); color: var(--text); }
.field input:focus, .field textarea:focus, .select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.type-picker { display: flex; gap: 8px; flex-wrap: wrap; }
.type-opt { flex: 1; min-width: 84px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card-soft); cursor: pointer; font-size: var(--fs-md); color: var(--text-soft); }
.type-opt.active { border-color: var(--primary); background: var(--primary-soft); color: var(--primary); font-weight: 600; }

@media (prefers-color-scheme: dark) {
  .prob-list { background: rgba(23, 27, 34, 0.72); border-color: rgba(52, 60, 74, 0.6); }
  .check, .field input, .field textarea, .select, .search-mini input, .icon-btn, .log-add input, .type-opt { background: var(--card-raised); }
  .btn-outline { background: var(--card-raised); border-color: var(--border-blue); }
  .empty-icon { background: var(--danger-soft-deep); color: var(--danger-soft-text); }
  .mini-chip { background: var(--well); color: var(--text-weak); }
  .mini-chip.hrs { background: var(--danger-soft-deep); color: var(--danger-soft-text); }
  .mini-chip.imgs { background: var(--primary-soft); color: var(--primary-light); }
  .mini-chip.ok { background: var(--success-soft); color: var(--success-light); }
  .prob-note.res { color: var(--success-light); }
  .res-title .ok { color: var(--success-light); }
  .res-input { background: var(--card-raised); }
  .img-cell { background: var(--card-raised); }
  .tag-chip { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .tag-input { background: var(--card-raised); }
  .dom-toggle { background: var(--card-raised); color: var(--text-weak); }
  .dom-toggle.on { background: var(--accent-soft-deep); border-color: var(--accent-deep); color: var(--accent-soft-text); }
  .ai-result { background: var(--card-raised); }
  .ai-running { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .ai-abort { color: var(--danger-soft-text); }
  .type-opt { background: var(--card-inset); color: var(--text-weak); }
}
</style>
