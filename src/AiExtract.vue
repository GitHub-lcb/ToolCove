<script setup>
// 通用「AI 识图录入」组件
// 支持：选择图片文件 / 剪贴板粘贴(Ctrl+V) / 拖拽图片。
// 单条模式(multiple=false)：识别 1 条，apply 回传对象；
// 批量模式(multiple=true)：识别多条(列表/表格)，逐条可编辑/删除，apply 回传对象数组。
// 分组模式(传 groups)：截图含多张表(如上线包三表)，按表分组识别，apply 回传 {表key: 行数组}。
// 流式+异步：识别结果边生成边填表（生成中只读）；可最小化弹窗后台继续（跨视图存活），
// 完成 toast 通知、重开弹窗恢复；可随时取消。任务状态由 extractTask.js 模块驱动。
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import Icon from "./Icon.vue";
import {
  aiExtractStream,
  aiExtractManyStream,
  aiExtractGroupsStream,
  isAIConfigured,
} from "./ai.js";
import {
  startExtractTask,
  getExtractTask,
  cancelExtractTask,
  clearExtractTask,
  subscribe,
  registerOwner,
  unregisterOwner,
  isOwnerMounted,
  TASK_LABELS,
} from "./extractTask.js";

const props = defineProps({
  // [{ key, label, desc?, enum?, multiline? }]
  fields: { type: Array, default: () => [] },
  // 分组模式：[{ key, title, fields: [{ key, label, desc?, bool?, multiline? }] }]
  groups: { type: Array, default: () => [] },
  hint: { type: String, default: "" },
  title: { type: String, default: "AI 识图录入" },
  buttonLabel: { type: String, default: "AI 识图" },
  multiple: { type: Boolean, default: false },
  // 重复项高亮：dedupeKey 指定用哪个字段比对，existing 为已存在的值列表
  dedupeKey: { type: String, default: "" },
  existing: { type: Array, default: () => [] },
  showToast: { type: Function, default: () => {} },
});

const emit = defineEmits(["apply"]);

const open = ref(false);
const dialogOpen = ref(false); // 本实例弹窗是否开着（toast 文案与恢复逻辑用）
const imageUrl = ref("");
const loading = ref(false);
const error = ref("");
const result = ref(null); // 单条：对象；批量：数组；分组：{key: 数组}
const selected = ref([]); // 批量：与 result 同下标的勾选；分组：{key: 勾选数组}
const isGroups = computed(() => props.groups.length > 0);
const dragOver = ref(false);
const configured = ref(true);
const fileInput = ref(null);

// 本实例身份 + owner 注册（toast 只由 owner 实例发）
const instanceId = crypto.randomUUID();
const mountedRef = ref(false);
let toastSent = false; // 本任务周期内是否已发过完成/失败 toast（防重复）

// 任务指示：触发器三态由模块状态驱动（组件卸载后其他实例/重挂载仍可读）
const taskState = ref(getExtractTask());
let unsub = null;

const triggerLabel = computed(() => {
  const t = taskState.value;
  if (!t) return props.buttonLabel;
  if (t.status === "running") return TASK_LABELS.running(t.elapsed);
  if (t.status === "done") return TASK_LABELS.done(countRows(t));
  if (t.status === "error") return TASK_LABELS.error;
  return props.buttonLabel;
});

function countRows(t) {
  if (t.mode === "groups") {
    return (t.groups || []).reduce((n, g) => n + ((t.result && t.result[g.key]) || []).length, 0);
  }
  return Array.isArray(t.result) ? t.result.length : 1;
}

