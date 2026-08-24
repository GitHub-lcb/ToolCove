// ai.js 流式封装单测：mock invoke 与 Channel，覆盖 delta/done/error/stop
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));
vi.mock("./secure.js", () => ({ decryptValue: async (v) => v }));

import { invoke, Channel } from "@tauri-apps/api/core";
import { aiChatStream } from "./ai.js";
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
