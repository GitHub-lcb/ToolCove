<script setup>
import { ref, computed, onMounted, onUnmounted, provide, nextTick, defineAsyncComponent } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";
import { fmtDate } from "./shared.js";
import { normalizeHiddenModules } from "./settingsConfig.js";
import { checkForUpdate } from "./updater.js";
import ConfirmDialog from "./ConfirmDialog.vue";
import ToolWindow from "./ToolWindow.vue";
import ToolboxView from "./ToolboxView.vue";
import GlobalSearch from "./GlobalSearch.vue";
import pkg from "../package.json";

const { t } = useI18n();

// ------- 模块导航配置（九视图：toolbox 为默认启动视图，Ctrl+1~9 直切） -------
const MODULES = [
  { key: "home", labelKey: "nav.home", descKey: "module.homeDesc", icon: "home" },
  { key: "domain", labelKey: "nav.domain", descKey: "module.domainDesc", icon: "layers" },
  { key: "iteration", labelKey: "nav.iteration", descKey: "module.iterationDesc", icon: "git-branch" },
  { key: "requirement", labelKey: "nav.requirement", descKey: "module.requirementDesc", icon: "bar-chart" },
  { key: "problem", labelKey: "nav.problem", descKey: "module.problemDesc", icon: "alert" },
  { key: "release", labelKey: "nav.release", descKey: "module.releaseDesc", icon: "upload" },
  { key: "snippet", labelKey: "nav.snippet", descKey: "module.snippetDesc", icon: "copy" },
  { key: "task", labelKey: "nav.task", descKey: "module.taskDesc", icon: "repeat" },
  { key: "toolbox", labelKey: "nav.toolbox", descKey: "module.toolboxDesc", icon: "wrench" },
];

