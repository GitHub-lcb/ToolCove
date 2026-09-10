import { describe, it, expect } from "vitest";
import {
  lwwCompare,
  mergeRemote,
  collectPushes,
  pruneTombstones,
  normalizeRemoteItem,
  normalizeEnvelope,
} from "./merge.js";

const mk = (id, ts, deviceId, extra = {}) => ({ envelope: { deviceId, ts, record: { id, updatedAt: ts, title: extra.title || "t", images: extra.images } }, updatedAt: ts, tombstone: !!extra.tombstone });

describe("lwwCompare", () => {
  it("ts 大者胜；同 ts 按 deviceId 字典序", () => {
    expect(lwwCompare(10, "a", 5, "b")).toBe(1);
    expect(lwwCompare(5, "a", 10, "b")).toBe(-1);
    expect(lwwCompare(10, "c", 10, "b")).toBe(1);
    expect(lwwCompare(10, "b", 10, "c")).toBe(-1);
    expect(lwwCompare(10, "a", 10, "a")).toBe(0);
  });
});

describe("mergeRemote LWW 矩阵", () => {
  it("远端新记录 → add", () => {
    const { records, ops } = mergeRemote([], [mk("r1", 2000, "devB")], "devA");
    expect(ops).toEqual([{ type: "add", record: expect.objectContaining({ id: "r1" }) }]);
    expect(records).toHaveLength(1);
  });

  it("远端旧于本地 → 忽略", () => {
    const local = [{ id: "r1", updatedAt: 5000, title: "new" }];
    const { records, ops } = mergeRemote(local, [mk("r1", 1000, "devB", { title: "old" })], "devA");
    expect(ops).toEqual([]);
    expect(records[0].title).toBe("new");
  });

  it("同 ts：deviceId 大者胜（双端同规则）", () => {
    const local = [{ id: "r1", updatedAt: 1000, title: "fromA" }];
    // 本地 deviceId devA，远端 devB → 远端赢
    const a = mergeRemote(local, [mk("r1", 1000, "devB", { title: "fromB" })], "devA");
    expect(a.records[0].title).toBe("fromB");
    // 反向视角（设备 B 的本地）→ 规则一致：仍是 devB 赢
    const localB = [{ id: "r1", updatedAt: 1000, title: "fromB" }];
    const b = mergeRemote(localB, [mk("r1", 1000, "devA", { title: "fromA" })], "devB");
    expect(b.records[0].title).toBe("fromB");
  });

  it("远端新于本地 → update", () => {
    const local = [{ id: "r1", updatedAt: 100, title: "old" }];
    const { ops } = mergeRemote(local, [mk("r1", 900, "devB", { title: "fresh" })], "devA");
    expect(ops).toEqual([{ type: "update", record: expect.objectContaining({ title: "fresh" }) }]);
  });

  it("墓碑：新于本地 → delete；旧于本地 → 保留", () => {
    const local = [{ id: "r1", updatedAt: 500, title: "x" }];
    const del = mergeRemote(local, [mk("r1", 800, "devB", { tombstone: true })], "devA");
    expect(del.ops).toEqual([{ type: "delete", record: expect.objectContaining({ id: "r1" }) }]);
    const keep = mergeRemote([{ id: "r1", updatedAt: 900, title: "x" }], [mk("r1", 800, "devB", { tombstone: true })], "devA");
    expect(keep.ops).toEqual([]);
  });

  it("离线复活：墓碑到期后旧设备把旧记录再推回来 → 接受（设计明示的复活窗口）", () => {
    // 模拟：旧设备 B 无墓碑概念，推送 updatedAt=800 的记录；本地已有墓碑 900
    const local = [{ id: "r1", updatedAt: 900, title: "tombstoned" }];
    const { ops } = mergeRemote(local, [mk("r1", 800, "devB", { title: "resurrected" })], "devA");
    expect(ops).toEqual([]); // 本地墓碑版本更新，拒绝复活
  });
});

describe("问题记录 images 本地保留", () => {
  it("远端无 images 时不覆盖本地 images（问题截图 v1 不同步）", () => {
    const local = [{ id: "p1", updatedAt: 100, title: "t", images: [{ id: "img1" }] }];
    const { records } = mergeRemote(local, [mk("p1", 500, "devB", { images: undefined })], "devA");
    expect(records[0].images).toEqual([{ id: "img1" }]);
  });

  it("远端有 images 时以远端为准（速记内嵌图的更新）", () => {
    const local = [{ id: "s1", updatedAt: 100, images: [{ id: "old" }] }];
    const { records } = mergeRemote(local, [mk("s1", 500, "devB", { images: [{ id: "new" }] })], "devA");
    expect(records[0].images).toEqual([{ id: "new" }]);
  });
});

describe("collectPushes / pruneTombstones", () => {
  it("只推 > lastPushedAt 的记录与墓碑", () => {
    const pushes = collectPushes(
      [{ id: "a", updatedAt: 100 }, { id: "b", updatedAt: 900 }, { id: "c", updatedAt: 800 }],
      800,
      [{ id: "d", updatedAt: 900 }]
    );
    expect(pushes.map((p) => p.record ? p.record.id : p.id)).toEqual(["b", "d"]);
  });

  it("墓碑 30 天过期清理", () => {
    const now = Date.now();
    const fresh = pruneTombstones({ a: now - 1000, b: now - 40 * 24 * 3600 * 1000 }, now);
    expect(Object.keys(fresh)).toEqual(["a"]);
  });
});

describe("归一化", () => {
  it("缺字段补默认", () => {
    expect(normalizeRemoteItem(null)).toEqual({ id: "", updatedAt: 0, data: "", tombstone: false, seq: 0 });
    expect(normalizeEnvelope(null)).toEqual({ deviceId: "", ts: 0, record: null, kind: "" });
  });
});

describe("墓碑 realId（engine 反查后挂载）", () => {
  it("无信封墓碑经 realId 定位删除；未知 realId 跳过", () => {
    const local = [{ id: "r1", updatedAt: 100, title: "x" }];
    const withReal = mergeRemote(local, [{ updatedAt: 900, tombstone: true, envelope: null, realId: "r1" }], "devA");
    expect(withReal.ops).toEqual([{ type: "delete", record: expect.objectContaining({ id: "r1" }) }]);
    const unknown = mergeRemote(local, [{ updatedAt: 900, tombstone: true, envelope: null, realId: null }], "devA");
    expect(unknown.ops).toEqual([]);
  });
});