// 任务状态变化 → 本实例 UI 同步；owner 身份发 toast（owner 卸载期间不发，按钮三态即通知）
function syncFromTask(t) {
  if (!t) {
    loading.value = false;
    return;
  }
  const isOwner = t.ownerId === instanceId;
  if (t.status === "running") {
    loading.value = true;
    if (dialogOpen.value && t.partial) {
      result.value = normalizePartial(t);
      selected.value = partialSelected(t);
    }
    return;
  }
  loading.value = false;
  // 完成/错误/被取消 → owner 发 toast（仅一次）
  if (isOwner && mountedRef.value && isOwnerMounted(instanceId)) {
    if (t.status === "done" && !toastSent && t.result) {
      toastSent = true;
      const n = countRows(t);
      props.showToast(dialogOpen.value ? `识别完成：已提取 ${n} 行` : `识别完成 ${n} 行，点「AI 识图」查看`);
      if (dialogOpen.value) {
        result.value = cloneResult(t.result);
        selected.value = initSelected(t);
      }
    } else if (t.status === "error" && !toastSent) {
      toastSent = true;
      props.showToast("识别失败：" + (t.error?.message || t.error));
      if (dialogOpen.value) {
        error.value = t.error?.message || String(t.error);
        result.value = null;
      }
    } else if (t.status === "cancelled" && !toastSent) {
      // 被新任务取消（非本实例主动取消，主动取消由 cancelRun 自己 toast）
      toastSent = true;
      props.showToast("原识别任务已被取消");
    }
  }
}

async function openDialog() {
  const t = getExtractTask();
  configured.value = await isAIConfigured();
  // 有任务：恢复（不重置 imageUrl/result）
  if (t && t.status === "running") {
    imageUrl.value = t.imageUrl || "";
    result.value = t.partial ? normalizePartial(t) : null;
    selected.value = partialSelected(t);
    loading.value = true;
    toastSent = false; // 弹窗内看进度，完成 toast 由 syncFromTask 按弹窗状态发
  } else if (t && t.status === "done" && t.result) {
    imageUrl.value = t.imageUrl || "";
    result.value = cloneResult(t.result);
    selected.value = initSelected(t);
    loading.value = false;
  } else if (t && t.status === "error") {
    imageUrl.value = t.imageUrl || "";
    error.value = t.error?.message || String(t.error);
    result.value = null;
    loading.value = false;
  } else {
    imageUrl.value = "";
    result.value = null;
    error.value = "";
    loading.value = false;
  }
  dialogOpen.value = true;
  open.value = true;
}
function close() {
  open.value = false;
  dialogOpen.value = false;
}
function minimize() {
  // running 态关弹窗：任务继续后台跑
  open.value = false;
  dialogOpen.value = false;
}
function cancelRun() {
  cancelExtractTask();
  loading.value = false;
  result.value = null;
  error.value = "已取消";
  toastSent = true;
  props.showToast("已取消");
}
// 配置类弹窗：禁点遮罩关闭，仅 Esc 可关（识别结果可编辑，防误触丢失）；
// running 态 Esc = 最小化（不中断任务）
function onEsc(e) {
  if (e.key === "Escape" && open.value) {
    if (loading.value) minimize();
    else close();
  }
}
onMounted(() => {
  window.addEventListener("keydown", onEsc);
  registerOwner(instanceId);
  mountedRef.value = true;
  unsub = subscribe((t) => {
    taskState.value = t;
    syncFromTask(t);
  });
});
onUnmounted(() => {
  window.removeEventListener("keydown", onEsc);
  unsub?.();
  unregisterOwner(instanceId);
  mountedRef.value = false;
});

// ---------- 图片输入 ----------
function readFile(file) {
  if (!file) return;
  if (!file.type || !file.type.startsWith("image/")) {
    props.showToast("请选择图片文件");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    imageUrl.value = reader.result;
    result.value = null;
    error.value = "";
  };
  reader.onerror = () => props.showToast("读取图片失败");
  reader.readAsDataURL(file);
}
function onSelect(e) {
  const f = e.target.files && e.target.files[0];
  readFile(f);
  e.target.value = ""; // 允许重复选同一文件
}
function onDrop(e) {
  dragOver.value = false;
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  readFile(f);
}
function onPaste(e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) {
      readFile(it.getAsFile());
      e.preventDefault();
      return;
    }
  }
}
// 仅在弹窗打开时监听全局粘贴
watch(open, (v) => {
  if (v) window.addEventListener("paste", onPaste);
  else window.removeEventListener("paste", onPaste);
});

