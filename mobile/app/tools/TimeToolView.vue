<script setup>
// 时间工具（手机端）：当前时间戳 / 时间戳解析 / 时区换算。
//
// 逻辑复用 src/timeTool.js（桌面端同一模块，基于 Luxon，按需加载 chunk）。
// 手机端的差异是排版与交互：桌面上三栏并排，窄屏改为「一张卡一件事」纵向排列。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { convertZonedDateTime, formatInstant, parseTimestamp, toDateTimeInput } from "../../../src/timeTool.js";

const { t } = useI18n();

// ── 当前时间：每秒更新（只在页面可见时跑，避免后台空转耗电）────────────────
const now = ref(Date.now());
let timer = null;
onMounted(() => {
  timer = setInterval(() => {
    if (document.visibilityState === "visible") now.value = Date.now();
  }, 1000);
});
onBeforeUnmount(() => timer && clearInterval(timer));

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const nowText = computed(() => {
  try {
    return formatInstant(now.value, localZone);
  } catch {
    return null;
  }
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    notice.value = t("common.copied", { defaultValue: "已复制" });
  } catch {
    notice.value = t("snippet.copyFailed");
  }
}

const notice = ref("");

// ── 时间戳解析 ────────────────────────────────────────────────────────
//
// 注意：错误状态**不能在 computed 里赋值**（Vue 明确反对在 computed 里做副作用：
// 会造成多余重算与竞态）。这里让 computed 保持纯净，只返回 { result, error }，
// 由模板从同一个对象里取用。
const stampInput = ref(String(Math.floor(Date.now() / 1000)));
const stampUnit = ref("auto");

const stampComputed = computed(() => {
  if (!stampInput.value.trim()) return { result: null, error: "" };
  try {
    const parsed = parseTimestamp(stampInput.value, stampUnit.value);
    const formatted = formatInstant(parsed.milliseconds, localZone);
    return { result: { parsed, formatted }, error: "" };
  } catch (e) {
    return { result: null, error: e?.message || String(e) };
  }
});
const stampResult = computed(() => stampComputed.value.result);
const stampError = computed(() => stampComputed.value.error);

// ── 时区换算 ──────────────────────────────────────────────────────────
const srcZone = ref(localZone);
const dstZone = ref("UTC");
const zoneInput = ref(toDateTimeInput(Date.now(), localZone));

const zoneComputed = computed(() => {
  if (!zoneInput.value.trim()) return { result: null, error: "" };
  try {
    return { result: convertZonedDateTime(zoneInput.value, srcZone.value, dstZone.value), error: "" };
  } catch (e) {
    return { result: null, error: e?.message || String(e) };
  }
});
const zoneResult = computed(() => zoneComputed.value.result);
const zoneError = computed(() => zoneComputed.value.error);

/** 常用时区快捷项：手机上没有搜索框，给几个最常用的按一下就切。 */
const ZONE_PRESETS = ["UTC", "Asia/Shanghai", "Asia/Tokyo", "Europe/London", "America/New_York", "America/Los_Angeles"];

function useNow(zoneField) {
  if (zoneField === "src") srcZone.value = localZone;
}
</script>

<template>
  <section class="m-tool" data-tool="time">
    <!-- 当前时间：一眼就能看到、一键就能复制（这是这个工具最高频的用途） -->
    <div class="m-card">
      <div class="m-card-head">
        <b>{{ t("mobile.timeNow") }}</b>
        <span class="m-zone">{{ localZone }}</span>
      </div>
      <p class="m-big" data-role="now-ms">{{ now }}</p>
      <p class="m-mono" data-role="now-iso">{{ nowText?.iso || "" }}</p>
      <p class="m-mono">{{ nowText?.dateTime || "" }} {{ nowText?.weekday || "" }}</p>
      <div class="m-actions">
        <button class="m-btn" @click="copy(now)">{{ t("mobile.timeCopyMs") }}</button>
        <button class="m-btn" @click="copy(Math.floor(now / 1000))">{{ t("mobile.timeCopyS") }}</button>
        <button class="m-btn" @click="copy(nowText?.iso || '')">{{ t("mobile.timeCopyIso") }}</button>
      </div>
    </div>

    <!-- 时间戳解析 -->
    <div class="m-card">
      <div class="m-card-head"><b>{{ t("mobile.timeParse") }}</b></div>
      <label class="m-field">
        <span>{{ t("mobile.timeStampLabel") }}</span>
        <input v-model="stampInput" inputmode="numeric" />
      </label>
      <div class="m-chips">
        <button
          v-for="item in [
            { key: 'auto', labelKey: 'mobile.timeUnitAuto' },
            { key: 'seconds', labelKey: 'mobile.timeUnitSeconds' },
            { key: 'milliseconds', labelKey: 'mobile.timeUnitMs' },
          ]"
          :key="item.key"
          class="m-chip"
          :class="{ on: stampUnit === item.key }"
          @click="stampUnit = item.key"
        >
          {{ t(item.labelKey) }}
        </button>
      </div>
      <p v-if="stampError" class="m-err" data-role="error">{{ stampError }}</p>
      <ul v-else-if="stampResult" class="m-stats" data-role="stamp-stats">
        <li><b>ISO</b><span class="m-mono" data-role="stamp-iso">{{ stampResult.formatted.iso }}</span></li>
        <li><b>{{ t("mobile.timeLocal") }}</b><span>{{ stampResult.formatted.dateTime }} {{ stampResult.formatted.offset }}</span></li>
        <li><b>{{ t("mobile.timeWeekday") }}</b><span>{{ stampResult.formatted.weekday }}</span></li>
        <li><b>{{ t("mobile.timeSeconds") }}</b><span data-role="stamp-seconds">{{ stampResult.parsed.seconds }}</span></li>
      </ul>
    </div>

    <!-- 时区换算 -->
    <div class="m-card">
      <div class="m-card-head"><b>{{ t("mobile.timeZones") }}</b></div>
      <label class="m-field">
        <span>{{ t("mobile.timeSourceZone") }}</span>
        <input v-model="srcZone" spellcheck="false" />
      </label>
      <div class="m-chips">
        <button class="m-chip" @click="useNow('src')">{{ t("mobile.timeUseLocal") }}</button>
      </div>
      <label class="m-field">
        <span>{{ t("mobile.timeDateTime") }}</span>
        <input v-model="zoneInput" spellcheck="false" placeholder="2026-09-20T10:30:00" />
      </label>
      <label class="m-field">
        <span>{{ t("mobile.timeTargetZone") }}</span>
        <input v-model="dstZone" spellcheck="false" />
      </label>
      <div class="m-chips">
        <button v-for="zone in ZONE_PRESETS" :key="zone" class="m-chip" :class="{ on: dstZone === zone }" @click="dstZone = zone">
          {{ zone }}
        </button>
      </div>
      <p v-if="zoneError" class="m-err" data-role="error">{{ zoneError }}</p>
      <ul v-else-if="zoneResult" class="m-stats" data-role="zone-stats">
        <li><b>{{ t("mobile.timeSource") }}</b><span>{{ zoneResult.source.dateTime }} {{ zoneResult.source.offset }}</span></li>
        <li><b>{{ t("mobile.timeTarget") }}</b><span data-role="zone-target">{{ zoneResult.target.dateTime }} {{ zoneResult.target.offset }}</span></li>
      </ul>
    </div>

    <p v-if="notice" class="m-ok">{{ notice }}</p>
  </section>
</template>
