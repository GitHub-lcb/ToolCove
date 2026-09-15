// 工具箱首页状态单测：快捷区排序补位、多开分类、展开状态恢复
import { describe, it, expect } from "vitest";
import { buildToolboxQuickList, normalizeExpandedGroups, toggleExpandedGroup } from "./toolboxViewState.js";
import { visibleToolboxTools } from "./toolboxTools.js";

const tools = [
  { key: "json", labelKey: "toolbox.registry.toolJson" },
  { key: "request", labelKey: "toolbox.registry.toolRequest" },
  { key: "convert", labelKey: "toolbox.registry.toolConvert" },
  { key: "chat", labelKey: "toolbox.registry.toolChat" },
  { key: "planned", labelKey: "toolbox.registry.toolPlanned", ready: false },
];

describe("buildToolboxQuickList", () => {
  it("按收藏、最近使用、注册表顺序补位并去重", () => {
    const quick = buildToolboxQuickList(
      tools,
      ["request", "missing", "json"],
      [{ key: "json", ts: 30 }, { key: "chat", ts: 20 }, { key: "missing", ts: 10 }],
      4
    );

    expect(quick.map((tool) => tool.key)).toEqual(["request", "json", "chat", "convert"]);
  });

  it("没有收藏和使用记录时按注册表顺序补齐", () => {
    expect(buildToolboxQuickList(tools, [], [], 3).map((tool) => tool.key)).toEqual(["json", "request", "convert"]);
  });

  it("跳过尚未开放的占位工具", () => {
    expect(buildToolboxQuickList(tools, ["planned"], [{ key: "planned" }], 10).map((tool) => tool.key)).not.toContain("planned");
  });

  it("容量上限之外的工具不再补位", () => {
    expect(buildToolboxQuickList(tools, [], [], 2).map((tool) => tool.key)).toEqual(["json", "request"]);
  });

  it("脏数据（非数组）按空处理，不抛错", () => {
    expect(buildToolboxQuickList(tools, null, undefined, 2).map((tool) => tool.key)).toEqual(["json", "request"]);
  });

  it("真实注册表能补齐满额快捷入口", () => {
    const quick = buildToolboxQuickList(visibleToolboxTools(), [], [], 6);
    expect(quick).toHaveLength(6);
    expect(new Set(quick.map((tool) => tool.key)).size).toBe(6);
    expect(quick.every((tool) => tool.ready)).toBe(true);
  });
});

describe("toggleExpandedGroup", () => {
  it("允许同时展开多个大类", () => {
    const once = toggleExpandedGroup([], "data");
    const twice = toggleExpandedGroup(once, "network");
    const closed = toggleExpandedGroup(twice, "data");

    expect(once).toEqual(["data"]);
    expect(twice).toEqual(["data", "network"]);
    expect(closed).toEqual(["network"]);
  });

  it("返回新数组，不改动入参", () => {
    const keys = ["data"];
    expect(toggleExpandedGroup(keys, "network")).not.toBe(keys);
    expect(keys).toEqual(["data"]);
  });

  it("空 key 与脏数据按原状态副本返回", () => {
    expect(toggleExpandedGroup(["data"], "")).toEqual(["data"]);
    expect(toggleExpandedGroup(null, "")).toEqual([]);
  });
});

describe("normalizeExpandedGroups", () => {
  it("过滤重复项与不存在的大类", () => {
    const groups = [{ key: "data" }, { key: "network" }];
    expect(normalizeExpandedGroups(["network", "missing", "data", "network"], groups)).toEqual(["network", "data"]);
  });

  it("脏数据回退为空数组", () => {
    expect(normalizeExpandedGroups(undefined, [{ key: "data" }])).toEqual([]);
  });
});
