<script setup>
// 目标输入框（composer）：附件、指令、模型、工作域、发送，全部收在同一条横带上。
//
// 布局参考 DSH 的输入框：上方是正文与附件，底部一行是「加号、工作域胶囊、模型胶囊、发送」。
// 这里的每个入口都接真能力，不做装饰（旧版那个点开什么都不做的入口正是这次要消掉的）：
//   加号     系统文件选择（桌面走 Tauri 对话框，网页走 <input type=file>），拖拽与粘贴同样可用
//   指令     输入 "/" 就地弹出；每一项都有对应行为（选文件 / 新建 / 切换模型 / 导出日志 / 设置）
//   工作域   本轮运行携带的领域上下文（原来在输入框上方单独占一行，现在收进胶囊）
//   模型胶囊 改当前模型配置（多配置可切换，运行中改只影响下一次），显示上下文窗口与推理档位
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../ui/Icon.vue";
import { errText } from "../shared/errors.js";
import { isDesktop } from "../platform/env.js";
import { ATTACH_MAX, attachmentIcon, attachmentKind, formatBytes, mergeAttachments } from "../agent/attachments.js";
import {
  EFFORT_OPTIONS,
  contextWindowOf,
  effortLabelKey,
  modelsFor,
  normalizeEffort,
  providerLabel,
} from "../agent/modelCatalog.js";
import { loadModelList, saveModelChoice } from "../agent/modelPrefs.js";

const props = defineProps({
  goal: { type: String, default: "" },
  attachments: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  aiReady: { type: Boolean, default: false },
  domains: { type: Array, default: () => [] },
  contextDomain: { type: String, default: "" },
  // 选中工作域时的上下文预览（「云仓 · 2 个代码池」），挂在胶囊的 title 上
  contextNote: { type: String, default: "" },
  placeholder: { type: String, default: "" },
  // 模型三件套由视图持有（它是 settings.ai 的展示副本），组件只负责改与回报
  modelName: { type: String, default: "" },
  modelBase: { type: String, default: "" },
  effort: { type: String, default: "" },
  // 已保存的多套模型配置（不含密钥）；超过一套时弹层里出现「模型配置」切换区
  profiles: { type: Array, default: () => [] },
  profileId: { type: String, default: "" },
});

const emit = defineEmits([
  "update:goal",
  "update:attachments",
  "update:contextDomain",
  "submit",
  "stop",
  "new-task",
  "export-run",
  "open-settings",
  "model-changed",
  "create-domain",
  "toast",
]);

const { t } = useI18n();

const shellEl = ref(null);
const goalEl = ref(null);
const fileEl = ref(null);
const menuOpen = ref(false);
const modelOpen = ref(false);
const domainOpen = ref(false);
const activeIndex = ref(0);
const dragActive = ref(false);
const focused = ref(false);
const reading = ref(false);
const modelSaving = ref(false);
const customDraft = ref("");
let dragDepth = 0;

// ---------- 指令 ----------
// 命令清单是**唯一的入口表**：菜单与 "/" 共用同一份，避免两处各写一遍迟早对不上。
const COMMAND_DEFS = [
  { key: "file", group: "add", icon: "file", labelKey: "agent.cmdFile", hintKey: "agent.cmdFileHint", run: () => pickFiles() },
  { key: "folder", group: "add", icon: "folder", labelKey: "agent.cmdFolder", hintKey: "agent.cmdFolderHint", desktopOnly: true, run: () => pickFolder() },
  { key: "new", group: "cmd", icon: "plus", labelKey: "agent.cmdNew", hintKey: "agent.cmdNewHint", run: () => emit("new-task") },
  { key: "model", group: "cmd", icon: "sparkles", labelKey: "agent.cmdModel", hintKey: "agent.cmdModelHint", run: () => openModel() },
  { key: "export", group: "cmd", icon: "download", labelKey: "agent.cmdExport", hintKey: "agent.cmdExportHint", run: () => emit("export-run") },
  { key: "settings", group: "cmd", icon: "settings", labelKey: "agent.cmdSettings", hintKey: "agent.cmdSettingsHint", run: () => emit("open-settings") },
];
const GROUP_DEFS = [
  { key: "add", labelKey: "agent.cmdAdd" },
  { key: "cmd", labelKey: "agent.cmdGroup" },
];

const commands = computed(() => COMMAND_DEFS.filter((item) => !item.desktopOnly || isDesktop));

// "/mo" 这种完整斜杠写法才算唤起指令：正常句子里出现的 "/" 不应弹菜单
const slashQuery = computed(() => {
  const match = /^\/([a-zA-Z-]*)$/.exec(props.goal.trim());
  return match ? match[1].toLowerCase() : null;
});
const menuVisible = computed(() => menuOpen.value || slashQuery.value !== null);

const filtered = computed(() => {
  const query = slashQuery.value;
  if (query === null) return commands.value;
  return commands.value.filter((item) => {
    if (item.key.startsWith(query)) return true;
    return t(item.labelKey).toLowerCase().includes(query);
  });
});
const visibleGroups = computed(() => {
  const picked = filtered.value;
  const groups = [];
  for (const group of GROUP_DEFS) {
    const items = picked.filter((item) => item.group === group.key);
    if (!items.length) continue;
    groups.push({ ...group, items: items.map((item) => ({ ...item, index: picked.indexOf(item) })) });
  }
  return groups;
});
watch(
  () => filtered.value.length,
  () => {
    activeIndex.value = 0;
  }
);

