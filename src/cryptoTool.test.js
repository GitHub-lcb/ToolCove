import { describe, expect, it } from "vitest";
import { i18n } from "./i18n/index.js";
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
  it("computes known results for common digests", async () => {
    await expect(digestText("hello", "MD5")).resolves.toBe("5d41402abc4b2a76b9719d911017c592");
    await expect(digestText("hello", "SHA-1")).resolves.toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    await expect(digestText("hello", "SHA-256")).resolves.toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("supports Base64 output", async () => {
    await expect(digestText("hello", "SHA-256", "base64"))
      .resolves.toBe("LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=");
  });
});

describe("hmacText", () => {
  it("computes RFC-style HMAC-SHA256", async () => {
    await expect(hmacText("The quick brown fox jumps over the lazy dog", "key", "SHA-256"))
      .resolves.toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });
});

describe("AES-GCM", () => {
  it("encrypts and decrypts UTF-8 text with passphrase", async () => {
    const encrypted = await encryptAes("secret data 123", "correct horse battery staple", 10_000);
    const payload = JSON.parse(encrypted);
    expect(payload).toMatchObject({ v: 1, alg: "AES-256-GCM", kdf: "PBKDF2-SHA256", iterations: 10_000 });
    expect(payload.salt).toBeTruthy();
    expect(payload.iv).toBeTruthy();
    await expect(decryptAes(encrypted, "correct horse battery staple")).resolves.toBe("secret data 123");
    await expect(decryptAes(encrypted, "wrong password")).rejects.toThrow(i18n.global.t("toolbox.crypto.errDecryptFailed"));
  });
});

describe("RSA-OAEP", () => {
  it("generates PEM keys and completes encrypt/decrypt", async () => {
    const keys = await generateRsaKeyPair(2048);
    expect(keys.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(keys.privateKey).toContain("BEGIN PRIVATE KEY");
    const encrypted = await encryptRsa("secret", keys.publicKey);
    await expect(decryptRsa(encrypted, keys.privateKey)).resolves.toBe("secret");
  });
});

describe("calculateFileHashes", () => {
  it("computes multiple digests incrementally", async () => {
    const file = new Blob(["hello"]);
    const result = await calculateFileHashes(file, ["MD5", "SHA-256"], { chunkSize: 2 });
    expect(result).toEqual({
      MD5: "5d41402abc4b2a76b9719d911017c592",
      "SHA-256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
  });
});

describe("generatePassword", () => {
  it("generates password with at least one char per selected set", () => {
    const value = generatePassword({ length: 32, uppercase: true, lowercase: true, numbers: true, symbols: true });
    expect(value).toHaveLength(32);
    expect(value).toMatch(/[A-Z]/);
    expect(value).toMatch(/[a-z]/);
    expect(value).toMatch(/[0-9]/);
    expect(value).toMatch(/[^A-Za-z0-9]/);
  });

  it("excludes ambiguous characters and reports strength", () => {
    const value = generatePassword({ length: 24, uppercase: true, lowercase: true, numbers: true, symbols: false, excludeAmbiguous: true });
    expect(value).not.toMatch(/[Il1O0o]/);
    expect(getPasswordStrength(value, 52)).toMatchObject({ label: i18n.global.t("toolbox.crypto.strengthStrong"), entropy: 137 });
    expect(() => generatePassword({ length: 12, uppercase: false, lowercase: false, numbers: false, symbols: false })).toThrow(i18n.global.t("toolbox.crypto.errNoCharset"));
  });
});
