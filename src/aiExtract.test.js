// aiExtract.test.js：识图流式提取封装单测（mock Channel/invoke 驱动全链路）
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));
vi.mock("./secure.js", () => ({ decryptValue: async (v) => v }));

import { invoke, Channel } from "@tauri-apps/api/core";
import { aiExtractStream, aiExtractManyStream, aiExtractGroupsStream } from "./ai.js";

// 假 Channel：记录实例供测试手动触发消息
class FakeChannel {
  constructor() {
    this.onmessage = null;
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
}

const FIELDS = [
  { key: "name", label: "名称" },
  { key: "count", label: "数量", enum: ["1", "2"] },
];
const GROUPS = [
  { key: "sql", title: "数据库脚本", fields: [{ key: "file", label: "文件名" }] },
  { key: "conf", title: "配置文件", fields: [{ key: "path", label: "路径" }] },
];

function setupAI() {
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "load_data") return { ai: { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m" } };
    if (cmd === "ai_chat_stream") return Promise.resolve();
    return {};
  });
}

function lastChannel() {
  return Channel.mock.instances[Channel.mock.instances.length - 1];
}

// 等待 aiChatStream 内部异步启动（loadAIConfig + invoke）
async function settle() {
  await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  vi.clearAllMocks();
  Channel.mockImplementation(function () {
    return new FakeChannel();
  });
  setupAI();
});

describe("aiExtractStream（单条）", () => {
  it("构造 system+user 消息（含图片块）并经 ai_chat_stream 发送", async () => {
    aiExtractStream(["data:image/png;base64,xxx"], FIELDS, { hint: "提取" }, {});
    await settle();
    const call = invoke.mock.calls.find((c) => c[0] === "ai_chat_stream");
    expect(call).toBeTruthy();
    const messages = call[1].messages;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("严格只输出一个 JSON 对象");
    expect(messages[1].content[0].type).toBe("text");
    expect(messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,xxx" } });
    expect(call[1].channel).toBeInstanceOf(FakeChannel);
  });

  it("delta 首拍立即触发 onPartial（字段过滤后）", async () => {
    const partials = [];
    aiExtractStream(["data:image/png;base64,xxx"], FIELDS, {}, { onPartial: (v) => partials.push(v) });
    await settle();
    lastChannel().onmessage({ delta: '{"na' });
    await new Promise((r) => setTimeout(r, 20));
    expect(partials.length).toBeGreaterThan(0);
    expect(partials[0]).toEqual({ name: "", count: "" }); // 仅声明字段
  });

  it("done 终态：parseJSONLoose 解析 + 字段过滤 + enum 校验", async () => {
    const done = vi.fn();
    aiExtractStream(["data:image/png;base64,xxx"], FIELDS, {}, { onDone: done });
    await settle();
    lastChannel().onmessage({ delta: '{"name":"张三","count":"9"}' });
    lastChannel().onmessage({ done: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toHaveBeenCalledWith({ name: "张三", count: "" }); // count=9 不在 enum → 清空
  });

  it("onError 收到后端 error 载荷", async () => {
    const err = vi.fn();
    aiExtractStream(["data:image/png;base64,xxx"], FIELDS, {}, { onError: err });
    await settle();
    lastChannel().onmessage({ error: "HTTP 500" });
    expect(err).toHaveBeenCalledWith(expect.objectContaining({ message: "HTTP 500" }));
  });

  it("stop 关闭 Channel", async () => {
    const handle = aiExtractStream(["data:image/png;base64,xxx"], FIELDS, {}, {});
    await settle();
    handle.stop();
    expect(lastChannel().closed).toBe(true);
  });
});

describe("aiExtractManyStream（批量）", () => {
  it("system 含数组指令，onPartial 过滤空白行", async () => {
    const partials = [];
    aiExtractManyStream(["data:image/png;base64,xxx"], FIELDS, {}, { onPartial: (v) => partials.push(v) });
    await settle();
    const call = invoke.mock.calls.find((c) => c[0] === "ai_chat_stream");
    expect(call[1].messages[0].content).toContain("JSON 数组");
    lastChannel().onmessage({ delta: '[{"name":"a"},{"name":""}]' });
    await new Promise((r) => setTimeout(r, 20));
    expect(partials[0]).toEqual([{ name: "a", count: "" }]); // 空白行被过滤
  });

  it("done 终态数组", async () => {
    const done = vi.fn();
    aiExtractManyStream(["data:image/png;base64,xxx"], FIELDS, {}, { onDone: done });
    await settle();
    lastChannel().onmessage({ delta: '[{"name":"a","count":"1"},{"name":"b","count":"2"}]' });
    lastChannel().onmessage({ done: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toHaveBeenCalledWith([
      { name: "a", count: "1" },
      { name: "b", count: "2" },
    ]);
  });
});

describe("aiExtractGroupsStream（分组）", () => {
  it("system 含表名定义，onPartial 按组过滤", async () => {
    const partials = [];
    aiExtractGroupsStream(["data:image/png;base64,xxx"], GROUPS, {}, { onPartial: (v) => partials.push(v) });
    await settle();
    const call = invoke.mock.calls.find((c) => c[0] === "ai_chat_stream");
    expect(call[1].messages[0].content).toContain("数据库脚本");
    lastChannel().onmessage({ delta: '{"sql":[{"file":"a.sql"}],"conf":[]}' });
    await new Promise((r) => setTimeout(r, 20));
    expect(partials[0]).toEqual({ sql: [{ file: "a.sql" }], conf: [] });
  });

  it("done 终态分组", async () => {
    const done = vi.fn();
    aiExtractGroupsStream(["data:image/png;base64,xxx"], GROUPS, {}, { onDone: done });
    await settle();
    lastChannel().onmessage({ delta: '{"sql":[{"file":"a.sql"}]}' });
    lastChannel().onmessage({ done: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toHaveBeenCalledWith({ sql: [{ file: "a.sql" }], conf: [] });
  });
});
