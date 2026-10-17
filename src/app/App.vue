<script setup>
import { ref, computed, onMounted, onUnmounted, provide, nextTick, defineAsyncComponent, watch } from "vue";
import { invoke } from "../platform/invoke.js";
import { getCurrentWindow } from "../platform/window.js";
import { listen } from "../platform/events.js";
import { openUrl } from "../platform/shell.js";
import { isDesktop, capabilities } from "../platform/env.js";
import { useI18n } from "vue-i18n";
import Icon from "../ui/Icon.vue";
import { fmtDate } from "../shared/dates.js";
import { normalizeHiddenModules } from "./settingsConfig.js";
import { shouldPrompt, consent as telemetryConsent, track as telemetryTrack, flush as telemetryFlush, getConfig as telemetryGetConfig, invalidateConfigCache as telemetryInvalidateCache } from "./telemetry.js";
import { applyAccent, resetAccent, loadAccentKey } from "./accentTheme.js";
import { getThemeMode, setThemeMode, syncThemeAttribute, nextThemeMode, isDarkEffective } from "./theme.js";
import { getDensity, setDensity, getSidebarCollapsed, setSidebarCollapsed } from "./theme.js";
import { checkForUpdate } from "./updater.js";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import { askConfirm } from "../ui/confirm.js";
import ToolWindow from "./ToolWindow.vue";
import ToolboxView from "../views/ToolboxView.vue";
import GlobalSearch from "../views/GlobalSearch.vue";
import ModuleTabs from "./ModuleTabs.vue";
import { NAV_MODULES, MODULE_TABS, MODULE_HOME_TAB, resolveNavTarget, migrateHiddenModulesV2 } from "./navConfig.js";
import { groupNavModules } from "./taskListItems.js";
import { startCheckInScheduler, stopCheckInScheduler } from "../checkin/index.js";
import { startWeeklyScheduler, stopWeeklyScheduler } from "../report/index.js";

const { t } = useI18n();

// ------- 导航分层（二期重构）：侧边栏 = 新任务 + 任务列表（agent 历史）+「工作面」分组 -------
// NAV_MODULES 数组本身不变：深链与 Ctrl+1..5 热键语义不动（Ctrl+1 仍回 agent 主区）。
// 配置与旧 key 映射见 navConfig.js，任务列表/工作面分组的投影见 taskListItems.js（均纯函数单测覆盖）
const MODULES = NAV_MODULES;

// 侧边栏主体（新任务按钮 + 任务行 + 后台任务监控条）。
// 异步加载的理由与所有模块视图一致：它要读 agentSession 单例，
// 静态 import 会把整个 agent 引擎拖进外壳的 entry chunk（详见组件内注释）。
const AgentSidePanel = defineAsyncComponent(() => import("./AgentSidePanel.vue"));

// 正在回看的历史 run id：只驱动侧边栏行高亮，回看状态本体在 AgentView 里
const viewingRunId = ref("");

// 任务列表跳转：复用 jump 深链机制（activeJump 只认 module/tab 坐标，action/runId 原样透传给 AgentView）
function onNewTask() {
  viewingRunId.value = "";
  activeModule.value = "agent";
  jump.value = { module: "agent", tab: null, action: "new", ts: Date.now() };
}
function onViewTask(runId) {
  viewingRunId.value = runId;
  activeModule.value = "agent";
  jump.value = { module: "agent", tab: null, action: "view", runId, ts: Date.now() };
}

// 工具箱工具独立窗口模式（URL 携带 ?tool=xxx 时只渲染工具窗口）
const toolMode = new URLSearchParams(window.location.search).get("tool") || "";
// 截图贴图窗（?shot=pin）：短命窗口，由 Rust 直接拉起，只渲染贴图页；
// 主窗口的定时任务（备份/更新/签到/遥测）一律不参与。
// （截图遮罩已是 Rust 原生窗口，不再有 WebView 页面）
const shotMode = new URLSearchParams(window.location.search).get("shot") || "";
const ScreenshotPin = defineAsyncComponent(() => import("../screenshot/PinApp.vue"));
const shotPage = computed(() => (shotMode === "pin" ? ScreenshotPin : null));
let toolWindowShown = false;
async function revealToolWindow() {
  if (!toolMode || toolWindowShown || !isTauri) return;
  toolWindowShown = true;
  try {
    await applyTheme(themeMode.value);
    await nextTick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  } catch {
    toolWindowShown = false;
  }
}

