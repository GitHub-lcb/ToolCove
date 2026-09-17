<script setup>
// 铁路大亨 · 挑战线路站点推断（《诡秘之主》家园列车贸易玩法）。
// 录入每站的「实际类型 + 该站看到的未来 3 站提示」，求解器穷举全部合法排列，
// 把能被唯一确定的站点标出来，并据此给策略卡建议。
// 纯本地计算，不联网、不读取任何游戏进程——性质等同于摆在桌面上的记事本。
//
// 两种版面（驾驶舱可再叠加「悬浮模式」：收掉标题栏与工具栏，只留路线与录入并自动置顶）：
//   - 驾驶舱（HUD）：为「边玩边扫一眼」设计，四段式——
//     工具栏（题目 + 欠提示入口 + 图标动作）、路线行（核心）、记这一站、提醒与动作。
//     路线行一格一站，**推断长在它预测的那一站上**：第一个未确认的站会鼓成一个气泡，
//     锁定时显示 100%，待定时给头名候选与占比条。全窗口只有「100% 锁定」用彩色，
//     类型不再各染一色；已录入是实底灰、未知是虚线 + 灰「?」。
//     提醒只在有坑时出现（记录矛盾 / 连站别拿售价卡），一句「别做什么」+ 一句「为什么」。
//     配合标题栏的置顶图钉可浮在游戏画面上（游戏需设为无边框窗口）。
//     悬浮模式连工具栏一起藏了，所以「全部记录」仍留着覆盖层入口——
//     不切版面就能查看并回改任意一站，这是浮窗里唯一的全表入口。
//   - 完整版面：全部节点全表（始发站 + 第 1~15 站）+ 路线条 + 侧栏，用于校对录入、复盘与回头补录。
//
// 站号口径：数组下标 0 是**始发站**，它就是「第 1 站」；于是「第 N 站」落在下标 N-1 上。
// 站号只在 railTycoon.js 的 stationNumber() 里算一次，视图层不许自己做 +1。
// 始发站**同样要记「未来 3 站」提示**（它的提示覆盖第 2~4 站），只是没有哪条提示会回头覆盖它。
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import { flushToolbox, loadToolbox, saveToolbox } from "../toolboxStore.js";
import {
  buildAdvice,
  canHintAt,
  CELL_LABEL,
  CELL_PREDICT,
  CELL_RECORD,
  firstIncomplete,
  hintMax,
  hintRange,
  HINT_SAME,
  isStationComplete,
  nextIncompleteAfter,
  normalizeHint,
  normalizeType,
  ORIGIN_INDEX,
  RECORD_DONE,
  RECORD_HALF,
  solveRailRoute,
  stationNumber,
  stationRecordState,
  stripCellContent,
  STATION_COUNT,
  TYPE_KEYS,
} from "./railTycoon.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t, te } = useI18n();

const STORE_KEY = "rail-tycoon";
const VIEW_KEY = "railTycoonView";

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const TYPE_LABEL_KEYS = TYPE_KEYS.map((k) => `toolbox.rail.type${capitalize(k)}`);
const TYPE_SHORT_KEYS = TYPE_KEYS.map((k) => `toolbox.rail.short${capitalize(k)}`);
const TYPE_CELL_KEYS = TYPE_KEYS.map((k) => `toolbox.rail.cell${capitalize(k)}`);

/**
 * 读上次停留的版面偏好。放在 setup 里同步读（而不是 onMounted 后再切），
 * 免得开着完整版面的人每次打开先闪一下驾驶舱；没有 localStorage（SSR）时退回驾驶舱。
 */
function readSavedView() {
  try {
    return localStorage.getItem(VIEW_KEY);
  } catch {
    return null;
  }
}

const observed = ref(new Array(STATION_COUNT).fill(null));
const hints = ref(new Array(STATION_COUNT).fill(null));
const isHud = ref(readSavedView() !== "full");
/** 当前正在录入的站点（0 基）。只由「去第 N 站」按钮推进（见 goNext），不自动前进。 */
const cursor = ref(0);
/** 「全部记录」覆盖层是否打开（浮窗里唯一的全表入口）。 */
const showAll = ref(false);
/** 「清空重来」的确认层是否打开。 */
const showResetConfirm = ref(false);
/** 「推断自动填入」类型的站下标（界面用虚线下划线区分来源，手动改过后移除）。 */
const autoFilled = ref([]);
const isAutoFilled = (index) => autoFilled.value.includes(index);

const result = computed(() => solveRailRoute({ observed: observed.value, hints: hints.value }));
const advice = computed(() => buildAdvice(result.value, { stationCount: result.value.stationCount }));

/**
 * 建议条目的可渲染形态：把一条建议拆成 title / act / detail 三段，各取各的 i18n 键。
 *
 * 拆三段不是为了好看——旧版把「结论 + 动作 + 明细」压进一句同字号同颜色的长文本，
 * 跑商时根本没空从句子里切分信息。分段后标题吃 14.5px/600、动作吃 13.5px、
 * 明细吃 12.5px 弱色，扫一眼就能停在需要的那一级。
 * 用 te() 判断该条有没有这一段：有些建议只有结论，不该硬塞空行。
 */
const adviceView = computed(() =>
  advice.value.map((item) => ({
    key: item.key,
    tone: item.tone,
    title: advPart(item, "title"),
    act: advPart(item, "act"),
    detail: advPart(item, "detail"),
  })),
);

const stationCount = computed(() => result.value.stationCount);

/**
 * 冲突时诊断出的可疑录入（railTycoon.js 的 diagnoseConflict 随建议条目一起带回）。
 *
 * 只报「记录冲突」帮不上忙——16 站 ×（类型 + 提示）最多 31 格，用户不知道该查哪一格。
 * 「去掉这一条，其余就自洽」是最接近答案的提示，所以干脆指名道姓。
 */
const conflictCulprits = computed(
  () => advice.value.find((item) => item.key === "conflict")?.culprits ?? [],
);

/** 把可疑录入渲染成「第 3 站的提示、第 4 站的类型」。 */
function culpritText(culprits = []) {
  return culprits
    .map((c) =>
      c.kind === "hint"
        ? t("toolbox.rail.culpritHint", { name: stationName(c.index) })
        : t("toolbox.rail.culpritType", { name: stationName(c.index) }),
    )
    .join(t("toolbox.rail.culpritSep"));
}

/** 冲突那一条文案：「矛盾条目：…」。诊断不出单条可疑项时退回空串（界面用泛化说明）。 */
const conflictWhat = computed(() => {
  const text = culpritText(conflictCulprits.value);
  return text ? t("toolbox.rail.conflictCulprits", { what: text }) : "";
});

/** 这一格录入是不是诊断出的可疑项：冲突时给它一个标记，省得用户挨个试。 */
const isCulprit = (kind, index) =>
  conflictCulprits.value.some((c) => c.kind === kind && c.index === index);

const hasInput = computed(
  () =>
    observed.value.some((v, i) => i > ORIGIN_INDEX && v !== null) ||
    hints.value.some((v) => v !== null),
);

const typeLabel = (index) => t(TYPE_LABEL_KEYS[index]);
const typeShort = (index) => t(TYPE_SHORT_KEYS[index]);
/** 记录条格子里的单字结果：格子只有十几像素宽，两个字放不下，取每类一个代表字（酒/食/商）。 */
const typeCell = (index) => t(TYPE_CELL_KEYS[index]);
const percent = (value) => `${Math.round(value * 100)}%`;

/** 节点的显示名：统一「第 N 站」（始发站 = 第 1 站），编号取自 stationNumber()。 */
function stationName(index) {
  const n = stationNumber(index);
  return n === null ? t("toolbox.rail.origin") : t("toolbox.rail.nthStation", { n });
}

/** 完整版面表格首列：编号本体（始发站也有编号）。 */
function stationCellMain(index) {
  const n = stationNumber(index);
  return n === null ? "—" : String(n);
}

/** 完整版面表格首列：位置说明。首站标「始发站」、末站标「终点」。 */
function stationCellSub(index) {
  if (index === ORIGIN_INDEX) return t("toolbox.rail.origin");
  return index === stationCount.value - 1 ? t("toolbox.rail.terminus") : "";
}

/** 该节点是不是始发站。它没有类型——只记提示，不选类型。 */
const isOrigin = (index) => index === ORIGIN_INDEX;

/**
 * 该节点的提示覆盖哪几站：下标 i 的提示覆盖 i+1 ~ min(i+3, 终点站)（见 railTycoon.js 的 hintRange）。
 *
 * 这是整个工具最容易记错的一条口径——记错一站，后续推断和冲突判定全歪，而且从界面上看不出来。
 * 所以把它显示出来：记的时候能当场和游戏里那句话对上，对不上就是记错站了。
 * 窗口在尾段会收窄（第 13 站 → 14~15、第 14 站 → 15）；返回 null 表示没有提示可录（终点站）。
 */
function hintWindow(index) {
  const range = hintRange(index, stationCount.value);
  return range ? { from: stationNumber(range.from), to: stationNumber(range.to) } : null;
}

/** 提示覆盖范围的短标签（驾驶舱用，省地方）；只剩 1 站时用单站说法。 */
function hintCoversShort(index) {
  const w = hintWindow(index);
  if (!w) return "";
  return w.from === w.to
    ? t("toolbox.rail.hintCoversOneShort", { to: w.to })
    : t("toolbox.rail.hintCoversShort", { from: w.from, to: w.to });
}

/** 提示覆盖范围的完整说法（title / aria 用）。 */
function hintCoversLong(index) {
  const w = hintWindow(index);
  if (!w) return t("toolbox.rail.hintDisabled");
  return w.from === w.to
    ? t("toolbox.rail.hintCoversOneLong", { to: w.to })
    : t("toolbox.rail.hintCoversLong", { from: w.from, to: w.to });
}

/**
 * 该节点为什么不能记提示。现在只剩「终点站后面没有站」这一种情况了——始发站与尾段都照样有
 * 提示（尾段窗口收窄）。做成 computed：它对任何站都是同一句话，不必再带下标。
 */
const hintBlockedTip = computed(() => t("toolbox.rail.hintDisabled"));

/** 该站能不能记提示。提示要覆盖它后面的站，故只有终点站没有提示可记。 */
const hintable = computed(() => canHintAt(cursor.value, stationCount.value));

/** 该站是否已记录完整（类型 + 提示）。判定逻辑在 railTycoon.js，有单测覆盖。 */
const stationDone = (index) =>
  isStationComplete(observed.value, hints.value, index, stationCount.value);

/**
 * 顶栏「16 格记录条」上每一格的档位：`empty` / `half` / `done`。
 *
 * 驾驶舱只看得到当前站，记到一半时没人知道「前面是不是还有站欠着提示」——
 * 这 16 格就是回答这个的。取色依据全部来自 railTycoon.js，这里只负责把它接到界面上。
 */
const recordState = (index) =>
  stationRecordState(observed.value, hints.value, index, stationCount.value);

/** 某一格还没有结果时的占位：站号；始发站没有类型，用「始」占位。 */
const stripLabel = (index) =>
  isOrigin(index) ? t("toolbox.rail.stripOrigin") : String(stationNumber(index));

