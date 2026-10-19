import { describe, expect, it } from "vitest";
import { activeProfile, newProfileId, normalizeAi, profileLabel, toStoredAi } from "./modelProfiles.js";

describe("normalizeAi 多模型配置", () => {
  it("读 profiles + activeId；失效的 activeId 回退到第一条", () => {
    const ai = normalizeAi({
      enabled: true,
      activeId: "b",
      profiles: [
        { id: "a", name: "主力", baseUrl: " https://api.deepseek.com/v1 ", apiKey: "k1", model: "deepseek-chat", temperature: 0.3, reasoningEffort: "HIGH" },
        { id: "b", name: "备用", baseUrl: "https://api.openai.com/v1", apiKey: "k2", model: "gpt-4o-mini" },
      ],
    });
    expect(ai.enabled).toBe(true);
    expect(ai.activeId).toBe("b");
    expect(ai.profiles[0]).toMatchObject({ id: "a", name: "主力", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", temperature: 0.3, reasoningEffort: "high" });
    expect(activeProfile(ai).id).toBe("b");

    const fallback = normalizeAi({ activeId: "ghost", profiles: [{ id: "a", model: "m", baseUrl: "u", apiKey: "k" }] });
    expect(fallback.activeId).toBe("a");
  });

  it("旧版扁平字段自动迁移成一条配置（id 固定为 default）", () => {
    const ai = normalizeAi({ enabled: true, baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "deepseek-chat", temperature: 0.5, reasoningEffort: "high" });
    expect(ai.profiles).toHaveLength(1);
    expect(ai.profiles[0]).toMatchObject({ id: "default", baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "deepseek-chat", temperature: 0.5, reasoningEffort: "high" });
    expect(ai.activeId).toBe("default");
  });

  it("全空记录、重复 id 与非数组输入都不产生脏配置", () => {
    expect(normalizeAi({}).profiles).toEqual([]);
    expect(normalizeAi(null).profiles).toEqual([]);
    expect(normalizeAi({ profiles: "x" }).profiles).toEqual([]);
    const ai = normalizeAi({
      profiles: [
        { id: "dup", model: "a", baseUrl: "u", apiKey: "k" },
        { id: "dup", model: "b", baseUrl: "u", apiKey: "k" },
        { id: "blank" },
      ],
    });
    expect(ai.profiles).toHaveLength(1);
    expect(ai.profiles[0].model).toBe("a");
  });

  it("温度夹到 0..1，非法值回默认；档位非法回默认档", () => {
    const [p] = normalizeAi({ profiles: [{ id: "a", model: "m", baseUrl: "u", apiKey: "k", temperature: 9, reasoningEffort: "ultra" }] }).profiles;
    expect(p.temperature).toBe(1);
    expect(p.reasoningEffort).toBe("");
    const [q] = normalizeAi({ profiles: [{ id: "a", model: "m", baseUrl: "u", apiKey: "k", temperature: "x" }] }).profiles;
    expect(q.temperature).toBe(0.7);
  });

  it("展示名：命名优先，其次模型名", () => {
    expect(profileLabel({ name: "主力", model: "deepseek-chat" })).toBe("主力");
    expect(profileLabel({ model: "deepseek-chat" })).toBe("deepseek-chat");
    expect(profileLabel(null)).toBe("");
  });

  it("落盘把当前配置镜像到旧扁平字段，切换后镜像跟着变", () => {
    const ai = normalizeAi({
      enabled: true,
      activeId: "a",
      profiles: [
        { id: "a", baseUrl: "https://a/v1", apiKey: "ka", model: "ma" },
        { id: "b", baseUrl: "https://b/v1", apiKey: "kb", model: "mb", reasoningEffort: "low" },
      ],
    });
    const stored = toStoredAi(ai);
    expect(stored).toMatchObject({ baseUrl: "https://a/v1", apiKey: "ka", model: "ma", activeId: "a" });
    const switched = toStoredAi({ ...ai, activeId: "b" });
    expect(switched).toMatchObject({ baseUrl: "https://b/v1", apiKey: "kb", model: "mb", reasoningEffort: "low", activeId: "b" });
  });

  it("newProfileId 每次不同", () => {
    const list = new Set(Array.from({ length: 20 }, () => newProfileId()));
    expect(list.size).toBe(20);
  });
});
