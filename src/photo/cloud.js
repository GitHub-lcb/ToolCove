// 云端对象管理：列出 / 预览 / 删除 / 移动（改目录）——手机端「云端」页用的那一层。
//
// 为什么走 platform/invoke 的 http_request 而不是 fetch：
//   · 七牛的管理接口**不给浏览器 CORS**：rsf 的 list 放行简单请求，而 rs.qiniuapi.com 的删/移
//     连 Access-Control-Allow-Origin 都没有——用 fetch 发出去也读不到结果；
//   · 安卓里 http_request 走原生桥（HttpURLConnection）、桌面走 Rust 代理，两者都不受 CORS 约束，
//     凭证放 Authorization 头最稳；
//   · 网页版只能退化成「把凭证放进 access_token 查询参数」（七牛允许这种传法）的简单请求。
//     删/移即使真的执行了也读不到响应，所以**统一用「操作后重新列举」判定成败**——
//     列表用的是放行 CORS 的 rsf，它的结果才是可信的。
import { invoke } from "../platform/invoke.js";
import { isDesktop, isNativeMobile } from "../platform/env.js";
import { normalizePhotoConfig, photoObjectPath } from "./config.js";
import { hmacSha1, resolveQiniuUploadHostDetailed, urlsafeBase64 } from "./qiniu.js";
import { listObjects, s3Request } from "./upload.js";
import { uriEncode } from "./sigv4.js";

const encoder = new TextEncoder();

/** 七牛管理接口的默认域名（区域解析失败时的兜底；新机房空间不认它）。 */
export const QINIU_DEFAULT_RSF_HOST = "rsf.qbox.me";

/** 这一端能不能用 Authorization 头（否则只能走简单请求 + access_token 查询参数）。 */
export function canSendAuthHeader() {
  return isDesktop || isNativeMobile;
}

/** 管理凭证：`QBox AK:sign`，签名串是「METHOD path?query\nHost: host\nContent-Type: ct\n\n」。
 *  与桌面端 Rust 的 qiniu_management_auth 逐字一致——两边必须能互相验证。 */
export async function qiniuManagementAuth({ config, method, host, pathAndQuery, contentType = "application/x-www-form-urlencoded" }) {
  const cfg = normalizePhotoConfig(config);
  const signing = `${method} ${pathAndQuery}\nHost: ${host}\nContent-Type: ${contentType}\n\n`;
  const sign = urlsafeBase64(await hmacSha1(cfg.secretKey, signing));
  return `QBox ${cfg.accessKey}:${sign}`;
}

/**
 * 发一次管理接口请求。返回 { ok, status, body }；网络层异常原样抛出（调用方要能看见原因）。
 *
 * 网页版把凭证放查询参数是**唯一**能让浏览器发出去的形式（自定义头会触发预检，而七牛不放行预检）。
 */
export async function qiniuManagementRequest({ config, method, host, pathAndQuery, contentType = "application/x-www-form-urlencoded", http }) {
  const auth = await qiniuManagementAuth({ config, method, host, pathAndQuery, contentType });
  const withHeader = canSendAuthHeader();
  const separator = pathAndQuery.includes("?") ? "&" : "?";
  const url = withHeader
    ? `https://${host}${pathAndQuery}`
    : `https://${host}${pathAndQuery}${separator}access_token=${encodeURIComponent(auth)}`;
  const send = http || ((args) => invoke("http_request", args));
  const result = await send({
    method,
    url,
    headers: withHeader ? { Authorization: auth, "Content-Type": contentType } : { "Content-Type": contentType },
    timeoutMs: 20000,
  });
  const status = Number(result?.status || 0);
  return { ok: status >= 200 && status < 300, status, body: String(result?.body ?? "") };
}

/** 组织成管理接口要的 entry：`bucket:key` 再做 URL-safe base64。 */
export function qiniuEntry(bucket, key) {
  return urlsafeBase64(encoder.encode(`${bucket}:${key}`));
}

/** 该后端能不能在手机上浏览云端。WebDAV 的列举要 PROPFIND 且各家 CORS 不一，暂不提供。 */
export function cloudProviderOf(config) {
  const provider = normalizePhotoConfig(config).provider;
  return provider === "qiniu" || provider === "s3" ? provider : "";
}

/**
 * 列出云端对象（按 key 升序）。
 * 返回 { objects: [{ key, name, size, lastModified, etag }], nextMarker, truncated }。
 */
