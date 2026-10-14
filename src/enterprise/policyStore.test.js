// 策略缓存 + 持久化：用 mock invoke 抓落盘内容，断言「缓存立即生效 + 读盘填充 + 失败保留旧值」。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ calls: [], loadResult: [], loadError: false }));
vi.mock("../platform/invoke.js", () => ({
  invoke: vi.fn(async (command, args) => {
    mocked.calls.push({ command, args });
    if (command === "load_data") {
      if (mocked.loadError) throw new Error("boom");
      return mocked.loadResult;
    }
    return null;
  }),
}));

import { invoke } from "../platform/invoke.js";
import { POLICY_KEY } from "./policy.js";
import { __resetPolicy, getPolicySync, loadPolicy, setPolicy } from "./policyStore.js";

const saveCall = () => mocked.calls.filter((c) => c.command === "save_data").at(-1);

beforeEach(() => {
  __resetPolicy();
  mocked.calls.length = 0;
  mocked.loadResult = [];
  mocked.loadError = false;
  invoke.mockClear();
});

describe("策略缓存与持久化", () => {
  it("默认空策略（不限制）", () => {
    expect(getPolicySync()).toEqual({ disabledTools: [], maxRisk: null });
  });

  it("setPolicy 归一化后缓存立即生效并落盘", () => {
    const snap = setPolicy({ disabledTools: ["db", "db", "", " file "], maxRisk: "write" });
    expect(snap).toEqual({ disabledTools: ["db", "file"], maxRisk: "write" });
    expect(getPolicySync()).toEqual(snap);
    expect(saveCall().args).toEqual({ key: POLICY_KEY, data: { disabledTools: ["db", "file"], maxRisk: "write" } });
  });

  it("getPolicySync 返回副本：改它不会污染缓存", () => {
    setPolicy({ disabledTools: ["db"], maxRisk: null });
    const snap = getPolicySync();
    snap.disabledTools.push("file");
    expect(getPolicySync().disabledTools).toEqual(["db"]);
  });

  it("loadPolicy 读回对象填充缓存", async () => {
    mocked.loadResult = { disabledTools: ["file"], maxRisk: "read" };
    await loadPolicy();
    expect(getPolicySync()).toEqual({ disabledTools: ["file"], maxRisk: "read" });
  });

  it("loadPolicy 读到空值（缺失约定返回 []）保留既有缓存", async () => {
    setPolicy({ disabledTools: ["db"], maxRisk: "read" });
    mocked.loadResult = [];
    await loadPolicy();
    expect(getPolicySync()).toEqual({ disabledTools: ["db"], maxRisk: "read" });
  });

  it("loadPolicy 读失败保留既有缓存（瞬时失败不得悄悄放开已配好的门禁）", async () => {
    setPolicy({ disabledTools: ["db"], maxRisk: "read" });
    mocked.loadError = true;
    await expect(loadPolicy()).resolves.toEqual({ disabledTools: ["db"], maxRisk: "read" });
  });
});
