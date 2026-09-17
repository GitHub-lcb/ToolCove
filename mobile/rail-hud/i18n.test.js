// 手机版字典与主程序字典的同步单测。
//
// i18n.gen.js 是从 src/i18n/{zh-CN,en-US}.json 的 toolbox.rail.* 子树**生成**的。
// 生成物一旦和源字典漂移（改了桌面版文案却忘了重新构建手机版），手机端会静静地显示旧文案——
// 没有任何报错，只有用户在手机上看到一句过时的话。这个文件就是那条护栏。
//
// 修法：node mobile/rail-hud/gen-i18n.mjs（或 npm run build:mobile）。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MESSAGES } from "./i18n.gen.js";
import zh from "../../src/i18n/zh-CN.json";
import en from "../../src/i18n/en-US.json";

const pick = (dict) => dict.toolbox.rail;

describe("手机版字典与主程序同步", () => {
  it("中文词条与 src/i18n/zh-CN.json 的 toolbox.rail 完全一致", () => {
    expect(MESSAGES["zh-CN"]).toEqual(pick(zh));
  });

  it("英文词条与 src/i18n/en-US.json 的 toolbox.rail 完全一致", () => {
    expect(MESSAGES["en-US"]).toEqual(pick(en));
  });

  it("生成物带「请勿手改」的头部说明与词条数", () => {
    const source = readFileSync(new URL("./i18n.gen.js", import.meta.url), "utf8");
    expect(source).toContain("自动生成");
    expect(source).toContain("MESSAGE_COUNT");
  });

  it("建议文案的三段结构与桌面版一致（title 必有）", () => {
    for (const locale of ["zh-CN", "en-US"]) {
      for (const [key, value] of Object.entries(MESSAGES[locale].adv)) {
        expect(typeof value.title, `${locale} adv.${key}.title`).toBe("string");
        expect(value.title.trim().length, `${locale} adv.${key}.title`).toBeGreaterThan(0);
      }
    }
  });
});
