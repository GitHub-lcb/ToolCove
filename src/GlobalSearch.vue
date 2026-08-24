<script setup>
import { ref, computed, nextTick, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";
import { searchToolboxTools, TOOLBOX_GROUPS } from "./toolboxTools.js";

const { t } = useI18n();

const emit = defineEmits(["navigate"]);

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const open = ref(false);
const q = ref("");
const inputRef = ref(null);
const copiedId = ref(null); // 刚复制的结果 copyKey（瞬态打勾）
const data = ref({ problems: [], snippets: [] });

async function loadAll() {
  try {
    const [problems, snippets] = await Promise.all([
      invoke("load_data", { key: "problems" }),
      invoke("load_data", { key: "snippets" }),
    ]);
    data.value = {
      problems: problems || [],
      snippets: snippets || [],
    };
  } catch (e) {
    /* 静默失败，搜索仍可用其余数据 */
  }
}

async function openPalette() {
  open.value = true;
  q.value = "";
  await loadAll();
  await nextTick();
  inputRef.value?.focus();
}
function close() {
  open.value = false;
}

// ------- 搜索历史（最近 10 条，本地保存） -------
const HISTORY_KEY = "gs-history";
const history = ref([]);
try {
  history.value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
} catch { history.value = []; }
function recordHistory(kw) {
  if (!kw) return;
  history.value = [kw, ...history.value.filter((h) => h !== kw)].slice(0, 10);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value));
}
function clearHistory() {
  history.value = [];
  localStorage.removeItem(HISTORY_KEY);
}

// 面板打开期间监听窗口级 Esc（输入框失焦时也能关闭）
function onWinKey(e) {
  if (e.key === "Escape") close();
}
watch(open, (v) => {
  if (v) window.addEventListener("keydown", onWinKey);
  else window.removeEventListener("keydown", onWinKey);
});

const GROUPS = {
  problem: { labelKey: "nav.problem", icon: "alert" },
  snippet: { labelKey: "nav.snippet", icon: "copy" },
  tool: { labelKey: "common.gsGroupTool", icon: "wrench" },
};
const GROUP_BY_KEY = new Map(TOOLBOX_GROUPS.map((g) => [g.key, g]));

const results = computed(() => {
  const kw = q.value.trim().toLowerCase();
  if (!kw) return [];
  const out = [];
  const hit = (s) => s && s.toLowerCase().includes(kw);

  for (const p of data.value.problems) {
    if (hit(p.title) || hit(p.note) || (p.tags || []).join(" ").toLowerCase().includes(kw))
      out.push({ group: "problem", title: p.title, sub: p.note || "", module: "problem", id: p.id });
    else if (hit(p.resolution))
      out.push({ group: "problem", title: p.title, sub: t("common.gsResolution", { text: (p.resolution || "").slice(0, 60) }), module: "problem", id: p.id });
  }
  for (const s of data.value.snippets) {
    if (hit(s.title) || hit(s.content) || hit(s.category))
      out.push({ group: "snippet", title: s.title || t("common.gsUntitled"), sub: s.category || (s.content || "").slice(0, 40), module: "snippet", id: s.id, content: s.content || "", copyKey: "snip-" + s.id });
  }
  const toolResults = searchToolboxTools(kw).map((tool) => {
    const group = GROUP_BY_KEY.get(tool.category) || {};
    return {
      group: "tool",
      title: t(tool.labelKey),
      sub: `${t(group.labelKey)} · ${t(tool.descKey)}`,
      module: "toolbox",
      id: tool.key,
    };
  });
  return [...out.slice(0, Math.max(0, 60 - toolResults.length)), ...toolResults];
});

const grouped = computed(() => {
  const m = {};
  let flat = 0;
  for (const r of results.value) {
    (m[r.group] = m[r.group] || []).push({ ...r, idx: flat++ });
  }
  return Object.keys(GROUPS)
    .filter((g) => m[g])
    .map((g) => ({ key: g, ...GROUPS[g], items: m[g] }));
});

