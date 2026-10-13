import { describe, expect, it } from "vitest";
import {
  PHOTO_CONFIG_EXPORT_KIND,
  defaultPhotoConfig,
  exportPhotoConfig,
  normalizePhotoConfig,
  parsePhotoConfigExport,
  photoHost,
  photoObjectPath,
  photoObjectUrl,
  qiniuObjectUrl,
  qiniuUploadUrl,
  validatePhotoConfig,
  webdavObjectUrl,
} from "./config.js";

const VALID = {
  provider: "s3",
  endpoint: "cos.ap-guangzhou.myqcloud.com",
  region: "ap-guangzhou",
  bucket: "my-bucket-1250000000",
  accessKey: "AKIDEXAMPLE",
  secretKey: "SECRET",
  pathStyle: false,
  prefix: "photos",
};

describe("normalizePhotoConfig", () => {
  it("粘贴完整 URL 也能用：剥协议头与末尾斜杠、去空白", () => {
    const cfg = normalizePhotoConfig({ ...VALID, endpoint: "  https://cos.ap-guangzhou.myqcloud.com/  ", bucket: " my-bucket " });
    expect(cfg.endpoint).toBe("cos.ap-guangzhou.myqcloud.com");
    expect(cfg.bucket).toBe("my-bucket");
  });

  it("缺字段补默认；前缀回到默认 photos", () => {
    const cfg = normalizePhotoConfig({ endpoint: "e.com" });
    expect(cfg.provider).toBe("s3");
    expect(cfg.prefix).toBe("photos");
    expect(cfg.pathStyle).toBe(false);
    expect(() => normalizePhotoConfig(null)).not.toThrow();
    expect(normalizePhotoConfig(null)).toEqual(defaultPhotoConfig());
  });
});

describe("validatePhotoConfig", () => {
  it("合法配置全过", () => {
    const result = validatePhotoConfig(VALID);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
  });

  it("逐字段给原因码（供视图映射中英文案）", () => {
    const result = validatePhotoConfig({});
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual({
      endpoint: "endpointEmpty",
      region: "regionEmpty",
      bucket: "bucketEmpty",
      accessKey: "keyEmpty",
      secretKey: "secretEmpty",
    });
  });

  it("地址与桶名的坏形态能被区分出来", () => {
    expect(validatePhotoConfig({ ...VALID, endpoint: "http://a b.com/" }).errors.endpoint).toBe("endpointBad");
    expect(validatePhotoConfig({ ...VALID, endpoint: "a/b.com" }).errors.endpoint).toBe("endpointBad");
    expect(validatePhotoConfig({ ...VALID, bucket: "bad bucket!" }).errors.bucket).toBe("bucketBad");
    expect(validatePhotoConfig({ ...VALID, prefix: "照 片" }).errors.prefix).toBe("prefixBad");
  });

  it("MinIO 的 host:port 形态是合法的", () => {
    expect(validatePhotoConfig({ ...VALID, endpoint: "127.0.0.1:9000" }).ok).toBe(true);
  });
});

describe("URL 组装", () => {
  it("虚拟主机风格：bucket 前缀域名（COS / R2 / AWS 默认）", () => {
    const cfg = normalizePhotoConfig(VALID);
    expect(photoHost(cfg)).toBe("my-bucket-1250000000.cos.ap-guangzhou.myqcloud.com");
    expect(photoObjectPath(cfg, "photos/2026/10/13/a.jpg")).toBe("/photos/2026/10/13/a.jpg");
    expect(photoObjectUrl(cfg, "photos/2026/10/13/a.jpg")).toBe(
      "https://my-bucket-1250000000.cos.ap-guangzhou.myqcloud.com/photos/2026/10/13/a.jpg"
    );
  });

  it("路径风格：桶进路径（MinIO 常用）", () => {
    const cfg = normalizePhotoConfig({ ...VALID, endpoint: "127.0.0.1:9000", pathStyle: true });
    expect(photoHost(cfg)).toBe("127.0.0.1:9000");
    expect(photoObjectPath(cfg, "photos/a.jpg")).toBe("/my-bucket-1250000000/photos/a.jpg");
    expect(photoObjectUrl(cfg, "photos/a.jpg")).toBe("https://127.0.0.1:9000/my-bucket-1250000000/photos/a.jpg");
  });

  it("key 前导斜杠不会拼出双斜杠路径", () => {
    const cfg = normalizePhotoConfig(VALID);
    expect(photoObjectPath(cfg, "/photos/a.jpg")).toBe("/photos/a.jpg");
  });
});

