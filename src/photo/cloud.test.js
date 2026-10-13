// 云端对象管理（src/photo/cloud.js）的单测：
// 这里测的都是"错了就只会看到 401/403、看不出哪儿错"的东西——签名串形状、entry 编码、
// 列举响应解析、私有预览 URL 的令牌。
import { describe, expect, it } from "vitest";
import { cloudProviderOf, deleteCloudObject, listCloudObjects, moveCloudObject, objectPreviewUrl, qiniuEntry, qiniuManagementAuth } from "./cloud.js";

const CONFIG = {
  provider: "qiniu", bucket: "luqian520", accessKey: "AK", secretKey: "SK",
  domain: "cdn.example.com", privateBucket: true, prefix: "photos",
};

/** 区域解析替身：直接失败，让 rsf 域名走默认值——单测不该出网。 */
const offlineFetch = async () => ({ ok: false, status: 612, text: async () => '{"error":"app/accesskey is not found"}' });

/** http_request 替身：记录最后一次请求，返回预置响应。 */
function fakeHttp({ status = 200, body = "{}" } = {}) {
  const calls = [];
  const http = async (args) => { calls.push(args); return { status, body }; };
  http.calls = calls;
  return http;
}

describe("cloudProviderOf", () => {
  it("七牛与 S3 支持，WebDAV 明确不支持（返回空串，界面据此说明原因）", () => {
    expect(cloudProviderOf(CONFIG)).toBe("qiniu");
    expect(cloudProviderOf({ provider: "s3", endpoint: "s3.example.com" })).toBe("s3");
    expect(cloudProviderOf({ provider: "webdav", endpoint: "https://dav.example.com" })).toBe("");
  });
});

describe("qiniuEntry / 管理凭证", () => {
  it("entry 是 bucket:key 的 URL-safe base64（不填充）", () => {
    expect(qiniuEntry("b", "k")).toBe("Yjpr");
  });

  it("凭证形如 QBox AK:sign，且签名串含 method/host/content-type（与 Rust 端逐字一致）", async () => {
    const auth = await qiniuManagementAuth({ config: CONFIG, method: "POST", host: "rsf.qbox.me", pathAndQuery: "/list?bucket=b&limit=1" });
    expect(auth.startsWith("QBox AK:")).toBe(true);
    // 换 host 必须换签名：签名串里带 Host，这是最容易漏的一处
    const other = await qiniuManagementAuth({ config: CONFIG, method: "POST", host: "rsf-z2.qiniup.com", pathAndQuery: "/list?bucket=b&limit=1" });
    expect(other).not.toBe(auth);
  });
});

describe("listCloudObjects（七牛）", () => {
  const ITEMS = JSON.stringify({
    items: [
      { key: "photos/2026/10/13/a.png", fsize: 33800, putTime: 17600000000000000, hash: "H1" },
      { key: "", fsize: 1 },
    ],
    marker: "next-token",
  });

  it("解析 items、换算拍摄时间、带出 marker，并丢掉空 key", async () => {
    // 区域解析也要回一条：否则 rsf 域名拿不到（这里直接给 rsf）
    const http = fakeHttp({ status: 200, body: ITEMS });
    const out = await listCloudObjects({ config: CONFIG, prefix: "photos/", http, fetchImpl: offlineFetch });
    expect(out.objects).toHaveLength(1);
    expect(out.objects[0]).toMatchObject({ key: "photos/2026/10/13/a.png", name: "a.png", size: 33800, etag: "H1" });
    expect(out.objects[0].lastModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.truncated).toBe(true);
    expect(out.nextMarker).toBe("next-token");
    // 请求必须是 POST /list，且带上 bucket 与 prefix
    expect(http.calls[0].method).toBe("POST");
    expect(http.calls[0].url).toContain("/list?");
    expect(http.calls[0].url).toContain("bucket=luqian520");
    expect(http.calls[0].url).toContain("prefix=photos%2F");
  });

  it("非 2xx 抛错时带上服务端原话（401 时只有它能说明问题）", async () => {
    const http = fakeHttp({ status: 401, body: '{"error":"bad token"}' });
    await expect(listCloudObjects({ config: CONFIG, http, fetchImpl: offlineFetch })).rejects.toThrow(/401/);
  });
});

describe("删除与移动", () => {
  it("删除打 POST /delete/<entry>", async () => {
    const http = fakeHttp({ status: 200, body: "{}" });
    await deleteCloudObject({ config: CONFIG, key: "photos/a.png", http, fetchImpl: offlineFetch });
    expect(http.calls[0].method).toBe("POST");
    expect(http.calls[0].url).toContain(`/delete/${qiniuEntry("luqian520", "photos/a.png")}`);
  });

  it("移动打 POST /move/<src>/<dst>?force=true", async () => {
    const http = fakeHttp({ status: 200, body: "{}" });
    await moveCloudObject({ config: CONFIG, from: "photos/a.png", to: "photos/2026/a.png", http, fetchImpl: offlineFetch });
    expect(http.calls[0].url).toContain(`/move/${qiniuEntry("luqian520", "photos/a.png")}/${qiniuEntry("luqian520", "photos/2026/a.png")}`);
    expect(http.calls[0].url).toContain("force=true");
  });

  it("目标与来源相同：不发请求（避免把「重命名成自己」当成移动）", async () => {
    const http = fakeHttp();
    const out = await moveCloudObject({ config: CONFIG, from: "photos/a.png", to: "photos/a.png", http });
    expect(out.moved).toBe(false);
    expect(http.calls).toHaveLength(0);
  });
});

describe("预览 URL", () => {
  it("私有桶：带 e 与 token（签名串是完整 URL + ?e=deadline）", async () => {
    const url = await objectPreviewUrl({ config: CONFIG, key: "photos/a b.png" });
    expect(url).toMatch(/^https:\/\/cdn\.example\.com\/photos\/a%20b\.png\?e=\d+&token=AK:/);
  });

  it("公开桶：裸链，不带令牌", async () => {
    const url = await objectPreviewUrl({ config: { ...CONFIG, privateBucket: false }, key: "photos/a.png" });
    expect(url).toBe("https://cdn.example.com/photos/a.png");
  });

  it("没配访问域名：返回空串（界面据此不渲染 img，而不是显示裂图）", async () => {
    expect(await objectPreviewUrl({ config: { ...CONFIG, domain: "" }, key: "a.png" })).toBe("");
  });
});
