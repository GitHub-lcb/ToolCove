<script setup>
import { computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import Icon from "./Icon.vue";
import AiExtract from "./AiExtract.vue";
import { PKG_POOL_COLS, PKG_ART_COLS, PKG_DB_COLS, emptyPkg, newPkgRow, buildReleaseXlsx } from "./shared.js";

const props = defineProps({
  iteration: { type: Object, required: true },
  persist: { type: Function, default: async () => {} },
  showToast: { type: Function, default: () => {} },
});

// 保证上线包结构存在
function pkg() {
  if (!props.iteration.pkg) props.iteration.pkg = emptyPkg();
  const p = props.iteration.pkg;
  if (!Array.isArray(p.pools)) p.pools = [];
  if (!Array.isArray(p.artifacts)) p.artifacts = [];
  if (!Array.isArray(p.dbScripts)) p.dbScripts = [];
  return p;
}

const TABS = [
  { key: "pools", title: "Pool 发布表", cols: PKG_POOL_COLS, icon: "box" },
  { key: "artifacts", title: "制品表", cols: PKG_ART_COLS, icon: "folder" },
  { key: "dbScripts", title: "数据库脚本表", cols: PKG_DB_COLS, icon: "database" },
];

// AI 识图分组定义：三表列直接复用，bool 列标记为布尔字段；关键列补充语义描述帮助模型归类
const AI_FIELD_DESC = {
  artifacts: { name: "制品/任务/配置项名称（如定时任务 job、pass 配置、发布点等）" },
  dbScripts: { file: "SQL 脚本文件名（如 V20260715__xxx.sql）或直接给出的 SQL 语句摘要", db: "目标数据库，识别不到留空" },
};
const AI_GROUPS = TABS.map((t) => ({
  key: t.key,
  title: t.title,
  fields: t.cols.map((c) => ({ key: c.key, label: c.label, bool: c.type === "bool", desc: (AI_FIELD_DESC[t.key] || {})[c.key] })),
}));
// 识图结果→按表批量追加行
async function fillFromAI(data) {
  const p = pkg();
  let added = 0;
  for (const tab of TABS) {
    const rows = Array.isArray(data[tab.key]) ? data[tab.key] : [];
    for (const r of rows) {
      p[tab.key].push({ ...newPkgRow(tab.cols), ...r });
      added++;
    }
  }
  if (!added) return props.showToast("没有可填入的行");
  await props.persist();
  props.showToast(`已填入 ${added} 行`);
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
    const safe = (props.iteration.title || "迭代").replace(/[\\/:*?"<>|]/g, "_");
    const path = await save({
      title: "导出上线包 Excel",
      defaultPath: `${safe}_上线包.xlsx`,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (!path) return;
    const b64 = await buildReleaseXlsx(props.iteration);
    await invoke("export_file_b64", { path, contentB64: b64 });
    props.showToast("已导出上线包 Excel");
  } catch (e) {
    props.showToast("导出失败：" + e);
  }
}
</script>

<template>
  <div class="pkg">
    <div class="pkg-head">
      <h3 class="list-title"><Icon name="rocket" :size="16" /> 上线包</h3>
      <div class="pkg-head-ops">
        <AiExtract :groups="AI_GROUPS" button-label="AI 识图填表" title="AI 识图录入上线包" hint="这是上线包截图，可能包含「Pool 发布表」「制品表」「数据库脚本表」中的一张或多张，请识别图中实际出现的表并按表提取每一行。注意：脚本与制品信息也可能不在规范表格里，而是写在表下方的备注长文本/合并单元格中（如‘初始化脚本 xxx.sql 责任人’‘定时任务’‘新增配置’），请逐条拆分归入对应表。" :show-toast="showToast" @apply="fillFromAI" />
        <button class="btn-primary sm" @click="exportXls"><Icon name="download" :size="15" /> 导出 Excel</button>
      </div>
    </div>

    <section v-for="tab in TABS" :key="tab.key" class="pkg-sec">
      <div class="sec-head">
        <span class="sec-title"><Icon :name="tab.icon" :size="14" /> {{ tab.title }} <em>{{ counts[tab.key] }}</em></span>
        <button class="btn-ghost sm" @click="addRow(tab)"><Icon name="plus" :size="14" /> 添加行</button>
      </div>

      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th v-for="c in tab.cols" :key="c.key">{{ c.label }}</th>
              <th class="op-col"></th>
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
                <input v-else v-model="row[c.key]" @change="onChange" :placeholder="c.label" :title="row[c.key] || ''" />
              </td>
              <td class="op-col">
                <button class="icon-btn xs" title="删除该行" @click="removeRow(tab, row)"><Icon name="x" :size="13" /></button>
              </td>
            </tr>
            <tr v-if="!pkg()[tab.key].length">
              <td :colspan="tab.cols.length + 1" class="empty-row">还没有数据，点「添加行」开始维护。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pkg { margin-top: 20px; }
.pkg-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.pkg-head .list-title { margin: 0; display: flex; align-items: center; gap: 7px; font-size: var(--fs-base); font-weight: 700; }
.pkg-head-ops { display: flex; align-items: center; gap: 10px; }

.pkg-sec { margin-bottom: 18px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); overflow: hidden; box-shadow: var(--shadow); }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--card-soft); }
.sec-title { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-md); font-weight: 700; color: var(--text-soft); }
.sec-title em { font-style: normal; color: var(--accent-hover); background: var(--accent-soft); padding: 1px 8px; border-radius: var(--r-pill); font-size: var(--fs-sm); }

.tbl-wrap { overflow-x: auto; }
.tbl { border-collapse: collapse; width: 100%; min-width: 100%; }
.tbl th { font-size: var(--fs-sm); font-weight: 700; color: var(--text-dim); text-align: left; padding: 8px 10px; background: var(--ghost); white-space: nowrap; border-bottom: 1px solid var(--border); }
.tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.tbl tr:last-child td { border-bottom: none; }
.tbl input[type="text"], .tbl input:not([type]) { width: 100%; min-width: 96px; padding: 6px 8px; border: 1px solid transparent; border-radius: var(--r-xs); font-size: var(--fs-sm); outline: none; background: transparent; color: var(--text); }
.tbl input:not([type]):hover, .tbl input:not([type]):focus { border-color: var(--border-strong); background: var(--card); }
.tbl input:not([type]):focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.boolcell { text-align: center; }
.boolcell input[type="checkbox"] { width: 17px; height: 17px; accent-color: var(--accent-hover); cursor: pointer; }
.op-col { width: 34px; text-align: center; }
.empty-row { text-align: center; color: var(--muted); font-size: var(--fs-sm); padding: 16px; }

/* 行删除按钮：hover 走危险语义（全局 .icon-btn 基础样式已统一，见 App.vue） */
.icon-btn:hover { color: var(--danger-deep); border-color: var(--border-danger); background: var(--danger-soft); }

@media (prefers-color-scheme: dark) {
  .tbl th { background: var(--card-soft); }
  .tbl input:not([type]):hover, .tbl input:not([type]):focus { background: var(--card-raised); }
  .icon-btn { background: var(--card-raised); }
  .sec-title em { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
}
</style>
