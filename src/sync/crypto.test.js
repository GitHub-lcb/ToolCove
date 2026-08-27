import { describe, it, expect } from "vitest";
import {
  deriveMasterKey,
  cachedDerive,
  newSalt,
  encryptEnvelope,
  decryptEnvelope,
  obfuscateId,
  makeEnvelope,
  parseEnvelope,
} from "./crypto.js";

describe("deriveMasterKey（PBKDF2 600k）", () => {
  it("同盐同密码 → 同密钥；盐变 → 密钥变；密码变 → 密钥变", async () => {
    const salt = newSalt();
    const k1 = await deriveMasterKey("correct-horse-8ch", salt);
    const k2 = await deriveMasterKey("correct-horse-8ch", salt);
    expect(k1).toBe(k2);
    const k3 = await deriveMasterKey("correct-horse-8ch", newSalt());
    expect(k3).not.toBe(k1);
    const k4 = await deriveMasterKey("another-password", salt);
    expect(k4).not.toBe(k1);
  });

  it("密码过短/盐缺失 → 抛错", async () => {
    await expect(deriveMasterKey("short", newSalt())).rejects.toThrow();
    await expect(deriveMasterKey("long-enough-ok", "")).rejects.toThrow();
  });

  it("缓存派生：二次调用不重算（同输入同输出）", async () => {
    const salt = newSalt();
    const a = await cachedDerive("pass-12345678", salt);
    const b = await cachedDerive("pass-12345678", salt);
    expect(a).toBe(b);
  });
});

describe("加密信封往返与篡改", () => {
  it("加密 → 解密还原；nonce 随机（同 payload 两次密文不同）", async () => {
    const key = await deriveMasterKey("pw-12345678", newSalt());
    const payload = makeEnvelope("dev-1", Date.now(), { id: "r1", title: "你好" });
    const c1 = await encryptEnvelope(key, payload);
    const c2 = await encryptEnvelope(key, payload);
    expect(c1).not.toBe(c2);
    const plain = await decryptEnvelope(key, c1);
    expect(parseEnvelope(plain).record.title).toBe("你好");
  });

  it("篡改任一字节 → 解密失败", async () => {
    const key = await deriveMasterKey("pw-12345678", newSalt());
    const c = await encryptEnvelope(key, makeEnvelope("dev-1", 1, { id: "r1" }));
    const bits = c.split("");
    bits[10] = bits[10] === "A" ? "B" : "A";
    await expect(decryptEnvelope(key, bits.join(""))).rejects.toThrow("sync-bad-cipher");
  });

  it("错密钥 → 解密失败", async () => {
    const k1 = await deriveMasterKey("pw-12345678", newSalt());
    const k2 = await deriveMasterKey("pw-87654321", newSalt());
    const c = await encryptEnvelope(k1, makeEnvelope("dev-1", 1, { id: "r1" }));
    await expect(decryptEnvelope(k2, c)).rejects.toThrow("sync-bad-cipher");
  });
});

describe("ID 混淆", () => {
  it("稳定且互异；不可逆（长度固定 64 hex）", async () => {
    const key = await deriveMasterKey("pw-12345678", newSalt());
    const a = await obfuscateId(key, "record-uuid-1");
    const b = await obfuscateId(key, "record-uuid-1");
    const c = await obfuscateId(key, "record-uuid-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("信封结构", () => {
  it("make/parse 往返；坏结构抛错", () => {
    const env = makeEnvelope("dev-1", 123, { id: "r1" });
    expect(parseEnvelope(env)).toEqual({ deviceId: "dev-1", ts: 123, record: { id: "r1" } });
    expect(() => parseEnvelope("not-json")).toThrow();
    expect(() => parseEnvelope('{"deviceId":"x"}')).toThrow();
  });
});
