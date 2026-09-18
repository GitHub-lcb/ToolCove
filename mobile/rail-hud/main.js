// 铁路大亨 · 手机版 HUD（原生 DOM，无框架）。
//
// 用途有三个，同一份代码：
//   1. Android 悬浮窗里的那个小面板（mode=panel，约 360×260dp，压在游戏上）；
//   2. Android 全屏页（mode=full）；
//   3. 手机浏览器直接打开（静态托管 / 本地文件）。
//
// 与桌面版 RailTycoonTool.vue 的关系：**求解与建议逻辑一行不改**，直接 import 同一个
// railTycoon.js；界面是重写的，因为手机是竖排、单列、拇指区，桌面那套 640×410 的左右分栏
// 在手机上会把提示按钮组压到排不下四个。
//
// 三条版面约定（改动前请先想清楚）：
//   ① 结论永远在最上面且不随滚动消失——跑商时唯一必须一眼看清的东西；
//   ② 录入按钮永远在最下面（拇指区），滚动中间那段不会把它顶走；
//   ③ panel 模式不滚动：整块面板必须一屏放得下，否则浮在游戏上时看不到结论。
//
// 状态只有一份（observed / hints / cursor），存在 localStorage，并实时回传给原生侧
// （window.railHudApi），这样悬浮窗和全屏页读的是同一份进度。

import { initLocale, isPanelMode, hasNative, setLocale, setPanelMode, t } from "./i18n.js";
import {
  canHintAt,
  HINT_SAME,
  hintMax,
  isStationComplete,
  nextIncompleteAfter,
  stationNumber,
} from "../../src/tools/railTycoon.js";
import {
  allRecorded,
  heroView,
  hintCoversShort,
  hintable,
  hudAdvice,
  isOrigin,
  lockedTypeAt,
  missingHints,
  percent,
  progressPct,
  stationName,
  stripCellView,
  stripTip,
  summaryText,
  TYPE_KEYS,
  typeLabel,
  typeShort,
} from "./view.js";
import {
  decodeState,
  describeState,
  exportFileName,
  IMPORT_ERRORS,
  normalizeState,
  STATE_KEY,
  toJSON,
} from "./data.js";
import { solveRailRoute } from "../../src/tools/railTycoon.js";

// ── 极简 DOM 助手 ────────────────────────────────────────────────────
// 不用模板字符串拼 HTML：那需要手动转义每一个文案（文案里有 「」、《》、{n} 之类），
// 漏一处就是注入口。直接建元素没有这个问题。
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "html") el.innerHTML = value;
    else if (key.startsWith("data-") || key === "role" || key.startsWith("aria-")) el.setAttribute(key, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
  }
  return el;
}

const $ = (sel) => document.querySelector(sel);

/**
 * 转交全屏页的动作名。
 *
 * 这四个字符串必须与 Kotlin 侧 SupportActivity 的常量**逐字一致**——它们是
 * JS 与原生之间唯一的协议，写错不会编译报错，只会「点了没反应」。
 * EXPORT / IMPORT 目前没有调用点，但**不能删**：dom.test.js 会逐个核对四个名字与 Kotlin 一致。
 */
/* eslint-disable no-unused-vars -- 见上：这两个常量是 JS↔原生协议的一部分，由契约测试守着 */
const ACTION_EXPORT = "com.githublcb.railpanel.EXPORT";
const ACTION_IMPORT = "com.githublcb.railpanel.IMPORT";
/* eslint-enable no-unused-vars */
const ACTION_RECORDS = "com.githublcb.railpanel.RECORDS";
const ACTION_RESET = "com.githublcb.railpanel.RESET";

/** 原生桥：Android 侧注入 window.railHudApi 后接管「保存文件 / 选文件」这两件 WebView 做不好的事。 */
const native = typeof window !== "undefined" ? window.railHudApi ?? null : null;

