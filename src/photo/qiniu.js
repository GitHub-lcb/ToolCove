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
/**
 * 区域解析的**详细版**：除了域名，还给出"为什么没解析出来"。
 *
 * 为什么要详细：导航式上游把失败吞掉（只返回空串），调用方只能退回默认域名，
 * 于是用户看到的是上传的 401 BadToken —— 而真实原因可能是 AK 填错、空间名填错、
 * 或者网络根本没通。这三种原因的修法完全不同，不能都报成"上传失败"。
 */
export async function resolveQiniuUploadHostDetailed({ accessKey, bucket, fetchImpl = null }) {
  const cacheKey = `${accessKey}|${bucket}`;
  const cached = uploadHostCache.get(cacheKey);
  if (cached !== undefined) return { host: cached, reason: "", message: "" };

  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) return { host: "", reason: "noFetch", message: "当前环境没有 fetch" };
  try {
    const url = `${QINIU_REGION_QUERY}?ak=${encodeURIComponent(accessKey)}&bucket=${encodeURIComponent(bucket)}`;
    const res = await fetchFn(url);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 非 JSON：按原文报出去，比"解析失败"有用
    }
    if (!res.ok) {
      const message = String(json?.error || text || `HTTP ${res.status}`).slice(0, 200);
      return { host: "", reason: classifyQiniuQueryError(message), message };
    }
    const up = json?.up || json?.data?.up;
    const host = up?.acc?.main?.[0] || up?.src?.main?.[0] || "";
    if (!host) return { host: "", reason: "unknown", message: "区域接口没有返回上传域名" };
    uploadHostCache.set(cacheKey, host);
    return { host, reason: "", message: "" };
  } catch (e) {
    // 网络异常不该中断上传：走兜底域名继续试，但把原因带出去
    return { host: "", reason: "network", message: String(e?.message || e) };
  }
}

export async function resolveQiniuUploadHost(args) {
  return (await resolveQiniuUploadHostDetailed(args)).host;
}

/**
 * 把区域接口的错误文案归成三类可操作的原因。
 * 文案来自七牛：AK 不认识 → `app/accesskey is not found`；空间不存在 → `no such bucket` 一类。
 */
export function classifyQiniuQueryError(message) {
  const text = String(message || "");
  if (/accesskey|access key|app\/accesskey/i.test(text)) return "accessKey";
  if (/no such bucket|bucket.*(not|不存在)/i.test(text)) return "bucket";
  return "unknown";
}

/**
 * 「测试连接」在网页/手机端唯一能做的一件事：问区域接口这套 AK + 空间名对不对。
 *
 * 为什么需要它：七牛的列举要走管理接口（需要额外签名，网页端做不了），
 * 所以非桌面端原本**没有任何办法**验证凭据，用户只会在上传时拿到一句 401 BadToken。
 * 这个接口免签名且带 CORS 头，浏览器直连可用，正好补上这个缺口。
 * 返回 { ok, uploadHost, reason, message }；reason ∈ accessKey / bucket / network / unknown。
 */
