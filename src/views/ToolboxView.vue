<script setup>
import { ref, computed, onMounted, onBeforeUnmount, onErrorCaptured, watch } from "vue";
import { useI18n } from "vue-i18n";
import { WebviewWindow } from "../platform/window.js";
import { emitTo } from "../platform/events.js";
import Icon from "../ui/Icon.vue";
import { relativeTime } from "../shared/dates.js";
import { openToolWindow, isTauriEnv, formatLoadErrorDetail } from "../app/toolWindow.js";
import ToolErrorPanel from "../ui/ToolErrorPanel.vue";
import { loadToolbox, saveToolbox, saveToolboxNow, flushToolbox } from "../toolboxStore.js";
import { createJsonHandoffQueue, JSON_HANDOFF_EVENT } from "../tools/jsonHandoff.js";
import { prepareJsonHandoff } from "../tools/jsonWorkspace.js";
import { groupToolboxTools, searchToolboxTools, toolKeywords, visibleToolboxTools } from "../toolboxTools.js";
import { AGENT_TOOL_CATALOG } from "../agent/catalog.js";
import { riskChip, riskKey } from "../agent/capabilities.js";
import { isSemanticWorthy, suggestTools } from "../toolboxSemantic.js";
import { resolveTypeSafeTransport } from "../typesafe.js";
import { getToolComponent } from "../toolComponents.js";
import { track } from "../app/telemetry.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});

const isTauri = isTauriEnv();
const RECENT_MAX = 8;

const { t } = useI18n();

// 工具注册表：ready=true 可打开，false 为规划中占位卡（key/label/icon 与独立窗口共用）；
// 浏览器端过滤掉依赖原生能力的工具（见 toolboxTools.js 的 desktopOnly）
const TOOLS = visibleToolboxTools();

// 首页检索：按注册表字段与关键词过滤，空关键词回落到完整列表
const query = ref("");
const hasSearch = computed(() => query.value.trim().length > 0);
const filteredTools = computed(() => {
  const keyword = query.value.trim();
  return keyword ? searchToolboxTools(keyword, TOOLS) : TOOLS;
});
// 目录只有一个（万物皆本地工具）：搜索之上再叠一层「全部 / Agent 可调 / 最近」的视图筛选。
// 「Agent 可调」不是另一份清单，而是同一批工具里被 Agent 动作引用到的那些——两处永远一致。
const filter = ref("all");
const FILTERS = [
  { key: "all", labelKey: "toolbox.gallery.filterAll" },
  { key: "agent", labelKey: "toolbox.gallery.filterAgent" },
  { key: "recent", labelKey: "toolbox.gallery.filterRecent" },
];
const agentToolKeys = computed(() => new Set(AGENT_TOOL_CATALOG.map((action) => action.toolKey)));
const modeTools = computed(() => {
  if (filter.value === "agent") return filteredTools.value.filter((tool) => agentToolKeys.value.has(tool.key));
  if (filter.value === "recent") {
    const order = new Map(recent.value.map((item, index) => [item.key, index]));
    return filteredTools.value.filter((tool) => order.has(tool.key)).sort((a, b) => order.get(a.key) - order.get(b.key));
  }
  return filteredTools.value;
});
const GROUPS = computed(() => groupToolboxTools(modeTools.value));
// 动作也吃同一个搜索词：搜「json」时却把 41 条动作全列出来，等于告诉用户"你的检索没生效"。
const filteredActions = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return AGENT_TOOL_CATALOG;
  return AGENT_TOOL_CATALOG.filter((action) => {
    const text = t(action.descriptionKey) || action.description || "";
    return action.name.toLowerCase().includes(keyword) || String(text).toLowerCase().includes(keyword);
  });
});

// 启动台上的三个数字：都可打开的工具数 / Agent 动作数 / 其中能被 Agent 调用的工具数。
// 刻意与 Agent 侧共用同一份目录（agent/catalog.js），于是"工具箱有多少、Agent 能驱动多少"
// 这两个数永远一致——它们本来就是同一件事的两面，各自维护一份必然会漂。
const agentActionCount = computed(() => AGENT_TOOL_CATALOG.length);
const agentToolCount = computed(() => {
  const keys = new Set(AGENT_TOOL_CATALOG.map((t) => t.toolKey));
  return TOOLS.filter((tool) => keys.has(tool.key)).length;
});

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
const usage = ref({}); // { key: { count, ts } } 使用次数（最近使用之外的第二档排序依据）

