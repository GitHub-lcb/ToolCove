import { describe, expect, it } from "vitest";
import { createRequirementItem, normalizeEstimateDays, parseEstimateInput, requirementActualHours, requirementCompletedHours, requirementMetrics, sizeByDays, subtaskActualHours } from "./requirementMetrics.js";

describe("需求规模", () => {
  it("按 10、30 人天边界分类", () => {
    expect(sizeByDays(9.5).key).toBe("small");
    expect(sizeByDays(10).key).toBe("medium");
    expect(sizeByDays(29.5).key).toBe("medium");
    expect(sizeByDays(30).key).toBe("large");
  });

  it("没有有效天数时为未评估", () => {
    expect(sizeByDays(0).key).toBe("unestimated");
    expect(normalizeEstimateDays("")).toBeNull();
    expect(normalizeEstimateDays(-1)).toBeNull();
    expect(normalizeEstimateDays("12.5")).toBe(12.5);
  });
});

describe("需求工时指标", () => {
  it("合计子任务工时并换算实际人天", () => {
    const requirement = { subtasks: [{ hours: 4 }, { hours: "8" }, { hours: null }] };
    expect(requirementActualHours(requirement)).toBe(12);
    expect(requirementMetrics(requirement, 8)).toMatchObject({ actualHours: 12, actualDays: 1.5 });
  });

  it("有登记明细时以 logs 为实际工时，不再使用顶层 hours", () => {
    const task = {
      hours: 0,
      logs: [
        { date: "2026-08-12", hours: 2 },
        { date: "2026-08-13", hours: 4 },
      ],
    };
    expect(subtaskActualHours(task)).toBe(6);
  });

  it("已完成人天只累计完成状态的子任务", () => {
    const requirement = {
      subtasks: [
        { done: true, hours: 0, logs: [{ hours: 4 }, { hours: 2 }] },
        { done: false, hours: 0, logs: [{ hours: 3 }] },
        { done: true, hours: 2, logs: [] },
      ],
    };
    expect(requirementActualHours(requirement)).toBe(11);
    expect(requirementCompletedHours(requirement)).toBe(8);
    expect(requirementMetrics(requirement, 8)).toMatchObject({ actualDays: 1.38, completedHours: 8, completedDays: 1 });
  });

  it("兼容历史需求级工时，需求完成后计入已完成人天", () => {
    const requirement = { done: true, subtasks: [], logs: [{ hours: 4 }, { hours: 2 }] };
    expect(requirementMetrics(requirement, 8)).toMatchObject({ actualHours: 6, actualDays: 0.75, completedHours: 6, completedDays: 0.75 });
  });

  it("有预估时按预估分类并识别超额", () => {
    const result = requirementMetrics({ estimateDays: 1, subtasks: [{ hours: 9.5 }] }, 8);
    expect(result).toMatchObject({
      estimateHours: 8,
      actualHours: 9.5,
      actualDays: 1.19,
      sizeSource: "estimate",
      overrun: true,
      overHours: 1.5,
      utilization: 119,
    });
  });

  it("无预估时按实际人天分类且不告警", () => {
    const result = requirementMetrics({ subtasks: [{ hours: 96 }] }, 8);
    expect(result.size.key).toBe("medium");
    expect(result.sizeSource).toBe("actual");
    expect(result.overrun).toBe(false);
    expect(result.estimateHours).toBeNull();
  });
});

describe("新建需求条目", () => {
  it("构造完整默认形状并规范化预估天数", () => {
    const item = createRequirementItem({ name: "对账导出优化", url: "https://x", estimateDays: "12.345" });
    expect(item).toMatchObject({
      name: "对账导出优化",
      url: "https://x",
      estimateDays: 12.35,
      note: "",
      done: false,
      subtasks: [],
      logs: [],
    });
    expect(typeof item.id).toBe("string");
    expect(item.id.length).toBeGreaterThan(0);
  });

  it("名称为空返回 null", () => {
    expect(createRequirementItem({ name: "  " })).toBeNull();
  });

  it("未填预估天数为 null", () => {
    expect(createRequirementItem({ name: "x", estimateDays: "" }).estimateDays).toBeNull();
  });

  it("parseEstimateInput 门禁：空/合法/非法", () => {
    expect(parseEstimateInput("")).toEqual({ valid: true, value: null });
    expect(parseEstimateInput("12.5")).toEqual({ valid: true, value: "12.5" });
    expect(parseEstimateInput("0").valid).toBe(false);
    expect(parseEstimateInput("-1").valid).toBe(false);
    expect(parseEstimateInput("abc").valid).toBe(false);
  });
});
