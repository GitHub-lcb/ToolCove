// src/shared/errors.js 的纯函数单测（从原 508 行的 shared.test.js 按领域拆出来）。
import { describe, it, expect } from "vitest";
import { errText } from "./errors.js";
import { i18n } from "../i18n/index.js";describe("errText", () => {
  it("字符串原样返回", () => {
    expect(errText("boom")).toBe("boom");
  });
  it("Error 取 message", () => {
    expect(errText(new Error("bad"))).toBe("bad");
  });
  it("null 返回兜底文案", () => {
    expect(errText(null)).toBe(i18n.global.t("common.unknownError"));
  });
});
