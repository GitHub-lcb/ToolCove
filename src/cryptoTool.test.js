import { describe, expect, it } from "vitest";
import {
  calculateFileHashes,
  decryptAes,
  decryptRsa,
  digestText,
  encryptAes,
  encryptRsa,
  generatePassword,
  generateRsaKeyPair,
  getPasswordStrength,
  hmacText,
} from "./cryptoTool.js";

describe("digestText", () => {
  it("计算常用摘要的已知结果", async () => {
    await expect(digestText("hello", "MD5")).resolves.toBe("5d41402abc4b2a76b9719d911017c592");
    await expect(digestText("hello", "SHA-1")).resolves.toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    await expect(digestText("hello", "SHA-256")).resolves.toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("支持 Base64 输出", async () => {
    await expect(digestText("hello", "SHA-256", "base64"))
      .resolves.toBe("LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=");
  });
});

describe("hmacText", () => {
  it("计算 RFC 风格的 HMAC-SHA256", async () => {
    await expect(hmacText("The quick brown fox jumps over the lazy dog", "key", "SHA-256"))
      .resolves.toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });
});

describe("AES-GCM", () => {
  it("使用口令加密并解密 UTF-8 文本", async () => {
    const encrypted = await encryptAes("研发数据 123", "correct horse battery staple", 10_000);
    const payload = JSON.parse(encrypted);
    expect(payload).toMatchObject({ v: 1, alg: "AES-256-GCM", kdf: "PBKDF2-SHA256", iterations: 10_000 });
    expect(payload.salt).toBeTruthy();
    expect(payload.iv).toBeTruthy();
    await expect(decryptAes(encrypted, "correct horse battery staple")).resolves.toBe("研发数据 123");
    await expect(decryptAes(encrypted, "wrong password")).rejects.toThrow("解密失败");
  });
});

describe("RSA-OAEP", () => {
  it("生成 PEM 密钥并完成加解密", async () => {
    const keys = await generateRsaKeyPair(2048);
    expect(keys.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(keys.privateKey).toContain("BEGIN PRIVATE KEY");
    const encrypted = await encryptRsa("secret", keys.publicKey);
    await expect(decryptRsa(encrypted, keys.privateKey)).resolves.toBe("secret");
  });
});

describe("calculateFileHashes", () => {
  it("增量计算文件的多个摘要", async () => {
    const file = new Blob(["hello"]);
    const result = await calculateFileHashes(file, ["MD5", "SHA-256"], { chunkSize: 2 });
    expect(result).toEqual({
      MD5: "5d41402abc4b2a76b9719d911017c592",
      "SHA-256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
  });
});

describe("generatePassword", () => {
  it("按选定字符集生成密码并确保每类至少出现一次", () => {
    const value = generatePassword({ length: 32, uppercase: true, lowercase: true, numbers: true, symbols: true });
    expect(value).toHaveLength(32);
    expect(value).toMatch(/[A-Z]/);
    expect(value).toMatch(/[a-z]/);
    expect(value).toMatch(/[0-9]/);
    expect(value).toMatch(/[^A-Za-z0-9]/);
  });

  it("排除易混淆字符并返回强度信息", () => {
    const value = generatePassword({ length: 24, uppercase: true, lowercase: true, numbers: true, symbols: false, excludeAmbiguous: true });
    expect(value).not.toMatch(/[Il1O0o]/);
    expect(getPasswordStrength(value, 52)).toMatchObject({ label: "强", entropy: 137 });
    expect(() => generatePassword({ length: 12, uppercase: false, lowercase: false, numbers: false, symbols: false })).toThrow("字符集");
  });
});