/**
 * 路线行（驾驶舱核心展示区）每格的呈现：站号 + 中心字 + 状态类 + 气泡内容。
 *
 * 内容优先级（判据在 railTycoon.js 的 stripCellContent，有单测）：
 *   已录入的类型 > 推断唯一确定（locked）的类型 > 未知。
 * 颜色只有一种语义：**主色 = 100% 锁定**（pred）；已录入 = 实底灰（rec）；未知 = 虚线 + 灰「?」。
 * 首个未确认站（推断前沿）会「鼓」成一个气泡：锁定时同主色，待定时同中性色但加粗描边，
 * 并给出头名候选与占比条。
 */
function routeCellView(index) {
  const r = result.value;
  const obs = observed.value[index];
  let predicted = null;
  if (obs === null && !isOrigin(index) && r.consistent && r.locked[index]) {
    predicted = r.possibleTypes[index][0];
  }
  const c = stripCellContent(obs, predicted);
  const isCurrent = index === cursor.value;
  const classes = [c.kind === CELL_RECORD ? "rec" : c.kind === CELL_PREDICT ? "pred" : "unknown"];
  if (isCurrent) classes.push("bubble", "current");
  if (index === stationCount.value - 1) classes.push("end");
  if (routeCellDebt(index)) classes.push("debt");
  if (isAutoFilled(index)) classes.push("auto");

  let char = c.kind === CELL_LABEL ? stripLabel(index) : typeCell(c.typeIndex);
  let sub = "";
  let bubble = null;
  // 气泡长在「正在记录的当前站」上——它与下方录入卡说的是同一站，避免「上面放大第 5 站、
  // 下面在记第 4 站」的割裂。「下一站是什么」由路线上的虚线锁定格与右侧动作 chip 承担。
  if (isCurrent) {
    bubble = { locked: false, top: null, segments: [] };
    if (isOrigin(index)) {
      char = t("toolbox.rail.stripOrigin");
      sub = stationDone(index) ? t("toolbox.rail.stripDone") : t("toolbox.rail.hudStateNeedHint");
    } else if (c.kind === CELL_RECORD) {
      // 已录入（含推断自动填入）：大字给类型名，小字提醒这一站还差什么
      char = typeLabel(c.typeIndex);
      sub = stationDone(index) ? t("toolbox.rail.stripDone") : t("toolbox.rail.hudStateNeedHint");
    } else if (r.consistent && r.possibleTypes[index].length) {
      const types = r.possibleTypes[index]
        .map((ti) => ({ ti, ratio: r.ratio[index][ti] }))
        .sort((a, b) => b.ratio - a.ratio);
      const locked = r.locked[index];
      // 尚未录入：锁定给类型名 + 100%，待定给头名与占比、并在下面铺三根占比条
      char = locked ? typeLabel(types[0].ti) : `${typeLabel(types[0].ti)} ${percent(types[0].ratio)}`;
      sub = locked
        ? `${percent(1)} · ${t("toolbox.rail.hudCertain")}`
        : types.slice(1).map((s) => `${typeShort(s.ti)} ${percent(s.ratio)}`).join(" · ");
      bubble = { locked, top: types[0], segments: locked ? [] : types };
    } else {
      char = "?";
    }
  }
  return {
    index,
    number: stationNumber(index),
    char,
    sub,
    kind: c.kind,
    typeIndex: c.typeIndex,
    bubble,
    classes,
    tip: routeCellTip(index, c),
  };
}

/** 路线行整体：一格一站，气泡落在首个未确认站上。 */
const routeCells = computed(() =>
  Array.from({ length: stationCount.value }, (_, i) => routeCellView(i)),
);

/** 这一格是否欠提示：提示位为空、且光标已经走过它（后面的站本来就还没轮到）。 */
function routeCellDebt(index) {
  return (
    canHintAt(index, stationCount.value) &&
    hints.value[index] === null &&
    index < cursor.value
  );
}

/**
 * 某一格鼠标悬停 / 读屏时的说明：站名 · 记到哪了（· 结果 · 提示 · 欠提示）。
 * 格子里只放得下一个字，其余全靠这一行——所以它必须把状态和结果都说全。
 */
function routeCellTip(index, content = routeCellView(index)) {
  const state = recordState(index);
  const bits = [
    stationName(index),
    state === RECORD_DONE
      ? t("toolbox.rail.stripDone")
      : state === RECORD_HALF
        ? t("toolbox.rail.stripHalf")
        : t("toolbox.rail.stripEmpty"),
  ];
  if (content.kind === CELL_RECORD) {
    bits.push(typeLabel(content.typeIndex));
    if (isAutoFilled(index)) bits.push(t("toolbox.rail.stripAuto"));
  } else if (content.kind === CELL_PREDICT) {
    bits.push(t("toolbox.rail.stripPred", { type: typeLabel(content.typeIndex) }));
  }
  const h = hintText(hints.value[index]);
  if (h) bits.push(h);
  if (routeCellDebt(index)) bits.push(t("toolbox.rail.stripDebt"));
  return bits.join(" · ");
}

/** 已录提示的短文案（`数量相同` / `酒庄最多`）；没录则空串。按值反查，不去解析编码。 */
function hintText(value) {
  if (value === null) return "";
  if (value === HINT_SAME) return t("toolbox.rail.optHintSameShort");
  const ti = TYPE_KEYS.findIndex((_, i) => hintMax(i) === value);
  return ti === -1 ? "" : t("toolbox.rail.optHintMaxShort", { type: typeShort(ti) });
}

/** 16 站全部记完（类型 + 提示，提示位共 15 个：始发站到第 15 站）——录入区收起，只剩提醒。 */
const allRecorded = computed(
  () => firstIncomplete(observed.value, hints.value, stationCount.value) === -1,
);

/** 当前站还差什么。提示是每站都要记的，不能让用户以为填完类型就完事。始发站没有类型。 */
const needType = computed(() => !isOrigin(cursor.value) && observed.value[cursor.value] === null);
const needHint = computed(() => hintable.value && hints.value[cursor.value] === null);

/**
 * 光标之前那些站里漏掉的提示数。
 * 漏提示不是「少填一格」——每条提示都是一个约束，漏了推断会变弱，所以显式提一句。
 * 只统计光标之前的站，后面的站本来还没走到。
 */
const missingHints = computed(() => {
  let n = 0;
  for (let i = 0; i < cursor.value; i += 1) {
    if (canHintAt(i, stationCount.value) && hints.value[i] === null) n += 1;
  }
  return n;
});

/**
 * 驾驶舱右列：把建议压成「一句提醒 + 一句动作」，并在卡片底部放下一步操作。
 *
 * 有坑才亮提醒（记录矛盾 / 连站别拿售价卡），其余建议折叠成一条动作 chip，
 * 长解释留在完整版面——跑商时读不完的文字等于没有。
 * 本站记全后，底部出现「去第 N 站 →」主按钮（手动推进，见 goNext）；没记全时
 * 用一句浅色说明填住这块空白，告诉用户还差什么才能走。
 */
const hudSide = computed(() => {
  const r = result.value;
  const items = advice.value;
  const has = (key) => items.some((i) => i.key === key);
  const out = { alert: null, action: "", extra: "", note: "", goNext: null, wait: "" };

  if (!r.consistent) {
    // 有诊断结果就指名道姓（「改哪一条」才是用户要的信息），诊断不出才退回泛化说明。
    out.alert = {
      tone: "danger",
      title: t("toolbox.rail.conflictTitle"),
      detail: conflictWhat.value || t("toolbox.rail.conflictDesc"),
    };
    return out;
  }

  if (has("dontBoostSame")) {
    const next = r.nextIndex;
    out.alert = {
      tone: "warn",
      title: t("toolbox.rail.hudAlertSameTitle"),
      detail: t("toolbox.rail.hudAlertSameDetail", {
        prev: stationName(next - 1),
        next: stationName(next),
        type: typeLabel(advice.value.find((i) => i.key === "dontBoostSame").typeIndex ?? 0),
      }),
    };
  }

  // 下一步操作：本站记全 → 可去下一站；没记全 → 说明为什么还不能走。
  const nextIncomplete = nextIncompleteAfter(
    observed.value,
    hints.value,
    cursor.value,
    stationCount.value,
  );
  if (stationDone(cursor.value)) {
    if (nextIncomplete !== -1) {
      out.goNext = t("toolbox.rail.hudGoNext", { n: stationNumber(nextIncomplete) });
    }
  } else {
    out.wait = t("toolbox.rail.hudWaitNext");
  }

  if (r.nextIndex === -1) {
    out.note = t("toolbox.rail.hudDoneAll");
    return out;
  }

  const certain = items.find((i) => i.key === "certain");
  if (certain) out.action = t("toolbox.rail.hudActCertain", { type: typeLabel(certain.typeIndex ?? 0) });
  else if (has("origin")) out.action = t("toolbox.rail.hudActOrigin");
  else if (has("uncertain")) out.action = t("toolbox.rail.hudActUncertain");
  if (has("tail")) out.extra = t("toolbox.rail.hudActTail");
  return out;
});

/** 下一站结论区要展示的站点：从首个未确认站起，最多往后看 3 站（完整版面用）。 */
const upcoming = computed(() => {
  const start = result.value.nextIndex;
  if (start === -1) return [];
  const out = [];
  for (let k = 0; k < 3 && start + k < stationCount.value; k += 1) {
    const index = start + k;
    if (result.value.known[index]) continue;
    out.push({
      index,
      types: result.value.possibleTypes[index],
      locked: result.value.locked[index],
      ratio: result.value.ratio[index],
    });
  }
  return out;
});

/** 一行文本结论，供复制到手机 / 第二块屏。 */
const summaryText = computed(() => {
  const lines = [t("toolbox.rail.copyTitle")];
  const r = result.value;
  if (!r.consistent) {
    lines.push(t("toolbox.rail.conflictTitle"));
    if (conflictWhat.value) lines.push(conflictWhat.value);
    return lines.join("\n");
  }
  if (r.nextIndex === -1) {
    lines.push(t("toolbox.rail.allKnownTitle"));
    return lines.join("\n");
  }
  for (const item of upcoming.value) {
    lines.push(`${stationName(item.index)}：${item.types.map(typeLabel).join(" / ")}`);
  }
  for (const item of adviceView.value) {
    lines.push(`· ${item.title}${item.act ? ` — ${item.act}` : ""}`);
  }
  return lines.join("\n");
});

/** 建议某一段的文案；该段不存在时返回空串（模板据此跳过）。 */
function advPart(item, part) {
  const key = `toolbox.rail.adv.${item.key}.${part}`;
  if (!te(key)) return "";
  // 两个插值一起传：各段按需用（type = 类型名，what = 冲突诊断出的可疑录入）。
  // vue-i18n 会忽略文案里没有的占位符，所以不必按段区分。
  return t(key, { type: typeLabel(item.typeIndex ?? 0), what: culpritText(item.culprits) });
}

function setObserved(index, raw) {
  const next = observed.value.slice();
  next[index] = normalizeType(raw);
  observed.value = next;
  // 手动改动（含清除）后不再是「推断自动填入」
  if (autoFilled.value.includes(index)) {
    autoFilled.value = autoFilled.value.filter((i) => i !== index);
  }
}

function setHint(index, raw) {
  const next = hints.value.slice();
  next[index] = normalizeHint(raw);
  hints.value = next;
}

/** 记录本站类型：点已选中的类型即清除，省掉一个单独的清除按钮。 */
function recordType(index, typeIndex) {
  setObserved(index, observed.value[index] === typeIndex ? "" : String(typeIndex));
}

