import { describe, expect, it } from "vitest";
import { createHistory } from "./history.js";

describe("标注操作栈", () => {
  it("push 后可撤销，undo/redo 往返一致", () => {
    const h = createHistory();
    h.push({ kind: "rect" });
    h.push({ kind: "arrow" });
    expect(h.active()).toHaveLength(2);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);

    h.undo();
    expect(h.active().map((op) => op.kind)).toEqual(["rect"]);
    expect(h.canRedo).toBe(true);

    h.redo();
    expect(h.active().map((op) => op.kind)).toEqual(["rect", "arrow"]);
  });

  it("撤销后再画会截断重做分支", () => {
    const h = createHistory();
    h.push({ kind: "a" });
    h.push({ kind: "b" });
    h.undo();
    h.push({ kind: "c" });
    expect(h.active().map((op) => op.kind)).toEqual(["a", "c"]);
    expect(h.canRedo).toBe(false);
  });

  it("空栈时撤销/重做都是空操作", () => {
    const h = createHistory();
    expect(h.undo()).toEqual([]);
    expect(h.redo()).toEqual([]);
    expect(h.canUndo).toBe(false);
  });

  it("超过上限时丢弃最老的操作（防长时间标注吃内存）", () => {
    const h = createHistory(3);
    for (const kind of ["a", "b", "c", "d"]) h.push({ kind });
    expect(h.active().map((op) => op.kind)).toEqual(["b", "c", "d"]);
  });

  it("clear 清空并重置游标", () => {
    const h = createHistory();
    h.push({ kind: "a" });
    h.clear();
    expect(h.active()).toEqual([]);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});
