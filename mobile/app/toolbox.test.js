import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS, TOOL_BY_KEY, TOOL_GROUPS, progressOf, toolsOfGroup } from "./toolbox.js";

describe("手机端工具箱目录", () => {
  it("每个工具的分组都在已定义的分组里（写错分组会让它在界面上消失）", () => {
    const known = new Set(TOOL_GROUPS.map((g) => g.key));
    for (const tool of TOOLS) expect(known.has(tool.group), `${tool.key} 的分组 ${tool.group} 未定义`).toBe(true);
  });

  it("key 不重复，且能按 key 取回同一条", () => {
    const keys = TOOLS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tool of TOOLS) expect(TOOL_BY_KEY[tool.key]).toBe(tool);
  });

  it("每个分组都有工具（空分组会在界面上留下一片空白）", () => {
    for (const group of TOOL_GROUPS) expect(toolsOfGroup(group.key).length, `${group.key} 是空的`).toBeGreaterThan(0);
  });

  it("工具箱已全部迁移完成，没有未迁移项", () => {
    // 这条用例原本是「未迁移的必须带降级说明」，随着工具逐个迁移，它按自己的提示
    // 变成了现在这条：**断言全部可用**。这样"迁移完成"是一个被测试守住的事实，
    // 而不是靠人记得。
    const pending = TOOLS.filter((tool) => !tool.ready);
    expect(pending.map((tool) => tool.key), "还有未迁移的工具").toEqual([]);
    expect(progressOf().ready).toBe(TOOLS.length);
  });

  it("工具清单与桌面端一一对应（防漏：少一个工具就是功能没对齐）", () => {
    // 为什么要读桌面端的注册表：手机端目录是手写的，**漏掉一个工具不会有任何报错**——
    // 界面上只是少一个入口。实际发生过：15 个工具里漏了「AI 对话」，
    // 而我当时按自己目录里的条数报成了"14/14 满格"。这条断言就是为了不再发生。
    const desktop = readFileSync(resolve(process.cwd(), "src/toolboxTools.js"), "utf8");
    const desktopKeys = [...desktop.matchAll(/key:\s*"([a-z]+)",\s*\n?\s*labelKey:\s*"toolbox\.registry\.tool/g)].map((m) => m[1]);
    expect(desktopKeys.length, "桌面端注册表没解析出来，正则要跟着改").toBeGreaterThan(10);

    const mobileKeys = TOOLS.map((tool) => tool.key);
    const missing = desktopKeys.filter((key) => !mobileKeys.includes(key));
    expect(missing, `手机端缺少工具：${missing.join(", ")}`).toEqual([]);
    // 反过来也不该多出桌面端没有的工具（那说明名字写错了）
    const extra = mobileKeys.filter((key) => !desktopKeys.includes(key));
    expect(extra, `手机端多出工具：${extra.join(", ")}`).toEqual([]);
  });

  it("已迁移但能力受限的工具仍要带说明（可用 ≠ 和桌面一样）", () => {
    // 网络（TCP 降级）、文件（SAF 语义）、数据库（只有 SQLite）、标签（无 RAW 打印队列）
    // 这四类在手机端都可用，但与桌面端不完全等价，说明必须留着。
    for (const key of ["network", "file", "db", "label"]) {
      const tool = TOOL_BY_KEY[key];
      expect(tool.ready, `${key} 应已可用`).toBe(true);
      expect(tool.note, `${key} 缺少能力差异说明`).toBeTruthy();
    }
  });

  it("部分降级的工具（已可用但能力受限）也要带说明", () => {
    // 网络诊断就是这种：URL/CIDR/UA 三块完全可用，端口检测是降级实现——
    // 「可用」与「和桌面一样」不是一回事，note 就是用来交代这个差别的
    const network = TOOL_BY_KEY.network;
    expect(network.ready).toBe(true);
    expect(network.note, "部分降级的能力必须写清差别").toBeTruthy();
  });

  it("未迁移的工具不该被当成可用", () => {
    for (const tool of TOOLS.filter((t) => t.ready === false)) {
      expect(tool.note, `${tool.key} 未迁移却没有说明`).toBeTruthy();
    }
  });

  it("进度按已可用数量计算", () => {
    expect(progressOf([])).toEqual({ ready: 0, total: 0, pct: 0 });
    expect(progressOf([{ ready: true }, { ready: false }])).toEqual({ ready: 1, total: 2, pct: 50 });
    // 真实清单：至少有一个已可用（否则说明清单写错了）
    expect(progressOf().ready).toBeGreaterThan(0);
  });

  it("toolsOfGroup 保持清单顺序（新增工具后这里要同步，否则界面顺序会漂）", () => {
    expect(toolsOfGroup("data").map((t) => t.key)).toEqual(["json", "markdown", "table", "convert", "diff", "time"]);
    expect(toolsOfGroup("development").map((t) => t.key)).toEqual(["crypto", "generator", "db"]);
    expect(toolsOfGroup("network").map((t) => t.key)).toEqual(["request", "network"]);
    expect(toolsOfGroup("game").map((t) => t.key)).toEqual(["rail"]);
  });
});
