<script setup>
// 设置页（UI 2.0 工作台式）：左侧分类导航 + 右侧内容区，替代原设置弹窗。
// 分类：AI 模型 / 系统设置；保存后 dispatch settings-saved 供全局刷新。
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "./platform/invoke.js";
import { capabilities } from "./platform/env.js";
import { open as openDialog, save as saveDialog } from "./platform/dialog.js";
import { relaunch } from "./platform/shell.js";
import { openUrl } from "./platform/shell.js";
import Icon from "./Icon.vue";
import { testAI, AI_PRESETS } from "./ai.js";
import { checkForUpdate } from "./updater.js";
import { encryptValue, decryptValue } from "./secure.js";
import { ACCENT_PRESETS, saveAccentKey, loadAccentKey } from "./accentTheme.js";
import { getConfig as telemetryGetConfig, consent as telemetryConsent } from "./telemetry.js";
import { createSyncCollection, joinSyncCollectionFull, syncNowManual, listDevices, revokeDevice, regeneratePairingCode, getSyncSnapshot, setSyncEnabled, setSyncDeviceName, getEngine } from "./sync/index.js";
import { askConfirm } from "./confirm.js";
import { flushToolbox } from "./toolboxStore.js";
import { flushSecureToolbox } from "./secureToolbox.js";
import { cloneJsonData } from "./jsonData.js";
import { normalizeHiddenModules, mergeSettingsSnapshot } from "./settingsConfig.js";
import { applyLocale } from "./i18n/index.js";
import pkg from "../package.json";

const { t } = useI18n();

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  section: { type: String, default: "general" }, // 侧边栏系统管理入口定位的分类
});

const SECTIONS = [
  { key: "ai", labelKey: "settings.navAi", icon: "sparkles", descKey: "settings.navAiDesc" },
  { key: "sync", labelKey: "settings.navSync", icon: "refresh", descKey: "settings.navSyncDesc" },
  { key: "sponsor", labelKey: "settings.navSponsor", icon: "heart", descKey: "settings.navSponsorDesc" },
  { key: "general", labelKey: "settings.navGeneral", icon: "settings", descKey: "settings.navGeneralDesc" },
];
// 云同步依赖原生代理（服务端未开 CORS 前浏览器直连不可用），浏览器端整节隐藏
const sections = computed(() => SECTIONS.filter((s) => s.key !== "sync" || capabilities.cloudSync));
const section = ref(SECTIONS.some((s) => s.key === props.section) ? props.section : "general");
watch(
  () => props.section,
  (v) => {
    if (SECTIONS.some((s) => s.key === v)) section.value = v;
  }
);
// 兜底显式指向 general（插入 pro 后 SECTIONS[1] 不再等于 general，评审注意项）
const currentMeta = computed(() => sections.value.find((s) => s.key === section.value) || SECTIONS.find((s) => s.key === "general") || SECTIONS[0]);

// 侧边栏模块展示/隐藏选项（与 App.vue 的 MODULES 列表保持一致，十视图）
const NAV_MODULE_OPTIONS = [
  { key: "agent", labelKey: "nav.agent" },
  { key: "home", labelKey: "nav.home" },
  { key: "domain", labelKey: "nav.domain" },
  { key: "iteration", labelKey: "nav.iteration" },
  { key: "requirement", labelKey: "nav.requirement" },
  { key: "problem", labelKey: "nav.problem" },
  { key: "release", labelKey: "nav.release" },
  { key: "snippet", labelKey: "nav.snippet" },
  { key: "task", labelKey: "nav.task" },
  { key: "toolbox", labelKey: "nav.toolbox" },
];
function isNavModuleVisible(key) {
  return !form.value.ui.hiddenModules.includes(key);
}
function toggleNavModule(key, visible) {
  const hidden = new Set(form.value.ui.hiddenModules);
  if (visible) hidden.delete(key);
  else hidden.add(key);
  // 按 NAV_MODULE_OPTIONS 固定顺序回写，列表稳定
  form.value.ui.hiddenModules = NAV_MODULE_OPTIONS.map((m) => m.key).filter((k) => hidden.has(k));
}

