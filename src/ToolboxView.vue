<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import Icon from "./Icon.vue";
import { relativeTime } from "./shared.js";
import { loadToolbox, saveToolbox, saveToolboxNow, flushToolbox } from "./toolboxStore.js";
import { createJsonHandoffQueue, JSON_HANDOFF_EVENT } from "./tools/jsonHandoff.js";
import { prepareJsonHandoff } from "./tools/jsonWorkspace.js";
import { groupToolboxTools, TOOLBOX_TOOLS } from "./toolboxTools.js";
import { getToolComponent } from "./toolComponents.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  jumpId: { type: Object, default: null },
});

const isTauri = !!window.__TAURI_INTERNALS__;
const RECENT_MAX = 8;

const { t } = useI18n();

// 工具注册表：ready=true 可打开，false 为规划中占位卡（key/label/icon 与独立窗口共用）
const TOOLS = TOOLBOX_TOOLS;
const GROUPS = groupToolboxTools(TOOLS);

const activeTool = ref(""); // "" = 画廊首页
const recent = ref([]); // [{ key, ts }]
const expandedGroup = ref(""); // 默认全部收起；同一时间只展开一个大类

let mounted = false;
let disposed = false;
onMounted(async () => {
  const saved = await loadToolbox("recent", []);
  if (disposed) return;
  recent.value = Array.isArray(saved) ? saved.filter((r) => TOOLS.some((t) => t.key === r.key)) : [];
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
// 最近使用记录的第一位即上次打开的工具，画廊里给它一个视觉焦点
function isLastUsed(t) {
  return recent.value.length > 0 && recent.value[0].key === t.key;
}
const activeMeta = computed(() => TOOLS.find((t) => t.key === activeTool.value) || null);
// 详情区动态组件：组件映射见 toolComponents.js（与独立窗口共用）
const toolComp = computed(() => (activeMeta.value ? getToolComponent(activeMeta.value.key) : null));
// 仅 API 调试工具需要跨工具跳转钩子（其余组件未声明该 prop，不能透传避免落到根元素）
const toolProps = computed(() => (activeTool.value === "request" ? { "open-in-json": openInJson } : {}));

function recordRecent(tool) {
  const list = recent.value.filter((r) => r.key !== tool.key);
  list.unshift({ key: tool.key, ts: Date.now() });
  recent.value = list.slice(0, RECENT_MAX);
  saveRecent();
}

// 打开工具：Tauri 下开独立窗口（可拖动、缩放；同工具单例，已开则聚焦）；浏览器降级为主窗口内嵌
async function openToolWindow(tool) {
  const label = "tool-" + tool.key;
  try {
    // Tauri v2：getByLabel 是 async（经 IPC 查询窗口），需 await 才是窗口实例
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.unminimize();
      await existing.setFocus();
      return;
    }
    const theme = await resolveToolWindowTheme();
    const win = new WebviewWindow(label, {
      url: "/index.html?tool=" + tool.key,
      title: t(tool.labelKey),
      width: 980,
      height: 720,
      minWidth: 720,
      minHeight: 520,
      decorations: false,
      center: true,
      visible: false,
      focus: false,
      theme,
      backgroundColor: theme === "dark" ? [13, 17, 23, 255] : [246, 248, 250, 255],
    });
    // 创建失败（如权限不足）：提示降级内嵌
    win.once("tauri://error", (e) => {
      console.error(t("common.toolWinFail", { err: JSON.stringify(e) }));
      activeTool.value = tool.key;
      props.showToast(t("toolbox.windowFailFallback"));
    });
  } catch (e) {
    console.error(t("common.toolWinOpenFail", { err: e }));
    activeTool.value = tool.key;
  }
}

async function resolveToolWindowTheme() {
  const mode = localStorage.getItem("themeMode") || "system";
  if (mode === "light" || mode === "dark") return mode;
  try {
    return (await getCurrentWindow().theme()) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
}

async function openTool(tool) {
  if (!tool.ready) return props.showToast(t("toolbox.comingSoon", { name: t(tool.labelKey) }));
  recordRecent(tool);
  if (isTauri) await openToolWindow(tool);
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
function toggleGroup(key) {
  expandedGroup.value = expandedGroup.value === key ? "" : key;
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
        <component :is="toolComp" :show-toast="showToast" v-bind="toolProps" />
      </section>
    </template>

    <!-- 画廊首页：工具列表 + 侧栏 -->
    <template v-else>
      <div class="home">
        <div class="home-main">
          <div class="tool-groups">
            <section v-for="group in GROUPS" :key="group.key" class="tool-group">
              <button
                class="group-head"
                :class="{ open: expandedGroup === group.key }"
                :aria-expanded="expandedGroup === group.key"
                :aria-controls="'tool-group-' + group.key"
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
                <div v-if="expandedGroup === group.key" :id="'tool-group-' + group.key" class="tool-list">
                  <button
                    v-for="tool in group.tools"
                    :key="tool.key"
                    class="tool-item"
                    :class="{ coming: !tool.ready, last: isLastUsed(tool) }"
                    @click="openTool(tool)"
                  >
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
.toolbox { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 10px; padding: 8px 28px 18px; }

/* 面包屑 */
.crumbs { flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
.crumb-back { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; font-size: var(--fs-md); border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.crumb-back:hover { color: var(--primary-hover); background: var(--primary-soft); }
.crumb-sep { color: var(--muted); font-size: var(--fs-sm); }
.crumb-ico { width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--r-xs); background: var(--primary-soft); color: var(--primary-hover); }
.crumb-cur { font-size: var(--fs-md); font-weight: 600; }
.crumb-desc { font-size: var(--fs-sm); color: var(--muted); }
.detail-body { flex: 1; min-height: 0; }

/* 首页两栏 */
.home { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: var(--sp-5); align-items: start; }
.home-main { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-5); }

/* 工具大类：默认收起，分类头与工具列表分层，避免把卡片套进卡片 */
.tool-groups { display: flex; flex-direction: column; gap: var(--sp-3); }
.tool-group { min-width: 0; }
.group-head { display: flex; align-items: center; gap: var(--sp-4); width: 100%; padding: var(--sp-4); color: var(--text); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); cursor: pointer; text-align: left; transition: border-color 0.15s, background 0.15s, box-shadow 0.15s; }
.group-head:hover { border-color: var(--border-strong); box-shadow: var(--shadow); }
.group-head.open { border-color: var(--border-blue); background: color-mix(in srgb, var(--primary) 2.5%, var(--card)); }
.group-head:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.group-icon { width: 44px; height: 44px; flex-shrink: 0; display: grid; place-items: center; color: var(--primary-hover); background: var(--primary-soft); border-radius: var(--r-md); }
.group-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.group-name { font-size: var(--fs-lg); font-weight: 700; line-height: var(--lh-tight); }
.group-desc { min-width: 0; overflow: hidden; color: var(--muted); font-size: var(--fs-sm); line-height: var(--lh-tight); text-overflow: ellipsis; white-space: nowrap; }
.group-count { flex-shrink: 0; padding: var(--sp-1) var(--sp-3); color: var(--text-soft); background: var(--well); border-radius: var(--r-pill); font-family: var(--font-num); font-size: var(--fs-xs); white-space: nowrap; }
.group-arrow { flex-shrink: 0; color: var(--muted); transition: transform 0.15s, color 0.15s; }
.group-head.open .group-arrow { color: var(--primary); transform: rotate(90deg); }

/* 展开的工具列表：左侧引导线表达归属，工具本身仍是独立重复项 */
.tool-list { display: flex; flex-direction: column; gap: var(--sp-3); margin: var(--sp-3) 0 var(--sp-2) var(--sp-7); padding-left: var(--sp-5); border-left: 2px solid var(--border-blue); }
.group-reveal-enter-active, .group-reveal-leave-active { transition: opacity 0.15s, transform 0.15s; }
.group-reveal-enter-from, .group-reveal-leave-to { opacity: 0; transform: translateY(-4px); }

/* 工具列表：紧凑行卡（图标 + 信息 + 前进箭头），整行可点 */
.tool-item { display: flex; align-items: center; gap: var(--sp-4); width: 100%; padding: var(--sp-4); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); color: var(--text); cursor: pointer; text-align: left; transition: all 0.18s; }
.tool-item:hover:not(.coming) { transform: translateY(-2px); border-color: var(--border-strong); box-shadow: var(--shadow); }
.tool-item.coming { cursor: default; }
/* tile：线性图标 + 主色柔和底（UI 2.0 单主色体系，不装饰着色），固定 52px 方形 */
.tile { width: 52px; height: 52px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: var(--r-md); background: var(--primary-soft); color: var(--primary-hover); }
/* 上次使用过的工具：描边 + 极淡主色底，形成画廊视觉焦点 */
.tool-item.last { border-color: color-mix(in srgb, var(--primary) 30%, var(--card-border)); background: color-mix(in srgb, var(--primary) 2.5%, var(--card)); }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.info-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.name { font-size: var(--fs-lg); font-weight: 600; line-height: var(--lh-tight); }
.last-tag { flex-shrink: 0; padding: 0 7px; font-size: var(--fs-xs); font-weight: 600; line-height: 1.7; color: var(--primary-hover); background: var(--primary-soft); border-radius: var(--r-pill); }
.desc { font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-tight); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.go { flex-shrink: 0; color: var(--faint); transition: color 0.15s, transform 0.15s; }
.tool-item:hover:not(.coming) .go { color: var(--primary); transform: translateX(2px); }
.go-txt { flex-shrink: 0; font-size: var(--fs-sm); color: var(--muted); }

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

/* 窄窗口：右侧 260px 侧栏移到主列下方，工具列表自适应 */
@media (max-width: 900px) {
  .home { grid-template-columns: 1fr; }
}
</style>
