import { describe, expect, it } from "vitest";
import { validateDescriptor } from "../../checkin/descriptor.js";
import { buildDescriptor, guessReadPaths } from "./descriptor.js";
import { combineRequests, findDynamicSegment, looksLikeId, pickDiscriminator, selectorIsValid } from "./combine.js";

// 全部用**实测抓到的真实形状**。选择器推得对不对，完全取决于真实数据长什么样，
// 编一个理想化的样本只会验出「我写的算法符合我的想象」。
const statusRec = {
  id: 1,
  method: "GET",
  host: "openapi.qoder.com.cn",
  origin: "https://openapi.qoder.com.cn",
  path: "/sash/api/v1/me/campaigns",
  status: 200,
  requestHeaders: { Authorization: "Bearer real-token" },
  responseBody: {
    uid: "01a07ef4-5b38-7313-88a6-41faf384d9f4",
    showCampaign: true,
    claimable: false,
    campaigns: [
      {
        campaignId: "01a0f1cc-d06c-7d4c-8ea0-4b52b24e94a5",
        campaignKey: "act-20260930-295",
        actionType: "CLAIM_BENEFIT",
        startAt: 1791165600,
        endAt: 1791251940,
        claimStatus: "CLAIMED",
        benefit: { kind: "CREDITS", amount: 100 },
      },
      {
        campaignId: "01a05bbf-5668-7031-83d6-91545f97ec05",
        campaignKey: "act-20260901-922",
        actionType: "VIEW_DETAILS",
        startAt: 1788243600,
        endAt: 1793462340,
        claimStatus: "CLAIMED",
      },
    ],
  },
};

const checkinRec = {
  id: 2,
  method: "POST",
  host: "openapi.qoder.com.cn",
  origin: "https://openapi.qoder.com.cn",
  path: "/sash/api/v1/me/campaigns/01a0f1cc-d06c-7d4c-8ea0-4b52b24e94a5/claim",
  status: 200,
  requestHeaders: { Authorization: "Bearer real-token" },
  responseBody: { status: "CLAIMED", replayed: true },
};

const deps = { buildDescriptor, guessReadPaths };

describe("looksLikeId 识别「会变的 ID」", () => {
  it("UUID 这类明显是 ID 的段认得出来", () => {
    expect(looksLikeId("01a0f1cc-d06c-7d4c-8ea0-4b52b24e94a5")).toBe(true);
    expect(looksLikeId("campaign_20261005")).toBe(true);
  });

  it("API 固定段不能被误判成 ID——否则会把版本号也占位化", () => {
    for (const segment of ["sash", "api", "v1", "me", "campaigns", "claim", ""]) {
      expect(looksLikeId(segment), segment).toBe(false);
    }
  });
});

describe("pickDiscriminator 挑数组判别字段", () => {
  const container = { arrayPath: "campaigns", index: 0, element: statusRec.responseBody.campaigns[0], siblings: statusRec.responseBody.campaigns };

  it("选中枚举型的 actionType，而不是带日期的 campaignKey", () => {
    // campaignKey="act-20260930-295" 带日期，明天就变；claimStatus 两条都是 CLAIMED 不唯一。
    // 这两个坑不避开，配出来的 where 明天就指错活动。
    const picked = pickDiscriminator(container, "campaignId");
    expect(picked.where).toEqual({ actionType: "CLAIM_BENEFIT" });
  });

  it("不把要取的那个字段自己当成判别字段", () => {
    const picked = pickDiscriminator(container, "campaignId");
    expect(picked.field).not.toBe("campaignId");
  });

  it("数组里没有唯一字段时返回 null，而不是随便挑一个", () => {
    const siblings = [{ a: 1, b: "x" }, { a: 1, b: "x" }];
    expect(pickDiscriminator({ arrayPath: "list", element: siblings[0], siblings }, "a")).toBeNull();
  });
});

