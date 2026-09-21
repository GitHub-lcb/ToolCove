<script setup>
import { ref, computed, onMounted, onBeforeUnmount, onErrorCaptured, watch } from "vue";
import { useI18n } from "vue-i18n";
import { WebviewWindow } from "./platform/window.js";
import { emitTo } from "./platform/events.js";
import Icon from "./Icon.vue";
import { relativeTime } from "./shared.js";
import { openToolWindow, isTauriEnv, formatLoadErrorDetail } from "./toolWindow.js";
import ToolErrorPanel from "./ToolErrorPanel.vue";
import { loadToolbox, saveToolbox, saveToolboxNow, flushToolbox } from "./toolboxStore.js";
import { createJsonHandoffQueue, JSON_HANDOFF_EVENT } from "./tools/jsonHandoff.js";
import { prepareJsonHandoff } from "./tools/jsonWorkspace.js";
import { groupToolboxTools, searchToolboxTools, toolKeywords, visibleToolboxTools } from "./toolboxTools.js";
import { isSemanticWorthy, suggestTools } from "./toolboxSemantic.js";
import { resolveTypeSafeTransport } from "./typesafe.js";
import { buildToolboxQuickList, normalizeExpandedGroups, toggleExpandedGroup } from "./toolboxViewState.js";
import { getToolComponent } from "./toolComponents.js";
import { track } from "./telemetry.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});

const isTauri = isTauriEnv();
const RECENT_MAX = 8;
const QUICK_MAX = 6;

const { t } = useI18n();

// 工具注册表：ready=true 可打开，false 为规划中占位卡（key/label/icon 与独立窗口共用）；
// 浏览器端过滤掉依赖原生能力的工具（见 toolboxTools.js 的 desktopOnly）
const TOOLS = visibleToolboxTools();
const ALL_GROUPS = groupToolboxTools(TOOLS);

// 首页检索：按注册表字段与关键词过滤，空关键词回落到完整列表
const query = ref("");
const hasSearch = computed(() => query.value.trim().length > 0);
const filteredTools = computed(() => {
  const keyword = query.value.trim();
  return keyword ? searchToolboxTools(keyword, TOOLS) : TOOLS;
});
const GROUPS = computed(() => groupToolboxTools(filteredTools.value));

// —— 自然语言找工具（TypeSafe 语义，可选增强）——
// 字面检索是子串包含：「把订单表另存成能直接用 Excel 打开的文件」与任何工具字段都没有共同子串，
// 于是它落在空结果页上。这里把那一步补上，而且**只在字面检索空手而归时**才问模型：
// 有字面命中还去发一次网络请求，慢的是用户、贵的是 token，准度却未必更高。
const SEMANTIC_DEBOUNCE_MS = 400;
const semanticHits = ref([]);
const semanticBusy = ref(false);
const semanticNote = ref("");
// 同一句话只问一次：中文输入法逐字上屏、用户来回改词都不该重复打端点
let semanticCache = new Map();
let semanticTimer = null;
let semanticToken = null;
let semanticTransport = null;

// 注册表存的是关键词字典键，语义请求要的是当前语言的词表（见 toolboxTools.toolKeywords）
const SEMANTIC_TOOLS = computed(() =>
  TOOLS.map((tool) => ({ ...tool, keywords: toolKeywords(tool).map((word) => String(word ?? "")) }))
);

async function runSemanticSearch(text) {
  if (semanticCache.has(text)) {
    semanticHits.value = semanticCache.get(text);
    semanticNote.value = "";
    return;
  }
  semanticBusy.value = true;
  const token = {};
  semanticToken = token;
  if (!semanticTransport) {
    // 未配置/显式关闭都是 null，据此安静地什么都不做（本功能没有字面兜底，字面检索已经跑过了）
    semanticTransport = await resolveTypeSafeTransport().catch(() => null);
  }
  const hits = await suggestTools(SEMANTIC_TOOLS.value, text, {
    transport: semanticTransport?.transport || null,
    ...(semanticTransport?.tuning || {}),
    limit: 3,
    translate: (key) => t(key),
    onResult: (info) => {
      // 不推荐时留一句原因：否则「配了没生效」和「压根没配」在界面上完全一样
      if (info.matcher === "none" && info.reason && info.reason !== "not-configured") semanticNote.value = info.reason;
    },
  });
  if (semanticToken !== token) return; // 期间用户又改了词，这次结果作废
  semanticBusy.value = false;
  if (semanticCache.size > 40) semanticCache = new Map();
  semanticCache.set(text, hits);
  semanticHits.value = hits;
}

