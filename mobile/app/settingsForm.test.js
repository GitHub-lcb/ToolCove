import { describe, expect, it } from "vitest";
import { applyAiForm, emptySettings, formFromSettings, matchPreset, normalizeBaseUrl, syncStatusKey, validateJoinInput, validateSettings } from "./settingsForm.js";

describe("formFromSettings", () => {
  it("缺字段时给安全默认值（不能把 undefined 塞进表单）", () => {
    const form = formFromSettings(undefined);
    expect(form.ai).toEqual({ baseUrl: "", apiKey: "", model: "", temperature: 0.7, reasoningEffort: "", enabled: false });
    expect(form.ui.locale).toBe("system");
    expect(form.ui.hiddenModules).toEqual([]);
  });

  it("load_data 对缺失文件返回数组——数组必须被当成空设置，而不是当对象读", () => {
    const form = formFromSettings([]);
    expect(form.ai.baseUrl).toBe("");
    expect(form.ui.density).toBe("compact");
  });

  it("保留合法值，纠正非法值", () => {
    const form = formFromSettings({
      ai: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", temperature: "hot", enabled: 1 },
      ui: { density: "weird", locale: "fr-FR", hiddenModules: "nope" },
    });
    expect(form.ai.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(form.ai.temperature).toBe(0.7); // 非数字回默认
    expect(form.ai.enabled).toBe(true);
    expect(form.ui.density).toBe("compact");
    expect(form.ui.locale).toBe("system");
    expect(form.ui.hiddenModules).toEqual([]);
  });

  it("apiKey 用解密后的值（磁盘上是密文，不能直接显示）", () => {
    const form = formFromSettings({ ai: { apiKey: "enc:abc" } }, { decryptedKey: "sk-real" });
    expect(form.ai.apiKey).toBe("sk-real");
  });

  it("hiddenModules 拷贝一份，不共享引用", () => {
    const source = { ui: { hiddenModules: ["rail"] } };
    const form = formFromSettings(source);
    form.ui.hiddenModules.push("db");
    expect(source.ui.hiddenModules).toEqual(["rail"]);
  });

  it("多套配置时读当前默认那套（与桌面端同一份 activeId）", () => {
    const form = formFromSettings({
      ai: {
        enabled: true,
        activeId: "b",
        profiles: [
          { id: "a", name: "主力", baseUrl: "https://a/v1", model: "ma", apiKey: "ka" },
          { id: "b", name: "备用", baseUrl: "https://b/v1", model: "mb", apiKey: "kb", temperature: 0.3, reasoningEffort: "low" },
        ],
      },
    });
    expect(form.ai).toMatchObject({ baseUrl: "https://b/v1", model: "mb", temperature: 0.3, reasoningEffort: "low", enabled: true });
  });
});

describe("applyAiForm", () => {
  it("只写回当前配置，其余配置与名字原样保留", () => {
    const stored = {
      enabled: true,
      activeId: "b",
      profiles: [
        { id: "a", name: "主力", baseUrl: "https://a/v1", apiKey: "ka", model: "ma", temperature: 0.7, reasoningEffort: "" },
        { id: "b", name: "备用", baseUrl: "https://b/v1", apiKey: "kb", model: "mb", temperature: 0.7, reasoningEffort: "" },
      ],
    };
    const ai = applyAiForm(stored, { enabled: true, baseUrl: "https://c/v1/", model: "mc", temperature: 0.2, reasoningEffort: "low" }, { apiKey: "kc" });
    expect(ai.activeId).toBe("b");
    expect(ai.profiles).toHaveLength(2);
    expect(ai.profiles[0]).toMatchObject({ id: "a", name: "主力", baseUrl: "https://a/v1", model: "ma", apiKey: "ka" });
    expect(ai.profiles[1]).toMatchObject({ id: "b", name: "备用", baseUrl: "https://c/v1", model: "mc", apiKey: "kc", reasoningEffort: "low", temperature: 0.2 });
    // 扁平镜像跟着当前配置走（旧代码/手改配置仍能读）
    expect(ai).toMatchObject({ baseUrl: "https://c/v1", model: "mc", apiKey: "kc" });
  });

  it("旧扁平配置保存后变成一条配置", () => {
    const ai = applyAiForm(
      { baseUrl: "https://a/v1", apiKey: "ka", model: "ma", temperature: 0.7 },
      { enabled: true, baseUrl: "https://b/v1", model: "mb", temperature: 0.5, reasoningEffort: "" },
      { apiKey: "kb" }
    );
    expect(ai.profiles).toHaveLength(1);
    expect(ai.profiles[0]).toMatchObject({ baseUrl: "https://b/v1", model: "mb", apiKey: "kb" });
    expect(ai.activeId).toBe("default");
  });
});

describe("validateSettings", () => {
  it("未启用 AI 时不校验任何字段（允许先存后配）", () => {
    expect(validateSettings({ ai: { enabled: false, baseUrl: "", apiKey: "", model: "" } }).ok).toBe(true);
  });

  it("启用后三个必填项都要有", () => {
    const { ok, errors } = validateSettings({ ai: { enabled: true, baseUrl: "", apiKey: "", model: "" } });
    expect(ok).toBe(false);
    expect(Object.keys(errors).sort()).toEqual(["apiKey", "baseUrl", "model"]);
  });

  it("地址必须带协议（写域名漏 http 是最常见的配置错误）", () => {
    const errors = validateSettings({ ai: { enabled: true, baseUrl: "api.deepseek.com/v1", apiKey: "k", model: "m" } }).errors;
    expect(errors.baseUrl).toBe("settings.errAiBase");
    expect(validateSettings({ ai: { enabled: true, baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "m" } }).ok).toBe(true);
  });

  it("温度必须是数字", () => {
    const errors = validateSettings({ ai: { enabled: true, baseUrl: "https://x/v1", apiKey: "k", model: "m", temperature: "abc" } }).errors;
    expect(errors.temperature).toBe("settings.errAiTemperature");
  });
});

describe("normalizeBaseUrl / matchPreset", () => {
  it("去掉末尾斜杠（否则会拼出 //chat/completions）", () => {
    expect(normalizeBaseUrl(" https://api.deepseek.com/v1/ ")).toBe("https://api.deepseek.com/v1");
  });

  it("预设匹配忽略大小写与末尾斜杠；匹配不上返回 null", () => {
    const presets = [{ key: "deepseek", baseUrl: "https://api.deepseek.com/v1" }];
    expect(matchPreset("https://API.DeepSeek.com/v1/", presets)?.key).toBe("deepseek");
    expect(matchPreset("https://my-own/v1", presets)).toBe(null);
    expect(matchPreset("", presets)).toBe(null);
  });
});

describe("syncStatusKey / validateJoinInput", () => {
  it("已知状态给对应文案键，未知状态也有说法（不能空白）", () => {
    // 键在 sync.* 命名空间下（桌面端就是这么放的）——写到 settings.* 会渲染出字面量
    expect(syncStatusKey("syncing")).toBe("sync.statusSyncing");
    expect(syncStatusKey("bogus")).toBe("sync.statusIdle");
    expect(syncStatusKey(undefined)).toBe("sync.statusIdle");
  });

  it("入伙三要素先本地拦，别等请求失败", () => {
    const { ok, errors } = validateJoinInput({ collectionId: "", code: " ", password: "" });
    expect(ok).toBe(false);
    expect(Object.keys(errors).sort()).toEqual(["code", "collectionId", "password"]);
    expect(validateJoinInput({ collectionId: "c", code: "123456", password: "p" }).ok).toBe(true);
  });
});

describe("emptySettings", () => {
  it("形状与桌面端一致（键名不同就会互相丢字段）", () => {
    const s = emptySettings();
    expect(Object.keys(s).sort()).toEqual(["ai", "ui"]);
    expect(s.ai).toHaveProperty("reasoningEffort");
    expect(s.ui).toHaveProperty("locale");
  });
});
