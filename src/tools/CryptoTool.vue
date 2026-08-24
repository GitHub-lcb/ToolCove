<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import {
  calculateFileHashes,
  decryptAes,
  decryptRsa,
  digestText,
  encryptAes,
  encryptRsa,
  generatePassword,
  generateRsaKeyPair,
  getPasswordPoolSize,
  getPasswordStrength,
  hmacText,
} from "../cryptoTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const TABS = computed(() => [
  { key: "digest", label: t("toolbox.crypto.tabDigest") },
  { key: "hmac", label: "HMAC" },
  { key: "aes", label: "AES" },
  { key: "rsa", label: "RSA" },
  { key: "file", label: t("toolbox.crypto.tabFile") },
  { key: "password", label: t("toolbox.crypto.tabPassword") },
]);
const HASH_ALGORITHMS = ["MD5", "SHA-1", "SHA-256", "SHA-384", "SHA-512"];
const SECURE_HASH_ALGORITHMS = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];
const activeTab = ref("digest");

const digestInput = ref("");
const digestAlgorithm = ref("SHA-256");
const digestOutput = ref("hex");
const digestResult = ref("");
const digestError = ref("");
let digestRun = 0;
watch([digestInput, digestAlgorithm, digestOutput], calculateDigest, { immediate: true });
async function calculateDigest() {
  const run = ++digestRun;
  digestError.value = "";
  digestResult.value = "";
  if (!digestInput.value) return;
  try {
    const result = await digestText(digestInput.value, digestAlgorithm.value, digestOutput.value);
    if (run === digestRun) digestResult.value = result;
  } catch (error) {
    if (run === digestRun) digestError.value = errorMessage(error);
  }
}

const hmacInput = ref("");
const hmacSecret = ref("");
const hmacAlgorithm = ref("SHA-256");
const hmacOutput = ref("hex");
const hmacResult = ref("");
const hmacError = ref("");
let hmacRun = 0;
watch([hmacInput, hmacSecret, hmacAlgorithm, hmacOutput], calculateHmac, { immediate: true });
async function calculateHmac() {
  const run = ++hmacRun;
  hmacError.value = "";
  hmacResult.value = "";
  if (!hmacInput.value || !hmacSecret.value) return;
  try {
    const result = await hmacText(hmacInput.value, hmacSecret.value, hmacAlgorithm.value, hmacOutput.value);
    if (run === hmacRun) hmacResult.value = result;
  } catch (error) {
    if (run === hmacRun) hmacError.value = errorMessage(error);
  }
}

const aesMode = ref("encrypt");
const aesInput = ref("");
const aesPassword = ref("");
const aesIterations = ref(210000);
const aesState = ref(taskState());
async function runAes() {
  if (!aesInput.value) return props.showToast(t(aesMode.value === "encrypt" ? "toolbox.crypto.aesNeedText" : "toolbox.crypto.aesNeedPackage"));
  if (!aesPassword.value) return props.showToast(t("toolbox.crypto.aesNeedPassword"));
  aesState.value = { loading: true, result: "", error: "" };
  try {
    const result = aesMode.value === "encrypt"
      ? await encryptAes(aesInput.value, aesPassword.value, Number(aesIterations.value))
      : await decryptAes(aesInput.value, aesPassword.value);
    aesState.value = { loading: false, result, error: "" };
  } catch (error) {
    aesState.value = { loading: false, result: "", error: errorMessage(error) };
  }
}
function useAesResult() {
  if (!aesState.value.result) return;
  aesInput.value = aesState.value.result;
  aesMode.value = aesMode.value === "encrypt" ? "decrypt" : "encrypt";
  aesState.value = taskState();
}

