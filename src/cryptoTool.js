import {
  createMD5,
  createSHA1,
  createSHA256,
  createSHA384,
  createSHA512,
  md5,
} from "hash-wasm";

const HASH_FACTORIES = {
  MD5: createMD5,
  "SHA-1": createSHA1,
  "SHA-256": createSHA256,
  "SHA-384": createSHA384,
  "SHA-512": createSHA512,
};
const WEB_HASHES = new Set(["SHA-1", "SHA-256", "SHA-384", "SHA-512"]);
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function subtle() {
  if (!globalThis.crypto?.subtle) throw new Error("当前环境不支持 Web Crypto");
  return globalThis.crypto.subtle;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const value = String(hex ?? "").replace(/\s/g, "");
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("十六进制数据格式无效");
  return Uint8Array.from(value.match(/.{2}/g), (item) => Number.parseInt(item, 16));
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  let binary;
  try {
    binary = atob(String(value ?? "").replace(/\s/g, ""));
  } catch {
    throw new Error("Base64 数据格式无效");
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function formatBytes(bytes, output) {
  return output === "base64" ? bytesToBase64(bytes) : bytesToHex(bytes);
}

export async function digestText(text, algorithm = "SHA-256", output = "hex") {
  const value = String(text ?? "");
  if (algorithm === "MD5") {
    const hex = await md5(value);
    return output === "base64" ? bytesToBase64(hexToBytes(hex)) : hex;
  }
  if (!WEB_HASHES.has(algorithm)) throw new Error("不支持的摘要算法");
  const result = await subtle().digest(algorithm, ENCODER.encode(value));
  return formatBytes(new Uint8Array(result), output);
}

export async function hmacText(text, secret, algorithm = "SHA-256", output = "hex") {
  if (!WEB_HASHES.has(algorithm)) throw new Error("不支持的 HMAC 算法");
  const key = await subtle().importKey(
    "raw",
    ENCODER.encode(String(secret ?? "")),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signature = await subtle().sign("HMAC", key, ENCODER.encode(String(text ?? "")));
  return formatBytes(new Uint8Array(signature), output);
}

async function deriveAesKey(password, salt, iterations, usage) {
  const baseKey = await subtle().importKey("raw", ENCODER.encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

export async function encryptAes(text, password, iterations = 210_000) {
  if (!String(password ?? "")) throw new Error("请输入加密口令");
  const rounds = Number(iterations);
  if (!Number.isInteger(rounds) || rounds < 10_000 || rounds > 2_000_000) throw new Error("PBKDF2 迭代次数必须在 10000 到 2000000 之间");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(String(password), salt, rounds, "encrypt");
  const ciphertext = await subtle().encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, ENCODER.encode(String(text ?? "")));
  return JSON.stringify({
    v: 1,
    alg: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: rounds,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptAes(payload, password) {
  if (!String(password ?? "")) throw new Error("请输入解密口令");
  let parsed;
  try {
    parsed = JSON.parse(String(payload ?? ""));
  } catch {
    throw new Error("密文不是有效的 AES 数据包");
  }
  if (parsed?.v !== 1 || parsed.alg !== "AES-256-GCM" || parsed.kdf !== "PBKDF2-SHA256") {
    throw new Error("不支持的 AES 数据包格式");
  }
  try {
    const salt = base64ToBytes(parsed.salt);
    const iv = base64ToBytes(parsed.iv);
    const data = base64ToBytes(parsed.data);
    const key = await deriveAesKey(String(password), salt, Number(parsed.iterations), "decrypt");
    const plain = await subtle().decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, data);
    return DECODER.decode(plain);
  } catch (error) {
    if (error instanceof Error && /数据包|Base64/.test(error.message)) throw error;
    throw new Error("解密失败：口令错误或密文已损坏");
  }
}

function pemFromBytes(bytes, label) {
  const base64 = bytesToBase64(bytes);
  const lines = base64.match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function bytesFromPem(pem, label) {
  const value = String(pem ?? "").trim();
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  if (!value.includes(begin) || !value.includes(end)) throw new Error(`${label} PEM 格式无效`);
  return base64ToBytes(value.replace(begin, "").replace(end, "").replace(/\s/g, ""));
}

export async function generateRsaKeyPair(modulusLength = 2048) {
  const size = Number(modulusLength);
  if (![2048, 3072, 4096].includes(size)) throw new Error("RSA 密钥长度仅支持 2048、3072 或 4096 位");
  const pair = await subtle().generateKey(
    { name: "RSA-OAEP", modulusLength: size, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const [spki, pkcs8] = await Promise.all([
    subtle().exportKey("spki", pair.publicKey),
    subtle().exportKey("pkcs8", pair.privateKey),
  ]);
  return {
    publicKey: pemFromBytes(new Uint8Array(spki), "PUBLIC KEY"),
    privateKey: pemFromBytes(new Uint8Array(pkcs8), "PRIVATE KEY"),
  };
}

export async function encryptRsa(text, publicKeyPem) {
  const bytes = ENCODER.encode(String(text ?? ""));
  const keyBytes = bytesFromPem(publicKeyPem, "PUBLIC KEY");
  const key = await subtle().importKey("spki", keyBytes, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  try {
    const encrypted = await subtle().encrypt({ name: "RSA-OAEP" }, key, bytes);
    return bytesToBase64(new Uint8Array(encrypted));
  } catch {
    throw new Error("RSA 加密失败：文本可能超过当前密钥长度限制");
  }
}

export async function decryptRsa(ciphertext, privateKeyPem) {
  const keyBytes = bytesFromPem(privateKeyPem, "PRIVATE KEY");
  const key = await subtle().importKey("pkcs8", keyBytes, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  try {
    const decrypted = await subtle().decrypt({ name: "RSA-OAEP" }, key, base64ToBytes(ciphertext));
    return DECODER.decode(decrypted);
  } catch {
    throw new Error("RSA 解密失败：私钥不匹配或密文已损坏");
  }
}

export async function calculateFileHashes(file, algorithms, options = {}) {
  if (!file || typeof file.slice !== "function") throw new Error("请选择文件");
  const selected = [...new Set(algorithms || [])];
  if (!selected.length || selected.some((algorithm) => !HASH_FACTORIES[algorithm])) throw new Error("请选择有效的摘要算法");
  const hashers = await Promise.all(selected.map((algorithm) => HASH_FACTORIES[algorithm]()));
  hashers.forEach((hasher) => hasher.init());
  const chunkSize = Math.max(64 * 1024, Number(options.chunkSize) || 4 * 1024 * 1024);
  const size = Number(file.size) || 0;
  for (let offset = 0; offset < size; offset += chunkSize) {
    const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + chunkSize, size)).arrayBuffer());
    hashers.forEach((hasher) => hasher.update(bytes));
    options.onProgress?.(Math.min(1, (offset + bytes.length) / Math.max(1, size)));
  }
  if (size === 0) options.onProgress?.(1);
  return Object.fromEntries(selected.map((algorithm, index) => [algorithm, hashers[index].digest("hex")]));
}

const PASSWORD_SETS = {
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  numbers: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?",
};
const AMBIGUOUS = /[Il1O0o]/g;

function randomIndex(max) {
  if (max <= 0) throw new Error("随机字符集为空");
  const limit = Math.floor(0x100000000 / max) * max;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] >= limit);
  return value[0] % max;
}

export function generatePassword(options = {}) {
  const length = Number(options.length ?? 20);
  if (!Number.isInteger(length) || length < 4 || length > 256) throw new Error("密码长度必须在 4 到 256 之间");
  const enabled = Object.entries(PASSWORD_SETS)
    .filter(([key]) => options[key] !== false)
    .map(([key, chars]) => options.excludeAmbiguous ? chars.replace(AMBIGUOUS, "") : chars);
  if (!enabled.length) throw new Error("请至少选择一个字符集");
  if (length < enabled.length) throw new Error("密码长度不能小于已选字符集数量");
  const pool = enabled.join("");
  const result = enabled.map((chars) => chars[randomIndex(chars.length)]);
  while (result.length < length) result.push(pool[randomIndex(pool.length)]);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result.join("");
}

export function getPasswordStrength(password, poolSize) {
  const entropy = Math.round(String(password ?? "").length * Math.log2(Math.max(1, Number(poolSize) || 1)));
  const label = entropy >= 120 ? "强" : entropy >= 80 ? "较强" : entropy >= 50 ? "一般" : "较弱";
  return { entropy, label };
}

export function getPasswordPoolSize(options = {}) {
  return Object.entries(PASSWORD_SETS)
    .filter(([key]) => options[key] !== false)
    .reduce((total, [, chars]) => total + (options.excludeAmbiguous ? chars.replace(AMBIGUOUS, "").length : chars.length), 0);
}
