import { describe, expect, it, vi } from "vitest";
import {
  SPILL_INDEX_KEY,
  SPILL_MAX_AGE_MS,
  SPILL_MAX_CHARS,
  SPILL_MAX_ITEMS,
  SPILL_PREFIX,
  createSpillStore,
  pickExpired,
  spillKey,
} from "./spillStore.js";

/** 内存版注入存储：只为把 spill 的治理逻辑单独测清楚，不依赖 toolboxStore/IndexedDB。 */
function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    read: async (key, fallback = null) => (map.has(key) ? map.get(key) : fallback),
    write: async (key, value) => { map.set(key, value); },
    remove: async (key) => { map.set(key, null); },
  };
}

describe("spillKey", () => {
  it("slugs the tool name so a spilled file is recognizable", () => {
    expect(spillKey("db.query_readonly", "abc123")).toBe("spill:db-query-readonly-abc123");
    expect(spillKey("", "abc123")).toBe("spill:result-abc123");
    expect(spillKey("!!!", "x")).toBe("spill:result-x");
  });

  it("generates a unique token when none is given", () => {
    expect(spillKey("file.read_text")).not.toBe(spillKey("file.read_text"));
  });
});

describe("pickExpired", () => {
  const now = 1_000_000_000;
  it("drops anything past the age limit", () => {
    const fresh = { key: "a", createdAt: now - 1000 };
    const old = { key: "b", createdAt: now - SPILL_MAX_AGE_MS - 1 };
    expect(pickExpired([fresh, old], now).map((x) => x.key)).toEqual(["b"]);
  });

  it("keeps only the newest SPILL_MAX_ITEMS", () => {
    const entries = Array.from({ length: SPILL_MAX_ITEMS + 3 }, (_, i) => ({ key: `k${i}`, createdAt: now - i }));
    const expired = pickExpired(entries, now);
    expect(expired).toHaveLength(3);
    expect(expired.map((x) => x.key)).toEqual([`k${SPILL_MAX_ITEMS}`, `k${SPILL_MAX_ITEMS + 1}`, `k${SPILL_MAX_ITEMS + 2}`]);
  });

  it("treats a missing timestamp as ancient", () => {
    expect(pickExpired([{ key: "naked" }], now)).toHaveLength(1);
  });
});

