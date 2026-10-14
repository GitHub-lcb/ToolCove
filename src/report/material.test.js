// 周报素材构建的单测：周范围边界 + 素材文本拼接与 hasLogs 判定。
// t 用假实现注入（返回 key + 参数 JSON），这样断言只看结构、不受 weekday 等真实译文影响。
import { describe, it, expect } from "vitest";
import { weekRange, buildReportMaterial } from "./material.js";

const t = (key, params) => (params && Object.keys(params).length ? `${key} ${JSON.stringify(params)}` : key);
const keyOnly = (key) => key;

describe("weekRange", () => {
  // 2026-10-14 是周三；该周周一为 2026-10-12
  const now = new Date(2026, 9, 14, 10, 0, 0);

  it("本周：周一至今天", () => {
    expect(weekRange("this", keyOnly, now)).toEqual({
      from: "2026-10-12",
      to: "2026-10-14",
      label: "task.rangeThis",
      labelKey: "task.rangeThis",
    });
  });

  it("上周：上周一至上周日", () => {
    expect(weekRange("last", keyOnly, now)).toEqual({
      from: "2026-10-05",
      to: "2026-10-11",
      label: "task.rangeLast",
      labelKey: "task.rangeLast",
    });
  });

  it("周一当日：本周范围 from == to（边界）", () => {
    const mon = new Date(2026, 9, 12, 8, 0, 0);
    const r = weekRange("this", keyOnly, mon);
    expect(r.from).toBe("2026-10-12");
    expect(r.to).toBe("2026-10-12");
  });

  it("周日：本周覆盖到周日", () => {
    const sun = new Date(2026, 9, 18, 22, 0, 0);
    const r = weekRange("this", keyOnly, sun);
    expect(r.from).toBe("2026-10-12");
    expect(r.to).toBe("2026-10-18");
  });
});

describe("buildReportMaterial", () => {
  const range = { from: "2026-10-12", to: "2026-10-14", label: "本周" };

  it("无工时：hasLogs 为假，文本含「无记录」提示", () => {
    const mat = buildReportMaterial({ dayLogs: [], iterations: [] }, range, t);
    expect(mat.hasLogs).toBe(false);
    expect(mat.text).toContain("task.materialRange");
    expect(mat.text).toContain("task.materialNoLogs");
  });

  it("范围外的工时不计入", () => {
    const dayLogs = [{ date: "2026-10-01", hours: 3, source: "iteration", title: "旧", note: "" }];
    const mat = buildReportMaterial({ dayLogs, iterations: [] }, range, t);
    expect(mat.hasLogs).toBe(false);
  });

  it("有工时：hasLogs 为真，文本按日聚合且带条目与总工时", () => {
    const dayLogs = [
      { date: "2026-10-13", hours: 2, source: "iteration", title: "迭代A · 子任务a", note: "需求1" },
      { date: "2026-10-13", hours: 3.5, source: "iteration", title: "迭代A · 子任务b", note: "" },
    ];
    const mat = buildReportMaterial({ dayLogs, iterations: [] }, range, t);
    expect(mat.hasLogs).toBe(true);
    expect(mat.text).toContain("迭代A · 子任务a");
    expect(mat.text).toContain("迭代A · 子任务b");
    expect(mat.text).toContain("task.materialDayHead");
    expect(mat.text).toContain("\"total\":5.5");
  });

  it("包含范围内容发布与未完成需求", () => {
    const iterations = [
      {
        title: "迭代A",
        status: "doing",
        version: "v1.0",
        releaseDate: "2026-10-13",
        items: [{ name: "需求1", done: false }],
      },
    ];
    const mat = buildReportMaterial({ dayLogs: [], iterations }, range, t);
    expect(mat.text).toContain("task.materialReleasesHead");
    expect(mat.text).toContain("task.materialReleaseLine");
    expect(mat.text).toContain("task.materialUndoneHead");
    // 未完成需求是纯文本行（不走 t）：迭代 / 需求
    expect(mat.text).toContain("- 迭代A / 需求1");
  });

  it("已上线迭代的未完成需求不计入计划", () => {
    const iterations = [{ title: "迭代A", status: "live", items: [{ name: "需求1", done: false }] }];
    const mat = buildReportMaterial({ dayLogs: [], iterations }, range, t);
    expect(mat.text).not.toContain("task.materialUndoneHead");
  });
});