// 工具箱工具独立窗口模式（URL 携带 ?tool=xxx 时只渲染工具窗口）
const toolMode = new URLSearchParams(window.location.search).get("tool") || "";
let toolWindowShown = false;
async function revealToolWindow() {
  if (!toolMode || toolWindowShown || !window.__TAURI_INTERNALS__) return;
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
const activeModule = ref("toolbox");
const collapsed = ref(true);
const toast = ref(null);
const jump = ref(null);
const gsRef = ref(null);

const WelcomeView = defineAsyncComponent(() => import("./WelcomeView.vue"));
const HomeView = defineAsyncComponent(() => import("./HomeView.vue"));
const DomainView = defineAsyncComponent(() => import("./DomainView.vue"));
const TaskView = defineAsyncComponent(() => import("./TaskView.vue"));
const SnippetView = defineAsyncComponent(() => import("./SnippetView.vue"));
const ProblemView = defineAsyncComponent(() => import("./ProblemView.vue"));
const SettingsView = defineAsyncComponent(() => import("./SettingsView.vue"));
const IterationView = defineAsyncComponent(() => import("./IterationView.vue"));
const RequirementBoardView = defineAsyncComponent(() => import("./RequirementBoardView.vue"));
const ReleaseView = defineAsyncComponent(() => import("./ReleaseView.vue"));
const VIEW_COMPONENTS = { home: HomeView, domain: DomainView, iteration: IterationView, requirement: RequirementBoardView, problem: ProblemView, release: ReleaseView, snippet: SnippetView, task: TaskView, toolbox: ToolboxView, settings: SettingsView };
const activeViewComp = computed(() => VIEW_COMPONENTS[activeModule.value] || WelcomeView);

const settingsSection = ref("general");
function openSettings(section) {
  activeModule.value = "settings";
  settingsSection.value = section;
}

// 界面设置（密度 + 侧边栏模块展示/隐藏，设置里可切换；紧凑为默认）
const density = ref("compact");
const hiddenModules = ref([]); // 设置里隐藏的模块 key；隐藏只是不展示，全局搜索仍可达
const visibleModules = computed(() => MODULES.filter((m) => !hiddenModules.value.includes(m.key)));
async function refreshUiSettings() {
  try {
    const s = (await invoke("load_data", { key: "settings" })) || {};
    density.value = s.ui?.density === "comfort" ? "comfort" : "compact";
    hiddenModules.value = normalizeHiddenModules(MODULES.map((m) => m.key), s.ui?.hiddenModules);
    // 当前所在模块被隐藏时切到第一个可见模块，避免侧边栏失去选中高亮
    if (MODULES.some((m) => m.key === activeModule.value) && hiddenModules.value.includes(activeModule.value) && visibleModules.value.length) {
      activeModule.value = visibleModules.value[0].key;
    }
  } catch (e) {}
}

// 保存设置后刷新界面设置（密度 / 侧边栏模块展示）
function onSettingsSaved() {
  refreshUiSettings();
}

// ------- 全局页脚 -------
const year = new Date().getFullYear();
const version = pkg.version;
const MANUAL_URL = "https://github.com/GitHub-lcb/ToolCove"; // M4 上线文档站后替换
function openManual() {
  openUrl(MANUAL_URL).catch((e) => showToast(String(e)));
}

// ------- 自定义标题栏（decorations:false，顶栏自绘窗口控制） -------
const isTauri = !!window.__TAURI_INTERNALS__;
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
function showToast(msg, opts = {}) {
  if (toastExpire) {
    const f = toastExpire;
    toastExpire = null;
    f();
  }
  toast.value = { text: msg, actionLabel: opts.actionLabel || "" };
  toastAction = opts.onAction || null;
  toastExpire = opts.onExpire || null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, opts.duration || (opts.actionLabel ? 5000 : 2200));
}
function dismissToast() {
  toast.value = null;
  toastAction = null;
  if (toastExpire) {
    const f = toastExpire;
    toastExpire = null;
    f();
  }
}
function onToastAction() {
  clearTimeout(toastTimer);
  const f = toastAction;
  toastAction = null;
  toastExpire = null;
  toast.value = null;
  if (f) f();
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

// ------- 全局快捷键（Ctrl+数字切模块；Ctrl+K 开全局搜索） -------
function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    gsRef.value?.openPalette();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key >= "1" && e.key <= String(MODULES.length)) {
    e.preventDefault();
    activeModule.value = MODULES[Number(e.key) - 1].key;
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

// 全局搜索导航：切模块并深链到具体记录（带 id 时）
function onGlobalNavigate({ module, id }) {
  if (!MODULES.some((m) => m.key === module)) return;
  activeModule.value = module;
  if (id) jump.value = { module, id, ts: Date.now() };
}

// 托盘/全局快捷键动作：quick-note 切到问题视图并唤起新建弹窗；check-update 手动检查更新
async function handleTrayAction(action) {
  if (action === "quick-note") {
    activeModule.value = "problem";
    await nextTick();
    setTimeout(() => window.dispatchEvent(new CustomEvent("quick-note")), 60);
  } else if (action === "check-update") {
    checkForUpdate({ silent: false, showToast });
  }
}

// ------- 主题切换 -------
const THEME_MODES = [
  { key: "system", labelKey: "common.themeSystem", icon: "contrast" },
  { key: "light", labelKey: "common.themeLight", icon: "sun" },
  { key: "dark", labelKey: "common.themeDark", icon: "moon" },
];
const themeMode = ref(localStorage.getItem("themeMode") || "system");
const themeMeta = computed(() => THEME_MODES.find((x) => x.key === themeMode.value) || THEME_MODES[0]);
async function applyTheme(mode) {
  try {
    await getCurrentWindow().setTheme(mode === "system" ? null : mode);
  } catch (e) {
    /* 非 Tauri 环境：静默降级为跟随系统 */
  } finally {
    document.documentElement.removeAttribute("data-boot-theme");
    document.documentElement.style.colorScheme = mode === "system" ? "light dark" : mode;
  }
}
function cycleTheme() {
  const i = THEME_MODES.findIndex((x) => x.key === themeMode.value);
  themeMode.value = THEME_MODES[(i + 1) % THEME_MODES.length].key;
  localStorage.setItem("themeMode", themeMode.value);
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

onMounted(() => {
  if (toolMode) setTimeout(revealToolWindow, 3000);
  applyTheme(themeMode.value);
  listen("tray-action", (e) => handleTrayAction(e.payload));
  window.addEventListener("settings-saved", onSettingsSaved);
  refreshUiSettings();
  setTimeout(autoBackup, 3000);
  // 启动静默检查新版本，有更新弹确认；延迟几秒避免与首屏抢 IO
  setTimeout(() => checkForUpdate({ silent: true, showToast }), 3000);
});
onUnmounted(() => {
  window.removeEventListener("settings-saved", onSettingsSaved);
});
</script>

<template>
  <!-- 工具独立窗口模式：只渲染工具本体 + toast，不渲染主界面 -->
  <template v-if="toolMode">
    <ToolWindow :tool="toolMode" :show-toast="showToast" @ready="revealToolWindow" />
    <transition name="fade">
      <div v-if="toast" class="toast">
        {{ toast.text }}
        <button v-if="toast.actionLabel" class="toast-act" @click="onToastAction">{{ toast.actionLabel }}</button>
      </div>
    </transition>
    <ConfirmDialog />
  </template>

  <div v-else class="shell" :class="{ collapsed, 'dens-comfort': density === 'comfort' }">
    <div class="orbs" aria-hidden="true">
      <span class="orb o1"></span>
      <span class="orb o2"></span>
      <span class="orb o3"></span>
    </div>
    <!-- ============ 侧边栏 ============ -->
    <aside class="sidebar">
      <div class="brand" data-tauri-drag-region>
        <span class="brand-logo"><Icon name="rocket" :size="20" /></span>
        <span class="brand-name">ToolCove</span>
      </div>

      <nav class="nav">
        <button
          v-for="m in visibleModules"
          :key="m.key"
          class="nav-item"
          :class="{ on: activeModule === m.key }"
          :title="t(m.labelKey)"
          @click="activeModule = m.key"
        >
          <span class="nav-ico"><Icon :name="m.icon" :size="17" /></span>
          <span class="nav-label">{{ t(m.labelKey) }}</span>
        </button>
      </nav>

      <div class="side-foot">
        <button class="collapse" :class="{ on: activeModule === 'settings' }" :title="t('nav.settings')" @click="openSettings('general')">
          <span class="clp-ico"><Icon name="settings" :size="15" /></span>
          <span class="nav-label">{{ t("nav.settings") }}</span>
        </button>
        <button class="collapse" :title="collapsed ? t('nav.expand') : t('nav.collapse')" @click="collapsed = !collapsed">
          <span class="clp-ico"><Icon name="chevrons-left" :size="14" :class="{ flip: collapsed }" /></span>
          <span class="nav-label">{{ collapsed ? t("nav.expand") : t("nav.collapse") }}</span>
        </button>
      </div>
    </aside>

    <!-- ============ 主区 ============ -->
    <div class="main">
      <header class="topbar" data-tauri-drag-region>
        <div class="page-title">
          <span class="pt-ico"><Icon :name="activeModule === 'settings' ? 'settings' : (MODULES.find((m) => m.key === activeModule) || MODULES[0]).icon" :size="20" /></span>
          <div class="pt-text">
            <h1>{{ activeModule === "settings" ? t("nav.settings") : t((MODULES.find((m) => m.key === activeModule) || MODULES[0]).labelKey) }}</h1>
          </div>
        </div>
        <div class="top-brand">
          © {{ year }} ToolCove · {{ t("app.slogan") }}
          <span class="tb-ver"><span class="tbv-txt">v{{ version }}</span></span>
        </div>
        <div class="top-actions">
          <GlobalSearch ref="gsRef" :show-toast="showToast" @navigate="onGlobalNavigate" />
          <button class="theme-btn" :title="t('common.manual')" @click="openManual">
            <Icon name="book-open" :size="16" />
          </button>
          <button class="theme-btn" :title="checkingVer ? t('common.updateChecking') : t('common.updateCheckTip')" :disabled="checkingVer" @click="onCheckVersion">
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
        <component
          :is="activeViewComp"
          :key="activeModule"
          :show-toast="showToast"
          :section="settingsSection"
          :jump-id="jump && jump.module === activeModule ? jump : null"
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

<style>
:root {
  /* UI 2.0：GitHub/终端母语系。浅色=冷钢兼容主题，深色=一等公民工作台 */
  --bg: #f6f8fa;
  --card: #ffffff;
  --text: #1f2328;
  --muted: #656d76;
  --border: #d8dee4;
  --border-strong: #c8d1da;
  --primary: #0969da;
  --primary-hover: #0550ae;
  --primary-soft: #eaf2fd;
  --shadow: 0 1px 2px rgba(31, 35, 40, 0.04), 0 10px 28px rgba(31, 35, 40, 0.08);
  --grad-brand: linear-gradient(135deg, #0969da, #4493f8 55%, #79c0ff);
  --card-border: #e3e8ee;
  --shadow-tile: 0 5px 14px rgba(31, 35, 40, 0.13);
  /* 排版 token：字号 7 档 + 行高 2 档 + 等宽字体栈；新样式禁止再写裸 px 字号（邮件内联样式除外） */
  --fs-xs: 11px;    /* 徽标、kbd、代码块、表格辅助 */
  --fs-sm: 12.5px;  /* 辅助说明、desc、chip、时间戳 */
  --fs-md: 13.5px;  /* 正文默认：列表、按钮、标签 */
  --fs-base: 14.5px;/* 输入框、导航、强调正文、卡片小标题 */
  --fs-lg: 16px;    /* 卡片标题、品牌名 */
  --fs-xl: 20px;    /* 页面标题、弹窗 h2、空状态 */
  --fs-num: 26px;   /* 统计大数字 */
  --lh-tight: 1.4;  /* 标题、单行 */
  --lh-body: 1.65;  /* 多行正文 */
  --font-mono: "Cascadia Code", Consolas, Menlo, monospace;
  /* 数字/版本展示字体栈：Bahnschrift 工程感强（Windows 10+ 自带，可变字重不虚化），用于 KPI 大数字、版本号等纯数字场合；代码语义文本仍走 --font-mono */
  --font-num: "Bahnschrift", "Cascadia Code", "Segoe UI", sans-serif;
  --code-bg: #f6f8fa;         /* 代码块底色 */
  --code-border: #eef0f6;     /* 代码块描边 */
  /* 紫系退役映射（UI 2.0）：token 保留防组件断裂，值已迁移到主色蓝系；重构完成后删除本组 */
  --accent: #0969da;        /* 强调主色（= 主色蓝） */
  --accent-hover: #0550ae;  /* 强调 hover/加深 */
  --accent-deep: #0550ae;   /* 强调深色（选中态文字） */
  --accent-light: #4493f8;  /* 强调浅色（渐变尾） */
  --accent-soft: #eaf2fd;   /* 强调柔和底 */
  --accent-border: #b8d8fb; /* 强调描边 */
  /* 语义状态色（终端母语：绿=成功/在线、红=错误/删除、琥珀=待办/警告） */
  --success: #1a7f37;
  --danger: #cf222e;
  --danger-soft: #ffebe9;
  --warn: #9a6700;
  /* 中性文字层级补充 */
  --text-weak: #59636e;       /* 次要文字（导航项、辅助说明） */
  --text-soft: #4a5561;       /* 三级文字（chip、日期、tag） */
  --text-dim: #59636e;        /* 四级文字（表格表头、弱标签） */
  --text-code: #334155;       /* 代码/预格式文本 */
  --text-invert: #ffffff;     /* 彩色底上的白字（按钮、徽标） */
  --faint: #afb8c4;           /* 装饰性最淡文字（版权条、箭头） */
  /* 嵌入底与幽灵按钮 */
  --well: #eef1f6;            /* 嵌入浅灰底（进度槽、tag 底、缩略图占位） */
  --well-hover: #e7eaf0;      /* 嵌入底 hover */
  --ghost: #f1f3f7;           /* 幽灵按钮底 */
  --card-soft: #fafbfd;       /* 卡片内嵌套区块底 */
  /* 蓝色系补充 */
  --primary-light: #4493f8;   /* 主色浅一号（渐变尾、深色模式亮字） */
  --primary-bright: #79c0ff;  /* 主色亮一号（toast 操作按钮字） */
  --primary-soft-hover: #d8e9fb; /* 主色浅底 hover（代码链接 chip） */
  --border-blue: #b8d8fb;     /* 浅蓝描边（outline 按钮） */
  --border-steel: #c7cdd8;    /* 灰蓝描边（chip hover、时间轴圆点） */
  --border-danger: #f0b1b1;   /* 浅红描边（危险 outline 按钮） */
  /* 紫系补充（退役映射） */
  --accent-soft-text: #4493f8;/* 深蓝底上的亮蓝文字 */
  --accent-tint: #f2f8fe;     /* 极淡蓝 hover 底 */
  --grad-selected: linear-gradient(135deg, #f2f8fe, #e3effd); /* 侧边栏选中项渐变（蓝系） */
  --grad-promo: linear-gradient(150deg, #f6fafd, #e9f1fb);    /* 推广/提示卡渐变（蓝系） */
  /* 状态色补充 */
  --success-light: #1f883d;
  --success-soft: #dafbe1;
  --success-tint: #e6f8ec;
  --success-deep: #116329;
  --success-border: #9ed9af;  /* 成功态描边（已解决文本） */
  --warn-soft: #fff8c5;
  --warn-tint: #fffbe9;
  --warn-deep: #7d4e00;
  --warn-border: #f0d06c;
  --amber: #9a6700;           /* 琥珀（待上线状态、pinned） */
  --amber-light: #d4a72c;     /* 琥珀亮（深色模式强调文字） */
  --amber-bright: #e3b341;    /* 琥珀亮一号（装饰点缀） */
  --amber-soft: #fff8c5;
  --amber-border: #f0c27b;    /* 琥珀描边（pinned 操作钮） */
  --danger-light: #ff8182;
  --danger-deep: #a40e26;
  --danger-bright: #f85149;   /* 铃铛红点 */
  /* 领域色（Domain 卡片循环、状态标签） */
  --teal: #0d9488;
  --teal-light: #5eead4;
  --teal-soft: #ccfbf1;
  --teal-deep: #0f766e;
  --sky: #0ea5e9;
  --sky-soft: #e0f2fe;
  --sky-deep: #0369a1;
  --fuchsia: #db2777;
  --green: #10b981;
  --orange: #f97316;
  /* 工时热力图（5 档） */
  --heat-0: #eef1f6;
  --heat-1: #dbeafe;
  --heat-2: #93c5fd;
  --heat-3: #3b82f6;
  --heat-4: #1d4ed8;
  --heat-text-1: #1e40af;
  --heat-text-2: #1e3a8a;
  /* 特殊用途 */
  --row-current: #fde68a;     /* 表格当前行高亮 */
  --toast-bg: #1f2937;
  --win-close: #e81123;
  /* 页面背景渐变 */
  --bg-grad: linear-gradient(160deg, #f6f8fa 0%, #f0f3f7 55%, #f4f7fa 100%);
  /* 圆角 5 档 */
  --r-xs: 6px;    /* 小元素：chip/tag/kbd/代码块 */
  --r-sm: 9px;    /* 输入框、次级按钮 */
  --r-md: 12px;   /* 卡片、主按钮 */
  --r-lg: 16px;   /* 大容器、弹窗 */
  --r-pill: 999px;/* 胶囊 */
  /* 间距 7 档（gap/padding/margin 优先引用；存量裸值按最接近档位归位） */
  --sp-1: 6px;
  --sp-2: 8px;
  --sp-3: 10px;
  --sp-4: 12px;
  --sp-5: 14px;
  --sp-6: 16px;
  --sp-7: 20px;
  /* 品牌光晕（UI 2.0：主色蓝辉，3D 图标/logo 统一使用） */
  --glow-sm: 0 3px 8px color-mix(in srgb, var(--primary) 25%, transparent);
  --glow-md: 0 6px 18px color-mix(in srgb, var(--primary) 32%, transparent);
  --glow-lg: 0 10px 28px color-mix(in srgb, var(--primary) 40%, transparent);
}
/* 舒适密度档（设置 → 系统设置 → 界面密度）：放大间距与行高；紧凑为默认（本 :root 值） */
.dens-comfort {
  --sp-1: 8px;
  --sp-2: 10px;
  --sp-3: 12px;
  --sp-4: 14px;
  --sp-5: 16px;
  --sp-6: 18px;
  --sp-7: 24px;
  --lh-tight: 1.5;
  --lh-body: 1.8;
}
* { box-sizing: border-box; }
/* 表单控件 UA 默认不继承字体（按钮/输入框渲染 Arial），全局归一到应用字体栈 */
button, input, select, textarea { font-family: inherit; }
body {
  margin: 0;
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", Inter, system-ui, sans-serif;
  font-size: var(--fs-base);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(rgba(31, 35, 40, 0.03) 1px, transparent 1.4px),
    radial-gradient(900px 480px at 85% -6%, rgba(9, 105, 218, 0.06), transparent 60%),
    radial-gradient(800px 460px at -4% 102%, rgba(56, 139, 253, 0.05), transparent 55%),
    var(--bg-grad);
  background-size: 22px 22px, auto, auto, auto;
  background-attachment: fixed;
}

/* 通用弹窗（全局统一，各视图仅覆盖宽度等差异） */
.modal-mask { position: fixed; inset: 0; background: rgba(17, 24, 39, 0.5); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 20px; }
.modal { background: var(--card); border-radius: var(--r-lg); padding: 26px; width: 540px; max-width: 100%; max-height: 90vh; overflow-y: auto; overscroll-behavior: contain; box-shadow: 0 20px 50px rgba(16, 24, 40, 0.25); }
.modal h2 { margin: 0 0 20px; font-size: var(--fs-xl); }
.modal-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }

/* ============ 按钮体系（全局唯一，各视图禁止再自造 .btn-*） ============ */
.btn-primary {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  background: var(--primary); color: var(--text-invert);
  border: none; border-radius: var(--r-sm);
  padding: 9px 16px; font-size: var(--fs-base); font-weight: 600;
  cursor: pointer; transition: background 0.15s, transform 0.1s;
}
.btn-primary:hover { background: var(--primary-hover); }
.btn-primary:active, .btn-outline:active, .btn-ghost:active, .icon-btn:active { transform: translateY(1px); }
.btn-primary.sm { padding: 7px 12px; font-size: var(--fs-md); }
.btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }
.btn-outline {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  background: var(--card); color: var(--primary);
  border: 1px solid var(--border-blue); border-radius: var(--r-sm);
  padding: 8px 14px; font-size: var(--fs-md); font-weight: 600;
  cursor: pointer; transition: background 0.15s, transform 0.1s;
}
.btn-outline:hover { background: var(--primary-soft); }
.btn-outline.lg { padding: 10px 18px; font-size: var(--fs-base); }
.btn-outline.danger { color: var(--danger); border-color: var(--border-danger); }
.btn-outline.danger:hover { background: var(--danger-soft); }
.btn-ghost {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  background: var(--ghost); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  padding: 7px 11px; font-size: var(--fs-md); font-weight: 600;
  cursor: pointer; transition: background 0.15s, transform 0.1s;
}
.btn-ghost:hover { background: var(--well-hover); }
.btn-ghost.sm { padding: 6px 10px; font-size: var(--fs-sm); }
.btn-ghost.xs { padding: 4px 8px; font-size: var(--fs-xs); }
.btn-ghost:disabled { opacity: 0.55; cursor: not-allowed; }
.icon-btn {
  width: 30px; height: 30px; display: grid; place-items: center; padding: 0;
  background: var(--card); color: var(--text-dim);
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  cursor: pointer; transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.1s;
}
.icon-btn:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }
.icon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.icon-btn:disabled:hover { color: var(--text-dim); border-color: var(--border-strong); background: var(--card); }
.icon-btn.xs { width: 24px; height: 24px; border-radius: var(--r-xs); }

/* ============ 状态胶囊（通用，按状态语义成套：软底 + deep 深色文字） ============ */
.st-chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--fs-sm); font-weight: 600; padding: 3px 10px;
  border-radius: var(--r-pill); white-space: nowrap;
}
.st-chip.sm { font-size: var(--fs-xs); padding: 2px 8px; flex-shrink: 0; }
.st-plan { color: var(--accent-hover); background: var(--accent-soft); }
.st-dev { color: var(--primary); background: var(--primary-soft); }
.st-test { color: var(--sky-deep); background: var(--sky-soft); }
.st-pending { color: var(--warn-deep); background: var(--amber-soft); }
.st-wait { color: var(--sky-deep); background: var(--sky-soft); }
.st-live { color: var(--success-deep); background: var(--success-soft); }
.st-done { color: var(--success-deep); background: var(--success-soft); }
.st-fail { color: var(--danger-deep); background: var(--danger-soft); }

/* 类型 chip（问题类型 / 资料类型 / 发布用途），按类成套配色 */
.tc-chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: var(--fs-sm); font-weight: 600; padding: 4px 10px;
  border-radius: var(--r-pill); white-space: nowrap;
}
.tc-chip.sm { font-size: var(--fs-xs); padding: 3px 9px; }
.tc-danger { color: var(--danger-deep); background: var(--danger-soft); }
.tc-primary { color: var(--primary); background: var(--primary-soft); }
.tc-amber { color: var(--warn-deep); background: var(--amber-soft); }
.tc-neutral { color: var(--text-soft); background: var(--well); }
.tc-teal { color: var(--teal-deep); background: var(--teal-soft); }
.tc-sky { color: var(--sky-deep); background: var(--sky-soft); }
.tc-accent { color: var(--accent-hover); background: var(--accent-soft); }
.tc-note { color: var(--warn-deep); background: var(--amber-soft); }

