<script setup>
// 铁路大亨 · 挑战线路站点推断（《诡秘之主》家园列车贸易玩法）。
// 录入每站的「实际类型 + 该站看到的未来 3 站提示」，求解器穷举全部合法排列，
// 把能被唯一确定的站点标出来，并据此给策略卡建议。
// 纯本地计算，不联网、不读取任何游戏进程——性质等同于摆在桌面上的记事本。
//
// 两种版面（驾驶舱可再叠加「悬浮模式」：收掉标题栏与顶栏，只留结论和录入并自动置顶）：
//   - 驾驶舱（HUD）：为「边玩边扫一眼」设计。左栏承担「记什么」（当前站的类型 + 提示），
//     右栏回答「下一站是什么」，底部整条横陈「这一站怎么做」。
//     配合标题栏的置顶图钉可浮在游戏画面上（游戏需设为无边框窗口）。
//     悬浮模式连工具顶栏一起藏了，所以「全部记录」做成覆盖层挂在录入卡上——
//     不切版面就能查看并回改任意一站，这是浮窗里唯一的全表入口。
//   - 完整版面：全部节点全表（始发站 + 第 1~15 站）+ 路线条 + 侧栏，用于校对录入、复盘与回头补录。
//
// 站号口径：数组下标 0 是**始发站**——游戏里它不参与「第 N 站」编号，所以「第 N 站」落在下标 N 上
// （不是下标 + 1）。站号只在 railTycoon.js 的 stationNumber() 里算一次。
// 始发站**同样要记「未来 3 站」提示**（它的提示覆盖第 1~3 站），只是没有哪条提示会回头覆盖它。
//
// 驾驶舱为什么不放路线条：逐条对照「是否支持导航 / 理解 / 决策 / 行动」——跳站是低频操作
// （且有上/下一站按钮），已记的站刚记过、未记的站全是「?」，16 个描边矩形反而构成视野里
// 最强的栅格噪声，占据右上角却不产生任何信息增量。删掉它，回顾与纠错交给完整版面。
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
  HINT_SAME,
  isStationComplete,
  nextIncompleteAfter,
  normalizeHint,
  normalizeType,
  ORIGIN_INDEX,
  RECORD_DONE,
  RECORD_EMPTY,
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

/** HUD 里不展示的通用节奏建议——它们是常驻提醒，不该占跑商时的显示面积。 */
const HUD_ADVICE_SKIP = new Set(["backToBack", "rhythm"]);

const observed = ref(new Array(STATION_COUNT).fill(null));
const hints = ref(new Array(STATION_COUNT).fill(null));
const isHud = ref(true);
/** 当前正在录入的站点（0 基）。与「推断前沿」解耦：类型和提示都记了才自动前进。 */
const cursor = ref(0);
/** 「全部记录」覆盖层是否打开（浮窗里唯一的全表入口）。 */
const showAll = ref(false);
/** 「清空重来」的确认层是否打开。 */
const showResetConfirm = ref(false);

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

/** 已确认类型的站点数，HUD 进度用。始发站没有类型，既不该计入也不该被老存档里的残留值影响。 */
const typedCount = computed(
  () => observed.value.filter((v, i) => i > ORIGIN_INDEX && v !== null).length,
);

/** 进度条宽度：已确认类型的站 / 需要类型的站（15 站，始发站没有类型）。 */
const progressPct = computed(
  () => `${Math.round((typedCount.value / Math.max(1, stationCount.value - 1)) * 100)}%`,
);

const typeLabel = (index) => t(TYPE_LABEL_KEYS[index]);
const typeShort = (index) => t(TYPE_SHORT_KEYS[index]);
/** 记录条格子里的单字结果：格子只有十几像素宽，两个字放不下，取每类一个代表字（酒/食/商）。 */
const typeCell = (index) => t(TYPE_CELL_KEYS[index]);
const percent = (value) => `${Math.round(value * 100)}%`;

/**
 * 节点的显示名：始发站用「始发站」，其余用「第 N 站」。
 *
 * 编号取自 railTycoon.js 的 stationNumber()（= 数组下标，始发站不编号），所以
 * 「第 N 站」比「下标 + 1」小 1。改版前这里是 `index + 1`，工具里的站号一路比游戏大 1。
 */
function stationName(index) {
  const n = stationNumber(index);
  return n === null ? t("toolbox.rail.origin") : t("toolbox.rail.nthStation", { n });
}

/** 完整版面表格首列：编号本体。始发站没有编号，显示名字。 */
function stationCellMain(index) {
  const n = stationNumber(index);
  return n === null ? t("toolbox.rail.origin") : String(n);
}

/** 完整版面表格首列：位置说明。只有末站额外标「终点」。 */
function stationCellSub(index) {
  return index === stationCount.value - 1 ? t("toolbox.rail.terminus") : "";
}

/** 该节点是不是始发站。它没有类型——只记提示，不选类型。 */
const isOrigin = (index) => stationNumber(index) === null;

/**
 * 该节点的提示覆盖哪 3 站：下标 i 的提示覆盖 i+1 / i+2 / i+3（见 railTycoon.js 的头注）。
 *
 * 这是整个工具最容易记错的一条口径——记错一站，后续推断和冲突判定全歪，而且从界面上看不出来。
 * 所以把它显示出来：记的时候能当场和游戏里那句话对上，对不上就是记错站了。
 * 返回 null 表示这一站没有提示可录（末尾凑不满 3 站）。
 */
function hintWindow(index) {
  if (!canHintAt(index, stationCount.value)) return null;
  return { from: stationNumber(index + 1), to: stationNumber(index + 3) };
}

/** 提示覆盖范围的短标签（驾驶舱用，省地方）。 */
function hintCoversShort(index) {
  const w = hintWindow(index);
  return w ? t("toolbox.rail.hintCoversShort", { from: w.from, to: w.to }) : "";
}

/** 提示覆盖范围的完整说法（title / aria 用）。 */
function hintCoversLong(index) {
  const w = hintWindow(index);
  return w ? t("toolbox.rail.hintCoversLong", { from: w.from, to: w.to }) : t("toolbox.rail.hintDisabled");
}

/**
 * 该节点为什么不能记提示。现在只剩「末尾凑不满 3 站」这一种情况了——始发站同样有提示。
 * 做成 computed：它对任何站都是同一句话，不必再带下标。
 */
