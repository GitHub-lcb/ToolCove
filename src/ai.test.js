// ai.js 流式封装单测：mock invoke 与 Channel，覆盖 delta/done/error/stop
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));
vi.mock("./secure.js", () => ({ decryptValue: async (v) => v }));

import { invoke, Channel } from "@tauri-apps/api/core";
import { aiChatStream, aiChat, extractUsage } from "./ai.js";
import { i18n } from "./i18n/index.js";

// 假 Channel：记录 onmessage 回调与 close 状态，供测试手动触发消息
class FakeChannel {
  constructor() {
    this.onmessage = null;
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
}

function setupAI(ai) {
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "load_data") return { ai: ai || { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m" } };
    if (cmd === "ai_chat_stream") return Promise.resolve();
    return {};
  });
}

function lastChannel() {
  return Channel.mock.instances[Channel.mock.instances.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  Channel.mockImplementation(function () {
    return new FakeChannel();
  });
  setupAI();
});

describe("aiChatStream", () => {
  it("调用 ai_chat_stream 并透传参数与 Channel", async () => {
    const handle = aiChatStream([{ role: "user", content: "hi" }], {});
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).toHaveBeenCalledWith("ai_chat_stream", expect.objectContaining({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    }));
    const args = invoke.mock.calls.find((c) => c[0] === "ai_chat_stream")[1];
    expect(args.channel).toBeInstanceOf(FakeChannel);
    expect(typeof handle.stop).toBe("function");
  });

  it("onDelta 累积增量，onDone 在 done 时触发", async () => {
    const deltas = [];
    const done = vi.fn();
    aiChatStream([{ role: "user", content: "hi" }], {}, { onDelta: (d) => deltas.push(d), onDone: done });
    await new Promise((r) => setTimeout(r, 0));
    const ch = lastChannel();
    ch.onmessage({ delta: "你" });
    ch.onmessage({ delta: "好" });
    ch.onmessage({ done: true });
    expect(deltas).toEqual(["你", "好"]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("onError 收到后端 error 载荷", async () => {
    const err = vi.fn();
    aiChatStream([{ role: "user", content: "hi" }], {}, { onError: err });
    await new Promise((r) => setTimeout(r, 0));
    lastChannel().onmessage({ error: "HTTP 401：unauthorized" });
    expect(err).toHaveBeenCalledWith(expect.objectContaining({ message: "HTTP 401：unauthorized" }));
  });

  it("未配置 AI 时 onError 收到配置错误（不抛异常）", async () => {
    setupAI({});
    const err = vi.fn();
    aiChatStream([{ role: "user", content: "hi" }], {}, { onError: err });
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(i18n.global.t("toolbox.ai.errNoBaseUrl")) }));
  });

  it("stop() 关闭 Channel", async () => {
    const handle = aiChatStream([{ role: "user", content: "hi" }], {});
    await new Promise((r) => setTimeout(r, 0));
    handle.stop();
    expect(lastChannel().closed).toBe(true);
  });
});

const USAGE_BODY = {
  choices: [{ message: { content: "hi" } }],
  usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
};

function setupRaw(raw) {
  invoke.mockImplementation(async (cmd) => {
    if (cmd === "load_data") return { ai: { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m" } };
    if (cmd === "ai_chat") return raw;
    return {};
  });
}

describe("aiChat 用量计量", () => {
  it("onUsage 收到本次调用的 token 用量，返回值仍是纯文本", async () => {
    setupRaw(USAGE_BODY);
    const onUsage = vi.fn();
    const text = await aiChat([{ role: "user", content: "hi" }], { onUsage });
    expect(text).toBe("hi");
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 11, completionTokens: 5, totalTokens: 16 });
  });

  it("服务端没返回 usage 时不触发回调", async () => {
    setupRaw({ choices: [{ message: { content: "ok" } }] });
    const onUsage = vi.fn();
    expect(await aiChat([{ role: "user", content: "hi" }], { onUsage })).toBe("ok");
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("回调抛异常不影响主流程", async () => {
    setupRaw(USAGE_BODY);
    const text = await aiChat([{ role: "user", content: "hi" }], { onUsage: () => { throw Error("boom"); } });
    expect(text).toBe("hi");
  });

  it("不传 onUsage 时行为不变", async () => {
    setupRaw(USAGE_BODY);
    expect(await aiChat([{ role: "user", content: "hi" }], {})).toBe("hi");
  });
});

describe("extractUsage", () => {
  it("缺失或非法 usage 返回 null", () => {
    expect(extractUsage(null)).toBeNull();
    expect(extractUsage(undefined)).toBeNull();
    expect(extractUsage({})).toBeNull();
    expect(extractUsage({ usage: "x" })).toBeNull();
    expect(extractUsage({ usage: [] })).toBeNull();
  });

  it("负数与非有限值归零，小数截断", () => {
    expect(extractUsage({ usage: { prompt_tokens: -4, completion_tokens: 3, total_tokens: Infinity } }))
      .toEqual({ promptTokens: 0, completionTokens: 3, totalTokens: 3 });
    expect(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 2.9 } }))
      .toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    expect(extractUsage({ usage: {} })).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("total_tokens 缺失时用 prompt+completion 兜底", () => {
    expect(extractUsage({ usage: { prompt_tokens: 7, completion_tokens: 8 } }).totalTokens).toBe(15);
    expect(extractUsage({ usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 0 } }).totalTokens).toBe(15);
  });
});