const rsaMode = ref("encrypt");
const rsaBits = ref(2048);
const rsaPublicKey = ref("");
const rsaPrivateKey = ref("");
const rsaInput = ref("");
const rsaKeyState = ref({ loading: false, error: "" });
const rsaState = ref(taskState());
async function generateKeys() {
  rsaKeyState.value = { loading: true, error: "" };
  try {
    const keys = await generateRsaKeyPair(Number(rsaBits.value));
    rsaPublicKey.value = keys.publicKey;
    rsaPrivateKey.value = keys.privateKey;
    rsaKeyState.value = { loading: false, error: "" };
    props.showToast(t("toolbox.crypto.keysGenerated"));
  } catch (error) {
    rsaKeyState.value = { loading: false, error: errorMessage(error) };
  }
}
async function runRsa() {
  if (!rsaInput.value) return props.showToast(t(rsaMode.value === "encrypt" ? "toolbox.crypto.aesNeedText" : "toolbox.crypto.rsaNeedCipher"));
  const key = rsaMode.value === "encrypt" ? rsaPublicKey.value : rsaPrivateKey.value;
  if (!key.trim()) return props.showToast(t(rsaMode.value === "encrypt" ? "toolbox.crypto.rsaNeedPub" : "toolbox.crypto.rsaNeedPriv"));
  rsaState.value = { loading: true, result: "", error: "" };
  try {
    const result = rsaMode.value === "encrypt"
      ? await encryptRsa(rsaInput.value, rsaPublicKey.value)
      : await decryptRsa(rsaInput.value, rsaPrivateKey.value);
    rsaState.value = { loading: false, result, error: "" };
  } catch (error) {
    rsaState.value = { loading: false, result: "", error: errorMessage(error) };
  }
}

const fileInput = ref(null);
const selectedFile = ref(null);
const fileAlgorithms = ref({ MD5: true, "SHA-1": false, "SHA-256": true, "SHA-384": false, "SHA-512": false });
const fileProgress = ref(0);
const fileState = ref({ loading: false, results: null, error: "" });
const draggingFile = ref(false);
function chooseFile() {
  fileInput.value?.click();
}
function onFileSelected(event) {
  setFile(event.target.files?.[0]);
  event.target.value = "";
}
function onFileDrop(event) {
  draggingFile.value = false;
  setFile(event.dataTransfer?.files?.[0]);
}
function setFile(file) {
  if (!file) return;
  selectedFile.value = file;
  fileState.value = { loading: false, results: null, error: "" };
  fileProgress.value = 0;
}
async function runFileHash() {
  if (!selectedFile.value) return props.showToast(t("toolbox.crypto.fileNotSelected"));
  const algorithms = Object.entries(fileAlgorithms.value).filter(([, enabled]) => enabled).map(([algorithm]) => algorithm);
  if (!algorithms.length) return props.showToast(t("toolbox.crypto.fileNoAlgo"));
  fileState.value = { loading: true, results: null, error: "" };
  fileProgress.value = 0;
  try {
    const results = await calculateFileHashes(selectedFile.value, algorithms, {
      onProgress: (value) => { fileProgress.value = value; },
    });
    fileState.value = { loading: false, results, error: "" };
  } catch (error) {
    fileState.value = { loading: false, results: null, error: errorMessage(error) };
  }
}

const passwordOptions = ref({
  length: 20,
  count: 5,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  excludeAmbiguous: true,
});
const passwords = ref([]);
const passwordError = ref("");
const copiedPasswordIndex = ref(-1);
const copiedAllPasswords = ref(false);
let passwordCopyTimer = null;
let allPasswordsCopyTimer = null;
const passwordPoolSize = computed(() => getPasswordPoolSize(passwordOptions.value));
const passwordStrength = computed(() => getPasswordStrength(passwords.value[0] || "", passwordPoolSize.value));
function generatePasswords() {
  passwordError.value = "";
  copiedPasswordIndex.value = -1;
  copiedAllPasswords.value = false;
  try {
    const count = Math.min(20, Math.max(1, Number(passwordOptions.value.count) || 1));
    passwords.value = Array.from({ length: count }, () => generatePassword(passwordOptions.value));
  } catch (error) {
    passwords.value = [];
    passwordError.value = errorMessage(error);
  }
}

async function copyPassword(password, index) {
  if (!await copyText(password, "toolbox.crypto.copyPassword")) return;
  copiedPasswordIndex.value = index;
  clearTimeout(passwordCopyTimer);
  passwordCopyTimer = setTimeout(() => { copiedPasswordIndex.value = -1; }, 1800);
}

async function copyAllPasswords() {
  if (!await copyText(passwords.value.join("\n"), "toolbox.crypto.copyAllPassword")) return;
  copiedAllPasswords.value = true;
  clearTimeout(allPasswordsCopyTimer);
  allPasswordsCopyTimer = setTimeout(() => { copiedAllPasswords.value = false; }, 1800);
}

