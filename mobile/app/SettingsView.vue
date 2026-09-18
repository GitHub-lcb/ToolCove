<script setup>
// 设置（手机端）：AI 模型 / 云同步 / 系统设置 / 关于。
//
// 这一页是「App 能不能真正用起来」的关键——没有它，装到手机上连 AI 都没地方配。
//
// 沿用桌面端的两条关键语义：
//  1) **快照合并保存**：表单只渲染 ai/ui，保存时以磁盘上的完整快照为基底合并
//     （mergeSettingsSnapshot），否则 sync/telemetry 等未渲染分组会被整段覆盖掉；
//  2) **apiKey 落盘加密**：读出来要 decryptValue（浏览器/手机端是明文往返，桌面端走 DPAPI/Keystore），
//     存进去要 encryptValue——两端共用同一份 secure.js。
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AI_PRESETS, testAI } from "../../src/ai.js";
import { mergeSettingsSnapshot } from "../../src/settingsConfig.js";
import { decryptValue, encryptValue } from "../../src/secure.js";
import { invoke } from "../../src/platform/invoke.js";
import { applyLocale } from "../../src/i18n/index.js";
import { applyBackup, buildBackup, describeBackup, downloadBackup } from "./backup.js";
import { createSyncCollection, getSyncSnapshot, joinSyncCollectionFull, listDevices, setSyncDeviceName, setSyncEnabled, syncNowManual } from "../../src/sync/index.js";
import { nativeAvailable, pickFile } from "./platform/bridge.js";
import { capabilities } from "../../src/platform/env.js";
import { REASONING_EFFORTS, emptySettings, formFromSettings, matchPreset, normalizeBaseUrl, syncStatusKey, validateSettings } from "./settingsForm.js";

const { t } = useI18n();

/** 构建戳：由 Vite 的 define 注入（桌面端也用它显示版本），手机端拿来核对"手机上装的是哪一版"。 */
const BUILD_STAMP_TEXT = typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__.replace("T", " ").replace("Z", "") : "dev";

/** 原生桥是否可用：内容随构建形态而变，所以不能写死"Android · WebView"。 */
const nativeReady = nativeAvailable();

/**
 * 能力清单：直接读 env.js 的 capabilities，**不手写第二份**——
 * 手写的清单迟早与代码不一致，而这里正是用户排查"这个功能怎么不好用"的地方。
 * 每一项都给出"能用"或"为什么不能用"，而不是只标一个叉。
 */
const CAPABILITY_ROWS = [
  { key: "sqlite", labelKey: "mobile.capSqlite" },
  { key: "filePicker", labelKey: "mobile.capFilePicker" },
  { key: "systemProxy", labelKey: "mobile.capHttp" },
  { key: "secureStore", labelKey: "mobile.capSecure" },
  { key: "cloudSync", labelKey: "mobile.capSync" },
  { key: "backup", labelKey: "mobile.capBackup" },
  { key: "aiRequest", labelKey: "mobile.capAi" },
  { key: "imageStore", labelKey: "mobile.capImage" },
  // 下面这些在手机端是**有意的降级**，注明原因
  { key: "jdbc", labelKey: "mobile.capJdbc" },
  { key: "rawPrint", labelKey: "mobile.capPrint" },
  { key: "multiWindow", labelKey: "mobile.capMultiWindow" },
  { key: "autostart", labelKey: "mobile.capAutostart" },
  { key: "updater", labelKey: "mobile.capUpdater" },
  { key: "tray", labelKey: "mobile.capTray" },
  { key: "localFile", labelKey: "mobile.capLocalFile" },
  { key: "icmpDiagnostics", labelKey: "mobile.capIcmp" },
  { key: "git", labelKey: "mobile.capGit" },
  { key: "telemetryUpload", labelKey: "mobile.capTelemetry" },
];

const capabilityRows = computed(() =>
  CAPABILITY_ROWS.map((row) => ({
    key: row.key,
    label: t(row.labelKey),
    on: capabilities[row.key] === true,
    // 不可用时给出原因（词条按 key 命名，缺了就退回一句通用说明，不会显示成词条键）
    note: capabilities[row.key] === true ? "" : t(`mobile.capNo_${row.key}`, t("mobile.capNo")),
  }))
);
const platformText = computed(() => (nativeReady ? "Android · WebView · 原生桥" : "WebView（网页形态）"));