// ------- 状态 -------
const activeModule = ref("agent");
// 各模块记住自己停留的 Tab（不入 settings：纯会话内状态，重启回默认 Tab）
const moduleTabs = ref({ ...MODULE_HOME_TAB });
const activeTab = computed(() => (MODULE_TABS[activeModule.value] ? moduleTabs.value[activeModule.value] : null));
// 侧边栏默认展开，用户的收起动作持久化（见 theme.js 的 getSidebarCollapsed 注释：
// 存 localStorage 而不是 settings.json，因为它必须首帧同步可读，否则启动会闪一下）
const collapsed = ref(getSidebarCollapsed());
watch(collapsed, (value) => setSidebarCollapsed(value));
// 窄窗自动收为图标轨道；临时展开不覆盖桌面端的持久化偏好。
const sidebarMedia = window.matchMedia?.("(max-width: 760px)");
const narrowSidebar = ref(sidebarMedia?.matches || false);
const narrowExpanded = ref(false);
const sidebarCollapsed = computed(() => narrowSidebar.value ? !narrowExpanded.value : collapsed.value);
function onSidebarMediaChange(event) {
  narrowSidebar.value = event.matches;
  narrowExpanded.value = false;
}
function toggleSidebar() {
  if (narrowSidebar.value) narrowExpanded.value = !narrowExpanded.value;
  else collapsed.value = !collapsed.value;
}
function expandSidebar() {
  if (narrowSidebar.value) narrowExpanded.value = true;
  else collapsed.value = false;
}
// 窄窗的临时展开是抽屉：点主区即收起（与 Escape、收起按钮等效），不落任何持久化偏好。
function onMainClick() {
  if (narrowSidebar.value && narrowExpanded.value) narrowExpanded.value = false;
}
onMounted(() => sidebarMedia?.addEventListener("change", onSidebarMediaChange));
onUnmounted(() => sidebarMedia?.removeEventListener("change", onSidebarMediaChange));
const toast = ref(null);
// 视图埋点（节流 10s；可选遥测未开启时只本地计数）
let viewTrackTs = {};
watch([activeModule, activeTab], ([key, tab]) => {
  const view = tab ? `${key}.${tab}` : key;
  const now = Date.now();
  if (now - (viewTrackTs[view] || 0) < 10000) return;
  viewTrackTs[view] = now;
  telemetryTrack("view." + view);
});
const jump = ref(null);
const gsRef = ref(null);

const WelcomeView = defineAsyncComponent(() => import("../views/WelcomeView.vue"));
const AgentView = defineAsyncComponent(() => import("../views/AgentView.vue"));
const WorkOverviewView = defineAsyncComponent(() => import("../views/WorkOverviewView.vue"));
const DomainView = defineAsyncComponent(() => import("../views/DomainView.vue"));
const TaskView = defineAsyncComponent(() => import("../views/TaskView.vue"));
const SnippetView = defineAsyncComponent(() => import("../views/SnippetView.vue"));
const ProblemView = defineAsyncComponent(() => import("../views/ProblemView.vue"));
const SettingsView = defineAsyncComponent(() => import("../views/SettingsView.vue"));
const IterationView = defineAsyncComponent(() => import("../views/IterationView.vue"));
const RequirementBoardView = defineAsyncComponent(() => import("../views/RequirementBoardView.vue"));
const ReleaseView = defineAsyncComponent(() => import("../views/ReleaseView.vue"));
// Tab key → 组件；无 Tab 的模块（agent/toolbox/settings）直接渲染
const TAB_COMPONENTS = { overview: WorkOverviewView, domain: DomainView, iteration: IterationView, requirement: RequirementBoardView, release: ReleaseView, task: TaskView, snippet: SnippetView, problem: ProblemView };
const PLAIN_COMPONENTS = { agent: AgentView, toolbox: ToolboxView, settings: SettingsView };
const activeTabs = computed(() => (MODULE_TABS[activeModule.value] || []).map((x) => ({ ...x, comp: TAB_COMPONENTS[x.key] })));
const plainViewComp = computed(() => PLAIN_COMPONENTS[activeModule.value] || WelcomeView);
// 深链只在「模块 + Tab + 条目」全命中时下发给视图；用户手动切走后自动失效
const activeJump = computed(() => {
  const j = jump.value;
  if (!j) return null;
  return j.module === activeModule.value && (j.tab || null) === (activeTab.value || null) ? j : null;
});

const settingsSection = ref("general");
function openSettings(section) {
  activeModule.value = "settings";
  settingsSection.value = section;
}
provide("openSettings", openSettings);

// 界面设置（密度 + 侧边栏模块展示/隐藏，设置里可切换；紧凑为默认）
// 密度通过 src/app/theme.js 落到 <html data-density> 上，而不是挂在 .shell 的类名上：
// 独立工具窗口（ToolWindow 的 .tool-win）不在 .shell 内，绑类名时"界面密度"
// 对工具窗口完全无效（审计实测）。属性挂在 :root 上则任何容器都能继承。
const density = ref(getDensity());
const hiddenModules = ref([]); // 设置里隐藏的模块 key；隐藏只是不展示，全局搜索仍可达
const visibleModules = computed(() => MODULES.filter((m) => !hiddenModules.value.includes(m.key)));
// 「工作面」分组按钮（work/records/toolbox；agent 永不入组也不可隐藏，语义见 taskListItems.js）
const workspaceModules = computed(() => groupNavModules(MODULES, hiddenModules.value));
// 切走 agent 模块后回看高亮失效（AgentView 被 :key 销毁，回看状态随之复位）
watch(activeModule, (m) => {
  if (m !== "agent") viewingRunId.value = "";
});
async function refreshUiSettings() {
  try {
    const s = (await invoke("load_data", { key: "settings" })) || {};
    density.value = s.ui?.density === "comfort" ? "comfort" : "compact";
    setDensity(density.value);
    // migrateHiddenModulesV2 兜底：v9 迁移已清过盘，但 settings-saved 事件路径上
    // 仍可能出现脏值（如旧版本回写），agent 被藏会把默认主区弄丢，这里再剔一次
    hiddenModules.value = migrateHiddenModulesV2(normalizeHiddenModules(MODULES.map((m) => m.key), s.ui?.hiddenModules));
    // 当前所在模块被隐藏时切到第一个可见模块，避免侧边栏失去选中高亮
    if (MODULES.some((m) => m.key === activeModule.value) && hiddenModules.value.includes(activeModule.value) && visibleModules.value.length) {
      activeModule.value = visibleModules.value[0].key;
    }
  } catch (e) {}
}

