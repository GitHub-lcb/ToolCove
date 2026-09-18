// 目录 ↔ 实现一致性：这次分层（catalog 纯元数据 / executors 实现）唯一的安全网。
//
// 为什么必须有：目录要在首屏被同步读取（设置归一化、能力面板），实现按需加载。
// 两边一旦漂移，「目录里说有、实际没有」会让规划器选中一个注定失败的工具，
// 而这类问题在单测里不报错、只在实际跑 Agent 时炸——所以在这里逐项强制。
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_CATALOG, AGENT_TOOL_BY_NAME, AGENT_TOOL_NAMES } from "./catalog.js";
import { BUILTIN_TOOL_IMPLS } from "./executors.js";
import { createDataTools } from "./dataTools.js";
import { allTools, buildAgentRegistry, listAgentTools, resolveRunOptions } from "./tools.js";

const dataTools = Object.fromEntries(createDataTools().map((tool) => [tool.name, tool]));

describe("目录与实现的一致性", () => {
  it("目录里的每个工具都能找到实现", () => {
    const impls = { ...BUILTIN_TOOL_IMPLS, ...dataTools };
    for (const meta of AGENT_TOOL_CATALOG) {
      expect(impls[meta.name], `缺少实现：${meta.name}`).toBeDefined();
      expect(typeof impls[meta.name].execute, `${meta.name} 的 execute 应是函数`).toBe("function");
    }
  });

  it("实现里没有目录之外的多余工具（否则规划器看不到它，等于白写）", () => {
    const implNames = [...Object.keys(BUILTIN_TOOL_IMPLS), ...Object.keys(dataTools)].sort();
    expect(implNames).toEqual([...AGENT_TOOL_NAMES].sort());
  });

  it("风险分级与开关标记在两边一致（不一致会让确认门禁失效）", async () => {
    const assembled = new Map((await allTools()).map((tool) => [tool.name, tool]));
    for (const meta of AGENT_TOOL_CATALOG) {
      const tool = assembled.get(meta.name);
      expect(tool.risk, `${meta.name} 的 risk`).toBe(meta.risk);
      // 这几个标记决定「要不要问人 / 要不要先预览 / 能不能重试 / 各端是否可见」，必须同源
      expect(!!tool.desktopOnly, `${meta.name} 的 desktopOnly`).toBe(!!meta.desktopOnly);
      expect(!!tool.previewBefore, `${meta.name} 的 previewBefore`).toBe(!!meta.previewBefore);
      expect(!!tool.concurrencySafe, `${meta.name} 的 concurrencySafe`).toBe(!!meta.concurrencySafe);
      expect(tool.confirm, `${meta.name} 的 confirm`).toBe(meta.confirm);
      expect(tool.retryable, `${meta.name} 的 retryable`).toBe(meta.retryable);
    }
  });

  it("目录本身没有重复名字与非法风险级别", () => {
    expect(AGENT_TOOL_NAMES.length).toBe(new Set(AGENT_TOOL_NAMES).size);
    for (const meta of AGENT_TOOL_CATALOG) {
      expect(["read", "transform", "write", "database"], meta.name).toContain(meta.risk);
      expect(meta.description?.length, `${meta.name} 的 description`).toBeGreaterThan(0);
    }
  });

  it("name → 元数据索引覆盖全部工具", () => {
    expect(AGENT_TOOL_BY_NAME.size).toBe(AGENT_TOOL_CATALOG.length);
    expect(AGENT_TOOL_BY_NAME.get("file.write_text").previewBefore).toBe(true);
    expect(AGENT_TOOL_BY_NAME.get("data.remove").confirm).toBe("always");
  });
});

describe("首屏可用的同步接口", () => {
  it("listAgentTools 不需要实现层就能给出清单（这是分层的意义）", () => {
    const list = listAgentTools(null);
    expect(list.length).toBeGreaterThan(20);
    expect(list[0]).toMatchObject({ name: expect.any(String), risk: expect.any(String), enabled: true });
    // 只读目录：不该带 execute
    expect(list[0].execute).toBeUndefined();
  });

  it("停用清单照旧生效", () => {
    const list = listAgentTools({ disabledTools: ["json.parse"] });
    expect(list.find((t) => t.name === "json.parse").enabled).toBe(false);
  });

  it("resolveRunOptions 仍是同步的（只读 config）", () => {
    expect(resolveRunOptions(null)).toEqual({ maxSteps: 12, retries: 1, requireConfirmation: "risky" });
  });
});

describe("按需装配", () => {
  it("buildAgentRegistry 给出带 execute 的完整工具", async () => {
    const registry = await buildAgentRegistry(null);
    const tool = registry.get("json.parse");
    expect(typeof tool.execute).toBe("function");
    expect(await tool.execute({ text: '{"a":1}' })).toEqual({ a: 1 });
  });

  it("多次装配复用同一份实现（动态 import 只解析一次）", async () => {
    const [first, second] = await Promise.all([allTools(), allTools()]);
    expect(first.map((t) => t.name)).toEqual(second.map((t) => t.name));
  });
});
