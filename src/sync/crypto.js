// 云同步加密模块（纯 JS + WebCrypto，可单测）：
// 派生（PBKDF2-SHA256 600k）→ AES-256-GCM 信封 → HMAC ID 混淆。
// 零知识设计：服务器只接触密文/HMAC 输出/时间戳；本模块永不触碰任何服务器。

const ITERATIONS = 600_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function bufToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  // 统一输出 base64url（去填充），与 atob 输入兼容见 b64ToBuf
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64ToBuf(b64) {
  // base64url → 标准 base64 补填充，atob 不接受 -/_ 字符
  let std = String(b64).replace(/-/g, "+").replace(/_/g, "/");
  while (std.length % 4) std += "=";
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error("sync-crypto-unavailable");
  return s;
}

/** 生成随机盐（16B，base64url） */
export function newSalt() {
  const bytes = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return bufToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/*
 // 供 node（vitest）与浏览器一致：base64url 自由转换
*/
/* base64url 无需再转：bufToB64 已输出 url-safe；保留此函数以防残留调用 */
function b64url(s) { return s; }

/** 派生主密钥（PBKDF2-SHA256，600k 迭代）→ base64url 32B。同输入必同输出。 */
export async function deriveMasterKey(password, saltB64) {
  if (!password || typeof password !== "string" || password.length < 8) throw new Error("sync-password-too-short");
  if (!saltB64 || typeof saltB64 !== "string") throw new Error("sync-bad-salt");
  const s = await subtle();
  const keyMaterial = await s.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await s.deriveKey(
    { name: "PBKDF2", salt: b64ToBuf(saltB64), iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: KEY_BYTES * 8 },
    true, // 需 export 为可落盘字符串（DPAPI 前）；本地机密，不涉及导出给第三方
    ["encrypt", "decrypt"]
  );
  // 导出为可落盘（DPAPI 前需字符串）的 raw key
  const raw = await s.exportKey("raw", key);
  return b64url(bufToB64(new Uint8Array(raw)));
}

/*
 // deriveKey 得到的 CryptoKey 无法序列化：改用「派生→导出 raw → 再导入 AES-GCM key」策略，
 // 保证 masterKeyB64(字符串) 可存 settings 且各端一致。下面 buildAesKey 供加解密复用。
*/
async function buildAesKey(masterKeyB64) {
  const s = await subtle();
  return s.importKey("raw", b64ToBuf(masterKeyB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** 生成新 nonce（12B） */
export function newNonce() {
  const b = new Uint8Array(NONCE_BYTES);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/**
 * 加密信封：base64(nonce || ciphertext || tag)。
 * payload 为已序列化字符串（调用方组装 envelope JSON：{deviceId, ts, record}）。
 */
export async function encryptEnvelope(masterKeyB64, payloadString) {
  const s = await subtle();
  const key = await buildAesKey(masterKeyB64);
  const nonce = newNonce();
  const ct = await s.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(payloadString));
  const out = new Uint8Array(NONCE_BYTES + ct.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(ct), NONCE_BYTES);
  return b64url(bufToB64(out));
}

/** 解密信封；任何失败（篡改/错钥）抛错 sync-bad-cipher */
export async function decryptEnvelope(masterKeyB64, cipherB64) {
  const s = await subtle();
  const key = await buildAesKey(masterKeyB64);
  const raw = b64ToBuf(cipherB64);
  if (raw.length < NONCE_BYTES + TAG_BYTES + 1) throw new Error("sync-bad-cipher");
  const nonce = raw.subarray(0, NONCE_BYTES);
  const data = raw.subarray(NONCE_BYTES);
  try {
    const pt = await s.decrypt({ name: "AES-GCM", iv: nonce }, key, data);
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("sync-bad-cipher");
  }
}

/** ID 混淆：HMAC-SHA256(recordId) → 64 hex（真实 uuid 永不上云） */
export async function obfuscateId(masterKeyB64, recordId) {
  const s = await subtle();
  const key = await s.importKey("raw", b64ToBuf(masterKeyB64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await s.sign("HMAC", key, new TextEncoder().encode(String(recordId)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 组装信封 JSON（含 LWW 裁决字段 deviceId + ts，及记录类别 kind）。
 * kind 随信封加密（服务端不可见）：拉取时据此把记录投放到正确的数据类别，
 * 缺失时视为旧格式，由 engine 用本地已有记录反查归属。
 */
export function makeEnvelope(deviceId, ts, record, kind) {
  const out = { deviceId, ts, record };
  if (kind) out.kind = String(kind);
  return JSON.stringify(out);
}

/** 解析信封 JSON（解密后调用）；解析失败抛 sync-bad-envelope */
export function parseEnvelope(jsonString) {
  try {
    const o = JSON.parse(jsonString);
    if (!o || typeof o !== "object" || typeof o.deviceId !== "string" || typeof o.ts !== "number" || !o.record) {
      throw new Error("shape");
    }
    return o;
  } catch {
    throw new Error("sync-bad-envelope");
  }
}

/** 派生结果进程内缓存（不缓存密码；同 salt 同密码只派一次） */
const deriveCache = new Map();
export async function cachedDerive(password, saltB64) {
  const k = saltB64 + ":" + password;
  if (deriveCache.has(k)) return deriveCache.get(k);
  const key = await deriveMasterKey(password, saltB64);
  if (deriveCache.size > 8) deriveCache.clear();
  deriveCache.set(k, key);
  return key;
}