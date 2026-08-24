// i18n 基建单测：字典键对齐 + 初始语言决议 + 语言偏好应用
import { describe, it, expect } from "vitest";
import zh from "./zh-CN.json";
import en from "./en-US.json";
import { flatKeys, resolveInitialLocale, applyLocale, i18n } from "./index.js";

describe("i18n 字典", () => {
  it("中英文字典键集合完全一致", () => {
    const zhKeys = flatKeys(zh).sort();
    const enKeys = flatKeys(en).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("每个键的中英文值都非空", () => {
    for (const k of flatKeys(zh)) {
      expect(String(get(zh, k)).trim().length, `zh ${k}`).toBeGreaterThan(0);
      expect(String(get(en, k)).trim().length, `en ${k}`).toBeGreaterThan(0);
    }
  });
});

describe("初始语言决议", () => {
  it("设置显式指定优先", () => {
    expect(resolveInitialLocale("en-US", "zh-CN")).toBe("en-US");
  });
  it("跟随系统时按系统语言前缀匹配", () => {
    expect(resolveInitialLocale("system", "zh-CN")).toBe("zh-CN");
    expect(resolveInitialLocale("system", "en-US")).toBe("en-US");
    expect(resolveInitialLocale("system", "ja-JP")).toBe("en-US"); // 无匹配回退英文
  });
});

describe("应用语言偏好", () => {
  it("显式偏好即时切换 locale", () => {
    applyLocale("en-US");
    expect(i18n.global.locale.value).toBe("en-US");
    applyLocale("zh-CN");
    expect(i18n.global.locale.value).toBe("zh-CN");
  });

  it("跟随系统按 navigator 语言决议", () => {
    applyLocale("system");
    expect(["zh-CN", "en-US"]).toContain(i18n.global.locale.value);
  });

  it("非法偏好回退跟随系统，不抛错", () => {
    applyLocale("fr-FR");
    expect(["zh-CN", "en-US"]).toContain(i18n.global.locale.value);
  });
});

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}