// 不推荐时的那句原因：「没配」不必说（本来就没这个功能），但「配了却失败」必须看得见
const SEMANTIC_NOTE_KEY = {
  "transport-error": "toolbox.gallery.semanticNoteError",
  "low-confidence": "toolbox.gallery.semanticNoteUnsure",
};
const semanticNoteText = computed(() => {
  const key = SEMANTIC_NOTE_KEY[semanticNote.value];
  return key ? t(key) : "";
});

watch(query, (value) => {
  const text = String(value ?? "").trim();
  semanticHits.value = [];
  semanticNote.value = "";
  if (semanticTimer) clearTimeout(semanticTimer);
  if (!hasSearch.value || filteredTools.value.length || !isSemanticWorthy(text)) return;
  semanticTimer = setTimeout(() => runSemanticSearch(text), SEMANTIC_DEBOUNCE_MS);
});

const activeTool = ref(""); // "" = 画廊首页
const recent = ref([]); // [{ key, ts }]
const pinned = ref([]); // 收藏的工具 key，按收藏顺序保存
const expandedGroups = ref([]); // 允许同时展开多个大类

let mounted = false;
let disposed = false;
onMounted(async () => {
  const [savedRecent, savedPinned, savedExpanded] = await Promise.all([
    loadToolbox("recent", []),
    loadToolbox("pinned", []),
    loadToolbox("expanded-groups", []),
  ]);
  if (disposed) return;
  recent.value = Array.isArray(savedRecent) ? savedRecent.filter((r) => TOOLS.some((t) => t.key === r.key)) : [];
  pinned.value = Array.isArray(savedPinned) ? savedPinned.filter((key) => TOOLS.some((t) => t.key === key)) : [];
  // 首次进入（无历史）默认展开第一个大类，避免首页只剩分类头
  const restored = normalizeExpandedGroups(savedExpanded, ALL_GROUPS);
  expandedGroups.value = restored.length ? restored : ALL_GROUPS[0] ? [ALL_GROUPS[0].key] : [];
  mounted = true;
  tryJump();
});
onBeforeUnmount(() => {
  disposed = true;
  flushToolbox(); // 卸载前冲刷全部待写数据，避免视图切换丢失
});

const recentList = computed(() =>
  recent.value.map((r) => ({ ...r, tool: TOOLS.find((t) => t.key === r.key) })).filter((r) => r.tool)
);
// 常用工具：收藏 → 最近使用 → 注册表顺序补位，保证入口始终可用
const quickTools = computed(() => buildToolboxQuickList(TOOLS, pinned.value, recent.value, QUICK_MAX));
// 最近使用记录的第一位即上次打开的工具，画廊里给它一个视觉焦点
function isLastUsed(t) {
  return recent.value.length > 0 && recent.value[0].key === t.key;
}
const activeMeta = computed(() => TOOLS.find((t) => t.key === activeTool.value) || null);
// 详情区动态组件：组件映射见 toolComponents.js（与独立窗口共用）
const toolComp = computed(() => (activeMeta.value ? getToolComponent(activeMeta.value.key) : null));
// 仅 API 调试工具需要跨工具跳转钩子（其余组件未声明该 prop，不能透传避免落到根元素）
const toolProps = computed(() => (activeTool.value === "request" ? { "open-in-json": openInJson } : {}));

