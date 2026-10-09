import { describe, expect, it } from "vitest";
import { classifyCheckIn, classifyStatus, OUTCOME } from "./classify.js";
import { BUILTIN_SITES, mergeBuiltinSites } from "./builtin.js";
import { validateDescriptor } from "./descriptor.js";
import { EXTRACT_ERROR, resolvePath } from "./extract.js";

const QODER = BUILTIN_SITES[0];

describe("内置站点描述", () => {
  it("每一个内置描述都必须自己校验得过", () => {
    for (const site of BUILTIN_SITES) {
      const { ok, errors } = validateDescriptor(site);
      expect(errors, `${site.key}: ${JSON.stringify(errors)}`).toEqual([]);
      expect(ok).toBe(true);
    }
  });

  it("不存任何凭据：token 由 credentialSource 当场读", () => {
    expect(QODER.credentialSource).toBeTruthy();
    for (const action of [QODER.status, QODER.checkin]) {
      const names = action.headers.map(([name]) => name.toLowerCase());
      expect(names).not.toContain("authorization");
      expect(names).not.toContain("cookie");
    }
  });

  it("每个动作都带 Cosy-ClientType：不带它接口会返回 200 + 空 campaigns", () => {
    // 少这个头不是「请求失败」，而是「请求成功但没有活动」——静默的错，最难发现的一种。
    for (const action of [QODER.status, QODER.checkin]) {
      expect(action.headers, action.path).toContainEqual(["Cosy-ClientType", "10"]);
    }
  });

  it("取的是「今天能领」的那个活动，不是「第一个 CLAIM_BENEFIT」", () => {
    const body = {
      campaigns: [
        { campaignId: "already-claimed", claimStatus: "CLAIMED" },
        { campaignId: "today-open", claimStatus: "CLAIMABLE" },
      ],
    };
    const resolved = resolvePath("/c/${campaignId}/claim", QODER.checkin.pathFrom, body);
    expect(resolved).toEqual({ ok: true, path: "/c/today-open/claim" });
  });

  it("活动列表为空时给出 empty-list，让上层能区分「没活动」与「配置写错」", () => {
    const got = resolvePath("/c/${campaignId}/claim", QODER.checkin.pathFrom, { campaigns: [] });
    expect(got.ok).toBe(false);
    expect(got.error).toBe(EXTRACT_ERROR.SELECTOR_NO_MATCH);
    expect(got.detail).toBe("empty-list");
  });
});

describe("Qoder CN 的两个响应形状共用一份 read", () => {
  const ok = (body) => ({ ok: true, status: 200, text: JSON.stringify(body), error: "", retryAfterMs: 0 });
  const read = QODER.read;

  it("查状态说活动已领 → 今日已签，不再发 claim", () => {
    const got = classifyStatus(ok({ claimable: false, campaigns: [{ actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED" }] }), read);
    expect(got.outcome).toBe(OUTCOME.ALREADY);
  });

  it("查状态说活动可领 → 绝不能判成已签（那是静默漏签）", () => {
    const got = classifyStatus(ok({ claimable: true, campaigns: [{ actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE" }] }), read);
    expect(got.outcome).not.toBe(OUTCOME.ALREADY);
  });

  it("别的活动早已领过，不能把今天可领的算成已签", () => {
    const got = classifyStatus(ok({ campaigns: [
      { actionType: "VIEW_DETAILS", claimStatus: "CLAIMED" },
      { actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE" },
    ] }), read);
    expect(got.outcome).not.toBe(OUTCOME.ALREADY);
  });

  it("执行签到返回 {status:CLAIMED} → 判成成功", () => {
    expect(classifyCheckIn(ok({ status: "CLAIMED" }), read).outcome).toBe(OUTCOME.OK);
  });
});

describe("TRAE Work CN 内置条目", () => {
  const TRAE = BUILTIN_SITES.find((site) => site.key === "trae-cn");

  it("两个动作都带 req_source:2（2=TRAE Work/lite，1=IDE；填错不报错，只是拿不到活动）", () => {
    for (const action of [TRAE.status, TRAE.checkin]) {
      expect(action.method).toBe("POST");
      expect(action.body, action.path).toContain('"req_source":2');
    }
  });

  it("不存凭据：authorization 与 x-device-id 都由 credentialSource 当场给", () => {
    expect(TRAE.credentialSource).toBe("trae-cn-local");
    for (const action of [TRAE.status, TRAE.checkin]) expect(action.headers).toEqual([]);
  });

  it("被限流时把业务码一起报出来——message 是同一句，只有码能分清该不该重试", () => {
    const got = classifyCheckIn(
      { ok: true, status: 200, text: JSON.stringify({ code: 9074, message: "当前参与用户太多，请稍后再试" }), error: "", retryAfterMs: 0 },
      TRAE.read,
    );
    // 9074 是排队惩罚窗口：判成限流才会退避，判成失败会当天继续重试、把窗口越拉越长
    expect(got.outcome).toBe(OUTCOME.RATE_LIMITED);
    expect(got.error).toContain("当前参与用户太多");
    expect(got.error).toContain("code=9074");
  });

  it("其它业务码仍然算失败，不要一律当限流", () => {
    const got = classifyCheckIn(
      { ok: true, status: 200, text: JSON.stringify({ code: 1002, message: "没有资格" }), error: "", retryAfterMs: 0 },
      TRAE.read,
    );
    expect(got.outcome).toBe(OUTCOME.FAILED);
  });
});

describe("mergeBuiltinSites", () => {
  it("内置的是 CN 版：key 与 label 都要能和国际版区分开", () => {
    expect(QODER.key).toBe("qoder-cn");
    expect(QODER.label).toContain("CN");
    expect(QODER.credentialSource).toBe("qoder-cn-local");
  });

  it("空列表里也会出现内置站点", () => {
    expect(mergeBuiltinSites([]).map((s) => s.key)).toContain("qoder-cn");
  });

  it("非内置的同名条目原样保留，不被内置覆盖", () => {
    const mine = { key: "qoder-cn", label: "我自己的", baseUrl: "https://example.com" };
    const merged = mergeBuiltinSites([mine]);
    expect(merged[0]).toEqual(mine);
    // 其余内置条目照常补进来，但不能顶掉同名的用户条目
    expect(merged.filter((s) => s.key === "qoder-cn")).toEqual([mine]);
  });

  it("内置条目过期时升级到代码这份，但保留用户的启用开关", () => {
    const stale = { ...QODER, revision: 0, enabled: false, checkin: { ...QODER.checkin, path: "/旧的" } };
    const [merged] = mergeBuiltinSites([stale]);
    expect(merged.checkin.path).toBe(QODER.checkin.path);
    expect(merged.enabled).toBe(false);
  });

  it("同版本的内置条目不被动过", () => {
    const asStored = { ...QODER, enabled: false };
    expect(mergeBuiltinSites([asStored])[0]).toBe(asStored);
  });
});
