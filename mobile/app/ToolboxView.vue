<script setup>
// 工具箱（手机端）：按分组列出全部工具，已迁移的直接进，未迁移的如实标注。
//
// 为什么不做「和桌面端一样的工具卡片墙」：桌面端有 1440px 宽 + 多窗口，能并排展示；
// 手机上把工具铺成卡片墙只会让人反复滚动。这里分组 + 可搜索折叠成一条，
// 「哪些还不能用的」由条目上的徽章就地说明（仅桌面端 / 待迁移）。
// 顶栏原来有一条「已迁移 x/y」进度：那是**迁移工程自己的指标**，迁完之后它常年显示
// 20/20，还和桌面端注册表的 23 个口径打架——对使用者没有任何信息量，所以撤掉。
import { computed, defineAsyncComponent, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../../src/ui/Icon.vue";
import { loadToolbox, saveToolbox } from "../../src/toolboxStore.js";
// 「常用工具」的排序规则**与桌面端同一份纯函数**（收藏 → 用得多 → 最近用过 → 注册表补位）。
// 抄一遍到手机端迟早会漂移（桌面改权重、手机不改），而这条规则正是"用起来顺手"的来源。
import { buildToolboxQuickList } from "../../src/toolboxViewState.js";
import { TOOL_GROUPS, TOOLS, toolsOfGroup, iconOfTool, iconOfGroup, progressOf } from "./toolbox.js";

const { t } = useI18n();

const openKey = ref(""); // 空串 = 在列表页
const current = computed(() => TOOLS.find((tool) => tool.key === openKey.value) || null);
const toolRef = ref(null); // 当前打开的工具体（内部还有子层级时由它决定返回键去哪）

// ---------- 常用工具（与桌面端同一套口径） ----------
// 存储键也用桌面端的：同一台设备上两个端各存各的库，但键名一致便于对照，
// 将来若做"手机端偏好迁到桌面"的导入也少一层翻译。
const QUICK_MAX = 6;
const RECENT_MAX = 8;
const recent = ref([]); // [{ key, ts }]
const pinned = ref([]); // 收藏的工具 key，按收藏顺序
const usage = ref({}); // { key: { count, ts } } —— 使用次数，才是"常用"的依据

onMounted(async () => {
  const [savedRecent, savedPinned, savedUsage] = await Promise.all([
    loadToolbox("recent", []),
    loadToolbox("pinned", []),
    loadToolbox("toolUsage", {}),
  ]);
  // 目录里已经没有的工具（停用/改名）不进列表：否则会渲染出点不动的条目
  recent.value = Array.isArray(savedRecent) ? savedRecent.filter((row) => TOOLS.some((tool) => tool.key === row?.key)) : [];
  pinned.value = Array.isArray(savedPinned) ? savedPinned.filter((key) => TOOLS.some((tool) => tool.key === key)) : [];
  usage.value = savedUsage && typeof savedUsage === "object" ? savedUsage : {};
});

const quickTools = computed(() => buildToolboxQuickList(TOOLS, pinned.value, recent.value, QUICK_MAX, usage.value));

/** 用过就记一笔：最近使用（只留 8 条）+ 使用次数（"用得多但久没开"的工具靠它才进得了常用）。 */
function recordUse(tool) {
  const list = recent.value.filter((row) => row.key !== tool.key);
  list.unshift({ key: tool.key, ts: Date.now() });
  recent.value = list.slice(0, RECENT_MAX);
  saveToolbox("recent", recent.value);
  const stat = usage.value[tool.key] || {};
  usage.value = { ...usage.value, [tool.key]: { count: (Number(stat.count) || 0) + 1, ts: Date.now() } };
  saveToolbox("toolUsage", usage.value);
}

function isPinned(tool) {
  return pinned.value.includes(tool.key);
}

function togglePin(tool) {
  pinned.value = isPinned(tool) ? pinned.value.filter((key) => key !== tool.key) : [tool.key, ...pinned.value];
  saveToolbox("pinned", pinned.value);
}

/**
 * 启动台数字：与桌面端启动台（ToolboxView.vue）同一套口径。
 *
 * 桌面独占的工具**不进分母**——它们是"迁不了"而不是"还没迁"，
 * 算进去进度条会永远停在八成，让人误以为还差一把。详见 toolbox.js 的 progressOf。
 */
const progress = computed(() => progressOf());
const readyCount = computed(() => TOOLS.filter((tool) => tool.ready).length);

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
  kb: defineAsyncComponent(() => import("./tools/KbToolView.vue")),
  xml: defineAsyncComponent(() => import("./tools/XmlToolView.vue")),
  schema: defineAsyncComponent(() => import("./tools/SchemaToolView.vue")),
  time: defineAsyncComponent(() => import("./tools/TimeToolView.vue")),
  crypto: defineAsyncComponent(() => import("./tools/CryptoToolView.vue")),
  generator: defineAsyncComponent(() => import("./tools/GeneratorToolView.vue")),
  diff: defineAsyncComponent(() => import("./tools/DiffToolView.vue")),
  request: defineAsyncComponent(() => import("./tools/RequestToolView.vue")),
  rail: defineAsyncComponent(() => import("./tools/RailToolView.vue")),
  interview: defineAsyncComponent(() => import("./tools/InterviewToolView.vue")),
  image: defineAsyncComponent(() => import("./tools/ImageToolView.vue")),
  photo: defineAsyncComponent(() => import("./tools/PhotoToolView.vue")),
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
  // 打开即计数：用得多/最近用过的工具因此会自己浮到「常用」区，不需要用户手工整理
  recordUse(tool);
}