// ── 状态 ────────────────────────────────────────────────────────────
let state = normalizeState(null);
let result = solveRailRoute(state);
let mode = "full";
let adviceOpen = false;
let toastTimer = null;
/** 「推断自动填入」类型的站下标：格子加虚线下划线，手动改过后移除（与桌面端同一套语言）。 */
let autoFilled = [];
/** 竖屏 / 横屏。由原生持久化并随 bootstrap 注入；浏览器里退回屏幕实际方向。 */
let orientation = "portrait";

function load() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return;
    state = normalizeState(JSON.parse(raw));
  } catch {
    state = normalizeState(null);
  }
}

function persist({ notifyNative = true } = {}) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用（隐私模式 / 配额）不该让界面停摆，继续用内存里的状态。
  }
  if (notifyNative && native?.onStateChanged) {
    try {
      native.onStateChanged(JSON.stringify(state));
    } catch {
      // 原生侧丢了这份状态不影响前端继续跑
    }
  }
}

function setState(next, { persist: save = true, notifyNative = true } = {}) {
  state = next;
  result = solveRailRoute(state);
  render();
  if (save) persist({ notifyNative });
}

function recordType(index, typeIndex) {
  const observed = state.observed.slice();
  observed[index] = observed[index] === typeIndex ? null : typeIndex;
  // 手动改动（含清除）后不再是「推断自动填入」
  autoFilled = autoFilled.filter((i) => i !== index);
  setState({ ...state, observed });
}

function recordHint(index, value) {
  const hints = state.hints.slice();
  hints[index] = hints[index] === value ? null : value;
  setState({ ...state, hints });
}

/**
 * 把当前站换成「推断已确定」的类型；返回 [新状态, 是否填了]。
 * 不改变解空间（所有合法排列本就都取这一类），只是把已知结论落到记录上。
 */
function withPrefill(next) {
  const index = next.cursor;
  if (next.observed[index] !== null) return [next, false];
  const type = lockedTypeAt(solveRailRoute(next), index);
  if (type === null) return [next, false];
  const observed = next.observed.slice();
  observed[index] = type;
  if (!autoFilled.includes(index)) autoFilled = [...autoFilled, index];
  return [{ ...next, observed }, true];
}

/**
 * 去下一站（显式动作，录入区底部的按钮）。
 *
 * 为什么不自动前进：记完提示 ≠ 离开这一站——玩家还在本站购物、选卡，自动跳站会让
 * 「当前站」跟着跑到下一站。推进时下一站若推断已确定，类型自动补上（只需记提示）；
 * 已记全的站会被跳过（历史站留下的空档不会挡路）。
 */
function goNext() {
  if (!isStationComplete(state.observed, state.hints, state.cursor, result.stationCount)) return;
  let next = state;
  for (let guard = 0; guard < result.stationCount; guard += 1) {
    const to = nextIncompleteAfter(next.observed, next.hints, next.cursor, result.stationCount);
    if (to === -1) break;
    next = { ...next, cursor: to };
    const [filled, prefilled] = withPrefill(next);
    next = filled;
    if (!prefilled) break;
    if (!isStationComplete(next.observed, next.hints, next.cursor, result.stationCount)) break;
  }
  setState(next);
}

/** 手动跳到某一站（点进度格 / 覆盖层的站号）：顺手把推断已确定的类型补上。 */
function selectStation(index) {
  const [next, prefilled] = withPrefill({ ...state, cursor: index });
  setState(next, prefilled ? {} : { persist: false });
}

function clearStation(index) {
  const observed = state.observed.slice();
  const hints = state.hints.slice();
  observed[index] = null;
  hints[index] = null;
  setState({ ...state, observed, hints });
}

function resetAll() {
  setState(normalizeState(null));
  closeDialog();
  toast(t("resetConfirmOk"));
}

// ── 渲染 ────────────────────────────────────────────────────────────
function render() {
  const root = $("#root");
  if (!root) return;
  root.dataset.mode = mode;
  root.dataset.orient = orientation;
  if (adviceOpen) root.dataset.advice = "on";
  else delete root.dataset.advice;
  renderHero();
  renderCells();
  renderSetup();
  renderAdvice();
}

