import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./png.js";

describe("PNG 字节与 base64 互转", () => {
  it("往返一致（含空数组与全 0-255 字节）", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    for (const bytes of [new Uint8Array([]), all, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]) {
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("跨过 0x8000 分块边界仍然正确（借用 apply 上限的坑）", () => {
    const big = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 256;
    const decoded = base64ToBytes(bytesToBase64(big));
    expect(decoded.length).toBe(big.length);
    expect(decoded[0]).toBe(big[0]);
    expect(decoded[0x8000 - 1]).toBe(big[0x8000 - 1]);
    expect(decoded[0x8000]).toBe(big[0x8000]);
    expect(decoded[decoded.length - 1]).toBe(big[big.length - 1]);
  });

  it("base64 解出与 Buffer 结果一致", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("空输入不抛错", () => {
    expect(base64ToBytes("").length).toBe(0);
    expect(base64ToBytes(null).length).toBe(0);
  });
});
