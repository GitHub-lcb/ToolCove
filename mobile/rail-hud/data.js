// 手机版 HUD 的数据编解码：状态归一 + 导出/导入 JSON。
//
// 存在的理由是「双端进度互通」：桌面版把进度落成 <应用数据目录>/rail-tycoon.json，
// 手机版落在自己的 localStorage，两边本来完全隔离。用户在两台设备上跑同一条挑战线路时，
// 需要能把这 16 站的记录搬过去——这是唯一一条通路。
//
// 格式刻意做得宽进严出：
//   - 导出：带 kind / v / exportedAt 的自描述信封，将来的版本可以据此迁移；
//   - 导入：**同时接受**信封和裸的 { observed, hints, cursor }，因为用户手里可能是一份
//     从桌面版 JSON 文件里抄出来的片段。只要能认出「这是铁路大亨的状态」就收下。
// 但**不猜**：kind 不认识就拒绝，不把别的工具的数据塞进这 16 个格子。

import {
  canHintAt,
  normalizeHint,
  normalizeType,
  ORIGIN_INDEX,
  STATION_COUNT,
} from "../../src/tools/railTycoon.js";

export const EXPORT_KIND = "toolcove.rail-tycoon";
export const EXPORT_VERSION = 1;
export const STATE_KEY = "toolbox-rail-tycoon";

/** 导入失败的原因码。文案由界面层翻译——数据层不碰 i18n。 */
export const IMPORT_ERRORS = {
  parse: "parse",
  shape: "shape",
  kind: "kind",
  stations: "stations",
};

/** 一排 16 个 null。 */
const emptyRow = (n = STATION_COUNT) => new Array(n).fill(null);

/** 归一出一份合法的状态；任何字段缺失或非法都退化成「没记」。 */
export function normalizeState(raw, stationCount = STATION_COUNT) {
  const observed = emptyRow();
  const hints = emptyRow();
  for (let i = 0; i < stationCount; i += 1) {
    observed[i] = normalizeType(raw?.observed?.[i]);
    hints[i] = canHintAt(i, stationCount) ? normalizeHint(raw?.hints?.[i]) : null;
  }
  // 始发站没有类型——存档里若有残留值直接丢掉，别让它混进进度条
  observed[ORIGIN_INDEX] = null;

  const savedCursor = Number(raw?.cursor);
  const cursorOk = Number.isInteger(savedCursor) && savedCursor >= 0 && savedCursor < stationCount;
  const hasInput = observed.some((v) => v !== null) || hints.some((v) => v !== null);
  return { observed, hints, cursor: hasInput && cursorOk ? savedCursor : 0 };
}

/** 把状态包成导出信封。 */
export function encodeState(state, { exportedAt = new Date().toISOString(), app = "ToolCove" } = {}) {
  return {
    kind: EXPORT_KIND,
    v: EXPORT_VERSION,
    app,
    exportedAt,
    stationCount: STATION_COUNT,
    observed: state.observed,
    hints: state.hints,
    cursor: state.cursor,
  };
}

export function toJSON(state, options) {
  return JSON.stringify(encodeState(state, options), null, 2);
}

/** 导出文件名带日期：两台设备各导一次时，靠文件名就能分清哪份新。 */
export function exportFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `rail-tycoon-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

/**
 * 解析一份导入文本。
 *
 * @returns {{ok: true, state: object, meta: object} | {ok: false, reason: string}}
 */
export function decodeState(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return { ok: false, reason: IMPORT_ERRORS.parse };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: IMPORT_ERRORS.shape };
  }
  // 信封形态：kind 必须对上（存在但不是我们的 → 明确拒绝，而不是硬塞）
  if (parsed.kind !== undefined && parsed.kind !== EXPORT_KIND) {
    return { ok: false, reason: IMPORT_ERRORS.kind };
  }
  if (!Array.isArray(parsed.observed) && !Array.isArray(parsed.hints)) {
    return { ok: false, reason: IMPORT_ERRORS.shape };
  }
  if (Array.isArray(parsed.observed) && parsed.observed.length > STATION_COUNT) {
    return { ok: false, reason: IMPORT_ERRORS.stations };
  }
  return {
    ok: true,
    state: normalizeState(parsed),
    meta: { app: parsed.app ?? "", exportedAt: parsed.exportedAt ?? "", v: parsed.v ?? null },
  };
}

/** 导入前给用户看的摘要：这份存档记了多少站、导出时间。 */
export function describeState(state) {
  const typed = state.observed.filter((v, i) => i > ORIGIN_INDEX && v !== null).length;
  const hinted = state.hints.filter((v) => v !== null).length;
  return { typed, hinted };
}