const saving = ref(false);
const dirty = ref(false);
const testingAI = ref(false);
const showKey = ref(false);
const fieldErr = ref({});
const form = ref(newSettings());
const settingsLoadError = ref("");
// 开机启动是系统状态不是应用数据：进入页面时读真实状态，保存时写回，不落 settings.json
const autostartOn = ref(false);
// 磁盘上的完整 settings 快照。表单只渲染 ai/ui，保存时以它为基底合并，
// 否则 sync/telemetry 等未渲染分组会被表单快照整体覆盖掉。
let rawSnapshot = {};
// ---------- 遥测隐私开关（即改即存，不走表单保存路径） ----------
const telemetryOn = ref(false);
async function loadTelemetryPref() {
  const cfg = await telemetryGetConfig().catch(() => ({ enabled: false }));
  telemetryOn.value = !!cfg.enabled;
}
async function toggleTelemetry(ev) {
  const next = !!ev.target.checked;
  telemetryOn.value = next;
  await telemetryConsent(next).catch(() => {});
  props.showToast(next ? t("telemetry.onMsg") : t("telemetry.offMsg"));
}
// ---------- 云同步 ----------
const syncCfg = ref(null); // normalizeSync 后的快照
const syncStatus = ref("disabled");
const syncBusy = ref(false);
const syncErrKey = ref("");
const syncCodeInput = ref("");
const syncPassword = ref("");
const syncJoinId = ref("");
const syncDevices = ref([]);
const pairingResult = ref({ code: "", expiresAt: 0 });
const syncField = ref(""); // paint
const showSyncPassword = ref(false);
async function refreshSync() {
  try {
    syncCfg.value = await getSyncSnapshot();
    syncStatus.value = syncCfg.value.status || "idle";
    const e = await getEngine().catch(() => null);
    if (e && syncCfg.value.enabled && syncCfg.value.tokenCipher) {
      try { syncDevices.value = await listDevices(); } catch { /* 未就绪 */ }
    }
  } catch { /* 设置页仍可用 */ }
}
async function toggleSync(ev) {
  const next = !!ev.target.checked;
  try {
    await setSyncEnabled(next);
    await refreshSync();
  } catch (e) {
    props.showToast(String(e));
  }
}
async function doCreateSync() {
  syncBusy.value = true;
  syncErrKey.value = "";
  try {
    if (syncPassword.value.length < 8) {
      syncErrKey.value = "sync.errShortPw";
      return;
    }
    const r = await createSyncCollection(syncField.value, syncPassword.value);
    pairingResult.value = { code: r.pairingCode, expiresAt: r.expiresAt };
    await refreshSync();
    syncBusy.value = false;
    props.showToast(t("sync.created"));
  } catch (e) {
    syncErrKey.value = String(e && e.message || e);
    syncBusy.value = false;
  }
}
async function doJoinSync() {
  syncBusy.value = true;
  syncErrKey.value = "";
  try {
    if (syncPassword.value.length < 8) { syncErrKey.value = "sync.errShortPw"; return; }
    await joinSyncCollectionFull(syncField.value, syncJoinId.value.trim(), syncCodeInput.value.trim(), syncPassword.value);
    await refreshSync();
    syncBusy.value = false;
    props.showToast(t("sync.joined"));
  } catch (e) {
    syncErrKey.value = String(e && e.message || e);
    syncBusy.value = false;
  }
}
async function doSyncNow() {
  syncBusy.value = true;
  try {
    const e = await getEngine();
    const st = await e.syncNow();
    await refreshSync();
    props.showToast(t("sync.syncNowOk", { pushed: st.pushed || 0, pulled: st.pulled || 0 }));
  } catch (e) {
    syncErrKey.value = String(e && e.message || e);
  } finally {
    syncBusy.value = false;
  }
}
async function doRegenCode() {
  try {
    const r = await regeneratePairingCode();
    pairingResult.value = { code: r.pairingCode, expiresAt: r.expiresAt };
  } catch (e) {
    syncErrKey.value = String(e && e.message || e);
  }
}
async function doRevoke(hash, self) {
  const ok = await askConfirm({
    title: t("sync.revokeTitle"),
    message: self ? t("sync.revokeSelfMsg") : t("sync.revokeMsg"),
    okText: t("sync.revokeBtn"),
  });
  if (!ok) return;
  try {
    await revokeDevice(hash, self);
    await refreshSync();
  } catch (e) {
    syncErrKey.value = String(e && e.message || e);
  }
}
function statusKey(st) {
  const map = { disabled: "sync.statusDisabled", idle: "sync.statusIdle", syncing: "sync.statusSyncing", error: "sync.statusError", revoked: "sync.statusRevoked" };
  return map[st] || "sync.statusIdle";
}
function fmtSyncTime(ts) {
  return new Date(Number(ts)).toLocaleString();
}
async function copyPairing() {
  try {
    await navigator.clipboard.writeText(pairingResult.value.code);
  } catch { /* 选中即复制，手抄兜底 */ }
}
function registerSyncRefresh() {
  window.addEventListener("sync-status", refreshSyncListener);
}
function refreshSyncListener() {
  refreshSync();
}
// 打开设置页时刷新 + 订阅状态（遥测与云同步都是桌面端专属，浏览器端跳过）
onMounted(async () => {
  loadSettings();
  if (capabilities.telemetryUpload) loadTelemetryPref();
  if (!capabilities.cloudSync) return;
  await refreshSync();
  registerSyncRefresh();
});
// 支持与链接 ----------
function openAfdian() {
  openUrl("https://afdian.com/a/toolcove").catch((e) => props.showToast(String(e)));
}
function openRepo() {
  openUrl("https://github.com/GitHub-lcb/ToolCove").catch((e) => props.showToast(String(e)));
}
// ---------- 自定义主题色 ----------
const accentKey = ref(loadAccentKey() || "");
async function pickAccent(key) {
  saveAccentKey(key || "");
  accentKey.value = key || "";
  window.dispatchEvent(new CustomEvent("accent-changed"));
  props.showToast(key ? t("settings.accentApplied") : t("settings.accentReset"));
}

