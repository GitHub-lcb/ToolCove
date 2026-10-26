<script setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { save } from "../platform/dialog.js";
import Icon from "../ui/Icon.vue";
import AiExtract from "./AiExtract.vue";
import { PKG_ART_COLS, PKG_DB_COLS, PKG_POOL_COLS, emptyPkg, newPkgRow } from "../shared/pkg.js";
import { buildReleaseXlsx } from "../shared/xlsx.js";

const props = defineProps({
  iteration: { type: Object, required: true },
  persist: { type: Function, default: async () => {} },
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

// 保证上线包结构存在
function pkg() {
  if (!props.iteration.pkg) props.iteration.pkg = emptyPkg();
  const p = props.iteration.pkg;
  if (!Array.isArray(p.pools)) p.pools = [];
  if (!Array.isArray(p.artifacts)) p.artifacts = [];
  if (!Array.isArray(p.dbScripts)) p.dbScripts = [];
  return p;
}

// 三表页签：cols 沿用 src/shared/pkg.js 的列定义（labelKey），标题走词条（computed：语言切换后重新求值）
const TABS = computed(() => [
  { key: "pools", title: t("release.pkgTabPools"), cols: PKG_POOL_COLS, icon: "box" },
  { key: "artifacts", title: t("release.pkgTabArtifacts"), cols: PKG_ART_COLS, icon: "folder" },
  { key: "dbScripts", title: t("release.pkgTabDbScripts"), cols: PKG_DB_COLS, icon: "database" },
]);

// AI 识图分组定义：三表列直接复用，bool 列标记为布尔字段；关键列补充语义描述帮助模型归类
const AI_FIELD_DESC = computed(() => ({
  artifacts: { name: t("release.pkgAiDescName") },
  dbScripts: { file: t("release.pkgAiDescFile"), db: t("release.pkgAiDescDb") },
}));
const AI_GROUPS = computed(() =>
  TABS.value.map((tab) => ({
    key: tab.key,
    title: tab.title,
    fields: tab.cols.map((c) => ({ key: c.key, label: t(c.labelKey), bool: c.type === "bool", desc: (AI_FIELD_DESC.value[tab.key] || {})[c.key] })),
  }))
);
// 识图结果→按表批量追加行
async function fillFromAI(data) {
  const p = pkg();
  let added = 0;
  for (const tab of TABS.value) {
    const rows = Array.isArray(data[tab.key]) ? data[tab.key] : [];
    for (const r of rows) {
      p[tab.key].push({ ...newPkgRow(tab.cols), ...r });
      added++;
    }
  }
  if (!added) return props.showToast(t("release.pkgAiNothing"));
  await props.persist();
  props.showToast(t("release.pkgAiFilled", { count: added }));
}

const counts = computed(() => {
  const p = pkg();
  return { pools: p.pools.length, artifacts: p.artifacts.length, dbScripts: p.dbScripts.length };
});

async function addRow(tab) {
  pkg()[tab.key].push(newPkgRow(tab.cols));
  await props.persist();
}
async function removeRow(tab, row) {
  const p = pkg();
  p[tab.key] = p[tab.key].filter((r) => r.id !== row.id);
  await props.persist();
}
async function onChange() {
  await props.persist();
}

async function exportXls() {
  try {
    const safe = (props.iteration.title || t("release.pkgExportFallbackName")).replace(/[\\/:*?"<>|]/g, "_");
    const path = await save({
      title: t("release.pkgExportDialog"),
      // 导出文件名保持中文「_上线包.xlsx」：这是给同事看的交付物，不随界面语言变化
      defaultPath: `${safe}_上线包.xlsx`,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (!path) return;
    const b64 = await buildReleaseXlsx(props.iteration);
    await invoke("export_file_b64", { path, contentB64: b64 });
    props.showToast(t("release.pkgExported"));
  } catch (e) {
    props.showToast(t("release.pkgExportFailed", { err: e }));
  }
}
</script>

<template>
  <div class="pkg">
    <div class="pkg-head">
      <h3 class="list-title"><Icon name="rocket" :size="16" /> {{ t("release.pkgTitle") }}</h3>
      <div class="pkg-head-ops">
        <AiExtract :groups="AI_GROUPS" :button-label="t('release.pkgAiBtn')" :title="t('release.pkgAiTitle')" :hint="t('release.pkgAiHint')" :show-toast="showToast" @apply="fillFromAI" />
        <button class="btn-primary sm" @click="exportXls"><Icon name="download" :size="15" /> {{ t("release.pkgBtnExport") }}</button>
      </div>
    </div>

    <section v-for="tab in TABS" :key="tab.key" class="pkg-sec">
      <div class="sec-head">
        <span class="sec-title"><Icon :name="tab.icon" :size="14" /> {{ tab.title }} <em>{{ counts[tab.key] }}</em></span>
        <button class="btn-ghost sm" @click="addRow(tab)"><Icon name="plus" :size="14" /> {{ t("release.pkgBtnAddRow") }}</button>
      </div>

      <div class="tbl-wrap">
        <!-- 表名就是页签名：读屏进表格前先知道在看哪张表，不需要另写一份文案 -->
        <table class="tbl" :aria-label="tab.title">
          <thead>
            <tr>
              <th scope="col" v-for="c in tab.cols" :key="c.key">{{ t(c.labelKey) }}</th>
              <th scope="col" class="op-col"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in pkg()[tab.key]" :key="row.id">
              <td v-for="c in tab.cols" :key="c.key" :class="{ boolcell: c.type === 'bool' }">
                <input
                  v-if="c.type === 'bool'"
                  type="checkbox"
                  v-model="row[c.key]"
                  @change="onChange"
                />
                <!-- 列宽有限，悬停显示完整内容 -->
                <input v-else v-model="row[c.key]" @change="onChange" :placeholder="t(c.labelKey)" :title="row[c.key] || ''" />
              </td>
              <td class="op-col">
                <button class="icon-btn xs" :title="t('release.pkgDeleteRow')" @click="removeRow(tab, row)"><Icon name="x" :size="13" /></button>
              </td>
            </tr>
            <tr v-if="!pkg()[tab.key].length">
              <td :colspan="tab.cols.length + 1" class="empty-row">{{ t("release.pkgEmptyRow") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pkg { margin-top: var(--sp-7); }
.pkg-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); margin-bottom: var(--sp-4); }
.pkg-head .list-title { margin: 0; display: flex; align-items: center; gap: 7px; font-size: var(--fs-base); font-weight: 700; }
.pkg-head-ops { display: flex; align-items: center; gap: var(--sp-3); }

.pkg-sec { margin-bottom: 18px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); overflow: hidden; box-shadow: var(--shadow); }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-4) var(--sp-6); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.sec-title { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-md); font-weight: 700; color: var(--text-soft); }
.sec-title em { font-style: normal; color: var(--accent-hover); background: var(--accent-soft); padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-sm); }

.tbl-wrap { overflow-x: auto; }
.tbl { border-collapse: collapse; width: 100%; min-width: 100%; }
.tbl th { font-size: var(--fs-sm); font-weight: 700; color: var(--text-dim); text-align: left; padding: var(--sp-2) var(--sp-3); background: var(--ghost); white-space: nowrap; border-bottom: 1px solid var(--border); }
.tbl td { padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border); vertical-align: middle; }
.tbl tr:last-child td { border-bottom: none; }
.tbl input[type="text"], .tbl input:not([type]) { width: 100%; min-width: 96px; padding: var(--sp-1) var(--sp-2); border: 1px solid transparent; border-radius: var(--r-xs); font-size: var(--fs-sm); outline: none; background: transparent; color: var(--text); }
.tbl input:not([type]):hover, .tbl input:not([type]):focus { border-color: var(--border-strong); background: var(--card); }
.tbl input:not([type]):focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.boolcell { text-align: center; }
.boolcell input[type="checkbox"] { width: 17px; height: 17px; accent-color: var(--accent-hover); cursor: pointer; }
.op-col { width: 34px; text-align: center; }
.empty-row { text-align: center; color: var(--muted); font-size: var(--fs-sm); padding: var(--sp-6); }

/* 行删除按钮：hover 走危险语义（全局 .icon-btn 基础样式已统一，见 App.vue） */
.icon-btn:hover { color: var(--danger-deep); border-color: var(--border-danger); background: var(--danger-soft); }

@media (prefers-color-scheme: dark) {
  .tbl th { background: var(--card-soft); }
  .tbl input:not([type]):hover, .tbl input:not([type]):focus { background: var(--card-raised); }
  .icon-btn { background: var(--card-raised); }
  .sec-title em { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
}
</style>