// ---------- 识别（流式任务） ----------
function runExtract() {
  if (!imageUrl.value || loading.value) return;
  error.value = "";
  result.value = null;
  toastSent = false;
  startExtractTask({
    mode: isGroups.value ? "groups" : props.multiple ? "many" : "single",
    images: [imageUrl.value],
    fields: props.fields,
    groups: props.groups,
    hint: props.hint,
    ownerId: instanceId,
    imageUrl: imageUrl.value,
  });
  // loading/进度/中间态由 subscribe → syncFromTask 驱动
  loading.value = true;
}

// 中间态与空模板合并：保证 v-model 只写声明字段、未出现字段留空、行数稳定
function normalizePartial(t) {
  if (t.mode === "groups") {
    const out = {};
    for (const g of t.groups) {
      const rows = (t.partial && t.partial[g.key]) || [];
      out[g.key] = rows.map((r) => ({ ...groupEmptyRow(g), ...r }));
    }
    return out;
  }
  if (t.mode === "many") {
    const rows = Array.isArray(t.partial) ? t.partial : [];
    return rows.map((r) => ({ ...emptyRow(), ...r }));
  }
  return { ...emptyRow(), ...(t.partial || {}) };
}
function partialSelected(t) {
  if (t.mode === "groups") {
    const sel = {};
    for (const g of t.groups) sel[g.key] = ((t.partial && t.partial[g.key]) || []).map(() => true);
    return sel;
  }
  if (t.mode === "many") return (Array.isArray(t.partial) ? t.partial : []).map(() => true);
  return [];
}
function initSelected(t) {
  if (t.mode === "groups") {
    const sel = {};
    for (const g of props.groups) sel[g.key] = ((t.result && t.result[g.key]) || []).map(() => true);
    return sel;
  }
  if (t.mode === "many") {
    return (t.result || []).map((r) => !isDuplicate(r));
  }
  return [];
}
function cloneResult(r) {
  if (Array.isArray(r)) return r.map((x) => ({ ...x }));
  if (r && typeof r === "object") {
    const out = {};
    for (const k of Object.keys(r)) out[k] = Array.isArray(r[k]) ? r[k].map((x) => ({ ...x })) : r[k];
    return out;
  }
  return r;
}

// ---------- 重复项检测 ----------
const existingSet = computed(
  () => new Set(props.existing.map((v) => (v == null ? "" : String(v).trim())).filter(Boolean))
);
function dupValue(row) {
  if (!props.dedupeKey || !row) return "";
  return (row[props.dedupeKey] || "").toString().trim();
}
function isDuplicate(row) {
  const v = dupValue(row);
  return !!v && existingSet.value.has(v);
}
// 本次识别结果内部重复（同一 dedupeKey 值出现多次，除首条外标记）
function isDupInList(i) {
  if (!props.dedupeKey || !Array.isArray(result.value)) return false;
  const v = dupValue(result.value[i]);
  if (!v) return false;
  for (let k = 0; k < i; k++) if (dupValue(result.value[k]) === v) return true;
  return false;
}
function rowFlag(i) {
  const row = result.value[i];
  if (isDuplicate(row)) return "已存在";
  if (isDupInList(i)) return "重复";
  return "";
}

