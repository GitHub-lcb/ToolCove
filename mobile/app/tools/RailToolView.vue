<script setup>
// 铁路大亨（手机端）：站点类型与「未来 3 站」提示 → 推断唯一确定的站点 → 给策略卡建议。
//
// 这个工具是旧悬浮面板被删掉后**第一个回归的功能**，而且求解逻辑一行不用重写：
// 全部复用 src/tools/railTycoon.js（桌面端 RailTycoonTool.vue 用的同一份）。
//
// 手机端的呈现取舍：桌面端是「驾驶舱 HUD + 完整版面」两套版面（窗口可以置顶浮在游戏上）；
// 手机上没法浮窗，所以只做**驾驶舱那一套**——巨型「下一站结论」+ 当前站一键录入，
// 这正是玩的时候真正要看的信息。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  HINT_MAX_PREFIX,
  HINT_SAME,
  ORIGIN_INDEX,
  STATION_COUNT,
  TYPE_KEYS,
  buildAdvice,
  canHintAt,
  firstIncomplete,
  hintRange,
  isStationComplete,
  nextIncompleteAfter,
  stationNumber,
  solveRailRoute,
  stationRecordState,
} from "../../../src/tools/railTycoon.js";

const { t, te } = useI18n();

const TYPE_LABEL_KEYS = TYPE_KEYS.map((k) => `toolbox.rail.type${k[0].toUpperCase()}${k.slice(1)}`);

/** 观察到的类型：下标为站点，值为 TYPE_KEYS 的下标或 null（未记录）。 */
const observed = ref(Array.from({ length: STATION_COUNT }, () => null));
/** 提示：每站一条，值为 null / "same" / "max0|max1|max2"。 */
const hints = ref(Array.from({ length: STATION_COUNT }, () => null));
const cursor = ref(ORIGIN_INDEX);
const confirmReset = ref(false);

const result = computed(() => solveRailRoute({ observed: observed.value, hints: hints.value }));
const advice = computed(() => buildAdvice(result.value, { stationCount: result.value.stationCount }));

/** 下一站结论：这是玩的时候最需要一眼看到的东西。 */
const nextVerdict = computed(() => {
  const r = result.value;
  if (!r.consistent) return { tone: "danger", text: t("toolbox.rail.conflictTitle") };
  if (r.nextIndex === -1) return { tone: "ok", text: t("toolbox.rail.allKnownTitle") };
  const locked = !!r.nextLocked;
  const types = r.nextTypes || [];
  return {
    tone: locked ? "ok" : "info",
    text: locked
      ? t("toolbox.rail.nextCertain", { n: stationNumber(r.nextIndex), type: t(TYPE_LABEL_KEYS[types[0]]) })
      : t("toolbox.rail.nextUncertain", { n: stationNumber(r.nextIndex) }),
  };
});

/**
 * 建议条目的可渲染形态：共享层给的只是 `{ key, typeIndex, tone }`，
 * 文案在 `toolbox.rail.adv.<key>.{title,act,detail}` 三段里（与桌面端同一套键）。
 * 缺哪段就留空——不编文案。
 */
function advPart(item, part) {
  const key = `toolbox.rail.adv.${item.key}.${part}`;
  if (!te(key)) return "";
  return t(key, { type: item.typeIndex === null || item.typeIndex === undefined ? "" : t(TYPE_LABEL_KEYS[item.typeIndex]) });
}

const adviceItems = computed(() =>
  advice.value.map((item) => ({
    key: item.key,
    tone: item.tone,
    title: advPart(item, "title"),
    act: advPart(item, "act"),
    detail: advPart(item, "detail"),
  }))
);

const currentComplete = computed(() => isStationComplete(observed.value, hints.value, cursor.value, STATION_COUNT));
const currentState = computed(() => stationRecordState(observed.value, hints.value, cursor.value, STATION_COUNT));
const canHint = computed(() => canHintAt(cursor.value, STATION_COUNT));
const hintable = computed(() => hintRange(cursor.value, STATION_COUNT));

function setType(typeIndex) {
  const next = [...observed.value];
  // 再点一次同一个类型 = 取消记录（手机上误触很常见，要能撤回）
  next[cursor.value] = next[cursor.value] === typeIndex ? null : typeIndex;
  observed.value = next;
}

function setHint(value) {
  const next = [...hints.value];
  next[cursor.value] = next[cursor.value] === value ? null : value;
  hints.value = next;
}

function goNext() {
  const next = nextIncompleteAfter(observed.value, hints.value, cursor.value, STATION_COUNT);
  cursor.value = next === -1 ? firstIncomplete(observed.value, hints.value, STATION_COUNT) : next;
  if (cursor.value === -1) cursor.value = ORIGIN_INDEX;
}

function reset() {
  observed.value = Array.from({ length: STATION_COUNT }, () => null);
  hints.value = Array.from({ length: STATION_COUNT }, () => null);
  cursor.value = ORIGIN_INDEX;
  confirmReset.value = false;
}

/** 站点缩写：手机上横向空间有限，一格就是用来看"这一站长什么样"。 */
function cellText(index) {
  const type = observed.value[index];
  if (type === null) return index === ORIGIN_INDEX ? t("toolbox.rail.origin") : t("toolbox.rail.optUnknown");
  return t(TYPE_LABEL_KEYS[type]);
}

