// 工具窗口共用逻辑单测：独立窗口打开降级、加载失败原因文本（要直接展示给用户）。
import { describe, it, expect, vi, afterEach } from "vitest";
import { formatLoadErrorDetail } from "./toolWindow.js";

describe("formatLoadErrorDetail", () => {
  afterEach(() => vi.restoreAllMocks());

  it("错误消息与 Vue 的 info 用分隔符拼一行", () => {
    expect(formatLoadErrorDetail(new Error("Invalid token in placeholder"), "setup function")).toBe(
      "Invalid token in placeholder · setup function"
    );
  });

  it("字符串错误照常可用（动态 import 失败常抛字符串）", () => {
    expect(formatLoadErrorDetail("Failed to fetch dynamically imported module", "")).toBe(
      "Failed to fetch dynamically imported module"
    );
  });

  it("缺消息或 info 时不留下 undefined / 悬空分隔符", () => {
    expect(formatLoadErrorDetail(new Error(""), "render function")).toBe("render function");
    expect(formatLoadErrorDetail(new Error("boom"), undefined)).toBe("boom");
    expect(formatLoadErrorDetail(null, null)).toBe("");
    expect(formatLoadErrorDetail(undefined)).toBe("");
  });

  it("前后空白会被裁掉，避免面板里出现空行", () => {
    expect(formatLoadErrorDetail(new Error("  boom  "), "  setup function  ")).toBe("boom · setup function");
  });
});