function emptyRow() {
  const row = {};
  for (const f of props.fields) row[f.key] = "";
  return row;
}
function addRow() {
  if (Array.isArray(result.value)) {
    result.value.push(emptyRow());
    selected.value.push(true);
  }
}
function removeRow(i) {
  if (Array.isArray(result.value)) {
    result.value.splice(i, 1);
    selected.value.splice(i, 1);
  }
}
// ---------- 分组模式行操作 ----------
function groupEmptyRow(g) {
  const row = {};
  for (const f of g.fields) row[f.key] = f.bool ? false : "";
  return row;
}
function groupAddRow(g) {
  if (!result.value || !result.value[g.key]) return;
  result.value[g.key].push(groupEmptyRow(g));
  selected.value[g.key].push(true);
}
function groupRemoveRow(g, i) {
  if (!result.value || !result.value[g.key]) return;
  result.value[g.key].splice(i, 1);
  selected.value[g.key].splice(i, 1);
}
const selectedCount = computed(() => {
  if (isGroups.value) {
    if (!result.value) return 0;
    return props.groups.reduce(
      (n, g) => n + (selected.value[g.key] || []).filter(Boolean).length,
      0
    );
  }
  return Array.isArray(result.value) ? selected.value.filter(Boolean).length : 0;
});
const totalRows = computed(() => {
  if (isGroups.value) {
    if (!result.value) return 0;
    return props.groups.reduce((n, g) => n + (result.value[g.key] || []).length, 0);
  }
  return Array.isArray(result.value) ? result.value.length : 0;
});
const allSelected = computed({
  get: () => selectedCount.value > 0 && selectedCount.value === totalRows.value,
  set: (v) => {
    if (isGroups.value) {
      if (!result.value) return;
      for (const g of props.groups) selected.value[g.key] = (result.value[g.key] || []).map(() => v);
    } else if (Array.isArray(result.value)) {
      selected.value = result.value.map(() => v);
    }
  },
});

function labelOf(key) {
  const f = props.fields.find((x) => x.key === key);
  return f ? f.label : key;
}
function isMultiline(key) {
  const f = props.fields.find((x) => x.key === key);
  return !!(f && f.multiline);
}

const canApply = () => {
  if (!result.value) return false;
  if (isGroups.value || props.multiple) return selectedCount.value > 0;
  return true;
};

function apply() {
  if (!canApply()) return;
  if (isGroups.value) {
    const out = {};
    let total = 0;
    for (const g of props.groups) {
      const rows = (result.value[g.key] || [])
        .filter((r, i) => selected.value[g.key][i])
        .map((r) => ({ ...r }))
        .filter((r) => g.fields.some((f) => !f.bool && (r[f.key] || "").toString().trim()));
      out[g.key] = rows;
      total += rows.length;
    }
    if (!total) return;
    emit("apply", out);
  } else if (props.multiple) {
    const list = result.value
      .filter((r, i) => selected.value[i])
      .map((r) => ({ ...r }))
      .filter((r) => Object.values(r).some((v) => (v || "").toString().trim()));
    if (!list.length) return;
    emit("apply", list);
  } else {
    emit("apply", { ...result.value });
  }
  // 结果已交付：清除任务，触发器回空闲
  clearExtractTask();
  close();
}

defineExpose({ openDialog });
</script>