onBeforeUnmount(() => {
  clearTimeout(passwordCopyTimer);
  clearTimeout(allPasswordsCopyTimer);
});

function taskState() {
  return { loading: false, result: "", error: "" };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
async function copyText(value, labelKey = "toolbox.crypto.copyResult", params) {
  if (!value) {
    props.showToast(t("toolbox.crypto.nothingToCopy", { label: t(labelKey, params) }));
    return false;
  }
  try {
    await navigator.clipboard.writeText(String(value));
    props.showToast(t("toolbox.crypto.copiedLabel", { label: t(labelKey, params) }));
    return true;
  } catch (error) {
    props.showToast(t("toolbox.crypto.copyFailed", { err: errorMessage(error) }));
    return false;
  }
}
</script>

<template>
  <div class="crypto-tool">
    <nav class="mode-tabs" :aria-label="t('toolbox.crypto.navLabel')">
      <button v-for="tab in TABS" :key="tab.key" type="button" class="mode-tab" :class="{ on: activeTab === tab.key }" @click="activeTab = tab.key">{{ tab.label }}</button>
    </nav>

    <section v-if="activeTab === 'digest'" class="workspace column-workspace">
      <div class="control-bar">
        <label class="field"><span>{{ t("toolbox.crypto.algorithmLabel") }}</span><select v-model="digestAlgorithm"><option v-for="algorithm in HASH_ALGORITHMS" :key="algorithm">{{ algorithm }}</option></select></label>
        <div class="segmented" role="group" :aria-label="t('toolbox.crypto.digestOutAria')"><button type="button" :class="{ on: digestOutput === 'hex' }" @click="digestOutput = 'hex'">Hex</button><button type="button" :class="{ on: digestOutput === 'base64' }" @click="digestOutput = 'base64'">Base64</button></div>
        <span v-if="digestAlgorithm === 'MD5' || digestAlgorithm === 'SHA-1'" class="warn-chip"><Icon name="alert" :size="13" />{{ t("toolbox.crypto.warnLegacy") }}</span>
      </div>
      <div class="split-workspace">
        <section class="panel editor-panel"><header class="panel-head"><b>{{ t("toolbox.crypto.digestSrcTitle") }}</b><span>{{ t("toolbox.crypto.charCount", { count: digestInput.length }) }}</span></header><textarea v-model="digestInput" class="text-editor mono" spellcheck="false" :placeholder="t('toolbox.crypto.digestPh')"></textarea></section>
        <section class="panel editor-panel" :class="{ invalid: digestError }"><header class="panel-head"><b>{{ t("toolbox.crypto.digestResultTitle", { algo: digestAlgorithm }) }}</b><button class="icon-btn xs" :title="t('toolbox.crypto.copyDigestTitle')" :disabled="!digestResult" @click="copyText(digestResult, 'toolbox.crypto.copyDigest')"><Icon name="copy" :size="13" /></button></header><div v-if="digestError" class="error-state"><Icon name="alert" :size="20" />{{ digestError }}</div><textarea v-else :value="digestResult" class="text-editor mono output" readonly spellcheck="false" :placeholder="t('toolbox.crypto.digestOutPh')"></textarea></section>
      </div>
    </section>

    <section v-else-if="activeTab === 'hmac'" class="workspace column-workspace">
      <div class="control-bar hmac-controls">
        <label class="field"><span>{{ t("toolbox.crypto.algorithmLabel") }}</span><select v-model="hmacAlgorithm"><option v-for="algorithm in SECURE_HASH_ALGORITHMS" :key="algorithm">{{ algorithm }}</option></select></label>
        <label class="field secret-field"><span>{{ t("toolbox.crypto.secretLabel") }}</span><input v-model="hmacSecret" class="mono" type="password" :placeholder="t('toolbox.crypto.hmacSecretPh')" /></label>
        <div class="segmented" role="group" :aria-label="t('toolbox.crypto.hmacOutAria')"><button type="button" :class="{ on: hmacOutput === 'hex' }" @click="hmacOutput = 'hex'">Hex</button><button type="button" :class="{ on: hmacOutput === 'base64' }" @click="hmacOutput = 'base64'">Base64</button></div>
      </div>
      <div class="split-workspace">
        <section class="panel editor-panel"><header class="panel-head"><b>{{ t("toolbox.crypto.hmacMsgTitle") }}</b><span>{{ t("toolbox.crypto.charCount", { count: hmacInput.length }) }}</span></header><textarea v-model="hmacInput" class="text-editor mono" spellcheck="false" :placeholder="t('toolbox.crypto.hmacMsgPh')"></textarea></section>
        <section class="panel editor-panel" :class="{ invalid: hmacError }"><header class="panel-head"><b>{{ t("toolbox.crypto.hmacResultTitle") }}</b><button class="icon-btn xs" :title="t('toolbox.crypto.copyHmacTitle')" :disabled="!hmacResult" @click="copyText(hmacResult, 'toolbox.crypto.copyHmac')"><Icon name="copy" :size="13" /></button></header><div v-if="hmacError" class="error-state"><Icon name="alert" :size="20" />{{ hmacError }}</div><textarea v-else :value="hmacResult" class="text-editor mono output" readonly spellcheck="false" :placeholder="t('toolbox.crypto.hmacOutPh')"></textarea></section>
      </div>
    </section>

    <section v-else-if="activeTab === 'aes'" class="workspace column-workspace">
      <div class="control-bar aes-controls">
        <div class="segmented"><button type="button" :class="{ on: aesMode === 'encrypt' }" @click="aesMode = 'encrypt'; aesState = taskState()">{{ t("toolbox.crypto.modeEncrypt") }}</button><button type="button" :class="{ on: aesMode === 'decrypt' }" @click="aesMode = 'decrypt'; aesState = taskState()">{{ t("toolbox.crypto.modeDecrypt") }}</button></div>
        <label class="field secret-field"><span>{{ t("toolbox.crypto.passLabel") }}</span><input v-model="aesPassword" class="mono" type="password" :placeholder="t('toolbox.crypto.aesPassPh')" /></label>
        <label v-if="aesMode === 'encrypt'" class="field iteration-field"><span>{{ t("toolbox.crypto.pbkdf2Label") }}</span><input v-model.number="aesIterations" type="number" min="10000" max="2000000" step="10000" /></label>
        <span class="secure-chip"><Icon name="lock" :size="13" />AES-256-GCM</span>
        <button class="btn-primary" type="button" :disabled="aesState.loading" @click="runAes"><Icon name="key" :size="15" />{{ aesMode === 'encrypt' ? t("toolbox.crypto.modeEncrypt") : t("toolbox.crypto.modeDecrypt") }}</button>
      </div>
      <div class="split-workspace">
        <section class="panel editor-panel"><header class="panel-head"><b>{{ aesMode === 'encrypt' ? t("toolbox.crypto.aesSrcEncTitle") : t("toolbox.crypto.aesSrcDecTitle") }}</b><span>{{ t("toolbox.crypto.charCount", { count: aesInput.length }) }}</span></header><textarea v-model="aesInput" class="text-editor mono" spellcheck="false" :placeholder="aesMode === 'encrypt' ? t('toolbox.crypto.aesSrcEncPh') : t('toolbox.crypto.aesSrcDecPh')"></textarea></section>
        <section class="panel editor-panel" :class="{ invalid: aesState.error }"><header class="panel-head"><b>{{ aesMode === 'encrypt' ? t("toolbox.crypto.aesOutEncTitle") : t("toolbox.crypto.aesOutDecTitle") }}</b><span class="panel-actions"><button class="btn-ghost xs" :disabled="!aesState.result" @click="useAesResult">{{ t("toolbox.crypto.aesReverseBtn") }}</button><button class="icon-btn xs" :title="t('toolbox.crypto.copyResultTitle')" :disabled="!aesState.result" @click="copyText(aesState.result)"><Icon name="copy" :size="13" /></button></span></header><div v-if="aesState.loading" class="loading-state"><span class="spinner"></span>{{ t("toolbox.crypto.processing") }}</div><div v-else-if="aesState.error" class="error-state"><Icon name="alert" :size="20" />{{ aesState.error }}</div><textarea v-else :value="aesState.result" class="text-editor mono output" readonly spellcheck="false" :placeholder="t('toolbox.crypto.runOutPh')"></textarea></section>
      </div>
    </section>

    <section v-else-if="activeTab === 'rsa'" class="workspace rsa-workspace">
      <div class="control-bar rsa-controls">
        <div class="segmented"><button type="button" :class="{ on: rsaMode === 'encrypt' }" @click="rsaMode = 'encrypt'; rsaState = taskState()">{{ t("toolbox.crypto.rsaModeEncrypt") }}</button><button type="button" :class="{ on: rsaMode === 'decrypt' }" @click="rsaMode = 'decrypt'; rsaState = taskState()">{{ t("toolbox.crypto.rsaModeDecrypt") }}</button></div>
        <label class="field bits-field"><span>{{ t("toolbox.crypto.rsaBitsLabel") }}</span><select v-model.number="rsaBits"><option :value="2048">2048</option><option :value="3072">3072</option><option :value="4096">4096</option></select></label>
        <button class="btn-outline" type="button" :disabled="rsaKeyState.loading" @click="generateKeys"><Icon name="key" :size="15" />{{ t("toolbox.crypto.genKeysBtn") }}</button>
        <span v-if="rsaKeyState.error" class="inline-error compact">{{ rsaKeyState.error }}</span>
      </div>
      <div class="rsa-grid">
        <section class="panel key-panel"><header class="panel-head"><b>{{ rsaMode === 'encrypt' ? t("toolbox.crypto.rsaPubTitle") : t("toolbox.crypto.rsaPrivTitle") }}</b><button class="icon-btn xs" :title="t('toolbox.crypto.copyKeyTitle')" :disabled="rsaMode === 'encrypt' ? !rsaPublicKey : !rsaPrivateKey" @click="copyText(rsaMode === 'encrypt' ? rsaPublicKey : rsaPrivateKey, 'toolbox.crypto.copyKey')"><Icon name="copy" :size="13" /></button></header><textarea v-if="rsaMode === 'encrypt'" v-model="rsaPublicKey" class="text-editor mono key-editor" spellcheck="false" :placeholder="t('toolbox.crypto.rsaPubPh')"></textarea><textarea v-else v-model="rsaPrivateKey" class="text-editor mono key-editor" spellcheck="false" :placeholder="t('toolbox.crypto.rsaPrivPh')"></textarea></section>
        <section class="rsa-message">
          <div class="rsa-runbar"><span class="secure-chip"><Icon name="lock" :size="13" />RSA-OAEP / SHA-256</span><button class="btn-primary" type="button" :disabled="rsaState.loading" @click="runRsa">{{ rsaMode === 'encrypt' ? t("toolbox.crypto.modeEncrypt") : t("toolbox.crypto.modeDecrypt") }}</button></div>
          <div class="rsa-editors">
            <section class="panel editor-panel"><header class="panel-head"><b>{{ rsaMode === 'encrypt' ? t("toolbox.crypto.rsaSrcEncTitle") : t("toolbox.crypto.rsaSrcDecTitle") }}</b></header><textarea v-model="rsaInput" class="text-editor mono" spellcheck="false" :placeholder="rsaMode === 'encrypt' ? t('toolbox.crypto.rsaSrcEncPh') : t('toolbox.crypto.rsaSrcDecPh')"></textarea></section>
            <section class="panel editor-panel" :class="{ invalid: rsaState.error }"><header class="panel-head"><b>{{ t("toolbox.crypto.resultTitle") }}</b><button class="icon-btn xs" :title="t('toolbox.crypto.copyResultTitle')" :disabled="!rsaState.result" @click="copyText(rsaState.result)"><Icon name="copy" :size="13" /></button></header><div v-if="rsaState.loading" class="loading-state"><span class="spinner"></span>{{ t("toolbox.crypto.processing") }}</div><div v-else-if="rsaState.error" class="error-state"><Icon name="alert" :size="20" />{{ rsaState.error }}</div><textarea v-else :value="rsaState.result" class="text-editor mono output" readonly spellcheck="false" :placeholder="t('toolbox.crypto.runOutPh')"></textarea></section>
          </div>
        </section>
      </div>
    </section>

    <section v-else-if="activeTab === 'file'" class="workspace file-workspace">
      <div class="file-controls"><div class="algorithm-checks"><span>{{ t("toolbox.crypto.fileAlgoLabel") }}</span><label v-for="algorithm in HASH_ALGORITHMS" :key="algorithm"><input v-model="fileAlgorithms[algorithm]" type="checkbox" />{{ algorithm }}</label></div><button class="btn-primary" type="button" :disabled="fileState.loading || !selectedFile" @click="runFileHash"><Icon name="shield" :size="15" />{{ t("toolbox.crypto.fileRunBtn") }}</button></div>
      <input ref="fileInput" class="hidden-file" type="file" @change="onFileSelected" />
      <button class="file-drop" :class="{ dragging: draggingFile }" type="button" @click="chooseFile" @dragover.prevent="draggingFile = true" @dragleave.prevent="draggingFile = false" @drop.prevent="onFileDrop">
        <span class="file-icon"><Icon name="file" :size="24" /></span>
        <template v-if="selectedFile"><b :title="selectedFile.name">{{ selectedFile.name }}</b><span>{{ formatFileSize(selectedFile.size) }} · {{ t("toolbox.crypto.fileChangeHint") }}</span></template>
        <template v-else><b>{{ t("toolbox.crypto.fileChooseBtn") }}</b><span>{{ t("toolbox.crypto.fileDropHint") }}</span></template>
      </button>
      <div v-if="fileState.loading" class="progress-row"><div><span :style="{ width: `${Math.round(fileProgress * 100)}%` }"></span></div><b>{{ Math.round(fileProgress * 100) }}%</b></div>
      <div v-if="fileState.error" class="inline-error"><Icon name="alert" :size="16" />{{ fileState.error }}</div>
      <div v-if="fileState.results" class="hash-results"><div v-for="(value, algorithm) in fileState.results" :key="algorithm" class="hash-row"><b>{{ algorithm }}</b><code :title="value">{{ value }}</code><button class="icon-btn xs" :title="t('toolbox.crypto.copyChecksumTitle')" @click="copyText(value, 'toolbox.crypto.copyChecksum', { algorithm })"><Icon name="copy" :size="13" /></button></div></div>
      <div v-else-if="!fileState.loading" class="blank-state"><Icon name="shield" :size="26" /><span>{{ t("toolbox.crypto.fileLocalNote") }}</span></div>
    </section>

    <section v-else class="workspace password-workspace">
      <div class="password-controls">
        <div class="length-control"><label><span>{{ t("toolbox.crypto.lengthLabel") }}</span><input v-model.number="passwordOptions.length" type="number" min="4" max="256" /></label><input v-model.number="passwordOptions.length" type="range" min="4" max="64" /></div>
        <label class="field count-field"><span>{{ t("toolbox.crypto.countLabel") }}</span><input v-model.number="passwordOptions.count" type="number" min="1" max="20" /></label>
        <div class="charset-options"><label><input v-model="passwordOptions.uppercase" type="checkbox" />{{ t("toolbox.crypto.optUpper") }}</label><label><input v-model="passwordOptions.lowercase" type="checkbox" />{{ t("toolbox.crypto.optLower") }}</label><label><input v-model="passwordOptions.numbers" type="checkbox" />{{ t("toolbox.crypto.optNumber") }}</label><label><input v-model="passwordOptions.symbols" type="checkbox" />{{ t("toolbox.crypto.optSymbol") }}</label><label><input v-model="passwordOptions.excludeAmbiguous" type="checkbox" />{{ t("toolbox.crypto.optExcludeAmbiguous") }}</label></div>
        <button class="btn-primary" type="button" @click="generatePasswords"><Icon name="dice" :size="15" />{{ t("toolbox.crypto.genBtn") }}</button>
      </div>
      <div v-if="passwordError" class="inline-error"><Icon name="alert" :size="16" />{{ passwordError }}</div>
      <div v-if="passwords.length" class="password-summary"><span>{{ t("toolbox.crypto.strengthCaption") }}</span><b>{{ passwordStrength.label }}</b><code>{{ t("toolbox.crypto.entropyText", { bits: passwordStrength.entropy }) }}</code><span>{{ t("toolbox.crypto.poolText", { count: passwordPoolSize }) }}</span><button class="btn-ghost xs copy-all-btn" :class="{ copied: copiedAllPasswords }" @click="copyAllPasswords"><Icon v-if="copiedAllPasswords" name="check" :size="13" />{{ copiedAllPasswords ? t("toolbox.crypto.copiedAll") : t("toolbox.crypto.copyAllBtn") }}</button></div>
      <div v-if="passwords.length" class="password-list"><div v-for="(password, index) in passwords" :key="index" class="password-row"><span>{{ index + 1 }}</span><code :title="password">{{ password }}</code><button class="icon-btn xs password-copy-btn" :class="{ copied: copiedPasswordIndex === index }" :title="copiedPasswordIndex === index ? t('toolbox.crypto.copiedTitle') : t('toolbox.crypto.copyPwdTitle')" :aria-label="copiedPasswordIndex === index ? t('toolbox.crypto.copiedPwdAria') : t('toolbox.crypto.copyPwdAria')" @click="copyPassword(password, index)"><Icon :name="copiedPasswordIndex === index ? 'check' : 'copy'" :size="13" /></button></div></div>
      <div v-else class="blank-state"><Icon name="dice" :size="26" /><span>{{ t("toolbox.crypto.passwordBlankNote") }}</span></div>
    </section>
  </div>
</template>

<style scoped>
.crypto-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.mode-tabs { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border); }
.mode-tab { flex-shrink: 0; padding: var(--sp-2) var(--sp-4); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text-weak); font-size: var(--fs-md); cursor: pointer; transition: color 0.15s, background 0.15s, border-color 0.15s; }
.mode-tab:hover { color: var(--text); background: var(--ghost); }
.mode-tab.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }
.workspace { flex: 1; min-height: 0; }
.column-workspace { display: flex; flex-direction: column; gap: var(--sp-3); }
.control-bar { flex-shrink: 0; min-height: 40px; display: flex; align-items: flex-end; gap: var(--sp-3); }
.field { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.field > span, .algorithm-checks > span { color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
.field input, .field select { min-width: 0; height: 34px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none; background: var(--card); color: var(--text); font-size: var(--fs-md); }
.field input:focus, .field select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.secret-field { flex: 1; max-width: 420px; }
.iteration-field { width: 170px; }
.bits-field { width: 110px; }
.panel { min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.panel.invalid { border-color: var(--border-danger); }
.panel-head { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.panel-head > span:not(.panel-actions) { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.panel-head > button, .panel-actions { margin-left: auto; }
.panel-actions { display: flex; align-items: center; gap: var(--sp-1); }
.text-editor { flex: 1; min-height: 0; width: 100%; padding: var(--sp-4); resize: none; border: none; outline: none; background: transparent; color: var(--text-code); font-size: var(--fs-md); line-height: var(--lh-body); overflow: auto; }
.text-editor.output { background: color-mix(in srgb, var(--text) 1.5%, transparent); }
.mono, code { font-family: var(--font-mono); }
.split-workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }
.editor-panel { display: flex; flex-direction: column; }
.segmented { flex-shrink: 0; display: inline-grid; grid-auto-flow: column; grid-auto-columns: minmax(66px, auto); padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.segmented button { min-height: 30px; padding: 0 var(--sp-3); border: none; border-radius: var(--r-xs); background: transparent; color: var(--muted); font-size: var(--fs-sm); cursor: pointer; }
.segmented button.on { background: var(--card); color: var(--primary-hover); box-shadow: var(--shadow); font-weight: 600; }
.warn-chip, .secure-chip { align-self: center; display: inline-flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-3); border-radius: var(--r-pill); background: var(--warn-soft); color: var(--warn-deep); font-size: var(--fs-sm); white-space: nowrap; }
.secure-chip { background: var(--success-soft); color: var(--success-deep); }
.error-state, .loading-state, .blank-state { flex: 1; min-height: 130px; display: flex; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-5); color: var(--muted); font-size: var(--fs-sm); text-align: center; }
.error-state { color: var(--danger-deep); background: var(--danger-soft); }
.blank-state svg { color: var(--faint); }
.inline-error { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-danger); border-radius: var(--r-sm); background: var(--danger-soft); color: var(--danger-deep); font-size: var(--fs-sm); }
.inline-error.compact { align-self: center; padding: var(--sp-1) var(--sp-3); }
.spinner { width: 16px; height: 16px; border: 2px solid var(--border-strong); border-top-color: var(--primary); border-radius: var(--r-pill); animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.rsa-workspace { display: flex; flex-direction: column; gap: var(--sp-3); }
.rsa-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(300px, 0.8fr) minmax(420px, 1.2fr); gap: var(--sp-3); }
.key-panel { display: flex; flex-direction: column; }
.key-editor { font-size: var(--fs-xs); }
.rsa-message { min-height: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.rsa-runbar { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; min-height: 34px; }
.rsa-editors { flex: 1; min-height: 0; display: grid; grid-template-rows: repeat(2, minmax(120px, 1fr)); gap: var(--sp-3); }

.file-workspace, .password-workspace { display: flex; flex-direction: column; gap: var(--sp-3); }
.file-controls { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--sp-4); }
.algorithm-checks { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); }
.algorithm-checks > span { width: 100%; }
.algorithm-checks label, .charset-options label { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--text-weak); font-size: var(--fs-sm); cursor: pointer; white-space: nowrap; }
.algorithm-checks input, .charset-options input { accent-color: var(--primary); }
.hidden-file { display: none; }
.file-drop { flex-shrink: 0; min-height: 120px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); border: 1px dashed var(--border-strong); border-radius: var(--r-md); background: var(--card); color: var(--text); cursor: pointer; }
.file-drop:hover, .file-drop.dragging { border-color: var(--primary); background: var(--primary-soft); }
.file-icon { width: 44px; height: 44px; display: grid; place-items: center; border-radius: var(--r-pill); background: var(--primary-soft); color: var(--primary-hover); }
.file-drop b { max-width: 80%; overflow: hidden; font-size: var(--fs-base); text-overflow: ellipsis; white-space: nowrap; }
.file-drop > span:not(.file-icon) { color: var(--muted); font-size: var(--fs-sm); }
.progress-row { display: grid; grid-template-columns: minmax(0, 1fr) 42px; align-items: center; gap: var(--sp-3); }
.progress-row > div { height: 8px; overflow: hidden; border-radius: var(--r-pill); background: var(--well); }
.progress-row > div span { display: block; height: 100%; border-radius: inherit; background: var(--primary); transition: width 0.15s; }
.progress-row b { color: var(--primary-hover); font-family: var(--font-num); font-size: var(--fs-sm); }
.hash-results { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.hash-row { display: grid; grid-template-columns: 82px minmax(0, 1fr) 24px; align-items: center; gap: var(--sp-3); min-height: 50px; padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); }
.hash-row:last-child { border-bottom: none; }
.hash-row b { color: var(--primary-hover); font-family: var(--font-num); font-size: var(--fs-sm); }
.hash-row code { overflow: hidden; color: var(--text-code); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }

.password-controls { display: flex; align-items: flex-end; gap: var(--sp-4); }
.length-control { flex: 1; min-width: 220px; display: flex; align-items: flex-end; gap: var(--sp-3); }
.length-control label { display: flex; flex-direction: column; gap: var(--sp-1); }
.length-control label span { color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
.length-control input[type="number"] { width: 80px; height: 34px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card); color: var(--text); }
.length-control input[type="range"] { flex: 1; height: 34px; accent-color: var(--primary); }
.count-field { width: 80px; }
.charset-options { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); }
.password-summary { flex-shrink: 0; min-height: 42px; display: flex; align-items: center; gap: var(--sp-3); padding: 0 var(--sp-4); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card); }
.password-summary > span { color: var(--muted); font-size: var(--fs-sm); }
.password-summary b { color: var(--success-deep); font-size: var(--fs-md); }
.password-summary code { color: var(--text-code); font-size: var(--fs-sm); }
.password-summary button { margin-left: auto; }
.copy-all-btn { min-width: 6em; justify-content: center; }
.copy-all-btn.copied, .password-copy-btn.copied { border-color: var(--success-border); background: var(--success-soft); color: var(--success-deep); }
.password-list { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.password-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) 24px; align-items: center; gap: var(--sp-3); min-height: 48px; padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); }
.password-row:last-child { border-bottom: none; }
.password-row > span { color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.password-row code { overflow: hidden; color: var(--text-code); font-size: var(--fs-md); text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 820px) {
  .control-bar, .file-controls, .password-controls { flex-wrap: wrap; }
  .hmac-controls .secret-field, .aes-controls .secret-field { flex-basis: 100%; max-width: none; order: -1; }
  .split-workspace { grid-template-columns: 1fr; grid-template-rows: repeat(2, minmax(160px, 1fr)); overflow: auto; }
  .rsa-grid { grid-template-columns: 1fr; grid-template-rows: minmax(190px, 0.8fr) minmax(280px, 1.2fr); overflow: auto; }
  .file-controls > button { align-self: flex-end; }
  .password-controls .length-control { flex-basis: 100%; }
  .charset-options { flex: 1; }
}
</style>