describe("findDynamicSegment 反推 pathFrom", () => {
  it("在真实数据上推出带 where 的选择器", () => {
    const found = findDynamicSegment(checkinRec.path, statusRec.responseBody);
    expect(found.placeholder).toBe("campaignId");
    expect(found.path).toBe("/sash/api/v1/me/campaigns/${campaignId}/claim");
    expect(found.selector).toEqual({ path: "campaigns", where: { actionType: "CLAIM_BENEFIT" }, pick: "campaignId" });
    expect(found.warning).toContain("推断");
  });

  it("路径里没有会变的段时返回 null，不硬造占位符", () => {
    expect(findDynamicSegment("/sash/api/v1/me/campaigns", statusRec.responseBody)).toBeNull();
  });

  it("响应里找不到对应值时不乱猜", () => {
    const other = "/sash/api/v1/me/campaigns/ffffffff-0000-1111-2222-333333333333/claim";
    expect(findDynamicSegment(other, statusRec.responseBody)).toBeNull();
  });

  it("选择器语法必须合法——不合法的写进配置只会被打回", () => {
    const found = findDynamicSegment(checkinRec.path, statusRec.responseBody);
    expect(selectorIsValid(found.selector)).toBe(true);
  });

  it("抓到的不是签到活动时，自动改用同组里像签到的那条——实测踩到过这个坑", () => {
    // 抓包时应用自动重放的是 VIEW_DETAILS（Pro 首月翻倍），不是每日签到（CLAIM_BENEFIT）。
    // 照它配下去签的是错的活动，而配置本身看起来完全正常、校验也过。
    const promoPath = "/sash/api/v1/me/campaigns/01a05bbf-5668-7031-83d6-91545f97ec05/claim";
    const found = findDynamicSegment(promoPath, statusRec.responseBody);
    expect(found.selector.where).toEqual({ actionType: "CLAIM_BENEFIT" });
    expect(found.selector.pick).toBe("campaignId");
    expect(found.warning).toContain("改用了后者");
  });

  it("改用之后路径里的占位符不变，取的自然是那条活动的 id", () => {
    const promoPath = "/sash/api/v1/me/campaigns/01a05bbf-5668-7031-83d6-91545f97ec05/claim";
    const found = findDynamicSegment(promoPath, statusRec.responseBody);
    expect(found.placeholder).toBe("campaignId");
    expect(found.path).toBe("/sash/api/v1/me/campaigns/${campaignId}/claim");
  });

  it("同组里没有像签到的活动时保留原值并警告，不瞎改", () => {
    const onlyPromo = {
      campaigns: [
        { campaignId: "01a05bbf-5668-7031-83d6-91545f97ec05", campaignKey: "act-20260901-922", actionType: "VIEW_DETAILS", claimStatus: "DONE" },
      ],
    };
    const found = findDynamicSegment("/x/01a05bbf-5668-7031-83d6-91545f97ec05/claim", onlyPromo);
    expect(found.selector.where).toEqual({ actionType: "VIEW_DETAILS" });
    expect(found.warning).toContain("不像是「签到/领取」类活动");
  });

  it("抓到的本来就是签到活动时不做任何替换", () => {
    const found = findDynamicSegment(checkinRec.path, statusRec.responseBody);
    expect(found.selector.where).toEqual({ actionType: "CLAIM_BENEFIT" });
    expect(found.warning).not.toContain("改用了后者");
    expect(found.warning).not.toContain("不像是");
  });
});

describe("combineRequests 拼出完整配置", () => {
  const out = combineRequests(checkinRec, statusRec, deps);

  it("status 动作来自查状态请求", () => {
    expect(out.descriptor.status.method).toBe("GET");
    expect(out.descriptor.status.path).toBe("/sash/api/v1/me/campaigns");
  });

  it("checkin 路径换成占位符并带上 pathFrom", () => {
    expect(out.descriptor.checkin.path).toBe("/sash/api/v1/me/campaigns/${campaignId}/claim");
    expect(out.descriptor.checkin.pathFrom.campaignId.where).toEqual({ actionType: "CLAIM_BENEFIT" });
  });

  it("read.checkedIn 用那条活动自己的状态字段，而不是顶层汇总布尔字段", () => {
    // 顶层 claimable 语义不准（实测在明明可领时给过 false，导致漏签），
    // 活动自己的 claimStatus 才是准确的。
    expect(out.descriptor.read.checkedIn).toEqual({
      path: "campaigns",
      where: { actionType: "CLAIM_BENEFIT" },
      pick: "claimStatus",
    });
    expect(out.descriptor.read.checkedInInvert).toBeUndefined();
  });

  it("用状态词后不再需要取反——状态词本身没有歧义", () => {
    expect(out.descriptor.read.checkedInInvert).toBeUndefined();
    expect(out.warnings.join()).toContain("汇总字段的语义常常不准");
  });

  it("活动里没有状态字段时退回原来的推断方式，并说明来源", () => {
    const noStatusField = {
      claimable: false,
      campaigns: [{ campaignId: "x".repeat(36), actionType: "CLAIM_BENEFIT" }],
    };
    const r = combineRequests(checkinRec, { ...statusRec, responseBody: noStatusField }, deps);
    expect(typeof r.descriptor.read.checkedIn).toBe("string");
  });

  it("凭据跟着走，两个动作都带上", () => {
    expect(out.descriptor.checkin.headers.some(([n]) => n === "Authorization")).toBe(true);
    expect(out.descriptor.status.headers.some(([n]) => n === "Authorization")).toBe(true);
  });

  it("**整份配置能过签到校验**——这是合并的意义所在", () => {
    // 单看领取请求是过不了的：它的响应里没有布尔型「已签」字段。
    expect(validateDescriptor(buildDescriptor(checkinRec).descriptor, { existingKeys: [] }).ok).toBe(false);
    const result = validateDescriptor(out.descriptor, { existingKeys: [] });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("把关键推断都写进警告，不假装全都确定", () => {
    const text = out.warnings.join("\n");
    expect(text).toContain("推断");           // pathFrom 是推的
    expect(text).toContain("查状态响应");      // read 换了来源
  });

  it("查状态响应里没有布尔字段时如实说，不留个假值", () => {
    const noBool = { ...statusRec, responseBody: { campaigns: [{ campaignId: "x".repeat(36), actionType: "CLAIM_BENEFIT" }] } };
    const r = combineRequests(checkinRec, noBool, deps);
    expect(r.warnings.join()).toContain("仍需手填");
  });
});
