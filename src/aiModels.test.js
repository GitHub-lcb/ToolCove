// 模型列表拉取：/models 响应的形状归一 + 请求参数。mock 掉平台 IPC，不碰真实网络。
import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("./platform/invoke.js", () => ({ invoke: invokeMock, createChannel: vi.fn() }));
vi.mock("./secure.js", () => ({ decryptValue: async (v) => v }));

import { listAIModels, parseModelsResponse } from "./ai.js";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("parseModelsResponse", () => {
  it("OpenAI 形状：data[].id，去重保序", () => {
    expect(parseModelsResponse(JSON.stringify({ data: [{ id: "b" }, { id: "a" }, { id: "b" }] }))).toEqual(["b", "a"]);
  });

  it("Ollama 形状：models[].name / model", () => {
    expect(parseModelsResponse({ models: [{ name: "qwen2.5:7b" }, { model: "llama3.1:8b" }] })).toEqual(["qwen2.5:7b", "llama3.1:8b"]);
  });

  it("纯字符串数组也接受", () => {
    expect(parseModelsResponse(["m1", "m2"])).toEqual(["m1", "m2"]);
  });

  it("不是 JSON / 没有列表时报错（不能静默交一个空下拉）", () => {
    expect(() => parseModelsResponse("not json")).toThrow("不是合法 JSON");
    expect(() => parseModelsResponse({ data: [] })).toThrow("没有模型列表");
    expect(() => parseModelsResponse(null)).toThrow("没有模型列表");
  });
});

describe("listAIModels", () => {
  it("GET {baseUrl}/models，带 Bearer Key；走平台 http_request 通道", async () => {
    invokeMock.mockResolvedValue({ status: 200, body: JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }) });
    const models = await listAIModels({ baseUrl: " https://api.deepseek.com/v1/ ", apiKey: " sk-1 " });
    expect(models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    const [command, args] = invokeMock.mock.calls[0];
    expect(command).toBe("http_request");
    expect(args).toMatchObject({ method: "GET", url: "https://api.deepseek.com/v1/models" });
    expect(args.headers).toContainEqual(["Authorization", "Bearer sk-1"]);
  });

  it("非 2xx 把状态码与响应摘要带出来，别只说「失败」", async () => {
    invokeMock.mockResolvedValue({ status: 401, body: JSON.stringify({ error: { message: "invalid key" } }) });
    await expect(listAIModels({ baseUrl: "https://api.example.com/v1", apiKey: "bad" })).rejects.toThrow(/HTTP 401.*invalid key/);
  });

  it("缺地址直接拦下（不发请求）", async () => {
    await expect(listAIModels({ baseUrl: "  ", apiKey: "k" })).rejects.toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
