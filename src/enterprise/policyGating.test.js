// 企业权限门禁接进投影：企业态按 policy 过滤画廊与 Agent 目录；个人版完全不受影响。
// 与 editionGating.test.js 同款：注册表 / 投影在调用时读取版本与策略，需要 resetModules 后
// 动态导入才能拿到另一版本分支。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function stubEdition(value) {
  vi.resetModules();
  vi.stubGlobal("__TOOLCOVE_EDITION__", value);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("个人版不受策略影响", () => {
  it("禁用 db / 设风险上限后，画廊与 Agent 目录照旧", async () => {
    const store = await import("./policyStore.js");
    store.setPolicy({ disabledTools: ["db"], maxRisk: "transform" });

    const { visibleToolboxTools } = await import("../toolboxTools.js");
    expect(visibleToolboxTools().map((tool) => tool.key)).toContain("db");

    const { listAgentTools } = await import("../agent/tools.js");
    const names = listAgentTools(null).map((tool) => tool.name);
    expect(names).toContain("db.query_readonly");
    expect(names).toContain("file.write_text");
  });
});

describe("企业态按策略过滤", () => {
  it("禁用工具：画廊与 Agent 目录都过滤掉该工具及其动作", async () => {
    stubEdition("enterprise");
    const store = await import("./policyStore.js");
    store.setPolicy({ disabledTools: ["db"], maxRisk: null });

    const { visibleToolboxTools } = await import("../toolboxTools.js");
    const keys = visibleToolboxTools().map((tool) => tool.key);
    expect(keys).not.toContain("db");
    expect(keys).toContain("json");

    const { buildAgentRegistry, listAgentTools } = await import("../agent/tools.js");
    const registryNames = (await buildAgentRegistry(null)).list().map((tool) => tool.name);
    expect(registryNames).not.toContain("db.query_readonly");
    expect(registryNames).toContain("json.parse");
    const listed = listAgentTools(null).map((tool) => tool.name);
    expect(listed).not.toContain("db.query_readonly");
    expect(listed).toEqual(registryNames);
  });

  it("风险上限：剔除超过上限的动作（database / write），保留 read / transform", async () => {
    stubEdition("enterprise");
    const store = await import("./policyStore.js");
    store.setPolicy({ disabledTools: [], maxRisk: "read" });

    const { listAgentTools } = await import("../agent/tools.js");
    const names = listAgentTools(null).map((tool) => tool.name);
    expect(names).not.toContain("file.write_text"); // write
    expect(names).not.toContain("db.query_readonly"); // database
    expect(names).toContain("file.read_text"); // read
    expect(names).toContain("json.parse"); // transform

    const registryNames = (await (await import("../agent/tools.js")).buildAgentRegistry(null)).list().map((tool) => tool.name);
    expect(registryNames).not.toContain("file.write_text");
    expect(registryNames).toContain("json.parse");
  });

  it("空策略（未配置）＝不限制，与个人版行为一致", async () => {
    stubEdition("enterprise");
    await import("./policyStore.js"); // 不 setPolicy

    const { visibleToolboxTools } = await import("../toolboxTools.js");
    expect(visibleToolboxTools().map((tool) => tool.key)).toContain("db");
    const { listAgentTools } = await import("../agent/tools.js");
    expect(listAgentTools(null).map((tool) => tool.name)).toContain("db.query_readonly");
  });
});