function validate() {
  const err = {};
  if (form.value.ai.enabled) {
    if (!(form.value.ai.baseUrl || "").trim()) err.aiBase = t("settings.errAiBase");
    if (!(form.value.ai.apiKey || "").trim()) err.aiKey = t("settings.errAiKey");
    if (!(form.value.ai.model || "").trim()) err.aiModel = t("settings.errAiModel");
  }
  if (!NAV_MODULE_OPTIONS.some((m) => !form.value.ui.hiddenModules.includes(m.key)))
    err.navModules = t("settings.errNavModules");
  return err;
}

function newSettings() {
  return {
    ai: { baseUrl: "", apiKey: "", model: "", temperature: 0.7, reasoningEffort: "", enabled: false },
    ui: { density: "compact", hiddenModules: [], locale: "system" },
  };
}

const LOCALE_PREFS = ["system", "zh-CN", "en-US"];

// 进入设置页加载真实配置（解密敏感字段）；改动即标记未保存
async function loadSettings() {
  settingsLoadError.value = "";
  try {
    const s = (await invoke("load_data", { key: "settings" })) || {};
    // load_data 对缺失文件返回 []，只接受真正的对象作为合并基底
    rawSnapshot = s && typeof s === "object" && !Array.isArray(s) ? s : {};
    form.value = {
      ai: {
        baseUrl: s.ai?.baseUrl || "",
        apiKey: await decryptValue(s.ai?.apiKey || ""),
        model: s.ai?.model || "",
        temperature: typeof s.ai?.temperature === "number" ? s.ai.temperature : 0.7,
        reasoningEffort: s.ai?.reasoningEffort || "",
        enabled: !!s.ai?.enabled,
      },
      ui: {
        density: s.ui?.density === "comfort" ? "comfort" : "compact",
        hiddenModules: normalizeHiddenModules(NAV_MODULE_OPTIONS.map((m) => m.key), s.ui?.hiddenModules),
        locale: LOCALE_PREFS.includes(s.ui?.locale) ? s.ui.locale : "system",
      },
    };
  } catch (e) {
    form.value = newSettings();
    settingsLoadError.value = e && e.message ? e.message : String(e);
    props.showToast(t("settings.loadFailed", { err: settingsLoadError.value }));
  }
  if (capabilities.autostart) {
    try {
      autostartOn.value = !!(await invoke("autostart_status"));
    } catch (e) {
      autostartOn.value = false;
    }
  }
  fieldErr.value = {};
  dirty.value = false;
}
// 任意字段改动标记未保存（排除程序化回填）
watch(
  () => JSON.stringify({ f: form.value, a: autostartOn.value }),
  () => {
    dirty.value = true;
  }
);

async function save() {
  if (settingsLoadError.value) {
    props.showToast(t("settings.saveBlocked"));
    return;
  }
  fieldErr.value = validate();
  if (Object.keys(fieldErr.value).length) {
    props.showToast(t("settings.fixRequired", { err: Object.values(fieldErr.value)[0] }));
    return;
  }
  saving.value = true;
  try {
    // 在独立副本里加密，失败时不污染表单中的明文草稿。
    const formCopy = cloneJsonData(form.value);
    formCopy.ai.apiKey = await encryptValue(formCopy.ai.apiKey);
    // 重读磁盘作为合并基底：本页的云同步与遥测开关是即改即存、不经表单的，
    // 进页面时缓存的快照此时已过期，直接写会抹掉用户刚开启的配置。
    let base = rawSnapshot;
    try {
      const disk = await invoke("load_data", { key: "settings" });
      if (disk && typeof disk === "object" && !Array.isArray(disk)) base = disk;
    } catch (e) {
      // 重读失败退回进页面时的快照，仍比只写表单分组安全
    }
    const payload = mergeSettingsSnapshot(cloneJsonData(base), formCopy);
    await invoke("save_data", { key: "settings", data: payload });
    rawSnapshot = payload;
    try {
      if (capabilities.autostart) await invoke("autostart_set", { enabled: autostartOn.value });
    } catch (e) {}
    window.dispatchEvent(new CustomEvent("settings-saved"));
    applyLocale(form.value.ui.locale); // 界面语言即时生效，无需重启
    dirty.value = false;
    props.showToast(t("settings.saved"));
  } catch (e) {
    props.showToast(t("settings.saveFailed", { err: e }));
  } finally {
    saving.value = false;
  }
}

function applyAIPreset(p) {
  form.value.ai.baseUrl = p.baseUrl;
  if (!form.value.ai.model) form.value.ai.model = p.model;
  // 本地服务（Ollama）不需要真实密钥，但配置校验要求非空；不覆盖用户已填的值
  if (p.apiKey && !form.value.ai.apiKey) form.value.ai.apiKey = p.apiKey;
}

async function testAIConn() {
  testingAI.value = true;
  try {
    const cfg = {
      baseUrl: (form.value.ai.baseUrl || "").trim().replace(/\/$/, ""),
      apiKey: (form.value.ai.apiKey || "").trim(),
      model: (form.value.ai.model || "").trim(),
      temperature: 0,
      reasoningEffort: (form.value.ai.reasoningEffort || "").trim(),
    };
    const reply = await testAI(cfg);
    props.showToast(t("settings.aiTestOk", { reply }));
  } catch (e) {
    props.showToast(t("settings.aiTestFail", { err: e && e.message ? e.message : e }));
  } finally {
    testingAI.value = false;
  }
}

