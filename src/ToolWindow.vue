<script setup>
// 工具箱工具独立窗口容器：迷你标题栏（拖拽区 + 最小化/关闭）+ 工具组件
import { computed, onBeforeUnmount, onErrorCaptured, onMounted, provide, ref, watch } from "vue";
import { getCurrentWindow } from "./platform/window.js";
import { applyAccent, resetAccent, loadAccentKey } from "./accentTheme.js";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";
import { TOOLBOX_TOOLS } from "./toolboxTools.js";
import { getToolComponent } from "./toolComponents.js";
import { formatLoadErrorDetail } from "./toolWindow.js";
import ToolErrorPanel from "./ToolErrorPanel.vue";
import { flushToolbox } from "./toolboxStore.js";
import { flushSecureToolbox } from "./secureToolbox.js";

const props = defineProps({
  tool: { type: String, required: true }, // 注册表 key，见 toolboxTools.js
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["ready"]);

const { t } = useI18n();

// 工具窗口是独立 JS realm：主题色在本窗口自行应用（主窗口切换后重开窗口生效）
const themeAccentMode = ref("system");
function applyWindowAccent() {
  const key = loadAccentKey();
  if (!key) {
    resetAccent();
    return;
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches || false;
  if (!applyAccent(key, themeAccentMode.value, prefersDark)) resetAccent();
}

const meta = computed(() => TOOLBOX_TOOLS.find((t) => t.key === props.tool) || TOOLBOX_TOOLS.find((t) => t.key === "json"));
const toolComponent = computed(() => getToolComponent(props.tool));

// 工具加载/初始化的兜底出口。
// 窗口是 visible:false 建的，靠 @ready 或 App.vue 的 3s 兜底才 show；而 <Suspense> 只负责「等待时显示 fallback」——
// 一旦动态 import 失败、或工具 setup/首次渲染抛错，这里就会永远停在纯底色 fallback 上：
// 用户看到的是「窗口开着但一片空白」，只能按 F12 才知道发生了什么。
// 这里把错误接住渲染成可见面板，并立刻把窗口显示出来。
const TOOL_LOAD_TIMEOUT_MS = 15000;
const loadError = ref(null);
let loadTimer = null;

function failTool(reasonKey, hintKey, detail, hintParams) {
  if (loadError.value) return; // 首个错误为准，后续重复错误不再覆盖
  loadError.value = { reason: t(reasonKey), hint: t(hintKey, hintParams), detail };
  reveal();
}
function reveal() {
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
  emit("ready");
}
// errorCaptured 能同时接住两类错误：异步组件 import 失败、工具组件 setup/渲染抛错
// （两者都沿组件链向上冒泡到这里，见 Vue 的 handleError）。
onErrorCaptured((err, _instance, info) => {
  console.error(t("common.toolLoadFail"), { tool: props.tool, err, info });
  failTool("common.toolLoadFail", "common.toolLoadFailHint", formatLoadErrorDetail(err, info), { tool: t(meta.value.labelKey) });
  return false; // 已自行展示，阻断继续上报，避免控制台再刷一遍「Unhandled error」
});
onMounted(() => {
  // import 既不 resolve 也不 reject（资源请求挂死）时也要有出路
  loadTimer = setTimeout(() => failTool("common.toolLoadTimeout", "common.toolLoadTimeoutHint", "", { sec: TOOL_LOAD_TIMEOUT_MS / 1000 }), TOOL_LOAD_TIMEOUT_MS);
});

// 置顶：把工具窗口压在其它窗口之上，用于「显示辅助」类工具浮在游戏画面上。
// 偏好全局记忆（所有工具窗口共用），窗口打开时自动恢复；属性失败即回滚，
// 避免按钮显示的状态与窗口真实状态不一致（例如权限未授予）。
const PIN_KEY = "toolWindowAlwaysOnTop";
const pinned = ref(false);
function setPinned(value) {
  pinned.value = value;
  localStorage.setItem(PIN_KEY, value ? "1" : "0");
  getCurrentWindow().setAlwaysOnTop(value).catch(() => {
    pinned.value = !value;
    localStorage.setItem(PIN_KEY, value ? "0" : "1");
  });
}
function togglePin() {
  setPinned(!pinned.value);
}

// 悬浮模式：工具可以请求收掉窗口装饰，把面积让给内容（铁路大亨驾驶舱用它只留结论与录入）。
// 状态由容器持有并按工具 key 持久化——「在驾驶舱里开了悬浮」不会顺手把别的工具的标题栏也藏了；
// 工具侧通过 inject("toolWindowChrome") 拿到同一份响应式状态，不需要 prop 透传
// （透传会给所有其它工具挂上多余的监听器，Vue 会警告 extraneous listeners）。
// 注意：这里不缩短窗口尺寸——改尺寸要 core:window:allow-set-size 权限，而权限清单是 Rust 侧配置，
// 加它得重启再编译一次；收掉两条标题栏已经还给内容约 52px。
const COMPACT_KEY = "toolWindowCompact:";
const compact = ref(false);
function setCompact(value) {
  compact.value = !!value;
  localStorage.setItem(COMPACT_KEY + props.tool, value ? "1" : "0");
}
// 不置顶的悬浮窗没有意义，进入悬浮即置顶；退出后保持置顶（用户可自己取消）。
watch(compact, (v) => {
  if (v && !pinned.value) setPinned(true);
});
provide("toolWindowChrome", { compact, setCompact });

// 关闭窗口前冲刷待写草稿：拦截关闭请求 → 落盘 → 再销毁。
// 防抖窗口（200ms）内的最后一次输入若直接关窗会丢，这里补上可靠的落盘路径
// （标题栏按钮、Alt+F4、任务栏关闭都会走 CloseRequested）。
// 注意：注册了 onCloseRequested 后，实际关闭一律由 JS 侧 destroy() 完成，
// 因此 capabilities 必须授予 core:window:allow-destroy，否则窗口无法关闭。
let unlistenClose = null;
let closing = false;
onMounted(async () => {
  // 悬浮偏好只决定「窗口装饰显不显示」，与平台无关，所以在 Tauri 判断之前恢复：
  // 浏览器预览（?tool=rail）里因此也是同一套行为，可以直接拿来量测。
  if (localStorage.getItem(COMPACT_KEY + props.tool) === "1") compact.value = true;
  if (!window.__TAURI_INTERNALS__) return;
  themeAccentMode.value = localStorage.getItem("themeMode") || "system";
  applyWindowAccent();
  // 恢复上次的置顶偏好（本窗口关闭前若处于置顶，重开后继续置顶）
  if (localStorage.getItem(PIN_KEY) === "1") setPinned(true);
  // 关闭窗口前冲刷待写草稿（原有逻辑，保留在主题色初始化之后注册）
  getCurrentWindow().onCloseRequested(async (event) => {
    // 每个关闭请求都阻止默认行为，统一走「冲刷 → destroy」路径；
    // 冲刷期间的重复关闭请求不再重复处理，由首次处理者完成关闭
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      await Promise.race([
        Promise.all([flushToolbox(), flushSecureToolbox()]),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch { /* 冲刷失败也继续关闭 */ }
    getCurrentWindow().destroy().catch(() => {
      closing = false; // 销毁失败恢复可重试，避免窗口永久卡死
    });
  }).then((unlisten) => {
    unlistenClose = unlisten;
  });
});
onBeforeUnmount(() => {
  unlistenClose?.();
  unlistenClose = null;
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
  flushToolbox();
  flushSecureToolbox();
});

function winMinimize() {
  getCurrentWindow().minimize().catch(() => {});
}
function winClose() {
  getCurrentWindow().close().catch(() => {});
}
</script>

<template>
  <div class="tool-win">
    <!-- 迷你标题栏：整条拖拽区，子元素不拦鼠标 -->
    <header class="tw-bar" :class="{ compact }" data-tauri-drag-region>
      <div class="tw-title">
        <span class="tw-ico"><Icon :name="meta.icon" :size="16" /></span>
        <b>{{ t(meta.labelKey) }}</b>
        <span class="tw-hint">{{ compact ? t("common.winFloatHint") : t("common.toolWindowHint") }}</span>
      </div>
      <div class="tw-ctrls">
        <!-- 悬浮模式下多出「退出悬浮」：顶栏被收掉了，这里是回到完整窗口的唯一入口 -->
        <button
          v-if="compact"
          class="twc"
          :title="t('common.winFloatOff')"
          :aria-label="t('common.winFloatOff')"
          @click="setCompact(false)"
        ><Icon name="chevrons-right" :size="14" /></button>
        <button
          class="twc"
          :class="{ on: pinned }"
          :title="pinned ? t('common.winUnpin') : t('common.winPin')"
          :aria-pressed="pinned"
          @click="togglePin"
        ><Icon name="pin" :size="14" /></button>
        <button class="twc" :title="t('common.winMinimize')" @click="winMinimize"><Icon name="minus" :size="13" /></button>
        <button class="twc close" :title="t('common.winClose')" @click="winClose"><Icon name="x" :size="14" /></button>
      </div>
    </header>

    <main class="tw-body">
      <!-- 工具加载/初始化失败：给出明确报错与原因，而不是留一个永远空白的窗口 -->
      <ToolErrorPanel v-if="loadError" :reason="loadError.reason" :hint="loadError.hint" :detail="loadError.detail" />
      <Suspense v-else @resolve="reveal">
        <component :is="toolComponent" :show-toast="showToast" />
        <template #fallback><div class="tw-loading" aria-hidden="true"></div></template>
      </Suspense>
    </main>
  </div>
</template>

<style scoped>
.tool-win { display: flex; flex-direction: column; height: 100vh; overflow: hidden; background: var(--bg); }

/* 迷你标题栏 */
.tw-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 40px;
  padding: 0 8px 0 14px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.tw-bar > * { pointer-events: none; }
.tw-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tw-ico { width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--r-xs); background: var(--primary-soft); color: var(--primary-hover); box-shadow: var(--glow-sm); flex-shrink: 0; }
.tw-title b { font-size: var(--fs-md); white-space: nowrap; }
.tw-hint { font-size: var(--fs-xs); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 悬浮模式：标题栏压成 22px 窄条，只留拖拽区与三个按钮 */
.tw-bar.compact { height: 22px; padding: 0 4px 0 8px; gap: 8px; }
.tw-bar.compact .tw-ico { display: none; }
.tw-bar.compact .tw-title b { font-size: var(--fs-xs); }
.tw-bar.compact .tw-hint { font-size: var(--fs-xs); }
.tw-bar.compact .twc { width: 26px; height: 18px; }
.tw-ctrls { display: flex; gap: 2px; pointer-events: auto !important; flex-shrink: 0; }
.twc { width: 34px; height: 30px; padding: 0; display: grid; place-items: center; border: none; background: transparent; color: var(--text-weak); border-radius: var(--r-xs); cursor: pointer; transition: background 0.15s, color 0.15s; }
.twc:hover { background: var(--well); color: var(--text); }
.twc.close:hover { background: var(--win-close); color: var(--text-invert); }
/* 置顶激活态：用主色常驻高亮，提醒「这个窗口正压在所有窗口之上」 */
.twc.on { background: var(--primary-soft); color: var(--primary-hover); }
.twc.on:hover { background: var(--primary-soft-hover); color: var(--primary-hover); }

.tw-body { flex: 1; min-height: 0; padding: 12px; overflow: hidden; }
.tw-loading { width: 100%; height: 100%; background: var(--bg); }

@media (prefers-color-scheme: dark) {
  .tw-bar { background: var(--card); border-bottom-color: var(--border); }
  .tw-hint { color: var(--muted); }
}
</style>