function renderHero() {
  const hero = heroView(result);
  const box = $("#hero");
  const expand = $("#btn-expand"); // renderHero 会清空 box 的子节点，先把展开按钮摘出来
  expand?.remove();
  box.className = `hero ${hero.cls}`;
  box.replaceChildren();
  if (expand) box.append(expand);

  const head = h("div", { class: "hero-head" }, [
    h("span", { class: "hero-label", text: hero.label }),
    hero.index !== null ? h("span", { class: "hero-tag", text: t("hudNextTag") }) : null,
    hero.index !== null ? h("span", { class: "hero-nth", text: stationName(hero.index) }) : null,
    hero.badge ? h("span", { class: "hero-badge", text: hero.badge }) : null,
  ]);
  const body = h("div", { class: "hero-body" });
  if (hero.bars) {
    for (const bar of hero.bars) {
      body.append(
        h("div", { class: `hero-bar t-${TYPE_KEYS[bar.ti]}${bar.locked ? " locked" : ""}` }, [
          h("span", { class: "hb-name", text: typeLabel(bar.ti) }),
          h("span", { class: "hb-track" }, [h("i", { class: "hb-fill", style: `width:${percent(bar.ratio)}` })]),
          h("span", { class: "hb-pct", text: percent(bar.ratio) }),
        ]),
      );
    }
  } else {
    body.append(h("p", { class: "hero-note", text: hero.note }));
  }

  box.append(
    head,
    body,
    h("div", { class: "hero-foot" }, [h("span", { class: "hero-track" }, [h("i", { style: `width:${progressPct(state.observed, result.stationCount)}` })])]),
  );
}

function renderCells() {
  const strip = $("#strip");
  strip.replaceChildren();
  for (let i = 0; i < result.stationCount; i += 1) {
    const cell = stripCellView(result, state.observed, state.hints, i, state.cursor);
    const auto = autoFilled.includes(i);
    const tip = stripTip(result, state.observed, state.hints, i) + (auto ? ` · ${t("stripAuto")}` : "");
    strip.append(
      h("button", {
        class: `cell ${cell.classes.join(" ")}${auto ? " auto" : ""}`,
        type: "button",
        title: tip,
        "aria-label": tip,
        text: cell.text,
        onclick: () => selectStation(i),
      }),
    );
  }
  const debt = missingHints(state.observed, state.hints, state.cursor, result.stationCount);
  const note = $("#strip-note");
  note.textContent = debt > 0
    ? t("hudMissingHints", { n: debt })
    : t("stripHalf");
  note.className = debt > 0 ? "strip-note warn" : "strip-note";
  if (debt === 0) note.textContent = "";
}