/** 记录本站提示。提示每站都要记——它是推断的唯一信息源，界面不替你跳过这一步。 */
function recordHint(index, value) {
  setHint(index, hints.value[index] === value ? "" : value);
}

/**
 * 推断已唯一确定的站：光标一到位就把类型自动记上——玩家在游戏里看到的就是它，
 * 只需再选提示。这不改变解空间（所有合法排列本就都取这一类），只是把已知结论落到记录上。
 * 自动填入的格子在界面上用虚线下划线标出（与「亲眼录入」区分），手动改过后标记消失。
 */
function prefillLockedType(index) {
  if (observed.value[index] !== null) return false;
  if (!result.value.consistent || !result.value.locked[index]) return false;
  const predicted = result.value.possibleTypes[index]?.[0];
  if (predicted === undefined) return false;
  setObserved(index, predicted);
  autoFilled.value = [...autoFilled.value, index];
  return true;
}

/**
 * 去下一站（右侧主按钮触发的显式动作）。
 *
 * 为什么不自动前进：记完提示 ≠ 离开这一站——玩家还在本站购物、选卡，此时工具若自己
 * 跳到下一站，录入卡会写着「第 5 站」而人还在第 4 站。所以光标只在本站记全后，由玩家
 * 按「去第 N 站 →」手动推进；推进时下一站若已被推断唯一确定，类型自动补上（只需记提示）。
 * 已记全的站会被跳过（回改历史站留下的空档不会挡路）。
 */
function goNext() {
  if (!stationDone(cursor.value)) return;
  for (let guard = 0; guard < stationCount.value; guard += 1) {
    const next = nextIncompleteAfter(observed.value, hints.value, cursor.value, stationCount.value);
    if (next === -1) return;
    cursor.value = next;
    // 下一站推断已确定 → 补类型；提示还缺（正常情况）就停下等用户记
    if (!prefillLockedType(next) || !stationDone(next)) return;
  }
}

/** 整站清空（类型 + 提示），用于把某一站重录。 */
function clearStation(index) {
  setObserved(index, "");
  setHint(index, "");
}

function resetAll() {
  observed.value = new Array(STATION_COUNT).fill(null);
  hints.value = new Array(STATION_COUNT).fill(null);
  autoFilled.value = [];
  cursor.value = 0;
}

/**
 * 「清空重来」先确认一次。
 *
 * 它现在**常亮**（清空是卡在半路时唯一的退路，退路不能有条件），代价是开局也很容易点到——
 * 而点到一次就是 16 站重记。所以确认这一步不能省：把「清掉的是 16 站的类型与提示、
 * 光标回始发站」写在确认层里，而不是塞进按钮的 title。
 */
function askReset() {
  showResetConfirm.value = true;
}

function doReset() {
  resetAll();
  showResetConfirm.value = false;
}

// 悬浮模式：本工具没有改窗口的能力，只是向容器「上报意图」——
// 容器据此收掉自己的标题栏（留一条拖拽窄条 + 退出/置顶/关闭），并按工具 key 记住偏好，
// 下次打开直接进悬浮。浏览器内嵌降级时容器没提供这个能力，注入为空，按钮不出现。
const chrome = inject("toolWindowChrome", null);
const canFloat = computed(() => !!chrome);
const isFloat = computed(() => !!chrome?.compact?.value);

function enterFloat() {
  if (!chrome) return;
  // 悬浮模式只服务「下一站是什么 + 记什么」，先把版面切回驾驶舱再收顶栏
  if (!isHud.value) toggleView();
  chrome.setCompact(true);
}

function toggleView() {
  isHud.value = !isHud.value;
  localStorage.setItem(VIEW_KEY, isHud.value ? "hud" : "full");
}

async function copySummary() {
  try {
    await navigator.clipboard.writeText(summaryText.value);
    props.showToast(t("toolbox.rail.copied"));
  } catch (e) {
    props.showToast(t("toolbox.rail.copyFailed", { err: String(e) }));
  }
}

// 录入即存：挑战线路跑到一半关掉窗口，重开还能接着推。
function persist() {
  saveToolbox(
    STORE_KEY,
    { observed: observed.value, hints: hints.value, cursor: cursor.value },
    { onError: (e) => console.error(e) },
  );
}
watch([observed, hints, cursor], persist, { deep: true });

// 两个覆盖层都盖住整块驾驶舱，只留一个右上角的关闭钮——鼠标要精准点它才出得来，
// 给一条键盘退路。监听只在打开期间挂着，不常驻。
function onOverlayKey(e) {
  if (e.key !== "Escape") return;
  if (showAll.value) showAll.value = false;
  else if (showResetConfirm.value) showResetConfirm.value = false;
}
// ⚠️ 数组源的 watch 回调拿到的是**全部新值**，必须逐个看。
// 写成 `([any]) => …` 只会取到第一个源（showAll），于是确认层打开时 any 是 false，
// 反而把刚挂上的监听摘掉——Esc 就再也关不掉它（真渲染验证逮到的）。
watch([showAll, showResetConfirm], (open) => {
  if (open.some(Boolean)) window.addEventListener("keydown", onOverlayKey);
  else window.removeEventListener("keydown", onOverlayKey);
});

onMounted(async () => {
  // 版面偏好在 setup 里已同步读过（见 readSavedView）：跑商的人不希望每次都手动切一次。
  const saved = await loadToolbox(STORE_KEY, null, { onError: (e) => console.error(e) });
  if (!saved) return;
  observed.value = Array.from({ length: STATION_COUNT }, (_, i) => normalizeType(saved.observed?.[i]));
  // 存档里的提示同样按可录位置过滤：终点站那格若残留了值，界面会把它显示在一个禁用的
  // 下拉里，但它其实不参与任何推算——两端的口径要与手机版 data.js 的归一保持一份。
  hints.value = Array.from({ length: STATION_COUNT }, (_, i) =>
    canHintAt(i, STATION_COUNT) ? normalizeHint(saved.hints?.[i]) : null,
  );
  // 这里**故意不做**任何「把下标 0 的数据搬到下标 1」的迁移。
  // 上一版曾按「始发站没有提示、下标 0 是旧版第 1 站」的口径搬过一次——现在始发站自己就有提示，
  // 再搬就会把用户刚记下的始发站提示偷走，而这种丢失事后完全看不出来。
  // 老存档若真有错位，界面每一格都标了它覆盖哪 3 站（见 hintCoversLong），当场看得出来、改得掉。
  // 存过光标就接着上次的位置；但**光标只在「有记录」的时候才有意义**。
  // 旧版本清空数据时若没同步光标，存档里会留下「记录全空、光标却停在第 11 站」这种状态：
  // 记录条全空、顶栏那个「漏 11 条提示」却还在，而唯一能退回开头的按钮当时是灰的——
  // 整个工具卡在半路，重开也照样卡（存档原样恢复）。所以这里夹一次：
  // 整份记录为空时，光标一律回到第一个没记完的站（空记录即始发站），不沿用存档值。
  const savedCursor = Number(saved.cursor);
  const savedCursorOk =
    Number.isInteger(savedCursor) && savedCursor >= 0 && savedCursor < STATION_COUNT;
  cursor.value =
    hasInput.value && savedCursorOk
      ? savedCursor
      : // 全记完时 firstIncomplete 返回 -1：那时录入区本来就收起了，落在末尾比落在 0 更不突兀
        Math.max(firstIncomplete(observed.value, hints.value, STATION_COUNT), 0);
  // 恢复的光标若停在「推断已唯一确定」的站上，同样补上类型（与 goNext 的行为一致）。
  // 这里**不**自动前进：玩家可能还停在这一站购物，光标该停在他离开时的地方。
  prefillLockedType(cursor.value);
});

onBeforeUnmount(() => {
  flushToolbox(STORE_KEY);
  window.removeEventListener("keydown", onOverlayKey);
});
</script>

