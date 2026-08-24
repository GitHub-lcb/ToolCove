<script setup>
// 表结构树（DbTool 拆出）：只读展示 + 交互委托给父组件（父持有 meta/展开态等状态）
import Icon from "../Icon.vue";
import { quoteIdent } from "../db.js";

const props = defineProps({
  meta: { type: Object, required: true },
  tableFilter: { type: String, default: "" },
  filteredTables: { type: Array, default: () => [] },
  tableGroups: { type: Object, default: () => ({ table: [], view: [] }) },
  expanded: { type: Object, default: () => ({}) },
  loadingCols: { type: Object, default: () => ({}) },
  activeConn: { type: Object, default: null },
  toggleTable: { type: Function, required: true },
  onTreeNameClick: { type: Function, required: true },
  quickQuery: { type: Function, required: true },
  onTreeCtx: { type: Function, required: true },
  openDetail: { type: Function, required: true },
  onColCtx: { type: Function, required: true },
  insertColumn: { type: Function, required: true },
  loadTables: { type: Function, required: true },
});
const emit = defineEmits(["update:tableFilter"]);
</script>

<template>
  <!-- 表结构树：点表快捷查询前 100 行，展开看列，双击列名插入 SQL -->
  <div class="meta-pane">
    <div class="pane-head">
      <b>表结构</b>
      <span class="pane-ops">
        <button class="mini-btn icon" title="刷新表清单" @click="loadTables()"><Icon name="repeat" :size="13" /></button>
      </span>
    </div>
    <div v-if="meta.loading" class="meta-tip">加载表清单…</div>
    <div v-else-if="meta.error" class="meta-tip err">{{ meta.error }}</div>
    <div v-else-if="!meta.tables.length" class="meta-tip">未发现表或视图</div>
      <template v-else>
        <!-- 表名过滤 -->
      <input
        :value="tableFilter"
        class="table-filter"
        type="text"
        placeholder="过滤表名…"
        title="输入关键字过滤表/视图（不区分大小写）"
        @input="emit('update:tableFilter', $event.target.value)"
      />
      <div v-if="!filteredTables.length" class="meta-tip">没有匹配「{{ tableFilter.trim() }}」的表</div>
      <template v-else>
        <!-- 分组渲染：表 / 视图（Navicat 对象树习惯）。统一滚动容器避免对象过多时被截断。 -->
        <div class="meta-scroll">
          <div v-for="(group, g) in tableGroups" :key="g" class="nav-group">
            <div class="nav-group-title">
              <Icon :name="g === 'table' ? 'box' : 'layers'" :size="12" />
              <span>{{ g === "table" ? "表" : "视图" }}</span>
              <span class="nav-group-cnt">{{ group.length }}</span>
            </div>
            <div class="meta-tree">
              <div v-for="t in group" :key="t.name" class="tree-item" @contextmenu.prevent="onTreeCtx($event, t)">
                <div class="tree-row">
                  <span class="tree-caret" title="展开列结构" @click="toggleTable(t)">
                    <Icon :name="expanded[t.name] ? 'chevron' : 'chevron-right'" :size="12" />
                  </span>
                  <span class="tree-name" :title="`单击：填充 SELECT 并展开字段；双击：打开表数据`" @click="onTreeNameClick(t)" @dblclick="quickQuery(t)">{{ t.name }}</span>
                  <span class="tree-actions">
                    <button class="tree-action" title="查看索引" aria-label="查看索引" @click.stop="openDetail(t, 'indexes')"><Icon name="layers" :size="12" /></button>
                    <button class="tree-action" title="查看 DDL" aria-label="查看 DDL" @click.stop="openDetail(t, 'ddl')"><Icon name="note" :size="12" /></button>
                  </span>
                  <span class="tree-kind" :class="t.kind">{{ t.kind === "view" ? "视图" : "表" }}</span>
                </div>
                <div v-if="expanded[t.name]" class="tree-cols">
                  <div v-if="loadingCols[t.name]" class="meta-tip">加载列…</div>
                  <template v-else>
                    <div
                      v-for="c in meta.columns[t.name] || []"
                      :key="c.name"
                      class="tree-col"
                      :title="`双击插入列名 ${quoteIdent(c.name, activeConn?.type)}`"
                      @dblclick="insertColumn(c.name)"
                      @contextmenu.prevent="onColCtx($event, t, c)"
                    >
                      <span class="col-pk" :class="{ on: c.pk }" title="主键">PK</span>
                      <span class="col-name">{{ c.name }}</span>
                      <span class="col-type" :title="c.type">{{ c.type }}</span>
                      <span v-if="c.comment" class="col-comment" :title="c.comment">{{ c.comment }}</span>
                    </div>
                    <p v-if="!(meta.columns[t.name] || []).length" class="meta-tip">无列信息</p>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.meta-pane { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; border-top: 1px solid var(--border); padding-top: 12px; }