let mounted = false;
let disposed = false;
onMounted(async () => {
  const [savedRecent, savedPinned, savedUsage] = await Promise.all([
    loadToolbox("recent", []),
    loadToolbox("pinned", []),
    loadToolbox("toolUsage", {}),
  ]);
  if (disposed) return;
  recent.value = Array.isArray(savedRecent) ? savedRecent.filter((r) => TOOLS.some((t) => t.key === r.key)) : [];
  pinned.value = Array.isArray(savedPinned) ? savedPinned.filter((key) => TOOLS.some((t) => t.key === key)) : [];
  usage.value = savedUsage && typeof savedUsage === "object" ? savedUsage : {};
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
  // 使用次数单独记（recent 只留 8 条，用它数次数会把"用得多但久没开"的工具漏掉）
  const stat = usage.value[tool.key] || {};
  usage.value = { ...usage.value, [tool.key]: { count: (Number(stat.count) || 0) + 1, ts: Date.now() } };
  saveToolbox("toolUsage", usage.value);
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

    <!-- 本地工具目录：Agent 的动作空间与人的手动入口是同一批能力，所以只有一份清单 -->
    <template v-else>
      <header class="lt-head">
        <div class="lt-copy">
          <h1>{{ t("nav.localTools") }}</h1>
          <p>{{ t("nav.localToolsHint") }}</p>
        </div>
        <div class="lt-stats">
          <span class="lt-stat"><b>{{ TOOLS.length }}</b>{{ t("toolbox.launchpad.statTools") }}</span>
          <span class="lt-stat"><b>{{ agentActionCount }}</b>{{ t("toolbox.launchpad.statActions") }}</span>
          <span class="lt-stat"><b>{{ agentToolCount }}</b>{{ t("toolbox.launchpad.statDriven") }}</span>
        </div>
      </header>

      <div class="lt-toolbar">
        <div class="lt-search">
          <Icon name="search" :size="15" class="search-icon" />
          <input v-model="query" type="search" :aria-label="t('toolbox.gallery.searchAria')" :placeholder="t('toolbox.gallery.searchPlaceholder')" />
          <button v-if="hasSearch" class="search-clear" type="button" :title="t('toolbox.gallery.searchClear')" :aria-label="t('toolbox.gallery.searchClear')" @click="query = ''">
            <Icon name="x" :size="13" />
          </button>
        </div>
        <div class="lt-filters" role="tablist" :aria-label="t('nav.localTools')">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            class="lt-filter"
            :class="{ on: filter === f.key }"
            role="tab"
            :aria-selected="filter === f.key"
            @click="filter = f.key"
          >
            {{ t(f.labelKey) }}
          </button>
        </div>
        <span v-if="hasSearch" class="lt-found">{{ t("toolbox.gallery.searchFound", { n: filteredTools.length }) }}</span>
      </div>

      <div class="lt-body">
        <div class="lt-list">
          <div v-if="!hasSearch && !GROUPS.length" class="lt-empty-block">
            <span class="empty-ico"><Icon name="clock" :size="20" /></span>
            <b>{{ t("toolbox.gallery.empty") }}</b>
          </div>

          <div v-if="hasSearch && !filteredTools.length" class="lt-empty-block">
            <template v-if="semanticHits.length">
              <b class="semantic-title">{{ t("toolbox.gallery.semanticTitle") }}</b>
              <div class="semantic-list">
                <button
                  v-for="hit in semanticHits"
                  :key="hit.tool.key"
                  class="lt-row semantic-item"
                  :title="t(hit.tool.descKey)"
                  @click="openTool(hit.tool)"
                >
                  <span class="lt-ico"><Icon :name="hit.tool.icon" :size="16" /></span>
                  <span class="lt-main">
                    <span class="lt-name">{{ t(hit.tool.labelKey) }}</span>
                    <span class="lt-desc">{{ t(hit.tool.descKey) }}</span>
                  </span>
                  <span class="semantic-score">{{ hit.score.toFixed(2) }}</span>
                </button>
              </div>
              <span class="semantic-hint">{{ t("toolbox.gallery.semanticHint") }}</span>
            </template>
            <template v-else>
              <span class="empty-ico"><Icon name="search" :size="22" /></span>
              <b>{{ t("toolbox.gallery.searchEmptyTitle") }}</b>
              <span>{{ semanticBusy ? t("toolbox.gallery.semanticBusy") : t("toolbox.gallery.searchEmptyHint") }}</span>
              <span v-if="semanticNoteText" class="semantic-note">{{ semanticNoteText }}</span>
              <button class="btn-outline sm" type="button" @click="query = ''">{{ t("toolbox.gallery.searchClear") }}</button>
            </template>
          </div>

          <section v-for="group in GROUPS" :key="group.key" class="lt-group">
            <p class="lt-group-title">
              <Icon :name="group.icon" :size="13" />
              {{ t(group.labelKey) }}
              <span class="lt-group-count">{{ group.tools.length }}</span>
            </p>
            <div v-for="tool in group.tools" :key="tool.key" class="lt-row-wrap">
              <button class="lt-row lt-tool" :class="{ coming: !tool.ready }" @click="openTool(tool)">
                <span class="lt-ico"><Icon :name="tool.icon" :size="16" /></span>
                <span class="lt-main">
                  <span class="lt-name">{{ t(tool.labelKey) }}</span>
                  <span class="lt-desc" :title="t(tool.descKey)">{{ t(tool.descKey) }}</span>
                </span>
                <span v-if="agentToolKeys.has(tool.key)" class="lt-badge">{{ t("toolbox.gallery.agentable") }}</span>
                <span v-if="!tool.ready" class="lt-coming">{{ t("toolbox.gallery.coming") }}</span>
                <Icon v-else name="chevron-right" :size="14" class="lt-go" />
              </button>
              <button
                v-if="tool.ready"
                class="lt-pin"
                :class="{ pinned: isPinned(tool) }"
                type="button"
                :title="t(isPinned(tool) ? 'toolbox.gallery.unpin' : 'toolbox.gallery.pin')"
                :aria-label="t(isPinned(tool) ? 'toolbox.gallery.unpinAria' : 'toolbox.gallery.pinAria', { name: t(tool.labelKey) })"
                @click="togglePinned(tool, $event)"
              >
                <Icon name="star" :size="13" />
              </button>
            </div>
          </section>

          <!-- Agent 动作：同一批能力的另一面。列在这里是为了让「万物皆本地工具」可核对——
               每个动作都指向上面某个工具的 key（toolKey），不是另一套黑箱。 -->
          <section v-if="filter !== 'recent' && filteredActions.length" class="lt-group lt-actions">
            <p class="lt-group-title">
              <Icon name="zap" :size="13" />
              {{ t("toolbox.gallery.actionsTitle") }}
              <span class="lt-group-count">{{ filteredActions.length }}</span>
              <span class="lt-group-hint">{{ t("toolbox.gallery.actionsHint") }}</span>
            </p>
            <div v-for="action in filteredActions" :key="action.name" class="lt-row lt-action">
              <code class="lt-action-name">{{ action.name }}</code>
              <span class="lt-main">
                <span class="lt-desc" :title="action.description">{{ t(action.descriptionKey) }}</span>
              </span>
              <span class="tc-chip sm" :class="riskChip(action.risk)">{{ t(riskKey(action.risk)) }}</span>
            </div>
          </section>
        </div>

        <aside class="lt-side">
          <div class="lt-card">
            <div class="lt-card-head">
              <b>{{ t("toolbox.gallery.recent") }}</b>
              <button v-if="recentList.length" class="lt-card-act" @click="clearRecent">{{ t("toolbox.gallery.clear") }}</button>
            </div>
            <div v-if="recentList.length" class="lt-recent">
              <button v-for="r in recentList" :key="r.key" class="lt-recent-row" @click="openTool(r.tool)">
                <span class="lt-ico sm"><Icon :name="r.tool.icon" :size="14" /></span>
                <span class="lt-recent-name" :title="t(r.tool.labelKey)">{{ t(r.tool.labelKey) }}</span>
                <span class="lt-recent-time">{{ relativeTime(r.ts) }}</span>
              </button>
            </div>
            <p v-else class="lt-empty-text">{{ t("toolbox.gallery.empty") }}</p>
          </div>

          <div class="lt-card">
            <div class="lt-card-head"><b>{{ t("toolbox.gallery.tip") }}</b></div>
            <ul class="lt-tips">
              <li>{{ t("toolbox.gallery.tip1") }}</li>
              <li>{{ t("toolbox.gallery.tip2") }}</li>
              <li>{{ t("toolbox.gallery.tip3") }}</li>
            </ul>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 页面留白对齐全局惯例：水平 28px，与顶栏标题起点对齐 */
.toolbox { display: flex; flex-direction: column; min-width: 0; height: 100%; min-height: 0; gap: var(--sp-3); padding: var(--sp-4) 28px 0; overflow: hidden; }

/* 面包屑（工具详情） */
.crumbs { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-2); }
.crumb-back { display: inline-flex; align-items: center; gap: 4px; padding: 5px var(--sp-3); font-size: var(--fs-md); border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.crumb-back:hover { color: var(--primary-hover); background: var(--primary-soft); }
.crumb-sep { color: var(--muted); font-size: var(--fs-sm); }
.crumb-ico { width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--r-xs); background: var(--primary-soft); color: var(--primary-hover); }
.crumb-cur { font-size: var(--fs-md); font-weight: 600; }
.crumb-desc { font-size: var(--fs-sm); color: var(--muted); }
.detail-body { flex: 1; min-width: 0; min-height: 0; overflow: auto; }

/* ---------- 目录头：标题 + 三个数字 ---------- */
.lt-head { flex-shrink: 0; display: flex; align-items: flex-end; justify-content: space-between; gap: var(--sp-5); flex-wrap: wrap; padding-bottom: var(--sp-1); }
.lt-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.lt-copy h1 { margin: 0; font-size: var(--fs-xl); font-weight: 650; letter-spacing: -0.3px; color: var(--text); }
.lt-copy p { margin: 0; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }
.lt-stats { display: flex; align-items: center; gap: var(--sp-4); flex-shrink: 0; }
.lt-stat { display: inline-flex; align-items: baseline; gap: 5px; font-size: var(--fs-xs); color: var(--muted); }
.lt-stat b { font-family: var(--font-num); font-size: var(--fs-lg); font-weight: 700; color: var(--text); }

/* ---------- 工具栏：搜索 + 视图筛选 ---------- */
.lt-toolbar { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
.lt-search { flex: 1; max-width: 460px; min-height: 34px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--card); color: var(--text-dim); transition: border-color 0.15s, box-shadow 0.15s; }
.lt-search:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.search-icon { flex-shrink: 0; color: var(--muted); }
.lt-search input { width: 100%; min-width: 0; padding: var(--sp-2) 0; border: 0; outline: 0; color: var(--text); background: transparent; font-size: var(--fs-md); }
.lt-search input::-webkit-search-cancel-button { display: none; }
.search-clear { width: 24px; height: 24px; flex-shrink: 0; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--r-xs); color: var(--muted); background: transparent; cursor: pointer; }
.search-clear:hover { color: var(--danger); background: var(--danger-soft); }
.lt-filters { display: flex; align-items: center; gap: 2px; flex-shrink: 0; padding: 2px; background: var(--well); border-radius: var(--r-sm); }
.lt-filter { height: 28px; padding: 0 var(--sp-3); border: 0; border-radius: var(--r-xs); background: transparent; color: var(--text-weak); font-size: var(--fs-sm); font-weight: 500; cursor: pointer; transition: background 0.15s, color 0.15s; }
.lt-filter:hover { color: var(--text); }
.lt-filter.on { background: var(--card); color: var(--text); box-shadow: 0 1px 2px rgba(31, 35, 40, 0.08); }
.lt-filter:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.lt-found { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); }

