import { describe, expect, it, vi } from "vitest";
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

  it("WorkBuddy CN 的 uuid / domain 头也是由凭据来源给的", async () => {
    const { calls, deps } = harness({
      resolveCredential: async () => [
        ["authorization", "Bearer 当场读的 JWT"],
        ["x-user-id", "602ed4a5"],
        ["x-domain", "copilot.tencent.com"],
      ],
    });
    await runAction(site({ credentialSource: "workbuddy-cn-local" }), "status", deps);
    expect(headerOf(calls[0], "authorization")).toEqual(["Bearer 当场读的 JWT"]);
    expect(headerOf(calls[0], "x-user-id")).toEqual(["602ed4a5"]);
    expect(headerOf(calls[0], "x-domain")).toEqual(["copilot.tencent.com"]);
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

// 上面的用例注入的是**假的** resolveCredential，只验证 http 层怎么合并请求头，
// 完全不经过 credentials.js 本身。umid 那组头正是在 credentials.js 里拼的，
// 所以下面这组直接测真实的 resolveCredential。
//
// mock 点选在 @tauri-apps/api/core（终端 IPC 层）而不是 platform/invoke.js：
// 本文件顶部已经 import 过 http.js → credentials.js，那个模块**早于** doMock 被求值并缓存，
// 再 doMock 也拦不住（这正是下面第一条曾经假绿的原因）。
// 顶层 vi.mock 是声明式的，会被提升到所有 import 之前，绕开这个时序问题。
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, Channel: vi.fn() }));

const { resolveCredential: realResolve } = await import("./credentials.js");

const machineAuth = {
  token: "dt-xxx",
  machineToken: "P1gA...",
  machineCode: "17bb5c13005160e526",
  machineType: "a0a8d75f91d7887247",
};
const mapOf = (headers) => new Map(headers.map(([n, v]) => [n.toLowerCase(), v]));

describe("凭据来源的真实取值", () => {
  it("Qoder 国际版带上 umid 机器身份三件套（缺了接口只回横幅，当轮签到活动不出现）", async () => {
    invokeMock.mockResolvedValue(machineAuth);
    const map = mapOf(await realResolve("qoder-intl-local"));
    expect(map.get("authorization")).toBe("Bearer dt-xxx");
    expect(map.get("cosy-machinetoken")).toBe("P1gA...");
    expect(map.get("cosy-machinecode")).toBe("17bb5c13005160e526");
    expect(map.get("cosy-machinetype")).toBe("a0a8d75f91d7887247");
  });

  it("读不到机器身份时只给 token，不抛错（退化成只看到横幅，而不是整个站点不可用）", async () => {
    // 抛错会把签到站点报成「不可用」，用户会去重装客户端——而真正的原因只是少了几个头。
    invokeMock.mockResolvedValue({ token: "dt-xxx", machineToken: "" });
    expect(await realResolve("qoder-intl-local")).toEqual([["authorization", "Bearer dt-xxx"]]);
  });

  it("国际版拿不到 token 时如实报错（而不是发一个空 token 的请求）", async () => {
    invokeMock.mockResolvedValue({ token: "" });
    await expect(realResolve("qoder-intl-local")).rejects.toThrow(/没有可用的 token/);
  });

  it("Qoder CN 不带 umid 头：CN 不受机器身份门控，多发反而可能干扰", async () => {
    invokeMock.mockResolvedValue({ token: "dt-yyy" });
    expect(await realResolve("qoder-cn-local")).toEqual([["authorization", "Bearer dt-yyy"]]);
  });
});