/* ============ 骨架屏（数据加载占位，shimmer 呼吸；prefers-reduced-motion 全局降级为静态） ============ */
.skel-block {
  background: linear-gradient(90deg, var(--well) 25%, var(--well-hover) 37%, var(--well) 63%);
  background-size: 400% 100%;
  animation: skelShimmer 1.4s ease infinite;
  border-radius: var(--r-md);
}
@keyframes skelShimmer {
  0% { background-position: 100% 0; }
  100% { background-position: 0 0; }
}

/* ============ 全局右键菜单 ============ */
.ctx-menu { position: fixed; z-index: 400; min-width: 168px; padding: 6px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); box-shadow: 0 10px 32px rgba(16, 24, 40, 0.18); display: flex; flex-direction: column; gap: 2px; }
.ctx-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; border: none; background: none; border-radius: var(--r-xs); font-family: inherit; font-size: var(--fs-md); color: var(--text); text-align: left; cursor: pointer; transition: background 0.1s, color 0.1s; }
.ctx-item:hover { background: var(--primary-soft); color: var(--primary); }
.ctx-item.danger:hover { background: var(--danger-soft); color: var(--danger-deep); }
/* 右键菜单淡入淡出（全局定义；ConfirmDialog scoped 同名类不影响） */
.cf-fade-enter-active, .cf-fade-leave-active { transition: opacity 0.15s; }
.cf-fade-enter-from, .cf-fade-leave-to { opacity: 0; }

