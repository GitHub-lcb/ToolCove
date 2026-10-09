import { describe, expect, it } from "vitest";
import { clampRect, hitHandle, insideRect, moveRect, nudgeRect, rectFromPoints, resizeRect, toPhysicalRect } from "./geometry.js";

const BOUNDS = { width: 1000, height: 800 };

describe("rectFromPoints", () => {
  it("任意方向拖拽都归一化为非负宽高", () => {
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 60, y: 90 })).toEqual({ x: 10, y: 20, width: 50, height: 70 });
    expect(rectFromPoints({ x: 60, y: 90 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 50, height: 70 });
  });
});

describe("clampRect", () => {
  it("越界时挪回边界内，尺寸不变", () => {
    const rect = clampRect({ x: 950, y: 780, width: 100, height: 60 }, BOUNDS);
    expect(rect).toEqual({ x: 900, y: 740, width: 100, height: 60 });
  });

  it("比边界还大时压缩到边界", () => {
    const rect = clampRect({ x: -20, y: -30, width: 2000, height: 900 }, BOUNDS);
    expect(rect).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });
});

describe("hitHandle", () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 };

  it("命中四角与四边", () => {
    expect(hitHandle(rect, { x: 100, y: 100 })).toBe("nw");
    expect(hitHandle(rect, { x: 300, y: 100 })).toBe("ne");
    expect(hitHandle(rect, { x: 100, y: 250 })).toBe("sw");
    expect(hitHandle(rect, { x: 300, y: 250 })).toBe("se");
    expect(hitHandle(rect, { x: 200, y: 100 })).toBe("n");
    expect(hitHandle(rect, { x: 200, y: 250 })).toBe("s");
    expect(hitHandle(rect, { x: 100, y: 175 })).toBe("w");
    expect(hitHandle(rect, { x: 300, y: 175 })).toBe("e");
  });

  it("选区内非边缘、选区外都不算手柄", () => {
    expect(hitHandle(rect, { x: 200, y: 175 })).toBe(null);
    expect(hitHandle(rect, { x: 500, y: 500 })).toBe(null);
  });

  it("判定半径内的外侧也算命中（好点中）", () => {
    expect(hitHandle(rect, { x: 96, y: 96 })).toBe("nw");
  });
});

describe("resizeRect", () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 };

  it("拖右下角只动右/下两边", () => {
    expect(resizeRect(rect, "se", { x: 400, y: 400 }, BOUNDS)).toEqual({ x: 100, y: 100, width: 300, height: 300 });
  });

  it("拖左上角动左/上两边，对边保持不动", () => {
    expect(resizeRect(rect, "nw", { x: 50, y: 60 }, BOUNDS)).toEqual({ x: 50, y: 60, width: 250, height: 190 });
  });

  it("缩过头停在最小尺寸而不是翻转", () => {
    const result = resizeRect(rect, "e", { x: 90, y: 175 }, BOUNDS, 4);
    expect(result.width).toBe(4);
    expect(result.x).toBe(100);
  });

  it("拖出边界自动钳回", () => {
    const result = resizeRect(rect, "se", { x: 5000, y: 5000 }, BOUNDS);
    expect(result.x + result.width).toBeLessThanOrEqual(BOUNDS.width);
    expect(result.y + result.height).toBeLessThanOrEqual(BOUNDS.height);
  });
});

describe("moveRect / nudgeRect", () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 };

  it("移动保持尺寸，撞边界停住", () => {
    expect(moveRect(rect, 50, 30, BOUNDS)).toEqual({ x: 150, y: 130, width: 200, height: 150 });
    expect(moveRect(rect, 5000, 0, BOUNDS)).toEqual({ x: 800, y: 100, width: 200, height: 150 });
  });

  it("方向键按步长微调；非方向键原样返回", () => {
    expect(nudgeRect(rect, "ArrowRight", 1, BOUNDS)).toEqual({ ...rect, x: 101 });
    expect(nudgeRect(rect, "ArrowUp", 10, BOUNDS)).toEqual({ ...rect, y: 90 });
    expect(nudgeRect(rect, "Enter", 1, BOUNDS)).toBe(rect);
  });
});

describe("insideRect", () => {
  it("含边界", () => {
    expect(insideRect({ x: 10, y: 10, width: 100, height: 100 }, { x: 10, y: 110 })).toBe(true);
    expect(insideRect({ x: 10, y: 10, width: 100, height: 100 }, { x: 111, y: 50 })).toBe(false);
  });
});

describe("toPhysicalRect", () => {
  it("乘缩放比并取整，且不出画布", () => {
    const bounds = { width: 1920, height: 1080 };
    expect(toPhysicalRect({ x: 10, y: 20, width: 100, height: 50 }, 1.5, 1.5, bounds)).toEqual({ x: 15, y: 30, width: 150, height: 75 });
  });

  it("贴边时不越界（右下取到画布尺寸）", () => {
    const bounds = { width: 1000, height: 600 };
    const rect = toPhysicalRect({ x: 500, y: 300, width: 500, height: 300 }, 1, 1, bounds);
    expect(rect.x + rect.width).toBe(1000);
    expect(rect.y + rect.height).toBe(600);
  });

  it("极小选区至少 1 像素，导出不会得到 0 宽画布", () => {
    const rect = toPhysicalRect({ x: 0, y: 0, width: 0.1, height: 0.1 }, 1, 1, { width: 100, height: 100 });
    expect(rect.width).toBeGreaterThanOrEqual(1);
    expect(rect.height).toBeGreaterThanOrEqual(1);
  });
});