/* Navicat 式分组：表 / 视图，分组标题 + 计数胶囊 */
.nav-group { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.nav-group-title { display: flex; align-items: center; gap: 5px; padding: 2px 6px; font-size: var(--fs-xs); font-weight: 700; color: var(--muted); letter-spacing: 0.3px; user-select: none; }
.nav-group-title .icon { color: var(--faint); }
.nav-group-cnt { margin-left: auto; padding: 0 7px; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); background: var(--well); border-radius: var(--r-pill); line-height: 1.6; }
.meta-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-width: auto; scrollbar-color: var(--border-strong) transparent; }
.meta-scroll::-webkit-scrollbar { width: 10px; }
.meta-scroll::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: var(--r-pill); border: 2px solid var(--card); }
.meta-scroll::-webkit-scrollbar-track { background: var(--card-soft); }
.meta-tree { display: flex; flex-direction: column; gap: 1px; min-height: 0; }
.tree-item { border-radius: var(--r-xs); transition: background 0.15s; }
.tree-item:hover { background: var(--well); }
.tree-row { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: var(--r-xs); transition: background 0.15s; }
.tree-row:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
/* 表名过滤框（与全局 search-mini 同语言） */
.table-filter { width: 100%; padding: 6px 10px; margin-bottom: 4px; border: 1px solid transparent; border-radius: var(--r-sm); font-size: var(--fs-sm); font-family: inherit; background: color-mix(in srgb, var(--text-weak) 9%, transparent); color: var(--text); outline: none; transition: background 0.15s, border-color 0.15s; box-sizing: border-box; }
.table-filter::placeholder { color: var(--muted); }
.table-filter:focus { background: var(--card); border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.tree-caret { display: grid; place-items: center; width: 16px; height: 16px; flex-shrink: 0; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; transition: all 0.15s; }
.tree-caret:hover { color: var(--primary); background: var(--primary-soft); }
.tree-name { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.tree-name:hover { color: var(--primary); }
.tree-actions { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
.tree-action { width: 22px; height: 22px; padding: 0; display: grid; place-items: center; border: 1px solid transparent; border-radius: var(--r-xs); background: transparent; color: var(--muted); cursor: pointer; opacity: 0.72; transition: all 0.15s; }
.tree-action:hover { color: var(--primary); background: var(--primary-soft); border-color: var(--border-blue); opacity: 1; }
/* 类型徽标：表 = teal 胶囊，视图 = 紫胶囊 */
.tree-kind { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 600; padding: 0 7px; border-radius: var(--r-pill); background: var(--teal-soft); color: var(--teal-deep); line-height: 1.7; }
.tree-kind.view { background: var(--accent-soft); color: var(--accent-deep); }
.tree-cols { display: flex; flex-direction: column; gap: 1px; margin: 2px 0 6px 18px; padding-left: 8px; border-left: 1px solid var(--border); }
.tree-col { display: flex; align-items: center; gap: 6px; padding: 2px 6px; border-radius: var(--r-xs); font-family: var(--font-mono); font-size: var(--fs-xs); cursor: copy; transition: background 0.15s; }
.tree-col:hover { background: var(--primary-soft); }
.col-pk { flex-shrink: 0; font-size: var(--fs-xs); line-height: 1.5; padding: 0 4px; border-radius: 3px; color: transparent; border: 1px solid transparent; }
.col-pk.on { color: var(--warn); border-color: color-mix(in srgb, var(--amber) 40%, transparent); background: rgba(217, 119, 6, 0.08); }
.col-name { flex-shrink: 0; color: var(--text); white-space: nowrap; }
.col-type { flex: 1; min-width: 0; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-comment { flex-shrink: 0; max-width: 70px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.75; }
.meta-tip { padding: 2px 6px; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }
.meta-tip.err { color: var(--danger); }

.pane-head { display: flex; align-items: center; justify-content: space-between; padding: 0 6px; }
.pane-head b { font-size: var(--fs-md); font-weight: 700; }
.pane-ops { display: inline-flex; align-items: center; gap: 6px; }
.mini-btn { display: inline-flex; align-items: center; gap: 3px; padding: 4px 8px; font-size: var(--fs-sm); border: 1px solid var(--border-strong); background: var(--card); color: var(--muted); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.mini-btn:hover { color: var(--primary); border-color: var(--primary); }
/* 纯图标按钮：padding 0 + grid 居中，避免 UA 默认 padding 偏移 */
.mini-btn.icon { width: 26px; height: 26px; padding: 0; display: grid; place-items: center; }
</style>
