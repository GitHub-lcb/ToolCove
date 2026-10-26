import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../platform/invoke.js", () => ({ invoke: invokeMock, createChannel: vi.fn() }));
vi.mock("../secure.js", () => ({ decryptValue: async (v) => v }));

import { EFFORT_LEVELS, contextWindowOf, effortDescKey, effortLabelKey, modelsFor, normalizeEffort, providerFor, providerLabel } from "./modelCatalog.js";
import { loadModelChoice, loadModelList, saveModelChoice } from "./modelPrefs.js";

describe("模型目录", () => {
  it("按 baseUrl 认服务商，认不出的给「自定义端点」", () => {
    expect(providerFor("https://api.deepseek.com/v1")?.key).toBe("deepseek");
    expect(providerFor("https://api.openai.com/v1")?.key).toBe("openai");
    expect(providerFor("http://localhost:11434/v1")?.key).toBe("ollama");
    expect(providerFor("https://my-gateway.example.com/v1")).toBe(null);
    expect(providerLabel("https://my-gateway.example.com/v1")).toBe("自定义端点");
    expect(providerLabel("")).toBe("自定义端点");
  });

  it("候选模型只来自当前端点", () => {
    expect(modelsFor("https://api.deepseek.com/v1").map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(modelsFor("https://my-gateway.example.com/v1")).toEqual([]);
  });

  it("上下文窗口只给有公开事实的模型，认不出返回空串", () => {
    expect(contextWindowOf("https://api.deepseek.com/v1", "deepseek-chat")).toBe("128K");
    expect(contextWindowOf("https://api.moonshot.cn/v1", "moonshot-v1-32k")).toBe("32K");
    expect(contextWindowOf("https://api.deepseek.com/v1", "deepseek-v9")).toBe("");
    expect(contextWindowOf("", "whatever")).toBe("");
  });

  it("推理档位归一：非法值回到默认档，词条键与设置页同源", () => {
    expect(normalizeEffort("HIGH")).toBe("high");
    expect(normalizeEffort("ultra")).toBe("");
    expect(normalizeEffort(null)).toBe("");
    expect(effortLabelKey("xhigh")).toBe("agent.effortXhigh");
    expect(effortLabelKey("")).toBe("agent.effortDefault");
    // 五档（不含"跟随服务商"）与解释词条：浮层与设置页都从这里取，别再各写一套
    expect(EFFORT_LEVELS.map((item) => item.value)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(effortDescKey("high")).toBe("agent.effortDescHigh");
    expect(effortDescKey("")).toBe("agent.effortDescDefault");
    expect(effortDescKey("ultra")).toBe("agent.effortDescDefault");
  });
});

beforeEach(() => {
  invokeMock.mockReset();
});

describe("模型选择的读写", () => {
  it("读当前配置与可切换配置列表；旧扁平字段自动迁移", async () => {
    invokeMock.mockResolvedValue([1, 2]);
    await expect(loadModelChoice()).resolves.toEqual({
      baseUrl: "",
      model: "",
      reasoningEffort: "",
      enabled: false,
      profileId: "",
      profileName: "",
      profiles: [],
    });
    invokeMock.mockResolvedValue({ ai: { baseUrl: " https://api.deepseek.com/v1 ", model: " deepseek-chat ", reasoningEffort: "high", enabled: true } });
    await expect(loadModelChoice()).resolves.toEqual({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      reasoningEffort: "high",
      enabled: true,
      profileId: "default",
      profileName: "deepseek-chat",
      profiles: [{ id: "default", name: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" }],
    });
  });

  it("写入是读-合并-写，别的分组原样保留，当前配置镜像到扁平字段", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "load_data") return { ai: { apiKey: "enc:xxx", model: "old" }, ui: { density: "cozy" } };
      if (command === "save_data") return null;
      return null;
    });
    const result = await saveModelChoice({ model: "deepseek-reasoner", reasoningEffort: "high" });
    const saved = invokeMock.mock.calls.find(([command]) => command === "save_data")[1];
    expect(saved.data.ai).toMatchObject({
      activeId: "default",
      apiKey: "enc:xxx",
      model: "deepseek-reasoner",
      reasoningEffort: "high",
      profiles: [{ id: "default", apiKey: "enc:xxx", model: "deepseek-reasoner", reasoningEffort: "high" }],
    });
    expect(saved.data.ui).toEqual({ density: "cozy" });
    expect(result.model).toBe("deepseek-reasoner");
  });

  it("切换配置：只改 activeId，镜像跟着当前配置走", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "load_data") {
        return {
          ai: {
            enabled: true,
            activeId: "a",
            profiles: [
              { id: "a", name: "主力", baseUrl: "https://a/v1", apiKey: "ka", model: "ma" },
              { id: "b", name: "备用", baseUrl: "https://b/v1", apiKey: "kb", model: "mb", reasoningEffort: "low" },
            ],
          },
        };
      }
      return null;
    });
    const result = await saveModelChoice({ profileId: "b" });
    const saved = invokeMock.mock.calls.find(([command]) => command === "save_data")[1];
    expect(saved.data.ai).toMatchObject({ activeId: "b", baseUrl: "https://b/v1", model: "mb", reasoningEffort: "low" });
    expect(result).toMatchObject({ profileId: "b", profileName: "备用", model: "mb", baseUrl: "https://b/v1" });
    expect(result.profiles.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("空模型名不落盘（否则下一次调用必然 CONFIG 失败）", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "load_data") return { ai: { model: "deepseek-chat" } };
      return null;
    });
    const result = await saveModelChoice({ model: "   " });
    expect(result.model).toBe("deepseek-chat");
    expect(invokeMock.mock.calls.some(([command]) => command === "save_data")).toBe(false);
  });

  it("按当前配置从端点拉模型列表：Key 在模块内解密后只进请求头", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "load_data") {
        return { ai: { enabled: true, baseUrl: "https://api.deepseek.com/v1", apiKey: "enc-key", model: "deepseek-chat" } };
      }
      if (command === "http_request") {
        return { status: 200, body: JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }) };
      }
      return null;
    });
    const models = await loadModelList();
    expect(models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    const call = invokeMock.mock.calls.find(([command]) => command === "http_request")[1];
    expect(call.url).toBe("https://api.deepseek.com/v1/models");
    expect(call.headers).toContainEqual(["Authorization", "Bearer enc-key"]);
  });
});