const hintBlockedTip = computed(() => t("toolbox.rail.hintDisabled"));

/** 该站能不能记提示。提示只覆盖其后 3 站，故末尾第 13~15 站没有提示可记。 */
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

/** 某一格还没有结果时的占位：始发站不编号，用一个字占位；其余就是站号。 */
const stripLabel = (index) =>
  stationNumber(index) === null ? t("toolbox.rail.stripOrigin") : String(stationNumber(index));

/**
 * 记录条一格的最终呈现：格子里写什么字、带哪些类。
 *
 * 内容优先级（判据在 railTycoon.js 的 stripCellContent，有单测）：
 *   已录入的类型 > 推断唯一确定（locked）的类型 > 站号占位。
 * 字的颜色跟着类型走（酒=金 / 食=绿 / 商=蓝，与推断占比条同色系）；
 * 推断确认但未录入的再加 `pred` 类画虚框——**结果可以提前知道，但「录没录过」不能含糊**。
 */
function stripCellView(index) {
  const obs = observed.value[index];
  let predicted = null;
  if (
    obs === null &&
    !isOrigin(index) &&
    result.value.consistent &&
    result.value.locked[index]
  ) {
    predicted = result.value.possibleTypes[index][0];
  }
  const c = stripCellContent(obs, predicted);
  const classes = [`st-${recordState(index)}`];
  if (c.typeIndex !== null) classes.push(`t-${TYPE_KEYS[c.typeIndex]}`);
  if (c.kind === CELL_PREDICT) classes.push("pred");
  if (index === cursor.value) classes.push({ current: true });
  if (index === stationCount.value - 1) classes.push({ end: true });
  return {
    text: c.kind === CELL_LABEL ? stripLabel(index) : typeCell(c.typeIndex),
    kind: c.kind,
    typeIndex: c.typeIndex,
    classes,
  };
}

/** 已录提示的短文案（`数量相同` / `酒庄最多`）；没录则空串。按值反查，不去解析编码。 */
function hintText(value) {
  if (value === null) return "";
  if (value === HINT_SAME) return t("toolbox.rail.optHintSameShort");
  const ti = TYPE_KEYS.findIndex((_, i) => hintMax(i) === value);
  return ti === -1 ? "" : t("toolbox.rail.optHintMaxShort", { type: typeShort(ti) });
}

/**
 * 某一格鼠标悬停时的说明：站名 · 记到哪了（· 结果是什么 · 提示是什么）。
 * 格子里只放得下一个字，其余全靠这一行——所以它必须把状态和结果都说全。
 */
function stripTip(index) {
  const view = stripCellView(index);
  const state = recordState(index);
  const bits = [
    stationName(index),
    state === RECORD_DONE
      ? t("toolbox.rail.stripDone")
      : state === RECORD_HALF
        ? t("toolbox.rail.stripHalf")
        : t("toolbox.rail.stripEmpty"),
  ];
  if (view.kind === CELL_RECORD) bits.push(typeLabel(view.typeIndex));
  else if (view.kind === CELL_PREDICT) {
    bits.push(t("toolbox.rail.stripPred", { type: typeLabel(view.typeIndex) }));
  }
  const h = hintText(hints.value[index]);
  if (h) bits.push(h);
  return bits.join(" · ");
}

/** 16 站全部记完（含始发站与第 1~12 站的提示，共 13 条）——此时录入区收起，只剩结论与建议。 */
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

/** HUD 结论块。只回答一个问题：下一站是什么。 */
const hero = computed(() => {
  const r = result.value;
  if (!r.consistent) {
    return {
      kind: "conflict",
      cls: "t-danger",
      label: t("toolbox.rail.conflictTitle"),
      badge: null,
      index: null,
      // 有诊断结果就指名道姓（「改哪一条」才是用户要的信息），诊断不出才退回泛化说明。
      note: conflictWhat.value || t("toolbox.rail.conflictDesc"),
    };
  }
  if (r.nextIndex === -1) {
    return {
      kind: "done",
      cls: "t-done",
      label: t("toolbox.rail.hudDoneAll"),
      badge: null,
      index: null,
      note: t("toolbox.rail.hudDoneAllDesc"),
    };
  }
  const index = r.nextIndex;
  const types = r.possibleTypes[index];
  if (r.locked[index]) {
    // 「确定」和「待定」共用同一套占比条隐喻，只是收敛成一根 100% 满条。
    // 旧版锁死时换成一个超大类型名，用户得重新学一遍「锁死长什么样」，
    // 而且看不到 100%——分不清「确定」和「只是最可能」。
    return {
      kind: "certain",
      cls: `t-${TYPE_KEYS[types[0]]}`,
      label: t("toolbox.rail.hudInferLabel"),
      badge: t("toolbox.rail.hudCertain"),
      index,
      bars: [{ ti: types[0], ratio: 1, locked: true }],
    };
  }
  // 按占比降序：最可能的排在最前面，扫一眼先看第一根条。
  const bars = types
    .map((ti) => ({ ti, ratio: r.ratio[index][ti], locked: false }))
    .sort((a, b) => b.ratio - a.ratio);
  return {
    kind: "open",
    cls: "t-open",
    label: t("toolbox.rail.hudInferLabel"),
    badge: t("toolbox.rail.hudOpen"),
    index,
    bars,
  };
});

/** HUD 建议：只留决定性条目，通用节奏建议挪到完整版面。 */
const hudAdvice = computed(() => adviceView.value.filter((item) => !HUD_ADVICE_SKIP.has(item.key)));
const hudAdviceMore = computed(() => adviceView.value.length - hudAdvice.value.length);

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
}

function setHint(index, raw) {
  const next = hints.value.slice();
  next[index] = normalizeHint(raw);
  hints.value = next;
}

/** 记录本站类型：点已选中的类型即清除，省掉一个单独的清除按钮。 */
function recordType(index, typeIndex) {
  setObserved(index, observed.value[index] === typeIndex ? "" : String(typeIndex));
  maybeAdvance(index);
}

/** 记录本站提示。提示每站都要记——它是推断的唯一信息源，界面不替你跳过这一步。 */
function recordHint(index, value) {
  setHint(index, hints.value[index] === value ? "" : value);
  maybeAdvance(index);
}

/**
 * 记完一站才自动前进。
 * 只填类型就跳，会让人永远记不上这一站的提示——那正是整个推断的关键约束。
 */
