import { describe, it, expect } from "vitest";
import {
  newIteration,
  newRequirement,
  newSubTask,
  addIteration,
  addRequirement,
  addSubTask,
  updateIteration,
  updateRequirement,
  updateSubTask,
  removeIteration,
  removeRequirement,
  removeSubTask,
  findIteration,
  findRequirement,
  findSubTask,
  iterationHours,
} from "./tasks.js";

function base() {
  const it = newIteration({ title: "迭代一", releaseDate: "2026-09-01", version: "v0.2.0" });
  const r = newRequirement({ name: "需求一" });
  return addRequirement(addIteration([], it), it.id, r);
}

describe("tasks 本地数据层", () => {
  it("newIteration/newRequirement/newSubTask 生成完整对象", () => {
    const it = newIteration({ title: " 迭代一 " });
    expect(it.id).toBeTruthy();
    expect(it.title).toBe("迭代一");
    expect(it.status).toBe("plan");
    expect(it.items).toEqual([]);
    expect(it.updatedAt).toBeTruthy();

    const r = newRequirement({ name: " 需求一 " });
    expect(r.id).toBeTruthy();
    expect(r.name).toBe("需求一");
    expect(r.done).toBe(false);
    expect(r.subtasks).toEqual([]);

    const s = newSubTask({ name: "开发", hours: 3.5 });
    expect(s.id).toBeTruthy();
    expect(s.name).toBe("开发");
    expect(s.hours).toBe(3.5);
    expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.logs).toEqual([]);
  });

  it("newSubTask 负数工时归零、空名可容忍", () => {
    expect(newSubTask({ name: "x", hours: -2 }).hours).toBe(0);
    expect(newSubTask({ name: "" }).name).toBe("");
  });

  it("addIteration/addRequirement/addSubTask 追加到对应层级", () => {
    let list = base();
    const it = findIteration(list, list[0].id);
    const r = findRequirement(list, it.id, it.items[0].id);
    list = addSubTask(list, it.id, r.id, newSubTask({ name: "开发", hours: 2 }));
    const it2 = findIteration(list, it.id);
    expect(it2.items[0].subtasks).toHaveLength(1);
    expect(it2.items[0].subtasks[0].name).toBe("开发");
    expect(it2.updatedAt).toBeTruthy();
  });

  it("updateIteration/updateRequirement/updateSubTask 局部更新不动其他层级", () => {
    let list = base();
    const it = list[0];
    const r = it.items[0];
    list = addSubTask(list, it.id, r.id, newSubTask({ name: "开发", hours: 1 }));
    list = updateIteration(list, it.id, { status: "dev" });
    list = updateRequirement(list, it.id, r.id, { done: true });
    list = updateSubTask(list, it.id, r.id, list[0].items[0].subtasks[0].id, { hours: 4 });
    const it2 = findIteration(list, it.id);
    expect(it2.status).toBe("dev");
    expect(it2.items[0].done).toBe(true);
    expect(it2.items[0].name).toBe("需求一");
    expect(it2.items[0].subtasks[0].hours).toBe(4);
  });

  it("removeIteration/removeRequirement/removeSubTask 精确删除", () => {
    let list = base();
    const it = list[0];
    const r = it.items[0];
    list = addSubTask(list, it.id, r.id, newSubTask({ name: "a", hours: 1 }));
    list = addSubTask(list, it.id, r.id, newSubTask({ name: "b", hours: 2 }));
    const subId = list[0].items[0].subtasks[0].id;
    list = removeSubTask(list, it.id, r.id, subId);
    expect(list[0].items[0].subtasks).toHaveLength(1);
    expect(list[0].items[0].subtasks[0].name).toBe("b");

    list = removeRequirement(list, it.id, r.id);
    expect(list[0].items).toHaveLength(0);

    const it2 = newIteration({ title: "二" });
    list = addIteration(list, it2);
    list = removeIteration(list, it2.id);
    expect(list).toHaveLength(1);
  });

  it("find* 找不到返回 null 且修改类函数对空输入安全", () => {
    expect(findIteration([], "x")).toBeNull();
    expect(findRequirement([], "x", "y")).toBeNull();
    expect(findSubTask([], "x", "y", "z")).toBeNull();
    expect(removeSubTask(null, "x", "y", "z")).toEqual([]);
    expect(updateIteration(undefined, "x", {})).toEqual([]);
  });

  it("iterationHours 汇总子任务工时（logs 明细优先）", () => {
    const it = newIteration({ title: "汇总" });
    let list = [it];
    const r = newRequirement({ name: "需求" });
    list = addRequirement(list, it.id, r);
    const r2 = findRequirement(list, it.id, r.id);
    // 无 logs：按 hours 回退
    list = addSubTask(list, it.id, r2.id, newSubTask({ name: "a", hours: 1.5 }));
    // 有 logs：按 logs 明细逐条统计
    list = addSubTask(list, it.id, r2.id, {
      ...newSubTask({ name: "b", hours: 9 }),
      logs: [
        { date: "2026-08-24", hours: 4, name: "" },
        { date: "2026-08-25", hours: 5, name: "" },
      ],
    });
    expect(iterationHours(list[0])).toBe(10.5);
    expect(iterationHours(null)).toBe(0);
  });
});