// 内嵌工具的失败出口：这里没有 <Suspense>，异步组件 import 失败或工具 setup/渲染抛错时
// 详情区会只剩一片空白（整窗空白那次的同款形态，只是换了个容器）。独立窗口走 ToolWindow 的同名兜底。
const toolError = ref(null);
onErrorCaptured((err, _instance, info) => {
  console.error(t("common.toolLoadFail"), { tool: activeTool.value, err, info });
  if (toolError.value) return false; // 首个错误为准
  const name = activeMeta.value ? t(activeMeta.value.labelKey) : activeTool.value;
  toolError.value = {
    reason: t("common.toolLoadFail"),
    hint: t("common.toolLoadFailHint", { tool: name }),
    detail: formatLoadErrorDetail(err, info),
  };
  return false; // 已自行展示，阻断继续上报
});
// 换工具或返回画廊时清掉上一次的报错，否则下次进来会一直显示旧错误
watch(activeTool, () => {
  toolError.value = null;
});

function recordRecent(tool) {
  const list = recent.value.filter((r) => r.key !== tool.key);
  list.unshift({ key: tool.key, ts: Date.now() });
  recent.value = list.slice(0, RECENT_MAX);
  saveRecent();
}

// 打开工具：Tauri 下开独立窗口（同工具单例，已开则聚焦）；浏览器或创建失败时降级为主窗口内嵌
async function openTool(tool) {
  if (!tool.ready) return props.showToast(t("toolbox.comingSoon", { name: t(tool.labelKey) }));
  recordRecent(tool);
  track("tool." + tool.key); // 可选遥测：工具打开计数
  if (isTauri) await openToolWindow(tool, { showToast: props.showToast, onFallback: () => { activeTool.value = tool.key; } });
  else activeTool.value = tool.key;
}
function tryJump() {
  if (!mounted || !props.jumpId?.id) return;
  const tool = TOOLS.find((item) => item.key === props.jumpId.id);
  if (tool) openTool(tool);
}
watch(() => props.jumpId, tryJump);
function backHome() {
  activeTool.value = "";
}
function clearRecent() {
  recent.value = [];
  saveRecent();
}
function saveRecent() {
  saveToolbox("recent", recent.value);
}
// 大类展开：允许同时展开多个；检索时统一展开，避免结果被折叠藏起来
function isGroupExpanded(key) {
  return hasSearch.value || expandedGroups.value.includes(key);
}
function toggleGroup(key) {
  expandedGroups.value = toggleExpandedGroup(expandedGroups.value, key);
  saveToolbox("expanded-groups", expandedGroups.value);
}
function isPinned(tool) {
  return pinned.value.includes(tool.key);
}
function togglePinned(tool, event) {
  event?.stopPropagation();
  pinned.value = isPinned(tool) ? pinned.value.filter((key) => key !== tool.key) : [tool.key, ...pinned.value];
  saveToolbox("pinned", pinned.value);
}

// 跨工具跳转：把文本写入 JSON 工具的草稿（合并保留其他设置）并切到 JSON 工具。
// 数据资产化后读写走后端；JsonTool 挂载读取时会先冲刷待写值，保证拿到本次写入。
async function openJsonHandoffState(value) {
  const jsonTool = TOOLS.find((tool) => tool.key === "json");
  if (!jsonTool) return;

  if (!isTauri) {
    if (activeTool.value === "json") {
      window.dispatchEvent(new CustomEvent(JSON_HANDOFF_EVENT, { detail: value }));
    } else {
      await openTool(jsonTool);
    }
    return;
  }

  const label = "tool-json";
  const existing = await WebviewWindow.getByLabel(label);
  if (!existing) {
    await openTool(jsonTool);
    return;
  }
  recordRecent(jsonTool);
  await emitTo({ kind: "WebviewWindow", label }, JSON_HANDOFF_EVENT, value);
  await existing.unminimize();
  await existing.setFocus();
}

const enqueueJsonHandoff = createJsonHandoffQueue({
  loadState: (onError) => loadToolbox("json", {}, { onError }),
  saveState: (value) => saveToolboxNow("json", value),
  prepareState: prepareJsonHandoff,
  idFactory: () => crypto.randomUUID(),
  onOpen: openJsonHandoffState,
  onError: (reason) => {
    const messages = {
      "load-failed": t("toolbox.handoff.loadFailed"),
      "save-failed": t("toolbox.handoff.saveFailed"),
      "open-failed": t("toolbox.handoff.openFailed"),
      limit: t("toolbox.handoff.limit"),
      "unsupported-version": t("toolbox.handoff.unsupportedVersion"),
      "recovery-required": t("toolbox.handoff.recoveryRequired"),
    };
    props.showToast(messages[reason] || t("toolbox.handoff.unknown"));
  },
});

