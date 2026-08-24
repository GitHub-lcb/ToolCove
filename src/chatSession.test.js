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
import { i18n } from "./i18n/index.js";

describe("createSession", () => {
  it("generates unique id and default fields", () => {
    const a = createSession("general");
    const b = createSession();
    expect(a.id).not.toBe(b.id);
    expect(a.title).toBe(i18n.global.t("toolbox.ai.newSession"));
    expect(a.presetId).toBe("general");
    expect(a.messages).toEqual([]);
    expect(typeof a.createdAt).toBe("number");
  });
});

describe("sessionTitle", () => {
  it("takes the first 20 chars of the first user message", () => {
    const long = "This is a very long user message used to verify the title truncation logic";
    expect(sessionTitle([{ role: "user", content: long }])).toBe(long.slice(0, 20));
  });
  it("falls back to image session for pure image messages", () => {
    expect(sessionTitle([{ role: "user", content: "", images: [{ name: "a.png" }] }])).toBe(i18n.global.t("toolbox.ai.imageSession"));
  });
  it("joins text blocks when content is an array", () => {
    expect(sessionTitle([{ role: "user", content: [{ type: "text", text: "analyze" }, { type: "image_url" }] }])).toBe("analyze");
  });
  it("returns a new session without messages", () => {
    expect(sessionTitle([])).toBe(i18n.global.t("toolbox.ai.newSession"));
  });
});

describe("renameSession", () => {
  it("falls back to auto title for blank input", () => {
    const s = createSession();
    renameSession(s, "   ");
    expect(s.title).toBe(i18n.global.t("toolbox.ai.newSession"));
    renameSession(s, "My Session");
    expect(s.title).toBe("My Session");
  });
});

describe("deleteSession", () => {
  it("filters by id", () => {
    const a = createSession();
    const b = createSession();
    expect(deleteSession([a, b], a.id)).toEqual([b]);
  });
});

describe("trimMessages", () => {
  it("drops the oldest beyond the limit", () => {
    const msgs = Array.from({ length: 105 }, (_, i) => ({ id: String(i), role: "user", content: String(i) }));
    const out = trimMessages(msgs, 100);
    expect(out).toHaveLength(100);
    expect(out[0].id).toBe("5");
    expect(out[99].id).toBe("104");
  });
  it("returns as-is within the limit", () => {
    const msgs = [{ role: "user", content: "x" }];
    expect(trimMessages(msgs, 100)).toEqual(msgs);
  });
});

describe("buildContextMessages", () => {
  it("prepends the system message", () => {
    const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const out = buildContextMessages(msgs, "You are an assistant", 10);
    expect(out[0]).toEqual({ role: "system", content: "You are an assistant" });
    expect(out).toHaveLength(3);
  });
  it("keeps only the latest maxRounds rounds", () => {
    const msgs = [];
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: "user", content: "u" + i });
      msgs.push({ role: "assistant", content: "a" + i });
    }
    const out = buildContextMessages(msgs, "", 10);
    expect(out).toHaveLength(20);
    expect(out[0].content).toBe("u2");
  });
  it("skips empty assistant replies", () => {
    const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: "" }];
    const out = buildContextMessages(msgs, "", 10);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("hi");
  });
  it("keeps content block arrays for image messages", () => {
    const blocks = [{ type: "text", text: "look at this image" }, { type: "image_url", image_url: { url: "data:image/png;base64,xxx" } }];
    const out = buildContextMessages([{ role: "user", content: blocks }], "", 10);
    expect(out[0].content).toEqual(blocks);
  });
  it("does not insert an empty system", () => {
    const out = buildContextMessages([{ role: "user", content: "hi" }], "   ", 10);
    expect(out).toHaveLength(1);
  });
});

describe("DEFAULT_PRESETS", () => {
  it("has 5 built-in presets with unique ids", () => {
    expect(DEFAULT_PRESETS).toHaveLength(5);
    expect(new Set(DEFAULT_PRESETS.map((p) => p.id)).size).toBe(5);
  });
});
