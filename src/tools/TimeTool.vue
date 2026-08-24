<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
const ZONES = [
  { value: localZone, label: `本机 · ${localZone}` },
  { value: "Asia/Shanghai", label: "上海 · UTC+8" },
  { value: "UTC", label: "UTC · UTC+0" },
  { value: "Asia/Tokyo", label: "东京 · UTC+9" },
  { value: "America/New_York", label: "纽约" },
  { value: "America/Los_Angeles", label: "洛杉矶" },
  { value: "Europe/London", label: "伦敦" },
  { value: "Europe/Berlin", label: "柏林" },
  { value: "Australia/Sydney", label: "悉尼" },
].filter((item, index, list) => list.findIndex((candidate) => candidate.value === item.value) === index);

const TABS = [
  { key: "timestamp", label: "时间戳" },
  { key: "timezone", label: "时区换算" },
  { key: "calculate", label: "日期计算" },
  { key: "cron", label: "Cron" },
];
const UNITS = [
  { value: "years", label: "年" },
  { value: "months", label: "月" },
  { value: "weeks", label: "周" },
  { value: "days", label: "天" },
  { value: "hours", label: "小时" },
  { value: "minutes", label: "分钟" },
  { value: "seconds", label: "秒" },
];
const CRON_PRESETS = [
  { label: "每 5 分钟", value: "*/5 * * * *" },
  { label: "每天 0 点", value: "0 0 * * *" },
  { label: "工作日 9 点", value: "0 9 * * 1-5" },
  { label: "每月 1 日", value: "0 0 1 * *" },
];

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
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
}

function durationText(data) {
  if (!data || data.totalMilliseconds === 0) return "两个时刻相同";
  const direction = data.totalMilliseconds > 0 ? "结束时间较晚" : "结束时间较早";
  const parts = [];
  if (data.days) parts.push(`${Math.abs(data.days)} 天`);
  if (data.hours) parts.push(`${Math.abs(data.hours)} 小时`);
  if (data.minutes) parts.push(`${Math.abs(data.minutes)} 分钟`);
  if (data.seconds) parts.push(`${Math.abs(data.seconds)} 秒`);
  return `${direction} · ${parts.join(" ") || "不足 1 秒"}`;
}

async function copyText(value, label) {
  if (value === "" || value === null || value === undefined) return props.showToast("没有可复制的内容");
  try {
    await navigator.clipboard.writeText(String(value));
    props.showToast(`已复制${label}`);
  } catch (e) {
    props.showToast("复制失败：" + e);
  }
}
</script>