function openInJson(text) {
  return enqueueJsonHandoff(text);
}
</script>

<template>
  <div class="toolbox">
    <!-- 工具详情：面包屑返回 + 工具工作区 -->
    <template v-if="activeMeta">
      <div class="crumbs">
        <button class="crumb-back" @click="backHome"><Icon name="chevrons-left" :size="14" />{{ t("nav.toolbox") }}</button>
        <span class="crumb-sep">/</span>
        <span class="crumb-ico"><Icon :name="activeMeta.icon" :size="16" /></span>
        <span class="crumb-cur">{{ t(activeMeta.labelKey) }}</span>
        <span class="crumb-desc">{{ t(activeMeta.descKey) }}</span>
      </div>
      <section class="detail-body">
        <!-- 加载/初始化失败时给出可见报错，而不是留一片空白 -->
        <ToolErrorPanel v-if="toolError" :reason="toolError.reason" :hint="toolError.hint" :detail="toolError.detail" />
        <component v-else :is="toolComp" :show-toast="showToast" v-bind="toolProps" />
      </section>
    </template>

    <!-- 画廊首页：检索 → 常用工具 → 分类列表 + 侧栏 -->
    <template v-else>
      <div class="home-toolbar">
        <div class="toolbox-search">
          <Icon name="search" :size="16" class="search-icon" />
          <input v-model="query" type="search" :aria-label="t('toolbox.gallery.searchAria')" :placeholder="t('toolbox.gallery.searchPlaceholder')" />
          <button v-if="hasSearch" class="search-clear" type="button" :title="t('toolbox.gallery.searchClear')" :aria-label="t('toolbox.gallery.searchClear')" @click="query = ''">
            <Icon name="x" :size="14" />
          </button>
        </div>
        <span v-if="hasSearch" class="search-summary">{{ t("toolbox.gallery.searchFound", { n: filteredTools.length }) }}</span>
      </div>

      <section v-if="!hasSearch" class="quick-section">
        <div class="quick-head">
          <div class="quick-title">
            <Icon name="star" :size="16" />
            <b>{{ t("toolbox.gallery.quickTitle") }}</b>
            <span>{{ t("toolbox.gallery.quickSubtitle") }}</span>
          </div>
          <span class="quick-count">{{ t("toolbox.gallery.quickCount", { n: quickTools.length }) }}</span>
        </div>
        <div class="quick-list">
          <button v-for="tool in quickTools" :key="tool.key" class="quick-item" :class="{ pinned: isPinned(tool) }" :title="t(tool.descKey)" @click="openTool(tool)">
            <span class="quick-tile"><Icon :name="tool.icon" :size="19" /></span>
            <span class="quick-info">
              <b>{{ t(tool.labelKey) }}</b>
              <small>{{ t(tool.descKey) }}</small>
            </span>
            <span v-if="isPinned(tool)" class="quick-pin" :title="t('toolbox.gallery.pinTip')"><Icon name="star" :size="13" /></span>
          </button>
        </div>
      </section>

      <div class="home">
        <div class="home-main">
          <div v-if="hasSearch && !filteredTools.length" class="search-empty">
            <template v-if="semanticHits.length">
              <b class="semantic-title">{{ t("toolbox.gallery.semanticTitle") }}</b>
              <div class="semantic-list">
                <button
                  v-for="hit in semanticHits"
                  :key="hit.tool.key"
                  class="quick-item semantic-item"
                  :title="t(hit.tool.descKey)"
                  @click="openTool(hit.tool)"
                >
                  <span class="quick-tile"><Icon :name="hit.tool.icon" :size="19" /></span>
                  <span class="quick-info">
                    <b>{{ t(hit.tool.labelKey) }}</b>
                    <small>{{ t(hit.tool.descKey) }}</small>
                  </span>
                  <!-- 概率原样给出：这是模型的把握，不是匹配度百分比，藏起来反而误导 -->
                  <span class="semantic-score">{{ hit.score.toFixed(2) }}</span>
                </button>
              </div>
              <span class="semantic-hint">{{ t("toolbox.gallery.semanticHint") }}</span>
            </template>
            <template v-else>
              <span class="empty-ico"><Icon name="search" :size="26" /></span>
              <b>{{ t("toolbox.gallery.searchEmptyTitle") }}</b>
              <span>{{ semanticBusy ? t("toolbox.gallery.semanticBusy") : t("toolbox.gallery.searchEmptyHint") }}</span>
              <span v-if="semanticNoteText" class="semantic-note">{{ semanticNoteText }}</span>
              <button class="btn-outline" type="button" @click="query = ''">{{ t("toolbox.gallery.searchClear") }}</button>
            </template>
          </div>
          <div v-else class="tool-groups">
            <section v-for="group in GROUPS" :key="group.key" class="tool-group">
              <button
                class="group-head"
                :class="{ open: isGroupExpanded(group.key) }"
                :aria-expanded="isGroupExpanded(group.key)"
                :aria-controls="'tool-group-' + group.key"
                :disabled="hasSearch"
                @click="toggleGroup(group.key)"
              >
                <span class="group-icon"><Icon :name="group.icon" :size="21" /></span>
                <span class="group-info">
                  <b class="group-name">{{ t(group.labelKey) }}</b>
                  <span class="group-desc" :title="t(group.descKey)">{{ t(group.descKey) }}</span>
                </span>
                <span class="group-count">{{ t("toolbox.gallery.count", { n: group.tools.length }) }}</span>
                <Icon name="chevron-right" :size="17" class="group-arrow" />
              </button>

              <Transition name="group-reveal">
                <div v-if="isGroupExpanded(group.key)" :id="'tool-group-' + group.key" class="tool-list">
                  <div v-for="tool in group.tools" :key="tool.key" class="tool-item-wrap">
                    <button class="tool-item" :class="{ coming: !tool.ready, last: isLastUsed(tool) }" @click="openTool(tool)">
                      <span class="tile"><Icon :name="tool.icon" :size="24" /></span>
                      <span class="info">
                        <span class="info-top">
                          <b class="name">{{ t(tool.labelKey) }}</b>
                          <span v-if="isLastUsed(tool)" class="last-tag" :title="t('toolbox.gallery.lastUsedTip')">{{ t("toolbox.gallery.lastUsed") }}</span>
                        </span>
                        <span class="desc" :title="t(tool.descKey)">{{ t(tool.descKey) }}</span>
                      </span>
                      <Icon v-if="tool.ready" name="chevron-right" :size="16" class="go" />
                      <span v-else class="go-txt">{{ t("toolbox.gallery.coming") }}</span>
                    </button>
                    <button
                      v-if="tool.ready"
                      class="tool-pin"
                      :class="{ pinned: isPinned(tool) }"
                      type="button"
                      :title="t(isPinned(tool) ? 'toolbox.gallery.unpin' : 'toolbox.gallery.pin')"
                      :aria-label="t(isPinned(tool) ? 'toolbox.gallery.unpinAria' : 'toolbox.gallery.pinAria', { name: t(tool.labelKey) })"
                      @click="togglePinned(tool, $event)"
                    >
                      <Icon name="star" :size="14" />
                    </button>
                  </div>
                </div>
              </Transition>
            </section>
          </div>
        </div>

        <aside class="home-side">
          <div class="side-card">
            <div class="side-head">
              <b>{{ t("toolbox.gallery.recent") }}</b>
              <button v-if="recentList.length" class="side-clear" @click="clearRecent">{{ t("toolbox.gallery.clear") }}</button>
            </div>
            <div v-if="recentList.length" class="recent-list">
              <button v-for="r in recentList" :key="r.key" class="recent-item" @click="openTool(r.tool)">
                <span class="ri-ico"><Icon :name="r.tool.icon" :size="16" /></span>
                <span class="ri-name" :title="t(r.tool.labelKey)">{{ t(r.tool.labelKey) }}</span>
                <span class="ri-time">{{ relativeTime(r.ts) }}</span>
              </button>
            </div>
            <p v-else class="side-empty">{{ t("toolbox.gallery.empty") }}</p>
          </div>

          <div class="side-card">
            <div class="side-head">
              <b>{{ t("toolbox.gallery.tip") }}</b>
            </div>
            <ul class="tip-list">
              <li>{{ t("toolbox.gallery.tip1") }}</li>
              <li>{{ t("toolbox.gallery.tip2") }}</li>
              <li><b>Ctrl</b> + <b>K</b> {{ t("toolbox.gallery.tip3") }}</li>
            </ul>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 页面留白对齐全局惯例：水平 28px（同 HomeView/TaskView 等内容区），与顶栏标题起点对齐 */