function maybeAdvance(index) {
  if (index !== cursor.value) return;
  if (!stationDone(index)) return;
  const next = nextIncompleteAfter(observed.value, hints.value, index, stationCount.value);
  if (next !== -1) cursor.value = next;
}

/**
 * 「上一站 / 下一站」按钮在这里被删掉了。
 *
 * 那两个按钮原本只有这一处入口，作用是手动挪光标；实测被当成「确认录入」点过——
 * 点了只是把光标挪走，界面看着像没反应。现在前进只走一条路：本站「类型 + 提示」
 * 记完自动跳到下一站（maybeAdvance）；回改历史站走「全部记录」覆盖层。
 * 光标不再是用户需要维护的东西，留一个没有入口的函数只会误导下一个读代码的人。
 */

/** 整站清空（类型 + 提示），用于把某一站重录。 */
function clearStation(index) {
  setObserved(index, "");
  setHint(index, "");
}

function resetAll() {
  observed.value = new Array(STATION_COUNT).fill(null);
  hints.value = new Array(STATION_COUNT).fill(null);
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
  // 上次停在哪个版面就还用哪个：跑商的人不希望每次都手动切一次。
  isHud.value = localStorage.getItem(VIEW_KEY) !== "full";
  const saved = await loadToolbox(STORE_KEY, null, { onError: (e) => console.error(e) });
  if (!saved) return;
  observed.value = Array.from({ length: STATION_COUNT }, (_, i) => normalizeType(saved.observed?.[i]));
  hints.value = Array.from({ length: STATION_COUNT }, (_, i) => normalizeHint(saved.hints?.[i]));
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
    <div v-if="!isFloat" class="action-bar">
      <!-- 驾驶舱顶栏左边 = 16 格记录条（始发站 → 终点站，一格一站）。
           它替掉了旧版的「挑战线路 · 16 站」徽标与「N 种合法排列」：
           排列数是十万到千万量级，跑商时既读不出趋势、也拿它做不了任何决定；
           而这 16 格回答的是另一个真正会被问到的问题——我记到哪了、哪站还欠一半。
           确认的结果直接写进格子（已录入=实底彩字，推断锁定=虚框彩字），
           光看底色得凑近猜，字才是结果本身。
           格子只报状态、不可点：手动翻站上一轮已经删掉（要回改走「全部记录」覆盖层），
           这里再开一个入口就等于把它恢复回来了。 -->
      <ol v-if="isHud" class="mini-strip" :title="t('toolbox.rail.stripTip')">
        <li
          v-for="index in stationCount"
          :key="index"
          class="mini-cell"
          :class="stripCellView(index - 1).classes"
          :title="stripTip(index - 1)"
        >{{ stripCellView(index - 1).text }}</li>
      </ol>
      <!-- 完整版面照旧用徽标：那边另有一整条路线卡（每格带类型），不再重复一排小方格。 -->
      <template v-else>
        <span class="badge-route"><Icon name="train" :size="14" />{{ t("toolbox.rail.badge", { n: stationCount }) }}</span>
        <span v-if="!result.consistent" class="badge-conflict"><Icon name="alert" :size="14" />{{ t("toolbox.rail.conflictTitle") }}</span>
      </template>
      <!-- 记录条自己就吃剩余宽度，所以驾驶舱里不再需要 spacer：
           两者都是 flex:1，留着会把富余对半分，格子白窄一半。 -->
      <span v-if="!isHud" class="action-spacer"></span>
      <!-- 悬浮开关做成纯图标按钮：这一行在 640px 下要放下 4 个控件，
           再加一个带文字的按钮，英文版就会折行——折行不会被横向溢出检查抓到，
           却会把下面建议区的高度顶掉。会隐藏什么、会自动置顶，都写进 title。 -->
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
        :title="isHud ? t('toolbox.rail.modeToFull') : t('toolbox.rail.modeToHud')"
        @click="toggleView"
      >
        <Icon :name="isHud ? 'layout' : 'gauge'" :size="14" />{{ isHud ? t("toolbox.rail.modeFull") : t("toolbox.rail.modeHud") }}
      </button>
      <!-- 复制仍然要「有东西可复制」才亮：空记录复制出来只是一句「还没记录」，没有意义。 -->
      <button class="btn-ghost sm" type="button" :disabled="!hasInput" @click="copySummary">
        <Icon name="copy" :size="14" />{{ t("toolbox.rail.copy") }}
      </button>
      <!-- 清空重来**常亮**。它此前是 :disabled="!hasInput"，于是「记录全空、光标却停在第 11 站」
           这种存档状态下：没有记录 → 按钮变灰，而没有记录也就没有别的路能把光标挪回去——
           整个工具卡死在半路。清空是唯一的退路，退路不能有条件。 -->
      <button class="btn-ghost sm" type="button" :title="t('toolbox.rail.resetTip')" @click="askReset">
        <Icon name="refresh" :size="14" />{{ t("toolbox.rail.reset") }}
      </button>
    </div>

    <!-- ── 驾驶舱 · 录入：类型与提示是两层按钮组 ──────────────────────
         提示不能藏在下拉框里，更不能因为填完类型就跳过去——每站都有提示，
         而提示才是推断的唯一约束来源。

         这块排在左栏：跑商时手上的动作是「记脚下这一站」，先记下来才有得推断。
         头部只留一个**不可点**的「当前站」标签。它取代的是旧版那个「‹ 下一站 ›」按钮——
         那个按钮同时当站号又当翻站，被当成「确认 / 下一步」点过，点了却只是把光标挪走。
         现在前进只有一条路：本站「类型 + 提示」记完自动跳到下一站（见 maybeAdvance）；
         要跳回去改哪一站，点「全部记录」在覆盖层里改，浮窗里也点得开。 -->
    <section v-if="isHud && !allRecorded" class="quick">
      <div class="quick-head">
        <span class="quick-title" :title="t('toolbox.rail.hudRecordTip')">
          <Icon name="edit" :size="14" /><span class="quick-kind">{{ t("toolbox.rail.hudRecordShort") }}</span><span class="hdr-tag">{{ t("toolbox.rail.hudCurTag") }}</span><b>{{ stationName(cursor) }}</b>
        </span>
        <span class="quick-spacer"></span>
        <!-- 漏提示是「推断变弱」而不是「少填一格」，所以做成可点的入口而不是死文字：
             点它直接切到完整版面补录，省掉「我记得有个地方能改」这一步回忆。
             不放 ⚠ 图标：琥珀底 + 边框已经把「这是警告」说完了，而头部在「漏 >9 条 + 清除」
             同时出现时只剩 20px 余量，图标那 14px 该让给文字。 -->
        <button
          v-if="missingHints > 0"
          class="quick-debt"
          type="button"
          :title="t('toolbox.rail.hudGoFix')"
          @click="toggleView"
        >
          {{ t("toolbox.rail.hudMissingHints", { n: missingHints }) }}
        </button>
        <!-- 本站两样都空时「清除」没有可清除的东西，直接不渲染。
             它此前是禁用态常驻，占 54px 却只服务于「光标停在一个空站」这个最常见的开局情形，
             正是头部最挤的时候。有内容才出现，出现即有效。
             现在只留图标：头部要放下「漏提示 + 清除 + 全部记录」三件，
             而它是最低频的一件，文字让给「全部记录」。 -->
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
        <!-- 全部记录：浮窗里唯一能「看到别的站」的入口。
             驾驶舱原本只回答「当前站记什么 + 下一站是什么」，想回改历史站得先切到完整版面，
             而悬浮模式把顶栏（含切版面按钮）藏起来了——于是浮在游戏上时根本进不去。
             点它就地盖一层全表，不切版面、不丢位置，改完关掉还在原来那一站。 -->
        <button
          class="qnav"
          type="button"
          :title="t('toolbox.rail.allRecordsTip')"
          @click="showAll = true"
        >
          <Icon name="layout" :size="12" />{{ t("toolbox.rail.allRecords") }}
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
            :class="[`t-${key}`, { on: observed[cursor] === ti }]"
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
        <!-- 把「这条提示覆盖哪 3 站」写在旁边：口径记错一站整盘就歪，而且事后看不出来。
             放在按钮前面而不是后面，是为了让 4 个按钮的位置在任何站都一致，形成肌肉记忆。 -->
        <span v-if="hintable" class="quick-covers" :title="hintCoversLong(cursor)">{{ hintCoversShort(cursor) }}</span>
        <div v-if="hintable" class="quick-btns">
          <button
            v-for="(key, ti) in TYPE_KEYS"
            :key="key"
            type="button"
            class="qbtn"
            :class="[`t-${key}`, { on: hints[cursor] === hintMax(ti) }]"
            :aria-pressed="hints[cursor] === hintMax(ti)"
            :aria-label="t('toolbox.rail.optHintMax', { type: typeLabel(ti) })"
            :title="t('toolbox.rail.optHintMax', { type: typeLabel(ti) })"
            @click="recordHint(cursor, hintMax(ti))"
          >{{ t("toolbox.rail.optHintMaxShort", { type: typeShort(ti) }) }}</button>
          <button
            type="button"
            class="qbtn"
            :class="{ on: hints[cursor] === HINT_SAME, 't-same': hints[cursor] === HINT_SAME }"
            :aria-pressed="hints[cursor] === HINT_SAME"
            :aria-label="t('toolbox.rail.optHintSame')"
            :title="t('toolbox.rail.optHintSameTip')"
            @click="recordHint(cursor, HINT_SAME)"
          >{{ t("toolbox.rail.optHintSameShort") }}</button>
        </div>
        <span v-else class="quick-na">{{ hintBlockedTip }}</span>
      </div>
    </section>
    <!-- ── 驾驶舱 · 主视区：下一站结论 ────────────────────────────────
         跑商时唯一必须一眼看清的东西。不确定时用占比条排序，
         条长即概率，比并排的百分比胶囊更快分辨「谁最可能」。 -->
    <section v-if="isHud" class="hero" :class="hero.cls">
      <div class="hero-head">
        <span class="hero-label"><Icon name="target" :size="13" />{{ hero.label }}</span>
        <!-- 「下一站」标签紧挨站号：这块答的是**前方那一站**是什么，不是脚下这一站。
             左侧录入卡写「当前站」、这里写「下一站」，两张卡各自在说哪一站才分得清。 -->
        <span v-if="hero.index !== null" class="hdr-tag" :title="t('toolbox.rail.hudNextTagTip')">{{ t("toolbox.rail.hudNextTag") }}</span>
        <span v-if="hero.index !== null" class="hero-nth">{{ stationName(hero.index) }}</span>
        <span v-if="hero.badge" class="hero-badge">{{ hero.badge }}</span>
      </div>

      <div class="hero-body">
        <!-- 确定与待定走同一个循环：确定时数组里只有一根 100% 的满条 -->
        <ul v-if="hero.bars" class="hero-bars">
          <li
            v-for="b in hero.bars"
            :key="b.ti"
            class="hero-bar"
            :class="[`t-${TYPE_KEYS[b.ti]}`, { locked: b.locked }]"
          >
            <span class="hb-name">{{ typeLabel(b.ti) }}</span>
            <span class="hb-track"><i class="hb-fill" :style="{ width: percent(b.ratio) }"></i></span>
            <span class="hb-pct">{{ percent(b.ratio) }}</span>
          </li>
        </ul>
        <p v-else class="hero-note">{{ hero.note }}</p>
      </div>

      <!-- 进度只留一根细条：旧版这里是「进度条 + 现在 N/16」一整行（29px），
           但站号已经由标题里的「第 N 站」给出，跑商时没人会去读「已记几站」——
           进度条负责「还剩多少」的整体感觉就够了。省下的 21px 全部让给下面的策略建议，
           英文文案较长时才不会把建议区顶到滚动。 -->
      <div class="hero-foot">
        <span class="hero-track"><i :style="{ width: progressPct }"></i></span>
      </div>
    </section>

    <!-- ── 路线条：只在完整版面出现 ────────────────────────────────────
         驾驶舱里它不成立。逐条对照「是否支持导航 / 理解 / 决策 / 行动」：
         跳站是低频操作（且有上/下一站按钮），已记的站你刚记过、未记的站全是「?」，
         16 个描边矩形反而构成视野里最强的栅格噪声。删掉它，回顾交给完整版面。 -->
    <section v-if="!isHud" class="route-card">
      <div class="strip">
        <div
          v-for="index in stationCount"
          :key="index"
          class="chip"
          :class="[
            observed[index - 1] !== null ? `t-${TYPE_KEYS[observed[index - 1]]}` : '',
            observed[index - 1] === null && result.locked[index - 1] && result.consistent ? 'locked' : '',
            observed[index - 1] === null ? 'future' : '',
            index - 1 === result.nextIndex && result.consistent ? 'current' : '',
          ]"
          :title="stationName(index - 1)"
        >
          <div class="chip-n">{{ stationNumber(index - 1) ?? t("toolbox.rail.origin") }}</div>
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

    <!-- ── 驾驶舱 · 建议：只留决定性条目 ────────────────────────────── -->
    <section v-if="isHud" class="hud-advice">
      <div class="hud-advice-head">
        <span class="hud-advice-title">{{ t("toolbox.rail.hudAdviceTitle") }}</span>
        <button
          v-if="hudAdviceMore > 0"
          class="hud-advice-more"
          type="button"
          :title="t('toolbox.rail.hudMoreTip', { n: hudAdviceMore })"
          @click="toggleView"
        >{{ t("toolbox.rail.hudMore", { n: hudAdviceMore }) }}</button>
        <span v-else-if="result.nextIndex === -1" class="hud-advice-more">{{ t("toolbox.rail.hudGoFull") }}</span>
      </div>
      <ul class="hud-advice-list">
        <li v-for="item in hudAdvice" :key="item.key" :class="`tone-${item.tone}`">
          <p class="adv-title">{{ item.title }}</p>
          <p v-if="item.act" class="adv-act">{{ item.act }}</p>
          <p v-if="item.detail" class="adv-detail">{{ item.detail }}</p>
        </li>
      </ul>
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
                <span v-else-if="observed[index - 1] !== null" class="tag" :class="`t-${TYPE_KEYS[observed[index - 1]]}`">
                  {{ typeLabel(observed[index - 1]) }}
                </span>
                <template v-else-if="!result.consistent">
                  <span class="tag muted">{{ t("toolbox.rail.inferConflict") }}</span>
                </template>
                <template v-else-if="result.possibleTypes[index - 1].length === 1">
                  <span class="tag" :class="`t-${TYPE_KEYS[result.possibleTypes[index - 1][0]]}`">
                    {{ typeLabel(result.possibleTypes[index - 1][0]) }}
                  </span>
                  <span class="lock-mark" :title="t('toolbox.rail.inferLocked')">100%</span>
                </template>
                <template v-else>
                  <span
                    v-for="ti in result.possibleTypes[index - 1]"
                    :key="ti"
                    class="tag soft"
                    :class="`t-${TYPE_KEYS[ti]}`"
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
            <p class="strong">
              {{ upcoming[0] && upcoming[0].locked
                ? t("toolbox.rail.nextCertain", { n: upcoming[0].nth, type: typeLabel(upcoming[0].types[0]) })
                : t("toolbox.rail.nextUncertain", { n: upcoming[0]?.nth ?? result.nextIndex + 1 }) }}
            </p>
            <div v-for="item in upcoming" :key="item.index" class="upcoming-row">
              <span class="up-nth">{{ stationName(item.index) }}</span>
              <span class="up-team">
                <span
                  v-for="ti in item.types"
                  :key="ti"
                  class="tag soft"
                  :class="`t-${TYPE_KEYS[ti]}`"
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
              <span v-else-if="observed[index - 1] !== null" class="tag" :class="`t-${TYPE_KEYS[observed[index - 1]]}`">
                {{ typeShort(observed[index - 1]) }}
              </span>
              <template v-else-if="!result.consistent">
                <span class="tag muted">{{ t("toolbox.rail.inferConflict") }}</span>
              </template>
              <template v-else-if="result.possibleTypes[index - 1].length === 1">
                <span class="tag" :class="`t-${TYPE_KEYS[result.possibleTypes[index - 1][0]]}`">
                  {{ typeShort(result.possibleTypes[index - 1][0]) }}
                </span>
                <span class="lock-mark">100%</span>
              </template>
              <template v-else>
                <span
                  v-for="ti in result.possibleTypes[index - 1]"
                  :key="ti"
                  class="tag soft"
                  :class="`t-${TYPE_KEYS[ti]}`"
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
   先把高度算清楚再排版。默认窗口 640×410，减去 40px 标题栏与 24px 内边距，
   内容区正好 346px，实测分配（紧凑密度、中英文一致）：

     row1 顶栏            32px
     row2 quick / hero   124px   （谁高谁定这一行，两者都是 124）
     row3 建议           174px   minmax(0, 1fr)，唯一可伸缩的一段
     两处行间距           16px
                       ─────
                        346px

   两条硬约束：
   1) 第 3 行是唯一伸缩段，它的 174px 必须容纳最长的建议内容。中文本就宽松（约 155px），
      英文更啰嗦但已收敛到 174px 内——加长任何 adv.* 文案前请先重新量一遍。
   2) 高度跌破 410 时率先不够的是建议区，而 .hud-advice 自带 overflow-y:auto，
      所以表现为「滚一下」而不是被 .tw-body 的 overflow:hidden 无声裁掉。
      窄于 620px 时整块改竖排、由 .rail-tool 自己滚，见文件末尾的自适应段。
   完整版面仍是纵向流（.is-full），它自带滚动容器。 */