// ---------- 工作域 ----------
const domainLabel = computed(() => props.domains.find((item) => item.id === props.contextDomain)?.name || t("agent.domainNone"));

// 新建工作域收在弹层里：没领域时原本只能去研发模块建完再回来，这个入口就是给那次往返兜底的。
// 创建交给视图（数据归它持有），成功后再关表单并绑定——失败时表单留着，输入不白写。
const domainCreating = ref(false);
const domainName = ref("");
const domainSaving = ref(false);

function startDomainCreate() {
  domainCreating.value = true;
  domainName.value = "";
  nextTick(() => shellEl.value?.querySelector(".domain-pop .dp-input")?.focus?.());
}
function cancelDomainCreate() {
  domainCreating.value = false;
  domainName.value = "";
}
function submitDomainCreate() {
  const name = domainName.value.trim();
  if (!name || domainSaving.value) return;
  domainSaving.value = true;
  emit("create-domain", { name }, (error, record) => {
    domainSaving.value = false;
    if (error || !record) return;
    domainCreating.value = false;
    domainName.value = "";
    domainOpen.value = false;
    emit("update:contextDomain", record.id);
  });
}
// 中文输入法里回车是「确认候选」，不能当提交（isComposing 为真时放行给输入法）
function onDomainNameEnter(event) {
  if (event.isComposing) return;
  event.preventDefault();
  submitDomainCreate();
}

// ---------- 模型 ----------
// 没填服务地址时不说「自定义端点」：那会让人以为已经配好了
const providerText = computed(() => (props.modelBase ? providerLabel(props.modelBase) : t("agent.modelProviderUnset")));
const displayModel = computed(() => props.modelName || t("agent.modelUnset"));
const profileName = computed(() => props.profiles.find((p) => p.id === props.profileId)?.name || "");
const modelCtx = computed(() => contextWindowOf(props.modelBase, props.modelName));
const effortText = computed(() => (normalizeEffort(props.effort) ? t(effortLabelKey(props.effort)) : ""));
const modelTitle = computed(() => [t("agent.modelTitle"), profileName.value, providerText.value, effortText.value].filter(Boolean).join(" · "));

// 端点返回的模型列表：打开弹层时按当前配置拉一次；失败保留内置候选/手动输入。
const remoteModels = ref([]);
const remoteLoading = ref(false);
const remoteError = ref("");
let remoteKey = "";
const modelChoices = computed(() => {
  const ids = [];
  const push = (id) => {
    const value = String(id || "").trim();
    if (value && !ids.includes(value)) ids.push(value);
  };
  for (const id of remoteModels.value) push(id);
  for (const item of modelsFor(props.modelBase)) push(item.id);
  const current = String(props.modelName || "").trim();
  if (current) {
    const at = ids.indexOf(current);
    if (at >= 0) ids.splice(at, 1);
    ids.unshift(current);
  }
  return ids.map((id) => ({ id, ctx: contextWindowOf(props.modelBase, id) }));
});

async function refreshRemoteModels({ force = false } = {}) {
  if (remoteLoading.value || !props.modelBase) return;
  const key = `${props.profileId}\u0000${props.modelBase}`;
  if (!force && remoteKey === key) return;
  remoteLoading.value = true;
  remoteError.value = "";
  try {
    remoteModels.value = await loadModelList({ profileId: props.profileId });
    remoteKey = key;
  } catch (error) {
    remoteError.value = errText(error);
    remoteKey = "";
  } finally {
    remoteLoading.value = false;
  }
}

const canSend = computed(() => !props.busy && props.goal.trim().length > 0);
const showHint = computed(() => focused.value && !props.busy && !menuVisible.value && !modelOpen.value && !domainOpen.value);

// 指令执行完把输入框里的 "/xxx" 清掉，否则命令已执行、提示词里却留下半条命令
function clearSlash() {
  if (slashQuery.value !== null) {
    emit("update:goal", "");
    nextTick(resize);
  }
}

function closeMenu() {
  menuOpen.value = false;
  clearSlash();
}

function toggleMenu() {
  modelOpen.value = false;
  closeDomain();
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) {
    activeIndex.value = 0;
    nextTick(resize);
  }
}

async function runCommand(item) {
  closeMenu();
  nextTick(() => goalEl.value?.focus());
  await item.run?.();
}

function moveActive(delta) {
  const total = filtered.value.length;
  if (!total) return;
  activeIndex.value = (activeIndex.value + delta + total) % total;
}

function runActive() {
  const item = filtered.value[activeIndex.value];
  if (item) runCommand(item);
}

// ---------- 附件 ----------
function notify(key, params) {
  emit("toast", key, params);
}

function reportRejected(rejected, browserOnly) {
  if (!rejected.length) return;
  const first = rejected[0];
  if (first.reason === "duplicate") return notify("agent.attachDuplicate", { name: first.name });
  if (first.reason === "limit") return notify("agent.attachLimit", { n: ATTACH_MAX });
  if (browserOnly) return notify("agent.attachTextOnly");
  notify(first.name ? "agent.attachInvalid" : "agent.attachInvalidPlain", { name: first.name });
}

