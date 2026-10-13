import { describe, expect, it } from "vitest";
import { PhotoError, errorCodeOf, errorMessageOf, listObjects, parseListObjectsXml, putPhotoObject, testPhotoConnection, unescapeXml } from "./upload.js";
import { EMPTY_SHA256 } from "./sigv4.js";

const CONFIG = {
  provider: "s3",
  endpoint: "cos.ap-guangzhou.myqcloud.com",
  region: "ap-guangzhou",
  bucket: "b-1250000000",
  accessKey: "AKID",
  secretKey: "SECRET",
  prefix: "photos",
};
const NOW = new Date(Date.UTC(2026, 9, 13, 8, 30, 0));

/** 可断言的最小 fetch 替身。 */
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

describe("putPhotoObject", () => {
  it("PUT 到签名 URL：头部齐、体是原始字节、ETag 去引号返回", async () => {
    const fetchImpl = fakeFetch({ headers: { etag: '"d41d8cd98f00b204e9800998ecf8427e"' } });
    const body = new TextEncoder().encode("photo-bytes");
    const out = await putPhotoObject({ config: CONFIG, key: "photos/2026/10/13/a.jpg", body, contentType: "image/jpeg", fetchImpl, now: NOW });

    expect(out.etag).toBe("d41d8cd98f00b204e9800998ecf8427e");
    const call = fetchImpl.calls[0];
    expect(call.url).toBe("https://b-1250000000.cos.ap-guangzhou.myqcloud.com/photos/2026/10/13/a.jpg");
    expect(call.init.method).toBe("PUT");
    expect(call.init.headers.Authorization).toContain("Credential=AKID/20261013/ap-guangzhou/s3/aws4_request");
    expect(call.init.headers.Authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(call.init.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(call.init.body).toEqual(body);
  });

  it("接受 File/Blob（含 arrayBuffer 的对象）作为上传体", async () => {
    const fetchImpl = fakeFetch({});
    const blob = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    await putPhotoObject({ config: CONFIG, key: "photos/a.jpg", body: blob, contentType: "", fetchImpl, now: NOW });
    expect(fetchImpl.calls[0].init.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("失败时抛 PhotoError，错误码从响应 XML 里取", async () => {
    const fetchImpl = fakeFetch({
      ok: false,
      status: 403,
      body: "<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message></Error>",
    });
    await expect(putPhotoObject({ config: CONFIG, key: "photos/a.jpg", body: new Uint8Array([1]), fetchImpl, now: NOW })).rejects.toMatchObject({
      name: "PhotoError",
      code: "SignatureDoesNotMatch",
    });
  });

  it("取不到错误码时退回 HTTP 状态", async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 500, body: "oops" });
    await expect(putPhotoObject({ config: CONFIG, key: "photos/a.jpg", body: new Uint8Array([1]), fetchImpl, now: NOW })).rejects.toMatchObject({
      code: "HTTP 500",
    });
  });
});

describe("ListObjectsV2 解析与列举", () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>b-1250000000</Name>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>photos/2026/10/13/20261013T163000_ab12cd_9f3e.jpg</Key>
    <LastModified>2026-10-13T08:30:00.000Z</LastModified>
    <ETag>&quot;abc123&quot;</ETag>
    <Size>5242880</Size>
  </Contents>
  <Contents>
    <Key>photos/2026/10/13/20261013T163010_ab12cd_1234.jpg</Key>
    <LastModified>2026-10-13T08:30:10.000Z</LastModified>
    <ETag>&quot;def456&quot;</ETag>
    <Size>1048576</Size>
  </Contents>
</ListBucketResult>`;

  it("解析 Contents 块：key / size / etag / lastModified", () => {
    const parsed = parseListObjectsXml(XML);
    expect(parsed.truncated).toBe(false);
    expect(parsed.nextToken).toBe("");
    expect(parsed.objects).toEqual([
      { key: "photos/2026/10/13/20261013T163000_ab12cd_9f3e.jpg", size: 5242880, etag: "abc123", lastModified: "2026-10-13T08:30:00.000Z" },
      { key: "photos/2026/10/13/20261013T163010_ab12cd_1234.jpg", size: 1048576, etag: "def456", lastModified: "2026-10-13T08:30:10.000Z" },
    ]);
  });

  it("分页字段：IsTruncated 与 NextContinuationToken", () => {
    const parsed = parseListObjectsXml(
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok+1/2=</NextContinuationToken></ListBucketResult>`
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.nextToken).toBe("tok+1/2=");
  });

  it("实体解码（手改过的对象名也要读得出来）", () => {
    expect(unescapeXml("a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;")).toBe(`a&b<c>"d"'e'`);
  });

  it("listObjects 拼出标准 ListObjectsV2 查询（prefix 值做百分号编码）", async () => {
    const fetchImpl = fakeFetch({ body: XML });
    const result = await listObjects({ config: CONFIG, prefix: "photos/", maxKeys: 1, fetchImpl, now: NOW });
    expect(result.objects).toHaveLength(2);
    const url = fetchImpl.calls[0].url;
    expect(url).toContain("list-type=2");
    expect(url).toContain("max-keys=1");
    expect(url).toContain("prefix=photos%2F");
    expect(fetchImpl.calls[0].init.method).toBe("GET");
    expect(fetchImpl.calls[0].init.body).toBeUndefined();
  });

  it("续传令牌进入查询串", async () => {
    const fetchImpl = fakeFetch({ body: "<ListBucketResult></ListBucketResult>" });
    await listObjects({ config: CONFIG, prefix: "photos/", continuationToken: "tok+1/2=", fetchImpl, now: NOW });
    expect(fetchImpl.calls[0].url).toContain("continuation-token=tok%2B1%2F2%3D");
  });
});

describe("testPhotoConnection", () => {
  it("成功返回样本数量", async () => {
    const fetchImpl = fakeFetch({
      body: `<ListBucketResult><Contents><Key>photos/2026/10/13/a.jpg</Key><Size>1</Size><ETag>&quot;x&quot;</ETag><LastModified>t</LastModified></Contents></ListBucketResult>`,
    });
    const result = await testPhotoConnection({ config: CONFIG, fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true, sampleCount: 1, truncated: false });
  });

  it("失败时把错误码透出来（AccessDenied 与 SignatureDoesNotMatch 要能区分）", async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 403, body: "<Error><Code>AccessDenied</Code><Message>denied</Message></Error>" });
    await expect(testPhotoConnection({ config: CONFIG, fetchImpl, now: NOW })).rejects.toMatchObject({ code: "AccessDenied" });
  });
});

describe("errorCodeOf / errorMessageOf", () => {
  it("非 XML 输入不炸", () => {
    expect(errorCodeOf("plain text")).toBe("");
    expect(errorMessageOf("plain text")).toBe("plain text");
    expect(errorCodeOf(undefined)).toBe("");
  });

  it("PhotoError 的 message 带错误码前缀便于排查", () => {
    const err = new PhotoError("NoSuchBucket", "bucket 不存在");
    expect(err.message).toBe("NoSuchBucket: bucket 不存在");
    expect(err.detail).toBe("bucket 不存在");
  });
});

describe("空体哈希常量", () => {
  it("与 sha256('') 一致（常量写错会让所有无体请求签名失败）", async () => {
    const { sha256Hex } = await import("./sigv4.js");
    expect(await sha256Hex(new Uint8Array(0))).toBe(EMPTY_SHA256);
  });
});