/* position: relative 只为「全部记录」覆盖层兜底：它要盖住整块驾驶舱而不是整页 */
.rail-tool { position: relative; height: 100%; min-height: 0; }

.rail-tool.is-full { display: flex; flex-direction: column; gap: var(--sp-3); }

/* 两栏是「先记后看」的顺序：左栏是手上的动作（记当前站），右栏是它的产出（下一站是什么）。
   列宽不是对半分，而是按两边**实测的自然宽**反推（cdp 的 need/debug 探针，见 _cdp.mjs）：
   左栏提示行中文要 348px、英文要 392px；右栏头部中文 175px、英文 203px。
   英文两样加起来 595px > 可用 608 − 边距，**在 640 宽里不可能都排成一行**——
   英文的提示行本来就会折（改版前也一样），所以比例按「保中文一行 + 保英文头部不溢出」定。
   结论：1.62 : 1（实测 381 / 235），两边各留 15px / 9px 余量。 */
.rail-tool.is-hud {
  display: grid;
  grid-template-columns: minmax(0, 1.62fr) minmax(0, 1fr);
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: var(--sp-2);
}
.rail-tool.is-hud > .action-bar { grid-area: 1 / 1 / 2 / -1; }
.rail-tool.is-hud > .quick { grid-area: 2 / 1 / 3 / 2; }
.rail-tool.is-hud > .hero { grid-area: 2 / 2 / 3 / 3; }
.rail-tool.is-hud > .hud-advice { grid-area: 3 / 1 / 4 / -1; }
/* 16 站全记完后录入区收起，结论独占整行——否则它会缩在半边、旁边空一大块，
   而那段说明文字还会在同一处宽度里折成三行。 */