.toolbox { display: flex; flex-direction: column; min-width: 0; height: 100%; min-height: 0; gap: 10px; padding: 8px 28px 18px; }

/* 面包屑 */
.crumbs { flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
.crumb-back { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; font-size: var(--fs-md); border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.crumb-back:hover { color: var(--primary-hover); background: var(--primary-soft); }
.crumb-sep { color: var(--muted); font-size: var(--fs-sm); }
.crumb-ico { width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--r-xs); background: var(--primary-soft); color: var(--primary-hover); }
.crumb-cur { font-size: var(--fs-md); font-weight: 600; }
.crumb-desc { font-size: var(--fs-sm); color: var(--muted); }
.detail-body { flex: 1; min-width: 0; min-height: 0; }

/* 首页检索栏：与分类卡同宽上限，右侧提示命中数量 */
.home-toolbar { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
.toolbox-search { min-height: 40px; flex: 1; display: flex; align-items: center; gap: var(--sp-2); max-width: 640px; padding: 0 var(--sp-3); border: 1px solid transparent; border-radius: var(--r-sm); background: var(--well); color: var(--text-dim); transition: background 0.15s, border-color 0.15s, box-shadow 0.15s; }
.toolbox-search:focus-within { border-color: var(--primary); background: var(--card); box-shadow: 0 0 0 3px var(--primary-soft); }
.search-icon { flex-shrink: 0; color: var(--muted); }
.toolbox-search input { width: 100%; min-width: 0; padding: var(--sp-3) 0; border: 0; outline: 0; color: var(--text); background: transparent; font-size: var(--fs-base); }
.toolbox-search input::-webkit-search-cancel-button { display: none; }
.search-clear { width: 28px; height: 28px; flex-shrink: 0; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--r-sm); color: var(--muted); background: transparent; cursor: pointer; }
.search-clear:hover { color: var(--danger); background: var(--danger-soft); }
.search-summary { flex-shrink: 0; color: var(--muted); font-size: var(--fs-sm); }

/* 常用工具：收藏 + 最近使用的一行式快捷入口，宽窗口三列 */
.quick-section { flex-shrink: 0; min-width: 0; }
.quick-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-2); }
.quick-title { display: flex; align-items: center; gap: var(--sp-2); color: var(--text); }
.quick-title > svg { color: var(--amber); }
.quick-title b { font-size: var(--fs-base); }
.quick-title span { color: var(--muted); font-size: var(--fs-sm); }
.quick-count { color: var(--text-dim); font-family: var(--font-num); font-size: var(--fs-xs); }
.quick-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); }
.quick-item { min-width: 0; display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--card-border); border-radius: var(--r-md); color: var(--text); background: var(--card); cursor: pointer; text-align: left; transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s; }
.quick-item:hover { border-color: var(--border-blue); box-shadow: var(--shadow); transform: translateY(-1px); }
.quick-item.pinned { border-color: var(--amber-border); }
.quick-tile { width: 34px; height: 34px; flex-shrink: 0; display: grid; place-items: center; border-radius: var(--r-sm); color: var(--primary-hover); background: var(--primary-soft); }
.quick-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.quick-info b { overflow: hidden; font-size: var(--fs-md); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.quick-info small { overflow: hidden; color: var(--muted); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.quick-pin { flex-shrink: 0; display: grid; place-items: center; color: var(--amber); }

/* 首页两栏 */
.home { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: var(--sp-5); align-items: start; }
.home-main { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-5); }

/* 工具大类：可同时展开，分类头与工具列表分层，避免把卡片套进卡片 */
.tool-groups { display: flex; flex-direction: column; gap: var(--sp-3); }
.tool-group { min-width: 0; }
.group-head { display: flex; align-items: center; gap: var(--sp-4); width: 100%; padding: var(--sp-4); color: var(--text); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); cursor: pointer; text-align: left; transition: border-color 0.15s, background 0.15s, box-shadow 0.15s; }
.group-head:hover { border-color: var(--border-strong); box-shadow: var(--shadow); }
.group-head.open { border-color: var(--border-blue); background: color-mix(in srgb, var(--primary) 2.5%, var(--card)); }
.group-head:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
/* 检索时分类固定展开，分类头仅作分组标题，不可点击折叠 */
.group-head:disabled { cursor: default; }
.group-icon { width: 44px; height: 44px; flex-shrink: 0; display: grid; place-items: center; color: var(--primary-hover); background: var(--primary-soft); border-radius: var(--r-md); }
.group-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.group-name { font-size: var(--fs-lg); font-weight: 700; line-height: var(--lh-tight); }
.group-desc { min-width: 0; overflow: hidden; color: var(--muted); font-size: var(--fs-sm); line-height: var(--lh-tight); text-overflow: ellipsis; white-space: nowrap; }
.group-count { flex-shrink: 0; padding: var(--sp-1) var(--sp-3); color: var(--text-soft); background: var(--well); border-radius: var(--r-pill); font-family: var(--font-num); font-size: var(--fs-xs); white-space: nowrap; }
.group-arrow { flex-shrink: 0; color: var(--muted); transition: transform 0.15s, color 0.15s; }
.group-head.open .group-arrow { color: var(--primary); transform: rotate(90deg); }

