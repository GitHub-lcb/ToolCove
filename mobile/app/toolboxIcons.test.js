// 手机端工具箱的图标必须与桌面端注册表**一致**。
//
// 这条守住的是一个具体退化：手机端原本一个图标都没有，后来补图标时
// 在 mobile/app/toolbox.js 里写死了一份映射。若桌面端改图标 / 加工具而手机端
// 没跟着改，两端慢慢对不上——而这种对不上不会有任何测试变红。
//
// 桌面注册表现在就是工具契约（src/contracts/，每个工具一份 UI 元数据 + Agent 动作声明）。
// 契约是纯数据模块（零依赖），vitest 与原生 Node ESM 都能直接 import——
// 所以这里不再像早年那样正则解析源码文本（那个写法曾经因为
// src/toolboxTools.js 顶部 import i18n→JSON、原生 Node 加载不了而被迫存在，
// 且正则本身会悄悄烂掉；真实 import 两样都不占）。
import { describe, it, expect } from "vitest";
import { TOOL_CONTRACTS } from "../../src/contracts/index.js";
import { TOOLBOX_GROUPS } from "../../src/contracts/groups.js";
import { TOOLS, TOOL_GROUPS, iconOfTool, iconOfGroup } from "./toolbox.js";

const DESKTOP_ICONS = new Map(TOOL_CONTRACTS.map((c) => [c.key, c.ui?.icon]));
const DESKTOP_GROUP_ICONS = new Map(TOOLBOX_GROUPS.map((g) => [g.key, g.icon]));

describe("手机端工具箱的图标与桌面注册表一致", () => {
  it("能从桌面注册表解析出图标（防止映射来源失效却空转通过）", () => {
    expect(DESKTOP_ICONS.size, "没解析到任何桌面图标").toBeGreaterThan(20);
    expect(DESKTOP_GROUP_ICONS.size, "没解析到任何分组图标").toBeGreaterThan(4);
    for (const icon of DESKTOP_ICONS.values()) expect(icon, "契约里有工具缺 ui.icon").toBeTruthy();
    // 抽查两个已知值，确认映射位置正确
    expect(DESKTOP_ICONS.get("json")).toBe("braces");
    expect(DESKTOP_ICONS.get("time")).toBe("clock");
  });

  it("每个手机端工具的图标名与桌面端逐条相同", () => {
    const wrong = [];
    for (const tool of TOOLS) {
      const desktop = DESKTOP_ICONS.get(tool.key);
      if (!desktop) {
        wrong.push(`${tool.key}: 桌面注册表里没有这个 key`);
      } else if (iconOfTool(tool) !== desktop) {
        wrong.push(`${tool.key}: 手机端 ${iconOfTool(tool)} ≠ 桌面端 ${desktop}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("每个手机端分组的图标名与桌面端逐条相同", () => {
    const wrong = [];
    for (const group of TOOL_GROUPS) {
      const desktop = DESKTOP_GROUP_ICONS.get(group.key);
      if (!desktop) {
        wrong.push(`${group.key}: 桌面注册表里没有这个分组`);
      } else if (iconOfGroup(group) !== desktop) {
        wrong.push(`${group.key}: 手机端 ${iconOfGroup(group)} ≠ 桌面端 ${desktop}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("解析不出图标名时走兜底，不返回 undefined（否则渲染空白 SVG）", () => {
    for (const tool of TOOLS) {
      expect(typeof iconOfTool(tool)).toBe("string");
      expect(iconOfTool(tool).length).toBeGreaterThan(0);
    }
    expect(iconOfTool({ key: "__不存在的工具__" })).toBe("wrench");
    expect(iconOfGroup({ key: "__不存在的分组__" })).toBe("wrench");
    expect(iconOfTool(undefined)).toBe("wrench");
    expect(iconOfGroup(undefined)).toBe("wrench");
  });
});