.rail-tool.is-hud:not(:has(.quick)) > .hero { grid-column: 1 / -1; }

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

/* ── 顶栏 16 格记录条（只在驾驶舱出现） ──────────────────────────────
   一格一站，从始发站排到终点站，回答「我记到哪了、哪站还欠一半」。
   三档全部落在背景与边框上，字只放站号（始发站不编号，用「始」占一格）：
     empty 空心描边 · half 浅底 · done 主色浅底 + 主色边 · 当前站再套一圈主色内描边
   两条硬约束：
   ① **顶栏不许因为这条而换行**——顶栏长高会直接吃掉下面建议区的高度，
      而建议区（174px）是全窗口唯一的弹性段。所以格子用 minmax(0, 1fr) 跟着一起缩，
      整条 min-width: 0，永不换行；640px 下实测每格约 15px（两位站号 12px，够放）。
   ② 圆角给 3px 而不是 var(--r-xs)：6px 落在 14×16 的小格上会变成胶囊形。 */
.mini-strip { display: grid; flex: 1 1 auto; grid-template-columns: repeat(16, minmax(0, 1fr)); gap: 1px; min-width: 0; margin: 0; padding: 0; list-style: none; }
.mini-cell { display: flex; align-items: center; justify-content: center; height: 16px; min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 3px; background: transparent; color: var(--text-dim); font-family: var(--font-num); font-size: var(--fs-xs); line-height: 1; }
.mini-cell.st-half { border-color: var(--border-strong); background: var(--well); color: var(--text-soft); }
.mini-cell.st-done { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); }
.mini-cell.current { box-shadow: inset 0 0 0 1px var(--primary); border-color: var(--primary); color: var(--primary-hover); font-weight: 700; }