/* 深色模式兜底：状态/类型胶囊底色加深，文字提亮 */
@media (prefers-color-scheme: dark) {
  .btn-outline, .icon-btn { background: var(--card-raised); }
  .st-plan { color: var(--accent-soft-text); background: var(--accent-soft-deep); }
  .st-test, .st-wait { color: #7dd3fc; background: var(--sky-soft); }
  .st-pending { color: var(--amber-light); background: var(--warn-soft); }
  .st-live, .st-done { color: var(--success-light); background: var(--success-soft); }
  .st-fail { color: var(--danger-light); background: var(--danger-soft); }
  .tc-danger { color: var(--danger-soft-text); background: var(--danger-soft-deep); }
  .tc-primary { color: var(--primary-light); background: var(--primary-soft); }
  .tc-amber { color: var(--amber-light); background: var(--warn-soft); }
  .tc-teal { color: var(--teal-light); background: var(--teal-soft); }
  .tc-sky { color: #7dd3fc; background: var(--sky-soft); }
  .tc-accent { color: var(--accent-soft-text); background: var(--accent-soft-deep); }
  .tc-note { color: var(--amber-light); background: var(--warn-soft); }
  .st-dev { color: var(--primary-light); background: var(--primary-soft); }
}

/* ============ 深色模式：变量与 body 背景必须在非 scoped 块里，否则 :root/body 匹配不到 ============ */
@media (prefers-color-scheme: dark) {
  :root {
    /* UI 2.0：GitHub Dark 工作台（一等公民） */
    --bg: #0d1117;
    --card: #161b22;
    --text: #e6edf3;
    --muted: #8b949e;
    --border: #21262d;
    --border-strong: #30363d;
    --primary: #4493f8;
    --primary-hover: #58a6ff;
    --primary-soft: #1a3352;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.35), 0 8px 24px rgba(0, 0, 0, 0.45);
    --grad-brand: linear-gradient(135deg, #1f6feb, #4493f8 55%, #79c0ff);
    --card-border: #21262d;
    --shadow-tile: 0 5px 14px rgba(0, 0, 0, 0.4);
    /* 深色覆盖：中性层级 / 嵌入底 */
    --text-weak: #b7c0cf;
    --text-soft: #8b949e;
    --text-dim: #8b949e;
    --text-code: #cbd5e1;
    --faint: #3d444d;
    --well: #21262d;
    --well-hover: #262d36;
    --ghost: #21262d;
    --card-soft: #10151c;
    --card-raised: #1c2128;   /* 深色输入框/控件底 */
    --card-inset: #10151c;    /* 深色嵌套区块底 */
    /* 深色覆盖：描边 */
    --border-blue: #1f3a5f;
    --border-steel: #30363d;
    --border-danger: #5c2b2b;
    /* 紫系退役映射（深色：迁移到深色主色蓝；accent-soft-deep 等保留供旧组件兜底） */
    --accent: #4493f8;
    --accent-hover: #58a6ff;
    --accent-deep: #58a6ff;
    --accent-light: #79c0ff;
    --accent-soft: #152c47;
    --accent-border: #1f3a5f;
    --accent-soft-text: #79c0ff;
    --accent-tint: #111d2e;
    --accent-soft-deep: #152c47;
    --accent-soft-deep-hover: #11263c;
    --accent-border-deep: #1f3a5f;
    --grad-selected: linear-gradient(135deg, #152c47, #11263c);
    --grad-promo: linear-gradient(150deg, #141d2b, #101a26);
    /* 深色覆盖：状态色（GitHub Dark 语义色） */
    --success: #3fb950;
    --success-light: #7ee787;
    --success-soft: #103a26;
    --success-tint: #0f2e22;
    --success-deep: #3fb950;
    --success-border: #1f6f54;
    --warn: #d29922;
    --warn-soft: #3a2e10;
    --warn-tint: #332a0e;
    --warn-deep: #d29922;
    --warn-border: #6b5417;
    --amber: #d29922;
    --amber-light: #e3b341;
    --amber-bright: #d29922;
    --amber-soft: #33270f;
    --amber-border: #6b5417;
    --danger: #f85149;
    --danger-light: #ffa198;
    --danger-deep: #f85149;
    --danger-bright: #f85149;
    --danger-soft: #3d1d1d;
    --danger-soft-deep: #3a1c1c;
    --danger-soft-text: #fca5a5;
    --teal-soft: #0f2e2a;
    --sky-soft: #0c2a3a;
    /* 深色覆盖：代码块 */
    --code-bg: #161a21;
    --code-border: #343c4a;
    /* 深色覆盖：热力图 */
    --heat-0: #21262d;
    --heat-1: #1a2740;
    --heat-2: #1e3a8a;
    --heat-3: #2563eb;
    --heat-4: #3b82f6;
    --heat-text-1: #93c5fd;
    --heat-text-2: #bfdbfe;
    /* 深色覆盖：特殊用途 */
    --row-current: #3a2e10;
    --orb-opacity: 0.09;      /* 背景氛围减半，专注内容 */
    --bg-grad: linear-gradient(135deg, #0d1117 0%, #11151d 50%, #0d1219 100%);
  }
  body {
    background:
      radial-gradient(1200px 600px at 78% -8%, rgba(56, 139, 253, 0.13), transparent 60%),
      radial-gradient(1000px 520px at 100% 105%, rgba(88, 166, 255, 0.09), transparent 55%),
      var(--bg-grad);
  }
}

/* ============ 动效降级：系统开启"减弱动态效果"时，关闭位移/呼吸动画，仅保留透明度过渡 ============ */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .shell { transition: none; }
}
</style>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 224px 1fr;
  height: 100vh;
  overflow: hidden;
  transition: grid-template-columns 0.22s ease;
}
.shell.collapsed { grid-template-columns: 76px 1fr; }

/* 环境柔光（低饱和低透明度，仅作背景点缀；深色下经 --orb-opacity 减半） */
.orbs { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
.orb { position: absolute; border-radius: 50%; filter: blur(72px); opacity: var(--orb-opacity, 0.18); }
.o1 { width: 360px; height: 360px; background: radial-gradient(circle, rgba(9, 105, 218, 0.45), transparent 70%); top: -70px; right: 7%; animation: drift1 19s ease-in-out infinite; }
.o2 { width: 320px; height: 320px; background: radial-gradient(circle, rgba(88, 166, 255, 0.4), transparent 70%); bottom: -90px; right: 22%; animation: drift2 23s ease-in-out infinite; }
.o3 { width: 280px; height: 280px; background: radial-gradient(circle, rgba(56, 139, 253, 0.3), transparent 70%); top: 42%; left: 28%; animation: drift3 27s ease-in-out infinite; }
@keyframes drift1 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(-46px, 34px); } }
@keyframes drift2 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(34px, -44px); } }
@keyframes drift3 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(24px, 22px); } }

