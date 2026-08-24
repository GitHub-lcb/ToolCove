<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import {
  addDateTime,
  calculateDateDifference,
  convertZonedDateTime,
  formatInstant,
  getNextCronRuns,
  parseTimestamp,
  toDateTimeInput,
} from "../timeTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t, locale } = useI18n();

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
const ZONES = computed(() => [
  { value: localZone, label: t("toolbox.time.zoneLocal", { zone: localZone }) },
  { value: "Asia/Shanghai", label: t("toolbox.time.zoneShanghai") },
  { value: "UTC", label: "UTC · UTC+0" },
  { value: "Asia/Tokyo", label: t("toolbox.time.zoneTokyo") },
  { value: "America/New_York", label: t("toolbox.time.zoneNewYork") },
  { value: "America/Los_Angeles", label: t("toolbox.time.zoneLosAngeles") },
  { value: "Europe/London", label: t("toolbox.time.zoneLondon") },
  { value: "Europe/Berlin", label: t("toolbox.time.zoneBerlin") },
  { value: "Australia/Sydney", label: t("toolbox.time.zoneSydney") },
].filter((item, index, list) => list.findIndex((candidate) => candidate.value === item.value) === index));

const TABS = computed(() => [
  { key: "timestamp", label: t("toolbox.time.tabTimestamp") },
  { key: "timezone", label: t("toolbox.time.tabTimezone") },
  { key: "calculate", label: t("toolbox.time.tabCalculate") },
  { key: "cron", label: t("toolbox.time.tabCron") },
]);
const UNITS = computed(() => [
  { value: "years", label: t("toolbox.time.unitYears") },
  { value: "months", label: t("toolbox.time.unitMonths") },
  { value: "weeks", label: t("toolbox.time.unitWeeks") },
  { value: "days", label: t("toolbox.time.unitDays") },
  { value: "hours", label: t("toolbox.time.unitHours") },
  { value: "minutes", label: t("toolbox.time.unitMinutes") },
  { value: "seconds", label: t("toolbox.time.unitSeconds") },
]);
const CRON_PRESETS = computed(() => [
  { label: t("toolbox.time.presetEvery5"), value: "*/5 * * * *" },
  { label: t("toolbox.time.presetDaily0"), value: "0 0 * * *" },
  { label: t("toolbox.time.presetWorkday9"), value: "0 9 * * 1-5" },
  { label: t("toolbox.time.presetMonth1"), value: "0 0 1 * *" },
]);

const activeTab = ref("timestamp");
const nowMs = ref(Date.now());
let clockTimer;

