// 云端对象管理（src/photo/cloud.js）的单测：
// 这里测的都是"错了就只会看到 401/403、看不出哪儿错"的东西——签名串形状、entry 编码、
// 列举响应解析、私有预览 URL 的令牌。
import { describe, expect, it, vi } from "vitest";
import { cloudProviderOf, deleteCloudObject, listCloudObjects, moveCloudObject, objectPreviewUrl, qiniuEntry, qiniuManagementAuth } from "./cloud.js";
import { isValidRelayUrl, validatePhotoConfig } from "./config.js";
import { isFolderMarker, LOCAL_RELAY_URL } from "./cloud.js";

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
    // 7 字节以内可能不产生填充，所以特意用一个需要填充的 key：
    // "b:k1" 是 4 字节 → base64 末尾有 ==（七牛文档的示例 entry 同样是带填充的）
    expect(qiniuEntry("b", "k1")).toBe("YjprMQ==");
    expect(qiniuEntry("b", "k")).toBe("Yjpr");
  });

  it("凭证形如 Qiniu AK:sign，且签名串含 method/host/content-type（与 Rust 端逐字一致）", async () => {
    const auth = await qiniuManagementAuth({ config: CONFIG, method: "POST", host: "rsf.qbox.me", pathAndQuery: "/list?bucket=b&limit=1" });
    // 前缀必须是 Qiniu（V2）——写成 QBox 会被服务端拒成 401 BadToken，真机上栽过
    expect(auth.startsWith("Qiniu AK:")).toBe(true);
    // 签名必须带填充：HMAC-SHA1 是 20 字节 → base64 一定以 = 结尾。
    // 去填充的版本在本账号/区域会被拒（401 BadToken）——上传凭证踩过一次，管理凭证又踩了一次。
    expect(auth.slice("Qiniu AK:".length).endsWith("=")).toBe(true);
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

describe("网页版走自建转发（relayUrl）", () => {
  const CONFIG = {
    provider: "qiniu",
    bucket: "luqian520",
    accessKey: "AK",
    secretKey: "SK",
    domain: "cdn.example.com",
    privateBucket: true,
    prefix: "photos",
    relayUrl: "https://relay.example.workers.dev/",
  };

  /**
   * 网页形态：有手机产物标记但**没有原生桥** → canSendAuthHeader() 为假 → 必须走 relay。
   * 这就是 github.io 上那份产物的真实形态。
   */
  async function withWebForm(testBody) {
    vi.stubGlobal("__MOBILE__", true);
    vi.stubGlobal("window", {});
    vi.resetModules();
    try {
      return await testBody(await import("./cloud.js"));
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  }

  it("把签好的凭证交给转发器（POST JSON: url/method/headers），并解析转发器回的 {status, body}", async () => {
    const calls = [];
    await withWebForm(async (cloud) => {
      const http = async (args) => {
        calls.push(args);
        return {
          status: 200,
          body: JSON.stringify({
            status: 200,
            body: JSON.stringify({ items: [{ key: "photos/", fsize: 0, putTime: 17600000000000000, hash: "D" }, { key: "photos/a.png", fsize: 3, putTime: 17600000000000000, hash: "H" }], marker: "" }),
          }),
        };
      };
      const out = await cloud.listCloudObjects({ config: CONFIG, prefix: "photos/", http, fetchImpl: offlineFetch });
      expect(out.objects.map((item) => item.key)).toEqual(["photos/a.png"]);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://relay.example.workers.dev/");
    const job = JSON.parse(calls[0].body);
    expect(job.url).toContain("/list?bucket=luqian520");
    expect(job.method).toBe("POST");
    // 凭证由页面本地签好再交给转发器：转发器不接触 SK
    expect(job.headers.Authorization.startsWith("Qiniu AK:")).toBe(true);
  });

  it("没配转发地址时**自动试本机默认端口**（网页常常就跑在起了转发器的同一台电脑上）", async () => {
    const urls = [];
    await withWebForm(async (cloud) => {
      const http = async (args) => {
        urls.push(args.url);
        return {
          status: 200,
          body: JSON.stringify({ status: 200, body: JSON.stringify({ items: [{ key: "photos/a.png", fsize: 3, putTime: 17600000000000000, hash: "H" }], marker: "" }) }),
        };
      };
      const out = await cloud.listCloudObjects({ config: { ...CONFIG, relayUrl: "" }, http, fetchImpl: offlineFetch });
      expect(out.objects.map((item) => item.key)).toEqual(["photos/a.png"]);
    });
    expect(urls).toEqual([LOCAL_RELAY_URL]);
  });

  it("本机也没转发器：不硬发到七牛，给可执行的指引（并说清连不上的原因）", async () => {
    let qiniuHits = 0;
    await withWebForm(async (cloud) => {
      const http = async (args) => {
        if (!String(args.url).startsWith("http://127.0.0.1")) qiniuHits += 1;
        throw new Error("Failed to fetch");
      };
      await expect(
        cloud.listCloudObjects({ config: { ...CONFIG, relayUrl: "" }, http, fetchImpl: offlineFetch })
      ).rejects.toThrow(/没有转发器在听/);
    });
    expect(qiniuHits, "七牛不认查询参数凭证，发过去只会得到没法定位的 BadToken——所以一个都不发").toBe(0);
  });
});

describe("转发地址的合法性（isValidRelayUrl）", () => {
  const cases = [
    ["https://relay.example.com/", true],
    ["https://relay.example.com/photo-relay", true],
    ["http://127.0.0.1:8127/", true],
    ["http://localhost:8127", true],
    ["http://127.0.0.1", true],
    // http 的公网/局域网地址会被浏览器的混合内容拦掉，所以不接受——
    // 放行它只会让人配好之后得到一个"Failed to fetch"，比直接报错更难查
    ["http://192.168.1.10:8127/", false],
    ["http://relay.example.com/", false],
    ["ftp://relay.example.com/", false],
    ["relay.example.com", false],
    ["", false],
  ];

  it.each(cases)("%s → %s", (url, ok) => {
    expect(isValidRelayUrl(url)).toBe(ok);
  });

  it("validatePhotoConfig 用同一条规则：回环地址算合法，局域网 http 报 relayUrlBad", () => {
    const base = { provider: "qiniu", bucket: "luqian520", accessKey: "AK", secretKey: "SK", domain: "cdn.example.com" };
    expect(validatePhotoConfig({ ...base, relayUrl: "http://127.0.0.1:8127/" }).errors.relayUrl).toBeUndefined();
    expect(validatePhotoConfig({ ...base, relayUrl: "http://192.168.1.10:8127/" }).errors.relayUrl).toBe("relayUrlBad");
    // 不填也行：转发是可选的
    expect(validatePhotoConfig(base).errors.relayUrl).toBeUndefined();
  });
});

describe("浏览器端走七牛 S3 兼容端点（桶配好跨域即可直连，不需要转发）", () => {
  const CONFIG = {
    provider: "qiniu",
    bucket: "luqian520",
    accessKey: "AK",
    secretKey: "SK",
    domain: "cdn.example.com",
    privateBucket: true,
    prefix: "photos",
  };
  // 区域接口的真实形状：up 给上传域名，s3 给 S3 兼容端点与 region_alias
  const REGION = JSON.stringify({
    up: { acc: { main: ["upload-z2.qiniup.com"] } },
    rsf: { acc: { main: ["rsf-z2.qbox.me"] } },
    s3: { region_alias: "cn-south-1", src: { main: ["s3-cn-south-1.qiniucs.com"] } },
  });
  const LIST_XML =
    '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
    '<Contents><Key>photos/</Key><Size>0</Size><LastModified>2026-10-13T00:00:00.000Z</LastModified><ETag>"D"</ETag></Contents>' +
    '<Contents><Key>photos/a.png</Key><Size>3</Size><LastModified>2026-10-14T00:00:00.000Z</LastModified><ETag>"H"</ETag></Contents></ListBucketResult>';

  async function withBrowser(testBody) {
    vi.stubGlobal("__MOBILE__", true);
    vi.stubGlobal("window", {}); // 没有原生桥 = 手机网页版
    vi.resetModules();
    try {
      return await testBody(await import("./cloud.js"));
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  }

  it("列举改走 S3 端点（路径风格 /<bucket>/?list-type=2），不再碰 rsf 与转发", async () => {
    const urls = [];
    await withBrowser(async (cloud) => {
      const fetchImpl = async (url) => {
        urls.push(String(url));
        if (String(url).includes("api.qiniu.com")) return { ok: true, status: 200, text: async () => REGION };
        return { ok: true, status: 200, text: async () => LIST_XML };
      };
      const http = async () => {
        throw new Error("浏览器端不该走管理接口或转发");
      };
      const out = await cloud.listCloudObjects({ config: CONFIG, prefix: "photos/", http, fetchImpl });
      expect(out.objects.map((item) => item.key)).toEqual(["photos/a.png"]);
    });
    expect(urls.some((u) => u.includes("s3-cn-south-1.qiniucs.com") && u.includes("list-type=2"))).toBe(true);
    expect(urls.some((u) => u.includes("rsf"))).toBe(false);
  });

  it("移动 = 复制（x-amz-copy-source 参与签名）再删源", async () => {
    const calls = [];
    await withBrowser(async (cloud) => {
      const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), method: init?.method, headers: init?.headers || {} });
        if (String(url).includes("api.qiniu.com")) return { ok: true, status: 200, text: async () => REGION };
        return { ok: true, status: 200, text: async () => "", headers: { get: () => "" } };
      };
      const out = await cloud.moveCloudObject({
        config: CONFIG,
        from: "photos/a.png",
        to: "photos/2026/a.png",
        http: async () => { throw new Error("不该走管理接口"); },
        fetchImpl,
      });
      expect(out).toMatchObject({ ok: true, moved: true, via: "s3" });
    });
    const put = calls.find((c) => c.method === "PUT");
    const del = calls.find((c) => c.method === "DELETE");
    expect(put.url).toContain("s3-cn-south-1.qiniucs.com/luqian520/photos/2026/a.png");
    expect(put.headers["x-amz-copy-source"]).toBe("/luqian520/photos%2Fa.png");
    expect(del.url).toContain("/luqian520/photos/a.png");
  });
});

describe("目录占位对象不显示（七牛的「创建目录」会写一个 key 以 / 结尾的 0 字节对象）", () => {
  it("isFolderMarker 只按结尾斜杠判定：真 0 字节文件仍要显示", () => {
    expect(isFolderMarker("photos/")).toBe(true);
    expect(isFolderMarker("photos/2026/")).toBe(true);
    expect(isFolderMarker("photos/empty.png")).toBe(false);
    expect(isFolderMarker("")).toBe(false);
  });
});