/* 格子里的结果字：颜色跟类型走（与推断占比条/类型标签同一套色，看色即知是哪类）。
   放在进度三档之后声明——同特异性下后者胜，结果色盖过进度底色：
   有结果的格子颜色本身就同时在报「是什么」和「记了没」。 */
.mini-cell.t-winery { border-color: var(--warn-border); background: var(--warn-soft); color: var(--warn-deep); }
.mini-cell.t-eatery { border-color: var(--success-border); background: var(--success-tint); color: var(--success-deep); }
.mini-cell.t-trade { border-color: var(--border-blue); background: var(--sky-soft); color: var(--sky-deep); }
/* 推断确认但未录入：虚框 + 透明底。结果可以提前写进格子，「录没录过」必须一眼分得开。 */
.mini-cell.pred { background: transparent; border-style: dashed; }
.mini-cell.pred.t-winery { border-color: var(--warn-border); color: var(--warn-deep); }
.mini-cell.pred.t-eatery { border-color: var(--success-border); color: var(--success-deep); }
.mini-cell.pred.t-trade { border-color: var(--border-blue); color: var(--sky-deep); }
/* 末格是终点站：右侧加粗一档，让「这条线到哪儿为止」看得出来 */
.mini-cell.end { border-right-width: 2px; }

/* ── 路线条 ───────────────────────────────────────────────────────── */
.route-card { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; padding: var(--sp-3); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.rail-tool.is-full > .route-card { flex-shrink: 0; padding: var(--sp-3) var(--sp-4); }
.strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(56px, 1fr)); gap: var(--sp-1); }
.chip { min-width: 0; padding: var(--sp-1) 2px; border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--well); text-align: center; }
.chip-n { color: var(--text-dim); font-family: var(--font-num); font-size: var(--fs-xs); line-height: var(--lh-tight); }
.chip-t { overflow: hidden; color: var(--text-soft); font-size: var(--fs-sm); font-weight: 700; line-height: var(--lh-tight); text-overflow: ellipsis; white-space: nowrap; }
.chip.future .chip-n { color: var(--primary); }
.chip.locked { border-width: 2px; border-color: var(--primary); }
.chip.future.locked .chip-n { color: var(--primary-hover); }
/* 当前站用外轮廓而非 border，避免和「已锁死」的粗边互相覆盖 */
.chip.current { outline: 2px solid var(--primary); outline-offset: 1px; box-shadow: var(--glow-sm); }
.chip.t-winery { background: var(--warn-soft); border-color: var(--warn-border); }
.chip.t-winery .chip-t { color: var(--warn-deep); }
.chip.t-eatery { background: var(--success-tint); border-color: var(--success-border); }
.chip.t-eatery .chip-t { color: var(--success-deep); }
.chip.t-trade { background: var(--sky-soft); border-color: var(--border-blue); }
.chip.t-trade .chip-t { color: var(--sky-deep); }

.legend { display: flex; flex-wrap: wrap; gap: var(--sp-4); color: var(--text-dim); font-size: var(--fs-xs); }
.legend span { display: inline-flex; align-items: center; gap: var(--sp-1); }
.dot { width: 10px; height: 10px; border-radius: var(--r-xs); }
.dot.solid { background: var(--well); border: 1px solid var(--border-strong); }
.dot.ring { background: var(--card); border: 2px solid var(--primary); }
.dot.future { background: var(--primary-soft); border: 1px solid var(--border-blue); }

/* ── 驾驶舱 · 结论（主视区）─────────────────────────────────────────
   整个 HUD 的视觉重心：只有它用彩色左描边 + 彩色底，也只有它用大字。
   「不确定」不再并排几个百分比胶囊，而是按概率降序的占比条——
   长度即概率，横向比较比读四个百分比更快。 */