<template>
  <div class="rail-tool" :class="isHud ? 'is-hud' : 'is-full'">
    <!-- 悬浮模式：整条顶栏让位给内容。跑商时只需要「下一站是什么 + 记什么」，
         复制 / 清空 / 切版面是开局与收尾动作——退出悬浮（窗口左上角）就能看到。 -->
    <template v-if="!isFloat">
      <!-- ── 驾驶舱 · 工具栏 ─────────────────────────────────────────
           跑商时最常做的是「记 + 看」，复制 / 清空 / 切版面是开局与收尾动作，
           所以它们退成图标；欠提示做成可点文字，因为它会改变推断强度。 -->
      <div v-if="isHud" class="hud-toolbar">
        <span class="hud-title"><Icon name="train" :size="14" />{{ t("toolbox.rail.badge", { n: stationCount }) }}</span>
        <button
          v-if="missingHints > 0"
          class="debt-link"
          type="button"
          :title="t('toolbox.rail.hudGoFix')"
          @click="toggleView"
        >{{ t("toolbox.rail.hudMissingHints", { n: missingHints }) }}</button>
        <span class="hud-spacer"></span>
        <button
          class="hud-iconbtn"
          type="button"
          :title="t('toolbox.rail.allRecordsTip')"
          :aria-label="t('toolbox.rail.allRecords')"
          @click="showAll = true"
        >
          <Icon name="grid" :size="15" />
        </button>
        <button
          class="hud-iconbtn"
          type="button"
          :title="t('toolbox.rail.modeToFull')"
          :aria-label="t('toolbox.rail.modeFull')"
          @click="toggleView"
        >
          <Icon name="layout" :size="15" />
        </button>
        <!-- 复制仍然要「有东西可复制」才亮：空记录复制出来只是一句「还没记录」，没有意义。 -->
        <button
          class="hud-iconbtn"
          type="button"
          :disabled="!hasInput"
          :title="t('toolbox.rail.copy')"
          :aria-label="t('toolbox.rail.copy')"
          @click="copySummary"
        >
          <Icon name="copy" :size="15" />
        </button>
        <!-- 清空重来**常亮**：它是卡在半路时唯一的退路，退路不能有条件。 -->
        <button
          class="hud-iconbtn"
          type="button"
          :title="t('toolbox.rail.resetTip')"
          :aria-label="t('toolbox.rail.reset')"
          @click="askReset"
        >
          <Icon name="refresh" :size="15" />
        </button>
        <button
          v-if="canFloat"
          class="hud-iconbtn"
          type="button"
          :title="t('toolbox.rail.hudFloat')"
          :aria-label="t('toolbox.rail.hudFloat')"
          @click="enterFloat"
        >
          <Icon name="layers" :size="15" />
        </button>
      </div>

      <!-- 完整版面照旧用徽标与文字按钮：那边信息密度低，不需要收成图标。 -->
      <div v-else class="action-bar">
        <span class="badge-route"><Icon name="train" :size="14" />{{ t("toolbox.rail.badge", { n: stationCount }) }}</span>
        <span v-if="!result.consistent" class="badge-conflict"><Icon name="alert" :size="14" />{{ t("toolbox.rail.conflictTitle") }}</span>
        <span class="action-spacer"></span>
        <button
          v-if="canFloat"
          class="btn-ghost sm icon"
          type="button"
          :title="t('toolbox.rail.hudFloat')"
          :aria-label="t('toolbox.rail.hudFloat')"
          @click="enterFloat"
        >
          <Icon name="layers" :size="14" />
        </button>
        <button
          class="btn-ghost sm"
          type="button"
          :title="t('toolbox.rail.modeToHud')"
          @click="toggleView"
        >
          <Icon name="gauge" :size="14" />{{ t("toolbox.rail.modeHud") }}
        </button>
        <button class="btn-ghost sm" type="button" :disabled="!hasInput" @click="copySummary">
          <Icon name="copy" :size="14" />{{ t("toolbox.rail.copy") }}
        </button>
        <button class="btn-ghost sm" type="button" :title="t('toolbox.rail.resetTip')" @click="askReset">
          <Icon name="refresh" :size="14" />{{ t("toolbox.rail.reset") }}
        </button>
      </div>
    </template>

    <!-- ── 驾驶舱 · 路线行（核心展示区）─────────────────────────────────
         一格一站：站号 + 结果字。全窗口只有「100% 锁定」用彩色；已录入是实底灰、
         未知是虚线 + 灰「?」。第一个还没确认的站会鼓成一个气泡——它的推断直接
         长在它头上，录完它就轮到下一格。格子不可点（回改走「全部记录」）。 -->
    <ol v-if="isHud" class="route-board" :aria-label="t('toolbox.rail.stripTitle')">
      <li
        v-for="cell in routeCells"
        :key="cell.index"
        class="rnode"
        :class="cell.classes"
        :title="cell.tip"
        :aria-label="cell.tip"
      >
        <i class="rn">{{ cell.number }}</i>
        <b class="rc">{{ cell.char }}</b>
        <template v-if="cell.bubble">
          <span v-if="cell.bubble.segments.length" class="rbars" aria-hidden="true">
            <i
              v-for="s in cell.bubble.segments"
              :key="s.ti"
              :style="{ flexGrow: s.ratio }"
              :class="{ on: s.ti === cell.bubble.top.ti }"
            ></i>
          </span>
          <span class="rw">{{ cell.sub }}</span>
        </template>
      </li>
    </ol>

    <!-- ── 驾驶舱 · 录入：类型与提示是两层按钮组 ──────────────────────
         提示不能藏在下拉框里，更不能因为填完类型就跳过去——每站都有提示，
         而提示才是推断的唯一约束来源。

         这块排在左栏：跑商时手上的动作是「记脚下这一站」，先记下来才有得推断。
         头部只留一个**不可点**的「当前站」标签。它取代的是旧版那个「‹ 下一站 ›」按钮——
         那个按钮同时当站号又当翻站，被当成「确认 / 下一步」点过，点了却只是把光标挪走。
         现在前进只有一条路：本站「类型 + 提示」记全后，按右侧底部的「去第 N 站」手动推进
         （见 goNext）——记完提示不代表已经购物完/离开本站。
         要跳回去改哪一站，点工具栏的「全部记录」在覆盖层里改，浮窗里也点得开。 -->
    <section v-if="isHud && !allRecorded" class="quick">
      <div class="quick-head">
        <span class="quick-title" :title="t('toolbox.rail.hudRecordTip')">
          <Icon name="edit" :size="14" /><span class="quick-kind">{{ t("toolbox.rail.hudRecordShort") }}</span><span class="hdr-tag">{{ t("toolbox.rail.hudCurTag") }}</span><b>{{ stationName(cursor) }}</b>
        </span>
        <span class="quick-spacer"></span>
        <!-- 本站两样都空时「清除」没有可清除的东西，直接不渲染（有内容才出现，出现即有效）。 -->
        <button
          v-if="observed[cursor] !== null || hints[cursor] !== null"
          class="qnav icon"
          type="button"
          :title="t('toolbox.rail.hudClearFull')"
          :aria-label="t('toolbox.rail.hudClearFull')"
          @click="clearStation(cursor)"
        >
          <Icon name="x" :size="12" />
        </button>
      </div>

      <div class="quick-row">
        <span
          class="quick-label"
          :class="{ pending: needType }"
          :title="isOrigin(cursor) ? t('toolbox.rail.originNoTypeTip') : `${t('toolbox.rail.hudTypeLabelFull')}${needType ? ` · ${t('toolbox.rail.hudStateNeedType')}` : ''}`"
        >{{ t("toolbox.rail.hudTypeLabel") }}</span>
        <!-- 始发站没有类型：这一行不放三选一，直接写「始发站」。
             放三选一的话，用户会被迫在酒庄/食铺/商行里挑一个——游戏里根本没有这个信息，
             而这个凭空选出来的类型还会顺着「已确认 N 站」的进度条混进印象里。 -->
        <span v-if="isOrigin(cursor)" class="quick-na" :title="t('toolbox.rail.originNoTypeTip')">{{ t("toolbox.rail.origin") }}</span>
        <div v-else class="quick-btns">
          <button
            v-for="(key, ti) in TYPE_KEYS"
            :key="key"
            type="button"
            class="qbtn"
            :class="{ on: observed[cursor] === ti }"
            :aria-pressed="observed[cursor] === ti"
            @click="recordType(cursor, ti)"
          >{{ typeLabel(ti) }}</button>
        </div>
      </div>

      <div class="quick-row">
        <span
          class="quick-label"
          :class="{ pending: needHint }"
          :title="`${t('toolbox.rail.hudHintLabelFull')}${hintable ? ` · ${hintCoversLong(cursor)}${needHint ? ` · ${t('toolbox.rail.hudStateNeedHint')}` : ` · ${t('toolbox.rail.hudStateOk')}`}` : ` · ${t('toolbox.rail.hintDisabled')}`}`"
        >{{ t("toolbox.rail.hudHintLabel") }}</span>
        <div v-if="hintable" class="quick-btns">
          <button
            v-for="(key, ti) in TYPE_KEYS"
            :key="key"
            type="button"
            class="qbtn"
            :class="{ on: hints[cursor] === hintMax(ti) }"
            :aria-pressed="hints[cursor] === hintMax(ti)"
            :aria-label="t('toolbox.rail.optHintMax', { type: typeLabel(ti) })"
            :title="t('toolbox.rail.optHintMax', { type: typeLabel(ti) })"
            @click="recordHint(cursor, hintMax(ti))"
          >{{ t("toolbox.rail.optHintMaxShort", { type: typeShort(ti) }) }}</button>
          <button
            type="button"
            class="qbtn"
            :class="{ on: hints[cursor] === HINT_SAME }"
            :aria-pressed="hints[cursor] === HINT_SAME"
            :aria-label="t('toolbox.rail.optHintSame')"
            :title="t('toolbox.rail.optHintSameTip')"
            @click="recordHint(cursor, HINT_SAME)"
          >{{ t("toolbox.rail.optHintSameShort") }}</button>
        </div>
        <span v-else class="quick-na">{{ hintBlockedTip }}</span>
      </div>
      <!-- 「这条提示覆盖哪几站」独立一行：口径记错一站整盘就歪、事后还看不出来，
           而且要能在任何站号位数 / 任何语言下都不换行、不撑高卡片。 -->
      <p v-if="hintable" class="covers">{{ hintCoversLong(cursor) }}</p>
      <p v-else class="covers">{{ hintBlockedTip }}</p>
    </section>

    <!-- ── 驾驶舱 · 提醒与动作 ────────────────────────────────────────
         有坑才亮提醒条（记录矛盾 / 连站别拿售价卡），一句「别做什么」+ 一句「为什么」；
         没有坑就只留一条动作 chip。长解释留在完整版面——跑商时读不完的文字等于没有。 -->
    <aside v-if="isHud" class="hud-side">
      <div
        v-if="hudSide.alert"
        class="alert2"
        :class="`tone-${hudSide.alert.tone}`"
        role="status"
      >
        <Icon name="alert" :size="14" />
        <span class="txt">
          <b>{{ hudSide.alert.title }}</b>
          <small>{{ hudSide.alert.detail }}</small>
        </span>
      </div>
      <span v-if="hudSide.action" class="act-chip">
        <Icon name="sparkles" :size="13" />{{ hudSide.action }}
      </span>
      <span v-if="hudSide.extra" class="act-chip soft">{{ hudSide.extra }}</span>
      <span v-if="hudSide.note" class="hud-note">{{ hudSide.note }}</span>
      <!-- 卡片底部：本站记全后出现「去下一站」主按钮；没记全时用浅色说明填住空白。
           手动推进的原因见 goNext——记完提示不代表玩家已经购物完/离开本站。 -->
      <span v-if="hudSide.wait" class="hud-wait">{{ hudSide.wait }}</span>
      <button v-if="hudSide.goNext" class="go-next" type="button" @click="goNext">
        {{ hudSide.goNext }}<Icon name="chevron-right" :size="14" />
      </button>
    </aside>
    <!-- ── 路线条：只在完整版面出现 ────────────────────────────────────
         驾驶舱有自己的路线行（带推断气泡），这条横排路线条只服务完整版面：
         每格给「站号 + 短类型名 + 图例」，用于校对录入与整体复盘。 -->
    <section v-if="!isHud" class="route-card">
      <div class="strip">
        <div
          v-for="index in stationCount"
          :key="index"
          class="chip"
          :class="[
            observed[index - 1] === null && result.locked[index - 1] && result.consistent ? 'locked' : '',
            observed[index - 1] === null ? 'future' : '',
            index - 1 === result.nextIndex && result.consistent ? 'current' : '',
          ]"
          :title="stationName(index - 1)"
        >
          <div class="chip-n">{{ stationNumber(index - 1) }}</div>
          <div class="chip-t">
            <!-- 始发站没有类型：显示一条横杠，别显示「?」——那看着像「还没推断出来」 -->
            {{ isOrigin(index - 1) ? '—' : (observed[index - 1] !== null ? typeShort(observed[index - 1]) : (result.consistent && result.locked[index - 1] ? typeShort(result.possibleTypes[index - 1][0]) : '?')) }}
          </div>
        </div>
      </div>
      <div class="legend">
        <span><i class="dot solid"></i>{{ t("toolbox.rail.legendKnown") }}</span>
        <span><i class="dot ring"></i>{{ t("toolbox.rail.legendLocked") }}</span>
        <span><i class="dot future"></i>{{ t("toolbox.rail.legendFuture") }}</span>
      </div>
    </section>

    <!-- ── 完整版面主体：16 站全表 + 侧栏 ───────────────────────────── -->
    <div v-if="!isHud" class="main">
      <section class="table-card">
        <table class="record-table">
          <thead>
            <tr>
              <th class="c-idx">{{ t("toolbox.rail.colStation") }}</th>
              <th class="c-obs">{{ t("toolbox.rail.colType") }}</th>
              <th class="c-hint" :title="t('toolbox.rail.colHintTip')">{{ t("toolbox.rail.colHint") }}</th>
              <th class="c-res">{{ t("toolbox.rail.colInference") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="index in stationCount"
              :key="index"
              :class="{
                done: observed[index - 1] !== null || isOrigin(index - 1),
                current: index - 1 === result.nextIndex,
              }"
            >
              <td class="c-idx"><b>{{ stationCellMain(index - 1) }}</b><small v-if="stationCellSub(index - 1)">{{ stationCellSub(index - 1) }}</small></td>
              <td class="c-obs" :class="{ 'is-bad': isCulprit('type', index - 1) }">
                <!-- 始发站没有类型：不给下拉框（给了就等于逼用户编一个），只写「始发站」 -->
                <span v-if="isOrigin(index - 1)" class="origin-tag" :title="t('toolbox.rail.originNoTypeTip')">{{ t("toolbox.rail.origin") }}</span>
                <!-- 选项用短名（中文短名与全名同字，只有英文不同：Trading house → Trade）。
                     原生 select 不换行、不省略号提示，超出宽度直接切掉尾巴——「Trading house」
                     在这一列的可用宽度里会被吃掉一截，且不会出现在任何溢出检查里。
                     短名同时和路线条、推断胶囊用同一套词，三处说同一个词。 -->
                <select
                  v-else
                  :value="observed[index - 1] === null ? '' : String(observed[index - 1])"
                  :aria-label="t('toolbox.rail.ariaType', { name: stationName(index - 1) })"
                  @change="setObserved(index - 1, $event.target.value)"
                >
                  <option value="">{{ t("toolbox.rail.optUnknown") }}</option>
                  <option v-for="(key, ti) in TYPE_KEYS" :key="key" :value="String(ti)">{{ typeShort(ti) }}</option>
                </select>
              </td>
              <td class="c-hint" :class="{ 'is-bad': isCulprit('hint', index - 1) }">
                <!-- 同理用短名：全名的英文「Trading house is the most」要 142px，这一列给不出，
                     连占位符「No hint / not recorded」都会被切。短名与驾驶舱的四个提示按钮逐字一致
                     （那边本来就用 optHint*Short），记的时候和校对的时候看到的是同一句话。
                     完整说法留在 select 的 title / aria-label 里说清覆盖范围。 -->
                <select
                  :value="hints[index - 1] ?? ''"
                  :disabled="!canHintAt(index - 1, stationCount)"
                  :title="canHintAt(index - 1, stationCount) ? hintCoversLong(index - 1) : hintBlockedTip"
                  :aria-label="canHintAt(index - 1, stationCount) ? t('toolbox.rail.ariaHint', { name: stationName(index - 1), covers: hintCoversLong(index - 1) }) : hintBlockedTip"
                  @change="setHint(index - 1, $event.target.value)"
                >
                  <option value="">{{ t("toolbox.rail.optHintNone") }}</option>
                  <option :value="HINT_SAME">{{ t("toolbox.rail.optHintSameShort") }}</option>
                  <option v-for="(key, ti) in TYPE_KEYS" :key="key" :value="hintMax(ti)">
                    {{ t("toolbox.rail.optHintMaxShort", { type: typeShort(ti) }) }}
                  </option>
                </select>
              </td>
              <td class="c-res">
                <!-- 始发站没有类型，也就没有可推断的东西：写「不参与推断」，而不是「记录冲突」 -->
                <template v-if="isOrigin(index - 1)">
                  <span class="tag muted">{{ t("toolbox.rail.inferNa") }}</span>
                </template>
                <span v-else-if="observed[index - 1] !== null" class="tag">{{ typeLabel(observed[index - 1]) }}</span>
                <template v-else-if="!result.consistent">
                  <span class="tag muted">{{ t("toolbox.rail.inferConflict") }}</span>
                </template>
                <template v-else-if="result.possibleTypes[index - 1].length === 1">
                  <span class="tag locked">{{ typeLabel(result.possibleTypes[index - 1][0]) }}</span>
                  <span class="lock-mark" :title="t('toolbox.rail.inferLocked')">100%</span>
                </template>
                <template v-else>
                  <span
                    v-for="ti in result.possibleTypes[index - 1]"
                    :key="ti"
                    class="tag soft"
                  >{{ typeShort(ti) }} {{ percent(result.ratio[index - 1][ti]) }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <aside class="side">
        <section class="card" :class="{ 'card-danger': !result.consistent }">
          <header class="card-head"><b>{{ t("toolbox.rail.nextTitle") }}</b></header>
          <div v-if="!result.consistent" class="body-text">
            <p class="strong-danger">{{ t("toolbox.rail.conflictTitle") }}</p>
            <p v-if="conflictWhat" class="strong-danger">{{ conflictWhat }}</p>
            <p>{{ t("toolbox.rail.conflictDesc") }}</p>
          </div>
          <div v-else-if="result.nextIndex === -1" class="body-text">
            <p class="strong">{{ t("toolbox.rail.allKnownTitle") }}</p>
            <p>{{ t("toolbox.rail.allKnownDesc", { n: stationCount }) }}</p>
          </div>
          <div v-else class="body-text">
            <!-- 站号取 upcoming 那一站的**下标**（= 游戏里的「第 N 站」），不是下标 + 1：
                 改版前这里读的 upcoming[0].nth 根本不存在，插值直接落空；回退分支又写成
                 nextIndex + 1，尾段还会显示出第 16 站这种不存在的站号。 -->
            <p class="strong">
              {{ upcoming[0] && upcoming[0].locked
                ? t("toolbox.rail.nextCertain", { n: stationNumber(upcoming[0].index), type: typeLabel(upcoming[0].types[0]) })
                : t("toolbox.rail.nextUncertain", { n: stationNumber(upcoming[0]?.index ?? result.nextIndex) }) }}
            </p>
            <div v-for="item in upcoming" :key="item.index" class="upcoming-row">
              <span class="up-nth">{{ stationName(item.index) }}</span>
              <span class="up-team">
                <span
                  v-for="ti in item.types"
                  :key="ti"
                  class="tag soft"
                >{{ typeLabel(ti) }} {{ percent(item.ratio[ti]) }}</span>
              </span>
            </div>
          </div>
        </section>

        <section class="card">
          <header class="card-head"><b>{{ t("toolbox.rail.adviceTitle") }}</b></header>
          <ul class="advice-list">
            <li v-for="item in adviceView" :key="item.key" :class="`tone-${item.tone}`">
              <p class="adv-title">{{ item.title }}</p>
              <p v-if="item.act" class="adv-act">{{ item.act }}</p>
              <p v-if="item.detail" class="adv-detail">{{ item.detail }}</p>
            </li>
          </ul>
        </section>

        <p class="disclaimer">{{ t("toolbox.rail.disclaimer") }}</p>
      </aside>
    </div>

    <!-- ── 「全部记录」覆盖层 ─────────────────────────────────────────
         悬浮在游戏上时，驾驶舱只看得到「当前站 + 下一站」。某一步记错了要回改，
         过去得先切到完整版面，而悬浮模式恰好把顶栏（含切版面按钮）藏了起来——
         于是浮在游戏上时根本进不去。这里就地盖一层 16 站全表：不切版面、光标不动，
         关掉还在原来那一站。行高与列宽比完整版面紧一档（这是覆盖层，不是主视区），
         但读写方式逐格一致：同一套下拉、同一套「可疑录入」标红。 -->
    <div v-if="showAll" class="rec-overlay" @click.self="showAll = false">
      <section class="rec-panel" role="dialog" aria-modal="true" :aria-label="t('toolbox.rail.allRecords')">
        <header class="rec-head">
          <Icon name="layout" :size="14" />
          <b>{{ t("toolbox.rail.allRecords") }}</b>
          <span class="rec-sub">{{ t("toolbox.rail.allRecordsSub") }}</span>
          <span class="quick-spacer"></span>
          <button
            class="qnav icon"
            type="button"
            :title="t('toolbox.rail.allRecordsClose')"
            :aria-label="t('toolbox.rail.allRecordsClose')"
            @click="showAll = false"
          ><Icon name="x" :size="12" /></button>
        </header>

        <!-- 一条贴着列表顶端的列头。覆盖层是「一屏 16 行」的核对视图，
             没有列头的话首行会被读成表头（始发站那一行的站号格与类型格都写着「始发站」，
             看着就像两列表头）。这行只做视觉对齐，用 aria-hidden 摘掉：
             每个下拉本身已经带了 aria-label，散着读四个词反而没有归属。 -->
        <div class="rec-cols" aria-hidden="true">
          <span>{{ t("toolbox.rail.allRecordsColStation") }}</span>
          <span>{{ t("toolbox.rail.allRecordsColType") }}</span>
          <span>{{ t("toolbox.rail.allRecordsColHint") }}</span>
          <span>{{ t("toolbox.rail.allRecordsColRes") }}</span>
        </div>

        <ul class="rec-list">
          <li
            v-for="index in stationCount"
            :key="index"
            class="rec-row"
            :class="{ done: observed[index - 1] !== null || isOrigin(index - 1), current: index - 1 === cursor }"
          >
            <!-- 站号列只放编号，不带完整版面那个「终点」副标：这一列只有 32px，
                 英文 "Terminus" 要 52px（中文「终点」24px）——按最长的那种语言给宽度，
                 等于让整列为一个只出现在末行的标记让路。终点在完整版面里标着。 -->
            <span class="rec-n"><b>{{ stationCellMain(index - 1) }}</b></span>
            <span class="rec-cell" :class="{ 'is-bad': isCulprit('type', index - 1) }">
              <span v-if="isOrigin(index - 1)" class="origin-tag" :title="t('toolbox.rail.originNoTypeTip')">{{ t("toolbox.rail.origin") }}</span>
              <select
                v-else
                :value="observed[index - 1] === null ? '' : String(observed[index - 1])"
                :aria-label="t('toolbox.rail.ariaType', { name: stationName(index - 1) })"
                @change="setObserved(index - 1, $event.target.value)"
              >
                <option value="">{{ t("toolbox.rail.optUnknown") }}</option>
                <option v-for="(key, ti) in TYPE_KEYS" :key="key" :value="String(ti)">{{ typeShort(ti) }}</option>
              </select>
            </span>
            <span class="rec-cell" :class="{ 'is-bad': isCulprit('hint', index - 1) }">
              <select
                :value="hints[index - 1] ?? ''"
                :disabled="!canHintAt(index - 1, stationCount)"
                :title="canHintAt(index - 1, stationCount) ? hintCoversLong(index - 1) : hintBlockedTip"
                :aria-label="canHintAt(index - 1, stationCount) ? t('toolbox.rail.ariaHint', { name: stationName(index - 1), covers: hintCoversLong(index - 1) }) : hintBlockedTip"
                @change="setHint(index - 1, $event.target.value)"
              >
                <option value="">{{ t("toolbox.rail.optHintNone") }}</option>
                <option :value="HINT_SAME">{{ t("toolbox.rail.optHintSameShort") }}</option>
                <option v-for="(key, ti) in TYPE_KEYS" :key="key" :value="hintMax(ti)">
                  {{ t("toolbox.rail.optHintMaxShort", { type: typeShort(ti) }) }}
                </option>
              </select>
            </span>
            <span class="rec-res">
              <template v-if="isOrigin(index - 1)">
                <span class="tag muted">{{ t("toolbox.rail.inferNa") }}</span>
              </template>
              <!-- 已录的站：只给一个上色的类型胶囊。它旁边的下拉已经把值说清了，
                   这里要补的是「颜色」这一类记忆线索，所以用短名不再重复全名。 -->
              <span v-else-if="observed[index - 1] !== null" class="tag">
                {{ typeShort(observed[index - 1]) }}
              </span>
              <template v-else-if="!result.consistent">
                <span class="tag muted">{{ t("toolbox.rail.inferConflict") }}</span>
              </template>
              <template v-else-if="result.possibleTypes[index - 1].length === 1">
                <span class="tag locked">
                  {{ typeShort(result.possibleTypes[index - 1][0]) }}
                </span>
                <span class="lock-mark">100%</span>
              </template>
              <template v-else>
                <span
                  v-for="ti in result.possibleTypes[index - 1]"
                  :key="ti"
                  class="tag soft"
                >{{ typeShort(ti) }}</span>
              </template>
            </span>
          </li>
        </ul>
      </section>
    </div>

    <!-- ── 「清空重来」的确认层 ────────────────────────────────────────
         清空按钮现在常亮（理由见顶栏注释），确认这一步就是它唯一的护栏。
         与「全部记录」共用同一套遮罩样式，出口也一样：点层外、Esc、取消按钮。 -->
    <div v-if="showResetConfirm" class="confirm-overlay" @click.self="showResetConfirm = false">
      <section
        class="confirm-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('toolbox.rail.resetConfirmTitle')"
      >
        <span class="confirm-head">
          <Icon name="alert" :size="14" /><b>{{ t("toolbox.rail.resetConfirmTitle") }}</b>
        </span>
        <p class="confirm-body">{{ t("toolbox.rail.resetConfirmBody") }}</p>
        <div class="confirm-btns">
          <button class="btn-ghost sm" type="button" @click="showResetConfirm = false">
            {{ t("toolbox.rail.resetCancel") }}
          </button>
          <button class="btn-outline danger" type="button" @click="doReset">
            {{ t("toolbox.rail.resetConfirmOk") }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* ── 版面骨架 ────────────────────────────────────────────────────────
   驾驶舱三段式：顶栏 → 左「记什么」×右「下一站是什么」→ 建议整条横在底部。
   三行都按内容取高（grid-template-rows: max-content），整体高度贴合内容：
   默认窗口 760×340，删掉标题栏与内边距后，容量刚好放下

     row1 工具栏            28px
     row2 路线行（核心）     76px   16 格 + 首个未确认站的气泡
     row3 录入 + 提醒        ≈ 150px
     两处行间距              16px

   窗口再矮、或英文文案更长时，由 .rail-tool 自己 scroll（overflow-y:auto），
   不会把内容静默裁掉。窄于 620px 时路线行折成两行 8 格、录入与提醒改竖排。
   完整版面仍是纵向流（.is-full），它自带滚动容器。 */
/* position: relative 只为「全部记录」覆盖层兜底：它要盖住整块驾驶舱而不是整页 */
.rail-tool { position: relative; height: 100%; min-height: 0; }

.rail-tool.is-full { display: flex; flex-direction: column; gap: var(--sp-3); }

/* 驾驶舱：工具栏 / 路线行 /（录入 + 提醒）。两栏比例沿用实测的 1.62 : 1——
   左栏是提示按钮组与类型按钮组，右栏只有一条提醒 + 一条动作 chip。 */
.rail-tool.is-hud {
  display: grid;
  grid-template-columns: minmax(0, 1.62fr) minmax(0, 1fr);
  /* 行高贴合内容：整窗高度降低后，空白留在窗口底部而不是撑进卡片里。
     窗口再矮（或英文文案更长）时由 .rail-tool 自己滚，不裁内容。 */
  grid-template-rows: max-content max-content max-content;
  align-content: start;
  gap: var(--sp-2);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.rail-tool.is-hud > .hud-toolbar { grid-area: 1 / 1 / 2 / -1; }
.rail-tool.is-hud > .route-board { grid-area: 2 / 1 / 3 / -1; }
.rail-tool.is-hud > .quick { grid-area: 3 / 1 / 4 / 2; }
.rail-tool.is-hud > .hud-side { grid-area: 3 / 2 / 4 / 3; }
/* 16 站全记完后录入区收起，提醒独占整行 */
.rail-tool.is-hud:not(:has(.quick)) > .hud-side { grid-area: 3 / 1 / 4 / -1; }

/* ── 顶栏 ─────────────────────────────────────────────────────────── */
.action-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); min-height: 28px; }
/* 按钮按整块换行，不要在按钮内部把文字折成三行 */
.action-bar .btn-ghost { white-space: nowrap; }
/* 悬浮开关是纯图标按钮：让掉一半左右内边距，顶栏在 640px（英文文案最长）下才放得下 4 个控件 */
.action-bar .btn-ghost.icon { padding: 6px 8px; }
.rail-tool.is-full > .action-bar { flex-shrink: 0; }
.action-spacer { flex: 1; min-width: 0; }
.badge-route { display: inline-flex; align-items: center; gap: var(--sp-1); padding: 2px var(--sp-2); border-radius: var(--r-pill); background: var(--primary-soft); color: var(--primary-hover); font-size: var(--fs-sm); font-weight: 600; white-space: nowrap; }
.badge-conflict { display: inline-flex; align-items: center; gap: var(--sp-1); padding: 2px var(--sp-2); border-radius: var(--r-pill); background: var(--danger-soft); color: var(--danger-deep); font-size: var(--fs-sm); font-weight: 600; white-space: nowrap; }

/* ── 驾驶舱 · 工具栏 ────────────────────────────────────────────────
   跑商时最常做的是「记 + 看」，所以这里只放题目、欠提示入口与一排图标次级动作。 */
.hud-toolbar { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; min-height: 28px; }
.hud-title { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--text-dim); font-size: var(--fs-sm); font-weight: 600; white-space: nowrap; }
.hud-spacer { flex: 1; min-width: 0; }
/* 欠提示是「推断变弱」而不是「少填一格」，所以做成可点入口而不是死文字。 */
.debt-link { height: 24px; padding: 0 var(--sp-2); border: 1px solid var(--warn-border); border-radius: var(--r-pill); background: var(--warn-soft); color: var(--warn-deep); font-size: var(--fs-xs); font-weight: 700; white-space: nowrap; cursor: pointer; }
.debt-link:hover { border-color: var(--warn); box-shadow: var(--glow-sm); }
/* 图标按钮：26×26 命中区（桌面鼠标足够），一律带 title / aria-label。 */
.hud-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--card); color: var(--text-weak); cursor: pointer; }
.hud-iconbtn:hover:not(:disabled) { background: var(--well-hover); color: var(--text); }
.hud-iconbtn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── 驾驶舱 · 路线行（核心展示区）───────────────────────────────────
   一格一站：左上角站号（tabular 数字）+ 居中结果字。全窗口只有「100% 锁定」用彩色：
     已录入 = 实底灰 · 100% 锁定 = 主色虚框浅底 · 未知 = 虚线 + 灰「?」。
   首个未确认站（推断前沿）鼓成一个气泡，推断就长在它头上；游标用上沿小三角表示。
   格子不可点：手动翻站已经删掉（回改走「全部记录」），这里再开入口等于把它恢复回来。 */
