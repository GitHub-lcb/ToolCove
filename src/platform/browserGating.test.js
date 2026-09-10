// 平台门禁：Node 测试环境默认无 window（按桌面处理），这里显式 stub 出
// 「有 window 但无 __TAURI_INTERNALS__」的浏览器态，验证桌面独占能力被正确过滤。
import { afterEach, describe, expect, it, vi } from "vitest";

// 注册表在导入时即读取 isDesktop，必须 resetModules 后重新动态导入才能拿到浏览器分支
function stubBrowser() {
  vi.resetModules();
  vi.stubGlobal("window", {});
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const DESKTOP_ONLY_TOOLS = [
  "db.query_readonly",
  "file.inspect",
  "file.list_directory",
  "file.preview_write",
  "file.read_text",
  "file.write_text",
  "network.dns",
  "network.ping",
  "network.tcp_check",
  "network.trace",
];

describe("平台判定", () => {
  it("无 window 时按桌面处理，既有测试继续走 IPC 分支", async () => {
    const env = await import("./env.js");
    expect(env.isDesktop).toBe(true);
    expect(env.isBrowser).toBe(false);
  });

  it("有 window 但无 __TAURI_INTERNALS__ 时判定为浏览器端", async () => {
    stubBrowser();
    const env = await import("./env.js");
    expect(env.isDesktop).toBe(false);
    expect(env.isBrowser).toBe(true);
    // 桌面独占能力全关，通用能力保留
    expect(env.capabilities.jdbc).toBe(false);
    expect(env.capabilities.localFile).toBe(false);
    expect(env.capabilities.cloudSync).toBe(false);
    expect(env.capabilities.updater).toBe(false);
    expect(env.capabilities.aiRequest).toBe(true);
    expect(env.capabilities.imageStore).toBe(true);
  });

  it("desktopOnly() 抛出带 DESKTOP_ONLY 标记的错误", async () => {
    const env = await import("./env.js");
    const error = env.desktopOnly("db_drivers");
    expect(error.code).toBe("DESKTOP_ONLY");
    expect(error.command).toBe("db_drivers");
  });
});

describe("平台适配层门禁", () => {
  it("浏览器端调用未适配的桌面命令时抛 DESKTOP_ONLY", async () => {
    stubBrowser();
    const { invoke } = await import("./invoke.js");
    await expect(invoke("db_drivers")).rejects.toMatchObject({ code: "DESKTOP_ONLY", command: "db_drivers" });
  });

  it("浏览器端已适配命令走内置实现（无 window.storage 时退化内存）", async () => {
    stubBrowser();
    const { invoke } = await import("./invoke.js");
    await expect(invoke("load_data", { key: "gating-missing" })).resolves.toEqual([]);
    await invoke("save_data", { key: "gating-key", data: { n: 1 } });
    await expect(invoke("load_data", { key: "gating-key" })).resolves.toEqual({ n: 1 });
  });

  it("browserHandlers 不含桌面独占命令", async () => {
    stubBrowser();
    const { browserHandlers } = await import("./invoke.js");
    expect(browserHandlers.db_drivers).toBeUndefined();
    expect(browserHandlers.file_tool_read_text).toBeUndefined();
    expect(browserHandlers.network_ping).toBeUndefined();
  });
});

describe("工具箱注册表平台过滤", () => {
  it("浏览器端隐藏 db/file/network，保留通用工具", async () => {
    stubBrowser();
    const mod = await import("../toolboxTools.js");
    const keys = mod.visibleToolboxTools().map((tool) => tool.key);
    expect(keys).not.toContain("db");
    expect(keys).not.toContain("file");
    expect(keys).not.toContain("network");
    expect(keys).toContain("json");
    expect(keys).toContain("chat");
    expect(keys).toContain("request");
    expect(keys).toContain("image");
    // 画廊分组同样基于过滤后的列表（分组顺序按 category 排列，与声明顺序不同，这里比对集合）
    const grouped = mod.groupToolboxTools(mod.visibleToolboxTools()).flatMap((g) => g.tools.map((tool) => tool.key));
    expect([...grouped].sort()).toEqual([...keys].sort());
  });

  it("桌面端（默认环境）保留全部工具", async () => {
    const mod = await import("../toolboxTools.js");
    const keys = mod.visibleToolboxTools().map((tool) => tool.key);
    expect(keys).toHaveLength(mod.TOOLBOX_TOOLS.length);
    expect(keys).toContain("db");
    expect(keys).toContain("file");
    expect(keys).toContain("network");
  });
});

describe("Agent 工具注册表平台过滤", () => {
  it("浏览器端剔除桌面独占工具，保留通用工具", async () => {
    stubBrowser();
    const { buildAgentRegistry, listAgentTools } = await import("../agent/tools.js");
    const names = buildAgentRegistry(null).list().map((tool) => tool.name);
    for (const name of DESKTOP_ONLY_TOOLS) expect(names).not.toContain(name);
    expect(names).toContain("http.request");
    expect(names).toContain("json.parse");
    expect(names).toContain("image.plan");

    const listed = listAgentTools(null).map((tool) => tool.name);
    for (const name of DESKTOP_ONLY_TOOLS) expect(listed).not.toContain(name);
    expect(listed).toEqual(names);
  });

  it("被剔除的桌面工具在浏览器端不可执行", async () => {
    stubBrowser();
    const { buildAgentRegistry } = await import("../agent/tools.js");
    const registry = buildAgentRegistry(null);
    expect(registry.get("file.read_text")).toBeUndefined();
    expect(registry.get("json.parse")).toBeTruthy();
  });

  it("浏览器可用集是桌面可用集的真子集，差异恰为 10 个桌面独占工具", async () => {
    const desktop = (await import("../agent/tools.js")).listAgentTools(null).map((tool) => tool.name);
    stubBrowser();
    const browser = (await import("../agent/tools.js")).listAgentTools(null).map((tool) => tool.name);
    expect(browser.length).toBeGreaterThan(0);
    expect(browser.length).toBeLessThan(desktop.length);
    expect(desktop.filter((name) => !browser.includes(name)).sort()).toEqual(DESKTOP_ONLY_TOOLS);
  });

  it("桌面端（默认环境）保留 db/file/network 工具", async () => {
    const { buildAgentRegistry } = await import("../agent/tools.js");
    const names = buildAgentRegistry(null).list().map((tool) => tool.name);
    expect(names).toContain("file.read_text");
    expect(names).toContain("db.query_readonly");
    expect(names).toContain("network.ping");
  });
});