/* 展开的工具列表：宽窗口两列，左侧引导线表达归属；工具本身仍是独立重复项 */
.tool-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); margin: var(--sp-3) 0 var(--sp-2) var(--sp-7); padding-left: var(--sp-5); border-left: 2px solid var(--border-blue); }
.group-reveal-enter-active, .group-reveal-leave-active { transition: opacity 0.15s, transform 0.15s; }
.group-reveal-enter-from, .group-reveal-leave-to { opacity: 0; transform: translateY(-4px); }

/* 工具列表：紧凑行卡（图标 + 信息 + 前进箭头），整行可点，右上角收藏。
   右侧留出「收藏钮 + 前进箭头」两段车道（2 × sp-7），文字与两者都不会互相压盖。 */
.tool-item-wrap { position: relative; min-width: 0; }
.tool-item { display: flex; align-items: center; gap: var(--sp-4); width: 100%; min-width: 0; padding: var(--sp-4) calc(var(--sp-7) * 2) var(--sp-4) var(--sp-4); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); color: var(--text); cursor: pointer; text-align: left; transition: transform 0.18s, border-color 0.18s, box-shadow 0.18s; }
.tool-item-wrap:hover .tool-item:not(.coming) { transform: translateY(-2px); border-color: var(--border-strong); box-shadow: var(--shadow); }
.tool-item.coming { cursor: default; }
/* tile：线性图标 + 主色柔和底（UI 2.0 单主色体系，不装饰着色），固定 52px 方形 */
.tile { width: 52px; height: 52px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary-hover); }
/* 上次使用过的工具：描边 + 极淡主色底，形成画廊视觉焦点 */
.tool-item.last { border-color: color-mix(in srgb, var(--primary) 30%, var(--card-border)); background: color-mix(in srgb, var(--primary) 2.5%, var(--card)); }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.info-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.name { min-width: 0; overflow: hidden; font-size: var(--fs-lg); font-weight: 600; line-height: var(--lh-tight); text-overflow: ellipsis; white-space: nowrap; }
.last-tag { flex-shrink: 0; padding: 0 7px; font-size: var(--fs-xs); font-weight: 600; line-height: 1.7; color: var(--primary-hover); background: var(--primary-soft); border-radius: var(--r-pill); }
.desc { font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-tight); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.go { flex-shrink: 0; color: var(--faint); transition: color 0.15s, transform 0.15s; }
.tool-item-wrap:hover .tool-item:not(.coming) .go { color: var(--primary); transform: translateX(2px); }
.go-txt { flex-shrink: 0; font-size: var(--fs-sm); color: var(--muted); }
/* 收藏钮：常态隐藏，悬停/键盘聚焦/已收藏时显示，避免干扰阅读。
   贴右上角但避开卡片圆角与行尾箭头（glyph 之间留出间距）。 */