function addAttachments(incoming, options = {}) {
  const result = mergeAttachments(props.attachments, incoming);
  if (result.added.length) emit("update:attachments", result.list);
  reportRejected(result.rejected, !!options.browserOnly);
  // 添加成功不再弹 toast：chip 当场出现就是反馈，再弹一条只会盖住刚要用到的输入框
  if (result.added.length) nextTick(() => goalEl.value?.focus());
  return result.added.length;
}

function removeAttachment(id) {
  emit(
    "update:attachments",
    props.attachments.filter((item) => item.id !== id)
  );
}

// 桌面端：路径 → 元信息（体积 / 是否目录）。inspect 失败不拦流程，路径本身就是能用的信息。
async function addPaths(paths, source) {
  const clean = (Array.isArray(paths) ? paths : [paths]).map((item) => String(item || "").trim()).filter(Boolean);
  if (!clean.length) return;
  reading.value = true;
  let infos = [];
  try {
    const { invoke } = await import("../platform/invoke.js");
    infos = await invoke("file_tool_inspect", { paths: clean });
  } catch {
    infos = [];
  } finally {
    reading.value = false;
  }
  const incoming = clean.map((path, index) => {
    const info = Array.isArray(infos) ? infos.find((item) => item && item.path === path) || infos[index] : null;
    return {
      path: info?.path || path,
      name: info?.name || undefined,
      size: info?.size,
      kind: info?.isDirectory ? "folder" : undefined,
      source,
    };
  });
  addAttachments(incoming);
}

// 网页端：File 没有真实路径，只能把文本内联；图片/二进制如实拒绝（模型读不到，附上也是假的）
async function addFiles(files, source) {
  const incoming = [];
  let rejected = 0;
  for (const file of files) {
    const kind = attachmentKind(file.name);
    if (kind !== "text") {
      rejected += 1;
      continue;
    }
    try {
      const content = await file.text();
      incoming.push({ name: file.name, size: file.size, kind, content, source });
    } catch {
      rejected += 1;
    }
  }
  if (incoming.length) addAttachments(incoming);
  // 桌面端与网页端失败原因不同：桌面端是「剪贴板里的文件没有本地路径」，网页端是「读不了二进制」。
  // 混选时文本照收、其余如实报掉，不静默丢弃。
  if (rejected) notify(isDesktop ? "agent.attachPasteDesktop" : "agent.attachTextOnly");
}

async function pickFiles() {
  if (isDesktop) {
    try {
      const { open } = await import("../platform/dialog.js");
      const picked = await open({ multiple: true, title: t("agent.attachDialog") });
      if (picked) await addPaths(Array.isArray(picked) ? picked : [picked], "picker");
    } catch (error) {
      notify("agent.attachFailed", { err: errText(error) });
    }
    return;
  }
  fileEl.value?.click();
}

async function pickFolder() {
  if (!isDesktop) return notify("agent.attachDesktopOnly");
  try {
    const { open } = await import("../platform/dialog.js");
    const picked = await open({ directory: true, multiple: false, title: t("agent.attachFolderDialog") });
    if (picked) await addPaths([picked], "picker");
  } catch (error) {
    notify("agent.attachFailed", { err: errText(error) });
  }
}

async function onFileInput(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (files.length) await addFiles(files, "picker");
}

function onPaste(event) {
  const files = Array.from(event.clipboardData?.files || []);
  if (!files.length) return;
  event.preventDefault();
  addFiles(files, "paste");
}

// 桌面端拖拽：Tauri 会拦下 HTML5 drop（拿不到路径），走 webview 的原生事件（见 platform/dnd.js）
let stopWatchDrop = null;
onMounted(async () => {
  if (!isDesktop) return;
  try {
    const { watchFileDrop } = await import("../platform/dnd.js");
    stopWatchDrop = await watchFileDrop({
      onFiles: (paths) => addPaths(paths, "drop"),
      onActive: (active) => {
        dragActive.value = !!active;
      },
    });
  } catch {
    // 拖拽是增强能力：注册失败不影响选择文件
  }
});

function onDragEnter(event) {
  if (isDesktop) return;
  if (!event.dataTransfer?.types?.includes("Files")) return;
  dragDepth += 1;
  dragActive.value = true;
}
function onDragOver(event) {
  if (isDesktop) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}
function onDragLeave() {
  if (isDesktop) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dragActive.value = false;
}
async function onDrop(event) {
  if (isDesktop) return;
  dragDepth = 0;
  dragActive.value = false;
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) await addFiles(files, "drop");
}

// ---------- 模型 / 工作域弹层 ----------
// 打开弹层时把焦点送进去：键盘用户不必再 Tab 一串才能改模型。
// 入口有两个（模型胶囊 / 斜杠指令），焦点逻辑只写这一份。
function focusModelPopover() {
  nextTick(() => {
    const first = shellEl.value?.querySelector(".model-pop .mp-item, .model-pop .mp-input");
    first?.focus?.();
  });
}
function toggleModel() {
  menuOpen.value = false;
  closeDomain();
  modelOpen.value = !modelOpen.value;
  if (modelOpen.value) {
    customDraft.value = props.modelName;
    focusModelPopover();
    refreshRemoteModels();
  }
}
function closeModel() {
  modelOpen.value = false;
}
function openModel() {
  closeDomain();
  menuOpen.value = false;
  modelOpen.value = true;
  customDraft.value = props.modelName;
  focusModelPopover();
  refreshRemoteModels();
}
function manageModels() {
  closeModel();
  emit("open-settings");
}

