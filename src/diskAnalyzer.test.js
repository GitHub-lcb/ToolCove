import { describe, expect, it } from "vitest";
import {
  applyDeletions,
  durationParts,
  formatBytes,
  formatPercent,
  isDirectChild,
  mergeEntries,
  selectionTotals,
  share,
  squarify,
  tileAt,
} from "./diskAnalyzer.js";

const RECT = { x: 0, y: 0, width: 400, height: 300 };

function areaOf(tile) {
  return tile.w * tile.h;
}

describe("磁盘分析：占比与格式化", () => {
  it("share 对零总量与非法值返回 0 而不是 NaN/Infinity", () => {
    expect(share(10, 0)).toBe(0);
    expect(share(10, -5)).toBe(0);
    expect(share(Number.NaN, 100)).toBe(0);
    expect(share(50, 200)).toBe(0.25);
    expect(share(500, 200)).toBe(1); // 溢出钳到 1，条形不会画出格
  });

  it("formatPercent 去掉无意义的小数尾巴，零总量显示 0%", () => {
    expect(formatPercent(50, 200)).toBe("25%");
    expect(formatPercent(1, 3)).toBe("33.3%");
    expect(formatPercent(1, 0)).toBe("0%");
  });

  it("formatBytes 复用文件处理的口径", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
  });

  it("durationParts 按毫秒/秒/分换挡", () => {
    expect(durationParts(820)).toEqual({ value: 820, unit: "ms" });
    expect(durationParts(3400)).toEqual({ value: 3.4, unit: "s" });
    expect(durationParts(72_000)).toEqual({ value: 1.2, unit: "min" });
    expect(durationParts(-5)).toEqual({ value: 0, unit: "ms" });
  });
});

describe("磁盘分析：合并目录与文件列表", () => {
  const dirs = [
    { id: 1, name: "Downloads", size: 300, files: 10, dirs: 0 },
    { id: 2, name: "Photos", size: 900, files: 20, dirs: 3 },
  ];
  const files = [
    { name: "big.iso", path: "D:\\big.iso", size: 1000 },
    { name: "note.txt", path: "D:\\note.txt", size: 5 },
  ];

  it("目录与文件按体积混排，目录保留可下钻的 id", () => {
    const { rows, total, truncated } = mergeEntries(dirs, files);
    expect(rows.map((row) => row.name)).toEqual(["big.iso", "Photos", "Downloads", "note.txt"]);
    expect(rows[1]).toMatchObject({ kind: "dir", id: 2, size: 900 });
    expect(rows[0]).toMatchObject({ kind: "file", path: "D:\\big.iso" });
    expect(total).toBe(4);
    expect(truncated).toBe(false);
  });

  it("超过 limit 时截断并从 total 如实反映全量", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ id: index, name: `d${index}`, size: index }));
    const { rows, total, truncated } = mergeEntries(many, [], 4);
    expect(rows).toHaveLength(4);
    expect(total).toBe(10);
    expect(truncated).toBe(true);
    // 截断取的是最大的 4 个
    expect(rows.map((row) => row.size)).toEqual([9, 8, 7, 6]);
  });

  it("空输入与非法输入都返回空列表", () => {
    expect(mergeEntries(null, undefined).rows).toEqual([]);
    expect(mergeEntries([], []).total).toBe(0);
  });
});

describe("磁盘分析：squarified treemap", () => {
  it("面积与体积成正比，且总和覆盖整个矩形", () => {
    const items = [
      { key: "a", size: 50 },
      { key: "b", size: 30 },
      { key: "c", size: 20 },
    ];
    const tiles = squarify(items, RECT);
    expect(tiles).toHaveLength(3);
    const totalArea = RECT.width * RECT.height;
    const total = 100;
    for (const tile of tiles) {
      const item = items.find((entry) => entry.key === tile.key);
      const expected = (item.size / total) * totalArea;
      expect(areaOf(tile)).toBeCloseTo(expected, 3);
    }
    const sum = tiles.reduce((acc, tile) => acc + areaOf(tile), 0);
    expect(sum).toBeCloseTo(totalArea, 3);
  });

  it("所有块都在矩形内，且按体积降序排在前", () => {
    const items = Array.from({ length: 60 }, (_, index) => ({ key: `k${index}`, size: 61 - index }));
    const tiles = squarify(items, RECT);
    expect(tiles).toHaveLength(60);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(RECT.x - 1e-6);
      expect(tile.y).toBeGreaterThanOrEqual(RECT.y - 1e-6);
      expect(tile.x + tile.w).toBeLessThanOrEqual(RECT.x + RECT.width + 1e-6);
      expect(tile.y + tile.h).toBeLessThanOrEqual(RECT.y + RECT.height + 1e-6);
      expect(tile.w).toBeGreaterThanOrEqual(0);
      expect(tile.h).toBeGreaterThanOrEqual(0);
    }
    expect(tiles[0].key).toBe("k0"); // 最大的一块在第一个（左上）
    expect(areaOf(tiles[0])).toBeGreaterThan(areaOf(tiles[tiles.length - 1]));
  });

  it("单块铺满整个矩形", () => {
    const tiles = squarify([{ key: "only", size: 7 }], RECT);
    expect(tiles).toHaveLength(1);
    expect(areaOf(tiles[0])).toBeCloseTo(RECT.width * RECT.height, 6);
  });

  it("极端长宽比与极小矩形也不越界", () => {
    const items = [
      { key: "huge", size: 100_000 },
      { key: "tiny1", size: 1 },
      { key: "tiny2", size: 2 },
      { key: "tiny3", size: 3 },
    ];
    for (const rect of [{ x: 0, y: 0, width: 800, height: 10 }, { x: 5, y: 7, width: 40, height: 900 }]) {
      const tiles = squarify(items, rect);
      for (const tile of tiles) {
        expect(tile.x).toBeGreaterThanOrEqual(rect.x - 1e-6);
        expect(tile.y).toBeGreaterThanOrEqual(rect.y - 1e-6);
        expect(tile.x + tile.w).toBeLessThanOrEqual(rect.x + rect.width + 1e-6);
        expect(tile.y + tile.h).toBeLessThanOrEqual(rect.y + rect.height + 1e-6);
      }
    }
  });

  it("空列表、零体积、零尺寸矩形都返回空", () => {
    expect(squarify([], RECT)).toEqual([]);
    expect(squarify([{ key: "z", size: 0 }], RECT)).toEqual([]);
    expect(squarify([{ key: "a", size: 10 }], { x: 0, y: 0, width: 0, height: 100 })).toEqual([]);
    expect(squarify(null, null)).toEqual([]);
  });

  it("tileAt 命中测试：命中最后绘制的块，界外返回 null", () => {
    const tiles = [
      { key: "a", size: 100, x: 0, y: 0, w: 100, h: 100 },
      { key: "b", size: 50, x: 100, y: 0, w: 100, h: 50 },
    ];
    expect(tileAt(tiles, 50, 50)?.key).toBe("a");
    expect(tileAt(tiles, 150, 20)?.key).toBe("b");
    expect(tileAt(tiles, 350, 350)).toBeNull();
    expect(tileAt(tiles, Number.NaN, 10)).toBeNull();
  });
});