<template>
  <button
    type="button"
    class="ai-trigger"
    :class="{ busy: taskState?.status === 'running', done: taskState?.status === 'done', err: taskState?.status === 'error' }"
    :title="title"
    @click="openDialog"
  >
    <Icon name="sparkles" :size="15" /> {{ triggerLabel }}
  </button>

  <div v-if="open" class="ax-mask">
    <div class="ax-modal" :class="{ wide: isGroups }">
      <h2><Icon name="sparkles" :size="18" /> {{ title }}</h2>

      <p v-if="!configured" class="ax-warn">
        <Icon name="alert" :size="14" /> 尚未配置 AI 模型，请先在右上角「设置 → AI 模型」中填写接口地址、模型与 API Key（模型需支持图片输入）。
      </p>

      <!-- 图片输入区 -->
      <div
        class="ax-drop"
        :class="{ over: dragOver, has: imageUrl }"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
        @click="!imageUrl && fileInput && fileInput.click()"
      >
        <template v-if="imageUrl">
          <img :src="imageUrl" class="ax-preview" alt="预览" />
        </template>
        <template v-else>
          <span class="ax-drop-ico"><Icon name="image" :size="26" /></span>
          <p class="ax-drop-main">点击选择图片</p>
          <p class="ax-drop-sub">或 Ctrl+V 粘贴截图 / 把图片拖到这里{{ isGroups ? "（可含一张或多张表）" : multiple ? "（可含多条记录）" : "" }}</p>
        </template>
        <input ref="fileInput" type="file" accept="image/*" class="ax-file" @change="onSelect" />
      </div>

      <div class="ax-actions" v-if="imageUrl">
        <button type="button" class="btn-ghost sm" :disabled="loading" @click="fileInput && fileInput.click()">
          <Icon name="repeat" :size="14" /> 换一张
        </button>
        <button type="button" class="btn-primary sm" :disabled="loading" @click="runExtract">
          <Icon name="sparkles" :size="14" /> {{ loading ? `识别中… ${taskState?.elapsed ?? 0}s` : result ? "重新识别" : "开始识别" }}
        </button>
      </div>

      <p v-if="error" class="ax-err"><Icon name="alert" :size="14" /> {{ error }}</p>
      <p v-if="loading && !result" class="ax-err ax-info">
        <Icon name="sparkles" :size="14" /> 正在识别，可点「最小化」继续做别的事，完成后会通知你
      </p>

      <!-- 分组识别结果（多张表） -->
      <div v-if="result && isGroups" class="ax-result">
        <div class="ax-result-hd">
          <label class="ax-selall">
            <input type="checkbox" v-model="allSelected" :disabled="loading" />
            <span>已选 {{ selectedCount }} / {{ totalRows }} 行</span>
          </label>
        </div>
        <div v-for="g in groups" :key="g.key" class="ax-group">
          <div class="ax-group-hd">
            <span>{{ g.title }}<em>{{ (result[g.key] || []).length }}</em></span>
            <button type="button" class="ax-add" :disabled="loading" @click="groupAddRow(g)"><Icon name="plus" :size="13" /> 加一行</button>
          </div>
          <p v-if="!(result[g.key] || []).length" class="ax-group-empty">截图中未识别到该表{{ loading ? "（识别中…）" : "" }}</p>
          <div v-for="(row, i) in result[g.key]" :key="i" class="ax-card" :class="{ off: !selected[g.key][i] }">
            <input type="checkbox" class="ax-check" v-model="selected[g.key][i]" :disabled="loading" />
            <span class="ax-idx">{{ i + 1 }}</span>
            <div class="ax-card-body ax-grid">
              <label v-for="f in g.fields" :key="f.key" class="ax-field" :class="{ bool: f.bool }">
                <span>{{ f.label }}</span>
                <input v-if="f.bool" type="checkbox" class="ax-bool" v-model="row[f.key]" :disabled="loading" />
                <input v-else v-model="row[f.key]" :disabled="loading" />
              </label>
            </div>
            <button type="button" class="ax-del" title="删除该行" :disabled="loading" @click="groupRemoveRow(g, i)">
              <Icon name="trash" :size="14" />
            </button>
          </div>
        </div>
      </div>

      <!-- 批量识别结果 -->
      <div v-else-if="result && multiple" class="ax-result">
        <div class="ax-result-hd">
          <label class="ax-selall">
            <input type="checkbox" v-model="allSelected" :disabled="loading" />
            <span>已选 {{ selectedCount }} / {{ result.length }} 条</span>
          </label>
          <button type="button" class="ax-add" :disabled="loading" @click="addRow"><Icon name="plus" :size="13" /> 加一条</button>
        </div>
        <div v-for="(row, i) in result" :key="i" class="ax-card" :class="{ off: !selected[i], dup: rowFlag(i) }">
          <input type="checkbox" class="ax-check" v-model="selected[i]" :disabled="loading" />
          <span class="ax-idx">{{ i + 1 }}</span>
          <div class="ax-card-body">
            <span v-if="rowFlag(i)" class="ax-dup"><Icon name="alert" :size="12" /> {{ rowFlag(i) }}</span>
            <label v-for="f in fields" :key="f.key" class="ax-field">
              <span>{{ f.label }}</span>
              <textarea v-if="f.multiline" v-model="row[f.key]" rows="2" :disabled="loading"></textarea>
              <input v-else v-model="row[f.key]" :disabled="loading" />
            </label>
          </div>
          <button type="button" class="ax-del" title="删除该条" :disabled="loading" @click="removeRow(i)">
            <Icon name="trash" :size="14" />
          </button>
        </div>
      </div>

      <!-- 单条识别结果 -->
      <div v-else-if="result" class="ax-result">
        <div class="ax-result-hd"><span>识别结果{{ loading ? "（识别中…）" : "（可修改后再填入）" }}</span></div>
        <label v-for="(val, key) in result" :key="key" class="ax-field">
          <span>{{ labelOf(key) }}</span>
          <textarea v-if="isMultiline(key)" v-model="result[key]" rows="2" :disabled="loading"></textarea>
          <input v-else v-model="result[key]" :disabled="loading" />
        </label>
      </div>

      <div class="ax-foot">
        <template v-if="loading">
          <button class="btn-ghost" @click="cancelRun"><Icon name="x" :size="15" /> 取消识别</button>
          <button class="btn-ghost" @click="minimize"><Icon name="chevrons-left" :size="15" /> 最小化</button>
        </template>
        <template v-else>
          <button class="btn-ghost" @click="close">取消</button>
          <button class="btn-primary" :disabled="!canApply()" @click="apply">
            <Icon name="check" :size="15" />
            {{ multiple || isGroups ? `批量填入${result ? " (" + selectedCount + ")" : ""}` : "填入表单" }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-trigger {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--accent-soft); color: var(--accent-hover); border: 1px solid var(--accent-border);
  padding: 7px 12px; border-radius: var(--r-sm); font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
}
.ai-trigger:hover { background: var(--accent-soft); border-color: var(--accent); }
.ai-trigger.busy { animation: ax-pulse 1.2s ease-in-out infinite; }
.ai-trigger.done { color: var(--green, var(--accent-hover)); border-color: var(--green, var(--accent)); }
.ai-trigger.err { color: var(--danger); border-color: var(--border-danger); }
@keyframes ax-pulse { 50% { opacity: 0.55; } }