/* ---------- 主体：目录 + 右栏 ---------- */
.lt-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 244px; gap: var(--sp-5); padding-top: var(--sp-1); }
.lt-list { min-width: 0; min-height: 0; overflow-y: auto; padding-bottom: var(--sp-7); display: flex; flex-direction: column; gap: var(--sp-5); scrollbar-width: thin; }

.lt-group { display: flex; flex-direction: column; gap: 1px; }
.lt-group-title { display: flex; align-items: center; gap: 6px; margin: 0 0 var(--sp-2); padding: 0 2px; font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.4px; color: var(--faint); }
.lt-group-title .icon { color: var(--faint); }
.lt-group-count { margin-left: 2px; padding: 1px 6px; border-radius: var(--r-pill); background: var(--well); color: var(--text-soft); font-family: var(--font-num); font-size: 10.5px; }
.lt-group-hint { margin-left: var(--sp-2); font-weight: 400; letter-spacing: 0; color: var(--faint); }

/* 目录行：扁平列表，悬停才出现底色——与 DSH 的插件清单同一种密度，
   一屏能看到 10 件以上工具，而不是四张浮起的大卡。 */
.lt-row-wrap { display: flex; align-items: center; gap: 2px; }
.lt-row {
  flex: 1; min-width: 0;
  display: grid; grid-template-columns: 28px 132px minmax(0, 1fr) auto 16px; align-items: center; gap: var(--sp-3);
  min-height: 42px; padding: 5px var(--sp-3);
  border: 1px solid transparent; border-radius: var(--r-sm);
  background: none; color: var(--text); text-align: left; cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.lt-row:hover { background: var(--card); border-color: var(--card-border); }
.lt-row:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.lt-row.coming { opacity: 0.55; cursor: default; }
.lt-ico { flex-shrink: 0; width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--r-sm); background: var(--primary-soft); color: var(--primary-hover); }
.lt-ico.sm { width: 22px; height: 22px; border-radius: var(--r-xs); }
.lt-main { display: contents; }
.lt-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-md); font-weight: 500; color: var(--text); }
.lt-desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); color: var(--muted); }
.lt-badge { flex-shrink: 0; padding: 1px 7px; border-radius: var(--r-pill); background: var(--primary-soft); color: var(--primary-hover); font-size: 10.5px; font-weight: 600; }
.lt-coming { flex-shrink: 0; font-size: var(--fs-xs); color: var(--faint); }
.lt-go { flex-shrink: 0; color: var(--faint); }
.lt-row:hover .lt-go { color: var(--primary-hover); }
.lt-pin { flex-shrink: 0; width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--r-xs); background: transparent; color: var(--border-steel); cursor: pointer; opacity: 0; transition: opacity 0.12s, color 0.12s, background 0.12s; }
.lt-row-wrap:hover .lt-pin, .lt-pin.pinned { opacity: 1; }
.lt-pin:hover { background: var(--warn-soft); color: var(--amber); }
.lt-pin.pinned { color: var(--amber); }
.lt-pin:focus-visible { opacity: 1; outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }

/* Agent 动作行：等宽名字 + 一句说明 + 风险等级 */
.lt-action { display: grid; grid-template-columns: 132px minmax(0, 1fr) auto; align-items: center; gap: var(--sp-3); cursor: default; min-height: 38px; padding: 5px var(--sp-3); border-radius: var(--r-sm); }
.lt-action:hover { background: var(--card-soft); }
.lt-action-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-code); }

/* 空结果 / 语义推荐 */
.lt-empty-block { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-7) var(--sp-3); color: var(--text-weak); }
.lt-empty-block b { font-size: var(--fs-base); color: var(--text); }
.lt-empty-block > span { font-size: var(--fs-sm); color: var(--muted); }
.empty-ico { display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--r-md); background: var(--well); color: var(--muted); }
.semantic-title { font-size: var(--fs-md); }
.semantic-list { display: flex; flex-direction: column; gap: 2px; width: 100%; }
.semantic-item { border: 1px solid var(--card-border); display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: var(--sp-3); }
.semantic-item .lt-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.semantic-score { flex-shrink: 0; font-family: var(--font-num); font-size: var(--fs-xs); color: var(--faint); }
.semantic-hint { font-size: var(--fs-xs); color: var(--faint); }
.semantic-note { font-size: var(--fs-xs); color: var(--warn); }