.hero {
  display: flex;
  flex-direction: column;
  /* 竖向收到 --sp-2：640×410 下每 1px 都要用在内容上。
     横向也从 --sp-4 收到 --sp-3：左侧已经有 4px 彩色描边撑着，视觉缩进不变，
     省下的 4px 全给了头部——英文「Predicted · Next · Stop 1 · Open」正好卡在这一栏的边缘上。
     line-height 取 --lh-tight：三根占比条各占一行，沿用正文字距会白吃掉约 10px 高度。 */
  gap: var(--sp-1);
  min-width: 0;
  min-height: 0;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--card-border);
  border-left: 4px solid var(--primary);
  border-radius: var(--r-md);
  background: var(--card);
  line-height: var(--lh-tight);
}
/* 头部四件（推断 · 下一站 · 第 N 站 · 待定）间距取 4px，与 .quick-head 同一约定：
   英文的 "Predicted / Next / Stop 1 / Open" 在这一栏里只差 6px 就会顶出卡片右边界
   （实测自然宽 209px、可用 203px；收到 4px 后留 12px 余量）。 */
.hero-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.hero-label { display: inline-flex; align-items: center; gap: 4px; color: var(--text-dim); font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.08em; white-space: nowrap; }
.hero-nth { color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; white-space: nowrap; }
.hero-badge { margin-left: auto; padding: 0 6px; border: 1px solid var(--border-strong); border-radius: var(--r-pill); background: var(--card); color: var(--text-weak); font-size: var(--fs-xs); font-weight: 700; white-space: nowrap; }
.hero-body { min-height: 0; overflow-y: auto; }
.hero-bars { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; padding: 0; list-style: none; }
/* 名字列用 auto 而不是写死 3.4em：英文类型名（"Trading house"）比中文长一倍，
   固定宽度会把它折成两行——那正是 640 宽下白吃掉 20px 高度、把建议区挤掉的元凶。 */
.hero-bar { display: grid; grid-template-columns: minmax(0, auto) minmax(28px, 1fr) 3.2em; align-items: center; gap: var(--sp-2); }
.hb-name { overflow: hidden; color: var(--text); font-size: var(--fs-md); font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.hb-track { height: 8px; overflow: hidden; border-radius: var(--r-pill); background: var(--well); }
.hb-fill { display: block; height: 100%; border-radius: inherit; background: var(--primary); transition: width 0.2s; }
.hb-pct { overflow: hidden; color: var(--text-weak); font-family: var(--font-num); font-size: var(--fs-sm); font-weight: 700; text-align: right; white-space: nowrap; }
/* 锁死：同一根条顶满 100%，只是名字、条高、百分比各上一个字号档。
   不再换成「一个超大类型名」那种另一套隐喻——用户不必重新学「锁死长什么样」，
   而且 100% 直接写在条尾，能一眼分清「确定」和「只是最可能」。 */
.hero-bar.locked { gap: var(--sp-3); }
.hero-bar.locked .hb-name { font-size: var(--fs-lg); font-weight: 800; letter-spacing: 0.02em; }.hero-bar.locked .hb-track { height: 12px; }
.hero-bar.locked .hb-pct { font-size: var(--fs-base); font-weight: 800; }
.hero-bar.locked.t-winery .hb-pct { color: var(--warn-deep); }
.hero-bar.locked.t-eatery .hb-pct { color: var(--success-deep); }
.hero-bar.locked.t-trade .hb-pct { color: var(--sky-deep); }
.hero-bar.t-winery .hb-fill { background: var(--warn); }
.hero-bar.t-winery .hb-name { color: var(--warn-deep); }
.hero-bar.t-eatery .hb-fill { background: var(--success); }
.hero-bar.t-eatery .hb-name { color: var(--success-deep); }
.hero-bar.t-trade .hb-fill { background: var(--sky); }
.hero-bar.t-trade .hb-name { color: var(--sky-deep); }
.hero-note { margin: 0; color: var(--text-weak); font-size: var(--fs-sm); line-height: var(--lh-body); }
/* 进度贴在卡片底部：它是全局状态，不该抢结论的位置，但必须随时可见 */
.hero-foot { margin-top: auto; padding-top: var(--sp-1); }
.hero-track { display: block; width: 100%; height: 4px; overflow: hidden; border-radius: var(--r-pill); background: var(--well); }
.hero-track i { display: block; height: 100%; border-radius: inherit; background: var(--primary); transition: width 0.2s; }

.hero.t-winery { background: var(--warn-soft); border-color: var(--warn-border); border-left-color: var(--warn); }
.hero.t-winery .hero-label, .hero.t-winery .hero-nth { color: var(--warn-deep); }
.hero.t-winery .hero-track i { background: var(--warn); }
.hero.t-winery .hero-badge { border-color: var(--warn); color: var(--warn-deep); }
.hero.t-eatery { background: var(--success-tint); border-color: var(--success-border); border-left-color: var(--success); }
.hero.t-eatery .hero-label, .hero.t-eatery .hero-nth { color: var(--success-deep); }
.hero.t-eatery .hero-track i { background: var(--success); }
.hero.t-eatery .hero-badge { border-color: var(--success); color: var(--success-deep); }
.hero.t-trade { background: var(--sky-soft); border-color: var(--border-blue); border-left-color: var(--sky); }
.hero.t-trade .hero-label, .hero.t-trade .hero-nth { color: var(--sky-deep); }
.hero.t-trade .hero-track i { background: var(--sky); }
.hero.t-trade .hero-badge { border-color: var(--sky); color: var(--sky-deep); }
.hero.t-open { border-color: var(--border-blue); border-left-color: var(--primary); }
.hero.t-open .hero-badge { border-color: var(--primary); color: var(--primary-hover); }
.hero.t-done { border-color: var(--success-border); border-left-color: var(--success); }
.hero.t-done .hero-note { color: var(--success-deep); }
.hero.t-done .hero-track i { background: var(--success); }
.hero.t-done .hero-badge { border-color: var(--success); color: var(--success-deep); }
.hero.t-danger { background: var(--danger-soft); border-color: var(--border-danger); border-left-color: var(--danger); }
.hero.t-danger .hero-label, .hero.t-danger .hero-note { color: var(--danger-deep); }
.hero.t-danger .hero-track i { background: var(--danger); }
.hero.t-danger .hero-badge { border-color: var(--danger); color: var(--danger-deep); }

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
  overflow-y: auto;
  padding: var(--sp-3);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  background: var(--card);
}
/* 间距收到 4px（与 .quick-row 同一约定）：头部要放下「站号 + 漏提示 + 清除 + 全部记录」
   四件，英文下按 --sp-2(8px) 算会折成两行，把底下的建议区挤到溢出。 */
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
/* 漏提示可以点：直接切到完整版面补录。做成按钮而不是死文字，
   省掉「我记得有个地方能改」这一步回忆。 */