async function persistModel(patch) {
  modelSaving.value = true;
  try {
    const saved = await saveModelChoice(patch);
    emit("model-changed", saved);
    // 换配置 / 换模型 / 调档位是三件事：提示要说清到底改了什么
    const key = Object.prototype.hasOwnProperty.call(patch, "profileId")
      ? "agent.profileSwitched"
      : Object.prototype.hasOwnProperty.call(patch, "model")
        ? "agent.modelSaved"
        : "agent.effortSaved";
    notify(key, { model: saved.model, name: saved.profileName });
    return true;
  } catch (error) {
    notify("agent.modelSaveFail", { err: errText(error) });
    return false;
  } finally {
    modelSaving.value = false;
  }
}

async function chooseProfile(id) {
  if (!id || id === props.profileId) {
    closeModel();
    return;
  }
  // 切换配置会连带换端点与模型：父组件收到完整 choice 后重算胶囊与服务商
  if (await persistModel({ profileId: id })) closeModel();
}

async function chooseModel(id) {
  if (!id || id === props.modelName) {
    closeModel();
    return;
  }
  if (await persistModel({ model: id })) closeModel();
}

async function chooseEffort(value) {
  const next = normalizeEffort(value);
  if (next === normalizeEffort(props.effort)) return;
  await persistModel({ reasoningEffort: next });
}

async function applyCustom() {
  const value = customDraft.value.trim();
  if (!value) return;
  if (await persistModel({ model: value })) closeModel();
}

function toggleDomain() {
  menuOpen.value = false;
  modelOpen.value = false;
  domainOpen.value = !domainOpen.value;
  if (domainOpen.value) {
    nextTick(() => shellEl.value?.querySelector(".domain-pop .pop-item")?.focus?.());
  } else {
    cancelDomainCreate();
  }
}
// 弹层所有关闭路径共用：表单状态不跨次打开残留
function closeDomain() {
  domainOpen.value = false;
  cancelDomainCreate();
}
function chooseDomain(id) {
  emit("update:contextDomain", id);
  closeDomain();
}

function onDocPointerDown(event) {
  if (!shellEl.value) return;
  if (shellEl.value.contains(event.target)) return;
  menuOpen.value = false;
  modelOpen.value = false;
  closeDomain();
}

// 焦点在正文里时 Esc 也要能关掉弹层：模型弹层打开会把焦点拿走，但用户点回正文后
// 那段 keydown 就不经过弹层了，只靠弹层自己的 @keydown.esc 会漏。
function onDocKeydown(event) {
  if (event.key !== "Escape") return;
  if (!menuOpen.value && !modelOpen.value && !domainOpen.value) return;
  closeMenu();
  modelOpen.value = false;
  closeDomain();
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onDocKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeydown);
  try {
    stopWatchDrop?.();
  } catch {
    // 拖放注销失败不影响视图销毁（见 platform/dnd.js 的说明）
  }
});

// ---------- 输入与提交 ----------
function resize() {
  const el = goalEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 220) + "px";
}

function onInput(event) {
  emit("update:goal", event.target.value);
  resize();
}

function submit() {
  if (!canSend.value) return;
  emit("submit");
}

function onKeydown(event) {
  // 中文输入法选词的回车不能当成提交或选中
  if (event.isComposing) return;
  if (menuVisible.value) {
    if (event.key === "ArrowDown") return prevent(event, () => moveActive(1));
    if (event.key === "ArrowUp") return prevent(event, () => moveActive(-1));
    if (event.key === "Escape") return prevent(event, closeMenu);
    if (event.key === "Enter" && !event.shiftKey) return prevent(event, runActive);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !props.busy) {
    event.preventDefault();
    submit();
  }
}

function prevent(event, run) {
  event.preventDefault();
  run();
}

function onFocus() {
  focused.value = true;
  if (menuOpen.value) menuOpen.value = false;
}
function onBlur() {
  focused.value = false;
}

watch(
  () => props.goal,
  () => nextTick(resize)
);
onMounted(() => nextTick(resize));

defineExpose({
  focus() {
    goalEl.value?.focus();
  },
});
</script>

