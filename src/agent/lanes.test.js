import { describe, expect, it } from "vitest";
import { buildLanes } from "./lanes.js";

const tool = (id, ts, attempt = 1) => ({ type: "tool_start", id, tool: "t", attempt, ts });
const done = (id, ts, attempt = 1) => ({ type: "tool_result", id, tool: "t", result: 1, attempt, ts });
const lane = (data, key) => data.lanes.find((item) => item.key === key).segments;

describe("buildLanes 执行泳道", () => {
  it("工具与确认各成段，模型时间取补集", () => {
    const data = buildLanes([
      tool("a", 1000),
      done("a", 1400),
      { type: "approval_asked", id: "c1", tool: "file.write_text", ts: 1600 },
      { type: "approval_decided", id: "c1", tool: "file.write_text", approved: true, ts: 2600 },
      tool("b", 2800),
      done("b", 3000),
      { type: "final", answer: "ok", ts: 3200 },
    ]);
    expect(data.totalMs).toBe(2200);
    expect(lane(data, "tool")).toEqual([
      { start: 1000, end: 1400 },
      { start: 2800, end: 3000 },
    ]);
    expect(lane(data, "wait")).toEqual([{ start: 1600, end: 2600 }]);
    expect(lane(data, "model")).toEqual([
      { start: 1400, end: 1600 },
      { start: 2600, end: 2800 },
      { start: 3000, end: 3200 },
    ]);
  });

  it("重试把同一次调用的两次尝试分成两段", () => {
    const data = buildLanes([
      tool("a", 1),
      { type: "tool_retry", id: "a", tool: "t", error: "x", ts: 30 },
      tool("a", 40, 2),
      done("a", 70, 2),
    ]);
    expect(lane(data, "tool")).toEqual([
      { start: 1, end: 30 },
      { start: 40, end: 70 },
    ]);
  });

  it("运行中的尝试延到 now，并且 now 晚于最后事件时总时长跟着长", () => {
    const data = buildLanes([tool("a", 100), { type: "notice", code: "x", ts: 120 }], { now: 500 });
    expect(data.totalMs).toBe(400);
    expect(lane(data, "tool")).toEqual([{ start: 100, end: 500 }]);
  });

  it("未收尾的确认也算等待时间", () => {
    const data = buildLanes([{ type: "approval_asked", id: "c1", tool: "file.write_text", ts: 100 }], { now: 400 });
    expect(lane(data, "wait")).toEqual([{ start: 100, end: 400 }]);
  });

  it("空事件流与非法时间戳不画泳道", () => {
    expect(buildLanes([])).toBeNull();
    expect(buildLanes([{ type: "final", answer: "x", ts: 0 }])).toBeNull();
    expect(buildLanes([{ type: "final", answer: "x" }])).toBeNull();
  });

  it("没有工具与确认时整条都是模型道", () => {
    const data = buildLanes([
      { type: "notice", code: "a", ts: 10 },
      { type: "final", answer: "x", ts: 60 },
    ]);
    expect(lane(data, "model")).toEqual([{ start: 10, end: 60 }]);
    expect(lane(data, "tool")).toEqual([]);
    expect(lane(data, "wait")).toEqual([]);
  });
});