.route-board { display: flex; gap: 3px; align-items: flex-end; height: 76px; min-width: 0; margin: 0; padding: 0; list-style: none; }
.rnode { position: relative; flex: 1 1 0; min-width: 0; height: 52px; display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: visible; border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--card); transition: transform 0.16s ease-out, opacity 0.16s ease-out; }
.rnode .rn { position: absolute; top: 2px; left: 5px; color: var(--text-dim); font-family: var(--font-num); font-size: var(--fs-xs); font-weight: 700; font-variant-numeric: tabular-nums; }
.rnode .rc { color: var(--text); font-size: var(--fs-md); font-weight: 800; line-height: 1; }
/* 已录入：实底灰。录的是亲眼所见，压过一切推断。 */
.rnode.rec { background: var(--well); border-color: var(--border-strong); }
/* 100% 锁定：全窗口唯一的彩色语义；虚框表示「还没录过」。 */
.rnode.pred { border: 2px dashed var(--primary); background: var(--primary-soft); }
.rnode.pred .rc { color: var(--primary-hover); }
/* 未知：虚线 + 灰「?」，形状本身也在表意（不只靠颜色）。 */
.rnode.unknown { border-style: dashed; }
.rnode.unknown .rc { color: var(--text-dim); }
/* 推断自动填入的类型：虚线下划线说明「来源是推断，不是亲眼录入」，手动改过后消失。 */
.rnode.auto .rc { text-decoration: underline dotted; text-underline-offset: 3px; }
/* 推断前沿：气泡。锁定时同主色；待定时中性但加粗描边，并给占比条。 */
.rnode.bubble { flex: 3 1 0; height: 68px; border: 2px solid var(--primary); background: var(--primary-soft); border-radius: var(--r-md); box-shadow: var(--glow-sm); }
.rnode.bubble.rec, .rnode.bubble.unknown { border-color: var(--border-strong); background: var(--card-soft); box-shadow: none; }
.rnode.bubble .rc { font-size: var(--fs-lg); }
.rnode.bubble .rw { max-width: 96%; margin-top: 2px; overflow: hidden; color: var(--text-weak); font-size: var(--fs-xs); font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
/* 待定时三根占比条：宽度即概率，头名亮、其余淡（具体数字在 title 里）。 */
.rnode.bubble .rbars { display: flex; gap: 2px; width: 84%; margin-top: 3px; }
.rnode.bubble .rbars i { height: 5px; border-radius: var(--r-pill); background: var(--border-blue); }
.rnode.bubble .rbars i.on { background: var(--primary); }
/* 游标：贴在上沿的小三角（中性色——主色留给「锁定」）。气泡本身就是当前站，不用再叠一个。 */
.rnode.current::before { content: ""; position: absolute; top: -8px; left: 50%; transform: translateX(-50%); border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 6px solid var(--text-soft); }
.rnode.bubble.current::before { display: none; }
/* 欠提示：格角空心小圈——「哪一站还欠一条」的位置标记，不参与配色。 */
.rnode.debt::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 6px; height: 6px; border: 1.5px solid var(--text-dim); border-radius: 50%; }
/* 末格是终点站：右侧加粗一档，让「这条线到哪儿为止」看得出来 */
.rnode.end { border-right-width: 2px; }
@media (prefers-reduced-motion: reduce) {
  .rnode { transition: none; }
}