describe("磁盘分析：删除后的就地扣减", () => {
  const stack = () => [
    { id: 0, size: 1000, ownBytes: 100, files: 10, dirs: 3 },
    { id: 1, size: 600, ownBytes: 50, files: 6, dirs: 1 },
  ];

  it("删文件：体积与文件数逐层扣减，ownBytes 只扣当前层（祖先的直属文件不含它）", () => {
    const next = applyDeletions(stack(), [{ kind: "file", size: 100 }]);
    expect(next[0]).toMatchObject({ size: 900, ownBytes: 100, files: 9, dirs: 3 });
    expect(next[1]).toMatchObject({ size: 500, ownBytes: 0, files: 5, dirs: 1 });
  });

  it("删目录：按快照的文件数/子目录数扣，ownBytes 不动", () => {
    const next = applyDeletions(stack(), [{ kind: "dir", size: 300, files: 4, dirs: 2 }]);
    expect(next[0]).toMatchObject({ size: 700, ownBytes: 100, files: 6, dirs: 1 });
    expect(next[1]).toMatchObject({ size: 300, ownBytes: 50, files: 2, dirs: 0 });
  });

  it("批量删除叠加扣减，且任何字段都不会被扣成负数", () => {
    const next = applyDeletions(stack(), [
      { kind: "file", size: 80 },
      { kind: "file", size: 80 },
      { kind: "dir", size: 900, files: 99, dirs: 99 },
    ]);
    expect(next[0]).toMatchObject({ size: 0, ownBytes: 100, files: 0, dirs: 0 });
    expect(next[1]).toMatchObject({ size: 0, ownBytes: 0, files: 0, dirs: 0 });
  });

  it("返回新对象，不改写入参（快照对象还要用于别处的渲染）", () => {
    const source = stack();
    const next = applyDeletions(source, [{ kind: "file", size: 100 }]);
    expect(source[0].size).toBe(1000);
    expect(next[0]).not.toBe(source[0]);
  });
});

describe("磁盘分析：选择合计与直接子项判断", () => {
  it("selectionTotals 汇总项数与体积，非法值按 0 计", () => {
    expect(selectionTotals([{ size: 100 }, { size: 50 }])).toEqual({ count: 2, size: 150 });
    expect(selectionTotals([{ size: -5 }, { size: Number.NaN }])).toEqual({ count: 2, size: 0 });
    expect(selectionTotals(null)).toEqual({ count: 0, size: 0 });
  });

  it("isDirectChild 只认直接子项（用于判断能否就地扣减）", () => {
    expect(isDirectChild("C:\\Users\\me", "C:\\Users\\me\\a.txt")).toBe(true);
    expect(isDirectChild("C:\\", "C:\\a.txt")).toBe(true);
    expect(isDirectChild("C:\\Users\\me", "C:\\Users\\me\\sub\\a.txt")).toBe(false);
    expect(isDirectChild("C:\\Users\\me", "C:\\Users\\metoo\\a.txt")).toBe(false);
    expect(isDirectChild("c:\\Users\\me", "C:\\Users\\me\\a.txt")).toBe(true); // Windows 路径大小写不敏感
    expect(isDirectChild("/home/me", "/home/me/a.txt")).toBe(true);
    expect(isDirectChild("/home/me", "/home/me/sub/a.txt")).toBe(false);
    expect(isDirectChild("", "C:\\a.txt")).toBe(false);
  });
});
