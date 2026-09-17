// 手机版 HUD 的纯视图逻辑：把 railTycoon.js 的求解结果翻成「界面上要渲染什么」。
//
// 与桌面版 RailTycoonTool.vue 的关系：**规则与判据全部来自 railTycoon.js，这里不重写任何一条**。
// 重写的只有版面决策（手机是竖排、单列、拇指区），以及「哪些信息在手机上值得占地方」。
//
// 为什么单独分出这个文件：main.js 直接操作 DOM（查不了单测），而这些换算逻辑是最容易出错、
// 也最值得锁住的部分（站号口径、提示覆盖范围、格子该显示什么字）。所以 DOM 层保持极薄。
//
// 站号口径（与 railTycoon.js 一致，这里只做转述）：数组下标 0 是**始发站**，它不参与
// 「第 N 站」编号，所以「第 N 站」落在下标 N 上——不是下标 + 1。全线站号只在 stationNumber() 算。

import {
  buildAdvice,
  CELL_LABEL,
  CELL_PREDICT,
  CELL_RECORD,
  firstIncomplete,
  HINT_SAME,
  hintMax,
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
} from "../../src/tools/railTycoon.js";
import { t } from "./i18n.js";

/** HUD 里不展示的通用节奏建议——它们是常驻提醒，不该占手机那块小屏幕。 */
const HUD_ADVICE_SKIP = new Set(["backToBack", "rhythm"]);

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const TYPE_LABEL_KEYS = TYPE_KEYS.map((k) => `type${capitalize(k)}`);
const TYPE_SHORT_KEYS = TYPE_KEYS.map((k) => `short${capitalize(k)}`);
const TYPE_CELL_KEYS = TYPE_KEYS.map((k) => `cell${capitalize(k)}`);

export const typeLabel = (index) => t(TYPE_LABEL_KEYS[index]);
export const typeShort = (index) => t(TYPE_SHORT_KEYS[index]);
export const typeCell = (index) => t(TYPE_CELL_KEYS[index]);
export const percent = (value) => `${Math.round(value * 100)}%`;

/** 站名：始发站用「始发站」，其余「第 N 站」。 */
export function stationName(index) {
  const n = stationNumber(index);
  return n === null ? t("origin") : t("nthStation", { n });
}

/** 该站的提示覆盖哪 3 站；末尾凑不满 3 站的站返回 null。 */
export function hintWindow(index, stationCount = STATION_COUNT) {
  if (index < ORIGIN_INDEX || index > stationCount - 4) return null;
  return { from: stationNumber(index + 1), to: stationNumber(index + 3) };
}

export function hintCoversShort(index, stationCount = STATION_COUNT) {
  const w = hintWindow(index, stationCount);
  return w ? t("hintCoversShort", { from: w.from, to: w.to }) : "";
}

export const isOrigin = (index) => stationNumber(index) === null;

export const hintable = (index, stationCount = STATION_COUNT) =>
  hintWindow(index, stationCount) !== null;

/** 已录提示的短文案（`数量相同` / `酒庄最多`）。按值反查，不去解析编码。 */
export function hintText(value) {
  if (value === null || value === undefined) return "";
  if (value === HINT_SAME) return t("optHintSameShort");
  const ti = TYPE_KEYS.findIndex((_, i) => hintMax(i) === value);
  return ti === -1 ? "" : t("optHintMaxShort", { type: typeShort(ti) });
}

/** 一条建议拆成三段，各取各的 i18n 键；缺段返回空串（渲染层据此跳过）。 */
export function adviceView(result) {
  return buildAdvice(result, { stationCount: result.stationCount }).map((item) => {
    const part = (name) => {
      const value = t(`adv.${item.key}.${name}`, {
        type: typeLabel(item.typeIndex ?? 0),
        what: culpritText(item.culprits),
      });
      // t() 找不到键时返回键名本身——这里靠「返回值等于键名」判断该段不存在
      return value === `adv.${item.key}.${name}` ? "" : value;
    };
    return { key: item.key, tone: item.tone, title: part("title"), act: part("act"), detail: part("detail") };
  });
}

/** 冲突时诊断出的可疑录入渲染成「第 3 站的提示、第 4 站的类型」。 */
export function culpritText(culprits = []) {
  return culprits
    .map((c) =>
      c.kind === "hint"
        ? t("culpritHint", { name: stationName(c.index) })
        : t("culpritType", { name: stationName(c.index) }),
    )
    .join(t("culpritSep"));
}

/**
 * 结论块：只回答一个问题——下一站是什么。
 * 确定与待定共用同一套占比条隐喻（确定时收敛成一根 100% 满条），理由见桌面版同名逻辑。
 */
export function heroView(result) {
  if (!result.consistent) {
    const what = culpritText(buildAdvice(result, { stationCount: result.stationCount })
      .find((item) => item.key === "conflict")?.culprits ?? []);
    return {
      kind: "conflict",
      cls: "t-danger",
      label: t("hudInferLabel"),
      badge: null,
      index: null,
      note: what ? t("conflictCulprits", { what }) : t("conflictDesc"),
    };
  }
  if (result.nextIndex === -1) {
    return { kind: "done", cls: "t-done", label: t("hudInferLabel"), badge: null, index: null, note: t("hudDoneAllDesc") };
  }
  const index = result.nextIndex;
  const types = result.possibleTypes[index];
  if (result.locked[index]) {
    return {
      kind: "certain",
      cls: `t-${TYPE_KEYS[types[0]]}`,
      label: t("hudInferLabel"),
      badge: t("hudCertain"),
      index,
      bars: [{ ti: types[0], ratio: 1, locked: true }],
    };
  }
  return {
    kind: "open",
    cls: "t-open",
    label: t("hudInferLabel"),
    badge: t("hudOpen"),
    index,
    bars: types
      .map((ti) => ({ ti, ratio: result.ratio[index][ti], locked: false }))
      .sort((a, b) => b.ratio - a.ratio),
  };
}