describe("createSpillStore", () => {
  it("saves, reads back and lists", async () => {
    const store = fakeStore();
    const spill = createSpillStore({ store, now: () => 1234 });
    const ref = await spill.save("big text", { tool: "db.query_readonly", random: "r1" });
    expect(ref).toEqual({ key: "spill:db-query-readonly-r1", chars: 8 });
    expect(await spill.read(ref.key)).toBe("big text");
    const list = await spill.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: ref.key, chars: 8, tool: "db.query_readonly", createdAt: 1234 });
  });

  it("sanitizes before writing to disk", async () => {
    const spill = createSpillStore({ store: fakeStore(), sanitize: (text) => text.replace(/hunter2/g, "[REDACTED]") });
    const ref = await spill.save("password=hunter2", { tool: "http.request", random: "r" });
    expect(await spill.read(ref.key)).toBe("password=[REDACTED]");
    expect(ref.chars).toBe("password=[REDACTED]".length);
  });

  it("refuses empty and oversized payloads", async () => {
    const spill = createSpillStore({ store: fakeStore() });
    expect(await spill.save("", {})).toBe(null);
    expect(await spill.save("x".repeat(SPILL_MAX_CHARS + 1), {})).toBe(null);
  });

  it("returns null instead of throwing when the write fails", async () => {
    const store = fakeStore();
    store.write = async () => { throw new Error("disk full"); };
    const spill = createSpillStore({ store });
    await expect(spill.save("data", { tool: "x" })).resolves.toBe(null);
  });

  it("prunes the oldest entry and deletes its body once over the cap", async () => {
    const store = fakeStore();
    let tick = 0;
    const spill = createSpillStore({ store, now: () => (tick += 1000) });
    const keys = [];
    for (let i = 0; i < SPILL_MAX_ITEMS + 2; i++) keys.push((await spill.save(`payload ${i}`, { tool: "t", random: `k${i}` })).key);
    expect(await spill.read(keys[0])).toBe(null); // 正文已删
    expect(await spill.read(keys[keys.length - 1])).toBe(`payload ${SPILL_MAX_ITEMS + 1}`);
    const index = await store.read(SPILL_INDEX_KEY, []);
    expect(index.length).toBe(SPILL_MAX_ITEMS);
    expect(index.map((x) => x.key)).not.toContain(keys[0]);
  });

  it("prunes by age on demand", async () => {
    const store = fakeStore();
    const spill = createSpillStore({ store, now: () => 1000 });
    const ref = await spill.save("old", { tool: "t", random: "a" });
    expect(await spill.prune(1000 + SPILL_MAX_AGE_MS + 1)).toEqual([ref.key]);
    expect(await spill.read(ref.key)).toBe(null);
    expect(await spill.list()).toEqual([]);
  });

  it("clear 清空索引与正文，并如实报告清掉了什么", async () => {
    const store = fakeStore();
    let tick = 0;
    const spill = createSpillStore({ store, now: () => (tick += 1000) });
    const a = await spill.save("aaaa", { tool: "db.query_readonly", random: "a" });
    const b = await spill.save("bb", { tool: "file.read_text", random: "b" });
    const result = await spill.clear();
    expect(result.cleared).toBe(2);
    expect(result.chars).toBe(6);
    expect(result.items).toEqual(expect.arrayContaining([a.key, b.key]));
    expect(await spill.list()).toEqual([]);
    expect(await spill.read(a.key)).toBe(null);
    // 再清一次是幂等的
    expect(await spill.clear()).toEqual({ cleared: 0, chars: 0, items: [] });
  });

  it("clear 之后还能继续写新条目", async () => {
    const store = fakeStore();
    const spill = createSpillStore({ store });
    await spill.save("x", { tool: "t", random: "1" });
    await spill.clear();
    const ref = await spill.save("y", { tool: "t", random: "2" });
    expect(await spill.read(ref.key)).toBe("y");
    expect(await spill.list()).toHaveLength(1);
  });

  it("reports metadata for one key", async () => {    const spill = createSpillStore({ store: fakeStore(), now: () => 777 });
    const ref = await spill.save("abc", { tool: "file.read_text", random: "z" });
    expect(await spill.stat(ref.key)).toEqual({ key: ref.key, chars: 3, tool: "file.read_text", createdAt: 777 });
    expect(await spill.stat("spill:nope")).toBe(null);
  });

  it("treats a body written as null as missing", async () => {
    const store = fakeStore({ [`${SPILL_PREFIX}gone`]: null });
    const spill = createSpillStore({ store });
    expect(await spill.read(`${SPILL_PREFIX}gone`)).toBe(null);
  });

  it("keeps its own namespace inside the store", async () => {
    const store = fakeStore({ "toolbox-somethingElse": { v: 1 } });
    const spill = createSpillStore({ store });
    await spill.save("data", { tool: "t", random: "q" });
    expect(store.map.get("toolbox-somethingElse")).toEqual({ v: 1 });
    expect(await spill.read("toolbox-somethingElse")).toBe(null);
  });

  it("survives a corrupt index", async () => {
    const store = fakeStore({ [SPILL_INDEX_KEY]: "not an array" });
    const spill = createSpillStore({ store });
    expect(await spill.list()).toEqual([]);
    await expect(spill.save("data", { tool: "t", random: "r" })).resolves.toMatchObject({ chars: 4 });
  });
});

describe("spill store defaults", () => {
  it("uses the platform kv when no store is injected", async () => {
    // 只验证「默认路径存在且可调用」：真实存储由 toolboxStore 决定（桌面=应用数据目录，浏览器=IndexedDB）
    const spill = createSpillStore();
    expect(typeof spill.save).toBe("function");
    expect(typeof spill.read).toBe("function");
    expect(vi.isMockFunction(spill.save)).toBe(false);
  });
});