// ------- 键盘导航：↑↓ 移动高亮、Enter 打开（桌面应用预期） -------
const activeIdx = ref(0);
const flatCount = computed(() => results.value.length);
watch(q, () => (activeIdx.value = 0));
watch(open, (v) => {
  if (!v) activeIdx.value = 0;
});
function onKeyNav(e) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIdx.value = Math.min(flatCount.value - 1, activeIdx.value + 1);
    scrollActive();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIdx.value = Math.max(0, activeIdx.value - 1);
    scrollActive();
  } else if (e.key === "Enter") {
    const r = results.value[activeIdx.value];
    if (r) {
      e.preventDefault();
      pick(r);
    }
  }
}
function scrollActive() {
  nextTick(() => {
    document.querySelector(`.gs-item.on .gs-main`)?.scrollIntoView({ block: "nearest" });
  });
}

function pick(r) {
  recordHistory(q.value.trim());
  emit("navigate", { module: r.module, id: r.id, keyword: r.keyword || q.value.trim() });
  close();
}

let copiedTimer = null;
async function copyResult(r) {
  if (!r.content) return props.showToast(t("common.gsCopyEmpty"));
  try {
    await navigator.clipboard.writeText(r.content);
    copiedId.value = r.copyKey;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedId.value = null), 1500);
    props.showToast(t("common.gsCopied", { title: r.title }));
  } catch (e) {
    props.showToast(t("common.gsCopyFailed", { err: e }));
  }
}

defineExpose({ openPalette });
</script>

<template>
  <button class="gs-trigger" :title="t('common.gsTriggerTitle')" @click="openPalette">
    <Icon name="search" :size="15" /> <span class="gs-ph">{{ t("common.gsTriggerPh") }}</span> <kbd class="gs-kbd">Ctrl K</kbd>
  </button>

  <div v-if="open" class="gs-mask" @click.self="close">
    <div class="gs-panel">
      <div class="gs-inputbar">
        <Icon name="search" :size="18" class="gs-icon" />
        <input
          ref="inputRef"
          v-model="q"
          :placeholder="t('common.gsPlaceholder')"
          @keyup.esc="close"
          @keydown="onKeyNav"
        />
        <button class="gs-esc" @click="close">Esc</button>
      </div>

      <div class="gs-body">
        <div v-if="!q.trim()" class="gs-hint">
          <template v-if="history.length">
            <div class="gs-his-head">
              <span>{{ t("common.gsHistory") }}</span>
              <button class="gs-his-clear" @click="clearHistory">{{ t("common.gsClear") }}</button>
            </div>
            <div class="gs-his-list">
              <button v-for="h in history" :key="h" class="gs-his-chip" @click="q = h">
                <Icon name="clock" :size="12" /> {{ h }}
              </button>
            </div>
          </template>
          <template v-else>{{ t("common.gsHint") }}</template>
        </div>
        <div v-else-if="!grouped.length" class="gs-none">
          <span class="empty-ico"><Icon name="search" :size="32" /></span>
          <p>{{ t("common.gsNoMatch", { q }) }}</p>
        </div>
        <template v-else>
          <div v-for="g in grouped" :key="g.key" class="gs-group">
            <button class="gs-group-head" :title="t('common.gsJumpGroup', { label: t(g.labelKey) })" @click="activeIdx = g.items[0].idx"><Icon :name="g.icon" :size="13" /> {{ t(g.labelKey) }} <em>{{ g.items.length }}</em></button>
            <div v-for="(r, i) in g.items" :key="i" class="gs-item" :class="{ on: activeIdx === r.idx }" @mouseenter="activeIdx = r.idx">
              <button class="gs-main" @click="pick(r)">
                <span class="gs-title">{{ r.title }}</span>
                <span v-if="r.sub" class="gs-sub">{{ r.sub }}</span>
              </button>
              <button
                v-if="r.copyKey"
                class="gs-copy"
                :class="{ done: copiedId === r.copyKey }"
                :title="copiedId === r.copyKey ? t('common.gsCopiedTag') : t('common.gsCopyBtn')"
                @click.stop="copyResult(r)"
              >
                <Icon :name="copiedId === r.copyKey ? 'check' : 'copy'" :size="14" />
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gs-trigger { display: inline-flex; align-items: center; gap: 8px; width: 280px; background: var(--card); border: 1px solid var(--border-strong); color: var(--muted); padding: 9px 14px; border-radius: var(--r-sm); font-size: var(--fs-md); cursor: pointer; }
.gs-trigger:hover { border-color: var(--primary); color: var(--primary); }
.gs-ph { flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gs-kbd { flex-shrink: 0; font-family: inherit; font-size: var(--fs-xs); color: var(--muted); border: 1px solid var(--border-strong); border-radius: var(--r-xs); padding: 1px 5px; background: color-mix(in srgb, var(--text) 4%, transparent); }

.gs-mask { position: fixed; inset: 0; background: rgba(17, 24, 39, 0.5); display: flex; align-items: flex-start; justify-content: center; z-index: 200; padding: 80px 20px 20px; }
.gs-panel { background: var(--card); border-radius: var(--r-lg); width: 620px; max-width: 100%; max-height: 72vh; display: flex; flex-direction: column; box-shadow: 0 20px 50px rgba(16, 24, 40, 0.25); overflow: hidden; }
.gs-inputbar { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); transition: border-color 0.15s; }
.gs-inputbar:focus-within { border-bottom-color: var(--primary); }
.gs-icon { color: var(--muted); flex-shrink: 0; }
.gs-inputbar input { flex: 1; border: none; outline: none; background: transparent; font-size: var(--fs-lg); color: var(--text); }
.gs-esc { border: 1px solid var(--border-strong); background: var(--card); color: var(--muted); font-size: var(--fs-xs); padding: 3px 8px; border-radius: var(--r-xs); cursor: pointer; }