.ax-mask { position: fixed; inset: 0; background: rgba(17, 24, 39, 0.5); display: flex; align-items: center; justify-content: center; z-index: 260; padding: 20px; }
.ax-modal { background: var(--card); border-radius: var(--r-lg); padding: 24px; width: 540px; max-width: 100%; max-height: 90vh; overflow-y: auto; overscroll-behavior: contain; contain: content; box-shadow: 0 20px 50px rgba(16, 24, 40, 0.25); }
.ax-modal.wide { width: 760px; }
.ax-modal h2 { margin: 0 0 16px; font-size: var(--fs-xl); display: flex; align-items: center; gap: 8px; }

.ax-warn { display: flex; align-items: flex-start; gap: 6px; font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--warn); background: var(--amber-soft); border: 1px solid var(--warn-border); border-radius: var(--r-sm); padding: 10px 12px; margin: 0 0 14px; }
.ax-info { color: var(--accent-hover); background: var(--accent-soft); border-color: var(--accent-border); margin: 12px 0 0; }

.ax-drop { position: relative; border: 2px dashed var(--border-strong); border-radius: var(--r-md); padding: 22px; text-align: center; color: var(--muted); cursor: pointer; transition: all 0.15s; }
.ax-drop.over { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-hover); }
.ax-drop.has { cursor: default; padding: 12px; }
.ax-drop-ico { width: 56px; height: 56px; display: grid; place-items: center; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary); box-shadow: 0 4px 10px rgba(35, 43, 66, 0.14); }
.ax-drop-main { margin: 8px 0 2px; font-size: var(--fs-base); font-weight: 600; color: var(--text); }
.ax-drop-sub { margin: 0; font-size: var(--fs-sm); }
.ax-preview { max-width: 100%; max-height: 260px; border-radius: var(--r-sm); display: block; margin: 0 auto; }
.ax-file { display: none; }

.ax-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 12px; }

