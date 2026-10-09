<script setup>
// 截图工具页（tool-screenshot 窗口）：快捷键设置 + 用法说明 + 立即截图入口。
// 真正的截屏动作全部发生在 Rust 侧拉起的遮罩窗里（?shot=overlay），本页只是「控制台」。
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import Icon from "../Icon.vue";
import { acceleratorFromEvent, acceleratorParts } from "../screenshot/hotkey.js";

const props = defineProps({ showToast: { type: Function, default: () => {} } });

const { t } = useI18n();
const toast = (message) => props.showToast(message);

const EMPTY_SETTINGS = { captureHotkey: "", pinHotkey: "", captureRegistered: false, pinRegistered: false };
const settings = ref({ ...EMPTY_SETTINGS });
const loadError = ref("");
const recording = ref(""); // "" | "capture" | "pin"
const starting = ref(false);

const GUIDE_STEPS = ["guideCapture", "guideAnnotate", "guideConfirm", "guideEsc"];
const KEY_ROWS = [
  { keys: ["Enter", "Ctrl+C"], labelKey: "keyCopy" },
  { keys: ["Ctrl+S"], labelKey: "keySave" },
  { keys: ["F3"], labelKey: "keyPin" },
  { keys: ["Ctrl+Z"], labelKey: "keyUndo" },
  { keys: ["Ctrl+Shift+Z", "Ctrl+Y"], labelKey: "keyRedo" },
  { keys: ["↑", "↓", "←", "→"], labelKey: "keyNudge" },
  { keys: ["Esc"], labelKey: "keyCancel" },
];

async function load() {
  try {
    // 命令返回 null（老版本 / 命令未注册）时退回空状态渲染，而不是让模板读到 null 崩掉
    settings.value = { ...EMPTY_SETTINGS, ...((await invoke("screenshot_settings_get")) || {}) };
    loadError.value = "";
  } catch (e) {
    loadError.value = String(e?.message || e);
  }
}

onMounted(load);

const captureStatus = computed(() => statusOf("captureHotkey", "captureRegistered"));
const pinStatus = computed(() => statusOf("pinHotkey", "pinRegistered"));
function statusOf(key, flag) {
  const value = settings.value[key];
  if (!value) return { kind: "off", textKey: "hotkeyOff" };
  return settings.value[flag] ? { kind: "on", textKey: "hotkeyActive" } : { kind: "warn", textKey: "hotkeyOccupied" };
}

function startRecording(field) {
  recording.value = field;
}

/** 录制键按下：Esc 取消；Backspace/Delete 关闭该热键；其余取可绑定的主键 + 修饰键 */
function onRecordKeydown(event) {
  if (!recording.value) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    recording.value = "";
    return;
  }
  if (event.key === "Backspace" || event.key === "Delete") {
    const field = recording.value;
    recording.value = "";
    save({ ...settings.value, [field === "capture" ? "captureHotkey" : "pinHotkey"]: "" });
    return;
  }
  const accelerator = acceleratorFromEvent(event);
  if (!accelerator) return; // 纯修饰键：继续等主键
  const field = recording.value;
  recording.value = "";
  save({ ...settings.value, [field === "capture" ? "captureHotkey" : "pinHotkey"]: accelerator });
}

async function save(next) {
  try {
    const info = await invoke("screenshot_settings_set", {
      captureHotkey: next.captureHotkey,
      pinHotkey: next.pinHotkey,
    });
    settings.value = { ...EMPTY_SETTINGS, ...(info || {}) };
    toast(t("screenshot.hotkeySaved"));
  } catch (e) {
    toast(String(e?.message || e));
    await load(); // 失败即回滚：以 Rust 侧真实状态为准
  }
}

function restoreDefaults() {
  save({ captureHotkey: "F1", pinHotkey: "F3" });
}

