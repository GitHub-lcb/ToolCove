import { describe, expect, it } from "vitest";
import { putQiniuObject, qiniuUploadToken, urlsafeBase64 } from "./qiniu.js";
import { putPhoto } from "./upload.js";

const CONFIG = {
  provider: "qiniu",
  bucket: "my-photos",
  accessKey: "AKID",
  secretKey: "SECRET",
  domain: "cdn.example.com",
  uploadHost: "upload.qiniup.com",
  prefix: "photos",
};

function fakeFetch(result) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = typeof result === "function" ? result(url, init) : result;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: { get: (name) => (r.headers || {})[name.toLowerCase()] ?? null },
      text: async () => r.body ?? "",
    };
  };
  fn.calls = calls;
  return fn;
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return atob(padded);
}

describe("urlsafeBase64", () => {
  it("URL-safe 且去填充", () => {
    expect(urlsafeBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8");
  });
});

describe("qiniuUploadToken", () => {
  it("三段式 AK:签名:策略，策略可解码且钉到具体 key", async () => {
    const token = await qiniuUploadToken({ accessKey: "AKID", secretKey: "SECRET", bucket: "b", key: "photos/a.jpg", deadline: 1800000000 });
    const parts = token.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("AKID");
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe，没有 +/=
    const policy = JSON.parse(decodeBase64Url(parts[2]));
    expect(policy).toEqual({ scope: "b:photos/a.jpg", deadline: 1800000000 });
  });

  // 参考向量：与官方 Python SDK token_with_data（AK:urlsafe_b64(HMAC-SHA1(SK, policy_b64)):policy_b64，
  // 不带填充）逐字节一致——签名值锁死，防止"改着改着两边对不上"。
  it("与官方 SDK 参考实现逐字节一致（固定向量）", async () => {
    const token = await qiniuUploadToken({ accessKey: "ak", secretKey: "sk", bucket: "b", key: "photos/a.jpg", deadline: 1700000000 });
    expect(token).toBe("ak:N1hKbgnqajCs2FnGBcCyhKUW3LI:eyJzY29wZSI6ImI6cGhvdG9zL2EuanBnIiwiZGVhZGxpbmUiOjE3MDAwMDAwMDB9");
  });

  it("相同输入签名稳定；换密钥签名改变", async () => {
    const args = { accessKey: "AK", secretKey: "SK1", bucket: "b", key: "k", deadline: 1 };
    const a = await qiniuUploadToken(args);
    const b = await qiniuUploadToken(args);
    const c = await qiniuUploadToken({ ...args, secretKey: "SK2" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("putQiniuObject", () => {
  it("表单字段齐：token / key / file，POST 到上传域名", async () => {
    const fetchImpl = fakeFetch({ body: JSON.stringify({ key: "photos/a.jpg", hash: "Fhash" }) });
    const body = new Uint8Array([1, 2, 3]);
    const now = new Date(Date.UTC(2026, 9, 13, 8, 30, 0));
    const out = await putQiniuObject({
      config: CONFIG,
      key: "photos/2026/10/13/a.jpg",
      body,
      fetchImpl,
      now,
    });

    expect(out.etag).toBe("Fhash");
    expect(fetchImpl.calls).toHaveLength(1);
    const call = fetchImpl.calls[0];
    expect(call.url).toBe("https://upload.qiniup.com/");
    expect(call.init.method).toBe("POST");
    const form = call.init.body;
    expect(form.get("key")).toBe("photos/2026/10/13/a.jpg");
    const token = String(form.get("token"));
    expect(token.startsWith("AKID:")).toBe(true);
    // 凭证有效期一小时，且 deadline 是 UNIX 秒（不是毫秒——写错会得到 50000 年后的凭证）
    const policy = JSON.parse(decodeBase64Url(token.split(":")[2]));
    expect(policy.deadline).toBe(Math.floor(now.getTime() / 1000) + 3600);
    expect(String(policy.deadline)).toMatch(/^\d{10}$/);
    expect(policy.scope).toBe("my-photos:photos/2026/10/13/a.jpg");
    expect(form.get("file")).toBeTruthy();
  });

  it("七牛返回 error 字段即失败（HTTP 200 也可能带业务错误）", async () => {
    const fetchImpl = fakeFetch({ body: JSON.stringify({ error: "bad token" }) });
    await expect(
      putQiniuObject({ config: CONFIG, key: "photos/a.jpg", body: new Uint8Array([1]), fetchImpl })
    ).rejects.toMatchObject({ name: "PhotoError", code: "bad token" });
  });

  it("非 JSON 响应按失败处理（网关页面不能冒充成功）", async () => {
    const fetchImpl = fakeFetch({ body: "<html>oops</html>" });
    await expect(
      putQiniuObject({ config: CONFIG, key: "photos/a.jpg", body: new Uint8Array([1]), fetchImpl })
    ).rejects.toMatchObject({ code: "badResponse" });
  });
});

describe("putPhoto 分派", () => {
  it("provider=qiniu 走表单直传而不是 S3 签名", async () => {
    const fetchImpl = fakeFetch({ body: JSON.stringify({ hash: "h" }) });
    await putPhoto({ config: CONFIG, key: "photos/a.jpg", body: new Uint8Array([1]), fetchImpl });
    expect(fetchImpl.calls[0].url).toBe("https://upload.qiniup.com/");
    expect(fetchImpl.calls[0].init.headers?.Authorization).toBeUndefined();
  });

  it("provider=s3 仍走签名 PUT", async () => {
    const fetchImpl = fakeFetch({ headers: { etag: '"e"' } });
    await putPhoto({
      config: { provider: "s3", endpoint: "cos.ap-guangzhou.myqcloud.com", region: "ap-guangzhou", bucket: "b-1", accessKey: "AK", secretKey: "SK" },
      key: "photos/a.jpg",
      body: new Uint8Array([1]),
      fetchImpl,
    });
    expect(fetchImpl.calls[0].init.method).toBe("PUT");
    expect(String(fetchImpl.calls[0].init.headers.Authorization)).toContain("AWS4-HMAC-SHA256");
  });
});
