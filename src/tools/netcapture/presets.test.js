// 已知应用的启动怪癖识别。
//
// 这张表存在的理由：不同应用开调试端口的办法不同，而那是应用内部实现，
// 不该让用户去记。用户视角里它们长得一模一样（"点启动"），
// 要求他分辨「这个吃参数、那个只认环境变量」是不合理的。
import { describe, expect, it } from "vitest";
import { envTextFor, matchPreset, needsEnv, PRESETS, shouldPassArgs } from "./presets.js";

describe("按可执行文件名识别应用", () => {
  it("认得 WorkBuddy（只认环境变量的那一个）", () => {
    const p = matchPreset("E:\\develop-lcb\\apps\\workbuddy\\WorkBuddy.exe");
    expect(p?.id).toBe("workbuddy");
    expect(needsEnv(p)).toBe(true);
    expect(shouldPassArgs(p)).toBe(false);
  });

  it("认得 Qoder CN（吃命令行参数的那一个）", () => {
    const p = matchPreset("E:\\develop-lcb\\apps\\Qoder CN\\.qoder-versions\\0.4.3\\Qoder CN.exe");
    expect(p?.id).toBe("qoder");
    expect(needsEnv(p)).toBe(false);
    expect(shouldPassArgs(p)).toBe(true);
  });

  it("只看文件名，不看装在哪个目录", () => {
    expect(matchPreset("D:\\software\\WorkBuddy.exe")?.id).toBe("workbuddy");
    expect(matchPreset("C:\\a\\b\\WorkBuddy.exe")?.id).toBe("workbuddy");
  });

  it("认不出来返回 null，交给通用做法，而不是硬套一个预设", () => {
    expect(matchPreset("C:\\x\\SomeOtherApp.exe")).toBeNull();
    expect(matchPreset("")).toBeNull();
    expect(matchPreset(undefined)).toBeNull();
  });
});

describe("自动生成环境变量", () => {
  const wb = PRESETS.find((p) => p.id === "workbuddy");

  it("WorkBuddy 得到它自己写死的那个变量名", () => {
    expect(envTextFor(wb, 9223)).toBe("WORKBUDDY_REMOTE_DEBUGGING_PORT=9223");
  });

  it("不需要环境变量的应用给空串，不留无意义的行", () => {
    const qoder = PRESETS.find((p) => p.id === "qoder");
    expect(envTextFor(qoder, 9223)).toBe("");
  });

  it("端口不合法就不生成——宁可不填，也不填一个应用绑不上的值", () => {
    for (const bad of [0, -1, 70000, 1.5, "abc", null, undefined]) {
      expect(envTextFor(wb, bad), String(bad)).toBe("");
    }
  });

  it("端口变化时文本跟着变（用户改了端口不会留下对不上的旧值）", () => {
    expect(envTextFor(wb, 9224)).toBe("WORKBUDDY_REMOTE_DEBUGGING_PORT=9224");
  });
});

describe("预设表本身", () => {
  it("每个预设都有 id / 名称 / 匹配规则，且 id 不重复", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PRESETS) {
      expect(p.id, p.id).toBeTruthy();
      expect(p.label, p.id).toBeTruthy();
      expect(p.exe instanceof RegExp, p.id).toBe(true);
      // 认出来了就得说清楚它的怪癖，否则用户遇到失败仍然一头雾水
      if (needsEnv(p)) expect(p.envKey, p.id).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
  });

  it("每个预设都带一句说明——认出来却不解释，等于没认出来", () => {
    for (const p of PRESETS) expect(p.note, p.id).toBeTruthy();
  });
});