function renderSetup() {
  const box = $("#setup");
  box.replaceChildren();
  const index = state.cursor;
  const origin = isOrigin(index);
  const recorded = allRecorded(state.observed, state.hints, result.stationCount);

  const target = t(orientation === "portrait" ? "orientLandscape" : "orientPortrait");
  box.append(
    h("div", { class: "setup-head" }, [
      h("span", { class: "setup-title", text: t("hudRecordShort") }),
      h("span", { class: "setup-tag", text: t("hudCurTag") }),
      h("b", { class: "setup-nth", text: stationName(index) }),
      h("span", { class: "spacer" }),
      // 横竖屏切换：只在原生支持时出现（浏览器里没有窗口可转）。文字显示的是**目标**方向。
      native?.setOrientation
        ? h("button", {
            class: "chip-btn orient",
            type: "button",
            title: t("orientSwitch", { mode: target }),
            "aria-label": t("orientSwitch", { mode: target }),
            text: target,
            onclick: toggleOrientation,
          })
        : null,
      (state.observed[index] !== null || state.hints[index] !== null)
        ? h("button", { class: "chip-btn", type: "button", title: t("hudClearFull"), "aria-label": t("hudClearFull"), text: "✕", onclick: () => clearStation(index) })
        : null,
    ]),
  );

  // 类型行：始发站没有类型，不给三选一——游戏里根本没有这个信息，凭空选一个会混进进度条
  const typeRow = h("div", { class: "row" }, [h("span", { class: "row-label", text: t("hudTypeLabel") })]);
  if (origin) {
    typeRow.append(h("span", { class: "row-na", text: t("originNoTypeTip") }));
  } else {
    const group = h("div", { class: "btns cols-3" });
    TYPE_KEYS.forEach((key, ti) => {
      const on = state.observed[index] === ti;
      group.append(h("button", {
        class: `btn${on ? " on" : ""}`,
        type: "button",
        "aria-pressed": String(on),
        text: typeLabel(ti),
        onclick: () => recordType(index, ti),
      }));
    });
    typeRow.append(group);
  }
  box.append(typeRow);

  // 提示行：每站都要记（终点站除外——它后面没有站），不能藏在折叠里
  const hintRow = h("div", { class: "row" }, [h("span", { class: "row-label", text: t("hudHintLabel") })]);
  if (hintable(index, result.stationCount)) {
    hintRow.append(h("span", { class: "row-covers", text: hintCoversShort(index, result.stationCount) }));
    const group = h("div", { class: "btns cols-4" });
    TYPE_KEYS.forEach((key, ti) => {
      const on = state.hints[index] === hintMax(ti);
      const label = t("optHintMaxShort", { type: typeShort(ti) });
      group.append(h("button", {
        class: `btn${on ? " on" : ""}`,
        type: "button",
        "aria-pressed": String(on),
        title: t("optHintMax", { type: typeLabel(ti) }),
        text: label,
        onclick: () => recordHint(index, hintMax(ti)),
      }));
    });
    const sameOn = state.hints[index] === HINT_SAME;
    group.append(h("button", {
      class: `btn${sameOn ? " on" : ""}`,
      type: "button",
      "aria-pressed": String(sameOn),
      title: t("optHintSameTip"),
      text: t("optHintSameShort"),
      onclick: () => recordHint(index, HINT_SAME),
    }));
    hintRow.append(group);
  } else {
    hintRow.append(h("span", { class: "row-na", text: t("hintDisabled") }));
  }
  box.append(hintRow);

  // 下一步操作：本站记全后出现「去第 N 站」；没记全时用一句浅色说明填住这块。
  // 手动推进的原因见 goNext——记完提示不代表玩家已经购物完/离开本站。
  if (recorded) {
    box.append(h("p", { class: "setup-done", text: t("hudDoneAllDesc") }));
  } else if (isStationComplete(state.observed, state.hints, index, result.stationCount)) {
    const to = nextIncompleteAfter(state.observed, state.hints, index, result.stationCount);
    if (to !== -1) {
      box.append(
        h("button", {
          class: "go-next",
          type: "button",
          text: `${t("hudGoNext", { n: stationNumber(to) })} →`,
          onclick: goNext,
        }),
      );
    }
  } else {
    box.append(h("p", { class: "setup-wait", text: t("hudWaitNext") }));
  }
}

function renderAdvice() {
  const { items, folded } = hudAdvice(result);
  const box = $("#advice");
  box.replaceChildren();
  for (const item of items) box.append(adviceNode(item));

  // 通用水位建议（通用节奏 / 连续同类型）在手机上默认收起：
  // 它们不改变任何一次具体决策，却要占掉半屏——而跑商时屏幕就那么大。
  const toggle = $("#advice-toggle");
  toggle.textContent = adviceOpen ? t("hudAdviceTitle") : t("hudMore", { n: folded.length });
  toggle.hidden = folded.length === 0;

  const more = $("#advice-more");
  more.replaceChildren();
  more.hidden = !adviceOpen;
  if (adviceOpen) for (const item of folded) more.append(adviceNode(item));
}

function adviceNode(item) {
  return h("div", { class: `adv tone-${item.tone}` }, [
    h("p", { class: "adv-title", text: item.title }),
    item.act ? h("p", { class: "adv-act", text: item.act }) : null,
    item.detail ? h("p", { class: "adv-detail", text: item.detail }) : null,
  ]);
}

