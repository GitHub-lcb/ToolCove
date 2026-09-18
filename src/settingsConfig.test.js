import { describe, expect, it } from "vitest";
import {
  normalizeHiddenModules,
  normalizeTelemetry,
  normalizeSync,
  mergeSettingsSnapshot,
  normalizeAgent,
  AGENT_CONFIRM_POLICIES,
  AGENT_MAX_STEPS_HARD_CAP,
  AGENT_MAX_RETRIES,
} from "./settingsConfig.js";

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

describe("mergeSettingsSnapshot（设置页保存不得删除未渲染分组）", () => {
  const disk = {
    ai: { baseUrl: "https://api.deepseek.com/v1", apiKey: "enc:old", model: "deepseek-chat" },
    ui: { density: "compact", hiddenModules: [], locale: "system" },
    telemetry: { enabled: true, prompted: true, installId: "uuid-1" },
    sync: { enabled: true, serverUrl: "https://sync.example.com", collectionId: "c1", tokenCipher: "enc:tok" },
    agent: { maxSteps: 20, disabledTools: ["json.parse"] },
  };

  it("表单只含 ai/ui 时，telemetry/sync/agent 原样保留", () => {
    const form = {
      ai: { baseUrl: "https://api.openai.com/v1", apiKey: "enc:new", model: "gpt-4o-mini" },
      ui: { density: "comfort", hiddenModules: ["home"], locale: "zh-CN" },
    };
    const out = mergeSettingsSnapshot(disk, form);
    expect(Object.keys(out).sort()).toEqual(["agent", "ai", "sync", "telemetry", "ui"]);
    expect(out.telemetry).toEqual(disk.telemetry);
    expect(out.sync).toEqual(disk.sync);
    expect(out.agent).toEqual(disk.agent);
  });

  it("表单分组覆盖同名基底分组，不连带影响其他分组", () => {
    const out = mergeSettingsSnapshot(disk, { ai: { model: "m2" }, ui: disk.ui });
    expect(out.ai).toEqual({ model: "m2" });
    expect(out.sync.tokenCipher).toBe("enc:tok");
  });

  it("非对象与数组输入被容忍（load_data 对缺失文件返回 []）", () => {
    expect(mergeSettingsSnapshot([], { ai: { model: "m" } })).toEqual({ ai: { model: "m" } });
    expect(mergeSettingsSnapshot(null, undefined)).toEqual({});
    expect(mergeSettingsSnapshot(disk, "x")).toEqual(disk);
  });

  it("返回新对象；浅合并语义下顶层赋值不影响入参（深拷贝由调用方 cloneJsonData 负责）", () => {
    const form = { ai: { model: "m3" } };
    const out = mergeSettingsSnapshot(disk, form);
    expect(out).not.toBe(disk);
    expect(out).not.toBe(form);
    out.sync = null;
    out.telemetry = null;
    expect(disk.sync).not.toBeNull();
    expect(disk.telemetry).not.toBeNull();
  });
});

describe("normalizeAgent（Agent 设置归一）", () => {
  const TOOLS = ["json.parse", "json.format", "file.write_text"];
  const DEFAULTS = { maxSteps: 12, retries: 1, requireConfirmation: "risky", disabledTools: [], disabledSkills: [] };

  it("缺字段/非对象 → 全默认", () => {
    expect(normalizeAgent(undefined, TOOLS)).toEqual(DEFAULTS);
    expect(normalizeAgent(null, TOOLS)).toEqual(DEFAULTS);
    expect(normalizeAgent("x", TOOLS)).toEqual(DEFAULTS);
    expect(normalizeAgent([], TOOLS)).toEqual(DEFAULTS);
    expect(normalizeAgent({}, TOOLS)).toEqual(DEFAULTS);
  });

  it("maxSteps / retries 超上限被钳制，非法值落回默认", () => {
    expect(normalizeAgent({ maxSteps: 500 }, TOOLS).maxSteps).toBe(AGENT_MAX_STEPS_HARD_CAP);
    expect(normalizeAgent({ maxSteps: 20 }, TOOLS).maxSteps).toBe(20);
    expect(normalizeAgent({ maxSteps: 0 }, TOOLS).maxSteps).toBe(12);
    expect(normalizeAgent({ maxSteps: "8" }, TOOLS).maxSteps).toBe(12);
    expect(normalizeAgent({ retries: 99 }, TOOLS).retries).toBe(AGENT_MAX_RETRIES);
    expect(normalizeAgent({ retries: 0 }, TOOLS).retries).toBe(0);
    expect(normalizeAgent({ retries: -1 }, TOOLS).retries).toBe(1);
  });

  it("确认策略只接受 risky/always/never", () => {
    expect(AGENT_CONFIRM_POLICIES).toEqual(["risky", "always", "never"]);
    for (const p of AGENT_CONFIRM_POLICIES) {
      expect(normalizeAgent({ requireConfirmation: p }, TOOLS).requireConfirmation).toBe(p);
    }
    expect(normalizeAgent({ requireConfirmation: "yolo" }, TOOLS).requireConfirmation).toBe("risky");
    expect(normalizeAgent({ requireConfirmation: ["never"] }, TOOLS).requireConfirmation).toBe("risky");
  });

  it("停用清单只保留真实存在的工具名，去重且保持顺序", () => {
    expect(normalizeAgent({ disabledTools: ["json.format", "json.parse", "json.format", "nope", 3] }, TOOLS).disabledTools)
      .toEqual(["json.format", "json.parse"]);
    expect(normalizeAgent({ disabledTools: "x" }, TOOLS).disabledTools).toEqual([]);
  });

  it("全关视为未配置（否则 registry 为空，Agent 什么都做不了）", () => {
    expect(normalizeAgent({ disabledTools: TOOLS }, TOOLS).disabledTools).toEqual([]);
    expect(normalizeAgent({ disabledTools: [...TOOLS, "nope"] }, TOOLS).disabledTools).toEqual([]);
    // 只关掉一部分不算全关，照常保留
    expect(normalizeAgent({ disabledTools: TOOLS.slice(0, 2) }, TOOLS).disabledTools).toEqual(TOOLS.slice(0, 2));
  });

  it("工具名清单缺失或非法时停用清单归空", () => {
    expect(normalizeAgent({ disabledTools: ["json.parse"] }, undefined).disabledTools).toEqual([]);
    expect(normalizeAgent({ disabledTools: ["json.parse"] }, "x").disabledTools).toEqual([]);
    // 清单为空时不做全关自愈（没有可比较的总数）
    expect(normalizeAgent({ disabledTools: [] }, []).disabledTools).toEqual([]);
  });

  it("disabledSkills 只做形状与去重约束（技能 id 由用户沉淀产生，设置页无法预校验存在性）", () => {
    expect(normalizeAgent({ disabledSkills: ["a", "a", " b ", "", 7, null] }, TOOLS).disabledSkills).toEqual(["a", " b "]);    expect(normalizeAgent({ disabledSkills: "x" }, TOOLS).disabledSkills).toEqual([]);
    // 全是技能被关掉也不报错：技能是可选增强，不是可执行能力（与「全关工具」不同）
    expect(normalizeAgent({ disabledSkills: ["a", "b"] }, TOOLS).disabledSkills).toEqual(["a", "b"]);
  });
});