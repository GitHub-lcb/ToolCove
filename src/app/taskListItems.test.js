// 侧边栏任务列表投影纯函数单测：任务行截取 / 工作面分组 / agent 不可隐藏语义
import { describe, it, expect } from "vitest";
import { buildTaskItems, groupNavModules, TASK_LIST_LIMIT } from "./taskListItems.js";
import { NAV_MODULES } from "./navConfig.js";

describe("buildTaskItems", () => {
  const run = (id, over = {}) => ({ id, input: "目标 " + id, status: "completed", createdAt: 100, updatedAt: 200, ...over });

  it("取前 limit 条并保持原序（runs 已是最新在前，不重排）", () => {
    const runs = Array.from({ length: 30 }, (_, i) => run("r" + i));
    const items = buildTaskItems(runs);
    expect(items).toHaveLength(TASK_LIST_LIMIT);
    expect(items[0].id).toBe("r0");
    expect(items[items.length - 1].id).toBe("r" + (TASK_LIST_LIMIT - 1));
  });

  it("只投影渲染所需字段，updatedAt 缺时退回 createdAt", () => {
    const items = buildTaskItems([run("r1", { history: [1], steps: [2], usage: { calls: 3 } }), run("r2", { updatedAt: 0, createdAt: 50 })]);
    expect(items[0]).toEqual({ id: "r1", status: "completed", input: "目标 r1", updatedAt: 200 });
    expect(items[1].updatedAt).toBe(50);
  });

  it("limit 可配；缺字段与脏记录有兜底", () => {
    expect(buildTaskItems([run("r1"), run("r2"), run("r3")], { limit: 2 }).map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(buildTaskItems([{ id: "r9" }, null, {}])[0]).toEqual({ id: "r9", status: "", input: "", updatedAt: 0 });
  });

  it("非数组输入返回空数组", () => {
    expect(buildTaskItems(null)).toEqual([]);
    expect(buildTaskItems(undefined)).toEqual([]);
    expect(buildTaskItems("runs")).toEqual([]);
  });
});

describe("groupNavModules", () => {
  it("按 hiddenModules 过滤工作面三项", () => {
    expect(groupNavModules(NAV_MODULES, []).map((m) => m.key)).toEqual(["work", "records", "toolbox"]);
    expect(groupNavModules(NAV_MODULES, ["records"]).map((m) => m.key)).toEqual(["work", "toolbox"]);
    expect(groupNavModules(NAV_MODULES, ["work", "records", "toolbox"])).toEqual([]);
  });

  it("agent 永不入组：即使 hiddenKeys 含 agent 也只是剔除它，不影响其余", () => {
    // v9 迁移前的历史脏值里可能藏着 "agent"——它是默认主区，藏起来就没有主区了
    expect(groupNavModules(NAV_MODULES, ["agent"]).map((m) => m.key)).toEqual(["work", "records", "toolbox"]);
    expect(groupNavModules(NAV_MODULES, ["agent", "work"]).map((m) => m.key)).toEqual(["records", "toolbox"]);
  });

  it("非数组输入有兜底", () => {
    expect(groupNavModules(null, null)).toEqual([]);
    expect(groupNavModules(NAV_MODULES, null).map((m) => m.key)).toEqual(["work", "records", "toolbox"]);
  });
});