// 保存设置后刷新界面设置（密度 / 侧边栏模块展示）
function onSettingsSaved() {
  refreshUiSettings();
  telemetryInvalidateCache();
  telemetryFlush().catch(() => {}); // 设置保存即冲刷待发计数（P1-1 flush 时机②）
  applyThemeAccent();
}

// ------- 操作手册 -------
const MANUAL_URL = "https://github.com/GitHub-lcb/ToolCove"; // M4 上线文档站后替换
function openManual() {
  openUrl(MANUAL_URL).catch((e) => showToast(String(e)));
}

// ------- 自定义标题栏（decorations:false，顶栏自绘窗口控制） -------
const isTauri = isDesktop;
const isMaximized = ref(false);
async function refreshMaximized() {
  try {
    isMaximized.value = await getCurrentWindow().isMaximized();
  } catch (e) {
    /* 非 Tauri 环境忽略 */
  }
}
function winMinimize() { getCurrentWindow().minimize().catch(() => {}); }
function winToggleMax() { getCurrentWindow().toggleMaximize().catch(() => {}); }
function winClose() { getCurrentWindow().close().catch(() => {}); }
let unlistenResize = null;
onMounted(async () => {
  if (!isTauri) return;
  refreshMaximized();
  try {
    unlistenResize = await getCurrentWindow().onResized(() => {
      refreshMaximized();
      forceWebviewReflow();
    });
  } catch (e) {}
});
// WebView2 偶发 resize 后不重绘：class 切换 + 读 offsetWidth 强制重排
function forceWebviewReflow() {
  requestAnimationFrame(() => {
    const el = document.documentElement;
    el.classList.remove("win-resized");
    void el.offsetWidth;
    el.classList.add("win-resized");
  });
}
onUnmounted(() => unlistenResize && unlistenResize());

// ------- 提示（支持带撤销等动作按钮） -------
let toastTimer = null;
let toastAction = null;
let toastExpire = null;
const toastWaiting = [];
const TOAST_QUEUE_MAX = 5;

function showToast(msg, opts = {}) {
  // 撤销窗口还开着时，后来的提示一律排队。旧实现让新提示直接顶掉旧的，代价是
  // 撤销按钮无声消失、且旧提示的 onExpire 当场执行（问题/速记用它物理删附件图片）——
  // 用户既来不及撤销，也不会意识到文件已经没了。
  if (toastExpire) {
    if (toastWaiting.length < TOAST_QUEUE_MAX) toastWaiting.push({ msg, opts });
    return;
  }
  displayToast(msg, opts);
}

function displayToast(msg, opts) {
  toast.value = { text: msg, actionLabel: opts.actionLabel || "" };
  toastAction = opts.onAction || null;
  toastExpire = opts.onExpire || null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, opts.duration || (opts.actionLabel ? 5000 : 2200));
}

function nextQueuedToast() {
  const next = toastWaiting.shift();
  if (next) displayToast(next.msg, next.opts);
}

function dismissToast() {
  toast.value = null;
  toastAction = null;
  if (toastExpire) {
    const f = toastExpire;
    toastExpire = null;
    f();
  }
  nextQueuedToast();
}
function onToastAction() {
  clearTimeout(toastTimer);
  const f = toastAction;
  toastAction = null;
  toastExpire = null;
  toast.value = null;
  if (f) f();
  nextQueuedToast();
}

// ------- 全局右键菜单 -------
const ctxMenu = ref({ x: 0, y: 0, items: [], visible: false });
function openCtxMenu(e, items) {
  e.preventDefault();
  ctxMenu.value = { x: e.clientX, y: e.clientY, items, visible: true };
  nextTick(() => {
    const el = document.querySelector(".ctx-menu");
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) ctxMenu.value.x = Math.max(8, ctxMenu.value.x - r.width);
    if (r.bottom > window.innerHeight - 8) ctxMenu.value.y = Math.max(8, ctxMenu.value.y - r.height);
  });
}
function onCtxAction(item) {
  ctxMenu.value.visible = false;
  item.fn && item.fn();
}
function closeCtxMenu() { ctxMenu.value.visible = false; }
onMounted(() => {
  window.addEventListener("click", closeCtxMenu);
  window.addEventListener("blur", closeCtxMenu);
});
onUnmounted(() => {
  window.removeEventListener("click", closeCtxMenu);
  window.removeEventListener("blur", closeCtxMenu);
});
provide("openCtxMenu", openCtxMenu);