describe("多后端（七牛 / WebDAV）", () => {
  const QINIU = {
    provider: "qiniu",
    bucket: "my-photos",
    accessKey: "AKID",
    secretKey: "SECRET",
    domain: "cdn.example.com",
    uploadHost: "upload.qiniup.com",
    prefix: "photos",
  };
  const WEBDAV = {
    provider: "webdav",
    endpoint: "https://dav.jianguoyun.com/dav/toolcove",
    username: "user@example.com",
    password: "app-password",
    prefix: "photos",
  };

  it("七牛：缺字段逐条报码；合法配置全过", () => {
    expect(validatePhotoConfig({ provider: "qiniu" }).errors).toEqual({
      bucket: "bucketEmpty",
      accessKey: "keyEmpty",
      secretKey: "secretEmpty",
      domain: "domainEmpty",
    });
    expect(validatePhotoConfig(QINIU).ok).toBe(true);
    expect(validatePhotoConfig({ ...QINIU, domain: "http://bad host/" }).errors.domain).toBe("domainBad");
  });

  it("七牛：S3 的字段不再参与校验（endpoint/region 缺失不该拦）", () => {
    const result = validatePhotoConfig(QINIU);
    expect(result.errors.endpoint).toBeUndefined();
    expect(result.errors.region).toBeUndefined();
  });

  it("七牛：访问域名与上传域名的 URL 组装", () => {
    const cfg = normalizePhotoConfig(QINIU);
    expect(qiniuObjectUrl(cfg, "photos/2026/10/13/a.jpg")).toBe("https://cdn.example.com/photos/2026/10/13/a.jpg");
    expect(qiniuUploadUrl(cfg)).toBe("https://upload.qiniup.com/");
    // 上传域名留空时回默认入口
    expect(normalizePhotoConfig({ ...QINIU, uploadHost: "" }).uploadHost).toBe("upload.qiniup.com");
    // 私有桶默认开（bool 默认值最容易写反）
    expect(normalizePhotoConfig({ provider: "qiniu" }).privateBucket).toBe(true);
    expect(normalizePhotoConfig({ provider: "qiniu", privateBucket: false }).privateBucket).toBe(false);
  });

  it("WebDAV：地址自动补 https://，缺用户名/密码报码", () => {
    const cfg = normalizePhotoConfig({ provider: "webdav", endpoint: "dav.example.com/dav/" });
    expect(cfg.endpoint).toBe("https://dav.example.com/dav");
    const errors = validatePhotoConfig({ provider: "webdav", endpoint: "dav.example.com/dav" }).errors;
    expect(errors.username).toBe("userEmpty");
    expect(errors.password).toBe("passEmpty");
    expect(validatePhotoConfig(WEBDAV).ok).toBe(true);
  });

  it("WebDAV：对象 URL 拼在基地址之后", () => {
    const cfg = normalizePhotoConfig(WEBDAV);
    expect(webdavObjectUrl(cfg, "photos/2026/10/13/a.jpg")).toBe("https://dav.jianguoyun.com/dav/toolcove/photos/2026/10/13/a.jpg");
  });
});

describe("导出 / 导入", () => {
  const FULL = {
    provider: "s3",
    endpoint: "cos.ap-guangzhou.myqcloud.com",
    region: "ap-guangzhou",
    bucket: "b-1250000000",
    accessKey: "AKID",
    secretKey: "SECRET",
    sessionToken: "TOKEN",
    pathStyle: false,
    prefix: "trip/2026",
    deviceId: "ab12cd",
  };

  it("导出：带 kind/version，凭据明文在内，deviceId 不随行", () => {
    const parsed = JSON.parse(exportPhotoConfig(FULL));
    expect(parsed.kind).toBe(PHOTO_CONFIG_EXPORT_KIND);
    expect(parsed.version).toBe(1);
    expect(parsed.config.secretKey).toBe("SECRET");
    expect(parsed.config.accessKey).toBe("AKID");
    expect(parsed.config.prefix).toBe("trip/2026");
    expect(parsed.config.deviceId).toBeUndefined();
  });

  it("往返：导出再导入得到同一份配置（deviceId 留空交给调用方）", () => {
    const result = parsePhotoConfigExport(exportPhotoConfig(FULL));
    expect(result.ok).toBe(true);
    expect(result.config).toEqual({ ...normalizePhotoConfig(FULL), deviceId: "" });
  });

  it("容错：裸配置对象（没有 kind 包装）也能导入", () => {
    const result = parsePhotoConfigExport(JSON.stringify({ provider: "qiniu", bucket: "b", accessKey: "AK", secretKey: "SK", domain: "cdn.example.com" }));
    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("qiniu");
  });

  it("拒绝：非 JSON / 空 / 数组", () => {
    expect(parsePhotoConfigExport("photos 配置")).toMatchObject({ ok: false, error: "badJson" });
    expect(parsePhotoConfigExport("")).toMatchObject({ ok: false, error: "badJson" });
    expect(parsePhotoConfigExport("[1,2]")).toMatchObject({ ok: false, error: "badJson" });
    expect(parsePhotoConfigExport(null)).toMatchObject({ ok: false, error: "badJson" });
  });

  it("拒绝：别的工具的导出（kind 不对）与过新的版本", () => {
    expect(parsePhotoConfigExport(JSON.stringify({ kind: "toolcove-sync", config: {} }))).toMatchObject({ ok: false, error: "badKind" });
    expect(parsePhotoConfigExport(JSON.stringify({ kind: PHOTO_CONFIG_EXPORT_KIND, version: 99, config: {} }))).toMatchObject({ ok: false, error: "badVersion" });
  });

  it("拒绝：不认识的 provider（拼错一个字母不能静默按 S3 走）", () => {
    expect(parsePhotoConfigExport(JSON.stringify({ provider: "s33", endpoint: "e.com", region: "r", bucket: "b", accessKey: "a", secretKey: "s" }))).toMatchObject({
      ok: false,
      error: "badProvider",
    });
  });

  it("拒绝：缺字段时把逐字段原因码带出来（界面能指到具体输入框）", () => {
    const result = parsePhotoConfigExport(JSON.stringify({ provider: "s3", endpoint: "cos.example.com" }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid");
    expect(result.errors.region).toBe("regionEmpty");
    expect(result.errors.bucket).toBe("bucketEmpty");
  });

  it("导入七牛配置：私有桶默认与上传域名缺省都保留", () => {
    const result = parsePhotoConfigExport(JSON.stringify({ provider: "qiniu", bucket: "b", accessKey: "AK", secretKey: "SK", domain: "cdn.example.com" }));
    expect(result.ok).toBe(true);
    expect(result.config.privateBucket).toBe(true);
    expect(result.config.uploadHost).toBe("upload.qiniup.com");
  });
});