export async function listCloudObjects({ config, prefix = "", marker = "", limit = 50, http, fetchImpl } = {}) {
  const cfg = normalizePhotoConfig(config);
  const provider = cloudProviderOf(cfg);
  if (!provider) throw new Error("unavailable");

  if (provider === "s3") {
    const page = await listObjects({ config: cfg, prefix, maxKeys: limit, continuationToken: marker, fetchImpl });
    return {
      objects: page.objects.map((item) => ({
        key: item.key,
        name: item.key.split("/").pop() || item.key,
        size: Number(item.size) || 0,
        lastModified: String(item.lastModified || "").slice(0, 10),
        etag: String(item.etag || "").replace(/"/g, ""),
      })),
      nextMarker: page.nextToken || "",
      truncated: !!page.truncated,
    };
  }

  // 七牛：列表域名同样要区域解析（新机房空间的 rsf 在老域名上会 401）
  const resolved = await resolveQiniuUploadHostDetailed({ accessKey: cfg.accessKey, bucket: cfg.bucket, fetchImpl });
  const host = resolved.rsfHost || QINIU_DEFAULT_RSF_HOST;
  const pairs = [["bucket", cfg.bucket], ["limit", String(limit)]];
  if (prefix) pairs.push(["prefix", prefix]);
  if (marker) pairs.push(["marker", marker]);
  const pathAndQuery = `/list?${pairs.map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(String(v), true)}`).join("&")}`;
  const res = await qiniuManagementRequest({ config: cfg, method: "POST", host, pathAndQuery, http });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error("响应不是合法 JSON");
  }
  const objects = (Array.isArray(parsed?.items) ? parsed.items : [])
    .map((item) => {
      const key = String(item?.key || "");
      const putTime = Number(item?.putTime) || 0;
      return {
        key,
        name: key.split("/").pop() || key,
        size: Number(item?.fsize) || 0,
        // putTime 是 100 纳秒单位
        lastModified: putTime > 0 ? new Date(putTime / 10_000).toISOString().slice(0, 10) : "",
        etag: String(item?.hash || ""),
      };
    })
    .filter((item) => item.key);
  const nextMarker = String(parsed?.marker || "");
  return { objects, nextMarker, truncated: !!nextMarker };
}

/** 删除一个对象。网页版可能读不到响应，成败由调用方「重新列举」判定。 */
export async function deleteCloudObject({ config, key, http, fetchImpl } = {}) {
  const cfg = normalizePhotoConfig(config);
  const provider = cloudProviderOf(cfg);
  if (!provider) throw new Error("unavailable");
  if (provider === "qiniu") {
    const resolved = await resolveQiniuUploadHostDetailed({ accessKey: cfg.accessKey, bucket: cfg.bucket, fetchImpl });
    const host = resolved.rsfHost || QINIU_DEFAULT_RSF_HOST;
    const pathAndQuery = `/delete/${qiniuEntry(cfg.bucket, key)}`;
    const res = await qiniuManagementRequest({ config: cfg, method: "POST", host, pathAndQuery, http });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    return { ok: true };
  }
  // S3：DELETE 需要桶的 CORS 放行 DELETE 方法（文档里的示例只列了 PUT/GET/HEAD）
  return deleteS3Object({ config: cfg, key, fetchImpl });
}

/** 移动/改名（= 改目录）：七牛 POST /move/<src>/<dst>?force=true。 */
export async function moveCloudObject({ config, from, to, http, fetchImpl } = {}) {
  const cfg = normalizePhotoConfig(config);
  if (cloudProviderOf(cfg) !== "qiniu") throw new Error("unavailable");
  if (!to || to === from) return { ok: true, moved: false };
  const resolved = await resolveQiniuUploadHostDetailed({ accessKey: cfg.accessKey, bucket: cfg.bucket, fetchImpl });
  const host = resolved.rsfHost || QINIU_DEFAULT_RSF_HOST;
  const pathAndQuery = `/move/${qiniuEntry(cfg.bucket, from)}/${qiniuEntry(cfg.bucket, to)}?force=true`;
  const res = await qiniuManagementRequest({ config: cfg, method: "POST", host, pathAndQuery, http });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  return { ok: true, moved: true };
}

/**
 * 预览/下载用的 URL：公开空间直接裸链，私有空间带下载令牌。
 * 私有令牌的签名串是**完整 URL + ?e=deadline**（与桌面端 Rust 的 qiniu_download_token 一致）。
 */
export async function objectPreviewUrl({ config, key, deadlineSeconds = 3600 } = {}) {
  const cfg = normalizePhotoConfig(config);
  if (!cfg.domain) return "";
  const base = `https://${cfg.domain}/${uriEncode(key, false)}`;
  if (!cfg.privateBucket) return base;
  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;
  const sign = urlsafeBase64(await hmacSha1(cfg.secretKey, `${base}?e=${deadline}`));
  return `${base}?e=${deadline}&token=${cfg.accessKey}:${sign}`;
}

/** S3 删除（SigV4，复用上传那套签名与 URL 组装，不另写第二份）。 */
async function deleteS3Object({ config, key, fetchImpl }) {
  const res = await s3Request({ config, method: "DELETE", path: photoObjectPath(config, key), fetchImpl });
  return { ok: true, status: res.status };
}