// ------- 全局快捷键（Ctrl+1~5 切模块：1 Agent / 2 研发 / 3 记录 / 4 工具箱 / 5 设置；
// Ctrl+0 保留为工具箱（旧习惯）；Ctrl+K 开全局搜索） -------
const HOTKEY_MODULES = MODULES.map((m) => m.key).concat("settings"); // Ctrl+1..5
function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    gsRef.value?.openPalette();
    return;
  }
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === "0") {
    e.preventDefault();
    activeModule.value = "toolbox";
    return;
  }
  if (!/^[1-9]$/.test(e.key)) return;
  const key = HOTKEY_MODULES[Number(e.key) - 1];
  if (!key) return;
  e.preventDefault();
  if (key === "settings") openSettings(settingsSection.value);
  else activeModule.value = key;
}
onMounted(() => {
  if (shotMode) return; // Ctrl+1..5 模块热键只在应用外壳里生效
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

// 全局搜索/视图跳转导航：切模块 + Tab，并深链到具体记录（带 id 时）
// 兼容旧视图 key（{module:'iteration'}）与新坐标（{module:'work', tab:'iteration'}）
function onGlobalNavigate(input) {
  const target = resolveNavTarget(input);
  if (!target) return;
  activeModule.value = target.module;
  if (target.tab) moduleTabs.value[target.module] = target.tab;
  const id = input && input.id;
  jump.value = id ? { ...target, id, ts: Date.now() } : null;
  // 回 agent 主区（不带条目深链）= 看当前画布：清掉侧边栏的回看高亮
  if (target.module === "agent" && !id) viewingRunId.value = "";
}
function onTabSwitch(tabKey) {
  moduleTabs.value[activeModule.value] = tabKey;
}

// 托盘/全局快捷键动作：quick-note 切到问题 Tab 并唤起新建弹窗；check-update 手动检查更新
async function handleTrayAction(action) {
  if (action === "quick-note") {
    onGlobalNavigate({ module: "records", tab: "problem" });
    await nextTick();
    setTimeout(() => window.dispatchEvent(new CustomEvent("quick-note")), 60);
  } else if (action === "check-update") {
    checkForUpdate({ silent: false, showToast });
  }
}

// ------- 主题切换 -------
// 主题的真相源在 src/app/theme.js（既有单测可覆盖，也供 ToolWindow / 手机端复用）。
// 这里只负责：把模式投影到 <html data-theme>（让 CSS 变量真的切换）、
// 通知 Tauri 窗口装饰，并重放自定义强调色。
const THEME_MODES = [
  { key: "system", labelKey: "common.themeSystem", icon: "contrast" },
  { key: "light", labelKey: "common.themeLight", icon: "sun" },
  { key: "dark", labelKey: "common.themeDark", icon: "moon" },
];
const themeMode = ref(getThemeMode());
const themeMeta = computed(() => THEME_MODES.find((x) => x.key === themeMode.value) || THEME_MODES[0]);
async function applyTheme(mode) {
  // 属性先落：CSS 变量必须立刻跟着变，不能等 IPC（旧实现只等 IPC，于是
  // 浏览器端手动切深色时 CSS 变量一个字都没变——审计实测到的缺陷）。
  syncThemeAttribute(mode);
  applyThemeAccent();
  try {
    await getCurrentWindow().setTheme(mode === "system" ? null : mode);
  } catch (e) {
    /* 非 Tauri 环境：属性已经生效，窗口装饰交给系统 */
  }
}
// 按当前主题/系统偏好重放自定义主题色
function applyThemeAccent() {
  const key = loadAccentKey();
  if (!key) {
    resetAccent();
    return;
  }
  if (!applyAccent(key, themeMode.value, isDarkEffective(themeMode.value))) resetAccent();
}
function cycleTheme() {
  themeMode.value = nextThemeMode(themeMode.value);
  setThemeMode(themeMode.value);
  applyTheme(themeMode.value);
  showToast(t("common.themeSwitched", { label: t(themeMeta.value.labelKey) }));
}

// ------- 每天首次启动自动备份（storage.rs 提供，保留最近 7 份） -------
async function autoBackup() {
  try {
    const summary = await invoke("auto_backup", { stamp: fmtDate(new Date()) });
    if (summary) showToast(t("common.backupDone", { summary }));
  } catch (e) {
    /* 备份失败不打扰使用 */
  }
}

// ------- 版本更新（顶栏手动入口；启动静默检查与托盘入口走 updater.js） -------
const syncDot = ref("disabled");
const checkingVer = ref(false);
async function onCheckVersion() {
  if (checkingVer.value) return;
  checkingVer.value = true;
  try {
    await checkForUpdate({ silent: false, showToast });
  } finally {
    checkingVer.value = false;
  }
}

onMounted(async () => {
  if (shotMode) return; // 截图遮罩/贴图窗：不挂主窗口的监听与定时
  if (toolMode) setTimeout(revealToolWindow, 3000);
  applyTheme(themeMode.value);
  listen("tray-action", (e) => handleTrayAction(e.payload));
  window.addEventListener("settings-saved", onSettingsSaved);
  window.addEventListener("accent-changed", applyThemeAccent);
  window.addEventListener("sync-status", (e) => {
    syncDot.value = (e && e.detail && e.detail.status) || "disabled";
  });
  refreshUiSettings();
  if (isTauri) {
    setTimeout(autoBackup, 3000);
    // 启动静默检查新版本，有更新弹确认；延迟几秒避免与首屏抢 IO
    setTimeout(() => checkForUpdate({ silent: true, showToast }), 3000);
    // 自动签到的常驻定时器必须挂在主窗口：工具是独立 WebviewWindow，
    // 关掉工具窗口定时器就没了。toolMode（工具独立窗口）时一律不挂。
    if (!toolMode) startCheckInScheduler().catch(() => {});
    // 周报定时生成同理（到点自动产草稿 + 启动补跑），只在主窗口挂一次
    if (!toolMode) startWeeklyScheduler().catch(() => {});
  }
  if (!isTauri) return;
  applyThemeAccent();
  // 可选遥测：首启询问一次（askConfirm，同意/拒绝即时落盘；失败不阻断启动）
  const telemetryCfg = await telemetryGetConfig().catch(() => null);
  if (telemetryCfg && shouldPrompt({ telemetry: telemetryCfg })) {
    const allow = await askConfirm({
      title: t("telemetry.promptTitle"),
      message: t("telemetry.promptBody"),
      okText: t("telemetry.allow"),
      cancelText: t("telemetry.deny"),
      danger: false,
    });
    await telemetryConsent(allow);
  }
  // 定时 flush（P1-1 flush 时机①：启用期间每 10 分钟）
  telemetryTimer = setInterval(() => telemetryFlush().catch(() => {}), 10 * 60 * 1000);
  // 系统深浅切换时重放 accent（themeMode=system 场景）
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  mqUnlisten = null;
  if (mq && mq.addEventListener) {
    const onMq = () => applyThemeAccent();
    mq.addEventListener("change", onMq);
    mqUnlisten = () => mq.removeEventListener("change", onMq);
  }
  // 关闭前尽力冲刷（P1-1 flush 时机③：fire-and-forget）
  window.addEventListener("beforeunload", () => { telemetryFlush().catch(() => {}); });
});
let telemetryTimer = null;
let mqUnlisten = null;
onUnmounted(() => {
  window.removeEventListener("settings-saved", onSettingsSaved);
  window.removeEventListener("accent-changed", applyThemeAccent);
  if (telemetryTimer) {
    clearInterval(telemetryTimer);
    telemetryTimer = null;
  }
  mqUnlisten && mqUnlisten();
  if (!toolMode) stopCheckInScheduler();
  if (!toolMode) stopWeeklyScheduler();
});
</script>

<template>
  <!-- 截图遮罩页 / 贴图窗：独立页面，不渲染应用外壳 -->
  <component :is="shotPage" v-if="shotPage" />

  <!-- 工具独立窗口模式：只渲染工具本体 + toast，不渲染主界面 -->
  <template v-else-if="toolMode">
    <ToolWindow :tool="toolMode" :show-toast="showToast" @ready="revealToolWindow" />
    <transition name="fade">
      <div v-if="toast" class="toast">
        {{ toast.text }}
        <button v-if="toast.actionLabel" class="toast-act" @click="onToastAction">{{ toast.actionLabel }}</button>
      </div>
    </transition>
    <ConfirmDialog />
  </template>

  <div v-else class="shell" :class="{ collapsed: sidebarCollapsed }">
    <!-- ============ 侧边栏 ============ -->
    <aside class="sidebar" @keydown.esc="narrowExpanded = false">
      <div class="brand" data-tauri-drag-region>
        <span class="brand-logo"><Icon name="sparkles" :size="20" /></span>
        <span class="brand-name">ToolCove</span>
      </div>

      <nav id="sidebar-nav" class="nav">
        <!-- 侧边栏分层（三期修订）：固定区 + 唯一的滚动区。
             新任务 / 工作面 / 搜索 / 底部按钮都是固定入口，只有会话列表滚动——
             旧版把整条侧边栏做成一个滚动容器，历史一长，「新任务」和搜索框被滚出视野、
             工作面被挤到底部，三个入口都变成「取决于你滚到哪」（用户实测反馈）。
             顺序：新任务 → 工作面 → 搜索 → 历史（滚动）→ 底部。
             工作面在会话列表之上，与 Qoder 桌面端一致（导航在上、任务列表在下半部分）。 -->
        <AgentSidePanel
          :active-module="activeModule"
          :viewing-run-id="viewingRunId"
          :collapsed="sidebarCollapsed"
          @new="onNewTask"
          @view="onViewTask"
          @open="activeModule = 'agent'"
          @expand="expandSidebar"
        >
          <!-- 工作面：人自己干活的地方，也是 Agent 的取数记忆。
               交给侧栏组件插在「新任务」与会话列表之间，但数据源（navConfig / hiddenModules）
               仍留在这里——组件只负责位置，不负责决定有哪些模块。 -->
          <template #workspace>
            <p v-if="workspaceModules.length && !sidebarCollapsed" class="nav-group">{{ t("nav.workspace") }}</p>
            <button
              v-for="m in workspaceModules"
              :key="m.key"
              class="nav-item"
              :class="{ on: activeModule === m.key }"
              :title="t(m.labelKey)"
              :aria-label="t(m.labelKey)"
              :aria-current="activeModule === m.key ? 'page' : undefined"
              @click="activeModule = m.key"
            >
              <span class="nav-ico"><Icon :name="m.icon" :size="17" /></span>
              <span class="nav-label">{{ t(m.labelKey) }}</span>
            </button>
          </template>
        </AgentSidePanel>
      </nav>

      <div class="side-foot">
        <button class="collapse settings-btn" :class="{ on: activeModule === 'settings' }" :title="t('nav.settings')" :aria-label="t('nav.settings')" :aria-current="activeModule === 'settings' ? 'page' : undefined" @click="openSettings('general')">
          <span class="clp-ico"><Icon name="settings" :size="15" /></span>
          <span class="nav-label">{{ t("nav.settings") }}</span>
        </button>
        <!-- 保留赞助与收起入口，以低权重图标和设置并排。 -->
        <button class="collapse foot-icon sponsor-btn" :title="t('sponsor.sideTip')" :aria-label="t('sponsor.sideTip')" @click="openSettings('sponsor')">
          <span class="clp-ico"><Icon name="heart" :size="15" /></span>
        </button>
        <button class="collapse foot-icon" :title="sidebarCollapsed ? t('nav.expand') : t('nav.collapse')" :aria-label="sidebarCollapsed ? t('nav.expand') : t('nav.collapse')" :aria-expanded="!sidebarCollapsed" aria-controls="sidebar-nav" @click="toggleSidebar">
          <span class="clp-ico"><Icon name="chevrons-left" :size="14" :class="{ flip: sidebarCollapsed }" /></span>
        </button>
      </div>
    </aside>

    <!-- ============ 主区 ============ -->
    <div class="main" @click="onMainClick">
      <header class="topbar" data-tauri-drag-region>
        <div class="page-title">
          <span class="pt-ico"><Icon :name="activeModule === 'settings' ? 'settings' : (MODULES.find((m) => m.key === activeModule) || MODULES[0]).icon" :size="20" /></span>
          <div class="pt-text">
            <h1>{{ activeModule === "settings" ? t("nav.settings") : t((MODULES.find((m) => m.key === activeModule) || MODULES[0]).labelKey) }}</h1>
          </div>
        </div>
        <div class="top-actions">
          <GlobalSearch ref="gsRef" :show-toast="showToast" @navigate="onGlobalNavigate" />
          <button v-if="capabilities.cloudSync" class="theme-btn sync-ind" :class="syncDot" :title="t('sync.statusTitle')" @click="openSettings('sync')">
            <span class="sync-ind-dot"></span>
          </button>
          <button class="theme-btn" :title="t('common.manual')" @click="openManual">
            <Icon name="book-open" :size="16" />
          </button>
          <button v-if="capabilities.updater" class="theme-btn" :title="checkingVer ? t('common.updateChecking') : t('common.updateCheckTip')" :disabled="checkingVer" @click="onCheckVersion">
            <Icon name="repeat" :size="15" />
          </button>
          <button class="theme-btn" :title="t('common.appearance') + '：' + t(themeMeta.labelKey)" @click="cycleTheme">
            <Icon :name="themeMeta.icon" :size="15" />
          </button>
          <div v-if="isTauri" class="win-ctrls">
            <button class="wc-btn" :title="t('common.winMinimize')" @click="winMinimize"><Icon name="minus" :size="14" /></button>
            <button class="wc-btn" :title="isMaximized ? t('common.winRestore') : t('common.winMaximize')" @click="winToggleMax">
              <Icon :name="isMaximized ? 'copy' : 'square'" :size="12" />
            </button>
            <button class="wc-btn close" :title="t('common.winClose')" @click="winClose"><Icon name="x" :size="15" /></button>
          </div>
        </div>
      </header>

      <div class="body">
        <ModuleTabs
          v-if="activeTabs.length"
          :key="activeModule"
          :tabs="activeTabs"
          :active="activeTab"
          :show-toast="showToast"
          :jump-id="activeJump"
          @update:active="onTabSwitch"
          @navigate="onGlobalNavigate"
        />
        <component
          v-else
          :is="plainViewComp"
          :key="activeModule"
          :show-toast="showToast"
          :section="settingsSection"
          :jump-id="activeJump"
          @navigate="onGlobalNavigate"
        />
      </div>
    </div>

    <transition name="fade">
      <div v-if="toast" class="toast">
        {{ toast.text }}
        <button v-if="toast.actionLabel" class="toast-act" @click="onToastAction">{{ toast.actionLabel }}</button>
      </div>
    </transition>

    <transition name="cf-fade">
      <div v-if="ctxMenu.visible" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
        <button v-for="(it, i) in ctxMenu.items" :key="i" class="ctx-item" :class="{ danger: it.danger }" @click="onCtxAction(it)">
          <Icon :name="it.icon" :size="14" /> {{ it.label }}
        </button>
      </div>
    </transition>

    <ConfirmDialog />
  </div>
</template>

<!-- 全局样式已抽到 src/styles/：tokens.css（设计令牌）/ primitives.css（组件原语）/
     globals.css（应用级基线 + 旧类名兼容别名）。三者在 main.js 里引入。 -->

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 244px minmax(0, 1fr);
  height: 100dvh;
  overflow: hidden;
  transition: grid-template-columns 0.22s ease;
}
.shell.collapsed { grid-template-columns: 64px minmax(0, 1fr); }

/* ============ 侧边栏 ============ */
.sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0 10px 10px;
  background: var(--bg);
  border-right: 1px solid var(--border);
  position: relative;
  height: 100dvh;
  overflow: hidden;
}
.brand { display: flex; align-items: center; flex-shrink: 0; height: 56px; gap: 10px; padding: 0 4px; }
/* 品牌区子元素不拦截鼠标，拖拽落到 .brand 的 drag-region 上（可拖动窗口） */
.brand > * { pointer-events: none; }
.brand-logo {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r-md);
  background: var(--grad-brand);
  color: var(--text-invert);
}
.brand-name { font-size: var(--fs-lg); font-weight: 700; letter-spacing: 0.3px; white-space: nowrap; }