.quick-debt { display: inline-flex; align-items: center; gap: 3px; height: 24px; padding: 0 var(--sp-2); border: 1px solid var(--warn-border); border-radius: var(--r-pill); background: var(--warn-soft); color: var(--warn-deep); font-size: var(--fs-xs); font-weight: 700; white-space: nowrap; cursor: pointer; }
.quick-debt:hover { border-color: var(--warn); box-shadow: var(--glow-sm); }
.quick-spacer { flex: 1; min-width: 0; }
/* 头部的小动作按钮（清除本站 / 全部记录 / 覆盖层关闭钮）。
   这一族原本是「上一站 / 下一站」翻站按钮，现在只服务「改记录」——高 24px 与 .quick-debt 对齐。 */
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
/* 选中态走「浅底 + 同色粗边 + 同色文字」而不是饱和实底：
   实底配白字只在浅色主题成立（深色主题的 --warn 是亮琥珀，白字对比度不足 3:1）。 */
.qbtn.on { border-width: 2px; box-shadow: var(--glow-sm); }
.qbtn.on.t-winery { background: var(--warn-soft); border-color: var(--warn); color: var(--warn-deep); }
.qbtn.on.t-eatery { background: var(--success-tint); border-color: var(--success); color: var(--success-deep); }
.qbtn.on.t-trade { background: var(--sky-soft); border-color: var(--sky); color: var(--sky-deep); }
.qbtn.on.t-same { background: var(--primary-soft); border-color: var(--primary); color: var(--primary-hover); }
.quick-na { color: var(--faint); font-size: var(--fs-sm); line-height: var(--lh-body); }
/* 提示覆盖范围（「→ 第 4~6 站」）：这是整块版面里最该先读的一句口径——
   记错一站，后面所有推断和冲突判定都会歪，而事后从界面上看不出来。
   排在按钮前面（不是后面）：四个按钮的位置要在任何站都一致，才能形成肌肉记忆。
   也正因为排在前面，它必须够短（--fs-xs）：640px 下提示行四个按钮刚好占满。 */
.quick-covers { flex-shrink: 0; color: var(--faint); font-family: var(--font-num); font-size: var(--fs-xs); }


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

/* ── 驾驶舱 · 建议 ─────────────────────────────────────────────────
   窗口被拉矮时这里先滚动：结论与录入都是「此刻必须能操作」的，
   建议是「可以慢慢看」的，压缩顺序按重要性来。 */
.hud-advice { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.hud-advice-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
/* 段标题用正文色 + 正文最大字号：「记录本站」与「这一站怎么做」是两个平行段，
   规格必须一致。旧版这里做成 12.5px 灰字 + 字距，比它的内容还弱，属于层级倒挂。 */
.hud-advice-title { color: var(--text); font-size: var(--fs-base); font-weight: 600; }
.hud-advice-more { padding: 0 var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--r-pill); background: var(--well); color: var(--text-weak); font-size: var(--fs-xs); font-weight: 700; cursor: pointer; }
.hud-advice-more:hover { background: var(--well-hover); color: var(--text); }
/* auto 上下外边距把列表在自己那一段里居中：只剩一条建议时（锁死 / 冲突 / 全程记完）
   底部会空出一大块，居中后读起来像是「这一段到此为止」，而不是内容没渲染出来。
   用 auto margin 而不是 justify-content: center——后者在溢出时会把第一项顶到滚动不到的地方。 */
.hud-advice-list { display: flex; flex-direction: column; gap: var(--sp-1); margin: auto 0; padding: 0; list-style: none; }
.hud-advice-list li { padding: 5px var(--sp-3); border-left: 3px solid var(--border-strong); border-radius: var(--r-xs); background: var(--card-soft); }
.hud-advice-list li.tone-success { border-left-color: var(--success); background: var(--success-tint); }
.hud-advice-list li.tone-warn { border-left-color: var(--warn); background: var(--warn-soft); }
.hud-advice-list li.tone-danger { border-left-color: var(--danger); background: var(--danger-soft); }

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
.tag.t-winery { background: var(--warn-soft); color: var(--warn-deep); }
.tag.t-eatery { background: var(--success-tint); color: var(--success-deep); }
.tag.t-trade { background: var(--sky-soft); color: var(--sky-deep); }
.tag.soft { background: transparent; border: 1px solid var(--border-strong); color: var(--text-weak); }
.tag.soft.t-winery { border-color: var(--warn-border); color: var(--warn-deep); }
.tag.soft.t-eatery { border-color: var(--success-border); color: var(--success-deep); }
.tag.soft.t-trade { border-color: var(--border-blue); color: var(--sky-deep); }
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

/* 深色下 --sky-deep（#0369a1）在 --sky-soft（#0c2a3a）上对比度不足，换亮蓝字 */
@media (prefers-color-scheme: dark) {
  .chip.t-trade .chip-t,
  .tag.t-trade,
  .tag.soft.t-trade,
  .hero-bar.t-trade .hb-name,
  .hero.t-trade .hero-label,
  .hero.t-trade .hero-nth,
  .hero.t-trade .hero-badge { color: var(--primary-bright); }
}

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

/* 驾驶舱窄窗（< 620px）：左右分栏会把提示按钮组压到排不下四个，
   改回纵向并整体滚动——宁可让用户滚一下，也不能把内容静默裁掉。
   断点必须低于默认窗口宽度 640，否则默认尺寸就会掉进竖排。 */
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
  .rail-tool.is-hud > .action-bar { grid-area: 1 / 1 / 2 / 2; }
  /* 竖排时仍按「先记后看」：录入卡在上，结论卡在下——与宽窗的左→右顺序一致 */
  .rail-tool.is-hud > .quick { grid-area: 2 / 1 / 3 / 2; }
  .rail-tool.is-hud > .hero { grid-area: 3 / 1 / 4 / 2; }
  .rail-tool.is-hud > .hud-advice { grid-area: 4 / 1 / 5 / 2; }
  .rail-tool.is-hud > .quick,
  .rail-tool.is-hud > .hero,
  .rail-tool.is-hud > .hud-advice,
  .rail-tool.is-hud .hero-body { overflow: visible; }
}
</style>
