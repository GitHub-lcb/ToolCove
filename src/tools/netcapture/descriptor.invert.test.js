// 「能力语义」布尔字段的取反推断。
//
// 这是实测踩出来的坑：Qoder 的状态响应里有 claimable，生成器按 /claim/ 规则
// 猜成了 read.checkedIn 却没带取反，于是产出一份**校验通过、语法正确、行为完全相反**的配置——
// 该签的那天被判成「已签」然后跳过，全程不报任何错。
//
// 报错你会去查；静默跳过你只会以为「今天没到点」。所以这类名字必须取反，
// 而且方向是挑过的：猜错时取反导致「多签一次」（服务端幂等，无害），
// 不取反导致「该签不签」（用户白丢一天额度）。
import { describe, expect, it } from "vitest";
import { validateDescriptor } from "../../checkin/descriptor.js";
import { buildDescriptor, guessReadPaths } from "./descriptor.js";

function capture(responseBody) {
  return {
    id: 1,
    method: "GET",
    host: "openapi.qoder.com.cn",
    origin: "https://openapi.qoder.com.cn",
    path: "/sash/api/v1/me/campaigns",
    status: 200,
    requestHeaders: { Authorization: "Bearer real-token" },
    requestBody: null,
    responseBody,
  };
}

describe("能力语义字段自动取反", () => {
  it("claimable 被认出来并带上取反——这是真实踩到的那个坑", () => {
    const hints = guessReadPaths({ claimable: false });
    expect(hints.checkedIn).toBe("claimable");
    expect(hints.checkedInInvert).toBe(true);
  });

  it("生成出来的配置确实带着取反，并且校验通过", () => {
    const out = buildDescriptor(capture({ claimable: false, uid: "u1" }));
    expect(out.descriptor.read.checkedIn).toBe("claimable");
    expect(out.descriptor.read.checkedInInvert).toBe(true);
    expect(validateDescriptor(out.descriptor, { existingKeys: [] }).ok).toBe(true);
  });

  it("警告里明说这是推断，并告诉用户怎么核对", () => {
    const out = buildDescriptor(capture({ claimable: false }));
    const text = out.warnings.join();
    expect(text).toContain("checkedInInvert");
    expect(text).toContain("推断");
  });

  it("各种「能力」命名都认", () => {
    // 只有**同时**满足两件事的名字才会走到取反这一步：
    //   1. 名字含 check/sign/claim/received/done —— 否则压根不会被当成签到字段；
    //   2. 名字是「能力」语义（able 结尾、can 开头等）。
    // 像 available / remaining 这种单看太含糊（available 什么？），检测那一层就不收，
    // 猜成签到字段反而危险，所以它们不在这里。
    for (const name of ["canCheckIn", "canSignIn", "claimable", "checkable", "signable", "claimAvailable"]) {
      const hints = guessReadPaths({ [name]: false });
      expect(hints.checkedIn, name).toBe(name);
      expect(hints.checkedInInvert, name).toBe(true);
    }
  });

  it("checkIn 属于结果语义，不取反——名字里有 check 不代表它是「能不能」", () => {
    const hints = guessReadPaths({ checkIn: true });
    expect(hints.checkedIn).toBe("checkIn");
    expect(hints.checkedInInvert).toBe(false);
  });

  it("猜出来的字段一定要提示核对——猜对了不提示、猜错了也不提示是最糟的组合", () => {
    const out = buildDescriptor(capture({ checkedIn: true }));
    expect(out.descriptor.read.checkedInInvert).toBeFalsy();
    expect(out.warnings.join()).toContain("猜");
  });

  it("普通「结果」命名不取反，避免无谓地改动语义", () => {
    for (const name of ["checkedIn", "hasCheckedIn", "signed", "claimed", "received", "done"]) {
      const hints = guessReadPaths({ [name]: true });
      expect(hints.checkedIn, name).toBe(name);
      expect(hints.checkedInInvert, name).toBe(false);
    }
  });

  it("没猜出 checkedIn 时不写取反——配置本来就无效，别再加一个无意义的键", () => {
    const out = buildDescriptor(capture({ status: "CLAIMED" }));
    expect(out.descriptor.read.checkedIn).toBe("");
    expect("checkedInInvert" in out.descriptor.read).toBe(false);
  });
});