const cellState = (index) => stationRecordState(observed.value, hints.value, index, STATION_COUNT);

/** 提示选项：数量相同 / 三种类型最多 / 未记录。 */
const HINT_OPTIONS = [
  { value: HINT_SAME, labelKey: "toolbox.rail.optHintSameShort" },
  ...TYPE_KEYS.map((_, typeIndex) => ({ value: `${HINT_MAX_PREFIX}${typeIndex}`, labelKey: "toolbox.rail.optHintMaxShort", typeIndex })),
  { value: null, labelKey: "toolbox.rail.optHintNone" },
];

function hintOptionLabel(option) {
  return option.typeIndex === undefined ? t(option.labelKey) : t(option.labelKey, { type: t(TYPE_LABEL_KEYS[option.typeIndex]) });
}
</script>

<template>
  <section class="m-tool" data-tool="rail">
    <!-- 驾驶舱：下一站结论 -->
    <div class="m-card m-verdict" :data-tone="nextVerdict.tone" data-role="verdict">
      <b>{{ t("toolbox.rail.nextTitle") }}</b>
      <p class="m-verdict-text" data-role="verdict-text">{{ nextVerdict.text }}</p>
    </div>

    <!-- 当前站 -->
    <div class="m-card">
      <div class="m-card-head">
        <b data-role="cursor">{{ cursor === ORIGIN_INDEX ? t("toolbox.rail.origin") : t("toolbox.rail.nthStation", { n: stationNumber(cursor) }) }}</b>
        <span class="m-zone" :data-state="currentState">{{ currentComplete ? t("toolbox.rail.stripDone") : t("toolbox.rail.stripHalf") }}</span>
      </div>

      <template v-if="cursor !== ORIGIN_INDEX">
        <p class="m-hint-sm">{{ t("toolbox.rail.colType") }}</p>
        <div class="m-chips">
          <button
            v-for="(key, typeIndex) in TYPE_KEYS"
            :key="key"
            class="m-chip"
            :class="{ on: observed[cursor] === typeIndex }"
            :data-type="key"
            @click="setType(typeIndex)"
          >
            {{ t(TYPE_LABEL_KEYS[typeIndex]) }}
          </button>
        </div>
      </template>

      <template v-if="canHint">
        <p class="m-hint-sm">{{ t("toolbox.rail.colHint") }}</p>
        <div class="m-chips">
          <button
            v-for="option in HINT_OPTIONS"
            :key="String(option.value)"
            class="m-chip"
            :class="{ on: hints[cursor] === option.value }"
            :data-hint="String(option.value)"
            @click="setHint(option.value)"
          >
            {{ hintOptionLabel(option) }}
          </button>
        </div>
      </template>
      <p v-else class="m-hint-sm">{{ t("toolbox.rail.hintDisabled") }}</p>

      <div class="m-actions">
        <button class="m-btn primary" data-role="go-next" @click="goNext">{{ t("toolbox.rail.hudRecordShort") }}</button>
        <button class="m-btn" data-role="reset" @click="confirmReset = true">{{ t("toolbox.rail.reset") }}</button>
      </div>
    </div>

    <!-- 全部站点一览 -->
    <div class="m-card">
      <div class="m-card-head"><b>{{ t("toolbox.rail.colStation") }}</b></div>
      <ul class="m-stations" data-role="stations">
        <li
          v-for="index in STATION_COUNT"
          :key="index - 1"
          class="m-station"
          :data-index="index - 1"
          :data-no="stationNumber(index - 1)"
          :data-state="cellState(index - 1)"
          :data-current="index - 1 === cursor"
          @click="cursor = index - 1"
        >
          <span class="m-station-no">{{ index - 1 === ORIGIN_INDEX ? "★" : stationNumber(index - 1) }}</span>
          <span class="m-station-type">{{ cellText(index - 1) }}</span>
        </li>
      </ul>
    </div>

    <!-- 建议：每条由 title / act / detail 三段组成（与桌面端同一套词条） -->
    <div class="m-card">
      <div class="m-card-head"><b>{{ t("toolbox.rail.adviceTitle") }}</b></div>
      <ul class="m-advice" data-role="advice">
        <li v-for="(item, i) in adviceItems" :key="i" :data-tone="item.tone" :data-advice="item.key">
          <b v-if="item.title">{{ item.title }}</b>
          <span v-if="item.act">{{ item.act }}</span>
          <span v-if="item.detail" class="m-advice-detail">{{ item.detail }}</span>
        </li>
      </ul>
      <p v-if="!adviceItems.length" class="m-hint-sm">{{ t("toolbox.rail.inferNa") }}</p>
    </div>

    <!-- 清空确认 -->
    <div v-if="confirmReset" class="m-modal">
      <div class="m-modal-card">
        <b>{{ t("toolbox.rail.resetConfirmTitle") }}</b>
        <p>{{ t("toolbox.rail.resetConfirmBody") }}</p>
        <div class="m-modal-ops">
          <button class="m-modal-cancel" @click="confirmReset = false">{{ t("toolbox.rail.resetCancel") }}</button>
          <button class="m-modal-ok" data-role="reset-ok" @click="reset">{{ t("toolbox.rail.resetConfirmOk") }}</button>
        </div>
      </div>
    </div>

    <p class="m-hint-sm">{{ t("toolbox.rail.disclaimer") }}</p>
  </section>
</template>