const SECTIONS = [
  { key: "ai", labelKey: "settings.navAi" },
  { key: "sync", labelKey: "settings.navSync" },
  { key: "general", labelKey: "settings.navGeneral" },
  { key: "about", labelKey: "mobile.setAbout" },
];

const section = ref("ai");
const form = ref(emptySettings());
const loadError = ref("");
const errors = ref({});
const saving = ref(false);
const testing = ref(false);
const testResult = ref("");
const notice = ref("");
const rawSnapshot = ref({});
const syncCfg = ref(null);
const syncBusy = ref(false);
const syncError = ref("");
const join = ref({ collectionId: "", code: "", password: "" });
const devices = ref([]);

const currentPreset = computed(() => matchPreset(form.value.ai.baseUrl, AI_PRESETS));
const syncStatusText = computed(() => t(syncStatusKey(syncCfg.value?.status)));

async function load() {
  loadError.value = "";
  try {
    const s = await invoke("load_data", { key: "settings" });
    // load_data 对缺失文件返回 []，只接受真正的对象作为快照基底
    const snapshot = s && typeof s === "object" && !Array.isArray(s) ? s : {};
    rawSnapshot.value = snapshot;
    form.value = formFromSettings(snapshot, { decryptedKey: await decryptValue(snapshot.ai?.apiKey || "") });
  } catch (e) {
    // 读失败就禁止保存：宁可不让改，也不能把用户原配置覆盖成空
    loadError.value = e?.message || String(e);
  }
}

async function refreshSync() {
  try {
    syncCfg.value = await getSyncSnapshot();
    if (syncCfg.value?.enabled) devices.value = (await listDevices()) || [];
  } catch (e) {
    syncError.value = e?.message || String(e);
  }
}

onMounted(async () => {
  await load();
  await refreshSync();
});

function applyPreset(preset) {
  form.value = {
    ...form.value,
    ai: {
      ...form.value.ai,
      baseUrl: preset.baseUrl,
      model: form.value.ai.model || preset.model,
      apiKey: form.value.ai.apiKey || preset.apiKey || "",
      enabled: true,
    },
  };
  errors.value = {};
}

// ---------- 备份与恢复 ----------
const backupBusy = ref(false);
const backupInfo = ref("");
const backupError = ref("");
const backupNotice = ref("");

