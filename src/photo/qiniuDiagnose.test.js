// 七牛上传失败的**归因**测试。
//
// 为什么单独测：401 BadToken 在七牛侧对应至少四种完全不同的原因（AK 错 / 空间名错 / SK 错 /
// 网络没通导致退回默认上传域名），而它们此前在界面上是**同一句话**——用户只能靠猜。
// 这里锁死"哪种情况报哪种话"，因为这句话就是排障的全部依据。
import { describe, expect, it } from "vitest";
import { checkQiniuSpace, classifyQiniuQueryError, diagnoseQiniuUploadFailure, probeQiniuUpload, qiniuUploadToken } from "./qiniu.js";

/** 最小 fetch 替身：按 URL 返回预置的 { status, body }。 */
function fakeFetch({ status = 200, body = "{}" } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      return { ok: status >= 200 && status < 300, status, text: async () => body };
    },
  };
}

describe("classifyQiniuQueryError", () => {
  it("AK 不认识 → accessKey（七牛原文 app/accesskey is not found）", () => {
    expect(classifyQiniuQueryError("app/accesskey is not found")).toBe("accessKey");
  });

  it("空间不存在 → bucket", () => {
    expect(classifyQiniuQueryError("no such bucket")).toBe("bucket");
  });

  it("其余归 unknown（不硬猜）", () => {
    expect(classifyQiniuQueryError("something else")).toBe("unknown");
    expect(classifyQiniuQueryError("")).toBe("unknown");
  });
});

describe("checkQiniuSpace", () => {
  it("解析成功：返回上传域名", async () => {
    const f = fakeFetch({ body: JSON.stringify({ up: { acc: { main: ["upload-z2.qiniup.com"] } } }) });
    const out = await checkQiniuSpace({ accessKey: "ak", bucket: "photos", fetchImpl: f.fetch });
    expect(out).toMatchObject({ ok: true, uploadHost: "upload-z2.qiniup.com" });
    expect(f.calls[0]).toContain("ak=ak");
    expect(f.calls[0]).toContain("bucket=photos");
  });

  it("AK 不对：如实报 accessKey 与上游原话", async () => {
    const f = fakeFetch({ status: 612, body: JSON.stringify({ error: "app/accesskey is not found" }) });
    const out = await checkQiniuSpace({ accessKey: "bad", bucket: "photos", fetchImpl: f.fetch });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("accessKey");
    expect(out.message).toContain("accesskey");
  });

  it("网络没通：归 network，不抛异常（上层要能继续走兜底域名）", async () => {
    const out = await checkQiniuSpace({ accessKey: "ak", bucket: "b", fetchImpl: async () => { throw new Error("Failed to fetch"); } });
    expect(out).toMatchObject({ ok: false, reason: "network" });
    expect(out.message).toContain("Failed to fetch");
  });
});

describe("diagnoseQiniuUploadFailure", () => {
  const badToken = '{"error":"bad token","error_code":"BadToken"}';

  it("非 BadToken 不加戏（上传失败有自己的原文）", () => {
    expect(diagnoseQiniuUploadFailure("{\"error\":\"file exists\"}", { host: "upload.qiniup.com" })).toBe("");
  });

  it("区域已解析成功 → 指向 SecretKey / 时钟（AK 与空间名已被证明是有效的）", () => {
    const text = diagnoseQiniuUploadFailure(badToken, { host: "upload-z2.qiniup.com", reason: "", message: "" });
    expect(text).toContain("upload-z2.qiniup.com");
    expect(text).toContain("SecretKey");
  });

  it("AK 错 / 空间名错 / 网络没通：各自给对应的那句话", () => {
    expect(diagnoseQiniuUploadFailure(badToken, { reason: "accessKey", message: "app/accesskey is not found" })).toContain("AccessKey");
    expect(diagnoseQiniuUploadFailure(badToken, { reason: "bucket", message: "no such bucket" })).toContain("空间名");
    expect(diagnoseQiniuUploadFailure(badToken, { reason: "network", message: "Failed to fetch" })).toContain("网络");
  });
});

describe("qiniuUploadToken（回归：形状没变）", () => {
  it("三段式，且策略里带 scope 与 deadline", async () => {
    const token = await qiniuUploadToken({ accessKey: "ak", secretKey: "sk", bucket: "b", key: "photos/a.jpg", deadline: 1_700_000_000 });
    const [ak, sign, policy] = token.split(":");
    expect(ak).toBe("ak");
    expect(sign).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = JSON.parse(atob(policy.replace(/-/g, "+").replace(/_/g, "/")));
    expect(decoded).toEqual({ scope: "b:photos/a.jpg", deadline: 1_700_000_000 });
  });
});

describe("probeQiniuUpload（真传一次来定因）", () => {
  const CONFIG = { provider: "qiniu", bucket: "photos", accessKey: "ak", secretKey: "sk", domain: "cdn.example.com", prefix: "photos" };

  /** 上传链路替身：按次数返回 200 或 401 BadToken，用来复现"两种期限都被拒 / 只有长期限被接受"。 */
  function uploadFetch({ failFirst = 0, regionOk = true } = {}) {
    let posts = 0;
    return async (url) => {
      if (url.includes("api.qiniu.com")) {
        return { ok: regionOk, status: regionOk ? 200 : 612, text: async () => JSON.stringify(regionOk ? { up: { acc: { main: ["upload-z2.qiniup.com"] } } } : { error: "app/accesskey is not found" }) };
      }
      posts += 1;
      const bad = posts <= failFirst;
      return { ok: !bad, status: bad ? 401 : 200, text: async () => (bad ? '{"error":"bad token","error_code":"BadToken"}' : '{"hash":"FakeHash"}') };
    };
  }

  it("能传上去：ok，并给出探针 key（1 字节，可删）", async () => {
    const out = await probeQiniuUpload({ config: CONFIG, fetchImpl: uploadFetch(), now: Date.now() });
    expect(out.ok).toBe(true);
    expect(out.key).toMatch(/^toolcove-selftest\//);
  });

  it("两种期限都被拒 → secretKey（空间名与 AK 已由区域解析证明有效）", async () => {
    const out = await probeQiniuUpload({ config: CONFIG, fetchImpl: uploadFetch({ failFirst: 2 }), now: Date.now() });
    expect(out).toMatchObject({ ok: false, reason: "secretKey" });
    expect(out.message).toContain("BadToken");
  });

  it("正常期限被拒、一年期限能过 → clock（设备时钟偏差，不是密钥问题）", async () => {
    const out = await probeQiniuUpload({ config: CONFIG, fetchImpl: uploadFetch({ failFirst: 1 }), now: Date.now() });
    expect(out).toMatchObject({ ok: false, reason: "clock", clockSkew: true });
  });

  it("非 BadToken 的失败原样透出（例如网络断了），不硬套密钥问题", async () => {
    const out = await probeQiniuUpload({
      config: CONFIG,
      fetchImpl: async (url) => {
        if (url.includes("api.qiniu.com")) return { ok: true, status: 200, text: async () => JSON.stringify({ up: { acc: { main: ["upload-z2.qiniup.com"] } } }) };
        throw new Error("Failed to fetch");
      },
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("upload");
    expect(out.message).toContain("Failed to fetch");
  });
});
