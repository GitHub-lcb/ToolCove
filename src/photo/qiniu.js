// 七牛云 Kodo 的上传侧（浏览器直传）。
//
// 凭证模型与 S3 系不同：不是逐请求签名，而是先签一张"上传凭证"（upToken）交给表单上传接口。
//   policy = {"scope":"<bucket>:<key>","deadline":<unix秒>}
//   upToken = "<AK>:<urlsafe_b64(HMAC-SHA1(SK, policy_b64))>:<policy_b64>"  ← 三段，策略本身要随证带上
// scope 钉到具体 key —— 这张凭证只能传这一个对象，泄露面比桶级凭证小。
//
// 上传走表单（multipart/form-data）：七牛的上传域名对浏览器跨域上传是放行的（官方 JS SDK 即此路径），
// 所以手机直传在七牛上不需要用户额外配置 CORS（S3 系则需要，见 docs/photo-storage-setup.md）。
import { normalizePhotoConfig, qiniuUploadUrl } from "./config.js";
import { PhotoError } from "./errors.js";

const encoder = new TextEncoder();

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

/** 表单直传一个对象。成功返回七牛计算的 hash（内容 etag）。 */
export async function putQiniuObject({ config, key, body, fetchImpl, now }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) throw new PhotoError("noFetch", "当前环境没有 fetch");
  const cfg = normalizePhotoConfig(config);

  const base = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const deadline = Math.floor(base / 1000) + 3600;
  const token = await qiniuUploadToken({ accessKey: cfg.accessKey, secretKey: cfg.secretKey, bucket: cfg.bucket, key, deadline });

  const form = new FormData();
  form.append("token", token);
  form.append("key", key);
  const fileName = String(key).split("/").pop() || "photo.jpg";
  form.append("file", body instanceof Blob ? body : new Blob([body], { type: "application/octet-stream" }), fileName);

  const res = await fetchFn(qiniuUploadUrl(cfg), { method: "POST", body: form });
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