.gs-body { overflow-y: auto; padding: 8px; }
.gs-hint { text-align: center; color: var(--muted); font-size: var(--fs-md); padding: 32px 20px; }
.gs-none { text-align: center; color: var(--muted); font-size: var(--fs-md); padding: 20px 20px 28px; }
.gs-none .empty-ico { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 50%; background: var(--primary-soft); color: var(--primary); margin: 0 auto 8px; }
.gs-none p { margin: 2px 0 0; }
.gs-his-head { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-sm); font-weight: 700; color: var(--muted); margin-bottom: 10px; text-align: left; }
.gs-his-clear { background: none; border: none; color: var(--muted); font-size: var(--fs-sm); cursor: pointer; padding: 2px 6px; border-radius: var(--r-xs); }
.gs-his-clear:hover { color: var(--danger-deep); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.gs-his-list { display: flex; flex-wrap: wrap; gap: 8px; }
.gs-his-chip { display: inline-flex; align-items: center; gap: 5px; background: var(--card); border: 1px solid var(--border-strong); color: var(--text); font-size: var(--fs-sm); padding: 6px 11px; border-radius: var(--r-pill); cursor: pointer; transition: all 0.15s; }
.gs-his-chip:hover { border-color: var(--primary); color: var(--primary); }
.gs-group { margin-bottom: 6px; }
.gs-group-head { display: flex; align-items: center; gap: 6px; width: 100%; border: none; background: none; font-family: inherit; font-size: var(--fs-sm); font-weight: 700; color: var(--muted); padding: 8px 12px 4px; cursor: pointer; text-align: left; }
.gs-group-head:hover { color: var(--primary); }
.gs-group-head em { font-style: normal; background: var(--primary-soft); color: var(--primary); padding: 0 7px; border-radius: var(--r-pill); font-size: var(--fs-xs); }
.gs-item { display: flex; align-items: center; gap: 6px; width: 100%; border-radius: var(--r-sm); padding-right: 8px; transition: background 0.1s; }
.gs-item:hover { background: var(--primary-soft); }
/* 键盘导航高亮（↑↓ 移动、Enter 打开） */
.gs-item.on { background: var(--primary-soft); }
.gs-item.on .gs-main { color: var(--text); }
.gs-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; background: none; border: none; padding: 8px 12px; border-radius: var(--r-sm); cursor: pointer; }
.gs-copy { flex-shrink: 0; width: 30px; height: 30px; padding: 0; display: grid; place-items: center; border: 1px solid var(--border-strong); background: var(--card); border-radius: var(--r-sm); color: var(--muted); cursor: pointer; transition: all 0.15s; }
.gs-copy:hover { color: var(--primary); border-color: var(--primary); background: var(--card); }
.gs-copy.done { color: var(--success-deep); border-color: var(--success); background: var(--success-tint); }
.gs-title { font-size: var(--fs-base); color: var(--text); word-break: break-word; }
.gs-sub { font-size: var(--fs-sm); color: var(--muted); word-break: break-word; }

@media (prefers-color-scheme: dark) {
  .gs-trigger, .gs-esc { background: var(--card-raised); }
  .gs-kbd { background: rgba(255, 255, 255, 0.06); }
  .gs-copy.done { background: var(--success-soft); color: var(--success-light); border-color: var(--success-light); }
  .gs-his-chip { background: var(--card-raised); }
}
</style>
