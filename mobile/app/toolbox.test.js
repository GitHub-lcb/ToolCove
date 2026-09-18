import { describe, expect, it } from "vitest";
import { TOOLS, TOOL_BY_KEY, TOOL_GROUPS, progressOf, toolsOfGroup } from "./toolbox.js";

describe("手机端工具箱目录", () => {
  it("每个工具的分组都在已定义的分组里（写错分组会让它在界面上消失）", () => {
    const known = new Set(TOOL_GROUPS.map((g) => g.key));
    for (const tool of TOOLS) expect(known.has(tool.group), `${tool.key} 的分组 ${tool.group} 未定义`).toBe(true);
  });

  it("key 不重复，且能按 key 取回同一条", () => {
    const keys = TOOLS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tool of TOOLS) expect(TOOL_BY_KEY[tool.key]).toBe(tool);
  });

  it("每个分组都有工具（空分组会在界面上留下一片空白）", () => {
    for (const group of TOOL_GROUPS) expect(toolsOfGroup(group.key).length, `${group.key} 是空的`).toBeGreaterThan(0);
  });

  it("平台独占的能力必须带降级说明（不能只写「迁移中」而不说为什么）", () => {
    for (const key of ["db", "network", "label"]) {
      const tool = TOOL_BY_KEY[key];
      expect(tool.ready).toBe(false);
      expect(tool.note, `${key} 缺少降级说明`).toBeTruthy();
    }
  });

  it("已迁移的工具不应该带降级说明", () => {
    for (const tool of TOOLS.filter((t) => t.ready)) expect(tool.note, `${tool.key} 已可用却有 note`).toBeUndefined();
  });

  it("进度按已可用数量计算", () => {
    expect(progressOf([])).toEqual({ ready: 0, total: 0, pct: 0 });
    expect(progressOf([{ ready: true }, { ready: false }])).toEqual({ ready: 1, total: 2, pct: 50 });
    // 真实清单：至少有一个已可用（否则说明清单写错了）
    expect(progressOf().ready).toBeGreaterThan(0);
  });

  it("toolsOfGroup 保持清单顺序", () => {
    expect(toolsOfGroup("data").map((t) => t.key)).toEqual(["json", "convert", "time"]);
  });
});