<template>
  <div
    ref="shellEl"
    class="goal-box"
    :class="{ 'is-busy': busy, 'is-drag': dragActive }"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div v-if="dragActive" class="drop-veil" aria-hidden="true">
      <Icon name="upload" :size="18" />
      <span>{{ t("agent.attachDropHint") }}</span>
    </div>

    <div v-if="attachments.length" class="att-row" role="list">
      <span v-for="item in attachments" :key="item.id" class="att" role="listitem">
        <Icon :name="attachmentIcon(item.kind)" :size="13" class="att-ico" />
        <span class="att-name" :title="item.path || item.name">{{ item.name }}</span>
        <span v-if="item.size" class="att-size">{{ formatBytes(item.size) }}</span>
        <button
          type="button"
          class="att-x"
          :aria-label="t('agent.attachRemove', { name: item.name })"
          @click="removeAttachment(item.id)"
        >
          <Icon name="x" :size="12" />
        </button>
      </span>
    </div>

    <textarea
      id="agent-goal"
      ref="goalEl"
      class="goal"
      rows="1"
      :value="goal"
      :aria-label="t('agent.goalLabel')"
      :placeholder="placeholder"
      role="combobox"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      :aria-expanded="menuVisible"
      :aria-controls="menuVisible ? 'agent-cmd-menu' : undefined"
      :aria-activedescendant="menuVisible && filtered.length ? 'ac-' + activeIndex : undefined"
      @input="onInput"
      @keydown="onKeydown"
      @focus="onFocus"
      @blur="onBlur"
      @paste="onPaste"
    ></textarea>

    <div class="toolbar">
      <div class="anchor">
        <button
          type="button"
          class="add-btn"
          :class="{ on: menuVisible, busy: reading }"
          :aria-label="t('agent.cmdMenu')"
          aria-haspopup="menu"
          :aria-expanded="menuVisible"
          @click="toggleMenu"
        >
          <Icon name="plus" :size="17" />
        </button>

        <div v-if="menuVisible" id="agent-cmd-menu" class="pop menu-pop" role="listbox" :aria-label="t('agent.cmdMenu')">
          <template v-for="group in visibleGroups" :key="group.key">
            <p class="pop-group">{{ t(group.labelKey) }}</p>
            <button
              v-for="item in group.items"
              :id="'ac-' + item.index"
              :key="item.key"
              type="button"
              class="pop-item"
              :data-cmd="item.key"
              role="option"
              :aria-selected="item.index === activeIndex"
              :class="{ active: item.index === activeIndex }"
              @mouseenter="activeIndex = item.index"
              @click="runCommand(item)"
            >
              <span class="pi-ico"><Icon :name="item.icon" :size="15" /></span>
              <span class="pi-label">{{ t(item.labelKey) }}</span>
              <span class="pi-hint">{{ t(item.hintKey) }}</span>
            </button>
          </template>
          <p v-if="!filtered.length" class="pop-empty">{{ t("agent.cmdEmpty") }}</p>
        </div>
      </div>

      <div class="anchor">
        <button
          type="button"
          class="mode-pill"
          :class="{ on: domainOpen }"
          :aria-expanded="domainOpen"
          :title="contextNote || t('agent.domainHint')"
          @click="toggleDomain"
        >
          <Icon name="layers" :size="13" />
          <span class="mode-text">{{ t("agent.domainPill", { name: domainLabel }) }}</span>
          <Icon name="chevron" :size="12" class="chev" />
        </button>

        <div
          v-if="domainOpen"
          class="pop domain-pop"
          role="dialog"
          :aria-label="t('agent.domain')"
          @keydown.esc.stop.prevent="domainOpen = false"
        >
          <p class="pop-group">{{ t("agent.domain") }}</p>
          <button
            type="button"
            class="pop-item"
            :class="{ active: !contextDomain }"
            @click="chooseDomain('')"
          >
            <span class="pi-ico"><Icon name="layers" :size="15" /></span>
            <span class="pi-label">{{ t("agent.domainNone") }}</span>
            <Icon v-if="!contextDomain" name="check" :size="14" class="pi-check" />
          </button>
          <button
            v-for="item in domains"
            :key="item.id"
            type="button"
            class="pop-item"
            :class="{ active: item.id === contextDomain }"
            @click="chooseDomain(item.id)"
          >
            <span class="pi-ico"><Icon name="layers" :size="15" /></span>
            <span class="pi-label">{{ item.name }}</span>
            <Icon v-if="item.id === contextDomain" name="check" :size="14" class="pi-check" />
          </button>
          <p v-if="!domains.length && !domainCreating" class="pop-empty">{{ t("agent.domainEmpty") }}</p>

          <form
            v-if="domainCreating"
            class="dp-form"
            @submit.prevent="submitDomainCreate"
            @keydown.esc.stop.prevent="cancelDomainCreate"
          >
            <input
              v-model="domainName"
              class="dp-input"
              type="text"
              maxlength="40"
              :placeholder="t('agent.domainNamePh')"
              :aria-label="t('agent.domainName')"
              autocomplete="off"
              data-role="domain-new-name"
              @keydown.enter="onDomainNameEnter"
            />
            <div class="dp-actions">
              <button type="button" class="dp-cancel" @click="cancelDomainCreate">{{ t("common.cancel") }}</button>
              <button
                type="submit"
                class="dp-create"
                :disabled="!domainName.trim() || domainSaving"
                data-role="domain-new-submit"
              >
                {{ domainSaving ? t("agent.domainCreating") : t("agent.domainCreate") }}
              </button>
            </div>
          </form>
          <button v-else type="button" class="pop-item dp-new" data-role="domain-new" @click="startDomainCreate">
            <span class="pi-ico"><Icon name="plus" :size="15" /></span>
            <span class="pi-label">{{ t("agent.domainNew") }}</span>
          </button>

          <p class="pop-note">{{ t("agent.domainNote") }}</p>
        </div>
      </div>

      <span class="toolbar-gap"></span>

      <span v-if="showHint" class="kbd-hint">{{ t("agent.kbdHint") }}</span>

      <div class="anchor anchor-right">
        <button
          type="button"
          class="model-btn"
          :class="{ on: modelOpen }"
          :aria-expanded="modelOpen"
          :title="modelTitle"
          aria-haspopup="dialog"
          @click="toggleModel"
        >
          <span class="model-name">{{ displayModel }}</span>
          <span v-if="modelCtx" class="ctx-badge">{{ modelCtx }}</span>
          <span v-if="effortText" class="effort-badge">{{ effortText }}</span>
          <Icon name="chevron" :size="12" class="chev" />
        </button>

        <div
          v-if="modelOpen"
          class="pop model-pop"
          role="dialog"
          :aria-label="t('agent.modelTitle')"
          @keydown.esc.stop.prevent="closeModel"
        >
          <div class="mp-head">
            <span class="mp-title">{{ t("agent.modelTitle") }}</span>
            <span class="mp-head-right">
              <span class="mp-prov">{{ providerText }}</span>
              <button
                type="button"
                class="mp-refresh"
                :title="t('agent.modelRefresh')"
                :aria-label="t('agent.modelRefresh')"
                :disabled="remoteLoading"
                data-role="model-refresh"
                @click="refreshRemoteModels({ force: true })"
              >
                <Icon name="refresh" :size="13" />
              </button>
            </span>
          </div>
          <p v-if="busy" class="pop-note" data-role="model-next-run">{{ t("agent.modelNextRunNote") }}</p>
          <p v-if="remoteLoading" class="pop-note">{{ t("agent.modelRemoteLoading") }}</p>
          <p v-else-if="remoteError" class="pop-note">{{ t("agent.modelRemoteFail", { err: remoteError }) }}</p>
          <p v-if="!aiReady" class="mp-warn">{{ t("agent.modelNeedSetup") }}</p>

          <!-- 多套配置时才出现：单模型用户不该看到多一层选择 -->
          <div v-if="profiles.length > 1" class="mp-block">
            <p class="pop-group">{{ t("agent.modelProfiles") }}</p>
            <div class="mp-list" role="radiogroup" :aria-label="t('agent.modelProfiles')">
              <button
                v-for="item in profiles"
                :key="item.id"
                type="button"
                class="mp-item"
                role="radio"
                :aria-checked="item.id === profileId"
                :class="{ on: item.id === profileId }"
                :disabled="modelSaving"
                data-role="profile-choice"
                @click="chooseProfile(item.id)"
              >
                <span class="mp-name">{{ item.name }}</span>
                <span v-if="item.model && item.model !== item.name" class="mp-profile-model">{{ item.model }}</span>
                <Icon v-if="item.id === profileId" name="check" :size="14" class="mp-check" />
              </button>
            </div>
          </div>

          <div class="mp-list" role="radiogroup" :aria-label="t('agent.modelTitle')">
            <button
              v-for="item in modelChoices"
              :key="item.id"
              type="button"
              class="mp-item"
              role="radio"
              :aria-checked="item.id === modelName"
              :class="{ on: item.id === modelName }"
              @click="chooseModel(item.id)"
            >
              <span class="mp-name">{{ item.id }}</span>
              <span v-if="item.ctx" class="ctx-badge">{{ item.ctx }}</span>
              <Icon v-if="item.id === modelName" name="check" :size="14" class="mp-check" />
            </button>
            <p v-if="!modelChoices.length && modelBase" class="pop-empty">{{ t("agent.modelNoPreset") }}</p>
          </div>

          <div class="mp-block">
            <p class="pop-group">{{ t("agent.modelEffort") }}</p>
            <div class="effort-grid" role="radiogroup" :aria-label="t('agent.modelEffort')">
              <button
                v-for="opt in EFFORT_OPTIONS"
                :key="opt.value || 'default'"
                type="button"
                class="effort-chip"
                role="radio"
                :aria-checked="normalizeEffort(effort) === opt.value"
                :class="{ on: normalizeEffort(effort) === opt.value }"
                :disabled="modelSaving"
                @click="chooseEffort(opt.value)"
              >
                {{ t(opt.labelKey) }}
              </button>
            </div>
            <p class="pop-note">{{ t("agent.effortNote") }}</p>
          </div>

          <form class="mp-custom" @submit.prevent="applyCustom">
            <input
              v-model="customDraft"
              class="mp-input"
              type="text"
              :placeholder="t('agent.modelCustomPh')"
              :aria-label="t('agent.modelCustom')"
              autocomplete="off"
              spellcheck="false"
            />
            <button type="submit" class="mp-apply" :disabled="!customDraft.trim() || modelSaving">
              {{ t("agent.modelApply") }}
            </button>
          </form>

          <p class="pop-note">{{ t("agent.modelScopeNote") }}</p>
          <button type="button" class="mp-manage" @click="manageModels">{{ t("agent.modelManage") }}</button>
        </div>
      </div>

      <button v-if="busy" type="button" class="send-btn is-stop" :aria-label="t('agent.stop')" @click="$emit('stop')">
        <Icon name="square" :size="13" />
      </button>
      <button v-else type="button" class="send-btn" :disabled="!canSend" :aria-label="t('agent.run')" @click="submit">
        <Icon name="arrow-up" :size="17" />
      </button>
    </div>

    <input ref="fileEl" class="file-input" type="file" multiple tabindex="-1" aria-hidden="true" @change="onFileInput" />
  </div>
