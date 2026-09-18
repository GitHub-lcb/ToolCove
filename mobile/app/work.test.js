import { describe, expect, it } from "vitest";
import { ITERATION_STATUSES, filterRequirements, hoursText, iterationSummary, requirementLine, sortIterations } from "./work.js";

const req = (over = {}) => ({ id: "r1", name: "需求", done: false, subtasks: [], ...over });
const iter = (over = {}) => ({ id: "i1", title: "迭代", status: "dev", releaseDate: "", items: [], ...over });

describe("iterationSummary", () => {
  it("统计需求完成度与百分比", () => {
    const summary = iterationSummary(iter({ items: [req({ done: true }), req({ id: "r2" }), req({ id: "r3", done: true })] }));
    expect(summary).toMatchObject({ total: 3, done: 2, pct: 67 });
  });

  it("空迭代不产生 NaN", () => {
    expect(iterationSummary(iter())).toMatchObject({ total: 0, done: 0, pct: 0, utilization: null });
  });

  it("工时按子任务汇总；利用率只在有估算时给出", () => {
    const withEstimate = iter({
      items: [
        req({ id: "a", estimateDays: 2, subtasks: [{ id: "s1", hours: 4, done: true }, { id: "s2", hours: 12, done: false }] }),
      ],
    });
    const summary = iterationSummary(withEstimate);
    // 估算 2 天 × 8h = 16h，实际 16h → 利用率 100%
    expect(summary.estimateHours).toBe(16);
    expect(summary.actualHours).toBe(16);
    expect(summary.completedHours).toBe(4);
    expect(summary.utilization).toBe(100);
    expect(summary.estimated).toBe(1);

    // 一条都没估算时不能给出 0%（那会被读成「没超」）
    const noEstimate = iterationSummary(iter({ items: [req({ subtasks: [{ id: "s", hours: 8 }] })] }));
    expect(noEstimate.utilization).toBe(null);
    expect(noEstimate.actualHours).toBe(8);
  });

  it("统计超估算的需求条数", () => {
    const summary = iterationSummary(
      iter({
        items: [
          req({ id: "a", estimateDays: 1, subtasks: [{ id: "s1", hours: 20 }] }), // 1 天 = 8h，实际 20h → 超
          req({ id: "b", estimateDays: 3, subtasks: [{ id: "s2", hours: 4 }] }),
        ],
      })
    );
    expect(summary.overrun).toBe(1);
  });

  it("容忍坏数据（items 不是数组、条目为 null）", () => {
    expect(iterationSummary(iter({ items: "nope" })).total).toBe(0);
    expect(iterationSummary(iter({ items: [null, req()] })).total).toBe(1);
    expect(iterationSummary(null).total).toBe(0);
  });
});

describe("sortIterations", () => {
  it("进行中的排前面，已上线沉底", () => {
    const list = [iter({ id: "live", status: "live" }), iter({ id: "dev", status: "dev" }), iter({ id: "plan", status: "plan" })];
    expect(sortIterations(list).map((x) => x.id)).toEqual(["dev", "plan", "live"]);
  });

  it("同状态按上线日期近的在前，日期缺失排最后", () => {
    const list = [
      iter({ id: "none", releaseDate: "" }),
      iter({ id: "late", releaseDate: "2026-12-01" }),
      iter({ id: "soon", releaseDate: "2026-10-01" }),
    ];
    expect(sortIterations(list).map((x) => x.id)).toEqual(["soon", "late", "none"]);
  });

  it("未知状态落在中间且不消失；顺序稳定（标题兜底）", () => {
    const list = [iter({ id: "weird", status: "bogus" }), iter({ id: "a", title: "A", status: "dev" }), iter({ id: "b", title: "B", status: "dev" })];
    const sorted = sortIterations(list);
    expect(sorted.map((x) => x.id)).toEqual(["a", "b", "weird"]);
    expect(sortIterations(sorted).map((x) => x.id)).toEqual(["a", "b", "weird"]);
  });

  it("过滤空条目且不改原数组", () => {
    const original = [null, iter({ id: "x" }), undefined];
    expect(sortIterations(original).map((x) => x.id)).toEqual(["x"]);
    expect(original).toHaveLength(3);
  });

  it("状态全集与桌面端取值一致", () => {
    expect(ITERATION_STATUSES).toEqual(["plan", "dev", "test", "pending", "live"]);
  });
});

describe("filterRequirements", () => {
  const list = [req({ id: "a" }), req({ id: "b", done: true })];
  it("active / done / 其它（含未知值当 all）", () => {
    expect(filterRequirements(list, "active").map((x) => x.id)).toEqual(["a"]);
    expect(filterRequirements(list, "done").map((x) => x.id)).toEqual(["b"]);
    expect(filterRequirements(list, "bogus")).toHaveLength(2);
    expect(filterRequirements(null, "active")).toEqual([]);
  });
});

describe("requirementLine", () => {
  it("汇总规模、工时、子任务完成度与超估算标记", () => {
    const line = requirementLine(
      req({ id: "r", name: "登录改造", estimateDays: 1, subtasks: [{ id: "s1", hours: 12, done: true }, { id: "s2", hours: 4 }] }),
      8
    );
    expect(line).toMatchObject({
      id: "r",
      name: "登录改造",
      done: false,
      estimateDays: 1,
      actualHours: 16,
      completedHours: 12,
      overrun: true,
      overHours: 8,
      subtaskTotal: 2,
      subtaskDone: 1,
      utilization: 200,
    });
    expect(line.size).toBeTruthy();
  });

  it("容忍缺字段", () => {
    expect(requirementLine(null)).toMatchObject({ id: "", name: "", done: false, subtaskTotal: 0 });
  });
});

describe("hoursText", () => {
  it("整数不带小数点，小数保留一位，非法值给 0h", () => {
    expect(hoursText(8)).toBe("8h");
    expect(hoursText(7.25)).toBe("7.3h");
    expect(hoursText(0)).toBe("0h");
    expect(hoursText(-3)).toBe("0h");
    expect(hoursText(undefined)).toBe("0h");
  });
});
