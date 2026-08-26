import { describe, expect, it } from "vitest";
import { normalizeHiddenModules, normalizeTelemetry } from "./settingsConfig.js";

describe("normalizeHiddenModules", () => {
  const ALL = ["toolbox", "snippet", "problem"];

  it("只保留当前存在的模块 key，去重且保持顺序", () => {
    expect(normalizeHiddenModules(ALL, ["problem", "snippet", "problem", "legacy", 3])).toEqual(["problem", "snippet"]);
  });

  it("非数组输入归一为空列表", () => {
    expect(normalizeHiddenModules(ALL, null)).toEqual([]);
    expect(normalizeHiddenModules(undefined, ["toolbox"])).toEqual([]);
  });
});

describe("normalizeTelemetry（旧数据兼容）", () => {
  it("缺字段/非对象 → 默认关闭且未询问，installId 置 null", () => {
    expect(normalizeTelemetry(undefined)).toEqual({ enabled: false, prompted: false, installId: null });
    expect(normalizeTelemetry(null)).toEqual({ enabled: false, prompted: false, installId: null });
    expect(normalizeTelemetry({})).toEqual({ enabled: false, prompted: false, installId: null });
    expect(normalizeTelemetry("x")).toEqual({ enabled: false, prompted: false, installId: null });
  });

  it("半值/非法 installId 补齐或置空", () => {
    expect(normalizeTelemetry({ enabled: true })).toEqual({ enabled: true, prompted: false, installId: null });
    expect(normalizeTelemetry({ prompted: true })).toEqual({ enabled: false, prompted: true, installId: null });
    expect(normalizeTelemetry({ enabled: true, prompted: true, installId: "" })).toEqual({ enabled: true, prompted: true, installId: null });
    expect(normalizeTelemetry({ enabled: true, installId: 123 })).toEqual({ enabled: true, prompted: false, installId: null });
    expect(normalizeTelemetry({ enabled: true, installId: "a".repeat(200) })).toEqual({ enabled: true, prompted: false, installId: null });
  });

  it("合法配置原样保留（enabled 非布尔值按 false 归一）", () => {
    expect(normalizeTelemetry({ enabled: true, prompted: true, installId: "uuid-1" })).toEqual({ enabled: true, prompted: true, installId: "uuid-1" });
    expect(normalizeTelemetry({ enabled: "yes", prompted: false, installId: "uuid-2" }).enabled).toBe(false);
  });
});