</template>

<style scoped>
/* 形状规则（全组件一份）：外层容器 16 / 弹层 12 / 胶囊控件全圆角 / 附件 chip 全圆角。
   混用圆角是最容易显脏的地方，所以这里先立规矩再写样式。 */
.goal-box {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-4) var(--sp-4) var(--sp-2);
  background: var(--card);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--text) 5%, transparent);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.goal-box:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft), 0 2px 10px color-mix(in srgb, var(--text) 5%, transparent);
}
.goal-box.is-drag { border-color: var(--primary); }

/* 拖拽蒙层：只做提示，不抢事件（pointer-events: none 让 drop 仍落在容器上） */
.drop-veil {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  color: var(--primary);
  background: color-mix(in srgb, var(--primary-soft) 92%, transparent);
  border: 2px dashed var(--primary);
  border-radius: inherit;
  font-size: var(--fs-md);
  font-weight: 600;
  pointer-events: none;
}

/* ---------- 附件 chips ---------- */
.att-row { display: flex; flex-wrap: wrap; gap: var(--sp-2); padding-bottom: var(--sp-0); }
.att {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  max-width: 260px;
  height: 26px;
  padding: 0 4px 0 var(--sp-2);
  color: var(--text-weak);
  background: var(--card-soft);
  border: 1px solid var(--card-border);
  border-radius: var(--r-pill);
  font-size: var(--fs-sm);
}
.att-ico { color: var(--muted); }
.att-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.att-size { flex-shrink: 0; color: var(--muted); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.att-x {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  color: var(--muted);
  background: transparent;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.att-x:hover { color: var(--fail-deep); background: var(--fail-soft); }
.att-x:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

/* ---------- 正文 ---------- */
.goal {
  width: 100%;
  min-height: 26px;
  max-height: 220px;
  padding: 2px var(--sp-1) 0;
  font-family: inherit;
  font-size: var(--fs-base);
  line-height: var(--lh-body);
  color: var(--text);
  background: transparent;
  border: 0;
  resize: none;
  overflow-y: auto;
}
.goal::placeholder { color: var(--muted); }
.goal:focus { outline: none; }

/* ---------- 底部一行 ---------- */
.toolbar { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.toolbar-gap { flex: 1; min-width: var(--sp-2); }
.anchor { position: relative; display: inline-flex; min-width: 0; }
.anchor-right .pop { left: auto; right: 0; }

.add-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--text-weak);
  background: var(--well);
  border: 1px solid transparent;
  border-radius: 999px;
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast), transform var(--dur-fast);
}
.add-btn:hover { color: var(--text); background: var(--well-hover); border-color: var(--border); }
.add-btn:active { transform: translateY(1px); }
.add-btn.on { color: var(--primary); background: var(--primary-soft); border-color: var(--border-blue); }
.add-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.add-btn.busy .icon { animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }

