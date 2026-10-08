// read.checkedIn 支持条件选择器 + 状态词。
//
// 起因是一次**真实漏签**：工具读顶层 claimable（语义含糊）判成「已签」并跳过，
// 而那条活动自己的 claimStatus 当时是 CLAIMABLE。
// 顶层汇总字段和「某一条活动的真实状态」不是一回事，能用后者就别用前者。
import { describe, expect, it } from "vitest";
import { classifyStatus, OUTCOME } from "./classify.js";
import { validateDescriptor } from "./descriptor.js";
import { toTriState } from "./paths.js";

// 实测响应形状（Qoder 每日签到接口）
const canClaim = {
  uid: "u1",
  showCampaign: true,
  claimable: true,
  campaigns: [
    { campaignId: "01a0f1cd-945c-7217-b373-f62e70da792d", campaignKey: "act-20260930-664", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE" },
    { campaignId: "01a05bbf-5668-7031-83d6-91545f97ec05", campaignKey: "act-20260901-922", actionType: "VIEW_DETAILS", claimStatus: "CLAIMED" },
  ],
};

const alreadyClaimed = {
  ...canClaim,
  claimable: false,
  campaigns: [canClaim.campaigns[0] && { ...canClaim.campaigns[0], claimStatus: "CLAIMED" }, canClaim.campaigns[1]],
};

const SELECTOR = { path: "campaigns", where: { actionType: "CLAIM_BENEFIT" }, pick: "claimStatus" };
const resp = (body) => ({ ok: true, status: 200, text: JSON.stringify(body) });

describe("状态词归一化", () => {
  it("认「已领取」类状态词", () => {
    for (const word of ["CLAIMED", "claimed", "done", "finished", "received"]) {
      expect(toTriState(word), word).toBe(true);
    }
  });

  it("认「可领取」类状态词", () => {
    for (const word of ["CLAIMABLE", "claimable", "available", "pending", "todo"]) {
      expect(toTriState(word), word).toBe(false);
    }
  });

  it("unclaimed 不能被当成 claimed —— 结尾一样，含义正好相反", () => {
    // 用 includes 判断就会在这里翻车，且翻得很安静
    expect(toTriState("unclaimed")).toBe(false);
    expect(toTriState("not_claimed")).toBe(false);
  });

  it("看不懂的词仍然是 undefined，不会被猜成 false 然后去签", () => {
    expect(toTriState("WEIRD_STATE")).toBeUndefined();
  });
});

describe("用条件选择器读 checkedIn", () => {
  const read = { checkedIn: SELECTOR };

  it("活动可领时判为「还没签」", () => {
    const r = classifyStatus(resp(canClaim), read);
    expect(r.checkedIn).toBe(false);
    expect(r.outcome).toBe(OUTCOME.NEEDED);
  });

  it("活动已领时判为「已签」", () => {
    const r = classifyStatus(resp(alreadyClaimed), read);
    expect(r.checkedIn).toBe(true);
    expect(r.outcome).toBe(OUTCOME.ALREADY);
  });

  it("只看那条活动的状态，不看顶层汇总字段", () => {
    // 顶层 claimable 与活动状态不一致时，以活动状态为准。
    // 实测顶层字段会给出误导性的值——这正是当初漏签的原因。
    const misleading = { ...canClaim, claimable: false }; // 顶层说不可领，活动说可领
    expect(classifyStatus(resp(misleading), read).outcome).toBe(OUTCOME.NEEDED);
    expect(classifyStatus(resp(misleading), { checkedIn: "claimable", checkedInInvert: true }).outcome).toBe(OUTCOME.ALREADY);
  });

  it("选不中时是 undefined（无法判定），不会瞎猜成 false 就去签", () => {
    const noMatch = { campaigns: [{ actionType: "OTHER", claimStatus: "CLAIMED" }] };
    const r = classifyStatus(resp(noMatch), read);
    expect(r.checkedIn).toBeUndefined();
    expect(r.outcome).toBe(OUTCOME.UNKNOWN);
  });
});

describe("描述校验接受选择器形态", () => {
  const base = {
    key: "qoder",
    label: "Qoder",
    baseUrl: "https://openapi.qoder.com.cn",
    status: { method: "GET", path: "/sash/api/v1/me/campaigns", headers: [] },
    checkin: { method: "POST", path: "/sash/api/v1/me/campaigns/x/claim", headers: [] },
    read: { checkedIn: SELECTOR },
  };

  it("对象形态的 checkedIn 通过校验", () => {
    const { ok, errors } = validateDescriptor(base, { existingKeys: [] });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it("选择器里的路径写错时能指出来", () => {
    const { ok, errors } = validateDescriptor({ ...base, read: { checkedIn: { path: "a..b", pick: "x" } } }, { existingKeys: [] });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.code === "pathSyntax")).toBe(true);
  });

  it("归一化后对象形态**不会**被 String() 变成 [object Object]", () => {
    const { value } = validateDescriptor(base, { existingKeys: [] });
    expect(value.read.checkedIn).toEqual(SELECTOR);
  });

  it("字符串形态照样能用，老配置不受影响", () => {
    const { ok, value } = validateDescriptor({ ...base, read: { checkedIn: "data.checkedIn" } }, { existingKeys: [] });
    expect(ok).toBe(true);
    expect(value.read.checkedIn).toBe("data.checkedIn");
  });
});