/* ============ 侧边栏 ============ */
.sidebar {
  display: flex;
  flex-direction: column;
  padding: 20px 14px 16px;
  background: rgba(255, 255, 255, 0.65);
  backdrop-filter: blur(20px) saturate(140%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  border-right: 1px solid rgba(216, 222, 228, 0.9);
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: hidden;
}
.brand { display: flex; align-items: center; gap: 12px; padding: 4px 8px 22px; }
/* 品牌区子元素不拦截鼠标，拖拽落到 .brand 的 drag-region 上（可拖动窗口） */
.brand > * { pointer-events: none; }
.brand-logo {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r-md);
  background: var(--grad-brand);
  color: var(--text-invert);
  box-shadow: var(--glow-md);
}
.brand-name { font-size: var(--fs-lg); font-weight: 700; letter-spacing: 0.3px; white-space: nowrap; }

/* nav 可滚：min-height:0 解除 flex 默认不收缩；负 margin+同值 padding 把滚动区撑到侧边栏边缘，选中项左侧指示条（left:-14px）不被裁 */
.nav { display: flex; flex-direction: column; gap: 9px; flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; margin: 0 -14px; padding: 0 14px; scrollbar-width: thin; scrollbar-color: var(--border-steel) transparent; }
.nav-item { flex-shrink: 0; }
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--card-border);
  background: var(--card);
  padding: 11px 12px;
  border-radius: var(--r-md);
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-weak);
  cursor: pointer;
  white-space: nowrap;
  box-shadow: 0 1px 2px rgba(35, 43, 66, 0.04), 0 6px 16px rgba(35, 43, 66, 0.05);
  transition: background 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s, border-color 0.15s;
}
.nav-ico { display: grid; place-items: center; flex-shrink: 0; width: 24px; color: var(--text-weak); }
.nav-item:hover .nav-ico { color: var(--primary-hover); }
.nav-item.on .nav-ico { color: var(--primary-hover); }
.nav-item:hover { color: var(--primary-hover); transform: translateY(-1px); box-shadow: 0 2px 4px rgba(35, 43, 66, 0.05), 0 10px 22px rgba(35, 43, 66, 0.08); }
/* 键盘导航的焦点框用主题紫柔化，覆盖浏览器默认黑框 */
.nav-item:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.nav-item.on { background: var(--grad-selected); color: var(--primary-hover); border-color: var(--border-blue); box-shadow: 0 1px 2px rgba(37, 99, 235, 0.06), 0 8px 20px rgba(37, 99, 235, 0.1); }
.nav-item.on::before {
  content: "";
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 22px;
  border-radius: 0 4px 4px 0;
  background: var(--primary);
}