.ax-err { display: flex; align-items: flex-start; gap: 6px; font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--danger-deep); background: var(--danger-soft); border: 1px solid var(--border-danger); border-radius: var(--r-sm); padding: 10px 12px; margin: 12px 0 0; }

.ax-result { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 14px; }
.ax-result-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: var(--fs-md); font-weight: 700; margin-bottom: 12px; }
.ax-selall { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; }
.ax-selall input { width: 15px; height: 15px; accent-color: var(--accent-hover); cursor: pointer; }
.ax-add { display: inline-flex; align-items: center; gap: 4px; background: none; border: 1px dashed var(--border-strong); color: var(--muted); font-size: var(--fs-sm); padding: 4px 9px; border-radius: var(--r-sm); cursor: pointer; }
.ax-add:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-hover); }
.ax-add:disabled { opacity: 0.5; cursor: default; }

.ax-card { position: relative; display: flex; align-items: flex-start; gap: 10px; padding: 12px 12px 2px; border: 1px solid var(--card-border); border-radius: var(--r-md); margin-bottom: 10px; background: var(--card-soft); transition: opacity 0.15s; }
.ax-card.off { opacity: 0.72; }
.ax-card.dup { border-color: var(--border-danger); background: var(--danger-soft); }
.ax-dup { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs); font-weight: 700; color: var(--danger-deep); background: var(--card); border: 1px solid var(--border-danger); border-radius: var(--r-xs); padding: 2px 7px; margin-bottom: 10px; }

.ax-group { margin-bottom: 16px; }
.ax-group-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: var(--fs-sm); font-weight: 700; color: var(--text-soft); margin-bottom: 8px; }
.ax-group-hd em { font-style: normal; color: var(--accent-hover); background: var(--accent-soft); padding: 0 7px; border-radius: var(--r-pill); font-size: var(--fs-xs); margin-left: 6px; }
.ax-group-empty { margin: 0 0 8px; font-size: var(--fs-sm); color: var(--muted); border: 1px dashed var(--border-strong); border-radius: var(--r-sm); padding: 10px 12px; text-align: center; }
.ax-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0 12px; }
.ax-grid .ax-field { margin-bottom: 10px; }
.ax-grid .ax-field.bool { display: flex; align-items: center; gap: 8px; }
.ax-grid .ax-field.bool > span { margin-bottom: 0; }
.ax-bool { width: 16px; height: 16px; accent-color: var(--accent-hover); cursor: pointer; }
.ax-check { flex: none; width: 16px; height: 16px; margin-top: 26px; accent-color: var(--accent-hover); cursor: pointer; }
.ax-idx { flex: none; width: 22px; height: 22px; margin-top: 24px; display: grid; place-items: center; border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-hover); font-size: var(--fs-sm); font-weight: 700; }
.ax-card-body { flex: 1; min-width: 0; }
.ax-del { flex: none; margin-top: 22px; background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px; border-radius: var(--r-sm); }
.ax-del:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
.ax-del:disabled { opacity: 0.5; cursor: default; }

.ax-field { display: block; margin-bottom: 12px; }
.ax-field > span { display: block; font-size: var(--fs-sm); color: var(--muted); margin-bottom: 6px; font-weight: 600; }
.ax-field input, .ax-field textarea { width: 100%; padding: 9px 12px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; background: var(--card); color: var(--text); resize: vertical; box-sizing: border-box; }
.ax-field input:focus, .ax-field textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.ax-field input:disabled, .ax-field textarea:disabled { opacity: 0.75; background: var(--well); }

.ax-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }

@media (prefers-color-scheme: dark) {
  .ax-field input, .ax-field textarea { background: var(--card-raised); }
  .ax-card.dup { background: var(--danger-soft-deep); border-color: var(--border-danger); }
  .ax-drop.over { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .ax-dup { background: var(--danger-soft-deep); color: var(--danger-soft-text); }
  .ax-group-hd em { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .ai-trigger { background: var(--accent-soft-deep); border-color: var(--accent-deep); color: var(--accent-soft-text); }
}
</style>
