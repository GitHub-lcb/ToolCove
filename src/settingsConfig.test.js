import { describe, expect, it } from "vitest";
import { normalizeHiddenModules, normalizeTelemetry, normalizeSync } from "./settingsConfig.js";

describe("normalizeHiddenModules", () => {
  const ALL = ["toolbox", "snippet", "problem"];

  it("只保留当前存在的模块 key，去重且保持顺序", () => {
    expect(normalizeHiddenModules(ALL, ["problem", "snippet", "problem", "legacy", 3])).toEqual(["problem", "snippet"]);
  });

  it("非数组输入归一为空列表", () => {
    expect(normalizeHiddenModules(ALL, null)).toEqual([]);
    expect(normalizeHiddenModules(undefined, ["toolbox"])).toEqual([]);
  });
});

describe("normalizeTelemetry（旧数据兼容）", () => {
  it("缺字段/非对象 → 默认关闭且未询问，installId 置 null", () => {
    expect(normalizeTelemetry(undefined)).toEqual({ enabled: false, prompted: false, installId: null });
    expect(normalizeTelemetry(null)).toEqual({ enabled: false, prompted: false, installId: null });
    expect(normalizeTelemetry({})).toEqual({ enabled: false, prompted: false, installId: null });
    expect(normalizeTelemetry("x")).toEqual({ enabled: false, prompted: false, installId: null });
  });

  it("半值/非法 installId 补齐或置空", () => {
    expect(normalizeTelemetry({ enabled: true })).toEqual({ enabled: true, prompted: false, installId: null });
    expect(normalizeTelemetry({ prompted: true })).toEqual({ enabled: false, prompted: true, installId: null });
    expect(normalizeTelemetry({ enabled: true, prompted: true, installId: "" })).toEqual({ enabled: true, prompted: true, installId: null });
    expect(normalizeTelemetry({ enabled: true, installId: 123 })).toEqual({ enabled: true, prompted: false, installId: null });
    expect(normalizeTelemetry({ enabled: true, installId: "a".repeat(200) })).toEqual({ enabled: true, prompted: false, installId: null });
  });

  it("合法配置原样保留（enabled 非布尔值按 false 归一）", () => {
    expect(normalizeTelemetry({ enabled: true, prompted: true, installId: "uuid-1" })).toEqual({ enabled: true, prompted: true, installId: "uuid-1" });
    expect(normalizeTelemetry({ enabled: "yes", prompted: false, installId: "uuid-2" }).enabled).toBe(false);
  });
});

describe("normalizeSync（旧数据兼容 + 安全域）", () => {
  it("缺字段 → 全关默认", () => {
    expect(normalizeSync(undefined)).toEqual({
      enabled: false, serverUrl: "", collectionId: "", deviceName: "", deviceId: "", salt: "", keyCipher: "", tokenCipher: "",
      cursor: 0, lastPushedAt: 0, lastSyncAt: 0, status: "idle",
    });
    expect(normalizeSync(null).enabled).toBe(false);
  });

  it("非法 serverUrl 清空；合法 http(s) 保留", () => {
    expect(normalizeSync({ serverUrl: "ftp://x" }).serverUrl).toBe("");
    expect(normalizeSync({ serverUrl: "not-a-url" }).serverUrl).toBe("");
    expect(normalizeSync({ serverUrl: "https://sync.example.com" }).serverUrl).toBe("https://sync.example.com");
    expect(normalizeSync({ serverUrl: "http://192.168.1.5:8080" }).serverUrl).toBe("http://192.168.1.5:8080");
  });

  it("status 仅允许 revoked/idle；cursor 等数值非负", () => {
    expect(normalizeSync({ status: "revoked" }).status).toBe("revoked");
    expect(normalizeSync({ status: "whatever" }).status).toBe("idle");
    expect(normalizeSync({ cursor: -5 })).toEqual(expect.objectContaining({ cursor: 0 }));
    expect(normalizeSync({ cursor: 42 })).toEqual(expect.objectContaining({ cursor: 42 }));
  });
});