/* 侧边栏底部（收起钉底 + 设置入口） */
.side-foot { display: flex; flex-direction: column; gap: 7px; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--card-border); }

.collapse {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid transparent;
  background: none;
  padding: 6px 8px;
  border-radius: var(--r-md);
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.collapse:hover { background: var(--card); border-color: var(--card-border); color: var(--primary); }
.collapse.on { background: var(--grad-selected); border-color: var(--border-blue); color: var(--primary-hover); }
.collapse:hover .clp-ico { background: var(--primary-soft); color: var(--primary); }
.clp-ico {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm);
  background: var(--well);
  color: var(--text-weak);
  transition: background 0.15s, color 0.15s;
}
.clp-ico svg { transition: transform 0.22s ease; }
.clp-ico svg.flip { transform: scaleX(-1); }

/* 收起态 */
.shell.collapsed .brand { justify-content: center; padding-left: 0; padding-right: 0; }
.shell.collapsed .brand-name,
.shell.collapsed .nav-label { display: none; }
.shell.collapsed .nav-item { justify-content: center; padding-left: 0; padding-right: 0; }
.shell.collapsed .collapse { justify-content: center; padding-left: 0; padding-right: 0; }

/* ============ 主区 ============ */
.main { display: flex; flex-direction: column; min-width: 0; height: 100vh; overflow: hidden; position: relative; z-index: 1; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 30px 14px;
  flex-shrink: 0;
}
/* 页面标题区不拦截鼠标，拖拽落到 topbar 的 drag-region 上（可拖动窗口/双击最大化）；flex-shrink:0 保证窄窗口时标题优先不被挤压 */
.page-title { display: flex; align-items: center; gap: 13px; min-width: 0; flex-shrink: 0; pointer-events: none; }
.pt-ico {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r-md);
  background: var(--primary-soft);
  color: var(--primary-hover);
  box-shadow: 0 8px 20px color-mix(in srgb, var(--primary) 28%, transparent);
}
.pt-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pt-text h1 { margin: 0; font-size: var(--fs-xl); font-weight: 700; letter-spacing: 0.2px; white-space: nowrap; }
.pt-desc { font-size: var(--fs-sm); color: var(--muted); white-space: nowrap; }
.top-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 1; min-width: 0; }
/* 图标按钮/通知/头像/窗口控制不收缩，窄窗时只压缩搜索框，保证最小化/最大化/关闭永远可见可点 */
.top-actions > * { flex-shrink: 0; }
/* 全局搜索框可收缩：窄窗口时先缩搜索框宽度（省略号兜底），而不是挤压页面标题 */
.top-actions :deep(.gs-trigger) { flex-shrink: 1; min-width: 0; }
.theme-btn { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-sm); color: var(--muted); cursor: pointer; transition: all 0.15s; }
.theme-btn:hover { border-color: var(--primary); color: var(--primary); }

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
.np-head { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px 10px; border-bottom: 1px solid var(--border); }
.np-head b { font-size: var(--fs-base); }
.np-clear { border: none; background: none; font-size: var(--fs-sm); color: var(--muted); cursor: pointer; padding: 2px 6px; border-radius: var(--r-xs); }
.np-clear:hover { color: var(--danger); background: var(--danger-soft); }
.np-list { overflow-y: auto; padding: 6px 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.np-item { display: flex; align-items: flex-start; gap: 8px; padding: 9px 8px; border-radius: var(--r-sm); }
.np-item.unread { background: var(--primary-soft); }
.np-tag { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 700; padding: 2px 8px; border-radius: var(--r-pill); background: var(--well); color: var(--text-weak); margin-top: 1px; }
.np-tag.release { background: var(--warn-soft); color: var(--warn); }
.np-tag.backup { background: var(--success-soft); color: var(--success-deep); }
.np-tag.sync { background: var(--primary-soft); color: var(--primary); }
.np-text { flex: 1; min-width: 0; font-size: var(--fs-sm); line-height: var(--lh-body); color: var(--text); word-break: break-word; }
.np-time { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
.np-empty { margin: 0; padding: 22px 20px 26px; font-size: var(--fs-sm); color: var(--muted); text-align: center; }

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

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }

/* 视图切换动画：入场淡入 + 上移 6px（组件 key 重建触发；无 leave，reduced-motion 全局降级） */
.body > * { animation: viewIn 0.18s ease; }
@keyframes viewIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}

