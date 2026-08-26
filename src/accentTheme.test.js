import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ACCENT_PRESETS,
  ACCENT_VARS,
  resolveAccentPatch,
  applyAccent,
  resetAccent,
  loadAccentKey,
  saveAccentKey,
} from "./accentTheme.js";

describe("预设结构", () => {
  it("3 个预设，每个含 light/dark 补丁且变量齐全", () => {
    expect(ACCENT_PRESETS.map((p) => p.key)).toEqual(["teal", "violet", "amber"]);
    for (const p of ACCENT_PRESETS) {
      expect(typeof p.light).toBe("object");
      expect(typeof p.dark).toBe("object");
      const patchVars = Object.keys(p.light);
      expect(patchVars).toEqual(Object.keys(p.dark));
      for (const v of patchVars) {
        expect(ACCENT_VARS).toContain(v);
        expect(typeof p.light[v]).toBe("string");
        expect(p.light[v].length).toBeGreaterThan(0);
        expect(typeof p.dark[v]).toBe("string");
        expect(p.dark[v].length).toBeGreaterThan(0);
      }
    }
  });
});

describe("resolveAccentPatch", () => {
  it("按主题与系统偏好选补丁", () => {
    expect(resolveAccentPatch("teal", "dark", false)["--primary"]).toContain("2cb0a4");
    expect(resolveAccentPatch("teal", "light", true)["--primary"]).toContain("0d8a7f");
    expect(resolveAccentPatch("teal", "system", true)["--primary"]).toContain("2cb0a4");
    expect(resolveAccentPatch("teal", "system", false)["--primary"]).toContain("0d8a7f");
  });

  it("未知预设返回 null", () => {
    expect(resolveAccentPatch("neon", "light", false)).toBeNull();
  });
});

describe("apply/reset（浏览器环境）", () => {
  let style;
  beforeEach(() => {
    style = {};
    globalThis.document = { documentElement: { style: { setProperty: vi.fn((k, v) => (style[k] = v)), removeProperty: vi.fn((k) => delete style[k]) } } };
  });
  afterEach(() => {
    delete globalThis.document;
  });

  it("applyAccent 设置全部补丁变量", () => {
    expect(applyAccent("amber", "light", false)).toBe(true);
    expect(style["--primary"]).toContain("bc4c00");
    expect(style["--no-such"]).toBeUndefined();
  });

  it("applyAccent 未知预设返回 false 且不写", () => {
    expect(applyAccent("neon", "light", false)).toBe(false);
    expect(style["--primary"]).toBeUndefined();
  });

  it("resetAccent 移除全部覆盖变量", () => {
    applyAccent("violet", "dark", false);
    resetAccent();
    expect(style["--primary"]).toBeUndefined();
  });
});

describe("localStorage 持久化", () => {
  let store;
  beforeEach(() => {
    store = {};
    globalThis.localStorage = {
      getItem: vi.fn((k) => (k in store ? store[k] : null)),
      setItem: vi.fn((k, v) => (store[k] = String(v))),
      removeItem: vi.fn((k) => delete store[k]),
    };
  });
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it("保存与读取往返；未知 key 视为未设置", () => {
    saveAccentKey("teal");
    expect(loadAccentKey()).toBe("teal");
    saveAccentKey("neon");
    expect(loadAccentKey()).toBeNull();
    expect(loadAccentKey()).toBeNull(); // 未设置时
  });
});
