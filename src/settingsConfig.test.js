import { describe, expect, it } from "vitest";
import { normalizeHiddenModules } from "./settingsConfig.js";

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
