import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import { cloneJsonData } from "./jsonData.js";

describe("cloneJsonData", () => {
  it("可以克隆 Vue 响应式对象并生成独立 JSON 快照", () => {
    const source = reactive({
      iterations: [{ id: "1", items: [{ subtasks: [{ code: "17334", hours: 2 }] }] }],
    });

    const snapshot = cloneJsonData(source);
    source.iterations[0].items[0].subtasks[0].hours = 4;

    expect(snapshot).toEqual({
      iterations: [{ id: "1", items: [{ subtasks: [{ code: "17334", hours: 2 }] }] }],
    });
  });

  it("保留 null 和 undefined 顶层值", () => {
    expect(cloneJsonData(null)).toBeNull();
    expect(cloneJsonData(undefined)).toBeUndefined();
  });
});
