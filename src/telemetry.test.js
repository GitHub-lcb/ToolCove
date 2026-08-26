import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  newInstallId,
  shouldPrompt,
  mergePromptDecision,
  pendingSnapshot,
  track,
} from "./telemetry.js";

describe("shouldPrompt（不重复询问）", () => {
  it("无 telemetry 字段 / undefined prompted 均视为未询问", () => {
    expect(shouldPrompt({})).toBe(true);
    expect(shouldPrompt({ telemetry: {} })).toBe(true);
    expect(shouldPrompt({ telemetry: { prompted: false } })).toBe(true);
    expect(shouldPrompt(null)).toBe(true);
    expect(shouldPrompt(undefined)).toBe(true);
  });

  it("prompted=true 后不再询问", () => {
    expect(shouldPrompt({ telemetry: { prompted: true, enabled: false } })).toBe(false);
  });
});

describe("mergePromptDecision（同意/拒绝立即落盘语义）", () => {
  it("同意：enabled=true + prompted=true，保留原设置与 installId，不改入参", () => {
    const base = { ui: { density: "compact" }, telemetry: { enabled: false, prompted: false, installId: "abc" } };
    const next = mergePromptDecision(base, true, "abc");
    expect(next.telemetry).toEqual({ enabled: true, prompted: true, installId: "abc" });
    expect(next.ui).toEqual({ density: "compact" });
    expect(base.telemetry.enabled).toBe(false);
  });

  it("拒绝：enabled=false + prompted=true", () => {
    const next = mergePromptDecision({}, false, "new-id");
    expect(next.telemetry.enabled).toBe(false);
    expect(next.telemetry.prompted).toBe(true);
    expect(next.telemetry.installId).toBe("new-id");
  });

  it("缺 installId 时自动生成", () => {
    const next = mergePromptDecision({}, true, undefined);
    expect(typeof next.telemetry.installId).toBe("string");
    expect(next.telemetry.installId.length).toBeGreaterThan(0);
  });
});

describe("newInstallId", () => {
  it("生成匿名 ID（非空且每次不同）", () => {
    const a = newInstallId();
    const b = newInstallId();
    expect(a.length).toBeGreaterThan(5);
    expect(a).not.toBe(b);
  });
});

describe("计数聚合与上限", () => {
  it("track 累加；pendingSnapshot 输出不受污染", () => {
    track("view.toolbox");
    track("view.toolbox");
    track("tool.json");
    const snap = pendingSnapshot();
    expect(snap).toEqual([
      { key: "view.toolbox", count: 2 },
      { key: "tool.json", count: 1 },
    ]);
    snap[0].count = 999;
    expect(pendingSnapshot()[0].count).toBe(2);
  });

  it("非法 key 忽略（不影响已有计数）", () => {
    track("view.home");
    const before = pendingSnapshot();
    track(null);
    track("");
    track(42);
    expect(pendingSnapshot()).toEqual(before);
  });
});

describe("Tauri 环境集成（mock invoke）", () => {
  beforeEach(() => {
    globalThis.window = { __TAURI_INTERNALS__: true };
    globalThis.localStorage = {
      _s: {},
      getItem(k) { return k in this._s ? this._s[k] : null; },
      setItem(k, v) { this._s[k] = String(v); },
      removeItem(k) { delete this._s[k]; },
    };
  });
  afterEach(() => {
    delete globalThis.window;
    delete globalThis.localStorage;
    vi.resetModules();
  });

  it("getConfig 读取 settings 并归一（旧数据缺字段补默认）", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: vi.fn(async (cmd) => (cmd === "load_data" ? {} : {})),
    }));
    const { getConfig } = await import("./telemetry.js");
    const cfg = await getConfig();
    expect(cfg).toEqual({ enabled: false, prompted: false, installId: null });
  });

  it("禁用时 flush 不调用 telemetry_submit", async () => {
    const invokeMock = vi.fn(async (cmd) => (cmd === "load_data" ? {} : {}));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
    const mod = await import("./telemetry.js");
    mod.track("view.toolbox");
    await mod.flush();
    expect(invokeMock).not.toHaveBeenCalledWith("telemetry_submit", expect.anything());
  });

  it("启用时 flush 发送并清空缓冲", async () => {
    const invokeMock = vi.fn(async (cmd) => {
      if (cmd === "load_data") return { telemetry: { enabled: true, prompted: true, installId: "i1" } };
      return {};
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
    const mod = await import("./telemetry.js");
    mod.track("view.toolbox");
    mod.track("view.toolbox");
    await mod.flush();
    expect(invokeMock).toHaveBeenCalledWith("telemetry_submit", expect.objectContaining({ events: expect.any(Array) }));
    expect(mod.pendingSnapshot()).toEqual([]);
  });
  it("consent 立即保存（save_data 路径与表单分离）", async () => {
    const invokeMock = vi.fn(async (cmd) => {
      if (cmd === "load_data") return {};
      if (cmd === "save_data") return { ok: true };
      return {};
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
    const { consent } = await import("./telemetry.js");
    await consent(true);
    expect(invokeMock).toHaveBeenCalledWith(
      "save_data",
      expect.objectContaining({
        key: "settings",
        data: expect.objectContaining({ telemetry: expect.objectContaining({ enabled: true, prompted: true }) }),
      })
    );
    vi.resetModules();
  });
});