import { describe, expect, it } from "vitest";
import { runAction } from "./http.js";

const response = { ok: true, status: 200, text: "{}", error: "", retryAfterMs: 0 };

function harness(overrides = {}) {
  const calls = [];
  const deps = {
    request: async (req) => {
      calls.push(req);
      return response;
    },
    resolveCredential: async () => [["authorization", "Bearer 当场读的"]],
    ...overrides,
  };
  return { calls, deps };
}

const site = (extra) => ({
  key: "t",
  label: "T",
  baseUrl: "https://api.example.com",
  status: { method: "GET", path: "/s", headers: [["authorization", "Bearer 上次抓包抄的"]] },
  checkin: { method: "POST", path: "/c", headers: [] },
  read: { checkedIn: "ok", points: "", message: "", code: "", successCodes: null },
  ...extra,
});

const headerOf = (req, name) => req.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);

describe("credentialSource 注入", () => {
  it("用当场读到的凭据覆盖描述里那份，而不是多加一条同名头", async () => {
    const { calls, deps } = harness();
    await runAction(site({ credentialSource: "qoder-cn-local" }), "status", deps);
    expect(headerOf(calls[0], "authorization")).toEqual(["Bearer 当场读的"]);
  });

  it("两个动作各自取一次，取到的都是新鲜的", async () => {
    let n = 0;
    const { calls, deps } = harness({
      resolveCredential: async () => [["authorization", `Bearer 第${(n += 1)}次`]],
    });
    const descriptor = site({ credentialSource: "qoder-cn-local" });
    await runAction(descriptor, "status", deps);
    await runAction(descriptor, "checkin", deps);
    expect(calls.map((c) => headerOf(c, "authorization"))).toEqual([["Bearer 第1次"], ["Bearer 第2次"]]);
  });

  it("取不到凭据时一个请求都不发，并把原因带出去", async () => {
    const { calls, deps } = harness({ resolveCredential: async () => {
      throw new Error("没有找到 Qoder 的登录态文件");
    } });
    const got = await runAction(site({ credentialSource: "qoder-cn-local" }), "status", deps);
    expect(calls).toHaveLength(0);
    expect(got.credentialError).toContain("没有找到");
    expect(got.response.error).toBe("credential");
  });

  it("一个来源可以带多条头：TRAE 除 JWT 还要 x-device-id", async () => {
    const { calls, deps } = harness({
      resolveCredential: async () => [["authorization", "Cloud-IDE-JWT 新的"], ["x-device-id", "设备号新的"]],
    });
    const withDevice = site({
      credentialSource: "trae-cn-local",
      status: { method: "POST", path: "/s", headers: [["authorization", "旧的"], ["x-device-id", "旧的设备号"]] },
    });
    await runAction(withDevice, "status", deps);
    expect(headerOf(calls[0], "authorization")).toEqual(["Cloud-IDE-JWT 新的"]);
    expect(headerOf(calls[0], "x-device-id")).toEqual(["设备号新的"]);
  });

  it("没配 credentialSource 的站点行为不变", async () => {
    const { calls, deps } = harness({ resolveCredential: async () => {
      throw new Error("不该被调用");
    } });
    await runAction(site(), "status", deps);
    expect(headerOf(calls[0], "authorization")).toEqual(["Bearer 上次抓包抄的"]);
  });

  it("未知的凭据来源在校验层就被拒，不会带着空凭据发出去", async () => {
    const { calls, deps } = harness();
    const got = await runAction(site({ credentialSource: "nope" }), "status", deps);
    expect(calls).toHaveLength(0);
    expect(got.errors.map((e) => e.code)).toContain("credentialSourceUnknown");
  });
});