.mode-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  max-width: 220px;
  padding: 0 var(--sp-2) 0 var(--sp-3);
  color: var(--text-weak);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-family: inherit;
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
}
.mode-pill:hover { color: var(--text); background: var(--card-soft); border-color: var(--border-strong); }
.mode-pill.on { color: var(--primary); background: var(--primary-soft); border-color: var(--border-blue); }
.mode-pill:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.mode-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chev { flex-shrink: 0; opacity: 0.7; }

.kbd-hint {
  flex-shrink: 0;
  padding-right: var(--sp-1);
  color: var(--muted);
  font-size: var(--fs-xs);
  white-space: nowrap;
}

.model-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  height: 30px;
  max-width: 320px;
  padding: 0 var(--sp-2) 0 var(--sp-3);
  color: var(--text-weak);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 999px;
  font-family: inherit;
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
}
.model-btn:hover { color: var(--text); background: var(--card-soft); border-color: var(--border); }
.model-btn.on { color: var(--text); background: var(--card-soft); border-color: var(--border-strong); }
.model-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }

/* 上下文窗口徽标：与 DSH 的模型胶囊同位同义（告诉人这个模型能装多少） */
.ctx-badge {
  flex-shrink: 0;
  padding: 1px var(--sp-1);
  color: var(--primary);
  background: var(--primary-soft);
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.effort-badge {
  flex-shrink: 0;
  color: var(--teal-deep);
  font-size: var(--fs-xs);
  font-weight: 600;
}

.send-btn {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--text-invert);
  background: var(--primary);
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  transition: background var(--dur-fast), transform var(--dur-fast), color var(--dur-fast);
}
.send-btn:hover:not(:disabled) { background: var(--primary-hover); }
.send-btn:active:not(:disabled) { transform: translateY(1px); }
.send-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.send-btn:disabled { color: var(--muted); background: var(--well); cursor: not-allowed; }
.send-btn.is-stop { color: var(--fail-deep); background: var(--fail-soft); }
.send-btn.is-stop:hover { background: var(--fail); color: var(--text-invert); }

.file-input { display: none; }

/* ---------- 弹层 ---------- */
.pop {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 0;
  z-index: var(--z-raised);
  min-width: 260px;
  max-width: min(360px, 88vw);
  max-height: min(60vh, 420px);
  overflow: auto;
  padding: var(--sp-1);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
}
.pop-group {
  margin: 0;
  padding: var(--sp-2) var(--sp-2) 4px;
  color: var(--muted);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
}
.pop-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: 7px var(--sp-2);
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  font-family: inherit;
  font-size: var(--fs-md);
  text-align: left;
  cursor: pointer;
}
.pop-item:hover, .pop-item.active { background: var(--well); }
.pop-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.pi-ico { flex-shrink: 0; color: var(--muted); }
.pi-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pi-hint {
  flex-shrink: 0;
  max-width: 132px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: var(--fs-xs);
}
.pi-check { flex-shrink: 0; color: var(--primary); }
.pop-empty {
  margin: 0;
  padding: var(--sp-3) var(--sp-2);
  color: var(--muted);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}
