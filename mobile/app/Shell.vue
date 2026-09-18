<script setup>
// Phase 1 的壳：确认「平台判定 + 原生桥 + 字典」三件事都到位。
// 这里刻意不画最终界面——页面结构在 Phase 2/3 按模块替换，先用一屏自证地基可用，
// 也让移动视口的 E2E 有稳定的锚点（.m-shell / .m-bridge / .m-caps）。
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps({
  bridged: { type: Boolean, default: false },
  native: { type: Boolean, default: false },
  capabilities: { type: Object, required: true },
  isMobile: { type: Boolean, default: false },
  isDesktop: { type: Boolean, default: false },
  isBrowser: { type: Boolean, default: false },
});

const { t } = useI18n();

const platform = computed(() => {
  if (props.isMobile) return "mobile";
  if (props.isDesktop) return "desktop";
  return "browser";
});

// 只列与手机端决策相关的几项，其余能力的完整矩阵留给设置页
const KEYS = ["aiRequest", "cloudSync", "filePicker", "sqlite", "jdbc", "rawPrint", "icmpDiagnostics", "multiWindow"];
const rows = computed(() => KEYS.map((key) => ({ key, on: !!props.capabilities[key] })));
</script>

<template>
  <div class="m-shell" :data-platform="platform">
    <header class="m-head">
      <h1 class="m-title">{{ t("app.name") }}</h1>
      <span class="m-ver" :data-platform="platform">{{ platform }}</span>
    </header>

    <p class="m-hint">{{ t("mobile.shellIntro") }}</p>

    <!-- 两枚状态：原生桥是否接上、字典是否可读。E2E 就靠这两个锚点判断地基是否成立 -->
    <ul class="m-status">
      <li class="m-bridge" :data-on="bridged">{{ bridged ? t("mobile.bridgeOn") : t("mobile.bridgeOff") }}</li>
      <li class="m-native" :data-on="native">{{ native ? t("mobile.nativeOn") : t("mobile.nativeOff") }}</li>
      <li class="m-i18n">{{ t("mobile.i18nReady") }}</li>
    </ul>

    <section class="m-caps">
      <h2 class="m-caps-title">{{ t("mobile.capsTitle") }}</h2>
      <ul>
        <li v-for="row in rows" :key="row.key" class="m-cap" :class="{ off: !row.on }" :data-cap="row.key" :data-on="row.on">
          <span class="m-cap-name">{{ row.key }}</span>
          <span class="m-cap-val">{{ row.on ? t("mobile.capOn") : t("mobile.capOff") }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
