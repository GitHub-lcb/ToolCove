<script setup>
// 数据库连接编辑弹窗（DbTool 拆出）：表单数据由父组件持有，嵌套字段直接双向绑定
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import { DB_TYPES } from "../db.js";

const { t } = useI18n();

const props = defineProps({
  editing: { type: Object, required: true },
  editingNew: { type: Boolean, default: false },
  oracleDrivers: { type: Array, default: () => [] },
  driverUrl: { type: String, default: "" },
  driverSha256: { type: String, default: "" },
  installingDriver: { type: Boolean, default: false },
});
const emit = defineEmits([
  "update:driverUrl", "update:driverSha256",
  "pick-file", "refresh-drivers", "install-driver", "cancel", "test", "save",
]);

const typeMeta = (t) => DB_TYPES.find((x) => x.type === t) || DB_TYPES[0];
</script>

<template>
  <div class="modal-mask">
    <div class="modal db-conn-modal">
      <h2>{{ editingNew ? t("toolbox.db.connNew") : t("toolbox.db.connEdit") }}</h2>
      <label class="fld">
        <span>{{ t("toolbox.db.type") }}</span>
        <select v-model="editing.type">
          <option v-for="t in DB_TYPES" :key="t.type" :value="t.type">{{ t('toolbox.db.' + t.labelKey) }}</option>
        </select>
      </label>
      <label class="fld">
        <span>{{ t("toolbox.db.connName") }}</span>
        <input v-model="editing.name" placeholder="" :placeholder="t('toolbox.db.connNamePh')" />
      </label>
      <template v-if="editing.type === 'sqlite'">
        <label class="fld">
          <span>{{ t("toolbox.db.dbFile") }}</span>
          <div class="fld-row">
            <input v-model="editing.database" placeholder="" :placeholder="t('toolbox.db.dbFilePh')" />
            <button class="mini-btn" @click="emit('pick-file')">{{ t("toolbox.db.pick") }}</button>
          </div>
        </label>
      </template>
      <template v-else>
        <div class="fld-2">
          <label class="fld">
            <span>{{ t("toolbox.db.host") }}</span>
            <input v-model="editing.host" placeholder="localhost" />
          </label>
          <label class="fld w60">
            <span>{{ t("toolbox.db.port") }}</span>
            <input v-model.number="editing.port" type="number" />
          </label>
        </div>
        <div class="fld-2">
          <label class="fld">
            <span>{{ t("toolbox.db.user") }}</span>
            <input v-model="editing.user" placeholder="root" />
          </label>
          <label class="fld">
            <span>{{ t("toolbox.db.password") }}</span>
            <input v-model="editing.password" type="password" placeholder="••••••" />
          </label>
        </div>
        <label class="fld">
          <span>{{ t('toolbox.db.' + typeMeta(editing.type).dbLabelKey) }}</span>
          <input v-model="editing.database" placeholder="" :placeholder="t('toolbox.db.dbNamePh')" />
        </label>
        <template v-if="editing.type === 'oracle'">
          <label class="fld">
            <span>{{ t("toolbox.db.serviceName") }}</span>
            <input v-model="editing.oracleService" placeholder="" :placeholder="t('toolbox.db.serviceNamePh')" />
          </label>
          <label class="fld">
            <span>{{ t("toolbox.db.odbcDriver") }}</span>
            <div class="fld-row">
              <select v-model="editing.oracleDriver" :disabled="!oracleDrivers.length">
                <option value="">{{ t("toolbox.db.selectDriver") }}</option>
                <option v-for="d in oracleDrivers" :key="d" :value="d">{{ d }}</option>
              </select>
              <button class="mini-btn" @click="emit('refresh-drivers')">{{ t("toolbox.db.refresh") }}</button>
            </div>
          </label>
          <p v-if="oracleDrivers.length" class="form-tip">{{ t("toolbox.db.oracleDriverTip") }}</p>
          <div v-else class="driver-install">
            <p class="form-tip danger">{{ t("toolbox.db.noDriverTip") }}</p>
            <div class="fld-row">
              <input :value="driverUrl" placeholder="" :placeholder="t('toolbox.db.driverUrlPh')" @input="emit('update:driverUrl', $event.target.value)" />
              <button class="mini-btn" :disabled="installingDriver || !driverUrl.trim() || !driverSha256.trim()" @click="emit('install-driver')">{{ installingDriver ? t("toolbox.db.installing") : t("toolbox.db.installOneClick") }}</button>
            </div>
            <label class="fld">
              <span>{{ t("toolbox.db.sha256") }}</span>
              <input :value="driverSha256" placeholder="" :placeholder="t('toolbox.db.sha256Ph')" spellcheck="false" @input="emit('update:driverSha256', $event.target.value)" />
            </label>
            <p class="form-tip">{{ t("toolbox.db.driverPathTip") }}</p>
          </div>
        </template>
        <label class="fld check">
          <input v-model="editing.rememberPwd" type="checkbox" />
          <span>{{ t("toolbox.db.rememberPwd") }}</span>
        </label>
      </template>
      <div class="modal-foot">
        <button class="btn ghost" @click="emit('cancel')">{{ t("toolbox.db.cancel") }}</button>
        <button class="btn solid" @click="emit('test')">{{ t("toolbox.db.testConn") }}</button>
        <button class="btn primary" @click="emit('save')">{{ t("toolbox.db.save") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.db-conn-modal { width: 560px; }
.db-conn-modal .fld { margin-bottom: 12px; }
.fld { display: flex; flex-direction: column; gap: 4px; }
.fld > span { font-size: var(--fs-xs); color: var(--muted); }
.fld input, .fld select { width: 100%; padding: 6px 9px; font-size: var(--fs-md); border: 1px solid var(--border-strong); background: var(--card); color: var(--text); border-radius: var(--r-sm); outline: none; transition: border-color 0.15s; }
.fld input:focus, .fld select:focus { border-color: var(--primary); }
.fld-row { display: flex; gap: 6px; }
.fld-row input { flex: 1; min-width: 0; }
.fld-2 { display: flex; gap: 8px; }
.fld-2 .fld { flex: 1; min-width: 0; }
.fld-2 .w60 { flex: 0 0 88px; }
.fld.check { flex-direction: row; align-items: center; gap: 6px; }
.fld.check span { font-size: var(--fs-sm); color: var(--text); }
.form-tip { margin: 0; font-size: var(--fs-xs); color: var(--warn); line-height: var(--lh-body); }
.form-tip.danger { color: var(--danger); }
.driver-install { display: flex; flex-direction: column; gap: 6px; }

.mini-btn { display: inline-flex; align-items: center; gap: 3px; padding: 4px 8px; font-size: var(--fs-sm); border: 1px solid var(--border-strong); background: var(--card); color: var(--muted); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.mini-btn:hover { color: var(--primary); border-color: var(--primary); }

.btn { display: inline-flex; align-items: center; gap: 5px; padding: 7px 14px; font-size: var(--fs-md); font-weight: 600; border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; border: 1px solid transparent; }
.btn.primary { background: var(--primary); color: var(--text-invert); }
.btn.primary:hover:not(:disabled) { background: var(--primary-hover); }
.btn.primary:disabled { opacity: 0.55; cursor: default; }
.btn.solid { background: var(--card); color: var(--text); border-color: var(--border-strong); }
.btn.solid:hover { border-color: var(--primary); color: var(--primary); }
.btn.ghost { background: transparent; color: var(--muted); }
.btn.ghost:hover { color: var(--primary); background: var(--primary-soft); }
</style>
