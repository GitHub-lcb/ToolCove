// toolboxStore.js 单测：浏览器降级读写、Tauri 资产落盘、防抖合并、旧数据迁移、读写顺序
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { loadToolbox, saveToolbox, saveToolboxNow, flushToolbox } from "./toolboxStore.js";

// node 环境无 localStorage，提供内存 mock（同 db.test.js 模式）
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// 模拟后端：save_data 写入 Map，load_data 返回写入值（不存在返回 []，与 Rust 行为一致）
let backend = new Map();
invoke.mockImplementation((cmd, args) => {
  if (cmd === "save_data") {
    backend.set(args.key, args.data);
    return Promise.resolve();
  }
  if (cmd === "load_data") {
    return Promise.resolve(backend.get(args.key) || []);
  }
  return Promise.resolve();
});

beforeEach(() => {
  mem.clear();
  backend.clear();
  vi.clearAllMocks();
});

describe("浏览器降级（非 Tauri）", () => {
  it("无旧数据返回默认值", async () => {
    expect(await loadToolbox("k", { x: 1 })).toEqual({ x: 1 });
    expect(await loadToolbox("k", [])).toEqual([]);
  });

  it("读写往返与损坏回退", async () => {
    saveToolbox("k", { a: 1 });
    expect(await loadToolbox("k", null)).toEqual({ a: 1 });
    mem.set("toolbox-k", "{bad json");
    expect(await loadToolbox("k", { d: 1 })).toEqual({ d: 1 });
  });

  it("不调用后端命令", async () => {
    await loadToolbox("k", null);
    saveToolbox("k", 1);
    await flushToolbox();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("浏览器读写失败调用 onError", async () => {
    const originalSet = localStorage.setItem;
    const onSaveError = vi.fn();
    localStorage.setItem = () => { throw new Error("quota"); };
    saveToolbox("quota", { a: 1 }, { onError: onSaveError });
    expect(onSaveError).toHaveBeenCalledWith(expect.objectContaining({
      key: "toolbox-quota",
      phase: "save",
      error: expect.any(Error),
    }));
    localStorage.setItem = originalSet;

    mem.set("toolbox-bad", "{bad");
    const onLoadError = vi.fn();
    expect(await loadToolbox("bad", { safe: true }, { onError: onLoadError })).toEqual({ safe: true });
    expect(onLoadError).toHaveBeenCalledWith(expect.objectContaining({
      key: "toolbox-bad",
      phase: "load",
      error: expect.any(Error),
    }));
  });
});

describe("Tauri 资产存储", () => {
  beforeEach(() => {
    globalThis.window = { __TAURI_INTERNALS__: {} };
  });
  afterEach(() => {
    delete globalThis.window;
  });

  it("后端无数据且无旧值：返回默认值且不写盘", async () => {
    const v = await loadToolbox("k", { d: 1 });
    expect(v).toEqual({ d: 1 });
    expect(invoke).toHaveBeenCalledTimes(1); // 仅 load_data
    expect(invoke).toHaveBeenCalledWith("load_data", { key: "toolbox-k" });
  });

  it("后端有资产数据：直接返回并跳过迁移", async () => {
    backend.set("toolbox-k", { v: { saved: true } });
    mem.set("toolbox-k", JSON.stringify({ legacy: true })); // 残留旧值不覆盖资产
    const v = await loadToolbox("k", null);
    expect(v).toEqual({ saved: true });
    expect(invoke).not.toHaveBeenCalledWith("save_data", expect.anything());
  });

  it("迁移旧 localStorage 数据：写回后端并清除旧值", async () => {
    mem.set("toolbox-k", JSON.stringify({ a: 1, b: [2, 3] }));
    const v = await loadToolbox("k", null);
    expect(v).toEqual({ a: 1, b: [2, 3] });
    expect(invoke).toHaveBeenCalledWith("save_data", { key: "toolbox-k", data: { v: { a: 1, b: [2, 3] } } });
    expect(mem.has("toolbox-k")).toBe(false);
  });



  it("旧数据迁移写入失败时返回已解析草稿并保留旧值", async () => {
    const legacy = { input: '{"legacy":true}', mode: "format" };
    localStorage.setItem("toolbox-json", JSON.stringify(legacy));
    const onError = vi.fn();
    invoke.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("disk"));

    await expect(loadToolbox("json", {}, { onError })).resolves.toEqual(legacy);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      key: "toolbox-json",
      phase: "save",
      error: expect.any(Error),
    }));
    expect(localStorage.getItem("toolbox-json")).toBe(JSON.stringify(legacy));
  });

  it("旧数据损坏时回退默认值且不写盘", async () => {
    mem.set("toolbox-k", "{bad json");
    const v = await loadToolbox("k", { d: 1 });
    expect(v).toEqual({ d: 1 });
    expect(invoke).not.toHaveBeenCalledWith("save_data", expect.anything());
  });

  it("防抖合并：多次写只落盘最后一次", async () => {
    vi.useFakeTimers();
    saveToolbox("k", 1);
    saveToolbox("k", 2);
    saveToolbox("k", 3);
    expect(backend.size).toBe(0); // 防抖窗口内未写
    await vi.advanceTimersByTimeAsync(250);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("save_data", { key: "toolbox-k", data: { v: 3 } });
    vi.useRealTimers();
  });

  it("flushToolbox 立即冲刷指定 key", async () => {
    saveToolbox("k", { x: 1 });
    await flushToolbox("k");
    expect(invoke).toHaveBeenCalledWith("save_data", { key: "toolbox-k", data: { v: { x: 1 } } });
  });

  it("flushToolbox 全量冲刷", async () => {
    saveToolbox("a", 1);
    saveToolbox("b", 2);
    await flushToolbox();
    expect(invoke).toHaveBeenCalledWith("save_data", { key: "toolbox-a", data: { v: 1 } });
    expect(invoke).toHaveBeenCalledWith("save_data", { key: "toolbox-b", data: { v: 2 } });
  });

  it("保存后立即读取：读前冲刷待写值，拿到最新", async () => {
    saveToolbox("k", { draft: "新值" });
    const v = await loadToolbox("k", null);
    expect(v).toEqual({ draft: "新值" });
  });

  it("写入按 key 隔离，互不串扰", async () => {
    saveToolbox("a", "甲");
    saveToolbox("b", "乙");
    await flushToolbox();
    expect(await loadToolbox("a", null)).toBe("甲");
    expect(await loadToolbox("b", null)).toBe("乙");
  });

  it("防抖合并采用最后一次值和回调", async () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const last = vi.fn();
    invoke.mockRejectedValueOnce(new Error("disk"));
    saveToolbox("k", 1, { onError: first });
    saveToolbox("k", 2, { onError: last });
    await vi.advanceTimersByTimeAsync(250);
    await flushToolbox("k");
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledWith(expect.objectContaining({
      key: "toolbox-k",
      phase: "save",
      error: expect.any(Error),
    }));
    vi.useRealTimers();
  });

  it("即时保存返回确定失败结果而 flush 保持兼容", async () => {
    invoke.mockRejectedValueOnce(new Error("disk"));
    await expect(saveToolboxNow("k", { recovery: true })).resolves.toEqual({
      ok: false,
      error: expect.any(Error),
    });
    await expect(flushToolbox("k")).resolves.toEqual({ ok: true, skipped: true });
  });

  it("即时保存取消同 key 未入队 pending", async () => {
    vi.useFakeTimers();
    saveToolbox("k", { value: "old" });
    await expect(saveToolboxNow("k", { value: "recovery" })).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(250);
    expect(backend.get("toolbox-k")).toEqual({ v: { value: "recovery" } });
    expect(invoke).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
