// 凭据挑选规则：什么时候能把真值写进配置，什么时候必须提示用户自己填。
//
// 单独一个文件，因为这块的判断依据是实测来的，而实测结论容易被后人「顺手简化」掉：
//   - Qoder 的签到 token 是 Electron 主进程在**网络层**注入的 34 字符 Bearer token；
//   - 应用层请求头（Network.requestWillBeSent）里一个字都没有；
//   - 只有 Network.requestWillBeSentExtraInfo 看得到。
// 所以「有没有真凭据」取决于 cdp.js 有没有把 ExtraInfo 的头并进来，
// 而不是取决于 CDP 给不给——早先这里写成「CDP 压根不给凭据」，是错的。
import { describe, expect, it } from "vitest";
import { REDACTED } from "./cdp.js";
import { buildDescriptor } from "./descriptor.js";

function capture(requestHeaders) {
  return {
    id: 1,
    method: "POST",
    url: "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/x/claim",
    host: "openapi.qoder.com.cn",
    origin: "https://openapi.qoder.com.cn",
    path: "/sash/api/v1/me/campaigns/x/claim",
    status: 200,
    requestHeaders,
    requestBody: null,
    responseBody: { status: "CLAIMED" },
  };
}

const headerOf = (out, name) => (out.descriptor.checkin.headers.find(([n]) => n === name) || [])[1];
const hasHeader = (out, name) => out.descriptor.checkin.headers.some(([n]) => n === name);

describe("凭据是真值时", () => {
  it("Authorization 直接写进配置——用户不用手抄任何凭据", () => {
    const out = buildDescriptor(capture({ Authorization: "Bearer abc.def.ghi" }));
    expect(headerOf(out, "Authorization")).toBe("Bearer abc.def.ghi");
    expect(out.warnings.join()).not.toContain("凭据头");
  });

  it("只有 Cookie 时也带上，否则靠 cookie 鉴权的站点配不出来", () => {
    const out = buildDescriptor(capture({ Cookie: "sid=abc123" }));
    expect(headerOf(out, "Cookie")).toBe("sid=abc123");
  });

  it("Authorization 与 Cookie 同时存在时丢掉 Cookie 并说明原因", () => {
    const out = buildDescriptor(capture({ Authorization: "Bearer abc", Cookie: "sid=abc" }));
    expect(hasHeader(out, "Authorization")).toBe(true);
    expect(hasHeader(out, "Cookie")).toBe(false);
    expect(out.warnings.join()).toContain("已省略 Cookie");
  });
});

describe("凭据只有脱敏占位符时", () => {
  const out = buildDescriptor(capture({ Authorization: REDACTED, Cookie: REDACTED }));

  it("绝不把占位符当成值写进配置", () => {
    // 写进去的后果：签到工具拿假 token 去打接口，回来的 401 看起来像「token 过期」，
    // 而真正的原因是这次压根没抓到上线的那份请求头。诊断方向会被彻底带偏。
    expect(hasHeader(out, "Authorization")).toBe(false);
    expect(hasHeader(out, "Cookie")).toBe(false);
  });

  it("明确告诉用户为什么、以及怎么补救", () => {
    expect(out.warnings.join()).toContain("凭据头");
    expect(out.warnings.join()).toContain("脱敏占位符");
  });
});

describe("噪声头", () => {
  it("浏览器特征头被丢掉，配置不会绑死在抓包那台机器上", () => {
    const out = buildDescriptor(capture({ "User-Agent": "Mozilla/5.0", "sec-ch-ua": '"x"', "Accept-Encoding": "gzip", "X-Request-Id": "r-1" }));
    for (const noise of ["User-Agent", "sec-ch-ua", "Accept-Encoding"]) {
      expect(hasHeader(out, noise), noise).toBe(false);
    }
    // 业务自己的头要留下
    expect(headerOf(out, "X-Request-Id")).toBe("r-1");
  });
});