.tool-pin { position: absolute; top: var(--sp-2); right: var(--sp-2); width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 1px solid transparent; border-radius: var(--r-sm); color: var(--muted); background: transparent; cursor: pointer; opacity: 0; transition: opacity 0.15s, color 0.15s, background 0.15s, border-color 0.15s; }
.tool-item-wrap:hover .tool-pin, .tool-pin:focus-visible, .tool-pin.pinned { opacity: 1; }
.tool-pin:hover { color: var(--amber); background: var(--amber-soft); border-color: var(--amber-border); }
.tool-pin.pinned { color: var(--amber); background: var(--amber-soft); border-color: var(--amber-border); }
/* 子组件根元素（Icon 的 svg）：收藏态用实心星，和未收藏的描边星拉开差异 */
.tool-pin.pinned :deep(.icon), .quick-pin :deep(.icon) { fill: currentColor; }

/* 搜索空态 */
.search-empty { min-height: 220px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); color: var(--muted); text-align: center; }
.search-empty .empty-ico { margin-bottom: var(--sp-2); }
.search-empty b { color: var(--text); font-size: var(--fs-lg); }
.search-empty .btn-outline { margin-top: var(--sp-2); }
/* 语义推荐：字面检索空手而归时的「按说法找到」。整块左对齐并撑满，
   否则继承自 .search-empty 的居中列会把可点的工具卡压成一串窄条。 */