/* 固定入口不滚动；只把剩余高度交给 AgentSidePanel 的历史列表。 */
.nav { display: flex; flex-direction: column; gap: 3px; flex: 1; min-height: 0; }
.nav-item { flex-shrink: 0; }
/* 工作面分组与新任务保持清晰分隔。 */
.nav-group { flex-shrink: 0; margin: 10px 0 2px; padding: 0 var(--sp-3); font-size: var(--fs-xs); font-weight: 600; color: var(--faint); letter-spacing: 0.4px; }
/* 导航行：扁平行 + 悬停填充，而不是默认就带边框与投影的小卡片。
   卡片式行每一条都在抢注意力，侧边栏一旦有 10 条历史就变成一片浮起的方块；
   Qoder / Cursor / VS Code 的侧边栏行都是扁平的，只有选中态才有底色。
   （AgentSidePanel.vue 里有一份等效样式：那边是 scoped，拿不到这里的声明。） */
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  border: 1px solid transparent;
  background: none;
  height: 34px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-sm);
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-weak);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.nav-ico { display: grid; place-items: center; flex-shrink: 0; width: 22px; color: var(--text-weak); }
.nav-item:hover .nav-ico { color: var(--primary-hover); }
.nav-item.on .nav-ico { color: var(--primary-hover); }
.nav-item:hover { color: var(--primary-hover); background: var(--card); border-color: var(--card-border); }
/* 键盘导航的焦点框用主题紫柔化，覆盖浏览器默认黑框 */
.nav-item:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.nav-item.on { background: var(--grad-selected); color: var(--primary-hover); border-color: var(--border-blue); }
.nav-item.on::before {
  content: "";
  position: absolute;
  left: -10px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 22px;
  border-radius: 0 4px 4px 0;
  background: var(--primary);
}

