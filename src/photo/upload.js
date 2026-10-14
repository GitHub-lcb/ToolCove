// 存储请求（浏览器直发）：PUT 上传、ListObjectsV2 列举/探活、错误解析。
//
// 走浏览器原生 fetch 而不是平台代理：这样手机 App（WebView）、iOS 网页版与桌面浏览器
// 是同一条代码路径——iOS 没有原生桥，直发是唯一可行方案，干脆让三端一致。
// 代价是受 CORS 约束：桶需要按 README 里的 CORS 配置放行 PUT/GET/HEAD（文档给了现成 JSON）。
import { normalizePhotoConfig, photoHost, photoObjectPath } from "./config.js";
import { PhotoError } from "./errors.js";
import { putQiniuObject } from "./qiniu.js";
import { buildQueryString, EMPTY_SHA256, sha256Hex, signS3Request, uriEncode } from "./sigv4.js";
import { putWebdavObject } from "./webdav.js";

export { PhotoError };

const encoder = new TextEncoder();

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function unescapeXml(text) {
  return String(text ?? "").replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);
}

/** 从 S3 错误响应里取 `<Code>`（SignatureDoesNotMatch / AccessDenied / NoSuchBucket…）。 */
export function errorCodeOf(xml) {
  const match = /<Code>([^<]*)<\/Code>/.exec(String(xml ?? ""));
  return match ? unescapeXml(match[1]).trim() : "";
}

export function errorMessageOf(xml) {
  const match = /<Message>([^<]*)<\/Message>/.exec(String(xml ?? ""));
  return match ? unescapeXml(match[1]).trim() : String(xml ?? "").slice(0, 200);
}

async function bodyBytes(body) {
  if (body == null) return null;
  if (body instanceof Uint8Array) return body;
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === "string") return encoder.encode(body);
  if (typeof body.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer());
  throw new PhotoError("badBody", "不支持的上传体类型");
}

/**
 * 签名并发出一次请求。URL 与 canonical URI 用**同一份**未编码路径经同一函数编码，
 * 两条线没有分叉的可能（这是 SigV4 最容易错的地方）。
 */
export async function s3Request({ config, method, path, query = [], headers = {}, body, fetchImpl, now }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) throw new PhotoError("noFetch", "当前环境没有 fetch");
  const bytes = await bodyBytes(body);
  const payloadHash = bytes ? await sha256Hex(bytes) : EMPTY_SHA256;
  // content-sha 头由这里显式加入参与签名（signS3Request 自身不碰它，见其注释）
  const signHeaders = { "x-amz-content-sha256": payloadHash, ...headers };

  const signed = await signS3Request({
    method,
    host: photoHost(config),
    path,
    query,
    headers: signHeaders,
    payloadHash,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    sessionToken: config.sessionToken,
    now,
  });

  const queryText = buildQueryString(query);
  const url = `https://${photoHost(config)}${uriEncode(path, false)}${queryText ? `?${queryText}` : ""}`;
  const sendHeaders = { ...signHeaders, Authorization: signed.authorization, "x-amz-date": signed.amzDate };
  if (config.sessionToken) sendHeaders["x-amz-security-token"] = config.sessionToken;

  const res = await fetchFn(url, { method: method.toUpperCase(), headers: sendHeaders, body: bytes || undefined });
  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch {
      // 读取错误体失败不应掩盖状态码，下面照样抛
    }
    throw new PhotoError(errorCodeOf(text) || `HTTP ${res.status}`, errorMessageOf(text));
  }
  return res;
}

/** 上传一张照片：PUT 到签名 URL，成功后返回 ETag（桶若配置了 ExposeHeader=ETag 才有值）。 */
export async function putPhotoObject({ config, key, body, contentType = "", fetchImpl, now }) {
  const cfg = normalizePhotoConfig(config);
  const headers = contentType ? { "content-type": contentType } : {};
  const res = await s3Request({ config: cfg, method: "PUT", path: photoObjectPath(cfg, key), headers, body, fetchImpl, now });
  return { status: res.status, etag: (res.headers?.get?.("etag") || "").replace(/"/g, "") };
}

/** 上传分派：按 provider 走各自实现。调用方（队列/视图）不需要知道底下是哪家。 */
export async function putPhoto({ config, key, body, contentType = "", fetchImpl, now }) {
  const cfg = normalizePhotoConfig(config);
  if (cfg.provider === "qiniu") return putQiniuObject({ config: cfg, key, body, fetchImpl, now });
  if (cfg.provider === "webdav") return putWebdavObject({ config: cfg, key, body, contentType, fetchImpl });
  return putPhotoObject({ config: cfg, key, body, contentType, fetchImpl, now });
}

/** 解析 ListObjectsV2 响应。key 是我们自建的受限字符集，仍按规范解实体，防手改过的对象名。 */
export function parseListObjectsXml(xml) {
  const text = String(xml ?? "");
  const objects = [];
  for (const block of text.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
      return m ? unescapeXml(m[1]) : "";
    };
    objects.push({
      key: pick("Key"),
      size: Number(pick("Size")) || 0,
      etag: pick("ETag").replace(/"/g, ""),
      lastModified: pick("LastModified"),
    });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(text);
  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text);
  return { objects, truncated, nextToken: tokenMatch ? unescapeXml(tokenMatch[1]) : "" };
}

/** 列举对象（按 key 字典序）。桌面端归档走 Rust 实现，这里主要服务探活与将来的网页版浏览。 */
export async function listObjects({ config, prefix = "", maxKeys = 1000, continuationToken = "", fetchImpl, now }) {
  const cfg = normalizePhotoConfig(config);
  const query = [["list-type", "2"], ["max-keys", String(maxKeys)]];
  if (prefix) query.push(["prefix", prefix]);
  if (continuationToken) query.push(["continuation-token", continuationToken]);

  // ⚠️ 路径风格（MinIO、**七牛的 S3 兼容端点**）必须把桶写进路径：
  // 它们的 CORS 规则是按桶匹配的——少了这一段，七牛连预检都回不了 CORS 头，
  // 浏览器侧表现为一个看不出所以然的 "CORS 错误"（实测踩到）。
  // 虚拟主机风格（COS / R2 / AWS 默认）才是 path = "/"，桶在域名前缀里。
  const path = cfg.pathStyle ? `/${cfg.bucket}/` : "/";
  const res = await s3Request({ config: cfg, method: "GET", path, query, fetchImpl, now });
  return parseListObjectsXml(await res.text());
}

/** 探活：列出 1 个对象。签名对 → 成功；权限/地址/密钥问题在错误码里能区分开。 */
export async function testPhotoConnection({ config, prefix = "", fetchImpl, now }) {
  const cfg = normalizePhotoConfig(config);
  const result = await listObjects({ config: cfg, prefix: `${cfg.prefix}/`, maxKeys: 1, fetchImpl, now });
  return { ok: true, sampleCount: result.objects.length, truncated: result.truncated };
}