/** 备份：把所有数据打包成一个 JSON 文件并下载。 */
async function doBackup() {
  if (backupBusy.value) return;
  backupBusy.value = true;
  backupError.value = "";
  backupNotice.value = "";
  try {
    const payload = await buildBackup();
    if (!payload.stats.keys) {
      // 没有数据时不该给一个空文件让人以为备份成功了
      backupError.value = t("mobile.setBackupEmpty");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBackup(payload, `toolcove-backup-${stamp}.json`);
    backupNotice.value = t("mobile.setBackupDone", { n: payload.stats.keys });
  } catch (e) {
    backupError.value = t("mobile.setBackupFailed", { err: e?.message || String(e) });
  } finally {
    backupBusy.value = false;
  }
}

/** 恢复：经系统文件选择器选一个备份文件，校验后写回。 */
async function doRestore() {
  if (backupBusy.value) return;
  backupBusy.value = true;
  backupError.value = "";
  backupNotice.value = "";
  backupInfo.value = "";
  try {
    const uri = await pickFile("application/json");
    if (!uri) return; // 用户取消：不是错误
    const file = await invoke("file_tool_read_text", { path: uri, encoding: "UTF-8" });
    let payload;
    try {
      payload = JSON.parse(file?.text || "");
    } catch {
      // 选错文件（比如桌面端的 zip）时给出可读原因，而不是抛一个 JSON 解析错误
      backupError.value = t("mobile.setRestoreNotJson");
      return;
    }
    const info = describeBackup(payload);
    if (!info.ok) {
      backupError.value = t(`mobile.setRestoreBad_${info.reason}`, { defaultValue: t("mobile.setRestoreBad") });
      return;
    }
    backupInfo.value = t("mobile.setRestorePreview", { n: info.keys, at: info.createdAt.slice(0, 19).replace("T", " ") });
    const result = await applyBackup(payload);
    backupNotice.value = t("mobile.setRestoreDone", { n: result.written });
  } catch (e) {
    backupError.value = t("mobile.setRestoreFailed", { err: e?.message || String(e) });
  } finally {
    backupBusy.value = false;
  }
}

async function save() {
  if (loadError.value) return;
  const check = validateSettings(form.value);
  errors.value = check.errors;
  if (!check.ok) return;

  saving.value = true;
  notice.value = "";
  try {
    // 以磁盘上的完整快照为基底合并：只覆盖表单渲染的 ai/ui，其余分组原样保留
    const payload = mergeSettingsSnapshot(JSON.parse(JSON.stringify(rawSnapshot.value || {})), {
      ai: {
        ...form.value.ai,
        baseUrl: normalizeBaseUrl(form.value.ai.baseUrl),
        apiKey: await encryptValue(form.value.ai.apiKey),
      },
      ui: form.value.ui,
    });
    await invoke("save_data", { key: "settings", data: payload });
    rawSnapshot.value = payload;
    // 语言即时生效（字典是按需加载的，要先 await 取回字典再切，避免闪一堆词条 key）
    await applyLocale(form.value.ui.locale);
    notice.value = t("settings.saved");
  } catch (e) {
    notice.value = t("settings.saveFailed", { err: e?.message || String(e) });
  } finally {
    saving.value = false;
  }
}

async function runTest() {
  testing.value = true;
  testResult.value = "";
  try {
    const reply = await testAI({
      baseUrl: normalizeBaseUrl(form.value.ai.baseUrl),
      apiKey: form.value.ai.apiKey,
      model: form.value.ai.model,
      temperature: form.value.ai.temperature,
    });
    testResult.value = t("settings.aiTestOk", { reply: String(reply).slice(0, 80) });
  } catch (e) {
    testResult.value = t("settings.aiTestFail", { err: e?.message || String(e) });
  } finally {
    testing.value = false;
  }
}

// ---------- 云同步 ----------
async function toggleSync() {
  syncBusy.value = true;
  syncError.value = "";
  try {
    await setSyncEnabled(!syncCfg.value?.enabled);
    await refreshSync();
  } catch (e) {
    syncError.value = e?.message || String(e);
  } finally {
    syncBusy.value = false;
  }
}

async function createCollection() {
  syncBusy.value = true;
  syncError.value = "";
  try {
    await createSyncCollection(syncCfg.value?.serverUrl || "", join.value.password);
    await refreshSync();
  } catch (e) {
    syncError.value = e?.message || String(e);
  } finally {
    syncBusy.value = false;
  }
}

async function joinCollection() {
  syncBusy.value = true;
  syncError.value = "";
  try {
    await joinSyncCollectionFull(syncCfg.value?.serverUrl || "", join.value.collectionId, join.value.code, join.value.password);
    await refreshSync();
  } catch (e) {
    syncError.value = e?.message || String(e);
  } finally {
    syncBusy.value = false;
  }
}

async function syncNow() {
  syncBusy.value = true;
  syncError.value = "";
  try {
    await syncNowManual();
    await refreshSync();
  } catch (e) {
    syncError.value = e?.message || String(e);
  } finally {
    syncBusy.value = false;
  }
}

async function renameDevice(event) {
  try {
    await setSyncDeviceName(event?.target?.value || "");
  } catch (e) {
    syncError.value = e?.message || String(e);
  }
}
</script>

<template>
  <section class="m-settings" :data-section="section">
    <div class="m-chips">
      <button v-for="item in SECTIONS" :key="item.key" class="m-chip" :class="{ on: section === item.key }" :data-nav="item.key" @click="section = item.key">
        {{ t(item.labelKey) }}
      </button>
    </div>

    <p v-if="loadError" class="m-err" data-role="load-error">{{ t("settings.loadFailed", { err: loadError }) }}</p>
    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>

    <!-- AI -->
    <template v-if="section === 'ai'">
      <div class="m-chips">
        <button class="m-chip" :class="{ on: form.ai.enabled }" data-role="ai-enable" @click="form.ai.enabled = !form.ai.enabled">
          {{ t("settings.aiEnable") }}
        </button>
      </div>

      <p class="m-hint-sm">{{ t("settings.aiDesc") }}</p>

      <div class="m-chips" data-role="presets">
        <button
          v-for="preset in AI_PRESETS"
          :key="preset.key"
          class="m-chip"
          :class="{ on: currentPreset?.key === preset.key }"
          :data-preset="preset.key"
          @click="applyPreset(preset)"
        >
          {{ t(preset.labelKey) }}
        </button>
      </div>

      <label class="m-field">
        <span>{{ t("settings.aiBaseUrl") }}</span>
        <input v-model="form.ai.baseUrl" spellcheck="false" inputmode="url" data-role="base-url" placeholder="https://api.deepseek.com/v1" />
        <span v-if="errors.baseUrl" class="m-field-err" data-role="err-base">{{ t(errors.baseUrl) }}</span>
      </label>

      <label class="m-field">
        <span>{{ t("settings.aiKey") }}</span>
        <input v-model="form.ai.apiKey" type="password" spellcheck="false" data-role="api-key" />
        <span v-if="errors.apiKey" class="m-field-err" data-role="err-key">{{ t(errors.apiKey) }}</span>
      </label>

      <label class="m-field">
        <span>{{ t("settings.aiModel") }}</span>
        <input v-model="form.ai.model" spellcheck="false" data-role="model" placeholder="deepseek-chat" />
        <span v-if="errors.model" class="m-field-err" data-role="err-model">{{ t(errors.model) }}</span>
      </label>

      <label class="m-field">
        <span>{{ t("settings.aiTemp", { value: form.ai.temperature }) }}</span>
        <input v-model.number="form.ai.temperature" type="range" min="0" max="2" step="0.1" data-role="temperature" />
      </label>

      <label class="m-field">
        <span>{{ t("settings.aiReason") }}</span>
        <select v-model="form.ai.reasoningEffort" data-role="reasoning">
          <option v-for="value in REASONING_EFFORTS" :key="value" :value="value">
            {{ value === "" ? t("settings.aiReasonNone") : value }}
          </option>
        </select>
      </label>

      <div class="m-actions">
        <button class="m-btn primary" :disabled="testing" data-role="test" @click="runTest">
          {{ testing ? t("settings.aiTesting") : t("settings.aiTest") }}
        </button>
      </div>
      <p v-if="testResult" class="m-hint-sm" data-role="test-result">{{ testResult }}</p>
    </template>

    <!-- 云同步 -->
    <template v-else-if="section === 'sync'">
      <div class="m-card">
        <div class="m-card-head">
          <b>{{ t("sync.title") }}</b>
          <span class="m-zone" data-role="sync-status">{{ syncStatusText }}</span>
        </div>
        <p class="m-hint-sm">{{ t("sync.desc") }}</p>
        <div class="m-chips">
          <button class="m-chip" :class="{ on: syncCfg?.enabled }" :disabled="syncBusy" data-role="sync-toggle" @click="toggleSync">
            {{ t("sync.enable") }}
          </button>
        </div>
        <label class="m-field">
          <span>{{ t("sync.serverUrl") }}</span>
          <input :value="syncCfg?.serverUrl || ''" spellcheck="false" inputmode="url" readonly data-role="sync-server" />
        </label>
        <label class="m-field">
          <span>{{ t("mobile.setDeviceName") }}</span>
          <input :value="syncCfg?.deviceName || ''" spellcheck="false" data-role="sync-device" @change="renameDevice" />
        </label>
        <div class="m-actions">
          <button class="m-btn" :disabled="syncBusy || !syncCfg?.enabled" data-role="sync-now" @click="syncNow">{{ t("sync.syncNowBtn") }}</button>
          <button class="m-btn" :disabled="syncBusy" data-role="sync-create" @click="createCollection">{{ t("sync.createBtn") }}</button>
        </div>
      </div>

      <div class="m-card">
        <div class="m-card-head"><b>{{ t("sync.joinBtn") }}</b></div>
        <label class="m-field">
          <span>{{ t("sync.or") }}</span>
          <input v-model="join.collectionId" spellcheck="false" :placeholder="t('sync.joinIdPh')" data-role="join-id" />
        </label>
        <label class="m-field">
          <span>{{ t("sync.joinCodePh") }}</span>
          <input v-model="join.code" spellcheck="false" data-role="join-code" />
        </label>
        <label class="m-field">
          <span>{{ t("sync.syncPasswordPh") }}</span>
          <input v-model="join.password" type="password" spellcheck="false" data-role="join-password" />
        </label>
        <div class="m-actions">
          <button class="m-btn primary" :disabled="syncBusy" data-role="join-btn" @click="joinCollection">{{ t("sync.joinBtn") }}</button>
        </div>
      </div>

      <div v-if="devices.length" class="m-card">
        <div class="m-card-head"><b>{{ t("sync.devicesTitle") }}</b></div>
        <ul class="m-stats" data-role="sync-devices">
          <li v-for="device in devices" :key="device.tokenHash || device.tokenTail || device.name">
            <b>{{ device.name || device.tokenTail || "—" }}</b>
            <span>{{ device.self ? t("sync.selfTag") : t("sync.tokenTailCol") }}</span>
          </li>
        </ul>
      </div>

      <p v-if="syncError" class="m-err" data-role="sync-error">{{ syncError }}</p>
    </template>

    <!-- 系统设置 -->
    <template v-else-if="section === 'general'">
      <label class="m-field">
        <span>{{ t("mobile.setLocale") }}</span>
        <select v-model="form.ui.locale" data-role="locale">
          <option value="system">{{ t("mobile.setLocaleSystem") }}</option>
          <option value="zh-CN">简体中文</option>
          <option value="en-US">English</option>
        </select>
      </label>
      <label class="m-field">
        <span>{{ t("mobile.setDensity") }}</span>
        <select v-model="form.ui.density" data-role="density">
          <option value="compact">{{ t("mobile.setDensityCompact") }}</option>
          <option value="comfort">{{ t("mobile.setDensityComfort") }}</option>
        </select>
      </label>
      <p class="m-hint-sm">{{ t("mobile.setDensityNote") }}</p>

      <!-- 备份与恢复：桌面端打成 zip 写到指定路径；手机端没有"任意路径写"，
           所以备份走浏览器下载、恢复走系统文件选择器（SAF）。 -->
      <div class="m-card">
        <div class="m-card-head"><b>{{ t("mobile.setBackupTitle") }}</b></div>
        <p class="m-hint-sm">{{ t("mobile.setBackupNote") }}</p>
        <div class="m-actions">
          <button class="m-btn primary" :disabled="backupBusy" data-role="backup" @click="doBackup">{{ t("mobile.setBackupBtn") }}</button>
          <button class="m-btn" :disabled="backupBusy || !nativeReady" data-role="restore" @click="doRestore">{{ t("mobile.setRestoreBtn") }}</button>
        </div>
        <!-- 恢复前必须让人看清"要写回多少键、来自什么时候"，否则是盲操作 -->
        <p v-if="backupInfo" class="m-hint-sm" data-role="backup-info">{{ backupInfo }}</p>
        <p v-if="backupError" class="m-err" data-role="backup-error">{{ backupError }}</p>
        <p v-if="backupNotice" class="m-ok" data-role="backup-notice">{{ backupNotice }}</p>
      </div>
    </template>

    <!-- 关于 -->
    <template v-else>
      <ul class="m-stats" data-role="about">
        <li><b>{{ t("mobile.setVersion") }}</b><span data-role="build-stamp">{{ BUILD_STAMP_TEXT }}</span></li>
        <li><b>{{ t("mobile.setPlatform") }}</b><span>{{ platformText }}</span></li>
        <!-- 原生桥是否接上：装了 APK 就该是「已接上」，浏览器里跑则是「网页形态」。
             这一行也是排查"为什么某些能力没生效"的第一个抓手。 -->
        <li><b>{{ t("mobile.setBridge") }}</b><span data-role="bridge-status" :data-on="nativeReady">{{ nativeReady ? t("mobile.bridgeOn") : t("mobile.bridgeOff") }}</span></li>
      </ul>
      <p class="m-hint-sm">{{ t("mobile.setStorageNote") }}</p>

      <!-- 能力清单：把"哪些能用、哪些在安卓上降级"直接摆在界面上。
           为什么要有这一块：降级此前只写在工具备注与文档里，用户遇到"这个功能怎么不好用"
           时没有一处能查。这里按 env.js 的真实能力矩阵渲染，不手写第二份清单——
           手写的清单迟早与代码不一致。 -->
      <div class="m-card">
        <div class="m-card-head"><b>{{ t("mobile.setCapsTitle") }}</b></div>
        <p class="m-hint-sm">{{ t("mobile.setCapsNote") }}</p>
        <ul class="m-stats" data-role="capabilities">
          <li v-for="cap in capabilityRows" :key="cap.key" :data-cap="cap.key" :data-on="cap.on">
            <b>{{ cap.label }}</b>
            <span>{{ cap.on ? t("mobile.capYes") : cap.note }}</span>
          </li>
        </ul>
      </div>
    </template>

    <div v-if="section !== 'about'" class="m-actions">
      <button class="m-btn primary" :disabled="saving || !!loadError" data-role="save" @click="save">{{ t("common.confirm") }}</button>
    </div>
  </section>
</template>
