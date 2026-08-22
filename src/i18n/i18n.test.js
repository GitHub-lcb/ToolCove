// i18n 基建单测：字典键对齐 + 初始语言决议
import { describe, it, expect } from "vitest";
import zh from "./zh-CN.json";
import en from "./en-US.json";
import { flatKeys, resolveInitialLocale } from "./index.js";

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

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}
