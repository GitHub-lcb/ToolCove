import { describe, it, expect, vi } from "vitest";

vi.mock("./secure.js", () => ({
  encryptValue: vi.fn(async (value) => value && !value.startsWith("enc:") ? `enc:${value}` : value),
  decryptValue: vi.fn(async (value) => value?.startsWith("enc:") ? value.slice(4) : value),
}));
vi.mock("./toolboxStore.js", () => ({
  loadToolbox: vi.fn(),
  saveToolbox: vi.fn(),
  flushToolbox: vi.fn(async () => {}),
}));

import {
  isSensitiveName,
  protectDbConnections, restoreDbConnections,
  protectRequestState, restoreRequestState,
  protectRequestCollections, protectRequestEnvs,
} from "./secureToolbox.js";

describe("secureToolbox", () => {
  it("识别请求头和环境变量中的敏感名称", () => {
    ["Authorization", "auth", "Cookie", "X-API-Key", "access_token", "oauth_token", "clientSecret", "dbPassword"].forEach((name) => {
      expect(isSensitiveName(name)).toBe(true);
    });
    expect(isSensitiveName("Content-Type")).toBe(false);
  });

  it("数据库密码只在持久化副本中加密，并尊重不记住密码", async () => {
    const source = [
      { id: "1", password: "secret", rememberPwd: true },
      { id: "2", password: "temporary", rememberPwd: false },
    ];
    const stored = await protectDbConnections(source);
    expect(stored.map((c) => c.password)).toEqual(["enc:secret", ""]);
    expect(source[0].password).toBe("secret");
    await expect(restoreDbConnections(stored)).resolves.toEqual([
      { id: "1", password: "secret", rememberPwd: true },
      { id: "2", password: "", rememberPwd: false },
    ]);
  });

  it("请求标签只加密敏感 Header，读取后可恢复", async () => {
    const state = { tabs: [{ headers: [
      { key: "Authorization", value: "Bearer abc", on: true },
      { key: "Content-Type", value: "application/json", on: true },
    ] }] };
    const stored = await protectRequestState(state);
    expect(stored.tabs[0].headers.map((h) => h.value)).toEqual(["enc:Bearer abc", "application/json"]);
    expect(state.tabs[0].headers[0].value).toBe("Bearer abc");
    await expect(restoreRequestState(stored)).resolves.toEqual(state);
  });

  it("集合请求 Header 与敏感环境变量同样加密", async () => {
    const collections = [{ requests: [{ headers: [{ key: "Cookie", value: "sid=1" }] }] }];
    const envs = [{ vars: [{ key: "api_token", value: "abc" }, { key: "base_url", value: "https://example.com" }] }];
    expect((await protectRequestCollections(collections))[0].requests[0].headers[0].value).toBe("enc:sid=1");
    expect((await protectRequestEnvs(envs))[0].vars.map((v) => v.value)).toEqual(["enc:abc", "https://example.com"]);
  });

  it("保留 null 以便调用方识别并迁移旧存储", async () => {
    await expect(restoreRequestState(null)).resolves.toBeNull();
    await expect(protectRequestCollections(null)).resolves.toBeNull();
  });
});