/**
 * 返回工具列表。**必须暴露给 Shell**：安卓系统返回键要能关掉工具页，
 * 否则在工具里按返回会直接退出应用（用户最容易骂人的行为）。
 *
 * 先问工具自己愿不愿意吃掉这次返回（与 Shell → 本视图、WorkView → DomainPanel 同一条下沉链）：
 * 工具内部有子层级时（知识库的编辑态），返回该先回它的列表，而不是直接把工具关掉——
 * 那会连带丢掉用户没保存的输入。
 */
function goBack() {
  if (!openKey.value) return false;
  if (toolRef.value?.goBack?.() === true) return true;
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
      <component :is="VIEWS[current.key]" ref="toolRef" />
    </template>

    <!-- 列表页 -->
    <template v-else>
      <div class="m-tools">
        <h2 class="m-h2">{{ t("nav.toolbox") }}</h2>
      </div>

      <!-- 启动台：与桌面端同一套数字与图标（口径见 toolbox.js 的 iconOfTool / progressOf）。
           手机上不放整面卡片墙（1440px 的桌面那样做只会让人一直滑），
           但仍要在第一屏说清「这里有多少件能用」——那是本产品与通用 Agent 的差别所在。 -->
      <section class="m-launchpad">
        <div class="m-lp-stats">
          <span class="m-lp-stat"><b>{{ readyCount }}</b><i>{{ t("toolbox.launchpad.statTools") }}</i></span>
          <span class="m-lp-stat"><b>{{ progress.total }}</b><i>{{ t("mobile.toolboxMigratable") }}</i></span>
        </div>
        <div class="m-lp-bar" role="img" :aria-label="t('mobile.toolboxProgress', { ready: progress.ready, total: progress.total })">
          <span :style="{ width: progress.pct + '%' }"></span>
        </div>
      </section>

      <!-- 常用工具：与桌面端同一套排序（收藏 → 用得多 → 最近用过 → 注册表补位）。
           手机上把它放在第一屏，是因为滑分组找工具正是手机端最烦的一步。 -->
      <section v-if="quickTools.length" class="m-quick" data-role="quick">
        <div class="m-quick-head">
          <b>{{ t("toolbox.gallery.quickTitle") }}</b>
          <span class="m-quick-sub">{{ t("toolbox.gallery.quickSubtitle") }}</span>
        </div>
        <div class="m-quick-row">
          <button
            v-for="tool in quickTools"
            :key="tool.key"
            class="m-quick-item"
            :class="{ pinned: isPinned(tool) }"
            :data-quick="tool.key"
            @click="open(tool)"
          >
            <Icon :name="iconOfTool(tool)" :size="15" />
            <span>{{ t(tool.labelKey) }}</span>
          </button>
        </div>
      </section>

      <section v-for="group in TOOL_GROUPS" :key="group.key" class="m-group">
        <h3 class="m-group-title">
          <Icon :name="iconOfGroup(group)" :size="16" />
          {{ t(group.labelKey) }}
        </h3>
        <ul class="m-list">
          <li v-for="tool in toolsOfGroup(group.key)" :key="tool.key" class="m-item" :data-tool="tool.key" :data-ready="tool.ready">
            <button class="m-item-main" :disabled="!tool.ready" @click="open(tool)">
              <span class="m-item-ico" aria-hidden="true"><Icon :name="iconOfTool(tool)" :size="19" /></span>
              <span class="m-item-text">
                <span class="m-item-title">
                  {{ t(tool.labelKey) }}
                  <!-- 桌面独占要说清是「不迁」而不是「还没迁」：不然用户会一直等 -->
                  <span v-if="tool.desktopOnly" class="m-badge">{{ t("mobile.toolDesktopOnly") }}</span>
                  <span v-else-if="!tool.ready" class="m-badge">{{ t("mobile.toolTodo") }}</span>
                </span>
                <span v-if="tool.note" class="m-item-sub">{{ t(tool.note) }}</span>
              </span>
            </button>
            <!-- 收藏：收藏的工具固定排在常用区最前（与桌面端一致） -->
            <button
              class="m-item-pin"
              :class="{ on: isPinned(tool) }"
              :title="t('toolbox.gallery.pinTip')"
              :data-role="`pin-${tool.key}`"
              @click.stop="togglePin(tool)"
            >
              <Icon name="star" :size="16" />
            </button>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>
