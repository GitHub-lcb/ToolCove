<script setup>
// 生成结果的媒体卡片：图片与视频都走 asset 协议直接加载（media/ 目录在 assetProtocol scope 内），
// 不经 IPC、不做 base64。media/ 里的文件可能已被清理或来自旧备份（恢复旧备份不携带 media/），
// 读取失败一律显示占位。
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../../platform/invoke.js";
import { isDesktop } from "../../platform/env.js";
import { fileAssetUrl } from "../../platform/image.js";
import { openPath, revealPath } from "../../platform/shell.js";
import { save as saveDialog } from "../../platform/dialog.js";
import Icon from "../../ui/Icon.vue";

const props = defineProps({
  name: { type: String, required: true },
  kind: { type: String, default: "image" },
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();
const url = ref("");
const missing = ref(false);
const srcKind = ref("");

onMounted(async () => {
  try {
    if (!isDesktop) {
      missing.value = true;
      return;
    }
    const path = await invoke("media_path", { name: props.name });
    url.value = await fileAssetUrl(path);
    srcKind.value = props.kind === "video" ? "video" : "image";
  } catch {
    missing.value = true;
  }
});

async function open() {
  try {
    const path = await invoke("media_path", { name: props.name });
    await openPath(path);
  } catch {
    props.showToast(t("toolbox.prompt.histMediaMissing"));
  }
}

async function reveal() {
  try {
    const path = await invoke("media_path", { name: props.name });
    await revealPath(path);
  } catch {
    props.showToast(t("toolbox.prompt.histMediaMissing"));
  }
}

async function saveAs() {
  const path = await saveDialog({ defaultPath: props.name });
  if (!path) return;
  try {
    await invoke("media_export", { name: props.name, dest: path });
    props.showToast(t("toolbox.prompt.resultSaved"));
  } catch (error) {
    props.showToast(String(error?.message ?? error));
  }
}
</script>

<template>
  <div class="pm-card" :data-role="'media-' + name">
    <div class="pm-body">
      <img v-if="srcKind === 'image' && url" :src="url" :alt="name" />
      <video v-else-if="srcKind === 'video' && url" :src="url" controls preload="metadata"></video>
      <div v-else-if="missing" class="pm-missing">{{ t("toolbox.prompt.histMediaMissing") }}</div>
      <div v-else class="pm-missing">{{ kind === "video" ? t("toolbox.prompt.videoHint") : t("toolbox.prompt.progressIndeterminate") }}</div>
    </div>
    <div class="pm-meta">
      <span class="pm-name" :title="name">{{ name }}</span>
      <div class="pm-actions">
        <button type="button" class="mini" :title="t('toolbox.prompt.resultOpen')" @click="open"><Icon name="open" :size="13" /></button>
        <button type="button" class="mini" :title="t('toolbox.prompt.resultReveal')" @click="reveal"><Icon name="folder" :size="13" /></button>
        <button type="button" class="mini" :title="t('toolbox.prompt.resultSaveAs')" @click="saveAs"><Icon name="download" :size="13" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pm-card {
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm, 8px);
  overflow: hidden;
  background: var(--card);
  min-width: 0;
}
.pm-body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  max-height: 320px;
  background: var(--well);
}
.pm-body img,
.pm-body video {
  max-width: 100%;
  max-height: 320px;
  display: block;
}
.pm-missing {
  padding: 24px var(--sp-4);
  font-size: var(--fs-sm);
  color: var(--text-weak);
  text-align: center;
}
.pm-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
}
.pm-name {
  font-size: var(--fs-sm);
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pm-actions {
  display: flex;
  gap: var(--sp-05);
  flex-shrink: 0;
}
.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: var(--r-xs, 6px);
  background: transparent;
  color: var(--text-weak);
  cursor: pointer;
}
.mini:hover {
  background: var(--ghost);
  color: var(--text);
}
</style>
