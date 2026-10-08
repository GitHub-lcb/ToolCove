import { describe, expect, it } from "vitest";
import { classifyStatus, OUTCOME } from "./classify.js";
import { EXTRACT_ERROR, extractValue, placeholdersIn, resolvePath } from "./extract.js";

// 用实测拿到的真实响应形状（Qoder 每日签到接口），而不是编一个理想化的样本——
// 选择器能不能用，取决于真实数据里那个数组长什么样。
const qoderStatus = {
  uid: "01a07ef4-5b38-7313-88a6-41faf384d9f4",
  showCampaign: true,
  claimable: false,
  campaigns: [
    {
      campaignId: "01a0f1cc-d06c-7d4c-8ea0-4b52b24e94a5",
      campaignKey: "act-20260930-295",
      actionType: "CLAIM_BENEFIT",
      claimStatus: "CLAIMED",
      benefit: { kind: "CREDITS", amount: 100 },
    },
    {
      campaignId: "01a05bbf-5668-7031-83d6-91545f97ec05",
      campaignKey: "act-20260901-922",
      actionType: "VIEW_DETAILS",
      claimStatus: "CLAIMED",
    },
  ],
};

describe("extractValue 取值", () => {
  it("点路径取值", () => {
    expect(extractValue(qoderStatus, "uid")).toEqual({ ok: true, value: "01a07ef4-5b38-7313-88a6-41faf384d9f4" });
  });

  it("在数组里按条件找到第一条再取字段——这正是每天变化的 campaignId", () => {
    const got = extractValue(qoderStatus, {
      path: "campaigns",
      where: { actionType: "CLAIM_BENEFIT" },
      pick: "campaignId",
    });
    expect(got).toEqual({ ok: true, value: "01a0f1cc-d06c-7d4c-8ea0-4b52b24e94a5" });
  });

  it("where 要求多个条件同时满足，不会误取到另一个活动", () => {
    const got = extractValue(qoderStatus, {
      path: "campaigns",
      where: { actionType: "VIEW_DETAILS", campaignKey: "act-20260901-922" },
      pick: "campaignId",
    });
    expect(got.value).toBe("01a05bbf-5668-7031-83d6-91545f97ec05");
  });

  it("条件匹配不到就明确报错，而不是取第一条", () => {
    const got = extractValue(qoderStatus, { path: "campaigns", where: { actionType: "NOT_EXIST" }, pick: "campaignId" });
    expect(got.ok).toBe(false);
    expect(got.error).toBe(EXTRACT_ERROR.SELECTOR_NO_MATCH);
  });

  it("类型必须严格相等，'1' 不等于 1（否则会误命中）", () => {
    const got = extractValue({ list: [{ n: 1 }, { n: "1" }] }, { path: "list", where: { n: "1" }, pick: "n" });
    expect(got.value).toBe("1");
  });

  it("path 指向的不是数组时报错，不静默返回 undefined", () => {
    expect(extractValue(qoderStatus, { path: "uid", pick: "x" }).error).toBe(EXTRACT_ERROR.SELECTOR_NOT_ARRAY);
  });

  it("含危险字符的取值被拒——这是拼进路径前的最后一道闸", () => {
    for (const bad of ["a/b", "a?b=1", "a#b", "a b", "a\\b", "//evil.com", "a/../b"]) {
      const got = extractValue({ v: bad }, "v");
      expect(got.ok, bad).toBe(false);
      expect(got.error, bad).toBe(EXTRACT_ERROR.VALUE_UNSAFE);
    }
  });

  it("超长取值被拒", () => {
    expect(extractValue({ v: "x".repeat(200) }, "v").error).toBe(EXTRACT_ERROR.VALUE_UNSAFE);
  });

  it("取不到值与取到 null 一样报错", () => {
    expect(extractValue({}, "nope").error).toBe(EXTRACT_ERROR.VALUE_MISSING);
    expect(extractValue({ v: null }, "v").error).toBe(EXTRACT_ERROR.VALUE_MISSING);
  });

  it("非法选择器语法不抛异常", () => {
    expect(extractValue(qoderStatus, "a..b").error).toBe(EXTRACT_ERROR.SELECTOR_SYNTAX);
    expect(extractValue(qoderStatus, "__proto__.x").error).toBe(EXTRACT_ERROR.SELECTOR_SYNTAX);
  });
});

