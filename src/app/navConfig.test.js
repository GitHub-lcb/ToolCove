// 导航分层纯函数单测：旧 key → 新坐标映射、导航目标解析、hiddenModules 迁移
import { describe, it, expect } from "vitest";
import {
  NAV_MODULES,
  MODULE_TABS,
  MODULE_HOME_TAB,
  LEGACY_VIEW_TARGET,
  resolveNavTarget,
  migrateHiddenModulesV1,
} from "./navConfig.js";

describe("导航配置", () => {
  it("侧边栏四项 + 设置；每项的 labelKey 均非空", () => {
    expect(NAV_MODULES.map((m) => m.key)).toEqual(["agent", "work", "records", "toolbox"]);
    for (const m of NAV_MODULES) expect(m.labelKey).toMatch(/^nav\./);
  });

  it("旧十视图 key 全部有落点：work 六 Tab、records 两 Tab", () => {
    expect(Object.keys(LEGACY_VIEW_TARGET).sort()).toEqual([
      "domain",
      "home",
      "iteration",
      "problem",
      "release",
      "requirement",
      "snippet",
      "task",
    ]);
    expect(MODULE_TABS.work.map((t) => t.key)).toEqual(["overview", "domain", "iteration", "requirement", "release", "task"]);
    expect(MODULE_TABS.records.map((t) => t.key)).toEqual(["snippet", "problem"]);
    // 每个旧 key 的落点必须真实存在于 Tab 列表
    for (const { module, tab } of Object.values(LEGACY_VIEW_TARGET)) {
      expect(MODULE_TABS[module].some((t) => t.key === tab)).toBe(true);
    }
    // 默认 Tab 也在 Tab 列表内
    for (const [module, tab] of Object.entries(MODULE_HOME_TAB)) {
      expect(MODULE_TABS[module].some((t) => t.key === tab)).toBe(true);
    }
  });
});

describe("resolveNavTarget", () => {
  it("旧视图 key 解析为 模块+Tab（深链兼容）", () => {
    expect(resolveNavTarget({ module: "iteration", id: "x" })).toEqual({ module: "work", tab: "iteration" });
    expect(resolveNavTarget({ module: "snippet" })).toEqual({ module: "records", tab: "snippet" });
    expect(resolveNavTarget({ module: "home" })).toEqual({ module: "work", tab: "overview" });
  });

  it("新坐标原样解析；非法 Tab 落回模块默认 Tab", () => {
    expect(resolveNavTarget({ module: "work", tab: "release" })).toEqual({ module: "work", tab: "release" });
    expect(resolveNavTarget({ module: "records", tab: "不存在" })).toEqual({ module: "records", tab: "snippet" });
    expect(resolveNavTarget({ module: "work" })).toEqual({ module: "work", tab: "overview" });
  });

  it("无 Tab 模块与设置模块 tab 为 null", () => {
    expect(resolveNavTarget({ module: "agent" })).toEqual({ module: "agent", tab: null });
    expect(resolveNavTarget({ module: "toolbox", tab: "snippet" })).toEqual({ module: "toolbox", tab: null });
    expect(resolveNavTarget({ module: "settings" })).toEqual({ module: "settings", tab: null });
  });

  it("未知模块返回 null（调用方忽略，不误切视图）", () => {
    expect(resolveNavTarget({ module: "nope" })).toBeNull();
    expect(resolveNavTarget({})).toBeNull();
    expect(resolveNavTarget(null)).toBeNull();
  });
});

describe("migrateHiddenModulesV1", () => {
  it("旧 key 归并到新模块，去重且保序", () => {
    expect(migrateHiddenModulesV1(["domain", "snippet"])).toEqual(["work", "records"]);
    expect(migrateHiddenModulesV1(["domain", "iteration", "release"])).toEqual(["work"]);
    expect(migrateHiddenModulesV1(["snippet", "problem", "domain"])).toEqual(["records", "work"]);
  });

  it("仍是合法模块的旧 key（agent/toolbox）语义不变", () => {
    expect(migrateHiddenModulesV1(["toolbox", "agent"])).toEqual(["toolbox", "agent"]);
  });

  it("幂等：已迁移的值重复跑结果不变；脏值丢弃；非数组原样返回", () => {
    const once = migrateHiddenModulesV1(["domain", "problem"]);
    expect(migrateHiddenModulesV1(once)).toEqual(once);
    expect(migrateHiddenModulesV1(["legacy", 3, null, "task"])).toEqual(["work"]);
    expect(migrateHiddenModulesV1(null)).toBeNull();
    expect(migrateHiddenModulesV1(undefined)).toBeUndefined();
  });
});
