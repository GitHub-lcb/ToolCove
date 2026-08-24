// chatSession.js 单测：会话创建/删除/标题/裁剪/上下文构建
import { describe, it, expect } from "vitest";
import {
  DEFAULT_PRESETS,
  createSession,
  sessionTitle,
  renameSession,
  deleteSession,
  trimMessages,
  buildContextMessages,
} from "./chatSession.js";

describe("createSession", () => {
  it("生成唯一 id 与默认字段", () => {
    const a = createSession("general");
    const b = createSession();
    expect(a.id).not.toBe(b.id);
    expect(a.title).toBe("新对话");
    expect(a.presetId).toBe("general");
    expect(a.messages).toEqual([]);
    expect(typeof a.createdAt).toBe("number");
  });
});

describe("sessionTitle", () => {
  it("取首条用户消息文本前 20 字", () => {
    const long = "这是一条非常长的用户消息，用来验证标题截断逻辑是否正确";
    expect(sessionTitle([{ role: "user", content: long }])).toBe(long.slice(0, 20));
  });
  it("纯图片消息回退为图片对话", () => {
    expect(sessionTitle([{ role: "user", content: "", images: [{ name: "a.png" }] }])).toBe("图片对话");
  });
  it("content 为块数组时拼接文本", () => {
    expect(sessionTitle([{ role: "user", content: [{ type: "text", text: "分析" }, { type: "image_url" }] }])).toBe("分析");
  });
  it("无消息返回新对话", () => {
    expect(sessionTitle([])).toBe("新对话");
  });
});

describe("renameSession", () => {
  it("空白标题回退为自动标题", () => {
    const s = createSession();
    renameSession(s, "   ");
    expect(s.title).toBe("新对话");
    renameSession(s, "我的会话");
    expect(s.title).toBe("我的会话");
  });
});

describe("deleteSession", () => {
  it("按 id 过滤", () => {
    const a = createSession();
    const b = createSession();
    expect(deleteSession([a, b], a.id)).toEqual([b]);
  });
});

describe("trimMessages", () => {
  it("超上限删最旧，保留最近", () => {
    const msgs = Array.from({ length: 105 }, (_, i) => ({ id: String(i), role: "user", content: String(i) }));
    const out = trimMessages(msgs, 100);
    expect(out).toHaveLength(100);
    expect(out[0].id).toBe("5");
    expect(out[99].id).toBe("104");
  });
  it("不超上限原样返回", () => {
    const msgs = [{ role: "user", content: "x" }];
    expect(trimMessages(msgs, 100)).toEqual(msgs);
  });
});

describe("buildContextMessages", () => {
  it("system 前置", () => {
    const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const out = buildContextMessages(msgs, "你是助手", 10);
    expect(out[0]).toEqual({ role: "system", content: "你是助手" });
    expect(out).toHaveLength(3);
  });
  it("只保留最近 maxRounds 轮", () => {
    const msgs = [];
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: "user", content: "u" + i });
      msgs.push({ role: "assistant", content: "a" + i });
    }
    const out = buildContextMessages(msgs, "", 10);
    expect(out).toHaveLength(20);
    expect(out[0].content).toBe("u2");
  });
  it("跳过空 assistant 回复（正在生成中的占位）", () => {
    const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: "" }];
    const out = buildContextMessages(msgs, "", 10);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("hi");
  });
  it("content 块数组（图片消息）原样保留", () => {
    const blocks = [{ type: "text", text: "看这张图" }, { type: "image_url", image_url: { url: "data:image/png;base64,xxx" } }];
    const out = buildContextMessages([{ role: "user", content: blocks }], "", 10);
    expect(out[0].content).toEqual(blocks);
  });
  it("system 空白时不插入", () => {
    const out = buildContextMessages([{ role: "user", content: "hi" }], "   ", 10);
    expect(out).toHaveLength(1);
  });
});

describe("DEFAULT_PRESETS", () => {
  it("内置 5 个且 id 唯一", () => {
    expect(DEFAULT_PRESETS).toHaveLength(5);
    expect(new Set(DEFAULT_PRESETS.map((p) => p.id)).size).toBe(5);
  });
});