/* 设置保留文字主入口，其余按钮横排；图标轨道内再纵向排布。 */
.side-foot { display: flex; align-items: center; flex-shrink: 0; gap: 4px; margin-top: auto; padding-top: 8px; border-top: 1px solid var(--border); }

.collapse {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  border: 1px solid transparent;
  background: none;
  padding: 0 6px;
  border-radius: var(--r-sm);
  font-size: 13.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.settings-btn { flex: 1; min-width: 0; }
.foot-icon { width: 34px; flex-shrink: 0; justify-content: center; padding: 0; }
.collapse:hover { background: var(--card); border-color: var(--card-border); color: var(--primary); }
.collapse:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.collapse.on { background: var(--grad-selected); border-color: var(--border-blue); color: var(--primary-hover); }
.sponsor-btn:hover { color: var(--warn); background: var(--warn-soft); }
.clp-ico {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  color: inherit;
}
.clp-ico svg { transition: transform 0.22s ease; }
.clp-ico svg.flip { transform: scaleX(-1); }

/* 收起态 */
.shell.collapsed .brand { justify-content: center; padding-left: 0; padding-right: 0; }
.shell.collapsed .brand-name,
.shell.collapsed .nav-label { display: none; }
.shell.collapsed .nav-item { justify-content: center; padding-left: 0; padding-right: 0; }
.shell.collapsed .side-foot { flex-direction: column; }
.shell.collapsed .collapse { flex: none; width: 100%; justify-content: center; padding-left: 0; padding-right: 0; }

/* ============ 主区 ============ */
.main { display: flex; flex-direction: column; min-width: 0; height: 100dvh; overflow: hidden; position: relative; background: var(--card); }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 56px;
  padding: 0 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
/* 标题不拦截拖拽；极窄窗口省略文字，不挤掉窗口控件。 */
.page-title { display: flex; align-items: center; gap: 8px; min-width: 0; pointer-events: none; }
.pt-ico {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  color: var(--text-weak);
}
.pt-text { display: flex; flex-direction: column; min-width: 0; }
.pt-text h1 { margin: 0; font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top-actions { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 仅搜索框收缩；GlobalSearch 是多根组件，选择器直接命中其真实触发按钮。 */
.top-actions > * { flex-shrink: 0; }
.top-actions :deep(.gs-trigger) { flex-shrink: 1; width: 220px; min-width: 32px; height: 32px; padding: 0 10px; }
.top-actions :deep(.gs-trigger > svg) { flex-shrink: 0; }
.top-actions :deep(.gs-ph) { min-width: 0; }
.theme-btn { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-sm); color: var(--muted); cursor: pointer; transition: all 0.15s; }
.theme-btn:hover { border-color: var(--primary); color: var(--primary); }
/* 云同步指示灯：灰=未启用/蓝=同步中/绿=已同步/红=失败/琥珀=已吊销 */
.sync-ind { display: grid; place-items: center; }
.sync-ind-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); transition: background 0.2s; }
.sync-ind.syncing .sync-ind-dot { background: var(--primary); animation: sync-ind-pulse 1.1s ease-in-out infinite; }
.sync-ind.idle .sync-ind-dot { background: var(--success); }
.sync-ind.error .sync-ind-dot { background: var(--danger); }
.sync-ind.revoked .sync-ind-dot { background: var(--warn); }
@keyframes sync-ind-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }

/* 窗口控制按钮（自定义标题栏） */
.win-ctrls { display: flex; align-items: center; gap: 2px; margin-left: 4px; }
.wc-btn { width: 32px; height: 30px; padding: 0; display: grid; place-items: center; border: none; background: none; border-radius: var(--r-sm); color: var(--muted); cursor: pointer; transition: background 0.12s, color 0.12s; }
.wc-btn:hover { background: rgba(120, 130, 150, 0.14); color: var(--text); }
.wc-btn.close:hover { background: var(--win-close); color: var(--text-invert); }

/* 铃铛通知中心 */
.notice-wrap { position: relative; }
.bell-btn { position: relative; }
.bell-dot {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  display: grid;
  place-items: center;
  background: var(--danger-bright);
  color: var(--text-invert);
  font-size: var(--fs-xs);
  font-weight: 700;
  border-radius: var(--r-pill);
  border: 2px solid var(--bg);
  line-height: 1;
}
.notice-panel {
  position: absolute;
  top: 44px;
  right: 0;
  width: 340px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-lg);
  box-shadow: 0 18px 44px rgba(16, 24, 40, 0.18);
  z-index: 60;
  overflow: hidden;
}
.np-head { display: flex; align-items: center; justify-content: space-between; padding: 13px var(--sp-6) var(--sp-3); border-bottom: 1px solid var(--border); }
.np-head b { font-size: var(--fs-base); }
.np-clear { border: none; background: none; font-size: var(--fs-sm); color: var(--muted); cursor: pointer; padding: 2px var(--sp-1); border-radius: var(--r-xs); }
.np-clear:hover { color: var(--danger); background: var(--danger-soft); }
.np-list { overflow-y: auto; padding: var(--sp-1) var(--sp-2) var(--sp-3); display: flex; flex-direction: column; gap: 2px; }
.np-item { display: flex; align-items: flex-start; gap: var(--sp-2); padding: 9px var(--sp-2); border-radius: var(--r-sm); }
.np-item.unread { background: var(--primary-soft); }
.np-tag { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 700; padding: 2px var(--sp-2); border-radius: var(--r-pill); background: var(--well); color: var(--text-weak); margin-top: 1px; }
.np-tag.release { background: var(--warn-soft); color: var(--warn); }
.np-tag.backup { background: var(--success-soft); color: var(--success-deep); }
.np-tag.sync { background: var(--primary-soft); color: var(--primary); }
.np-text { flex: 1; min-width: 0; font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--text); word-break: break-word; }
.np-time { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
.np-empty { margin: 0; padding: 22px var(--sp-7) 26px; font-size: var(--fs-sm); color: var(--muted); text-align: center; }

/* 当前用户（仅头像，主区已有问候语） */
.user-chip { display: flex; align-items: center; flex-shrink: 0; cursor: default; }
.uc-avatar {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--grad-brand);
  color: var(--text-invert);
  font-size: var(--fs-base);
  font-weight: 700;
  box-shadow: 0 2px 6px rgba(99, 102, 241, 0.28);
  transition: transform 0.15s, box-shadow 0.15s;
}
.user-chip:hover .uc-avatar { transform: translateY(-1px); box-shadow: 0 4px 10px rgba(99, 102, 241, 0.36); }