<template>
  <div class="time-tool">
    <nav class="mode-tabs" aria-label="时间工具类型">
      <button v-for="tab in TABS" :key="tab.key" type="button" class="mode-tab" :class="{ on: activeTab === tab.key }" @click="activeTab = tab.key">
        {{ tab.label }}
      </button>
    </nav>

    <section v-if="activeTab === 'timestamp'" class="tool-workspace timestamp-workspace">
      <div class="control-panel">
        <div class="live-time">
          <span>当前时间戳</span>
          <button type="button" title="使用当前秒级时间戳" @click="useCurrentTimestamp('seconds')">
            <b>{{ currentTimestamp.seconds }}</b><small>秒</small>
          </button>
          <button type="button" title="使用当前毫秒级时间戳" @click="useCurrentTimestamp('milliseconds')">
            <b>{{ currentTimestamp.milliseconds }}</b><small>毫秒</small>
          </button>
        </div>
        <label class="field wide">
          <span>时间戳</span>
          <input v-model.trim="timestampInput" class="mono" inputmode="numeric" placeholder="输入秒或毫秒时间戳" />
        </label>
        <div class="field-row">
          <label class="field">
            <span>单位</span>
            <select v-model="timestampUnit">
              <option value="auto">自动识别</option>
              <option value="seconds">秒</option>
              <option value="milliseconds">毫秒</option>
            </select>
          </label>
          <label class="field">
            <span>显示时区</span>
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
            <div class="result-row"><span>秒时间戳</span><code>{{ timestampResult.data.parsed.seconds }}</code><button class="icon-btn xs" title="复制秒时间戳" @click="copyText(timestampResult.data.parsed.seconds, '秒时间戳')"><Icon name="copy" :size="13" /></button></div>
            <div class="result-row"><span>毫秒时间戳</span><code>{{ timestampResult.data.parsed.milliseconds }}</code><button class="icon-btn xs" title="复制毫秒时间戳" @click="copyText(timestampResult.data.parsed.milliseconds, '毫秒时间戳')"><Icon name="copy" :size="13" /></button></div>
            <div class="result-row"><span>ISO 8601</span><code :title="timestampResult.data.formatted.iso">{{ timestampResult.data.formatted.iso }}</code><button class="icon-btn xs" title="复制 ISO 时间" @click="copyText(timestampResult.data.formatted.iso, ' ISO 时间')"><Icon name="copy" :size="13" /></button></div>
            <div class="result-row"><span>UTC</span><code>{{ formatInstant(timestampResult.data.parsed.milliseconds, 'UTC').dateTime }}</code><button class="icon-btn xs" title="复制 UTC 时间" @click="copyText(formatInstant(timestampResult.data.parsed.milliseconds, 'UTC').dateTime, ' UTC 时间')"><Icon name="copy" :size="13" /></button></div>
          </div>
        </template>
      </div>
    </section>

    <section v-else-if="activeTab === 'timezone'" class="tool-workspace timezone-workspace">
      <div class="timezone-form">
        <label class="field wide"><span>日期时间</span><input v-model="timezoneInput" type="datetime-local" step="1" /></label>
        <button class="btn-ghost sm now-btn" type="button" @click="useTimezoneNow"><Icon name="clock" :size="14" />当前时间</button>
        <label class="field"><span>源时区</span><select v-model="sourceZone"><option v-for="zone in ZONES" :key="zone.value" :value="zone.value">{{ zone.label }}</option></select></label>
        <button class="icon-btn swap-btn" type="button" title="交换源时区与目标时区" aria-label="交换源时区与目标时区" @click="swapZones"><Icon name="repeat" :size="16" /></button>
        <label class="field"><span>目标时区</span><select v-model="targetZone"><option v-for="zone in ZONES" :key="zone.value" :value="zone.value">{{ zone.label }}</option></select></label>
      </div>
      <div v-if="timezoneResult.error" class="error-state full" role="alert"><Icon name="alert" :size="20" /><span>{{ timezoneResult.error }}</span></div>
      <div v-else class="zone-results">
        <div class="zone-result source"><span>{{ timezoneResult.data.source.zone }} · {{ timezoneResult.data.source.offset }}</span><b>{{ timezoneResult.data.source.dateTime }}</b><small>{{ timezoneResult.data.source.weekday }}</small></div>
        <Icon name="chevron-right" :size="20" class="zone-arrow" />
        <div class="zone-result target"><span>{{ timezoneResult.data.target.zone }} · {{ timezoneResult.data.target.offset }}</span><b>{{ timezoneResult.data.target.dateTime }}</b><small>{{ timezoneResult.data.target.weekday }}</small></div>
      </div>
    </section>

    <section v-else-if="activeTab === 'calculate'" class="tool-workspace calculate-workspace">
      <div class="calc-switch" role="group" aria-label="日期计算方式">
        <button type="button" :class="{ on: calcMode === 'add' }" @click="calcMode = 'add'">日期增减</button>
        <button type="button" :class="{ on: calcMode === 'diff' }" @click="calcMode = 'diff'">时间间隔</button>
      </div>
      <label class="field zone-field"><span>计算时区</span><select v-model="calcZone"><option v-for="zone in ZONES" :key="zone.value" :value="zone.value">{{ zone.label }}</option></select></label>

      <template v-if="calcMode === 'add'">
        <div class="calc-form">
          <label class="field"><span>基准时间</span><input v-model="calcStart" type="datetime-local" step="1" /></label>
          <label class="field amount-field"><span>增减数量</span><input v-model.number="calcAmount" type="number" /></label>
          <label class="field unit-field"><span>单位</span><select v-model="calcUnit"><option v-for="unit in UNITS" :key="unit.value" :value="unit.value">{{ unit.label }}</option></select></label>
        </div>
        <div v-if="addResult.error" class="error-state full" role="alert"><Icon name="alert" :size="20" /><span>{{ addResult.error }}</span></div>
        <div v-else class="calc-result"><span>计算结果</span><b>{{ addResult.data.dateTime }}</b><small>{{ addResult.data.weekday }} · {{ addResult.data.offset }}</small><button class="icon-btn" title="复制计算结果" @click="copyText(addResult.data.dateTime, '计算结果')"><Icon name="copy" :size="14" /></button></div>
      </template>

      <template v-else>
        <div class="calc-form diff-form">
          <label class="field"><span>开始时间</span><input v-model="calcStart" type="datetime-local" step="1" /></label>
          <label class="field"><span>结束时间</span><input v-model="calcEnd" type="datetime-local" step="1" /></label>
        </div>
        <div v-if="differenceResult.error" class="error-state full" role="alert"><Icon name="alert" :size="20" /><span>{{ differenceResult.error }}</span></div>
        <div v-else class="duration-result">
          <header><b>{{ durationText(differenceResult.data) }}</b><span>{{ formatNumber(differenceResult.data.totalMilliseconds) }} 毫秒</span></header>
          <div class="duration-stats"><span><b>{{ formatNumber(differenceResult.data.totalHours, 3) }}</b>小时</span><span><b>{{ formatNumber(differenceResult.data.totalMinutes, 3) }}</b>分钟</span><span><b>{{ formatNumber(differenceResult.data.totalSeconds, 3) }}</b>秒</span></div>
        </div>
      </template>
    </section>

    <section v-else class="tool-workspace cron-workspace">
      <div class="cron-form">
        <label class="field cron-expression"><span>Cron 表达式</span><input v-model.trim="cronExpression" class="mono" placeholder="0 9 * * 1-5" /></label>
        <label class="field"><span>执行时区</span><select v-model="cronZone"><option v-for="zone in ZONES" :key="zone.value" :value="zone.value">{{ zone.label }}</option></select></label>
        <label class="field"><span>起算时间</span><input v-model="cronBase" type="datetime-local" step="1" /></label>
        <label class="field count-field"><span>次数</span><select v-model.number="cronCount"><option :value="5">5</option><option :value="10">10</option><option :value="20">20</option></select></label>
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