async function captureNow() {
  if (starting.value) return;
  starting.value = true;
  try {
    await invoke("screenshot_begin");
    toast(t("screenshot.beginToast"));
  } catch (e) {
    toast(String(e?.message || e));
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <div class="shot-tool">
    <header class="st-head">
      <h2>{{ t("toolbox.registry.toolScreenshot") }}</h2>
      <p class="st-sub">{{ t("screenshot.subtitle") }}</p>
    </header>

    <section class="st-card">
      <div class="st-row">
        <div class="st-row-main">
          <b>{{ t("screenshot.actionNow") }}</b>
          <span class="st-hint">{{ t("screenshot.actionHint") }}</span>
        </div>
        <button class="btn-primary" :disabled="starting || !!loadError" data-role="capture-now" @click="captureNow">
          <Icon name="crop" :size="15" />{{ t("screenshot.actionNow") }}
        </button>
      </div>
      <p v-if="loadError" class="st-error">{{ loadError }}</p>
    </section>

    <section class="st-card">
      <h3>{{ t("screenshot.hotkeySection") }}</h3>
      <div class="st-hk" v-for="item in [{ field: 'capture', labelKey: 'hotkeyCapture', status: captureStatus }, { field: 'pin', labelKey: 'hotkeyPin', status: pinStatus }]" :key="item.field">
        <span class="st-hk-label">{{ t(`screenshot.${item.labelKey}`) }}</span>
        <button
          class="st-hk-key"
          :class="{ rec: recording === item.field }"
          :data-role="'hotkey-' + item.field"
          @click="startRecording(item.field)"
          @keydown="onRecordKeydown"
          @blur="recording = ''"
        >
          <template v-if="recording === item.field">{{ t("screenshot.recordHint") }}</template>
          <template v-else-if="item.field === 'capture' ? settings.captureHotkey : settings.pinHotkey">
            <kbd v-for="part in acceleratorParts(item.field === 'capture' ? settings.captureHotkey : settings.pinHotkey)" :key="part">{{ part }}</kbd>
          </template>
          <template v-else>{{ t("screenshot.hotkeyOff") }}</template>
        </button>
        <span class="st-chip" :class="item.status.kind">{{ t(`screenshot.${item.status.textKey}`) }}</span>
      </div>
      <div class="st-hk-foot">
        <span class="st-hint">{{ t("screenshot.hotkeyGlobalHint") }}</span>
        <button class="btn-ghost sm" data-role="hotkey-default" @click="restoreDefaults"><Icon name="repeat" :size="13" />{{ t("screenshot.hotkeyRestore") }}</button>
      </div>
    </section>

    <section class="st-card">
      <h3>{{ t("screenshot.guideTitle") }}</h3>
      <ol class="st-steps">
        <li v-for="step in GUIDE_STEPS" :key="step">{{ t(`screenshot.${step}`) }}</li>
      </ol>
      <table class="st-keys">
        <tbody>
          <tr v-for="row in KEY_ROWS" :key="row.labelKey">
            <td class="st-keys-cell"><kbd v-for="k in row.keys" :key="k">{{ k }}</kbd></td>
            <td>{{ t(`screenshot.${row.labelKey}`) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="st-card">
      <h3>{{ t("screenshot.pinTitle") }}</h3>
      <ul class="st-list">
        <li>{{ t("screenshot.pinGuide1") }}</li>
        <li>{{ t("screenshot.pinGuide2") }}</li>
        <li>{{ t("screenshot.pinGuide3") }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.shot-tool { padding: 20px 24px 32px; display: flex; flex-direction: column; gap: 14px; max-width: 780px; }
.st-head h2 { margin: 0 0 6px; font-size: var(--fs-xl); }
.st-sub { margin: 0; color: var(--muted); font-size: var(--fs-md); line-height: var(--lh-body); }

.st-card { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); padding: 14px 16px; }
.st-card h3 { margin: 0 0 10px; font-size: var(--fs-base); }

.st-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.st-row-main { display: flex; flex-direction: column; gap: 3px; }
.st-hint { color: var(--muted); font-size: var(--fs-sm); }
.st-error { margin: 10px 0 0; color: var(--danger); font-size: var(--fs-sm); }

.st-hk { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.st-hk-label { width: 64px; color: var(--text-weak); font-size: var(--fs-md); }
.st-hk-key {
  display: inline-flex; align-items: center; gap: 4px; min-width: 168px;
  padding: 6px 10px; background: var(--ghost); border: 1px solid var(--border-strong);
  border-radius: var(--r-sm); color: var(--text); font-size: var(--fs-md); cursor: pointer;
}
.st-hk-key:hover { border-color: var(--primary); }
.st-hk-key.rec { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }
.st-hk-key kbd { padding: 1px 6px; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: var(--r-xs); background: var(--card); font-family: var(--font-mono); font-size: var(--fs-xs); }

.st-chip { font-size: var(--fs-xs); font-weight: 600; padding: 2px 9px; border-radius: var(--r-pill); }
.st-chip.on { color: var(--success-deep); background: var(--success-soft); }
.st-chip.warn { color: var(--warn-deep); background: var(--amber-soft); }
.st-chip.off { color: var(--text-soft); background: var(--well); }

.st-hk-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 6px; }

.st-steps { margin: 0 0 12px; padding-left: 20px; color: var(--text); font-size: var(--fs-md); line-height: var(--lh-body); }
.st-steps li { margin: 3px 0; }

.st-keys { width: 100%; border-collapse: collapse; font-size: var(--fs-md); }
.st-keys td { padding: 5px 0; border-top: 1px solid var(--border); }
.st-keys-cell { width: 200px; }
.st-keys kbd { display: inline-block; margin-right: 4px; padding: 1px 7px; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: var(--r-xs); background: var(--ghost); font-family: var(--font-mono); font-size: var(--fs-xs); }

.st-list { margin: 0; padding-left: 20px; color: var(--text); font-size: var(--fs-md); line-height: var(--lh-body); }
.st-list li { margin: 3px 0; }
</style>