/** 16 格记录条上某一格的呈现：写什么字、带哪些类。判据在 stripCellContent / stationRecordState。 */
export function stripCellView(result, observed, hints, index, cursor) {
  const obs = observed[index];
  let predicted = null;
  if (obs === null && !isOrigin(index) && result.consistent && result.locked[index]) {
    predicted = result.possibleTypes[index][0];
  }
  const content = stripCellContent(obs, predicted);
  const classes = [`st-${stationRecordState(observed, hints, index, result.stationCount)}`];
  if (content.typeIndex !== null) classes.push(`t-${TYPE_KEYS[content.typeIndex]}`);
  if (content.kind === CELL_PREDICT) classes.push("pred");
  if (index === cursor) classes.push("current");
  if (index === result.stationCount - 1) classes.push("end");
  return {
    text: content.kind === CELL_LABEL
      ? (stationNumber(index) === null ? t("stripOrigin") : String(stationNumber(index)))
      : typeCell(content.typeIndex),
    kind: content.kind,
    typeIndex: content.typeIndex,
    classes,
  };
}

/** 一格的长说明（title / aria）。格子里只放得下一个字，其余全靠这一行。 */
export function stripTip(result, observed, hints, index) {
  const view = stripCellView(result, observed, hints, index, -1);
  const state = stationRecordState(observed, hints, index, result.stationCount);
  const bits = [
    stationName(index),
    state === RECORD_DONE ? t("stripDone") : state === RECORD_HALF ? t("stripHalf") : t("stripEmpty"),
  ];
  if (view.kind === CELL_RECORD) bits.push(typeLabel(view.typeIndex));
  else if (view.kind === CELL_PREDICT) bits.push(t("stripPred", { type: typeLabel(view.typeIndex) }));
  const h = hintText(hints[index]);
  if (h) bits.push(h);
  return bits.join(" · ");
}

/** 一行文本结论，供复制到另一台设备 / 聊天窗口。 */
export function summaryText(result, observed, hints) {
  const lines = [t("copyTitle")];
  if (!result.consistent) {
    lines.push(t("conflictTitle"));
    const what = culpritText(buildAdvice(result, { stationCount: result.stationCount })
      .find((item) => item.key === "conflict")?.culprits ?? []);
    if (what) lines.push(t("conflictCulprits", { what }));
    return lines.join("\n");
  }
  if (result.nextIndex === -1) {
    lines.push(t("allKnownTitle"));
    return lines.join("\n");
  }
  for (const item of upcoming(result)) {
    lines.push(`${stationName(item.index)}：${item.types.map(typeLabel).join(" / ")}`);
  }
  for (const item of adviceView(result)) {
    lines.push(`· ${item.title}${item.act ? ` — ${item.act}` : ""}`);
  }
  return lines.join("\n");
}

/** 从首个未确认站起，最多往后看 3 站。 */
export function upcoming(result) {
  const start = result.nextIndex;
  if (start === -1) return [];
  const out = [];
  for (let k = 0; k < 3 && start + k < result.stationCount; k += 1) {
    const index = start + k;
    if (result.known[index]) continue;
    out.push({
      index,
      types: result.possibleTypes[index],
      locked: result.locked[index],
      ratio: result.ratio[index],
    });
  }
  return out;
}

/** 已确认类型的站点数（始发站没有类型，不计入）。 */
export function typedCount(observed, stationCount = STATION_COUNT) {
  return observed.filter((v, i) => i > ORIGIN_INDEX && v !== null).length;
}

export function progressPct(observed, stationCount = STATION_COUNT) {
  return `${Math.round((typedCount(observed, stationCount) / Math.max(1, stationCount - 1)) * 100)}%`;
}

/** 光标之前那些站里漏掉的提示数。漏提示 = 推断变弱，所以要显式提示。 */
export function missingHints(observed, hints, cursor, stationCount = STATION_COUNT) {
  let n = 0;
  for (let i = 0; i < cursor; i += 1) {
    if (hintable(i, stationCount) && hints[i] === null) n += 1;
  }
  return n;
}

export function allRecorded(observed, hints, stationCount = STATION_COUNT) {
  return firstIncomplete(observed, hints, stationCount) === -1;
}

/** HUD 建议：只留决定性条目；被折叠的那几条单独返回（手机上默认收起）。 */
export function hudAdvice(result) {
  const all = adviceView(result);
  return {
    items: all.filter((item) => !HUD_ADVICE_SKIP.has(item.key)),
    folded: all.filter((item) => HUD_ADVICE_SKIP.has(item.key)),
  };
}

export { HUD_ADVICE_SKIP, TYPE_KEYS, HINT_SAME, hintMax, isStationComplete, nextIncompleteAfter, normalizeHint, normalizeType, solveRailRoute, STATION_COUNT, ORIGIN_INDEX };