/* 顶栏中部品牌条（原底部页脚上移）：吸收中间富余空间，居中、不拦鼠标以不影响拖拽 */
.top-brand { flex: 1; min-width: 0; text-align: center; font-size: var(--fs-sm); color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; user-select: none; }
.tb-ver { display: inline-flex; align-items: center; gap: 3px; margin-left: 8px; padding: 1px 8px; border: none; border-radius: var(--r-pill); font-family: var(--font-num); font-size: var(--fs-sm); font-weight: 600; color: var(--accent-hover); background: var(--accent-soft); cursor: pointer; pointer-events: auto; transition: background 0.15s, color 0.15s; }
.tb-ver:hover { color: var(--text-invert); background: var(--accent); }
.tb-ver:disabled { cursor: default; opacity: 0.7; }
.tbv-ico { opacity: 0.55; transition: opacity 0.15s, transform 0.4s; }
.tb-ver:hover .tbv-ico { opacity: 1; }
.tb-ver.checking .tbv-ico { animation: tbv-spin 0.9s linear infinite; }
@keyframes tbv-spin { to { transform: rotate(360deg); } }

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
  gap: 14px;
  max-width: calc(100vw - 60px);
}
.toast-act {
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.28);
  color: var(--primary-bright);
  font-size: var(--fs-md);
  font-weight: 700;
  padding: 4px 12px;
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background 0.15s;
}
.toast-act:hover { background: rgba(255, 255, 255, 0.24); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* ============ 深色模式（组件级覆盖，变量在全局块已翻转） ============ */
@media (prefers-color-scheme: dark) {
  .sidebar { background: rgba(13, 17, 23, 0.72); border-right-color: var(--border); }
  .nav { scrollbar-color: var(--faint) transparent; }
  .nav-item:hover { background: rgba(56, 139, 253, 0.12); }
  .pt-ico { background: var(--card-raised); }
  .theme-btn { background: var(--card-raised); }
}

/* ============ 小窗口适配：按宽度逐步隐藏次要信息，标题永不竖排 ============ */
@media (max-width: 1180px) {
  .pt-desc { display: none; }   /* 先藏副标题说明 */
}
@media (max-width: 1020px) {
  .top-brand { display: none; } /* 再藏中部品牌条（含版本胶囊） */
}
@media (max-width: 920px) {
  .pt-ico { display: none; }    /* 最后藏页面图标，只留标题文字 */
  .topbar { padding-left: 20px; padding-right: 20px; }
}
/* 矮窗口：压缩顶栏纵向留白，把空间留给内容区 */
@media (max-height: 720px) {
  .topbar { padding-top: 14px; padding-bottom: 10px; }
}
</style>
