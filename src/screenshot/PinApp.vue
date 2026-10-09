<script setup>
// 贴图窗口（?shot=pin，标签 tool-pin-<n>）：把一张 PNG 钉在屏幕最上层。
// 交互：拖动窗口、滚轮以光标为锚点缩放、双击/Esc 关闭、右键菜单（复制/另存为/重置缩放/关闭）。
// 缩放的几何计算在 Rust（pin_zoom）：那里能直接取全局光标坐标，避免前端两套坐标系猜来猜去。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { getCurrentWindow } from "../platform/window.js";
import { save } from "../platform/dialog.js";
import Icon from "../Icon.vue";
import { base64ToBytes, bytesToBlobUrl } from "./png.js";

const { t } = useI18n();
// 渲染冒烟测试跑在 Node（无 window）：拿不到窗口标签就给个占位，组件只做首屏渲染
const label = typeof window === "undefined" ? "" : getCurrentWindow().label || "";

const phase = ref("loading"); // loading | ready | closing
const imageUrl = ref("");
const failure = ref("");
const menu = ref({ visible: false, x: 0, y: 0 });
let blobUrl = "";

const menuStyle = computed(() => ({
  left: `${Math.min(menu.value.x, Math.max(window.innerWidth - 170, 4))}px`,
  top: `${Math.min(menu.value.y, Math.max(window.innerHeight - 160, 4))}px`,
}));

async function fetchPng() {
  const b64 = await invoke("pin_image", { label });
  return b64;
}

async function closePin() {
  phase.value = "closing";
  try {
    await invoke("pin_close", { label });
  } catch {
    getCurrentWindow().close().catch(() => {});
  }
}

async function copyPin() {
  menu.value.visible = false;
  try {
    await invoke("pin_copy", { label });
  } catch (e) {
    failure.value = String(e?.message || e);
    setTimeout(() => (failure.value = ""), 2600);
  }
}

async function savePin() {
  menu.value.visible = false;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const path = await save({
    defaultPath: `paste-${stamp}.png`,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!path) return;
  try {
    const b64 = await fetchPng();
    await invoke("export_file_b64", { path, contentB64: b64 });
  } catch (e) {
    failure.value = String(e?.message || e);
    setTimeout(() => (failure.value = ""), 2600);
  }
}

async function resetZoom() {
  menu.value.visible = false;
  try {
    await invoke("pin_zoom", { label, factor: 0 });
  } catch {
    /* 窗口可能已关 */
  }
}

function onWheel(event) {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
  invoke("pin_zoom", { label, factor }).catch(() => {});
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  if (menu.value.visible) {
    menu.value.visible = false;
    return;
  }
  getCurrentWindow().startDragging().catch(() => {});
}

function onContextMenu(event) {
  event.preventDefault();
  menu.value = { visible: true, x: event.clientX, y: event.clientY };
}

function onKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    if (menu.value.visible) menu.value.visible = false;
    else closePin();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === "c" || event.key === "C")) {
    event.preventDefault();
    copyPin();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("click", () => (menu.value.visible = false));
  try {
    const b64 = await fetchPng();
    blobUrl = bytesToBlobUrl(base64ToBytes(b64));
    imageUrl.value = blobUrl;
    phase.value = "ready";
    await getCurrentWindow().show();
  } catch (e) {
    failure.value = String(e?.message || e);
    phase.value = "closing";
    closePin();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});
</script>

<template>
  <div class="pin-root" @pointerdown="onPointerDown" @dblclick="closePin" @contextmenu="onContextMenu" @wheel="onWheel">
    <img v-if="imageUrl" class="pin-image" :src="imageUrl" alt="" draggable="false" />
    <div v-else-if="failure" class="pin-error">{{ failure }}</div>

    <div v-if="menu.visible" class="pin-menu" :style="menuStyle" @pointerdown.stop @click.stop>
      <button class="menu-item" @click="copyPin"><Icon name="copy" :size="13" />{{ t("screenshot.menuCopy") }}</button>
      <button class="menu-item" @click="savePin"><Icon name="download" :size="13" />{{ t("screenshot.menuSaveAs") }}</button>
      <button class="menu-item" @click="resetZoom"><Icon name="repeat" :size="13" />{{ t("screenshot.menuResetZoom") }}</button>
      <button class="menu-item danger" @click="closePin"><Icon name="x" :size="13" />{{ t("screenshot.menuClose") }}</button>
    </div>
  </div>
</template>

<style scoped>
.pin-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  cursor: move;
  user-select: none;
  background: #0b0e14;
}
.pin-image { width: 100%; height: 100%; display: block; object-fit: fill; -webkit-user-drag: none; }
.pin-error { padding: 12px; color: #f85149; font-size: 12px; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }

.pin-menu {
  position: fixed;
  min-width: 158px;
  padding: 5px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: default;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border: none;
  border-radius: 6px;
  background: none;
  color: #c9d1d9;
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.menu-item:hover { background: #1a3352; color: #79c0ff; }
.menu-item.danger:hover { background: #3d1d1d; color: #f85149; }
</style>
