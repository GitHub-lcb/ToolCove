<script setup>
// 照片列表缩略图：进入视口才去取（列表可能上千行，不做无谓的下载）。
// Rust 侧会缩到 96px 并落盘缓存，同一对象跨会话不再走网络；
// 失败（网络/格式不支持）保持占位图标——列表里几十行并发取图，逐行弹错误只会变成报警墙。
import { onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "../../ui/Icon.vue";
import { invoke } from "../../platform/invoke.js";

const props = defineProps({
  config: { type: Object, required: true },
  photoKey: { type: String, required: true },
});

const root = ref(null);
const src = ref("");
let observer = null;

async function load() {
  try {
    const result = await invoke("photo_thumb", { config: props.config, key: props.photoKey });
    if (result?.dataUrl) src.value = result.dataUrl;
  } catch {
    // 保持占位图标即可，不打扰用户
  }
}

onMounted(() => {
  if (typeof IntersectionObserver === "undefined") {
    load();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        observer = null;
        load();
      }
    },
    { rootMargin: "160px" }
  );
  observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <span ref="root" class="photo-thumb" data-role="thumb">
    <img v-if="src" :src="src" alt="" />
    <Icon v-else name="camera" :size="15" />
  </span>
</template>

<style scoped>
.photo-thumb {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--ghost);
  color: var(--faint);
}

.photo-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
