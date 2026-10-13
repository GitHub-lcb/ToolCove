// 七牛云 Kodo 的上传侧（浏览器直传）。
//
// 凭证模型与 S3 系不同：不是逐请求签名，而是先签一张"上传凭证"（upToken）交给表单上传接口。
//   policy = {"scope":"<bucket>:<key>","deadline":<unix秒>}
//   upToken = "<AK>:<urlsafe_b64(HMAC-SHA1(SK, policy_b64))>:<policy_b64>"  ← 三段，策略本身要随证带上
// scope 钉到具体 key —— 这张凭证只能传这一个对象，泄露面比桶级凭证小。
//
// **上传域名必须先做区域解析**（官方浏览器 SDK 同款）：新注册账号的空间常在新机房
// （如华东-浙江2），旧的全局域名 upload.qiniup.com 不服务它们——直传会拿到 401 BadToken
// （实测踩到，和密钥无关）。解析接口 api.qiniu.com/v2/query 免签名、对浏览器放行 CORS。
import { QINIU_DEFAULT_UPLOAD_HOST, normalizePhotoConfig } from "./config.js";
import { PhotoError } from "./errors.js";

const encoder = new TextEncoder();

/** 区域解析接口（qiniu-js 官方 SDK 用的就是它）。 */
const QINIU_REGION_QUERY = "https://api.qiniu.com/v2/query";

/** 会话内缓存 ak+bucket → 上传域名（区域解析一天内不会变，重传不必再问）。 */
const uploadHostCache = new Map();

/** 测试用：清空区域缓存。 */
export function resetQiniuHostCache() {
  uploadHostCache.clear();
}

/**
 * 解析该空间的区域上传域名。失败返回空串（调用方兜底）。
 * 响应形状兼容两种：`{ up: { acc: { main: [...] } } }`（直连 API）
 * 与 `{ data: { up: ... } }`（个别 SDK 包装）。
 */
export async function resolveQiniuUploadHost({ accessKey, bucket, fetchImpl = null }) {
  const cacheKey = `${accessKey}|${bucket}`;
  const cached = uploadHostCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const fetchFn = fetchImpl || globalThis.fetch;
  let host = "";
  try {
    const url = `${QINIU_REGION_QUERY}?ak=${encodeURIComponent(accessKey)}&bucket=${encodeURIComponent(bucket)}`;
    const res = await fetchFn(url);
    if (res.ok) {
      const json = await res.json();
      const up = json?.up || json?.data?.up;
      host = up?.acc?.main?.[0] || up?.src?.main?.[0] || "";
    }
  } catch {
    // 解析失败不是致命错误：走调用方的兜底域名，真实错误会由上传本身报出来
  }
  if (typeof host === "string" && host) uploadHostCache.set(cacheKey, host);
  return host;
}

/** URL-safe Base64（七牛凭证的编码约定：+→-、/→_、去填充）。 */
export function urlsafeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha1(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * 生成上传凭证（三段式：AK:签名:策略）。deadline 为 UNIX 秒（七牛要求），
 * 调用方给足余量即可——凭证只在一次上传请求里用完即弃，不做缓存。
 */
export async function qiniuUploadToken({ accessKey, secretKey, bucket, key, deadline }) {
  const policy = JSON.stringify({ scope: `${bucket}:${key}`, deadline });
  const policyB64 = urlsafeBase64(encoder.encode(policy));
  const sign = urlsafeBase64(await hmacSha1(secretKey, policyB64));
  return `${accessKey}:${sign}:${policyB64}`;
}

/** 表单直传一个对象。成功返回七牛计算的 hash（内容 etag）。
 *  上传域名选择顺序：用户显式配置的域名（非默认值）＞ 区域解析 ＞ 默认全局域名。 */
export async function putQiniuObject({ config, key, body, fetchImpl, now }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) throw new PhotoError("noFetch", "当前环境没有 fetch");
  const cfg = normalizePhotoConfig(config);

  const base = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const deadline = Math.floor(base / 1000) + 3600;
  const token = await qiniuUploadToken({ accessKey: cfg.accessKey, secretKey: cfg.secretKey, bucket: cfg.bucket, key, deadline });

  const explicitHost = cfg.uploadHost && cfg.uploadHost !== QINIU_DEFAULT_UPLOAD_HOST ? cfg.uploadHost : "";
  const resolvedHost = explicitHost || (await resolveQiniuUploadHost({ accessKey: cfg.accessKey, bucket: cfg.bucket, fetchImpl }));
  const uploadHost = resolvedHost || cfg.uploadHost || QINIU_DEFAULT_UPLOAD_HOST;

  const form = new FormData();
  form.append("token", token);
  form.append("key", key);
  const fileName = String(key).split("/").pop() || "photo.jpg";
  form.append("file", body instanceof Blob ? body : new Blob([body], { type: "application/octet-stream" }), fileName);

  const res = await fetchFn(`https://${uploadHost}/`, { method: "POST", body: form });
  const text = await res.text();
  if (!res.ok) throw new PhotoError(`HTTP ${res.status}`, text.slice(0, 200));
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应按失败处理（网关页面之类），不给"看起来成功"留缝
  }
  if (!json || json.error) throw new PhotoError(json?.error || "badResponse", text.slice(0, 200));
  return { status: res.status, etag: String(json.hash || "") };
}
