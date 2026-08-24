<script setup>
// 工具箱工具独立窗口容器：迷你标题栏（拖拽区 + 最小化/关闭）+ 工具组件
import { computed, onBeforeUnmount, onMounted } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";
import { TOOLBOX_TOOLS } from "./toolboxTools.js";
import { getToolComponent } from "./toolComponents.js";
import { flushToolbox } from "./toolboxStore.js";
import { flushSecureToolbox } from "./secureToolbox.js";

const props = defineProps({
  tool: { type: String, required: true }, // 注册表 key，见 toolboxTools.js
  showToast: { type: Function, default: () => {} },
});
const emit = defineEmits(["ready"]);

const { t } = useI18n();

const meta = computed(() => TOOLBOX_TOOLS.find((t) => t.key === props.tool) || TOOLBOX_TOOLS.find((t) => t.key === "json"));
const toolComponent = computed(() => getToolComponent(props.tool));

// 关闭窗口前冲刷待写草稿：拦截关闭请求 → 落盘 → 再销毁。
// 防抖窗口（200ms）内的最后一次输入若直接关窗会丢，这里补上可靠的落盘路径
// （标题栏按钮、Alt+F4、任务栏关闭都会走 CloseRequested）。
// 注意：注册了 onCloseRequested 后，实际关闭一律由 JS 侧 destroy() 完成，
// 因此 capabilities 必须授予 core:window:allow-destroy，否则窗口无法关闭。
let unlistenClose = null;
let closing = false;
onMounted(() => {
  if (!window.__TAURI_INTERNALS__) return;
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
    <header class="tw-bar" data-tauri-drag-region>
      <div class="tw-title">
        <span class="tw-ico"><Icon :name="meta.icon" :size="16" /></span>
        <b>{{ meta.label }}</b>
        <span class="tw-hint">{{ t("common.toolWindowHint") }}</span>
      </div>
      <div class="tw-ctrls">
        <button class="twc" :title="t('common.winMinimize')" @click="winMinimize"><Icon name="minus" :size="13" /></button>
        <button class="twc close" :title="t('common.winClose')" @click="winClose"><Icon name="x" :size="14" /></button>
      </div>
    </header>

    <main class="tw-body">
      <Suspense @resolve="emit('ready')">
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
.tw-ctrls { display: flex; gap: 2px; pointer-events: auto !important; flex-shrink: 0; }
.twc { width: 34px; height: 30px; padding: 0; display: grid; place-items: center; border: none; background: transparent; color: var(--text-weak); border-radius: var(--r-xs); cursor: pointer; transition: background 0.15s, color 0.15s; }
.twc:hover { background: var(--well); color: var(--text); }
.twc.close:hover { background: var(--win-close); color: var(--text-invert); }

.tw-body { flex: 1; min-height: 0; padding: 12px; overflow: hidden; }
.tw-loading { width: 100%; height: 100%; background: var(--bg); }

@media (prefers-color-scheme: dark) {
  .tw-bar { background: var(--card); border-bottom-color: var(--border); }
  .tw-hint { color: var(--muted); }
}
</style>