/* ── 路线条 ───────────────────────────────────────────────────────── */
.route-card { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; padding: var(--sp-3); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.rail-tool.is-full > .route-card { flex-shrink: 0; padding: var(--sp-3) var(--sp-4); }
.strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(56px, 1fr)); gap: var(--sp-1); }
.chip { min-width: 0; padding: var(--sp-1) 2px; border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--well); text-align: center; }
.chip-n { color: var(--text-dim); font-family: var(--font-num); font-size: var(--fs-xs); line-height: var(--lh-tight); }
.chip-t { overflow: hidden; color: var(--text-soft); font-size: var(--fs-sm); font-weight: 700; line-height: var(--lh-tight); text-overflow: ellipsis; white-space: nowrap; }
.chip.future .chip-n { color: var(--text-dim); }
.chip.locked { border-width: 2px; border-color: var(--primary); }
.chip.future.locked .chip-n { color: var(--primary-hover); }
/* 当前站用外轮廓而非 border，避免和「已锁死」的粗边互相覆盖（中性色，主色留给锁定） */
.chip.current { outline: 2px solid var(--text-soft); outline-offset: 1px; }

.legend { display: flex; flex-wrap: wrap; gap: var(--sp-4); color: var(--text-dim); font-size: var(--fs-xs); }
.legend span { display: inline-flex; align-items: center; gap: var(--sp-1); }
.dot { width: 10px; height: 10px; border-radius: var(--r-xs); }
.dot.solid { background: var(--well); border: 1px solid var(--border-strong); }
.dot.ring { background: var(--card); border: 2px solid var(--primary); }
.dot.future { background: var(--card); border: 1px dashed var(--border-strong); }