describe("placeholdersIn 占位符解析", () => {
  it("取出路径里用到的名字并去重", () => {
    expect(placeholdersIn("/a/${x}/b/${y}/${x}").sort()).toEqual(["x", "y"]);
    expect(placeholdersIn("/a/b")).toEqual([]);
  });
});

describe("checkedInInvert 取反", () => {
  // Qoder 的顶层 claimable 是「可以领」而不是「已经领」。
  // 不取反就会在恰好该签的那天判成「已签」并跳过，而且全程不报错。
  const claimableTrue = { ok: true, status: 200, text: JSON.stringify({ claimable: true }) };
  const claimableFalse = { ok: true, status: 200, text: JSON.stringify({ claimable: false }) };

  it("不取反时，true 直接读成「已签」", () => {
    expect(classifyStatus(claimableTrue, { checkedIn: "claimable" }).checkedIn).toBe(true);
  });

  it("取反后 true 读成「还没签」——该去签的时候就会去签", () => {
    expect(classifyStatus(claimableTrue, { checkedIn: "claimable", checkedInInvert: true }).checkedIn).toBe(false);
  });

  it("取反后 false 读成「已签」，会跳过", () => {
    expect(classifyStatus(claimableFalse, { checkedIn: "claimable", checkedInInvert: true }).checkedIn).toBe(true);
  });

  it("取反不影响「读不出来」：仍然是 undefined，不会被取反成 false", () => {
    const r = classifyStatus({ ok: true, status: 200, text: "{}" }, { checkedIn: "claimable", checkedInInvert: true });
    expect(r.checkedIn).toBeUndefined();
    expect(r.outcome).toBe(OUTCOME.UNKNOWN);
  });

  it("没有该字段时视为默认不取反，老配置行为不变", () => {
    expect(classifyStatus(claimableTrue, { checkedIn: "claimable" }).checkedIn).toBe(true);
  });
});

describe("resolvePath 路径拼装", () => {
  const pathFrom = { campaignId: { path: "campaigns", where: { actionType: "CLAIM_BENEFIT" }, pick: "campaignId" } };

  it("用真实响应把模板拼成可用的路径", () => {
    const got = resolvePath("/sash/api/v1/me/campaigns/${campaignId}/claim", pathFrom, qoderStatus);
    expect(got).toEqual({ ok: true, path: "/sash/api/v1/me/campaigns/01a0f1cc-d06c-7d4c-8ea0-4b52b24e94a5/claim" });
  });

  it("没有占位符时原样返回（老配置不受影响）", () => {
    expect(resolvePath("/sash/api/v1/me/campaigns", undefined, qoderStatus)).toEqual({ ok: true, path: "/sash/api/v1/me/campaigns" });
  });

  it("同一个占位符出现多次全部替换", () => {
    const got = resolvePath("/${id}/x/${id}", { id: "uid" }, qoderStatus);
    expect(got.path).toBe("/01a07ef4-5b38-7313-88a6-41faf384d9f4/x/01a07ef4-5b38-7313-88a6-41faf384d9f4");
  });

  it("取不到就失败，绝不返回半成品路径", () => {
    const got = resolvePath("/a/${campaignId}/claim", { campaignId: { path: "campaigns", where: { actionType: "NOPE" }, pick: "campaignId" } }, qoderStatus);
    expect(got.ok).toBe(false);
    expect(got.path).toBeUndefined();
  });

  it("声明了取值规则但路径里没用它，报错而不是默默忽略", () => {
    const got = resolvePath("/plain", { unused: "uid" }, qoderStatus);
    expect(got.error).toBe(EXTRACT_ERROR.PLACEHOLDER_UNUSED);
  });

  it("路径里有占位符却没声明取值规则，立刻报错", () => {
    const got = resolvePath("/a/${missing}/b", {}, qoderStatus);
    expect(got.error).toBe(EXTRACT_ERROR.PLACEHOLDER_MISSING);
    expect(got.detail).toBe("missing");
  });

  it("拼出来的路径仍必须是绝对路径且不能是协议相对", () => {
    // 就算单个值都合法，组合起来仍可能拼出 '//' —— 这是必须整体再校验的理由
    const got = resolvePath("${p}", { p: "uid" }, { uid: "//evil.com" });
    expect(got.ok).toBe(false);
  });
});
