<script setup>
// 集合树侧栏（RequestTool 拆出）：纯展示 + 交互委托给父组件
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";

const { t } = useI18n();

const props = defineProps({
  collections: { type: Array, default: () => [] },
  tabSavedId: { type: String, default: "" },
  totalRequests: { type: Number, default: 0 },
  methodClass: { type: Function, required: true },
});
const emit = defineEmits(["new-collection", "toggle-coll", "save-dialog", "remove-collection", "load-request", "remove-request"]);
</script>

<template>
  <aside class="col-collection">
    <button class="new-btn" @click="emit('new-collection')"><Icon name="plus" :size="15" />{{ t("toolbox.request.newCollection") }}</button>
    <div class="cl-head">
      <span>{{ t("toolbox.request.collections") }}</span>
      <span class="cl-count">{{ t("toolbox.request.collCount", { groups: collections.length, requests: totalRequests }) }}</span>
    </div>
    <div v-if="collections.length" class="cl-list">
      <div v-for="c in collections" :key="c.id" class="cl-group">
        <div class="cl-gh" @click="emit('toggle-coll', c)">
          <Icon name="chevron" :size="13" class="cl-caret" :class="{ open: c.open }" />
          <Icon name="folder" :size="14" class="cl-folder" />
          <span class="cl-gname">{{ c.name }}</span>
          <span class="cl-gcount">{{ c.requests.length }}</span>
          <button class="cl-mini" :title="t('toolbox.request.saveToThisColl')" @click.stop="emit('save-dialog', c.id)"><Icon name="plus" :size="12" /></button>
          <button class="cl-mini cl-del" :title="t('toolbox.request.deleteColl')" @click.stop="emit('remove-collection', c)"><Icon name="trash" :size="12" /></button>
        </div>
        <div v-if="c.open" class="cl-reqs">
          <div
            v-for="r in c.requests"
            :key="r.id"
            class="cl-item"
            :class="{ on: tabSavedId === r.id }"
            @click="emit('load-request', r)"
          >
            <span class="mtag" :class="methodClass(r.method)">{{ r.method }}</span>
            <span class="cl-name">{{ r.name }}</span>
            <button class="cl-mini cl-del" :title="t('toolbox.request.delete')" @click.stop="emit('remove-request', c, r)"><Icon name="trash" :size="12" /></button>
          </div>
          <p v-if="!c.requests.length" class="cl-sub-empty">{{ t("toolbox.request.collEmptySub") }}</p>
        </div>
      </div>
    </div>
    <p v-else class="cl-empty">{{ t("toolbox.request.collEmpty") }}</p>
  </aside>
</template>

<style scoped>
/* 通用小标签：方法着色 */
.mtag { flex-shrink: 0; padding: 1px 6px; font-size: var(--fs-xs); font-weight: 700; font-family: var(--font-mono); border-radius: var(--r-xs); }
.m-get { color: var(--success); background: var(--success-tint); }
.m-post { color: var(--warn); background: var(--warn-tint); }
.m-put { color: var(--primary); background: var(--primary-soft); }
.m-patch { color: var(--accent-deep); background: var(--accent-soft); }
.m-delete { color: var(--danger); background: var(--danger-soft); }
.m-head, .m-options { color: var(--muted); background: color-mix(in srgb, var(--text) 6%, transparent); }

/* 集合树 */
.col-collection { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 12px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); overflow: hidden; }
.new-btn { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px; font-size: var(--fs-md); font-weight: 600; color: var(--text-invert); background: var(--accent); border: none; border-radius: var(--r-sm); cursor: pointer; transition: filter 0.15s; }
.new-btn:hover { filter: brightness(1.08); }
.cl-head { display: flex; align-items: baseline; justify-content: space-between; font-size: var(--fs-sm); font-weight: 700; color: var(--text); }
.cl-count { font-size: var(--fs-xs); font-weight: 400; color: var(--muted); }
.cl-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.cl-group { display: flex; flex-direction: column; }
.cl-gh { display: flex; align-items: center; gap: 5px; padding: 6px 6px; border-radius: var(--r-sm); cursor: pointer; transition: background 0.15s; }
.cl-gh:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
.cl-caret { color: var(--muted); transform: rotate(-90deg); transition: transform 0.15s; }
.cl-caret.open { transform: rotate(0deg); }
.cl-folder { color: var(--accent); flex-shrink: 0; }
.cl-gname { flex: 1; min-width: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cl-gcount { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); }
.cl-mini { flex-shrink: 0; display: none; padding: 2px; border: none; background: transparent; color: var(--muted); cursor: pointer; border-radius: var(--r-xs); }
.cl-gh:hover .cl-mini, .cl-item:hover .cl-mini { display: inline-flex; }
.cl-mini:hover { color: var(--accent-deep); background: var(--accent-soft); }
.cl-del:hover { color: var(--danger); background: var(--danger-soft); }
.cl-reqs { display: flex; flex-direction: column; gap: 1px; padding-left: 14px; }
.cl-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: var(--r-sm); cursor: pointer; transition: background 0.15s; }
.cl-item:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
.cl-item.on { background: var(--accent-soft); }
.cl-name { flex: 1; min-width: 0; font-size: var(--fs-sm); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cl-sub-empty { margin: 2px 0 4px 4px; font-size: var(--fs-xs); color: var(--muted); }
.cl-empty { margin: 0; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }
</style>
