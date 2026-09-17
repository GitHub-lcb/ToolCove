// 手机版数据编解码单测：状态归一 + 导出/导入往返。
//
// 这一层的价值全在「用户手里的那份 JSON 到底能不能用」上：
// 导入是**唯一**一条把 PC 上的进度搬到手机上的通路，解析放宽一点（接受裸对象）、
// 拒绝严格一点（别的工具的 kind 一律不收），都不能靠手测覆盖。

import { describe, it, expect } from "vitest";
import {
  decodeState,
  describeState,
  encodeState,
  EXPORT_KIND,
  EXPORT_VERSION,
  exportFileName,
  IMPORT_ERRORS,
  normalizeState,
  toJSON,
} from "./data.js";
import { HINT_SAME, hintMax, STATION_COUNT } from "../../src/tools/railTycoon.js";

const sample = () => {
  const observed = new Array(STATION_COUNT).fill(null);
  const hints = new Array(STATION_COUNT).fill(null);
  observed[1] = 0;
  observed[2] = 2;
  hints[0] = HINT_SAME;
  hints[1] = hintMax(1);
  return { observed, hints, cursor: 3 };
};

describe("状态归一", () => {
  it("空输入退化成一排 null，不抛错", () => {
    for (const raw of [null, undefined, {}, { observed: "x" }, []]) {
      const state = normalizeState(raw);
      expect(state.observed).toHaveLength(STATION_COUNT);
      expect(state.hints).toHaveLength(STATION_COUNT);
      expect(state.observed.every((v) => v === null)).toBe(true);
      expect(state.cursor).toBe(0);
    }
  });

  it("非法类型值一律当没记（不静默产生错误约束）", () => {
    const state = normalizeState({ observed: [0, 9, -1, "x", 2], hints: [] });
    expect(state.observed[0]).toBeNull(); // 始发站没有类型，残留值丢掉
    expect(state.observed[1]).toBeNull();
    expect(state.observed[2]).toBeNull();
    expect(state.observed[3]).toBeNull();
    expect(state.observed[4]).toBe(2);
  });

  it("末尾 3 站的提示即使存档里有值也丢掉（那里本来没有提示）", () => {
    const hints = new Array(STATION_COUNT).fill(HINT_SAME);
    const state = normalizeState({ hints });
    for (let i = 0; i <= STATION_COUNT - 4; i += 1) expect(state.hints[i]).toBe(HINT_SAME);
    for (let i = STATION_COUNT - 3; i < STATION_COUNT; i += 1) expect(state.hints[i]).toBeNull();
  });

  it("越界或非整数的光标回落到 0", () => {
    for (const cursor of [-1, 99, "abc", 1.5, null]) {
      expect(normalizeState({ ...sample(), cursor }).cursor).toBe(0);
    }
    expect(normalizeState({ ...sample(), cursor: 7 }).cursor).toBe(7);
  });

  it("全空记录时光标一律回 0（不沿用存档里的半路光标）", () => {
    expect(normalizeState({ cursor: 11 }).cursor).toBe(0);
  });

  it("保留光标的前提是确实有记录", () => {
    expect(normalizeState({ ...sample(), cursor: 5 }).cursor).toBe(5);
  });
});

describe("导出信封", () => {
  it("带 kind / 版本 / 时间戳，够自描述", () => {
    const env = encodeState(sample(), { exportedAt: "2026-01-02T03:04:05.000Z", app: "ToolCove 0.6.0" });
    expect(env.kind).toBe(EXPORT_KIND);
    expect(env.v).toBe(EXPORT_VERSION);
    expect(env.exportedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(env.app).toBe("ToolCove 0.6.0");
    expect(env.stationCount).toBe(STATION_COUNT);
  });

  it("JSON 是缩进过的，方便用户自己看一眼再复制", () => {
    expect(toJSON(sample())).toContain("\n  ");
  });

  it("文件名带日期时间，两台设备各导一次能分清哪份新", () => {
    const name = exportFileName(new Date(2026, 0, 2, 3, 4));
    expect(name).toBe("rail-tycoon-20260102-0304.json");
  });
});

describe("导入解析", () => {
  it("导出再导入是恒等的（往返不丢一站）", () => {
    const state = normalizeState(sample());
    const decoded = decodeState(toJSON(state));
    expect(decoded.ok).toBe(true);
    expect(decoded.state).toEqual(state);
  });

  it("也接受裸的 { observed, hints, cursor }（用户可能只抄了片段）", () => {
    const decoded = decodeState(JSON.stringify(sample()));
    expect(decoded.ok).toBe(true);
    expect(decoded.state.observed[1]).toBe(0);
  });

  it("非 JSON 文本 → parse", () => {
    expect(decodeState("这不是 JSON").reason).toBe(IMPORT_ERRORS.parse);
    expect(decodeState("").reason).toBe(IMPORT_ERRORS.parse);
  });

  it("JSON 但不是对象（数组/数字/字符串）→ shape", () => {
    expect(decodeState("[1,2,3]").reason).toBe(IMPORT_ERRORS.shape);
    expect(decodeState("42").reason).toBe(IMPORT_ERRORS.shape);
    expect(decodeState('"hi"').reason).toBe(IMPORT_ERRORS.shape);
  });

  it("没有 observed / hints 的对象 → shape", () => {
    expect(decodeState('{"foo":1}').reason).toBe(IMPORT_ERRORS.shape);
  });

  it("别的工具导出的文件 → kind（明确拒绝，不硬塞）", () => {
    const decoded = decodeState(JSON.stringify({ kind: "toolcove.snippets", observed: [], hints: [] }));
    expect(decoded.ok).toBe(false);
    expect(decoded.reason).toBe(IMPORT_ERRORS.kind);
  });

  it("站点数组比 16 长 → stations", () => {
    const observed = new Array(20).fill(0);
    expect(decodeState(JSON.stringify({ observed })).reason).toBe(IMPORT_ERRORS.stations);
  });

  it("站点数组比 16 短是允许的（旧存档 / 手抄片段），缺的算没记", () => {
    const decoded = decodeState(JSON.stringify({ observed: [null, 0, 1], hints: [] }));
    expect(decoded.ok).toBe(true);
    expect(decoded.state.observed[1]).toBe(0);
    expect(decoded.state.observed[2]).toBe(1);
    expect(decoded.state.observed[3]).toBeNull();
  });

  it("导入时会跑一遍归一：非法值与越界提示都清掉", () => {
    const decoded = decodeState(JSON.stringify({ observed: [0, 7], hints: [HINT_SAME, HINT_SAME], cursor: 99 }));
    expect(decoded.state.observed[0]).toBeNull();
    expect(decoded.state.observed[1]).toBeNull();
    expect(decoded.state.hints[0]).toBe(HINT_SAME);
    expect(decoded.state.cursor).toBe(0); // 99 越界 → 回始发站
  });

  it("meta 透出导出方与时间，供界面提示「这份是什么时候导的」", () => {
    const decoded = decodeState(toJSON(sample(), { exportedAt: "2026-01-02T03:04:05.000Z", app: "ToolCove 0.6.0" }));
    expect(decoded.meta.exportedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(decoded.meta.app).toBe("ToolCove 0.6.0");
  });
});

describe("导入摘要", () => {
  it("数出「记了几站类型、几条提示」，供 toast 用", () => {
    expect(describeState(normalizeState(sample()))).toEqual({ typed: 2, hinted: 2 });
    expect(describeState(normalizeState(null))).toEqual({ typed: 0, hinted: 0 });
  });
});
