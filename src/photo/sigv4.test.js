import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { EMPTY_SHA256, buildQueryString, formatAmzDate, sha256Hex, signS3Request, uriEncode } from "./sigv4.js";

// 官方向量来自 aws-sig-v4-test-suite（get-vanilla / get-vanilla-query-order-key-case）。
// 这是我们手写签名唯一的"外部真相"来源：不引 SDK 的底气就是它能原样复现官方输出。
const CREDS = { accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const VECTOR_TIME = new Date("2015-08-30T12:36:00Z");

describe("uriEncode / buildQueryString", () => {
  it("RFC3986：只放过 A-Za-z0-9-_.~，其余百分号编码", () => {
    expect(uriEncode("a b")).toBe("a%20b");
    expect(uriEncode("a~b")).toBe("a~b");
    expect(uriEncode("a/b", false)).toBe("a/b");
    expect(uriEncode("a/b", true)).toBe("a%2Fb");
    expect(uriEncode("!*'()")).toBe("%21%2A%27%28%29");
    expect(uriEncode("照片")).toBe("%E7%85%A7%E7%89%87");
  });

  it("查询串按 (key, value) 排序，值与键都编码", () => {
    expect(buildQueryString([["b", "2"], ["a", "1"], ["a b", "x/y"]])).toBe("a=1&a%20b=x%2Fy&b=2");
    expect(buildQueryString([])).toBe("");
    expect(buildQueryString({ "list-type": "2", "max-keys": "10" })).toBe("list-type=2&max-keys=10");
  });
});

describe("官方测试向量", () => {
  it("get-vanilla：GET / 与官方签名逐字一致", async () => {
    const out = await signS3Request({
      method: "GET",
      host: "example.amazonaws.com",
      path: "/",
      query: [],
      headers: {},
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      service: "service",
      now: VECTOR_TIME,
      ...CREDS,
    });
    expect(out.amzDate).toBe("20150830T123600Z");
    expect(out.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
    );
  });

  it("get-vanilla-query-order-key-case：查询参数先排序再签名", async () => {
    const out = await signS3Request({
      method: "GET",
      host: "example.amazonaws.com",
      path: "/",
      query: [["Param2", "value2"], ["Param1", "value1"]],
      headers: {},
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      service: "service",
      now: VECTOR_TIME,
      ...CREDS,
    });
    expect(out.authorization).toContain("Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });

  it("换顺序输入同一组参数，签名不变（排序真的发生了）", async () => {
    const sign = (query) =>
      signS3Request({
        method: "GET",
        host: "example.amazonaws.com",
        path: "/",
        query,
        headers: {},
        payloadHash: EMPTY_SHA256,
        region: "us-east-1",
        service: "service",
        now: VECTOR_TIME,
        ...CREDS,
      });
    const a = await sign([["Param2", "value2"], ["Param1", "value1"]]);
    const b = await sign([["Param1", "value1"], ["Param2", "value2"]]);
    expect(a.authorization).toBe(b.authorization);
  });
});

describe("S3 风格请求（我们真正发的形态）", () => {
  // 手写规范请求 + node:crypto 独立实现 HMAC 链：验证「规范请求怎么拼」这一步
  // 与实现一致（subtle 与 node:crypto 是两条独立代码路径）
  it("PUT 对象：签名可由 node:crypto 按规范逐字复算", async () => {
    const now = new Date(Date.UTC(2026, 9, 13, 8, 30, 0));
    const payload = "hello-photo";
    const payloadHash = await sha256Hex(new TextEncoder().encode(payload));
    const host = "bucket-1250000000.cos.ap-guangzhou.myqcloud.com";
    const path = "/photos/2026/10/13/20261013T163000_ab12cd_9f3e.jpg";

    const out = await signS3Request({
      method: "PUT",
      host,
      path,
      query: [],
      headers: { "content-type": "image/jpeg", "x-amz-content-sha256": payloadHash },
      payloadHash,
      region: "ap-guangzhou",
      accessKey: "AKIDTEST",
      secretKey: "SECRETTEST",
      now,
    });

    // 按规范逐字拼（独立于实现）：
    const canonicalRequest = [
      "PUT",
      path, // key 的字符集保证编码后与原文相同
      "",
      `content-type:image/jpeg\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:20261013T083000Z\n`,
      "content-type;host;x-amz-content-sha256;x-amz-date",
      payloadHash,
    ].join("\n");
    const scope = "20261013/ap-guangzhou/s3/aws4_request";
    const stringToSign = ["AWS4-HMAC-SHA256", "20261013T083000Z", scope, await sha256Hex(canonicalRequest)].join("\n");
    const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
    let key = hmac("AWS4SECRETTEST", "20261013");
    key = hmac(key, "ap-guangzhou");
    key = hmac(key, "s3");
    key = hmac(key, "aws4_request");
    const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

    expect(out.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIDTEST/${scope}, ` +
        `SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${signature}`
    );
  });

  it("临时密钥（sessionToken）进入签名头", async () => {
    const out = await signS3Request({
      method: "GET",
      host: "b.s3.example.com",
      path: "/",
      query: [],
      headers: {},
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      accessKey: "AK",
      secretKey: "SK",
      sessionToken: "TOKEN",
      now: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    });
    expect(out.signedHeaders).toBe("host;x-amz-date;x-amz-security-token");
  });
});

describe("formatAmzDate", () => {
  it("固定宽度 UTC，无小数秒", () => {
    expect(formatAmzDate(new Date(Date.UTC(2026, 9, 13, 8, 30, 0)))).toBe("20261013T083000Z");
    expect(formatAmzDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("20260102T030405Z");
  });
});