export async function checkQiniuSpace({ accessKey, bucket, fetchImpl = null }) {
  const result = await resolveQiniuUploadHostDetailed({ accessKey, bucket, fetchImpl });
  return result.host
    ? { ok: true, uploadHost: result.host, reason: "", message: "" }
    : { ok: false, uploadHost: "", reason: result.reason, message: result.message };
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

/**
 * 上传失败时的**归因**：把区域解析的结论拼进错误里。
 *
 * 401 BadToken 在七牛侧对应三种完全不同的原因，用户看到的却永远是同一句：
 *   · 区域解析**成功**（拿到了上传域名）→ AK 与空间名都是真的，问题在 SK（签错了）或设备时钟；
 *   · 区域解析说 accesskey 不对 → AK 填错，或这个空间不属于该账号；
 *   · 区域解析说没有这个空间 → 空间名写错（常见：把 CDN 域名或完整桶名填进去）；
 *   · 区域解析**请求本身**没通 → 网络/DNS 问题，此时退回默认上传域名，本来就是盲试。
 * 这四种在真机上都出现过（用户只看到"BadToken"），所以必须区分开。
 */
export function diagnoseQiniuUploadFailure(body, resolved = {}) {
  const text = String(body || "");
  if (!/BadToken|bad token/i.test(text)) return "";
  if (resolved.reason === "accessKey") return `（区域接口：${resolved.message} → AccessKey 不对，或这个空间不属于该账号）`;
  if (resolved.reason === "bucket") return `（区域接口：${resolved.message} → 空间名不对，要填空间名而不是域名）`;
  if (resolved.reason === "network" || resolved.reason === "noFetch") return `（区域解析也没通：${resolved.message} → 已退回默认上传域名，先查网络）`;
  if (resolved.reason) return `（区域解析失败：${resolved.message}）`;
  if (resolved.host) return `（空间已解析到 ${resolved.host}，AK 与空间名有效 → 更可能是 SecretKey 不对，或设备时钟偏差把凭证签成了过期）`;
  return "";
}

/**
 * 真发一次上传来给配置"判死刑"：**这是唯一能把 BadToken 的三种原因分开的办法**。
 *
 * 为什么不能只验签名：七牛没有"既免签名又能验 SK"的接口——管理接口（rsf/rs）不给浏览器
 * CORS（预检不放行 Authorization），而上传域名只认 POST。于是只有真发一次请求，三种原因才会现形：
 *   · SK 不对 → 两种期限的凭证都被拒（BadToken）；
 *   · 设备时钟偏差 → 正常期限的凭证被拒，但**一年期限**的凭证被接受；
 *   · 区域/域名不对 → 两种都被拒，且区域解析那一步已经先报出来了。
 *
 * 探针对象 1 字节，放在 `toolcove-selftest/` 下，控制台里一眼能认出并删除。
 * 返回 { ok, key, etag, clockSkew, reason, message }。
 */
export async function probeQiniuUpload({ config, fetchImpl = null, now = Date.now() } = {}) {
  const cfg = normalizePhotoConfig(config);
  const key = `toolcove-selftest/probe-${Date.now()}.txt`;
  const body = new Blob([new Uint8Array([0x54])], { type: "text/plain" });
  try {
    const out = await putQiniuObject({ config: cfg, key, body, fetchImpl, now });
    return { ok: true, key, etag: out.etag, clockSkew: false, reason: "", message: "" };
  } catch (e) {
    const message = String(e?.message || e);
    if (!/BadToken|bad token/i.test(message)) return { ok: false, key, reason: "upload", message };
    // 同样的内容再用"一年后过期"的凭证试一次：能过说明问题在设备时钟，不是密钥
    try {
      await putQiniuObject({ config: cfg, key, body, fetchImpl, now: now + 365 * 24 * 3600 * 1000 });
      return { ok: false, key, clockSkew: true, reason: "clock", message };
    } catch {
      return { ok: false, key, clockSkew: false, reason: "secretKey", message };
    }
  }
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
  const resolved = explicitHost
    ? { host: explicitHost, reason: "", message: "" }
    : await resolveQiniuUploadHostDetailed({ accessKey: cfg.accessKey, bucket: cfg.bucket, fetchImpl });
  const uploadHost = resolved.host || cfg.uploadHost || QINIU_DEFAULT_UPLOAD_HOST;

  const form = new FormData();
  form.append("token", token);
  form.append("key", key);
  const fileName = String(key).split("/").pop() || "photo.jpg";
  form.append("file", body instanceof Blob ? body : new Blob([body], { type: "application/octet-stream" }), fileName);

  const res = await fetchFn(`https://${uploadHost}/`, { method: "POST", body: form });
  const text = await res.text();
  if (!res.ok) throw new PhotoError(`HTTP ${res.status}`, `${text.slice(0, 200)}${diagnoseQiniuUploadFailure(text, resolved)}`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应按失败处理（网关页面之类），不给"看起来成功"留缝
  }
  if (!json || json.error) throw new PhotoError(json?.error || "badResponse", text.slice(0, 200));
  return { status: res.status, etag: String(json.hash || "") };
}