.pop-note {
  margin: 0;
  padding: var(--sp-2) var(--sp-2) var(--sp-1);
  color: var(--muted);
  font-size: var(--fs-xs);
  line-height: var(--lh-body);
}

/* ---------- 工作域弹层 ---------- */
.domain-pop { width: 300px; }
.dp-new { color: var(--primary); }
.dp-new:hover { background: var(--primary-soft); }
.dp-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-0);
  padding: var(--sp-2);
  border-top: 1px solid var(--card-border);
}
.dp-input {
  height: 30px;
  padding: 0 var(--sp-2);
  color: var(--text);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-family: inherit;
  font-size: var(--fs-sm);
}
.dp-input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-soft); }
.dp-actions { display: flex; justify-content: flex-end; gap: var(--sp-1); }
.dp-cancel,
.dp-create {
  height: 26px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-sm);
  font-family: inherit;
  font-size: var(--fs-sm);
  cursor: pointer;
}
.dp-cancel { color: var(--text-weak); background: var(--card-soft); border: 1px solid var(--card-border); }
.dp-cancel:hover { color: var(--text); border-color: var(--border-strong); }
.dp-create {
  color: var(--text-invert);
  background: var(--primary);
  border: 1px solid var(--primary);
  font-weight: 600;
}
.dp-create:hover:not(:disabled) { background: var(--primary-hover); border-color: var(--primary-hover); }
.dp-create:disabled { color: var(--muted); background: var(--well); border-color: var(--card-border); cursor: not-allowed; }
.dp-cancel:focus-visible,
.dp-create:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

/* ---------- 模型弹层 ---------- */
.model-pop { width: 344px; padding: var(--sp-3); }
.mp-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); padding: 0 2px var(--sp-2); }
.mp-title { font-size: var(--fs-md); font-weight: 650; color: var(--text); }
.mp-head-right { display: inline-flex; align-items: center; gap: var(--sp-1); }
.mp-prov { font-size: var(--fs-xs); color: var(--muted); }
.mp-refresh { display: grid; place-items: center; width: 22px; height: 22px; padding: 0; color: var(--muted); background: transparent; border: 1px solid transparent; border-radius: var(--r-xs); cursor: pointer; }
.mp-refresh:hover { color: var(--primary-hover); background: var(--primary-soft); }
.mp-refresh:disabled { opacity: 0.5; cursor: default; }
.mp-warn {
  margin: 0 0 var(--sp-2);
  padding: var(--sp-2);
  color: var(--wait-deep);
  background: var(--wait-soft);
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  line-height: var(--lh-body);
}
.mp-list { display: flex; flex-direction: column; gap: var(--sp-0); }
.mp-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: 7px var(--sp-2);
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
}
.mp-item:hover { background: var(--well); }
.mp-item.on { background: var(--primary-soft); }
.mp-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.mp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-profile-model { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); }
.mp-check { flex-shrink: 0; color: var(--primary); }
.mp-block { margin-top: var(--sp-2); border-top: 1px solid var(--card-border); padding-top: var(--sp-1); }
.effort-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-05); }
.effort-chip {
  padding: var(--sp-1) var(--sp-05);
  color: var(--text-weak);
  background: var(--card-soft);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  font-family: inherit;
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
}
.effort-chip:hover { color: var(--text); border-color: var(--border-strong); }
.effort-chip.on { color: var(--primary); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }
.effort-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.mp-custom { display: flex; gap: var(--sp-1); margin-top: var(--sp-2); }
.mp-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 var(--sp-2);
  color: var(--text);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.mp-input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-soft); }
.mp-apply {
  flex-shrink: 0;
  height: 30px;
  padding: 0 var(--sp-3);
  color: var(--text-invert);
  background: var(--primary);
  border: 0;
  border-radius: var(--r-sm);
  font-family: inherit;
  font-size: var(--fs-sm);
  font-weight: 600;
  cursor: pointer;
}
.mp-apply:hover:not(:disabled) { background: var(--primary-hover); }
.mp-apply:disabled { color: var(--muted); background: var(--well); cursor: not-allowed; }
.mp-manage {
  margin-top: var(--sp-2);
  padding: var(--sp-2) 2px 2px;
  width: 100%;
  color: var(--primary);
  background: transparent;
  border: 0;
  border-top: 1px solid var(--card-border);
  font-family: inherit;
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
}
.mp-manage:hover { color: var(--primary-hover); }

/* ---------- 窄容器：先丢提示，再收胶囊 ---------- */
@container agent (max-width: 640px) {
  .kbd-hint { display: none; }
  /* 132px 会把「工作域：不指定」掐成「工作域：不…」——比不给前缀还难读。
     留到 170px 能放下 3 个汉字的领域名，再长的仍然截断（title 里有全名）。 */
  .mode-pill { max-width: 170px; }
  .model-btn { max-width: 210px; }
}
@container agent (max-width: 480px) {
  .mode-text { display: none; }
  .mode-pill { padding: 0 var(--sp-2); }
  .goal-box { padding: var(--sp-3) var(--sp-3) 6px; }
}

@media (prefers-reduced-motion: reduce) {
  .goal-box, .add-btn, .mode-pill, .model-btn, .send-btn, .att-x, .effort-chip { transition: none; }
  .add-btn.busy .icon { animation: none; }
}
</style>