const appVersion = pkg.version;
const checkingUpdate = ref(false);
async function checkUpdateNow() {
  checkingUpdate.value = true;
  try {
    await checkForUpdate({ silent: false, showToast: props.showToast });
  } finally {
    checkingUpdate.value = false;
  }
}

const backingUp = ref(false);
const restoring = ref(false);
async function backupNow() {
  const p = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  try {
    const dest = await saveDialog({
      title: t("settings.backupDlgTitle"),
      defaultPath: `toolcove-backup-${stamp}.zip`,
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (!dest) return;
    backingUp.value = true;
    const summary = await invoke("backup_data", { dest });
    props.showToast(t("settings.backupDone", { summary }));
  } catch (e) {
    props.showToast(t("settings.backupFailed", { err: e }));
  } finally {
    backingUp.value = false;
  }
}

async function restoreNow() {
  const source = await openDialog({
    multiple: false,
    directory: false,
    title: t("settings.restoreDlgTitle"),
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (typeof source !== "string" || !source) return;
  const ok = await askConfirm({
    title: t("settings.restoreConfirmTitle"),
    message: t("settings.restoreConfirmMsg"),
    okText: t("settings.restoreOk"),
  });
  if (!ok) return;
  restoring.value = true;
  try {
    await flushSecureToolbox();
    await flushToolbox();
    const summary = await invoke("restore_data", { source });
    props.showToast(t("settings.restoreDone", { summary }), { duration: 5000 });
    await relaunch();
  } catch (e) {
    props.showToast(t("settings.restoreFailed", { err: e }), { duration: 5000 });
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <div class="settings-view">
    <!-- 左侧分类导航（Qoder Work 式设置页） -->
    <aside class="sv-side">
      <div class="sv-title">{{ t("nav.settings") }}</div>
      <button
        v-for="s in sections"
        :key="s.key"
        class="sv-nav"
        :class="{ on: section === s.key }"
        :title="t(s.descKey)"
        @click="section = s.key"
      >
        <Icon :name="s.icon" :size="17" />
        <span class="sv-nav-label">{{ t(s.labelKey) }}</span>
      </button>
      <div class="sv-foot">
        <span class="ver-tag">v{{ appVersion }}</span>
      </div>
    </aside>

    <!-- 右侧内容区 -->
    <main class="sv-main">
      <div class="sv-bar">
        <div class="sv-bar-txt">
          <b>{{ t(currentMeta.labelKey) }}</b>
          <span class="sv-desc">{{ t(currentMeta.descKey) }}</span>
          <span v-if="dirty" class="sv-dirty">{{ t("settings.dirty") }}</span>
        </div>
        <button class="btn-primary sm" :disabled="saving" @click="save">
          <Icon name="check" :size="14" /> {{ saving ? t("settings.saving") : t("settings.save") }}
        </button>
      </div>

      <div class="sv-body">
        <!-- ============ AI 模型 ============ -->
        <div v-show="section === 'ai'" class="sect">
          <div class="sect-head">
            <span class="sect-title"><Icon name="sparkles" :size="15" class="sect-ico" /> {{ t("settings.aiTitle") }}</span>
            <label class="switch">
              <input type="checkbox" v-model="form.ai.enabled" />
              <span class="track"></span>
              <span>{{ t("settings.aiEnable") }}</span>
            </label>
          </div>
          <p class="sect-desc">{{ t("settings.aiDesc") }}</p>

          <div class="presets">
            <button
              v-for="p in AI_PRESETS"
              :key="p.key"
              type="button"
              class="preset-chip"
              :class="{ on: form.ai.baseUrl === p.baseUrl }"
              @click="applyAIPreset(p)"
            >{{ t(p.labelKey) }}</button>
          </div>

          <label class="field" :class="{ err: fieldErr.aiBase }">
            <span>{{ t("settings.aiBaseUrl") }}</span>
            <input v-model="form.ai.baseUrl" :placeholder="t('settings.aiBaseUrlPh')" />
            <span v-if="fieldErr.aiBase" class="field-err">{{ fieldErr.aiBase }}</span>
          </label>

          <label class="field" :class="{ err: fieldErr.aiModel }">
            <span>{{ t("settings.aiModel") }}</span>
            <input v-model="form.ai.model" :placeholder="t('settings.aiModelPh')" />
            <span v-if="fieldErr.aiModel" class="field-err">{{ fieldErr.aiModel }}</span>
          </label>

          <label class="field" :class="{ err: fieldErr.aiKey }">
            <span>{{ t("settings.aiKey") }}</span>
            <div class="token-row">
              <input
                :type="showKey ? 'text' : 'password'"
                v-model="form.ai.apiKey"
                :placeholder="t('settings.aiKeyPh')"
                autocomplete="off"
              />
              <button type="button" class="btn-ghost sm" @click="showKey = !showKey">
                <Icon :name="showKey ? 'x' : 'open'" :size="14" /> {{ showKey ? t("settings.hide") : t("settings.show") }}
              </button>
            </div>
            <span v-if="fieldErr.aiKey" class="field-err">{{ fieldErr.aiKey }}</span>
          </label>

          <label class="field">
            <span>{{ t("settings.aiReason") }}</span>
            <select v-model="form.ai.reasoningEffort" class="select">
              <option value="">{{ t("settings.aiReasonNone") }}</option>
              <option value="minimal">{{ t("settings.aiReasonFastest") }}</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">{{ t("settings.aiReasonXhigh") }}</option>
            </select>
          </label>

          <label class="field" v-if="!form.ai.reasoningEffort">
            <span>{{ t("settings.aiTemp", { value: Number(form.ai.temperature).toFixed(1) }) }}</span>
            <input type="range" min="0" max="1" step="0.1" v-model.number="form.ai.temperature" class="range" />
          </label>

          <div class="sect-foot">
            <button class="btn-ghost sm" :disabled="testingAI" @click="testAIConn"><Icon name="sparkles" :size="14" /> {{ testingAI ? t("settings.aiTesting") : t("settings.aiTest") }}</button>
          </div>
        </div>
        <!-- ============ 云同步（端到端加密，免费内置） ============ -->
        <div v-if="capabilities.cloudSync" v-show="section === 'sync'" class="sect sync">
          <div class="sect-head">
            <span class="sect-title"><Icon name="refresh" :size="15" class="sect-ico" /> {{ t("sync.title") }}</span>
            <label class="switch">
              <input type="checkbox" :checked="syncCfg && syncCfg.enabled" @change="toggleSync" />
              <span class="track"></span>
              <span>{{ t("sync.enable") }}</span>
            </label>
          </div>
          <p class="sect-desc">{{ t("sync.desc") }}</p>

          <!-- 服务器地址与配对（未入伙时） -->
          <template v-if="!syncCfg || !syncCfg.collectionId">
            <label class="field">
              <span>{{ t("sync.serverUrl") }}</span>
              <input v-model="syncField" :placeholder="t('sync.serverUrlPh')" />
            </label>
            <p v-if="syncField && !syncField.startsWith('https://')" class="field-err">{{ t("sync.serverUrlHttpWarn") }}</p>
            <label class="field">
              <span>{{ t("sync.syncPasswordPh") }} <span class="faint-hint">{{ t("sync.syncPasswordHint") }}</span></span>
              <div class="token-row">
                <input :type="showSyncPassword ? 'text' : 'password'" v-model="syncPassword" :placeholder="t('sync.syncPasswordPh')" autocomplete="new-password" />
                <button type="button" class="btn-ghost sm" @click="showSyncPassword = !showSyncPassword">{{ showSyncPassword ? t("settings.hide") : t("settings.show") }}</button>
              </div>
            </label>
            <div class="sync-actions">
              <button class="btn-primary sm" :disabled="syncBusy" @click="doCreateSync"><Icon name="plus" :size="14" /> {{ t("sync.createBtn") }}</button>
              <span class="sync-or">{{ t("sync.or") }}</span>
              <input v-model="syncJoinId" :placeholder="t('sync.joinIdPh')" class="lic-input sm-input" />
              <input v-model="syncCodeInput" :placeholder="t('sync.joinCodePh')" class="lic-input sm-input" />
              <button class="btn-ghost sm" :disabled="syncBusy" @click="doJoinSync"><Icon name="link" :size="14" /> {{ t("sync.joinBtn") }}</button>
            </div>
            <p v-if="syncErrKey && !syncCfg.collectionId" class="field-err">{{ t(syncErrKey) }}</p>
          </template>

          <!-- 已入伙：状态 + 配对码 + 设备 + 操作 -->
          <template v-else>
            <div class="sync-state" :class="syncStatus">
              <span class="sync-dot"></span>
              <span>{{ t(statusKey(syncStatus)) }}<template v-if="syncCfg.lastSyncAt"> · {{ t("sync.lastSyncAt", { time: fmtSyncTime(syncCfg.lastSyncAt) }) }}</template></span>
            </div>

            <div class="sync-actions">
              <button class="btn-primary sm" :disabled="syncBusy" @click="doSyncNow"><Icon name="refresh" :size="14" /> {{ t("sync.syncNowBtn") }}</button>
              <button class="btn-ghost sm" @click="doRegenCode"><Icon name="repeat" :size="14" /> {{ t("sync.regenCodeBtn") }}</button>
            </div>
            <div v-if="pairingResult.code" class="pairing-box">
              <div class="pairing-code" @click="copyPairing">{{ pairingResult.code }}</div>
              <p class="sect-desc">{{ t("sync.pairingCodeHint") }}</p>
            </div>

            <div class="devices-box">
              <div class="sect-title sm-title">{{ t("sync.devicesTitle") }}</div>
              <div v-for="d in syncDevices" :key="d.tokenHash" class="device-row">
                <Icon name="laptop" :size="14" />
                <span class="dev-name">{{ d.name }}{{ d.self ? t("sync.selfTag") : "" }}</span>
                <span class="dev-tail">{{ d.tokenTail }}</span>
                <button class="btn-danger xs" :disabled="syncBusy" @click="doRevoke(d.tokenHash, d.self)">{{ t("sync.revokeBtn") }}</button>
              </div>
              <p v-if="!syncDevices.length" class="sect-desc">{{ t("sync.noDevices") }}</p>
            </div>
            <p v-if="syncErrKey" class="field-err">{{ t(syncErrKey) }}</p>
            <p class="sect-desc sub">{{ t("sync.viewTip") }}</p>
          </template>
        </div>

        <!-- ============ 赞助与开源（全面免费，自愿支持） ============ -->
        <div v-show="section === 'sponsor'" class="sect sponsor">
          <div class="sect-head">
            <span class="sect-title"><Icon name="heart" :size="15" class="sect-ico" /> {{ t("sponsor.title") }}</span>
            <span class="free-tag">{{ t("sponsor.freeTag") }}</span>
          </div>
          <p class="sect-desc">{{ t("sponsor.desc") }}</p>

          <div class="sponsor-card">
            <div class="sponsor-ico"><Icon name="heart" :size="22" /></div>
            <div class="sponsor-txt">
              <b>{{ t("sponsor.whyTitle") }}</b>
              <p>{{ t("sponsor.whyBody") }}</p>
            </div>
          </div>

          <div class="sect-foot">
            <button class="btn-primary sm" @click="openAfdian"><Icon name="heart" :size="14" /> {{ t("sponsor.afdianBtn") }}</button>
            <button class="btn-ghost sm" @click="openRepo"><Icon name="star" :size="14" /> {{ t("sponsor.starBtn") }}</button>
            <span class="sect-desc inline">{{ t("sponsor.afdianHint") }}</span>
          </div>

          <div class="oss-box">
            <div class="sect-title sm-title">{{ t("sponsor.ossTitle") }}</div>
            <p class="sect-desc">{{ t("sponsor.ossDesc") }}</p>
          </div>
        </div>


        <!-- ============ 系统设置 ============ -->
        <div v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="palette" :size="15" /> {{ t("settings.accentTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.accentDesc") }}</p>
          <div class="accent-row">
            <button
              v-for="p in ACCENT_PRESETS"
              :key="p.key"
              type="button"
              class="accent-dot"
              :class="{ on: accentKey === p.key }"
              :style="{ background: p.light['--primary'] }"
              :title="t(p.labelKey)"
              @click="pickAccent(p.key)"
            ></button>
            <button type="button" class="btn-ghost sm" @click="pickAccent('')">{{ t("settings.accentDefault") }}</button>
          </div>
        </div>

        <div v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="grid" :size="15" /> {{ t("settings.densityTitle") }}</span>
            <select v-model="form.ui.density" class="density-sel">
              <option value="compact">{{ t("settings.densityCompact") }}</option>
              <option value="comfort">{{ t("settings.densityComfort") }}</option>
            </select>
          </div>
          <p class="sect-desc">{{ t("settings.densityDesc") }}</p>
        </div>

        <div v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="eye" :size="15" /> {{ t("settings.navModulesTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.navModulesDesc") }}</p>
          <div class="nav-mod-grid">
            <label v-for="m in NAV_MODULE_OPTIONS" :key="m.key" class="switch">
              <input type="checkbox" :checked="isNavModuleVisible(m.key)" @change="toggleNavModule(m.key, $event.target.checked)" />
              <span class="track"></span>
              <span>{{ t(m.labelKey) }}</span>
            </label>
          </div>
          <p v-if="fieldErr.navModules" class="field-err nav-mod-err">{{ fieldErr.navModules }}</p>
        </div>

        <div v-if="capabilities.autostart" v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="rocket" :size="15" /> {{ t("settings.autostartTitle") }}</span>
            <label class="switch">
              <input type="checkbox" v-model="autostartOn" />
              <span class="track"></span>
              <span>{{ t("settings.autostartOn") }}</span>
            </label>
          </div>
          <p class="sect-desc">{{ t("settings.autostartDesc") }}</p>
        </div>

        <div v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="globe" :size="15" /> {{ t("settings.langTitle") }}</span>
            <select v-model="form.ui.locale" class="density-sel">
              <option value="system">{{ t("settings.langSystem") }}</option>
              <option value="zh-CN">&#20013;&#25991;</option>
              <option value="en-US">English</option>
            </select>
          </div>
          <p class="sect-desc">{{ t("settings.langDesc") }}</p>
        </div>

        <div v-if="capabilities.telemetryUpload" v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="shield" :size="15" /> {{ t("telemetry.title") }}</span>
            <label class="switch">
              <input type="checkbox" :checked="telemetryOn" @change="toggleTelemetry" />
              <span class="track"></span>
              <span>{{ t("telemetry.enable") }}</span>
            </label>
          </div>
          <p class="sect-desc">{{ t("telemetry.desc") }}</p>
          <p class="sect-desc sub">{{ t("telemetry.privacyNote") }}</p>
        </div>

        <div v-if="capabilities.backup" v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="box" :size="15" /> {{ t("settings.backupTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.backupDesc") }}</p>
          <div class="sect-foot">
            <button class="btn-ghost sm" :disabled="backingUp || restoring" @click="backupNow">
              <Icon name="download" :size="14" /> {{ backingUp ? t("settings.backuping") : t("settings.backupBtn") }}
            </button>
            <button class="btn-ghost sm" :disabled="backingUp || restoring" @click="restoreNow">
              <Icon name="repeat" :size="14" /> {{ restoring ? t("settings.restoring") : t("settings.restoreBtn") }}
            </button>
          </div>
        </div>

        <div v-if="capabilities.updater" v-show="section === 'general'" class="sect gen gen-last">
          <div class="sect-head">
            <span class="sect-title"><Icon name="download" :size="15" /> {{ t("settings.updateTitle") }}</span>
            <span class="ver-tag">{{ t("settings.updateVer", { version: appVersion }) }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.updateDesc") }}</p>
          <div class="sect-foot">
            <button class="btn-ghost sm" :disabled="checkingUpdate" @click="checkUpdateNow">
              <Icon name="repeat" :size="14" /> {{ checkingUpdate ? t("settings.updateCheckingBtn") : t("settings.updateBtn") }}
            </button>
          </div>
        </div>

        <!-- 浏览器版说明：说明存储位置与桌面版差异 -->
        <div v-if="!capabilities.multiWindow" v-show="section === 'general'" class="sect gen gen-last">
          <div class="sect-head">
            <span class="sect-title"><Icon name="globe" :size="15" /> {{ t("settings.browserTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.browserDesc") }}</p>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.settings-view { flex: 1; display: flex; min-height: 0; gap: 16px; padding: 8px 28px 18px; }

/* 左侧分类导航 */
.sv-side {
  flex-shrink: 0;
  width: 176px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 10px;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow);
  align-self: flex-start;
}
.sv-title { font-size: var(--fs-sm); font-weight: 700; color: var(--muted); padding: 2px 10px 8px; letter-spacing: 1px; }
.sv-nav {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  background: none;
  border-radius: var(--r-sm);
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-weak);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.sv-nav:hover { background: var(--primary-soft); color: var(--primary-hover); }
.sv-nav.on { background: var(--grad-selected); color: var(--primary-hover); border: 1px solid var(--border-blue); box-shadow: inset 2px 0 0 var(--primary); }
.sv-nav-label { white-space: nowrap; }
.sv-foot { margin-top: auto; padding: 10px 10px 2px; }
.ver-tag { font-size: var(--fs-xs); color: var(--faint); }

/* 右侧内容区 */
.sv-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.sv-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow);
}
.sv-bar-txt { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.sv-bar-txt b { font-size: var(--fs-base); font-weight: 700; }
.sv-desc { font-size: var(--fs-sm); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sv-dirty { font-size: var(--fs-xs); font-weight: 600; color: var(--warn-deep); background: var(--warn-soft); padding: 1px 8px; border-radius: var(--r-pill); flex-shrink: 0; }
.sv-body { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }

.sect { border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 18px; margin-bottom: 18px; background: var(--card-soft); }
.sect.gen { border: none; background: transparent; border-radius: 0; padding: 16px 2px; margin-bottom: 0; border-bottom: 1px solid var(--border); }
.sect.gen.gen-last { border-bottom: none; }
.sub-group { margin: 2px 0 16px; }
.sub-group h4 { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: var(--fs-sm); font-weight: 700; color: var(--text-soft); }
.sub-group h4::after { content: ""; flex: 1; height: 1px; background: var(--border); }
.sect-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.sect-head .switch { margin-left: auto; }
.sect-title { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-base); font-weight: 700; }
.sect-ico { flex-shrink: 0; color: var(--primary-hover); }
.sect-desc { font-size: var(--fs-sm); color: var(--muted); margin: 0 0 16px; line-height: var(--lh-body); }
.switch { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-md); color: var(--text-soft); cursor: pointer; user-select: none; }
.switch input { display: none; }
.switch .track { position: relative; width: 36px; height: 20px; flex-shrink: 0; border-radius: var(--r-pill); background: var(--border-strong); transition: background 0.15s; }
.switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--text-invert); box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25); transition: transform 0.15s; }
.switch input:checked + .track { background: var(--primary-hover); }
.switch input:checked + .track::after { transform: translateX(16px); }
.switch input:focus-visible + .track { outline: 2px solid var(--accent-soft-text); outline-offset: 2px; }

.presets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.preset-chip { padding: 6px 12px; border-radius: var(--r-pill); border: 1px solid var(--border-strong); background: var(--card); color: var(--text); font-size: var(--fs-sm); cursor: pointer; transition: all 0.15s; }
.preset-chip:hover { border-color: var(--primary); color: var(--primary-hover); }
.preset-chip.on { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }

.field { display: block; margin-bottom: 14px; }
.field > span { display: block; font-size: var(--fs-md); color: var(--muted); margin-bottom: 7px; font-weight: 600; }
.field.err > span { color: var(--danger-deep); }
.field.err input, .field.err .select { border-color: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
.field-err { display: block; margin-top: 5px; font-size: var(--fs-xs); font-weight: 600; color: var(--danger-deep); }
.field-hint { display: block; margin-top: 5px; font-size: var(--fs-xs); color: var(--muted); }
.field input { width: 100%; padding: 10px 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; background: var(--card); color: var(--text); }
.field input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.field .select { width: 100%; padding: 10px 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; background: var(--card); color: var(--text); cursor: pointer; }
.field .select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.density-sel { padding: 5px 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card); color: var(--text); font-size: var(--fs-sm); font-family: inherit; cursor: pointer; }
.density-sel:focus { border-color: var(--primary); outline: none; }
.field input.range { padding: 0; height: 24px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.tpl-hint { font-size: var(--fs-sm); color: var(--muted); margin: 2px 0 12px; line-height: var(--lh-body); }
.tpl-hint code { background: color-mix(in srgb, var(--text-weak) 13%, transparent); border-radius: var(--r-xs); padding: 1px 5px; font-size: var(--fs-xs); }
.tips-box { margin: -4px 0 14px; }
.tips-toggle { display: inline-flex; align-items: center; gap: 5px; background: none; border: none; padding: 0; color: var(--primary); font-size: var(--fs-sm); cursor: pointer; }
.tips-arrow { transition: transform 0.15s; }
.tips-arrow.open { transform: rotate(180deg); }
.tips-body { margin-top: 8px; padding: 12px 14px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: color-mix(in srgb, var(--text-weak) 6%, transparent); font-size: var(--fs-sm); color: var(--text); line-height: var(--lh-body); }
.tips-body p { margin: 0 0 8px; }
.tips-body ol { margin: 0 0 8px; padding-left: 18px; }
.tips-body li { margin-bottom: 4px; }
.tips-body b { color: var(--primary); font-weight: 600; }
.tips-note { color: var(--muted); font-size: var(--fs-sm); }
.token-row { display: flex; gap: 8px; }
.token-row input { flex: 1; }

.sect-foot { display: flex; align-items: center; gap: 14px; margin-top: 4px; }
.nav-mod-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 14px; }
.nav-mod-err { margin-top: 10px; }
.team-reminder-err { margin: -6px 0 14px; }
.link-btn { background: none; border: none; color: var(--primary); font-size: var(--fs-sm); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 0; }
.link-btn:hover { text-decoration: underline; }

@media (prefers-color-scheme: dark) {
  .field input { background: var(--card-raised); }
  .field .select { background: var(--card-raised); }
  .preset-chip { background: var(--card-raised); }
  .preset-chip.on { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .lic-input { background: var(--card-raised); }
}

/* ============ 赞助与开源分区样式 ============ */
.free-tag { font-size: var(--fs-xs); font-weight: 700; color: var(--success); border: 1px solid color-mix(in srgb, var(--success) 45%, transparent); border-radius: 999px; padding: 1px 7px; }
.sponsor-card {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  margin: 6px 0 18px;
  padding: 14px 16px;
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  background: linear-gradient(160deg, color-mix(in srgb, var(--accent-soft) 55%, var(--card)), var(--card));
}
.sponsor-ico { flex-shrink: 0; width: 40px; height: 40px; display: grid; place-items: center; border-radius: 50%; background: var(--grad-brand); color: var(--text-invert); }
.sponsor-txt b { font-size: var(--fs-base); }
.sponsor-txt p { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }
.oss-box { margin-top: 18px; padding: 10px 12px; border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card-soft); }
.oss-box .sect-desc { margin: 0; }
.lic-input {
  flex: 1;
  min-width: 240px;
  padding: 7px 10px;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--input-bg, var(--card));
  color: var(--text);
}
.accent-row { display: flex; gap: 10px; align-items: center; margin: 10px 0 4px; }
.accent-dot {
  width: 30px; height: 30px; border-radius: 50%;
  border: 2px solid var(--card-border);
  cursor: pointer; padding: 0;
  transition: transform 0.12s, border-color 0.12s;
}
.accent-dot:hover { transform: scale(1.12); border-color: var(--primary); }
.accent-dot.on { border-color: var(--text); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 30%, transparent); }
.sect-desc.inline { display: inline; margin: 0; }