// ── 全部记录（覆盖层）────────────────────────────────────────────────
function openRecords() {
  // 面板里不开这一层（理由见 openInActivity）：改走全屏页
  if (openInActivity(ACTION_RECORDS)) return;
  const list = $("#records-list");
  list.replaceChildren();
  for (let i = 0; i < result.stationCount; i += 1) {
    const origin = isOrigin(i);
    const row = h("div", { class: `rec-row${i === state.cursor ? " current" : ""}` }, [
      h("button", {
        class: "rec-n",
        type: "button",
        text: String(stationNumber(i)),
        onclick: () => {
          selectStation(i);
          closeDialog();
        },
      }),
    ]);
    if (origin) {
      row.append(h("span", { class: "rec-na", text: "—" }));
    } else {
      const select = h("select", { class: "rec-select", "aria-label": t("ariaType", { name: stationName(i) }) });
      select.append(h("option", { value: "", text: t("optUnknown") }));
      TYPE_KEYS.forEach((key, ti) => select.append(h("option", { value: String(ti), text: typeShort(ti) })));
      select.value = state.observed[i] === null ? "" : String(state.observed[i]);
      select.addEventListener("change", (e) => {
        const observed = state.observed.slice();
        observed[i] = e.target.value === "" ? null : Number(e.target.value);
        setState({ ...state, observed });
      });
      row.append(select);
    }
    const hintSelect = h("select", {
      class: "rec-select",
      disabled: !canHintAt(i, result.stationCount),
      title: hintable(i, result.stationCount) ? hintCoversShort(i, result.stationCount) : t("hintDisabled"),
    });
    hintSelect.append(h("option", { value: "", text: t("optHintNone") }));
    hintSelect.append(h("option", { value: HINT_SAME, text: t("optHintSameShort") }));
    TYPE_KEYS.forEach((key, ti) => hintSelect.append(h("option", { value: hintMax(ti), text: t("optHintMaxShort", { type: typeShort(ti) }) })));
    hintSelect.value = state.hints[i] ?? "";
    hintSelect.addEventListener("change", (e) => {
      const hints = state.hints.slice();
      hints[i] = e.target.value === "" ? null : e.target.value;
      setState({ ...state, hints });
    });
    row.append(hintSelect);
    row.append(h("span", { class: "rec-res", text: recordResultText(i) }));
    list.append(row);
  }
  openDialog("#records");
}

function recordResultText(i) {
  if (isOrigin(i)) return t("inferNa");
  if (state.observed[i] !== null) return typeShort(state.observed[i]);
  if (!result.consistent) return t("inferConflict");
  if (result.possibleTypes[i].length === 1) return `${typeShort(result.possibleTypes[i][0])} 100%`;
  return result.possibleTypes[i].map((ti) => `${typeShort(ti)} ${percent(result.ratio[i][ti])}`).join(" / ");
}

// ── 弹层 ────────────────────────────────────────────────────────────
//
// ⚠️ 悬浮窗里**不开任何页内弹层**，一律转交全屏页。这是真机踩出来的：
//   1) 面板是 FLAG_NOT_FOCUSABLE 的 overlay 窗口；弹层的按钮贴屏幕底部，
//      会压在手势导航条上——手势条优先吃触摸，按钮点了「没有任何反应」
//      （用户实测：清空确认里的「取消 / 清空并回始发站」两个按钮全点不动）；
//   2) 依赖子窗口的控件（`<select>`、文件选择器）在 overlay 窗口里也不可靠。
// 全屏页是 Activity 窗口，没有这两个限制。手机浏览器里（没有原生桥）弹层照常可用。
function openInActivity(action) {
  if (!isPanelMode() || !hasNative() || typeof native.openSupport !== "function") return false;
  try {
    native.openSupport(action);
    return true;
  } catch {
    return false; // 原生那侧出问题时退回页内弹层，至少还有个反馈
  }
}

