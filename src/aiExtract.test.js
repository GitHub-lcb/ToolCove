// aiExtract.test.js：识图流式提取封装单测（mock Channel/invoke 驱动全链路）
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));
vi.mock("./secure.js", () => ({ decryptValue: async (v) => v }));

import { invoke, Channel } from "@tauri-apps/api/core";
import { aiExtractStream, aiExtractManyStream, aiExtractGroupsStream } from "./ai.js";
import { i18n } from "./i18n/index.js";

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
  { key: "name", label: "Name" },
  { key: "count", label: "Count", enum: ["1", "2"] },
];
const GROUPS = [
  { key: "sql", title: "DB Scripts", fields: [{ key: "file", label: "File" }] },
  { key: "conf", title: "Config Files", fields: [{ key: "path", label: "Path" }] },
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

describe("aiExtractStream (single)", () => {
  it("builds system+user messages (with image blocks) and sends via ai_chat_stream", async () => {
    aiExtractStream(["data:image/png;base64,xxx"], FIELDS, { hint: "extract" }, {});
    await settle();
    const call = invoke.mock.calls.find((c) => c[0] === "ai_chat_stream");
    expect(call).toBeTruthy();
    const messages = call[1].messages;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(i18n.global.t("prompt.extractSingleHead"));
    expect(messages[1].content[0].type).toBe("text");
    expect(messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,xxx" } });
    expect(call[1].channel).toBeInstanceOf(FakeChannel);
  });

  it("first delta triggers onPartial immediately (after field filtering)", async () => {
    const partials = [];
    aiExtractStream(["data:image/png;base64,xxx"], FIELDS, {}, { onPartial: (v) => partials.push(v) });
    await settle();
    lastChannel().onmessage({ delta: '{"na' });
    await new Promise((r) => setTimeout(r, 20));
    expect(partials.length).toBeGreaterThan(0);
    expect(partials[0]).toEqual({ name: "", count: "" }); // 仅声明字段
  });

  it("done final state: parseJSONLoose + field filtering + enum validation", async () => {
    const done = vi.fn();
    aiExtractStream(["data:image/png;base64,xxx"], FIELDS, {}, { onDone: done });
    await settle();
    lastChannel().onmessage({ delta: '{"name":"Tom","count":"9"}' });
    lastChannel().onmessage({ done: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toHaveBeenCalledWith({ name: "Tom", count: "" }); // count=9 not in enum -> cleared
  });

  it("onError receives backend error payload", async () => {
    const err = vi.fn();
    aiExtractStream(["data:image/png;base64,xxx"], FIELDS, {}, { onError: err });
    await settle();
    lastChannel().onmessage({ error: "HTTP 500" });
    expect(err).toHaveBeenCalledWith(expect.objectContaining({ message: "HTTP 500" }));
  });

  it("stop closes the Channel", async () => {
    const handle = aiExtractStream(["data:image/png;base64,xxx"], FIELDS, {}, {});
    await settle();
    handle.stop();
    expect(lastChannel().closed).toBe(true);
  });
});

describe("aiExtractManyStream (many)", () => {
  it("system carries array instruction, onPartial filters empty rows", async () => {
    const partials = [];
    aiExtractManyStream(["data:image/png;base64,xxx"], FIELDS, {}, { onPartial: (v) => partials.push(v) });
    await settle();
    const call = invoke.mock.calls.find((c) => c[0] === "ai_chat_stream");
    expect(call[1].messages[0].content).toContain(i18n.global.t("prompt.extractManyHead"));
    lastChannel().onmessage({ delta: '[{"name":"a"},{"name":""}]' });
    await new Promise((r) => setTimeout(r, 20));
    expect(partials[0]).toEqual([{ name: "a", count: "" }]); // empty rows filtered
  });

  it("done final state array", async () => {
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

describe("aiExtractGroupsStream (groups)", () => {
  it("system carries table definitions, onPartial filters by group", async () => {
    const partials = [];
    aiExtractGroupsStream(["data:image/png;base64,xxx"], GROUPS, {}, { onPartial: (v) => partials.push(v) });
    await settle();
    const call = invoke.mock.calls.find((c) => c[0] === "ai_chat_stream");
    expect(call[1].messages[0].content).toContain("DB Scripts");
    lastChannel().onmessage({ delta: '{"sql":[{"file":"a.sql"}],"conf":[]}' });
    await new Promise((r) => setTimeout(r, 20));
    expect(partials[0]).toEqual({ sql: [{ file: "a.sql" }], conf: [] });
  });

  it("done final state grouped", async () => {
    const done = vi.fn();
    aiExtractGroupsStream(["data:image/png;base64,xxx"], GROUPS, {}, { onDone: done });
    await settle();
    lastChannel().onmessage({ delta: '{"sql":[{"file":"a.sql"}]}' });
    lastChannel().onmessage({ done: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toHaveBeenCalledWith({ sql: [{ file: "a.sql" }], conf: [] });
  });
});