/* ============ 云同步组样式 ============ */
.sync-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
.sync-or { color: var(--faint); font-size: var(--fs-sm); }
.sm-input { min-width: 150px; flex: 0 1 200px; }
.faint-hint { color: var(--faint); font-size: var(--fs-xs); font-weight: 400; }
.sync-state { display: flex; align-items: center; gap: 8px; margin: 8px 0 4px; font-size: var(--fs-sm); color: var(--text-weak); }
.sync-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); }
.sync-state.syncing .sync-dot { background: var(--primary); animation: sync-pulse 1.1s ease-in-out infinite; }
.sync-state.idle .sync-dot { background: var(--success); }
.sync-state.error .sync-dot { background: var(--danger); }
.sync-state.revoked .sync-dot { background: var(--warn); }
@keyframes sync-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.pairing-box { margin: 8px 0 12px; padding: 12px 14px; border: 1px dashed var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.pairing-code { font-family: var(--font-mono); font-size: var(--fs-xl); font-weight: 700; letter-spacing: 4px; text-align: center; color: var(--primary-hover); cursor: pointer; user-select: all; }
.devices-box { margin: 8px 0 12px; padding: 10px 12px; border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card-soft); }
.sm-title { font-size: var(--fs-sm); margin-bottom: 8px; }
.device-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: var(--fs-sm); color: var(--text); }
.dev-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dev-tail { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--muted); }
.btn-danger { background: none; border: 1px solid var(--border-danger); color: var(--danger); border-radius: var(--r-sm); padding: 3px 10px; font-size: var(--fs-xs); cursor: pointer; }
.btn-danger:hover { background: var(--danger-soft); }
</style>