.body { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; overflow-x: hidden; }

/* 视图切换动画：入场淡入 + 上移 6px（组件 key 重建触发；无 leave，reduced-motion 全局降级） */
.body > * { min-width: 0; animation: viewIn 0.18s ease; }
@keyframes viewIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}

/* 提示条 */
.toast {
  position: fixed;
  bottom: 26px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--toast-bg);
  color: var(--text-invert);
  padding: 11px 22px;
  border-radius: var(--r-sm);
  font-size: var(--fs-base);
  z-index: 200;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  max-width: calc(100vw - 60px);
}
.toast-act {
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.28);
  color: var(--primary-bright);
  font-size: var(--fs-md);
  font-weight: 700;
  padding: 4px var(--sp-4);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background 0.15s;
}
.toast-act:hover { background: rgba(255, 255, 255, 0.24); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* 壳层配色完全跟随 token，不用系统媒体查询覆盖用户手动选择的主题。 */
@media (max-width: 1000px) {
  .topbar { padding: 0 12px; gap: 8px; }
  .top-actions :deep(.gs-trigger) { width: 160px; }
  .top-actions :deep(.gs-kbd) { display: none; }
}
@media (max-width: 760px) {
  .shell, .shell.collapsed { grid-template-columns: 64px minmax(0, 1fr); }
  /* 侧栏浮出后不在流内，主区必须钉在第二列，否则会掉进 64px 的轨道列。 */
  .main { grid-column: 2; }
  /* 临时展开覆盖主区，而不压缩工作台；底部收起和 Escape 均可回到轨道。 */
  .shell:not(.collapsed) .sidebar { position: absolute; inset: 0 auto 0 0; width: 244px; z-index: 30; }
  .top-actions { flex-shrink: 0; }
  .top-actions :deep(.gs-trigger) { width: 32px; min-width: 32px; justify-content: center; padding: 0; }
  .top-actions :deep(.gs-ph) { display: none; }
}
@media (max-width: 560px) {
  .topbar { padding: 0 8px; gap: 4px; }
  .pt-ico { display: none; }
  .top-actions { gap: 3px; }
  .theme-btn { width: 28px; }
  .win-ctrls { gap: 0; margin-left: 0; }
  .wc-btn { width: 24px; }
}
@media (prefers-reduced-motion: reduce) {
  .shell { transition: none; }
}
</style>