/* ---------- 右栏：最近使用 + 提示 ---------- */
.lt-side { min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding-bottom: var(--sp-7); }
.lt-card { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); background: var(--card-soft); border: 1px solid var(--card-border); border-radius: var(--r-md); }
.lt-card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.lt-card-head b { font-size: var(--fs-sm); color: var(--text); }
.lt-card-act { padding: 0; border: 0; background: none; font-size: var(--fs-xs); color: var(--muted); cursor: pointer; }
.lt-card-act:hover { color: var(--primary-hover); }
.lt-recent { display: flex; flex-direction: column; gap: 1px; }
.lt-recent-row { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; padding: 4px; border: 0; border-radius: var(--r-xs); background: none; color: var(--text-weak); text-align: left; cursor: pointer; }
.lt-recent-row:hover { background: var(--card); color: var(--text); }
.lt-recent-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); }
.lt-recent-time { flex-shrink: 0; font-size: var(--fs-xs); color: var(--faint); }
.lt-empty-text { margin: 0; font-size: var(--fs-xs); color: var(--faint); line-height: var(--lh-body); }
.lt-tips { margin: 0; padding-left: var(--sp-4); display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-xs); color: var(--muted); line-height: var(--lh-body); }

@media (max-width: 1100px) {
  .lt-body { grid-template-columns: minmax(0, 1fr); }
  .lt-side { display: none; }
}
</style>
