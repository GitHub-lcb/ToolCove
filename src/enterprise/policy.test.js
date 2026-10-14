import { describe, expect, it } from "vitest";
import {
  POLICY_KEY,
  RISK_LEVELS,
  RISK_RANK,
  applyPolicyToActions,
  applyPolicyToTools,
  normalizePolicy,
  policyAllowsRisk,
  policyAllowsTool,
} from "./policy.js";

describe("normalizePolicy", () => {
  it("空 / 非法输入回退为空策略（不限制）", () => {
    for (const raw of [undefined, null, [], "x", 1, true, {}]) {
      expect(normalizePolicy(raw)).toEqual({ disabledTools: [], maxRisk: null });
    }
  });

  it("disabledTools 去空、去重、去首尾空白，非字符串项丢弃", () => {
    expect(normalizePolicy({ disabledTools: ["db", "", "  ", "db", " file ", 1, null, {}] }).disabledTools).toEqual(["db", "file"]);
    expect(normalizePolicy({ disabledTools: "db" }).disabledTools).toEqual([]);
  });

  it("maxRisk 只接受四个枚举或 null", () => {
    for (const level of RISK_LEVELS) expect(normalizePolicy({ maxRisk: level }).maxRisk).toBe(level);
    for (const bad of [undefined, null, "", "readonly", "database ", 1, {}]) {
      expect(normalizePolicy({ maxRisk: bad }).maxRisk).toBe(null);
    }
  });
});

describe("policyAllowsTool", () => {
  const policy = { disabledTools: ["db"], maxRisk: null };

  it("不在禁用清单即放行", () => {
    expect(policyAllowsTool(policy, "file")).toBe(true);
    expect(policyAllowsTool(policy, "json")).toBe(true);
  });

  it("在禁用清单即拒绝", () => {
    expect(policyAllowsTool(policy, "db")).toBe(false);
  });

  it("空 toolKey（引擎 / 数据动作无工具归属）不参与工具级禁用", () => {
    expect(policyAllowsTool(policy, "")).toBe(true);
    expect(policyAllowsTool(policy, undefined)).toBe(true);
  });
});

describe("policyAllowsRisk", () => {
  it("无上限时不限制（未知风险也放行）", () => {
    expect(policyAllowsRisk({ maxRisk: null }, "database")).toBe(true);
    expect(policyAllowsRisk({ maxRisk: undefined }, "nonsense")).toBe(true);
    expect(policyAllowsRisk({}, "read")).toBe(true);
  });

  it("设上限时按等级比较，边界（等于上限）包含在内", () => {
    const policy = { maxRisk: "read" };
    expect(policyAllowsRisk(policy, "transform")).toBe(true);
    expect(policyAllowsRisk(policy, "read")).toBe(true);
    expect(policyAllowsRisk(policy, "write")).toBe(false);
    expect(policyAllowsRisk(policy, "database")).toBe(false);
  });

  it("设上限时未知风险一律保守拒绝（判不出就在上限内，宁拒勿放）", () => {
    expect(policyAllowsRisk({ maxRisk: "database" }, "nonsense")).toBe(false);
    expect(policyAllowsRisk({ maxRisk: "bogus" }, "read")).toBe(false);
  });
});

describe("过滤函数", () => {
  it("applyPolicyToTools 按 key 过滤并返回新数组（不改入参）", () => {
    const tools = [{ key: "db" }, { key: "file" }, { key: "json" }];
    const out = applyPolicyToTools({ disabledTools: ["db"] }, tools);
    expect(out.map((tool) => tool.key)).toEqual(["file", "json"]);
    expect(out).not.toBe(tools);
    expect(tools).toHaveLength(3);
  });

  it("空策略等价于不限制", () => {
    const tools = [{ key: "db" }, { key: "file" }];
    expect(applyPolicyToTools(normalizePolicy(null), tools)).toHaveLength(2);
    expect(applyPolicyToActions(normalizePolicy(null), [{ toolKey: "db", risk: "database" }])).toHaveLength(1);
  });

  it("applyPolicyToActions 同时判工具禁用与风险上限", () => {
    const actions = [
      { name: "db.query", toolKey: "db", risk: "database" },
      { name: "file.write", toolKey: "file", risk: "write" },
      { name: "file.read", toolKey: "file", risk: "read" },
      { name: "json.parse", toolKey: "json", risk: "transform" },
    ];
    // 风险上限 read：剔除 write / database，保留 read / transform
    expect(applyPolicyToActions({ disabledTools: [], maxRisk: "read" }, actions).map((a) => a.name)).toEqual(["file.read", "json.parse"]);
    // 禁用 file 工具：剔除其全部动作，其余不受限
    expect(applyPolicyToActions({ disabledTools: ["file"], maxRisk: null }, actions).map((a) => a.name)).toEqual(["db.query", "json.parse"]);
    // 两条一起：file 被禁用 + 上限 read → 只剩 json 的 transform 动作
    expect(applyPolicyToActions({ disabledTools: ["file"], maxRisk: "read" }, actions).map((a) => a.name)).toEqual(["json.parse"]);
  });

  it("RISK_RANK 与 RISK_LEVELS 口径一致（升序），POLICY_KEY 稳定", () => {
    expect(RISK_LEVELS.map((level) => RISK_RANK[level])).toEqual([0, 1, 2, 3]);
    expect(POLICY_KEY).toBe("enterprisePolicy");
  });
});
