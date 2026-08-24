<script setup>
import Icon from "../Icon.vue";
import { formatFileSize } from "../fileTool.js";

defineProps({
  source: { type: Object, default: null },
  output: { type: Object, default: null },
  error: { type: String, default: "" },
});
defineEmits(["save"]);
</script>

<template>
  <section class="preview-panel">
    <header class="panel-head">
      <b>图片预览</b>
      <span v-if="output">{{ output.width }} × {{ output.height }}</span>
      <button v-if="output" class="icon-btn xs" title="保存图片" @click="$emit('save')"><Icon name="download" :size="13" /></button>
    </header>
    <div v-if="error" class="preview-error"><Icon name="alert" :size="22" />{{ error }}</div>
    <div v-else-if="source" class="preview-grid">
      <figure>
        <img :src="source.url" :alt="source.file.name" />
        <figcaption>原图 · {{ source.width }} × {{ source.height }}</figcaption>
      </figure>
      <figure>
        <img v-if="output" :src="output.url" :alt="output.name" />
        <span v-else class="preview-wait"><Icon name="image" :size="28" /></span>
        <figcaption>{{ output ? `处理结果 · ${output.name}` : "等待生成" }}</figcaption>
      </figure>
    </div>
    <div v-else class="preview-empty"><span class="empty-ico"><Icon name="image" :size="32" /></span><b>还没有待处理图片</b></div>
    <footer v-if="output" class="preview-footer">
      <span>{{ output.name }} · {{ formatFileSize(output.blob.size) }}</span>
      <button class="btn-primary sm" @click="$emit('save')"><Icon name="download" :size="14" />保存图片</button>
    </footer>
  </section>
</template>

<style scoped>
.preview-panel { position: relative; min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.panel-head { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.panel-head > span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.panel-head .icon-btn { margin-left: var(--sp-1); }
.preview-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); padding: var(--sp-3); background: var(--card-soft); }
.preview-grid figure { min-width: 0; min-height: 0; margin: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--well); }
.preview-grid img { flex: 1; min-height: 0; width: 100%; object-fit: contain; background-image: linear-gradient(45deg, color-mix(in srgb, var(--text) 7%, transparent) 25%, transparent 25%), linear-gradient(-45deg, color-mix(in srgb, var(--text) 7%, transparent) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--text) 7%, transparent) 75%), linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--text) 7%, transparent) 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0; }
.preview-grid figcaption { flex-shrink: 0; overflow: hidden; padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border); background: var(--card); color: var(--muted); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.preview-wait { flex: 1; display: grid; place-items: center; color: var(--faint); }
.preview-empty, .preview-error { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-3); color: var(--muted); }
.preview-empty b { color: var(--text-weak); font-size: var(--fs-md); }
.preview-error { padding: var(--sp-5); background: var(--danger-soft); color: var(--danger-deep); text-align: center; }
.preview-footer { flex-shrink: 0; min-height: 44px; display: flex; align-items: center; gap: var(--sp-3); padding: 0 var(--sp-4); border-top: 1px solid var(--border); }
.preview-footer span { flex: 1; min-width: 0; overflow: hidden; color: var(--muted); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
</style>
