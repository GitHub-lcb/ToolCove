// 敏感配置加解密的形状约定：桌面 Rust 与浏览器实现返回裸字符串，安卓桥返回 {cipher}/{plain}。
// 只按裸串拼接时，手机端会把 AI Key 存成 "enc:[object Object]"——再也解不回来。
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("./platform/invoke.js", () => ({ invoke: (...args) => invoke(...args) }));

import { decryptValue, encryptValue } from "./secure.js";

beforeEach(() => invoke.mockReset());

describe("encryptValue", () => {
  it("安卓桥返回 {cipher} 时取字段，不是拼出 [object Object]", async () => {
    invoke.mockResolvedValueOnce({ cipher: "C1PH3R" });
    expect(await encryptValue("sk-secret")).toBe("enc:C1PH3R");
    expect(invoke).toHaveBeenCalledWith("encrypt_text", { plain: "sk-secret" });
  });

  it("桌面/浏览器返回裸字符串时照常可用", async () => {
    invoke.mockResolvedValueOnce("C1PH3R");
    expect(await encryptValue("sk-secret")).toBe("enc:C1PH3R");
  });

  it("没有密文就抛错，绝不降级成明文落盘", async () => {
    invoke.mockResolvedValueOnce({});
    await expect(encryptValue("sk-secret")).rejects.toThrow();
    invoke.mockResolvedValueOnce("");
    await expect(encryptValue("sk-secret")).rejects.toThrow();
  });

  it("已加密的值原样返回（不二次加密）", async () => {
    expect(await encryptValue("enc:already")).toBe("enc:already");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("decryptValue", () => {
  it("安卓桥返回 {plain} 时取字段", async () => {
    invoke.mockResolvedValueOnce({ plain: "sk-secret" });
    expect(await decryptValue("enc:C1PH3R")).toBe("sk-secret");
    expect(invoke).toHaveBeenCalledWith("decrypt_text", { cipher: "C1PH3R" });
  });

  it("裸字符串与明文兼容", async () => {
    invoke.mockResolvedValueOnce("sk-secret");
    expect(await decryptValue("enc:C1PH3R")).toBe("sk-secret");
    expect(await decryptValue("plain-old-data")).toBe("plain-old-data");
  });
});
