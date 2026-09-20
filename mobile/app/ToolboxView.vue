<script setup>
// 工具箱（手机端）：按分组列出全部工具，已迁移的直接进，未迁移的如实标注。
//
// 为什么不做「和桌面端一样的工具卡片墙」：桌面端有 1440px 宽 + 多窗口，能并排展示；
// 手机上把 13 个工具铺成卡片墙只会让人反复滚动。这里分组 + 可搜索折叠成一条，
// 并且**显示迁移进度**——让用户知道哪些能用、哪些还在路上，而不是点了没反应。
import { computed, defineAsyncComponent, ref } from "vue";
import { useI18n } from "vue-i18n";
import { TOOL_GROUPS, TOOLS, progressOf, toolsOfGroup } from "./toolbox.js";

const { t } = useI18n();

const openKey = ref(""); // 空串 = 在列表页
const current = computed(() => TOOLS.find((tool) => tool.key === openKey.value) || null);
const progress = computed(() => progressOf());

/**
 * 工具视图表：**按需加载**（defineAsyncComponent）。
 *
 * 为什么必须懒加载：时间工具带 Luxon（约 200KB）、JSON 工具带 json.js，
 * 静态 import 会让它们全进首屏包——实测主包从 276KB 涨到 477KB。
 * 工具是「打开才用」的东西，一键之遥的加载完全可接受。
 */
const VIEWS = {
  json: defineAsyncComponent(() => import("./tools/JsonToolView.vue")),
  convert: defineAsyncComponent(() => import("./tools/ConvertToolView.vue")),
  table: defineAsyncComponent(() => import("./tools/TableToolView.vue")),
  markdown: defineAsyncComponent(() => import("./tools/MarkdownToolView.vue")),
  xml: defineAsyncComponent(() => import("./tools/XmlToolView.vue")),
  time: defineAsyncComponent(() => import("./tools/TimeToolView.vue")),
  crypto: defineAsyncComponent(() => import("./tools/CryptoToolView.vue")),
  generator: defineAsyncComponent(() => import("./tools/GeneratorToolView.vue")),
  diff: defineAsyncComponent(() => import("./tools/DiffToolView.vue")),
  request: defineAsyncComponent(() => import("./tools/RequestToolView.vue")),
  rail: defineAsyncComponent(() => import("./tools/RailToolView.vue")),
  image: defineAsyncComponent(() => import("./tools/ImageToolView.vue")),
  pdf: defineAsyncComponent(() => import("./tools/PdfToolView.vue")),
  network: defineAsyncComponent(() => import("./tools/NetworkToolView.vue")),
  file: defineAsyncComponent(() => import("./tools/FileToolView.vue")),
  db: defineAsyncComponent(() => import("./tools/DbToolView.vue")),
  label: defineAsyncComponent(() => import("./tools/LabelToolView.vue")),
  chat: defineAsyncComponent(() => import("./tools/ChatToolView.vue")),
};

function open(tool) {
  if (!tool.ready || !VIEWS[tool.key]) return;
  openKey.value = tool.key;
}

/**
 * 返回工具列表。**必须暴露给 Shell**：安卓系统返回键要能关掉工具页，
 * 否则在工具里按返回会直接退出应用（用户最容易骂人的行为）。
 */
function goBack() {
  if (!openKey.value) return false;
  openKey.value = "";
  return true;
}

defineExpose({ goBack });

function close() {
  openKey.value = "";
}
</script>

<template>
  <section class="m-toolbox" :data-view="openKey || 'list'">
    <!-- 工具页：顶部一条返回 + 标题，内容交给具体工具 -->
    <template v-if="current">
      <div class="m-tools">
        <button class="m-back" @click="close">‹</button>
        <h2 class="m-h2">{{ t(current.labelKey) }}</h2>
      </div>
      <component :is="VIEWS[current.key]" />
    </template>

    <!-- 列表页 -->
    <template v-else>
      <div class="m-tools">
        <h2 class="m-h2">{{ t("nav.toolbox") }}</h2>
        <span class="m-progress" data-role="tool-progress">
          {{ t("mobile.toolProgress", { ready: progress.ready, total: progress.total }) }}
        </span>
      </div>
      <span class="m-bar" :aria-label="t('mobile.toolProgressLabel')"><i :style="{ width: progress.pct + '%' }"></i></span>

      <section v-for="group in TOOL_GROUPS" :key="group.key" class="m-group">
        <h3 class="m-group-title">{{ t(group.labelKey) }}</h3>
        <ul class="m-list">
          <li v-for="tool in toolsOfGroup(group.key)" :key="tool.key" class="m-item" :data-tool="tool.key" :data-ready="tool.ready">
            <button class="m-item-main" :disabled="!tool.ready" @click="open(tool)">
              <span class="m-item-title">
                {{ t(tool.labelKey) }}
                <span v-if="!tool.ready" class="m-badge">{{ t("mobile.toolTodo") }}</span>
              </span>
              <span v-if="tool.note" class="m-item-sub">{{ t(tool.note) }}</span>
            </button>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>