.semantic-list { width: 100%; display: grid; gap: var(--sp-2); margin-top: var(--sp-3); }
.semantic-item { width: 100%; }
.semantic-item:hover { border-color: var(--accent); }
.semantic-score { margin-left: auto; font-size: var(--fs-xs); color: var(--muted); }
.semantic-hint { font-size: var(--fs-xs); }
.semantic-note { font-size: var(--fs-xs); color: var(--muted); }

/* 右侧栏 */
.home-side { display: flex; flex-direction: column; gap: 14px; }
.side-card { padding: 14px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); }
.side-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.side-head b { font-size: var(--fs-base); }
.side-clear { padding: 2px 8px; font-size: var(--fs-sm); border: none; background: transparent; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; }
.side-clear:hover { color: var(--danger); background: var(--danger-soft); }
.recent-list { display: flex; flex-direction: column; gap: 2px; }
.recent-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 8px; border: none; background: transparent; border-radius: var(--r-sm); cursor: pointer; text-align: left; transition: background 0.15s; }
.recent-item:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
.ri-ico { width: 26px; height: 26px; flex-shrink: 0; display: grid; place-items: center; border-radius: var(--r-xs); background: var(--primary-soft); color: var(--primary); }
.ri-name { flex: 1; min-width: 0; font-size: var(--fs-md); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri-time { flex-shrink: 0; font-size: var(--fs-sm); color: var(--muted); }
.side-empty { margin: 0; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }

/* 小贴士列表：圆点 + 弱化文字，静态内容平衡侧栏高度 */
.tip-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.tip-list li { position: relative; padding-left: 14px; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }
.tip-list li::before { content: ""; position: absolute; left: 0; top: 9px; width: 4px; height: 4px; border-radius: 50%; background: var(--primary); opacity: 0.55; }
.tip-list b { font-weight: 600; color: var(--text); }

/* 窄窗口：侧栏移到主列下方；两列工具卡与三列快捷入口逐级降列 */
@media (max-width: 1180px) {
  .quick-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .home { grid-template-columns: 1fr; }
  .tool-list { grid-template-columns: 1fr; }
}
@media (max-width: 620px) {
  .quick-list { grid-template-columns: 1fr; }
  .home-toolbar { align-items: stretch; flex-direction: column; }
  .toolbox-search { max-width: none; }
}
/* 矮窗口：快捷入口去掉副标题行，把高度让给下面的分类列表 */
@media (max-height: 640px) {
  .quick-info small { display: none; }
}
</style>
