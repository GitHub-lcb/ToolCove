// 手机端工具箱的图标必须与桌面端注册表**一致**。
//
// 这条守住的是一个具体退化：手机端原本一个图标都没有，后来补图标时
// 在 mobile/app/toolbox.js 里写死了一份映射。若桌面端改图标 / 加工具而手机端
// 没跟着改，两端慢慢对不上——而这种对不上不会有任何测试变红。
//
// 为什么用「读源码文本」而不是 import 桌面注册表：
//   `src/toolboxTools.js` 顶部 import 了 `i18n/index.js` → 进而 import JSON 词条。
//   而 `e2e/helpers.js:579` 用**原生 Node ESM loader** 直接 import `mobile/app/toolbox.js`
//   来比对两端工具清单；一旦本文件再 import 桌面注册表，Node 认不了 Vite 的 JSON 插件，
//   整个 Playwright 套件会在收集用例时就崩掉（Total: 0 tests in 0 files）。
//   ——这个坑已经踩过一次，所以这里刻意只读文本，不建立运行时依赖。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_GROUPS, iconOfTool, iconOfGroup } from "./toolbox.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const desktopSource = fs.readFileSync(path.join(ROOT, "src/toolboxTools.js"), "utf8");

/** 从桌面注册表源码里抽出 `{ key: "icon" }` 映射（只认 tools/groups 两段的单行写法） */
function desktopIconMap() {
  const map = new Map();
  for (const m of desktopSource.matchAll(/key:\s*"([a-z]+)"[^}]*?icon:\s*"([a-z-]+)"/g)) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  return map;
}

const DESKTOP_ICONS = desktopIconMap();
const DESKTOP_GROUP_ICONS = new Map(
  [...desktopSource.matchAll(/key:\s*"([a-z]+)",\s*labelKey:\s*"toolbox\.registry\.group[^"]*",\s*icon:\s*"([a-z-]+)"/g)].map(
    (m) => [m[1], m[2]],
  ),
);

describe("手机端工具箱的图标与桌面注册表一致", () => {
  it("能从桌面注册表源码里解析出图标（防止上面的正则写失效却空转通过）", () => {
    expect(DESKTOP_ICONS.size, "没解析到任何桌面图标，正则可能失效").toBeGreaterThan(20);
    expect(DESKTOP_GROUP_ICONS.size, "没解析到任何分组图标").toBeGreaterThan(4);
    // 抽查两个已知值，确认解析位置正确
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