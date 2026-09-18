import { describe, expect, it } from "vitest";
import { buildAgentRegistry, listAgentTools, resolveRunOptions } from "./tools.js";
import { AGENT_MAX_STEPS_HARD_CAP, AGENT_MAX_RETRIES } from "../settingsConfig.js";

describe("resolveRunOptions", () => {
  it("缺省配置落到 12 步 / 1 次重试 / risky 确认", () => {
    expect(resolveRunOptions(null)).toEqual({ maxSteps: 12, retries: 1, requireConfirmation: "risky" });
    expect(resolveRunOptions({})).toEqual({ maxSteps: 12, retries: 1, requireConfirmation: "risky" });
  });

  it("非法值一律落回默认，不改写设置文件", () => {
    const cfg = { maxSteps: -3, retries: 2.5, requireConfirmation: "sometimes" };
    expect(resolveRunOptions(cfg)).toEqual({ maxSteps: 12, retries: 1, requireConfirmation: "risky" });
  });

  it("钳到硬上限，用户手改 settings 也绕不过", () => {
    expect(resolveRunOptions({ maxSteps: 999, retries: 99 }).maxSteps).toBe(AGENT_MAX_STEPS_HARD_CAP);
    expect(resolveRunOptions({ maxSteps: 999, retries: 99 }).retries).toBe(AGENT_MAX_RETRIES);
  });

  it("三种确认策略都合法，含从不确认", () => {
    for (const mode of ["risky", "always", "never"]) {
      expect(resolveRunOptions({ requireConfirmation: mode }).requireConfirmation).toBe(mode);
    }
  });
});

describe("buildAgentRegistry / listAgentTools", () => {
  it("默认包含全部内置工具，且都可执行", async () => {
    const registry = await buildAgentRegistry(null);
    const names = registry.list().map((t) => t.name);
    expect(names).toContain("json.parse");
    expect(names).toContain("file.write_text");
    expect(names).toContain("db.query_readonly");
    expect(typeof registry.get("file.write_text").execute).toBe("function");
  });

  it("停用清单把工具从 registry 移除，能力清单同步反映", async () => {
    const cfg = { disabledTools: ["base64.encode", "file.write_text"] };
    const names = (await buildAgentRegistry(cfg)).list().map((t) => t.name);
    expect(names).not.toContain("base64.encode");
    expect(names).not.toContain("file.write_text");
    const listed = listAgentTools(cfg);
    expect(listed).toHaveLength(names.length + 2);
    expect(listed.find((t) => t.name === "base64.encode").enabled).toBe(false);
    expect(listed.find((t) => t.name === "json.parse").enabled).toBe(true);
  });

  it("能力清单是同步的，且不依赖工具实现（首屏不带 luxon 等重依赖）", () => {
    // listAgentTools 只读 catalog：这里不 await、也不触发动态 import
    const item = listAgentTools(null).find((t) => t.name === "json.parse");
    expect(item).toMatchObject({ risk: "transform", descriptionKey: "agent.toolJsonParse", toolKey: "json", enabled: true });
    expect(item.execute).toBeUndefined();
  });
});
