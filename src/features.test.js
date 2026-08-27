import { describe, it, expect } from "vitest";
import { PRO_FEATURES, isFeatureEnabled, proLockHint, proFeatureKeys } from "./features.js";

describe("PRO_FEATURES 注册表", () => {
  it("首批锁定 2 个真实功能", () => {
    expect(proFeatureKeys()).toEqual(["db-export-xlsx", "theme-custom", "cloud-sync"]);
    for (const [key, meta] of Object.entries(PRO_FEATURES)) {
      expect(typeof meta.labelKey).toBe("string");
      expect(typeof meta.descKey).toBe("string");
    }
  });
});

describe("isFeatureEnabled 开关矩阵", () => {
  it("免费态/未激活一律 false", () => {
    expect(isFeatureEnabled(null, "db-export-xlsx")).toBe(false);
    expect(isFeatureEnabled({ pro: false }, "db-export-xlsx")).toBe(false);
    expect(isFeatureEnabled(undefined, "db-export-xlsx")).toBe(false);
  });

  it("激活但 features 未含该功能 → false", () => {
    const s = { pro: true, features: ["theme-custom"] };
    expect(isFeatureEnabled(s, "db-export-xlsx")).toBe(false);
    expect(isFeatureEnabled(s, "theme-custom")).toBe(true);
  });

  it("features 缺失/非数组 → false", () => {
    expect(isFeatureEnabled({ pro: true }, "theme-custom")).toBe(false);
    expect(isFeatureEnabled({ pro: true, features: "x" }, "theme-custom")).toBe(false);
  });

  it("全部功能启用 → true", () => {
    const s = { pro: true, features: ["db-export-xlsx", "theme-custom"] };
    expect(isFeatureEnabled(s, "db-export-xlsx")).toBe(true);
    expect(isFeatureEnabled(s, "theme-custom")).toBe(true);
  });
});

describe("proLockHint", () => {
  it("返回通用锁定提示键（工具窗口含主窗口导航指引）", () => {
    expect(proLockHint()).toBe("license.lockHint");
  });
});