onMounted(() => {
  clockTimer = window.setInterval(() => { nowMs.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => window.clearInterval(clockTimer));

const timestampInput = ref(String(Date.now()));
const timestampUnit = ref("auto");
const timestampZone = ref(localZone);
const timestampResult = computed(() => safeResult(() => {
  const parsed = parseTimestamp(timestampInput.value, timestampUnit.value);
  return { parsed, formatted: formatInstant(parsed.milliseconds, timestampZone.value) };
}));
const currentTimestamp = computed(() => ({
  seconds: Math.trunc(nowMs.value / 1000),
  milliseconds: nowMs.value,
}));

const sourceZone = ref(localZone);
const targetZone = ref(localZone === "UTC" ? "Asia/Shanghai" : "UTC");
const timezoneInput = ref(toDateTimeInput(Date.now(), sourceZone.value));
const timezoneResult = computed(() => safeResult(() =>
  convertZonedDateTime(timezoneInput.value, sourceZone.value, targetZone.value)
));

const calcMode = ref("add");
const calcZone = ref(localZone);
const calcStart = ref(toDateTimeInput(Date.now(), calcZone.value));
const calcAmount = ref(1);
const calcUnit = ref("days");
const calcEnd = ref(toDateTimeInput(Date.now() + 86_400_000, calcZone.value));
const addResult = computed(() => safeResult(() =>
  addDateTime(calcStart.value, calcAmount.value, calcUnit.value, calcZone.value)
));
const differenceResult = computed(() => safeResult(() =>
  calculateDateDifference(calcStart.value, calcEnd.value, calcZone.value)
));

const cronExpression = ref("0 9 * * 1-5");
const cronZone = ref(localZone);
const cronBase = ref(toDateTimeInput(Date.now(), cronZone.value));
const cronCount = ref(5);
const cronResult = computed(() => safeResult(() => {
  const currentDate = convertZonedDateTime(cronBase.value, cronZone.value, cronZone.value).timestamp;
  return getNextCronRuns(cronExpression.value, {
    zone: cronZone.value,
    currentDate,
    count: cronCount.value,
  });
}));

function safeResult(fn) {
  try {
    return { data: fn(), error: "" };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function useCurrentTimestamp(unit) {
  timestampUnit.value = unit;
  timestampInput.value = String(unit === "seconds" ? currentTimestamp.value.seconds : currentTimestamp.value.milliseconds);
}

function useTimezoneNow() {
  timezoneInput.value = toDateTimeInput(Date.now(), sourceZone.value);
}

function swapZones() {
  const instant = timezoneResult.value.data?.timestamp;
  [sourceZone.value, targetZone.value] = [targetZone.value, sourceZone.value];
  if (instant) timezoneInput.value = toDateTimeInput(instant, sourceZone.value);
}

function applyCronPreset(value) {
  cronExpression.value = value;
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat(locale.value, { maximumFractionDigits: digits }).format(value);
}

function durationText(data) {
  if (!data || data.totalMilliseconds === 0) return t("toolbox.time.durationSame");
  const direction = data.totalMilliseconds > 0 ? t("toolbox.time.durationLater") : t("toolbox.time.durationEarlier");
  const parts = [];
  if (data.days) parts.push(t("toolbox.time.durDays", { count: Math.abs(data.days) }));
  if (data.hours) parts.push(t("toolbox.time.durHours", { count: Math.abs(data.hours) }));
  if (data.minutes) parts.push(t("toolbox.time.durMinutes", { count: Math.abs(data.minutes) }));
  if (data.seconds) parts.push(t("toolbox.time.durSeconds", { count: Math.abs(data.seconds) }));
  return `${direction} · ${parts.join(" ") || t("toolbox.time.durSubSecond")}`;
}

async function copyText(value, label) {
  if (value === "" || value === null || value === undefined) return props.showToast(t("toolbox.time.copyEmpty"));
  try {
    await navigator.clipboard.writeText(String(value));
    props.showToast(t("toolbox.time.copied", { label }));
  } catch (e) {
    props.showToast(t("toolbox.time.copyFailed", { err: String(e) }));
  }
}
</script>

<template>
  <div class="time-tool">
    <nav class="mode-tabs" :aria-label="t('toolbox.time.navLabel')">
      <button v-for="tab in TABS" :key="tab.key" type="button" class="mode-tab" :class="{ on: activeTab === tab.key }" @click="activeTab = tab.key">
        {{ tab.label }}
      </button>
    </nav>

    <section v-if="activeTab === 'timestamp'" class="tool-workspace timestamp-workspace">
      <div class="control-panel">
        <div class="live-time">
          <span>{{ t("toolbox.time.liveTitle") }}</span>
          <button type="button" :title="t('toolbox.time.liveSecTitle')" @click="useCurrentTimestamp('seconds')">
            <b>{{ currentTimestamp.seconds }}</b><small>{{ t("toolbox.time.secShort") }}</small>
          </button>
          <button type="button" :title="t('toolbox.time.liveMsTitle')" @click="useCurrentTimestamp('milliseconds')">
            <b>{{ currentTimestamp.milliseconds }}</b><small>{{ t("toolbox.time.msShort") }}</small>
          </button>
        </div>
        <label class="field wide">
          <span>{{ t("toolbox.time.timestampLabel") }}</span>
          <input v-model.trim="timestampInput" class="mono" inputmode="numeric" :placeholder="t('toolbox.time.timestampPh')" />
        </label>
        <div class="field-row">
          <label class="field">
            <span>{{ t("toolbox.time.unitLabel") }}</span>
            <select v-model="timestampUnit">
              <option value="auto">{{ t("toolbox.time.unitAuto") }}</option>
              <option value="seconds">{{ t("toolbox.time.unitSeconds") }}</option>
              <option value="milliseconds">{{ t("toolbox.time.unitMilliseconds") }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t("toolbox.time.zoneLabel") }}</span>
            <select v-model="timestampZone">
              <option v-for="zone in ZONES" :key="zone.value" :value="zone.value">{{ zone.label }}</option>
            </select>
          </label>
        </div>
      </div>

      <div class="result-panel">
        <div v-if="timestampResult.error" class="error-state" role="alert"><Icon name="alert" :size="20" /><span>{{ timestampResult.error }}</span></div>
        <template v-else>
          <header class="result-head"><b>{{ timestampResult.data.formatted.dateTime }}</b><span>{{ timestampResult.data.formatted.weekday }} · {{ timestampResult.data.formatted.offset }}</span></header>
          <div class="result-rows">
            <div class="result-row"><span>{{ t("toolbox.time.copySecLabel") }}</span><code>{{ timestampResult.data.parsed.seconds }}</code><button class="icon-btn xs" :title="t('toolbox.time.copySecTitle')" @click="copyText(timestampResult.data.parsed.seconds, t('toolbox.time.copySecLabel'))"><Icon name="copy" :size="13" /></button></div>
            <div class="result-row"><span>{{ t("toolbox.time.copyMsLabel") }}</span><code>{{ timestampResult.data.parsed.milliseconds }}</code><button class="icon-btn xs" :title="t('toolbox.time.copyMsTitle')" @click="copyText(timestampResult.data.parsed.milliseconds, t('toolbox.time.copyMsLabel'))"><Icon name="copy" :size="13" /></button></div>
            <div class="result-row"><span>ISO 8601</span><code :title="timestampResult.data.formatted.iso">{{ timestampResult.data.formatted.iso }}</code><button class="icon-btn xs" :title="t('toolbox.time.copyIsoTitle')" @click="copyText(timestampResult.data.formatted.iso, t('toolbox.time.copyIsoLabel'))"><Icon name="copy" :size="13" /></button></div>
            <div class="result-row"><span>UTC</span><code>{{ formatInstant(timestampResult.data.parsed.milliseconds, 'UTC').dateTime }}</code><button class="icon-btn xs" :title="t('toolbox.time.copyUtcTitle')" @click="copyText(formatInstant(timestampResult.data.parsed.milliseconds, 'UTC').dateTime, t('toolbox.time.copyUtcLabel'))"><Icon name="copy" :size="13" /></button></div>
          </div>
        </template>
      </div>
    </section>

    <section v-else-if="activeTab === 'timezone'" class="tool-workspace timezone-workspace">
      <div class="timezone-form">
        <label class="field wide"><span>{{ t("toolbox.time.datetimeLabel") }}</span><input v-model="timezoneInput" type="datetime-local" step="1" /></label>
        <button class="btn-ghost sm now-btn" type="button" @click="useTimezoneNow"><Icon name="clock" :size="14" />{{ t("toolbox.time.nowBtn") }}</button>
        <label class="field"><span>{{ t("toolbox.time.sourceZoneLabel") }}</span><select v-model="sourceZone"><option v-for="zone in ZONES" :key="zone.value" :value="zone.value">{{ zone.label }}</option></select></label>
        <button class="icon-btn swap-btn" type="button" :title="t('toolbox.time.swapTitle')" :aria-label="t('toolbox.time.swapTitle')" @click="swapZones"><Icon name="repeat" :size="16" /></button>
        <label class="field"><span>{{ t("toolbox.time.targetZoneLabel") }}</span><select v-model="targetZone"><option v-for="zone in ZONES" :key="zone.value" :value="zone.value">{{ zone.label }}</option></select></label>
      </div>
      <div v-if="timezoneResult.error" class="error-state full" role="alert"><Icon name="alert" :size="20" /><span>{{ timezoneResult.error }}</span></div>
      <div v-else class="zone-results">
        <div class="zone-result source"><span>{{ timezoneResult.data.source.zone }} · {{ timezoneResult.data.source.offset }}</span><b>{{ timezoneResult.data.source.dateTime }}</b><small>{{ timezoneResult.data.source.weekday }}</small></div>
        <Icon name="chevron-right" :size="20" class="zone-arrow" />
        <div class="zone-result target"><span>{{ timezoneResult.data.target.zone }} · {{ timezoneResult.data.target.offset }}</span><b>{{ timezoneResult.data.target.dateTime }}</b><small>{{ timezoneResult.data.target.weekday }}</small></div>
      </div>
    </section>

    <section v-else-if="activeTab === 'calculate'" class="tool-workspace calculate-workspace">
      <div class="calc-switch" role="group" :aria-label="t('toolbox.time.calcAria')">
        <button type="button" :class="{ on: calcMode === 'add' }" @click="calcMode = 'add'">{{ t("toolbox.time.calcModeAdd") }}</button>
        <button type="button" :class="{ on: calcMode === 'diff' }" @click="calcMode = 'diff'">{{ t("toolbox.time.calcModeDiff") }}</button>
      </div>
      <label class="field zone-field"><span>{{ t("toolbox.time.calcZoneLabel") }}</span><select v-model="calcZone"><option v-for="zone in ZONES" :key="zone.value" :value="zone.value">{{ zone.label }}</option></select></label>

      <template v-if="calcMode === 'add'">
        <div class="calc-form">
          <label class="field"><span>{{ t("toolbox.time.baseTimeLabel") }}</span><input v-model="calcStart" type="datetime-local" step="1" /></label>
          <label class="field amount-field"><span>{{ t("toolbox.time.amountLabel") }}</span><input v-model.number="calcAmount" type="number" /></label>
          <label class="field unit-field"><span>{{ t("toolbox.time.unitLabel") }}</span><select v-model="calcUnit"><option v-for="unit in UNITS" :key="unit.value" :value="unit.value">{{ unit.label }}</option></select></label>
        </div>
        <div v-if="addResult.error" class="error-state full" role="alert"><Icon name="alert" :size="20" /><span>{{ addResult.error }}</span></div>
        <div v-else class="calc-result"><span>{{ t("toolbox.time.resultLabel") }}</span><b>{{ addResult.data.dateTime }}</b><small>{{ addResult.data.weekday }} · {{ addResult.data.offset }}</small><button class="icon-btn" :title="t('toolbox.time.copyResultTitle')" @click="copyText(addResult.data.dateTime, t('toolbox.time.copyResultLabel'))"><Icon name="copy" :size="14" /></button></div>
      </template>

      <template v-else>
        <div class="calc-form diff-form">
          <label class="field"><span>{{ t("toolbox.time.startLabel") }}</span><input v-model="calcStart" type="datetime-local" step="1" /></label>
          <label class="field"><span>{{ t("toolbox.time.endLabel") }}</span><input v-model="calcEnd" type="datetime-local" step="1" /></label>
        </div>
        <div v-if="differenceResult.error" class="error-state full" role="alert"><Icon name="alert" :size="20" /><span>{{ differenceResult.error }}</span></div>
        <div v-else class="duration-result">
          <header><b>{{ durationText(differenceResult.data) }}</b><span>{{ t("toolbox.time.totalMs", { count: formatNumber(differenceResult.data.totalMilliseconds) }) }}</span></header>
          <div class="duration-stats"><span><b>{{ formatNumber(differenceResult.data.totalHours, 3) }}</b>{{ t("toolbox.time.unitHours") }}</span><span><b>{{ formatNumber(differenceResult.data.totalMinutes, 3) }}</b>{{ t("toolbox.time.unitMinutes") }}</span><span><b>{{ formatNumber(differenceResult.data.totalSeconds, 3) }}</b>{{ t("toolbox.time.unitSeconds") }}</span></div>
        </div>
      </template>
    </section>

    <section v-else class="tool-workspace cron-workspace">
      <div class="cron-form">
        <label class="field cron-expression"><span>{{ t("toolbox.time.cronExprLabel") }}</span><input v-model.trim="cronExpression" class="mono" placeholder="0 9 * * 1-5" /></label>
        <label class="field"><span>{{ t("toolbox.time.cronZoneLabel") }}</span><select v-model="cronZone"><option v-for="zone in ZONES" :key="zone.value" :value="zone.value">{{ zone.label }}</option></select></label>
        <label class="field"><span>{{ t("toolbox.time.cronBaseLabel") }}</span><input v-model="cronBase" type="datetime-local" step="1" /></label>
        <label class="field count-field"><span>{{ t("toolbox.time.cronCountLabel") }}</span><select v-model.number="cronCount"><option :value="5">5</option><option :value="10">10</option><option :value="20">20</option></select></label>
      </div>
      <div class="preset-row"><button v-for="preset in CRON_PRESETS" :key="preset.value" type="button" :class="{ on: cronExpression === preset.value }" @click="applyCronPreset(preset.value)">{{ preset.label }}</button></div>
      <div v-if="cronResult.error" class="error-state full" role="alert"><Icon name="alert" :size="20" /><span>{{ cronResult.error }}</span></div>
      <div v-else class="cron-results">
        <div v-for="(run, index) in cronResult.data" :key="run.timestamp" class="cron-row">
          <span class="run-index">{{ index + 1 }}</span><b>{{ run.dateTime }}</b><span>{{ run.weekday }}</span><code>{{ run.offset }}</code>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.time-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.mode-tabs { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border); }
.mode-tab { flex-shrink: 0; padding: var(--sp-2) var(--sp-4); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text-weak); font-size: var(--fs-md); cursor: pointer; transition: color 0.15s, background 0.15s, border-color 0.15s; }
.mode-tab:hover { color: var(--text); background: var(--ghost); }
.mode-tab.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }
.tool-workspace { flex: 1; min-height: 0; overflow: auto; }
.field { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.field > span { color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
.field input, .field select { width: 100%; min-width: 0; height: 36px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none; background: var(--card); color: var(--text); font-size: var(--fs-md); }
.field input:focus, .field select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.field .mono, code { font-family: var(--font-mono); }
.field-row { display: grid; grid-template-columns: minmax(120px, 0.7fr) minmax(180px, 1.3fr); gap: var(--sp-3); }
.error-state { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-4); border: 1px solid var(--border-danger); border-radius: var(--r-sm); background: var(--danger-soft); color: var(--danger-deep); font-size: var(--fs-sm); }
.error-state.full { justify-content: center; min-height: 100px; }

.timestamp-workspace { display: grid; grid-template-columns: minmax(280px, 0.85fr) minmax(360px, 1.15fr); gap: var(--sp-3); }
.control-panel, .result-panel { min-width: 0; padding: var(--sp-5); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.control-panel { display: flex; flex-direction: column; gap: var(--sp-4); }
.live-time { display: grid; grid-template-columns: 1fr; gap: var(--sp-1); padding-bottom: var(--sp-3); border-bottom: 1px solid var(--border); }
.live-time > span { color: var(--muted); font-size: var(--fs-sm); }
.live-time button { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: var(--sp-2); padding: var(--sp-1) 0; border: none; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.live-time button:hover b { color: var(--primary-hover); }
.live-time b { overflow: hidden; font-family: var(--font-num); font-size: var(--fs-lg); text-overflow: ellipsis; }
.live-time small { color: var(--muted); font-size: var(--fs-xs); }
.result-panel { display: flex; flex-direction: column; gap: var(--sp-3); }
.result-head { display: flex; flex-direction: column; gap: var(--sp-1); padding-bottom: var(--sp-3); border-bottom: 1px solid var(--border); }
.result-head b { font-family: var(--font-num); font-size: var(--fs-xl); }
.result-head span { color: var(--muted); font-size: var(--fs-sm); }
.result-rows { display: flex; flex-direction: column; }
.result-row { display: grid; grid-template-columns: 90px minmax(0, 1fr) 24px; align-items: center; gap: var(--sp-2); min-height: 42px; border-bottom: 1px solid var(--border); }
.result-row:last-child { border-bottom: none; }
.result-row > span { color: var(--muted); font-size: var(--fs-sm); }
.result-row code { overflow: hidden; color: var(--text-code); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }

.timezone-workspace, .calculate-workspace, .cron-workspace { display: flex; flex-direction: column; gap: var(--sp-4); }
.timezone-form { display: grid; grid-template-columns: minmax(200px, 1.2fr) auto minmax(180px, 1fr) auto minmax(180px, 1fr); align-items: end; gap: var(--sp-3); padding: var(--sp-5); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.now-btn { height: 36px; white-space: nowrap; }
.swap-btn { margin-bottom: 3px; }
.zone-results { flex: 1; min-height: 220px; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: var(--sp-5); }
.zone-result { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-7); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.zone-result.source { border-left: 3px solid var(--primary); }
.zone-result.target { border-left: 3px solid var(--success); }
.zone-result span, .zone-result small { color: var(--muted); font-size: var(--fs-sm); }
.zone-result b { font-family: var(--font-num); font-size: var(--fs-xl); white-space: nowrap; }
.zone-arrow { color: var(--muted); }

.calculate-workspace { position: relative; }
.calc-switch { align-self: flex-start; display: inline-grid; grid-template-columns: repeat(2, minmax(76px, 1fr)); padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.calc-switch button { padding: var(--sp-1) var(--sp-4); border: none; border-radius: var(--r-xs); background: transparent; color: var(--muted); font-size: var(--fs-sm); cursor: pointer; }
.calc-switch button.on { background: var(--card); color: var(--primary-hover); box-shadow: var(--shadow); font-weight: 600; }
.zone-field { position: absolute; top: 0; right: 0; width: min(260px, 42%); }
.calc-form { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(120px, 0.45fr) minmax(120px, 0.45fr); gap: var(--sp-3); padding: var(--sp-5); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.calc-form.diff-form { grid-template-columns: repeat(2, minmax(220px, 1fr)); }
.calc-result { display: grid; grid-template-columns: auto minmax(0, 1fr) auto 30px; align-items: center; gap: var(--sp-4); min-height: 110px; padding: var(--sp-7); border: 1px solid var(--border-blue); border-radius: var(--r-md); background: var(--primary-soft); }
.calc-result > span { color: var(--text-weak); font-size: var(--fs-sm); }
.calc-result > b { font-family: var(--font-num); font-size: var(--fs-xl); }
.calc-result > small { color: var(--muted); font-size: var(--fs-sm); }
.duration-result { display: flex; flex-direction: column; gap: var(--sp-5); padding: var(--sp-7); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.duration-result header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); }
.duration-result header b { font-size: var(--fs-lg); }
.duration-result header span { color: var(--muted); font-family: var(--font-num); font-size: var(--fs-sm); }
.duration-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-3); }
.duration-stats span { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-4); border-radius: var(--r-sm); background: var(--well); color: var(--muted); font-size: var(--fs-sm); }
.duration-stats b { color: var(--text); font-family: var(--font-num); font-size: var(--fs-lg); }

.cron-form { display: grid; grid-template-columns: minmax(210px, 1fr) minmax(180px, 0.8fr) minmax(210px, 0.9fr) 78px; gap: var(--sp-3); padding: var(--sp-5); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.preset-row { display: flex; gap: var(--sp-2); overflow-x: auto; }
.preset-row button { flex-shrink: 0; padding: var(--sp-1) var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-pill); background: var(--card); color: var(--text-weak); font-size: var(--fs-sm); cursor: pointer; }
.preset-row button:hover, .preset-row button.on { border-color: var(--border-blue); background: var(--primary-soft); color: var(--primary-hover); }
.cron-results { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.cron-row { display: grid; grid-template-columns: 34px minmax(180px, 1fr) minmax(70px, 0.45fr) 70px; align-items: center; gap: var(--sp-3); min-height: 42px; padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); }
.cron-row:last-child { border-bottom: none; }
.run-index { width: 24px; height: 24px; display: grid; place-items: center; border-radius: var(--r-pill); background: var(--primary-soft); color: var(--primary-hover); font-family: var(--font-num); font-size: var(--fs-xs); }
.cron-row b { font-family: var(--font-num); font-size: var(--fs-md); }
.cron-row > span:not(.run-index), .cron-row code { color: var(--muted); font-size: var(--fs-sm); }

@media (max-width: 820px) {
  .timestamp-workspace { grid-template-columns: 1fr; }
  .timezone-form { grid-template-columns: minmax(200px, 1fr) auto minmax(180px, 1fr); }
  .timezone-form .swap-btn { display: none; }
  .timezone-form .field:last-child { grid-column: 1 / 4; }
  .zone-results { min-width: 600px; }
  .timezone-workspace { overflow-x: auto; }
  .calc-form, .cron-form { grid-template-columns: repeat(2, minmax(200px, 1fr)); }
  .cron-form .count-field { min-width: 0; }
}
</style>
