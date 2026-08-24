<script setup>
// 环境变量管理弹窗（RequestTool 拆出）：变量键值直接绑定父组件数据，持久化经事件委托
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";

const { t } = useI18n();

const props = defineProps({
  envs: { type: Array, default: () => [] },
  activeEnvId: { type: String, default: "" },
  varNameSyntax: { type: String, default: "" },
});
const emit = defineEmits(["close", "add", "use", "remove", "remove-var", "var-edit", "persist"]);
</script>

<template>
  <div class="env-mask" @click.self="emit('close')">
    <div class="env-box">
      <div class="env-head">
        <b>{{ t("toolbox.request.envTitle") }}</b>
        <span class="env-hint">{{ t("toolbox.request.envHint", { syntax: varNameSyntax }) }}</span>
        <span class="spacer"></span>
        <button class="env-add" @click="emit('add')"><Icon name="plus" :size="14" />{{ t("toolbox.request.addEnv") }}</button>
        <button class="env-close" @click="emit('close')"><Icon name="x" :size="16" /></button>
      </div>
      <div v-if="envs.length" class="env-body">
        <div v-for="en in envs" :key="en.id" class="env-card" :class="{ active: activeEnvId === en.id }">
          <div class="env-card-head">
            <input v-model="en.name" class="env-name" spellcheck="false" @input="emit('persist')" />
            <button class="env-use" :class="{ on: activeEnvId === en.id }" @click="emit('use', en)">{{ t(activeEnvId === en.id ? "toolbox.request.inUse" : "toolbox.request.enable") }}</button>
            <button class="env-remove" :title="t('toolbox.request.deleteEnv')" @click="emit('remove', en)"><Icon name="trash" :size="13" /></button>
          </div>
          <table class="kv">
            <thead><tr><th class="th-ck"></th><th>{{ t("toolbox.request.varName") }}</th><th>{{ t("toolbox.request.value") }}</th><th class="th-op"></th></tr></thead>
            <tbody>
              <tr v-for="(v, i) in en.vars" :key="'v' + i">
                <td class="td-ck"><input v-model="v.on" type="checkbox" @change="emit('persist')" /></td>
                <td><input v-model="v.key" class="cell" spellcheck="false" :placeholder="t('toolbox.request.varKeyPlaceholder')" @input="emit('var-edit', en)" /></td>
                <td><input v-model="v.value" class="cell" spellcheck="false" :placeholder="t('toolbox.request.varValuePlaceholder')" @input="emit('var-edit', en)" /></td>
                <td class="td-op"><button v-if="i < en.vars.length - 1" class="row-del" @click="emit('remove-var', en, i)"><Icon name="x" :size="13" /></button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p v-else class="env-empty">{{ t("toolbox.request.envEmpty") }}</p>
    </div>
  </div>
</template>

<style scoped>
.spacer { flex: 1; }

.env-mask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(17, 24, 39, 0.4); }
.env-box { width: 640px; max-width: calc(100vw - 48px); max-height: calc(100vh - 96px); display: flex; flex-direction: column; padding: 20px; background: var(--card); border-radius: var(--r-lg); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25); }
.env-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.env-head b { font-size: var(--fs-base); font-weight: 700; }
.env-hint { font-size: var(--fs-xs); color: var(--muted); }
.env-hint code { padding: 1px 5px; font-family: var(--font-mono); color: var(--accent-deep); background: var(--accent-soft); border-radius: var(--r-xs); }
.env-add { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; font-size: var(--fs-sm); color: var(--text-invert); background: var(--accent); border: none; border-radius: var(--r-sm); cursor: pointer; }
.env-add:hover { filter: brightness(1.08); }
.env-close { padding: 5px; border: none; background: transparent; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; }
.env-close:hover { color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
.env-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.env-card { border: 1px solid var(--card-border); border-radius: var(--r-md); overflow: hidden; }
.env-card.active { border-color: var(--accent-border); box-shadow: 0 0 0 2px var(--accent-soft); }
.env-card-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: color-mix(in srgb, var(--text) 3%, transparent); border-bottom: 1px solid var(--card-border); }
.env-name { flex: 1; min-width: 0; padding: 5px 8px; font-size: var(--fs-md); font-weight: 600; border: 1px solid transparent; background: transparent; color: var(--text); border-radius: var(--r-sm); outline: none; }
.env-name:hover { border-color: var(--card-border); }
.env-name:focus { border-color: var(--primary); background: var(--card); }
.env-use { flex-shrink: 0; padding: 5px 12px; font-size: var(--fs-sm); color: var(--muted); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); cursor: pointer; }
.env-use.on { color: var(--text-invert); background: var(--success); border-color: var(--success); font-weight: 600; }
.env-remove { flex-shrink: 0; padding: 5px; border: none; background: transparent; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; }
.env-remove:hover { color: var(--danger); background: var(--danger-soft); }
.env-empty { margin: 0; padding: 24px 8px; font-size: var(--fs-sm); color: var(--muted); text-align: center; line-height: var(--lh-body); }

/* 键值表 */
.kv { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.kv thead th { position: sticky; top: 0; padding: 8px 10px; text-align: left; font-weight: 600; color: var(--muted); background: color-mix(in srgb, var(--text) 3%, transparent); border-bottom: 1px solid var(--card-border); }
.kv th.th-ck, .kv td.td-ck { width: 34px; text-align: center; }
.kv th.th-op, .kv td.td-op { width: 36px; text-align: center; }
.kv td { padding: 2px 6px; border-bottom: 1px solid color-mix(in srgb, var(--text) 5%, transparent); }
.cell { width: 100%; padding: 6px 4px; font-size: var(--fs-sm); font-family: var(--font-mono); border: none; background: transparent; color: var(--text); outline: none; }
.cell:focus { background: var(--accent-soft); border-radius: var(--r-xs); }
.row-del { padding: 3px; border: none; background: transparent; color: var(--muted); cursor: pointer; border-radius: var(--r-xs); }
.row-del:hover { color: var(--danger); background: var(--danger-soft); }
</style>
