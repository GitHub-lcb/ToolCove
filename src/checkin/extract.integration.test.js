// 「先查状态 → 从响应里取值 → 用取到的值拼签到路径」这条链路的端到端验证。
//
// 全部用**实测拿到的真实响应形状**（Qoder 每日签到接口），而不是理想化的样本。
// 这条链路以前根本不存在：签到端点里带着每天都会变的 campaignId，
// 而旧的 runner 只把状态响应当成「判幂等」的依据，不会喂给下一步请求。
import { describe, expect, it } from "vitest";
import { OUTCOME } from "./classify.js";
import { validateDescriptor } from "./descriptor.js";
import { createCheckInRunner, TRIGGER } from "./runner.js";

const AT = new Date(2026, 9, 5, 12, 0, 0, 0).getTime();

// 实测：GET /sash/api/v1/me/campaigns 的响应（截取与判断有关的字段）
const statusBody = {
  uid: "01a07ef4-5b38-7313-88a6-41faf384d9f4",
  showCampaign: true,
  claimable: false,
  campaigns: [
    { campaignId: "01a0f1cc-d06c-7d4c-8ea0-4b52b24e94a5", campaignKey: "act-20260930-295", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED" },
    { campaignId: "01a05bbf-5668-7031-83d6-91545f97ec05", campaignKey: "act-20260901-922", actionType: "VIEW_DETAILS", claimStatus: "CLAIMED" },
  ],
};

const QODER = {
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
  read: { checkedIn: "claimStatus", points: "benefit.amount", message: "message", code: "", successCodes: null },
};

function harness(queue) {
  const calls = [];
  const runner = createCheckInRunner({
    now: () => AT,
    request: async (req) => {
      calls.push(req);
      return queue.shift() || { ok: true, status: 200, text: "{}", error: "", retryAfterMs: 0 };
    },
  });
  return { runner, calls };
}

const ok = (body) => ({ ok: true, status: 200, text: JSON.stringify(body), error: "", retryAfterMs: 0 });

describe("带动态路径的站点描述", () => {
  it("先校验通过：占位符与取值规则一一对应", () => {
    const { ok: passed, errors, value } = validateDescriptor(QODER);
    expect(errors).toEqual([]);
    expect(passed).toBe(true);
    expect(value.checkin.pathFrom.campaignId).toEqual({
      path: "campaigns",
      where: { actionType: "CLAIM_BENEFIT" },
      pick: "campaignId",
    });
  });

  it("从状态响应里取出当天 campaignId，签到请求真的发到了那个 ID 上", async () => {
    const { runner, calls } = harness([
      ok(statusBody),
      ok({ status: "CLAIMED", replayed: true, campaignId: "01a0f1cc-d06c-7d4c-8ea0-4b52b24e94a5" }),
    ]);
    const result = await runner.runSite(QODER, {}, { trigger: TRIGGER.MANUAL });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/sash/api/v1/me/campaigns");
    // 关键断言：路径里的占位符被换成了当天那个 ID，而不是原样带着 ${} 发出去
    expect(calls[1].url).toBe("https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/01a0f1cc-d06c-7d4c-8ea0-4b52b24e94a5/claim");
    expect(calls[1].url).not.toContain("${");
    expect(result.outcome).not.toBe(OUTCOME.BAD_DESCRIPTOR);
  });

  it("每天换一个 campaignId 也能跟着变——这正是不写死路径的意义", async () => {
    const tomorrow = { ...statusBody, campaigns: [{ ...statusBody.campaigns[0], campaignId: "aaaa1111-bbbb-2222-cccc-333344445555" }, statusBody.campaigns[1]] };
    const { runner, calls } = harness([ok(tomorrow), ok({ status: "CLAIMED" })]);
    await runner.runSite(QODER, {}, { trigger: TRIGGER.MANUAL });
    expect(calls[1].url).toContain("aaaa1111-bbbb-2222-cccc-333344445555");
  });

  it("取不到就只发查状态那一次请求，绝不拿空值拼路径", async () => {
    const noMatch = { ...statusBody, campaigns: [statusBody.campaigns[1]] }; // 只有 VIEW_DETAILS，没有 CLAIM_BENEFIT
    const { runner, calls } = harness([ok(noMatch), ok({ status: "CLAIMED" })]);
    const result = await runner.runSite(QODER, {}, { trigger: TRIGGER.MANUAL });

    expect(calls).toHaveLength(1);
    expect(result.outcome).toBe(OUTCOME.BAD_DESCRIPTOR);
    expect(result.error).toContain("selectorNoMatch");
  });

  it("状态响应是登录页时报「不是 JSON」，不再伪装成描述无效——同样不发畸形请求", async () => {
    const { runner, calls } = harness([
      { ok: true, status: 200, text: "<html>登录已失效</html>", error: "", retryAfterMs: 0 },
      ok({ status: "CLAIMED" }),
    ]);
    const result = await runner.runSite(QODER, {}, { trigger: TRIGGER.MANUAL });
    expect(calls).toHaveLength(1);
    // 取值的数据来源就是这次响应，它连 JSON 都不是，再跑 pathFrom 只会得出
    // 「你的描述写错了」这个假结论（真实原因：登录态过期）。
    expect(result.outcome).toBe(OUTCOME.NOT_JSON);
    expect(result.error).not.toContain("pathFrom:");
  });

  it("描述文件里占位符没有对应取值规则时，本地就拦下不发请求", async () => {
    const bad = { ...QODER, checkin: { ...QODER.checkin, pathFrom: undefined } };
    const { runner, calls } = harness([ok(statusBody), ok({ status: "CLAIMED" })]);
    const result = await runner.runSite(bad, {}, { trigger: TRIGGER.MANUAL });
    expect(calls).toHaveLength(0);
    expect(result.outcome).toBe(OUTCOME.BAD_DESCRIPTOR);
  });

  it("登录态失效（401 + 空响应）报「鉴权失效」，不再伪装成描述无效", async () => {
    // 这就是当初那个坑：token 过期后响应体是空的，取不到 campaigns，
    // 于是界面显示「描述无效」，让人去改一份根本没写错的配置。
    const { runner, calls } = harness([
      { ok: false, status: 401, text: "", error: "", retryAfterMs: 0 },
      ok({ status: "CLAIMED" }),
    ]);
    const result = await runner.runSite(QODER, {}, { trigger: TRIGGER.MANUAL });
    expect(calls).toHaveLength(1);
    expect(result.outcome).toBe(OUTCOME.AUTH);
    expect(result.error).toContain("401");
    expect(result.error).not.toContain("pathFrom:");
  });

  it("活动列表为空时报「没有可领的活动」，而不是描述无效", async () => {
    const { runner, calls } = harness([ok({ uid: "u", showCampaign: false, claimable: false, campaigns: [] }), ok({ status: "CLAIMED" })]);
    const result = await runner.runSite(QODER, {}, { trigger: TRIGGER.MANUAL });
    expect(calls).toHaveLength(1);
    expect(result.error).toBe("没有可领的活动");
    expect(result.outcome).not.toBe(OUTCOME.BAD_DESCRIPTOR);
  });

  it("凭据取不到时一个请求都不发，并说明原因", async () => {
    const calls = [];
    const local = createCheckInRunner({
      now: () => AT,
      request: async (req) => {
        calls.push(req);
        return ok(statusBody);
      },
      resolveCredential: async () => {
        throw new Error("没有找到 Qoder 的登录态文件");
      },
    });
    const result = await local.runSite({ ...QODER, credentialSource: "qoder-cn-local" }, {}, { trigger: TRIGGER.MANUAL });
    expect(calls).toHaveLength(0);
    expect(result.outcome).toBe(OUTCOME.AUTH);
    expect(result.error).toContain("没有找到 Qoder 的登录态文件");
  });

  it("没有 status 动作却有 pathFrom —— 保存时就判不成立，不留到定时任务里才炸", () => {
    const bad = { ...QODER, status: undefined };
    const { ok: passed, errors, value } = validateDescriptor(bad);
    expect(passed).toBe(false);
    expect(value).toBeNull();
    expect(errors.map((e) => e.code)).toContain("pathFromWithoutStatus");
  });

  it("校验不通过的站点一个请求都不发", async () => {
    const bad = { ...QODER, status: undefined };
    const { runner, calls } = harness([ok(statusBody), ok({ status: "CLAIMED" })]);
    const result = await runner.runSite(bad, {}, { trigger: TRIGGER.MANUAL });
    expect(calls).toHaveLength(0);
    expect(result.outcome).toBe(OUTCOME.BAD_DESCRIPTOR);
  });

  it("不用动态路径的旧站点行为不变", async () => {
    const legacy = {
      key: "wb",
      label: "WorkBuddy",
      baseUrl: "https://api.example.com",
      checkin: { method: "POST", path: "/v1/do", headers: [["Cookie", "sid=1"]] },
      read: { checkedIn: "data.checkedToday", points: "data.points", message: "message", code: "", successCodes: null },
    };
    const { runner, calls } = harness([ok({ status: "OK" })]);
    const result = await runner.runSite(legacy, {}, { trigger: TRIGGER.MANUAL });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.com/v1/do");
    expect(result.outcome).not.toBe(OUTCOME.BAD_DESCRIPTOR);
  });
});