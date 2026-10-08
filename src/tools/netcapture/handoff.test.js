import { describe, expect, it } from "vitest";
import { buildDescriptor } from "./descriptor.js";
import { appendSite, evaluateAdd, HANDOFF, parseDescriptorObject } from "./handoff.js";

// 用真实抓到的 Qoder 领取请求当样本，而不是编一个理想化的对象。
const captured = {
  id: 7,
  method: "POST",
  host: "openapi.qoder.com.cn",
  origin: "https://openapi.qoder.com.cn",
  path: "/sash/api/v1/me/campaigns/01a0f1cc-d06c-7d4c-8ea0-4b52b24e94a5/claim",
  status: 200,
  requestHeaders: { Referer: "https://openapi.qoder.com.cn/growth-page/activity-iframe" },
  requestBody: null,
  responseBody: { status: "CLAIMED", replayed: true },
};

const existingSite = {
  key: "qoder",
  label: "Qoder CN（旧）",
  baseUrl: "https://openapi.qoder.com.cn",
  checkin: { method: "POST", path: "/old", headers: [] },
  read: { checkedIn: "x" },
};

const VALID = {
  key: "qoder",
  label: "Qoder CN",
  baseUrl: "https://openapi.qoder.com.cn",
  status: { method: "GET", path: "/sash/api/v1/me/campaigns", headers: [["Cookie", "sid=1"]] },
  checkin: {
    method: "POST",
    path: "/sash/api/v1/me/campaigns/${campaignId}/claim",
    pathFrom: { campaignId: { path: "campaigns", where: { actionType: "CLAIM_BENEFIT" }, pick: "campaignId" } },
    headers: [["Cookie", "sid=1"]],
  },
  read: { checkedIn: "claimable", checkedInInvert: true },
};

describe("只看领取请求生成不出完整配置（这是实测结论，不是测试凑数）", () => {
  it("领取响应里没有布尔型「已签」字段，生成器拒绝瞎填", () => {
    const built = buildDescriptor(captured);
    expect(built.valid).toBe(false);
    // 空着，并给出为什么——而不是塞一个看起来能用的假路径
    expect(built.descriptor.read.checkedIn).toBe("");
    expect(built.warnings.join()).toContain("checkedIn");
  });

  it("所以一键加入必须以用户编辑后的内容为准，不能拿生成器的输出直接存", () => {
    // 未经编辑的生成结果一定是无效的——真存下去，签到工具会在每次定时运行时
    // 因为缺 read.checkedIn 而判成 bad-descriptor，而且用户看不出是哪一步错的。
    expect(evaluateAdd(buildDescriptor(captured).descriptor, []).ok).toBe(false);
  });
});

describe("evaluateAdd 把编辑好的描述变成签到站点", () => {
  it("补齐必填项后可以通过", () => {
    const r = evaluateAdd(VALID, []);
    expect(r.ok).toBe(true);
    expect(r.site.baseUrl).toBe("https://openapi.qoder.com.cn");
  });

  it("key 已存在时拒绝，并明确说没有覆盖", () => {
    const r = evaluateAdd(VALID, [existingSite]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(HANDOFF.DUPLICATE);
    expect(r.site).toBeNull();
  });

  it("缺 read.checkedIn 时把校验错误原样带出去，界面才能指出是哪一条", () => {
    const r = evaluateAdd({ ...VALID, read: { checkedIn: "" } }, []);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(HANDOFF.INVALID);
    expect(r.errors.some((e) => e.field === "read.checkedIn")).toBe(true);
  });

  it("明文 http 的 baseUrl 被拒——凭据不能走明文", () => {
    const r = evaluateAdd({ ...VALID, baseUrl: "http://openapi.qoder.com.cn" }, []);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "urlNotHttps")).toBe(true);
  });

  it("路径里有占位符却没配 pathFrom 会被拒——否则明天就 404", () => {
    const noRule = { ...VALID, checkin: { method: "POST", path: "/a/${campaignId}/claim", headers: [] } };
    const r = evaluateAdd(noRule, []);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "placeholderMissing")).toBe(true);
  });

  it("已有站点不是数组时按空列表处理，不崩", () => {
    expect(evaluateAdd(VALID, undefined).ok).toBe(true);
  });

  it("返回的是副本，改它不会动到传入的对象", () => {
    const r = evaluateAdd(VALID, []);
    r.site.label = "改了";
    expect(VALID.label).toBe("Qoder CN");
  });
});

describe("parseDescriptorObject 解析描述框", () => {
  it("解析合法 JSON", () => {
    expect(parseDescriptorObject('{"key":"a"}')).toEqual({ key: "a" });
  });

  it("空文本、坏 JSON、数组都返回 null 而不是半个对象", () => {
    expect(parseDescriptorObject("")).toBeNull();
    expect(parseDescriptorObject("   ")).toBeNull();
    expect(parseDescriptorObject("{oops")).toBeNull();
    expect(parseDescriptorObject("[1,2]")).toBeNull();
    expect(parseDescriptorObject("null")).toBeNull();
  });
});

describe("appendSite 追加", () => {
  it("返回新数组且不动入参", () => {
    const before = [existingSite];
    const after = appendSite(before, { key: "new" });
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
  });

  it("空列表也能追加", () => {
    expect(appendSite(undefined, { key: "a" })).toEqual([{ key: "a" }]);
  });
});