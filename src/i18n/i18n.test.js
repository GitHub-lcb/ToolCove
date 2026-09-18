// i18n 基建单测：字典键对齐 + 初始语言决议 + 语言偏好应用
import { describe, it, expect } from "vitest";
import zh from "./zh-CN.json";
import en from "./en-US.json";
import { flatKeys, resolveInitialLocale, applyLocale, i18n } from "./index.js";
import { TOOLBOX_GROUPS, TOOLBOX_TOOLS } from "../toolboxTools.js";
import { ADVICE_KEYS } from "../tools/railTycoon.js";

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

  // 回归：词条里的裸花括号会被 vue-i18n 当成占位符定界符，编译期抛 SyntaxError，
  // 而且只在 t(key) 首次调用时爆——表现是「整块界面空白 / 点了没反应」，排查成本极高。
  // 需要输出字面量花括号写 {'{'} / {'}'}，需要输出反斜杠写 \\（单写 \ 会把后面的 { 转义掉）。
  // 例：`-d '{...}'` 必须写成 `-d '{'{'}...{'}'}'`。
  it("所有词条都能通过消息编译器（裸花括号会在这里抛错）", () => {
    const original = i18n.global.locale.value;
    try {
      for (const [locale, dict] of [["zh-CN", zh], ["en-US", en]]) {
        i18n.global.locale.value = locale;
        for (const key of flatKeys(dict)) {
          expect(() => i18n.global.t(key), `${locale} ${key}`).not.toThrow();
        }
      }
    } finally {
      i18n.global.locale.value = original;
    }
  });

  it("工具箱注册表引用的词条键都真实存在", () => {
    const keys = [
      ...TOOLBOX_GROUPS.flatMap((group) => [group.labelKey, group.descKey]),
      ...TOOLBOX_TOOLS.flatMap((tool) => [tool.labelKey, tool.descKey, tool.keywordsKey].filter(Boolean)),
    ];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(get(zh, key), `zh ${key}`).toBeDefined();
      expect(get(en, key), `en ${key}`).toBeDefined();
    }
  });
});

// 驾驶舱与完整版面都按 `toolbox.rail.adv.<key>.title / .act / .detail` 三段取文案，
// 缺了 title 不会抛错，只会静默渲染出空标题——所以单独锁一条。
describe("铁路大亨建议文案", () => {
  it("每条建议的标题在两种语言里都存在", () => {
    for (const key of ADVICE_KEYS) {
      expect(get(zh, `toolbox.rail.adv.${key}.title`), `zh ${key}`).toBeTruthy();
      expect(get(en, `toolbox.rail.adv.${key}.title`), `en ${key}`).toBeTruthy();
    }
  });

  it("建议条目写成三段结构，没有残留的单字符串", () => {
    for (const key of ADVICE_KEYS) {
      expect(typeof get(zh, `toolbox.rail.adv.${key}`), key).toBe("object");
      expect(typeof get(en, `toolbox.rail.adv.${key}`), key).toBe("object");
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
  // applyLocale 现在是异步的：字典按需加载（首屏只打包当前语言，另一种懒加载），
  // 所以「切到一个还没加载的语言」要先 await 加载完成。启动流程在 mount 之前 await 它，
  // 用户不会看到中间态。
  it("显式偏好即时切换 locale（字典未加载时先加载再切）", async () => {
    await expect(applyLocale("en-US")).resolves.toBe(true);
    expect(i18n.global.locale.value).toBe("en-US");
    expect(i18n.global.availableLocales).toContain("en-US");
    await applyLocale("zh-CN");
    expect(i18n.global.locale.value).toBe("zh-CN");
  });

  it("懒加载后的字典真的可用（不是只有一个 locale 名）", async () => {
    await applyLocale("en-US");
    expect(i18n.global.t("nav.agent")).toBeTruthy();
    expect(String(i18n.global.t("nav.agent"))).not.toBe("nav.agent");
  });

  it("跟随系统按 navigator 语言决议", async () => {
    await applyLocale("system");
    expect(["zh-CN", "en-US"]).toContain(i18n.global.locale.value);
  });

  it("非法偏好回退跟随系统，不抛错", async () => {
    await expect(applyLocale("fr-FR")).resolves.toBe(true);
    expect(["zh-CN", "en-US"]).toContain(i18n.global.locale.value);
  });
});

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}
