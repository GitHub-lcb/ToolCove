<script setup>
// 表详情弹窗（DbTool 拆出）：索引 / DDL 双 Tab，懒加载由父组件负责
import Icon from "../Icon.vue";

const props = defineProps({
  detail: { type: Object, required: true },
  switchDetailTab: { type: Function, required: true },
  copyDetailDDL: { type: Function, required: true },
  useDetailDDL: { type: Function, required: true },
});
const emit = defineEmits(["close"]);
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal db-detail-modal">
      <h2>表详情 <code class="dd-table-name">{{ detail.table }}</code></h2>
      <div class="dd-tabs">
        <button class="dd-tab" :class="{ on: detail.tab === 'indexes' }" @click="switchDetailTab('indexes')">
          索引<template v-if="detail.loaded.indexes">（{{ detail.indexes.length }}）</template>
        </button>
        <button class="dd-tab" :class="{ on: detail.tab === 'ddl' }" @click="switchDetailTab('ddl')">DDL</button>
      </div>
      <div v-if="detail.loading" class="meta-tip">加载中…</div>
      <div v-else-if="detail.error" class="meta-tip err">{{ detail.error }}</div>
      <template v-else>
        <!-- 索引 Tab：索引名 / 唯一 / 列 / 定义 -->
        <div v-if="detail.tab === 'indexes'" class="dd-body">
          <table v-if="detail.indexes.length" class="tbl idx-tbl">
            <thead>
              <tr>
                <th>索引名</th>
                <th>唯一</th>
                <th>列</th>
                <th>定义</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ix in detail.indexes" :key="ix.name">
                <td class="idx-name" :title="ix.name">{{ ix.name }}</td>
                <td :class="{ uni: ix.unique }">{{ ix.unique ? "是" : "否" }}</td>
                <td class="idx-cols" :title="(ix.columns || []).join(', ')">{{ (ix.columns || []).join(", ") }}</td>
                <td class="idx-def" :title="ix.def">{{ ix.def }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="meta-tip">该表没有索引</p>
        </div>
        <!-- DDL Tab：建表语句全文 -->
        <div v-else class="dd-body">
          <pre v-if="detail.ddl" class="ddl-pre">{{ detail.ddl }}</pre>
          <p v-else class="meta-tip">未能获取 DDL</p>
        </div>
      </template>
      <div class="modal-foot">
        <button v-if="detail.tab === 'ddl' && detail.ddl" class="btn solid" @click="copyDetailDDL()"><Icon name="copy" :size="13" />复制 DDL</button>
        <button v-if="detail.tab === 'ddl' && detail.ddl" class="btn solid" @click="useDetailDDL()"><Icon name="edit" :size="13" />填入编辑器</button>
        <button class="btn primary" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.db-detail-modal { width: 720px; }
.db-detail-modal h2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dd-table-name { font-family: var(--font-mono); font-size: var(--fs-md); font-weight: 600; background: var(--well); padding: 2px 8px; border-radius: var(--r-xs); color: var(--text); }
.dd-tabs { display: inline-flex; gap: 4px; padding: 3px; margin-bottom: 10px; background: var(--well); border-radius: var(--r-pill); }
.dd-tab { padding: 5px 14px; font-size: var(--fs-sm); font-weight: 600; border: none; background: transparent; color: var(--muted); border-radius: var(--r-pill); cursor: pointer; transition: all 0.15s; }
.dd-tab:hover { color: var(--primary); }
.dd-tab.on { background: var(--card); color: var(--primary); box-shadow: 0 1px 4px rgba(16, 24, 40, 0.12); }
.dd-body { min-height: 120px; max-height: 55vh; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-sm); }
/* 索引表格：固定布局 + 定义列截断悬浮看全文 */
.idx-tbl { table-layout: fixed; }
.idx-tbl th:nth-child(1) { width: 30%; }
.idx-tbl th:nth-child(2) { width: 48px; text-align: center; }
.idx-tbl td { cursor: default; }
.idx-tbl td:nth-child(2) { text-align: center; }
.idx-name { font-weight: 600; color: var(--text); }
.idx-tbl td.uni { color: var(--accent); font-weight: 600; }
.idx-cols, .idx-def { font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.idx-def { color: var(--muted); }
/* DDL 原文 */
.ddl-pre { margin: 0; padding: 12px 14px; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); white-space: pre-wrap; word-break: break-all; color: var(--text); }

.meta-tip { padding: 2px 6px; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }
.meta-tip.err { color: var(--danger); }

.tbl { border-collapse: collapse; width: 100%; table-layout: fixed; font-family: var(--font-mono); font-size: var(--fs-xs); }
.tbl th { position: sticky; top: 0; z-index: 1; padding: 7px 12px; font-weight: 700; text-align: left; background: var(--primary-soft); color: var(--primary); border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tbl td { padding: 6px 12px; border-bottom: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }

.btn { display: inline-flex; align-items: center; gap: 5px; padding: 7px 14px; font-size: var(--fs-md); font-weight: 600; border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; border: 1px solid transparent; }
.btn.primary { background: var(--primary); color: var(--text-invert); }
.btn.primary:hover:not(:disabled) { background: var(--primary-hover); }
.btn.solid { background: var(--card); color: var(--text); border-color: var(--border-strong); }
.btn.solid:hover { border-color: var(--primary); color: var(--primary); }
</style>