/* ── 驾驶舱 · 提醒与动作 ────────────────────────────────────────────
   有坑才亮提醒条：主句「别做什么」+ 次句「为什么」，两行同一左基线（不用硬折行）。
   动作 chip 是正向指令；尾段这类补充建议做成次级 chip。 */
.hud-side { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-1); min-width: 0; min-height: 0; padding: var(--sp-3); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.alert2 { display: flex; gap: var(--sp-2); align-items: flex-start; width: 100%; padding: 6px var(--sp-2); border: 1px solid var(--warn-border); border-left: 4px solid var(--warn); border-radius: var(--r-xs); background: var(--warn-soft); color: var(--warn-deep); }
.alert2 .txt { display: flex; flex-direction: column; min-width: 0; }
.alert2 .txt b { font-size: var(--fs-base); font-weight: 800; line-height: var(--lh-tight); }
.alert2 .txt small { margin-top: 2px; font-size: var(--fs-xs); font-weight: 600; line-height: 1.45; }
.alert2.tone-danger { border-color: var(--border-danger); border-left-color: var(--danger); background: var(--danger-soft); color: var(--danger-deep); }
.act-chip { display: inline-flex; align-items: center; gap: 5px; padding: 5px var(--sp-3); border: 1px solid var(--border-blue); border-radius: var(--r-pill); background: var(--primary-soft); color: var(--primary-hover); font-size: var(--fs-sm); font-weight: 700; }
.act-chip.soft { border-color: var(--border-strong); background: var(--well); color: var(--text-weak); font-weight: 600; }
.hud-note { color: var(--text-weak); font-size: var(--fs-sm); line-height: var(--lh-body); }
/* 底部主操作：本站记全后出现，手动推进到下一站（记完提示 ≠ 已经购物完/离开本站）。 */
.go-next { display: inline-flex; align-items: center; justify-content: center; gap: 4px; align-self: stretch; margin-top: auto; padding: 8px var(--sp-3); border: 1px solid var(--primary); border-radius: var(--r-sm); background: var(--primary-soft); color: var(--primary-hover); font-size: var(--fs-base); font-weight: 800; cursor: pointer; }
.go-next:hover { border-color: var(--primary-hover); box-shadow: var(--glow-sm); }
/* 还没记全：用一句浅色说明填住这块空白，告诉用户为什么还没有「去下一站」。 */
.hud-wait { margin-top: auto; color: var(--text-dim); font-size: var(--fs-xs); line-height: 1.45; }

/* ── 驾驶舱 · 录入 ──────────────────────────────────────────────────
   两层按钮：类型一行、提示一行。提示刻意做成和类型同等显眼的按钮组，
   而不是塞在下拉框里——每站都有提示，且提示才是推断的唯一约束来源。
   「这一站还差什么」不做成独立的常驻状态条（那要多占一行，760×440 里很贵），
   而是直接把对应那行的标签点亮——状态长在它对应的控件旁边，比另开一行更好找。 */
.quick {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
  min-height: 0;
  padding: var(--sp-3);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  background: var(--card);
}
/* 间距收到 4px（与 .quick-row 同一约定）：头部要放下「站号 + 清除」，英文下也不折行。
   漏提示与「全部记录」已挪到工具栏——面板上只留「记这一站」这一件事。 */
.quick-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.quick-title { display: inline-flex; align-items: center; gap: 4px; color: var(--text-dim); font-size: var(--fs-sm); font-weight: 600; white-space: nowrap; }
.quick-title b { color: var(--text); font-family: var(--font-num); font-size: var(--fs-base); }
/* 「记录·当前站 第 4 站」的前缀点明这是录入光标（对应结论区的「推断」）。
   两处站号此前都是裸数字，看着像自相矛盾——现在各有一句话说明自己是什么。 */
.quick-kind { color: var(--text-weak); font-weight: 700; }
/* 「当前站」/「下一站」：两张卡各自在说哪一站，靠这一枚标签点明。
   做成 pill 但**不是按钮**：它没有任何交互，点它什么都不该发生——
   旧版这里是可点的「‹ 下一站 ›」，被当成「确认录入」按过。 */
.hdr-tag { padding: 0 6px; border-radius: var(--r-pill); background: var(--well); color: var(--text-dim); font-size: var(--fs-xs); font-weight: 700; white-space: nowrap; }
.quick-spacer { flex: 1; min-width: 0; }
/* 头部的小动作按钮（清除本站 / 覆盖层关闭钮）。
   这一族原本是「上一站 / 下一站」翻站按钮，现在只服务「改记录」——高 24px。 */
.qnav { display: inline-flex; align-items: center; justify-content: center; gap: 2px; height: 24px; padding: 0 6px; border: 1px solid var(--border-strong); border-radius: var(--r-xs); background: var(--well); color: var(--text-weak); font-size: var(--fs-xs); font-weight: 600; cursor: pointer; }
.qnav.icon { width: 26px; padding: 0; }
.qnav:hover:not(:disabled) { background: var(--well-hover); color: var(--text); }
.qnav:disabled { opacity: 0.4; cursor: not-allowed; }
/* 行内间距收到 4px（默认 --sp-1 是 6）：提示行四个按钮要挤在一行里，
   英文界面下每个按钮都比中文宽，靠这点余量才不至于折行。 */
.quick-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
/* 标签只留两个字（类型 / 提示），完整措辞走 title。
   640 宽的窗口里提示行四个按钮必须挤成一行，标签每多一个字就从按钮身上抢走 13px。 */
.quick-label { flex-shrink: 0; width: 34px; padding-left: 3px; border-left: 3px solid transparent; color: var(--text-dim); font-size: var(--fs-sm); font-weight: 600; }
/* 该行还空着：标签转成警示色 + 左描边，比额外一行状态条省地方也更好找 */
.quick-label.pending { border-left-color: var(--warn); color: var(--warn-deep); font-weight: 700; }
/* 按钮间距跟着 .quick-row 收到 4px（原为 --sp-1 的 6px）：提示行四个按钮必须挤在一行里，
   英文每个按钮都比中文宽，这三个 2px 正好是「一行 / 两行」的分界（一行 32px、两行 52px）。 */
.quick-btns { display: flex; flex-wrap: wrap; gap: 4px; }
/* 字号取 --fs-sm 而非 --fs-md：这是一块紧凑面，按钮更接近 chip 而不是正文按钮。
   英文界面下提示行四个按钮（"Trade most" / "All equal" 这类）用 13.5px 排不进一行，
   折算下来每行只差 10px——降到 chip 字阶正好换回 25px 余量，中文界面也跟着宽松。
   padding 收到 5px 同理：这是整块版面里唯一一处宽度刚好够用的地方。
   再收到 4px：录入卡换到左栏后比原来窄了 27px，中文提示行需要 348px 而可用只有 354px——
   四个按钮各让 1px 就换回 8px 余量，正好把它从「刚好卡在折行线上」拉回来。 */
.qbtn { min-width: 48px; height: 32px; padding: 0 4px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); color: var(--text); font-size: var(--fs-sm); font-weight: 700; white-space: nowrap; cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s; }
.qbtn:hover { background: var(--well-hover); }
/* 选中态不只用颜色：主色描边 + 内侧左竖条 + 同色文字（形状差异扛住色觉差异）。 */
.qbtn.on { border-width: 2px; border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); box-shadow: inset 3px 0 0 var(--primary); }
.quick-na { color: var(--faint); font-size: var(--fs-sm); line-height: var(--lh-body); }
/* 提示覆盖范围：整块版面里最该先读的一句口径——记错一站，后面所有推断和冲突判定都会歪，
   而事后从界面上看不出来。独立成行（虚线分隔、固定行高）：放在行内会被窗口宽度逼着换行，
   把卡片高度顶得忽高忽低。 */
.covers { margin: 0; padding-top: var(--sp-1); border-top: 1px dashed var(--border); color: var(--text-weak); font-size: var(--fs-xs); line-height: var(--lh-tight); }


/* ── 建议条目的三级字阶（驾驶舱与完整版面共用）─────────────────────
   一条建议里其实是三种信息：结论（要不要在乎）、动作（做什么）、明细（卡叫什么）。
   旧版把它们压进一句同字号同颜色的长文本，跑商间隙得自己从句子里切分信息。
   拆成三级后，扫一眼就能停在需要的那一级；颜色由 tone 决定，只染标题。 */
.adv-title { margin: 0; color: var(--text); font-size: var(--fs-base); font-weight: 600; line-height: var(--lh-tight); }
.adv-act { margin: 2px 0 0; color: var(--text); font-size: var(--fs-md); line-height: var(--lh-tight); }
.adv-detail { margin: 2px 0 0; color: var(--text-weak); font-size: var(--fs-sm); line-height: 1.5; }
.tone-success .adv-title { color: var(--success-deep); }
.tone-warn .adv-title { color: var(--warn-deep); }
.tone-danger .adv-title { color: var(--danger-deep); }

/* ── 完整版面 ─────────────────────────────────────────────────────── */
.main { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: var(--sp-3); flex: 1; min-height: 0; }

