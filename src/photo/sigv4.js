// AWS Signature V4 签名（浏览器 WebCrypto 实现，Android WebView / iOS Safari / Node 单测同一份）。
//
// 为什么手写而不引 SDK：SDK 体积以 MB 计，而我们只需要「给一个 PUT / 一个 GET 签名」；
// 签名算法本身是稳定的公开标准，配一条官方测试向量就能锁住正确性（见 sigv4.test.js）。
//
// 适用面：腾讯 COS / MinIO / Cloudflare R2 / AWS S3 等 S3 兼容服务统一走这一份；
// 七牛（P2）用的是另一套 token 体系，不在这条线里。
const encoder = new TextEncoder();

export function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data) {
  const buf = typeof data === "string" ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(digest));
}

async function hmacSha256(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, typeof message === "string" ? encoder.encode(message) : message);
  return new Uint8Array(sig);
}

/** RFC 3986 编码：只放过 A-Za-z0-9-_.~，其余一律百分号编码（AWS 对 `!*'()` 也要求编码）。 */
export function uriEncode(input, encodeSlash = true) {
  let out = "";
  for (const ch of String(input)) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === "/") out += encodeSlash ? "%2F" : "/";
    else out += encoder.encode(ch).reduce((acc, b) => acc + "%" + b.toString(16).toUpperCase().padStart(2, "0"), "");
  }
  return out;
}

/** `20250830T123600Z`（UTC，不分时区；签名必须用 UTC）。 */
export function formatAmzDate(date) {
  const iso = date.toISOString().replace(/[-:]/g, "");
  return iso.slice(0, 15) + "Z";
}

/** 规范的查询串：编码 → 按 (key, value) 字典序排序 → 拼接。URL 与 canonical request 共用同一份。 */
export function buildQueryString(query) {
  const pairs = Array.isArray(query)
    ? query
    : Object.entries(query || {});
  return pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(String(v ?? ""))])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function canonicalHeadersOf(headers) {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).replace(/\s+/g, " ").trim()])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * 签名请求。返回需要附加到请求上的头部。
 *
 * @param {object} opts
 *  - method / host / path（未编码的 key 路径，函数内逐段编码）/ query（数组或对象）
 *  - headers：要参与签名的附加头（如 content-type、x-amz-content-sha256；host 自动加入）
 *  - payloadHash：请求体的 sha256 十六进制；GET/HEAD 传空体哈希（只进 canonical request 的末行，
 *    不作为头部自动加入——签哪些头由调用方决定，官方测试向量才能原样复现）
 *  - region / service（默认 s3）/ accessKey / secretKey / sessionToken（可选，临时密钥）
 *  - now：Date（测试注入固定时间）
 */
export async function signS3Request(opts) {
  const {
    method,
    host,
    path,
    query = [],
    headers = {},
    payloadHash,
    region,
    service = "s3",
    accessKey,
    secretKey,
    sessionToken = "",
    now = new Date(),
  } = opts;

  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const signHeaders = { host, "x-amz-date": amzDate, ...headers };
  if (sessionToken) signHeaders["x-amz-security-token"] = sessionToken;

  const canonHeaders = canonicalHeadersOf(signHeaders);
  const signedHeaders = canonHeaders.map(([name]) => name).join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    uriEncode(path, false),
    buildQueryString(query),
    canonHeaders.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let key = await hmacSha256(encoder.encode(`AWS4${secretKey}`), dateStamp);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, service);
  key = await hmacSha256(key, "aws4_request");
  const signature = toHex(await hmacSha256(key, stringToSign));

  return {
    amzDate,
    payloadHash,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** 空请求体的哈希（GET/HEAD 与事件负载用），常量省一次摘要计算。 */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