function openDialog(sel) {
  const el = $(sel);
  el.hidden = false;
}
function closeDialog() {
  for (const el of document.querySelectorAll(".dialog")) el.hidden = true;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

// ── 导出 / 导入 / 复制 ───────────────────────────────────────────────
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // WebView / 非安全上下文下 clipboard API 可能不可用，退回 execCommand
    try {
      const area = h("textarea", { value: text });
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function doCopy() {
  const ok = await copyText(summaryText(result, state.observed, state.hints));
  toast(ok ? t("copied") : t("copyFailed", { err: "clipboard" }));
}

function doExport() {
  const json = toJSON(state);
  const name = exportFileName();
  if (hasNative() && typeof native.saveFile === "function") {
    // Android：交给原生走支持页（悬浮窗里没有可复制的界面）
    try {
      native.saveFile(name, json);
    } catch {
      showExportText(json, name);
    }
    return;
  }
  try {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // 下载被拦（部分 WebView）：退回「显示全文让用户自己复制」
  }
  showExportText(json, name);
}

function showExportText(json, name) {
  $("#export-text").value = json;
  $("#export-name").textContent = name;
  openDialog("#export");
}

/** 导入：优先让原生选文件（Android 的 WebView 里 <input file> 需要 onShowFileChooser 支持）。 */
function doImportPick() {
  if (hasNative() && typeof native.pickFile === "function") {
    try {
      native.pickFile();
      return;
    } catch {
      // 掉到下面的 input 方案
    }
  }
  $("#file-input").click();
}

function applyImportText(text) {
  const decoded = decodeState(text);
  if (!decoded.ok) {
    const messages = {
      [IMPORT_ERRORS.parse]: t("importBadJson"),
      [IMPORT_ERRORS.shape]: t("importBadShape"),
      [IMPORT_ERRORS.kind]: t("importBadKind"),
      [IMPORT_ERRORS.stations]: t("importBadShape"),
    };
    toast(messages[decoded.reason] ?? t("importBadShape"));
    return false;
  }
  setState(decoded.state);
  closeDialog();
  toast(t("importOk", describeState(decoded.state)));
  return true;
}

function doReset() {
  // 面板里的弹层按钮会压在手势导航条上、点了没反应（用户实测反馈），
  // 所以清空的确认交给全屏页的原生对话框来做
  if (openInActivity(ACTION_RESET)) return;
  openDialog("#reset");
}

// ── 初始化 ──────────────────────────────────────────────────────────
//
// Android 侧会在页面脚本之前注入 window.__railBootstrap（见 RailWebView.loadHud）：
//   { state: "<权威状态的 JSON>", mode: "panel|full|bar", lang: "zh" }
// 状态由原生注入而不是让页面自己去读，是因为页面在 file:// 下读不到 SharedPreferences，
// 而 localStorage 在「刚装完」和「另一个窗口刚改过」时都不等于真源。
function bootstrap() {
  try {
    return window.__railBootstrap ?? null;
  } catch {
    return null;
  }
}

function bind() {
  $("#btn-all").addEventListener("click", openRecords);
  $("#btn-copy").addEventListener("click", doCopy);
  $("#btn-export").addEventListener("click", doExport);
  $("#btn-import").addEventListener("click", doImportPick);
  $("#btn-reset").addEventListener("click", doReset);
  $("#advice-toggle").addEventListener("click", () => {
    adviceOpen = !adviceOpen;
    render();
  });
  $("#export-copy").addEventListener("click", async () => {
    const ok = await copyText($("#export-text").value);
    toast(ok ? t("copied") : t("copyFailed", { err: "clipboard" }));
  });
  $("#import-apply").addEventListener("click", () => applyImportText($("#import-text").value));
  $("#reset-ok").addEventListener("click", resetAll);

  for (const el of document.querySelectorAll("[data-close]")) {
    el.addEventListener("click", closeDialog);
  }
  for (const el of document.querySelectorAll(".dialog")) {
    el.addEventListener("click", (e) => {
      if (e.target === el) closeDialog();
    });
  }
  $("#file-input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    applyImportText(await file.text());
    e.target.value = "";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDialog();
  });
}

// 静态外壳的文案（HTML 里写的是中文兜底，这里按当前语言覆盖一遍）
function renderStatic() {
  document.title = t("mobileTitle");
  document.querySelector(".brand").textContent = t("mobileTitle");
  $("#btn-all").textContent = t("allRecords");
  $("#btn-copy").textContent = t("copy");
  $("#btn-export").textContent = t("export");
  $("#btn-import").textContent = t("import");
  $("#btn-reset").textContent = t("reset");
  $("#records-title").textContent = t("allRecords");
  $("#records-sub").textContent = t("allRecordsSub");
  $("#records-close").textContent = t("close");
  $("#export-title").textContent = t("exportTitle");
  $("#export-desc").textContent = t("exportDesc");
  $("#export-copy").textContent = t("exportCopy");
  $("#export-close").textContent = t("close");
  $("#import-title").textContent = t("importTitle");
  $("#import-desc").textContent = t("importDesc");
  document.querySelector("[data-import-pick]").textContent = t("importPick");
  $("#import-apply").textContent = t("importApply");
  $("#import-text").placeholder = t("importPlaceholder");
  $("#import-close").textContent = t("close");
  $("#reset-title").textContent = t("resetConfirmTitle");
  $("#reset-desc").textContent = t("resetConfirmBody");
  $("#reset-cancel").textContent = t("resetCancel");
  $("#reset-ok").textContent = t("resetConfirmOk");
  $("#mode-hint").textContent = t("mobileModeHint");
  $("#btn-collapse").textContent = t("mobileCollapse");
  const headers = document.querySelectorAll(".rec-cols span");
  ["allRecordsColStation", "allRecordsColType", "allRecordsColHint", "allRecordsColRes"]
    .forEach((key, i) => { if (headers[i]) headers[i].textContent = t(key); });
}

/**
 * 「收起 / 展开」按钮：悬浮窗里唯一能自己让出屏幕面积的动作。
 *
 * 面板压在游戏画面上，遮挡面积直接决定玩家还能不能点到游戏，所以这个按钮不是装饰。
 * 收起态（bar）时顶栏整条被藏了，出口改挂在结论卡上——收起来之后仍然要能展开回来，
 * 否则用户只能去通知栏关掉面板再重开。
 *
 * 浏览器里没有窗口可以收，所以按钮不出现（native 为空）。
 */
function bindCollapse() {
  const collapse = $("#btn-collapse");
  const expand = $("#btn-expand");
  if (!native?.setCollapsed) return;
  if (mode === "panel") {
    collapse.hidden = false;
    collapse.addEventListener("click", () => requestMode("bar"));
  }
  expand.hidden = false;
  expand.addEventListener("click", () => requestMode("panel"));
}

function requestMode(next) {
  try {
    native.setCollapsed(next === "bar");
  } catch {
    // 原生侧不支持收起：按钮留着也没意义
    $("#btn-collapse").hidden = true;
    $("#btn-expand").hidden = true;
  }
}

/**
 * 横竖屏切换。
 *
 * 页面只负责「请求 + 把自己的版面切成对应方向」；真正改窗口/Activity 朝向的是原生
 * （悬浮窗 = 换窗口宽高，全屏页 = requestedOrientation）。原生持久化选择，下次开窗口
 * 由 bootstrap 注入回来，所以这里不需要自己存。
 * 原生调用失败时不改本地状态——否则页面切了、窗口没切，两边说的不是一个方向。
 */
function toggleOrientation() {
  const next = orientation === "portrait" ? "landscape" : "portrait";
  try {
    native.setOrientation(next);
  } catch {
    return;
  }
  orientation = next;
  render();
}

/**
 * 原生侧的回调面（Kotlin 通过 evaluateJavascript 调这里，见 RailPanelService.onReceive）。
 *
 * 四个口子对应原生真正需要的四件事：切模式（展开/收起）、跟随系统语言、
 * 接收另一个窗口改过的状态、以及把当前状态回吐给原生（排查用）。
 * 名字一旦改了要同步改 Kotlin 侧的字符串，所以集中在这里、不在别处再定义一遍。
 */
window.railHud = {
  setMode(next) {
    mode = ["full", "panel", "bar"].includes(next) ? next : "full";
    render();
  },
  /** 原生侧告诉页面「窗口 / Activity 现在是哪个朝向」（除了 bootstrap，运行中也可能变）。 */
  setOrientation(next) {
    orientation = next === "landscape" ? "landscape" : "portrait";
    render();
  },
  setLocale(next) {
    setLocale(next);
    renderStatic();
    render();
  },
  /**
   * 应用另一个窗口推过来的状态。
   *
   * notifyNative 传 false 是**必须**的：这份状态就是原生广播过来的，
   * 再回传一次会让两个窗口互相广播、无限来回。回声抑制靠这一处，
   * 所以不要把它改成默认值。
   */
  applyStateJSON(json) {
    try {
      setState(normalizeState(JSON.parse(json)), { notifyNative: false });
    } catch {
      // 非法 JSON 忽略：原生存的是字符串，格式坏了不该让面板停摆
    }
  },
  getStateJSON() {
    return JSON.stringify(state);
  },
  /**
   * 由原生把「用户选中的文件内容」灌进来。
   *
   * 文件选择器必须走原生：WebView 的 `<input type=file>` 需要 onShowFileChooser 支持，
   * 而悬浮窗本身是 FLAG_NOT_FOCUSABLE 的、系统选择器在 overlay 窗口上不可靠。
   * 所以「选文件」交给 Activity，「解析与应用」仍然走页面里这一条路径——
   * 校验规则只有一份，不会出现「原生导入和页面导入行为不一致」。
   */
  applyImportText(text) {
    return applyImportText(text);
  },
  /**
   * 原生确认「清空并回始发站」后调用。
   *
   * 清空这个动作在面板里走的是原生对话框（弹层在浮窗里点不动，见 openInActivity），
   * 所以真正的执行入口要留给原生回调——两条入口（页内弹层 / 原生对话框）
   * 最终都落到 resetAll()，不会出现「原生清了、页面还留着旧记录」的分叉。
   */
  confirmReset() {
    resetAll();
  },
};

/**
 * 导出 / 导入页（Android 的 SupportActivity）要用的两个入口。
 *
 * 它们必须是**全局函数**而不是 window.railHud 上的方法：原生是在页面加载完成后
 * 用 evaluateJavascript 调它们来「打开哪张卡」，而 railHud 是给页面回调原生的接口，
 * 两个方向分开摆，不至于看成一套。
 */
window.railHudExport = () => doExport();
window.railHudImport = () => openDialog("#import");
// 「全部记录」在面板里被转交到全屏页，由原生调它来就地打开那一层
window.railHudRecords = () => openRecords();
// 「选择文件…」按 data 属性接线：index.html 里那颗按钮不写 id，
// 免得和上面 bind() 里逐个 getElementById 的风格混起来（两种都做就是两处都要维护）。
document.querySelector("[data-import-pick]")?.addEventListener("click", doImportPick);

const boot = bootstrap();
initLocale(boot?.lang ? `?lang=${boot.lang}` : window.location.search);
mode = document.querySelector("#root")?.dataset.mode ?? "full";
if (boot?.mode) mode = boot.mode;
// 朝向：原生持久化并注入；浏览器里按屏幕实际方向初始化（那边没有切换按钮）
orientation =
  boot?.orientation === "landscape" || boot?.orientation === "portrait"
    ? boot.orientation
    : window.matchMedia?.("(orientation: landscape)").matches
      ? "landscape"
      : "portrait";
// 告诉 i18n 层「现在跑在悬浮窗里」：弹层边界判定要用（见 openInActivity）
setPanelMode(mode === "panel");

// 原生给了权威状态就用它；否则读本地存档（浏览器直接打开时就是这条路径）
if (boot?.state) {
  try {
    state = normalizeState(JSON.parse(boot.state));
  } catch {
    load();
  }
} else {
  load();
}

bind();
renderStatic();
render();
bindCollapse();
// 不回头通知原生：这份状态本来就是它给的，回传只会制造一次无意义的广播
persist({ notifyNative: false });
if (native?.ready) {
  try {
    native.ready(JSON.stringify(state));
  } catch {
    // 原生侧没实现这个钩子不算错误
  }
}