.table-card { min-width: 0; min-height: 0; overflow: auto; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.record-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.record-table th { position: sticky; top: 0; z-index: 1; height: 34px; padding: 0 var(--sp-3); background: var(--card-soft); color: var(--text-dim); font-size: var(--fs-xs); font-weight: 600; text-align: left; }
.record-table td { height: 42px; padding: var(--sp-1) var(--sp-3); border-top: 1px solid var(--border); vertical-align: middle; }
.record-table tr.current td { background: var(--primary-soft); }
.record-table tr.done .c-idx { color: var(--text-dim); }
/* 冲突时把「去掉就能自洽」的那几格标出来：用户不用再从 31 格里猜是哪条录错了。
   只染格子不染整行——同一行里通常只有一格可疑。
   覆盖层与完整版面共用这一套标记，故选择器两边都写。 */
.record-table td.is-bad,
.rec-cell.is-bad { background: var(--danger-soft); }
.record-table td.is-bad select,
.rec-cell.is-bad select { border-color: var(--border-danger); color: var(--danger-deep); }
/* 首列要同时放「15」和末站的副标「终点 / Terminus」。62px 在中文下够（「终点」24px），
   但英文的 Terminus 在 11px 字号下要 45px，而舒适密度下这一格的可用宽度只有 62−24=38px——
   实测被顶出 3px，正好漫到右内边距里，肉眼几乎看不出来，却说明这列宽是靠中文长度撑住的。
   放宽到 72px：两种密度下可用宽度 48 / 52px，英文副标与表头 Station 都留了余量。
   表格是 table-layout:fixed，多出来的 10px 由不设宽的推断列吸收，不挤压任何一列。 */
.c-idx { width: 72px; color: var(--text-soft); font-family: var(--font-num); font-size: var(--fs-sm); }
.c-idx b { font-weight: 600; }
.c-idx small { display: block; color: var(--faint); font-family: inherit; font-size: var(--fs-xs); font-weight: 400; }
.c-obs { width: 122px; }
/* 始发站没有类型：用与下拉框同高的静态标签占位，免得整行竖线错位。
   不放禁用态下拉框——那会让人以为「这里本来能选，只是被锁了」。 */
.origin-tag { display: inline-flex; align-items: center; height: 30px; color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
/* 提示列的宽度下限由**最长的那句选项**决定，不是由中文决定：
   英文占位符 "Not recorded" 在 11px 字号下要 74px，加上下拉指示器 22px（不在盒模型里）
   与自身内边距 16px，一格至少要 112px 可写区。158px 的列在两种密度下都留出 14px 以上的余量。
   窄窗不再收窄这一列：≤819px 时 .main 已是单列，表格拿到整个宽度，收窄只会白白切掉选项。 */
.c-hint { width: 158px; }
/* 推断列宽窗下只有 180px，放不下「三选一」那三枚并排胶囊：
   中文「酒庄 33%」×3 撑出 41px、英文「Trade 33%」×3 撑出 54px。
   整格 nowrap 会把右侧顶出表格，被 .table-card 的横向滚动条盖住——
   这一列恰恰是「推断结果」，最不该藏。窄窗（≤819px）靠 .c-hint 收窄到 132px
   侥幸没暴露，宽窗是实打实少了一截。
   改成「胶囊之间可换行、胶囊自己不断词」：三选一的行排两行，
   已确定的行仍是一行——不牺牲密度，也不再丢数据。 */
.record-table td.c-res { white-space: normal; }
.record-table td.c-res .tag { white-space: nowrap; }
/* 下拉框样式在完整版面与「全部记录」覆盖层里共用一份：同一格记录在两种版面里长得不一样，
   等于要用户学两遍，也等于两份样式迟早各自漂移。 */
.record-table select,
.rec-cell select { width: 100%; height: 30px; padding: 0 var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--r-xs); outline: none; background: var(--card); color: var(--text); font-size: var(--fs-sm); cursor: pointer; }
.record-table select:focus,
.rec-cell select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.record-table select:disabled,
.rec-cell select:disabled { background: var(--well); color: var(--faint); cursor: not-allowed; }

.tag { display: inline-block; margin-right: var(--sp-1); padding: 1px var(--sp-2); border-radius: var(--r-pill); background: var(--well); color: var(--text-weak); font-size: var(--fs-xs); font-weight: 600; }
/* 全工具只有一种彩色：100% 锁定（推断唯一的确定结果）。类型不再各染一色。 */
.tag.locked { border: 2px solid var(--primary); background: var(--primary-soft); color: var(--primary-hover); }
.tag.soft { background: transparent; border: 1px solid var(--border-strong); color: var(--text-weak); }
.tag.muted { background: var(--well); color: var(--muted); }
.lock-mark { color: var(--primary-hover); font-size: var(--fs-xs); font-weight: 600; }

/* ── 「全部记录」覆盖层 ──────────────────────────────────────────────
   悬浮在游戏上时的全表入口。做成盖在驾驶舱上的一层，而不是切到完整版面：
   完整版面是两栏纵向流（全表 + 侧栏 + 路线条），640×410 里要滚好几屏；
   覆盖层只要「16 行记录」，去掉侧栏与路线条正好一屏扫完。
   行高取 30px 的下拉 + 2px 上下留白（完整版面是 42px 行）：
   覆盖层用来核对与改错的，一屏看全比每格宽松更重要。
   遮罩样式两处共用：这里（全部记录）与「清空重来」的确认层。
   但**类名不共用**——CSS 可以合并，语义不能合并：
   两层的面板结构完全不同（一个是 16 行列表、一个是一句话的确认框），
   共用一个类名会让「找 .rec-overlay 再找里面的 .rec-panel」这种定位方式直接踩空。 */
.rec-overlay,
.confirm-overlay { position: absolute; inset: 0; z-index: 30; display: flex; padding: var(--sp-1); background: rgba(17, 24, 39, 0.42); backdrop-filter: blur(2px); }
.rec-panel { display: flex; flex: 1; flex-direction: column; gap: var(--sp-2); min-width: 0; min-height: 0; padding: var(--sp-3); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); box-shadow: 0 14px 34px rgba(0, 0, 0, 0.26);
  /* 列宽一处定义：列头与数据行必须严格同轨，分开写两份迟早漂移 */
  --rec-cols: 44px 124px 128px minmax(0, 1fr); }
.rec-head { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.rec-head b { color: var(--text); font-size: var(--fs-base); }
/* 副标题说明「改完立刻重算」，并允许被裁掉：它是补充说明，真正要读的是头两个字 */
.rec-sub { min-width: 0; overflow: hidden; color: var(--text-weak); font-size: var(--fs-xs); white-space: nowrap; text-overflow: ellipsis; }
.rec-list { flex: 1; min-height: 0; margin: 0; padding: 0; overflow-y: auto; overscroll-behavior: contain; list-style: none; }
/* 列宽与完整版面同源（首列站号、中两列两个下拉、末列推断），只是都收窄一档。
   收窄有下限，且下限由**英文**决定：类型列要放下占位符 "Unknown"（11px 下 52px），
   提示列要放下 "Not recorded"（74px），各自再加上自己的内边距 16px 与下拉指示器 22px。
   124 / 128 就是照这条算出来的（余量各 30px / 14px）；再窄就会像旧版那样静默切尾巴。
   首列 44px 的底线是「始发站 / Origin」这两个词本身（37 / 38px）——32px 时中文会折成两行。 */
.rec-cols { display: grid; grid-template-columns: var(--rec-cols); gap: var(--sp-1); padding: 0 0 2px; color: var(--text-dim); font-size: var(--fs-xs); font-weight: 600; line-height: 1.2; }
.rec-row { display: grid; grid-template-columns: var(--rec-cols); align-items: center; gap: var(--sp-1); padding: 2px 0; border-top: 1px solid var(--border); }
.rec-row:first-child { border-top: none; }
/* 光标所在站：与完整版面的 tr.current 同一套底色，一眼对上「记录卡现在记的是哪一站」 */
.rec-row.current { background: var(--primary-soft); }
.rec-n { display: flex; align-items: baseline; gap: 2px; color: var(--text-soft); font-family: var(--font-num); font-size: var(--fs-sm); }
.rec-n b { font-weight: 600; }
.rec-cell { display: block; min-width: 0; }
/* 推断列与完整版面同一个约定：胶囊之间可以换行，胶囊自己不断词 */
.rec-res { min-width: 0; white-space: normal; }
.rec-res .tag { white-space: nowrap; }

/* ── 清空确认层 ──────────────────────────────────────────────────────
   遮罩复用 .rec-overlay（同一套「盖在驾驶舱上、Esc 退出」的约定），
   但面板比「全部记录」小得多：内容自适应、居中，不撑满——它只问一句话。 */
.confirm-panel { display: flex; flex-direction: column; align-self: center; gap: var(--sp-2); width: 100%; max-width: 380px; margin: 0 auto; padding: var(--sp-3) var(--sp-4); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); box-shadow: 0 14px 34px rgba(0, 0, 0, 0.26); }
.confirm-head { display: flex; align-items: center; gap: var(--sp-1); color: var(--danger); font-size: var(--fs-base); }
.confirm-head b { color: var(--text); }
.confirm-body { margin: 0; color: var(--text-weak); font-size: var(--fs-sm); line-height: var(--lh-body); }
.confirm-btns { display: flex; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-1); }
/* 危险的确认按钮走全局那套 .btn-outline.danger（浅底 + 同色边 + 同色字），
   只补一个紧凑尺寸：全局只有 .btn-outline.lg，而这一行要和旁边的 .btn-ghost.sm 同高。
   不去动全局按钮体系。 */
.confirm-btns .btn-outline { padding: 6px 10px; font-size: var(--fs-sm); }

.side { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); overflow: auto; }
.card { flex-shrink: 0; padding: var(--sp-3) var(--sp-4); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.card-danger { border-color: var(--border-danger); background: var(--danger-soft); }
.card-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
.card-head b { font-size: var(--fs-md); }
.body-text p { margin: 0 0 var(--sp-2); color: var(--text-weak); font-size: var(--fs-sm); line-height: var(--lh-body); }
.body-text p:last-child { margin-bottom: 0; }
.body-text .strong { color: var(--text); font-size: var(--fs-base); font-weight: 600; }
.body-text .strong-danger { color: var(--danger-deep); font-size: var(--fs-base); font-weight: 600; }
.upcoming-row { display: flex; align-items: baseline; gap: var(--sp-2); margin-top: var(--sp-1); }
.up-nth { flex-shrink: 0; width: 58px; color: var(--text-dim); font-size: var(--fs-sm); }
.up-team { min-width: 0; }
/* 与驾驶舱同一套版式（左描边 + 三级字阶）：同一份内容在两种版面里长得不一样，
   等于要用户学两遍。 */
.advice-list { display: flex; flex-direction: column; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
.advice-list li { padding-left: var(--sp-3); border-left: 3px solid var(--border-strong); }
.advice-list li.tone-success { border-left-color: var(--success); }
.advice-list li.tone-warn { border-left-color: var(--warn); }
.advice-list li.tone-danger { border-left-color: var(--danger); }
.disclaimer { margin: 0; color: var(--faint); font-size: var(--fs-xs); line-height: var(--lh-body); }

/* 深色下主色（--primary）在浅底上的对比度按主题令牌走，不再为单个类型调色 */

/* ── 自适应 ─────────────────────────────────────────────────────────
   完整版面窄窗：表格与侧栏收成一列，只留 .main 一个滚动容器
   （表格改 overflow:visible），避免两个滚动条各自为政。 */
@media (max-width: 819px) {
  .main {
    grid-template-columns: minmax(0, 1fr);
    /* max-content：窄窗下按内容高度排布，不再把表格和侧栏压成两个小滚动框 */
    grid-template-rows: max-content max-content;
    align-content: start;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .table-card { overflow: visible; }
  .side { overflow: visible; }
}

/* 驾驶舱窄窗（< 620px）：路线行一行 16 格会挤到每格只剩 ~29px，
   折成两行 8 格；录入与提醒改竖排并整体滚动——宁可让用户滚一下，
   也不能把内容静默裁掉。断点必须低于默认窗口宽度 640，否则默认尺寸就掉进竖排。 */
@media (max-width: 619px) {
  .rail-tool.is-hud {
    grid-template-columns: minmax(0, 1fr);
    /* auto 行在定高容器里会被压缩分配（这些段都设了 min-height:0，基线为 0），
       那样每段各自冒出滚动条。改成 max-content，只让 .rail-tool 自己滚。 */
    grid-template-rows: max-content;
    grid-auto-rows: max-content;
    align-content: start;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .rail-tool.is-hud > .hud-toolbar { grid-area: 1 / 1 / 2 / 2; }
  .rail-tool.is-hud > .route-board { grid-area: 2 / 1 / 3 / 2; }
  /* 竖排时仍按「先记后看」：路线行在上、录入卡居中、提醒在下。 */
  .rail-tool.is-hud > .quick { grid-area: 3 / 1 / 4 / 2; }
  .rail-tool.is-hud > .hud-side { grid-area: 4 / 1 / 5 / 2; }
  /* 折两行 8 格：每格约 58px，站号/类型/状态都不挤。 */
  .route-board { flex-wrap: wrap; height: auto; }
  .rnode { flex: 1 1 calc(12.5% - 3px); }
  .rnode.bubble { flex: 1 1 calc(25% - 3px); }
  .rail-tool.is-hud > .quick,
  .rail-tool.is-hud > .hud-side { overflow: visible; }
}
</style>
