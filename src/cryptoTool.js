import {
  createMD5,
  createSHA1,
  createSHA256,
  createSHA384,
  createSHA512,
  md5,
} from "hash-wasm";
import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

// 数据包/编码类错误打标记，供 decryptAes 区分「数据问题」与「口令错误」
function dataError(key, params) {
  const err = new Error(t(key, params));
  err.isDataError = true;
  return err;
}

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
  if (!globalThis.crypto?.subtle) throw new Error(t("toolbox.crypto.errNoWebCrypto"));
  return globalThis.crypto.subtle;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const value = String(hex ?? "").replace(/\s/g, "");
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw dataError("toolbox.crypto.errInvalidHexData");
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
    throw dataError("toolbox.crypto.errInvalidBase64Data");
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
  if (!WEB_HASHES.has(algorithm)) throw new Error(t("toolbox.crypto.errUnsupportedDigest"));
  const result = await subtle().digest(algorithm, ENCODER.encode(value));
  return formatBytes(new Uint8Array(result), output);
}

export async function hmacText(text, secret, algorithm = "SHA-256", output = "hex") {
  if (!WEB_HASHES.has(algorithm)) throw new Error(t("toolbox.crypto.errUnsupportedHmac"));
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
  if (!String(password ?? "")) throw new Error(t("toolbox.crypto.errEncryptPassword"));
  const rounds = Number(iterations);
  if (!Number.isInteger(rounds) || rounds < 10_000 || rounds > 2_000_000) throw new Error(t("toolbox.crypto.errIterations"));
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
  if (!String(password ?? "")) throw new Error(t("toolbox.crypto.errDecryptPassword"));
  let parsed;
  try {
    parsed = JSON.parse(String(payload ?? ""));
  } catch {
    throw dataError("toolbox.crypto.errAesPacketInvalid");
  }
  if (parsed?.v !== 1 || parsed.alg !== "AES-256-GCM" || parsed.kdf !== "PBKDF2-SHA256") {
    throw dataError("toolbox.crypto.errAesPacketFormat");
  }
  try {
    const salt = base64ToBytes(parsed.salt);
    const iv = base64ToBytes(parsed.iv);
    const data = base64ToBytes(parsed.data);
    const key = await deriveAesKey(String(password), salt, Number(parsed.iterations), "decrypt");
    const plain = await subtle().decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, data);
    return DECODER.decode(plain);
  } catch (error) {
    if (error instanceof Error && error.isDataError) throw error;
    throw new Error(t("toolbox.crypto.errDecryptFailed"));
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
  if (!value.includes(begin) || !value.includes(end)) throw new Error(t("toolbox.crypto.errInvalidPem", { label }));
  return base64ToBytes(value.replace(begin, "").replace(end, "").replace(/\s/g, ""));
}

export async function generateRsaKeyPair(modulusLength = 2048) {
  const size = Number(modulusLength);
  if (![2048, 3072, 4096].includes(size)) throw new Error(t("toolbox.crypto.errRsaSize"));
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
    throw new Error(t("toolbox.crypto.errRsaEncrypt"));
  }
}

export async function decryptRsa(ciphertext, privateKeyPem) {
  const keyBytes = bytesFromPem(privateKeyPem, "PRIVATE KEY");
  const key = await subtle().importKey("pkcs8", keyBytes, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  try {
    const decrypted = await subtle().decrypt({ name: "RSA-OAEP" }, key, base64ToBytes(ciphertext));
    return DECODER.decode(decrypted);
  } catch {
    throw new Error(t("toolbox.crypto.errRsaDecrypt"));
  }
}

export async function calculateFileHashes(file, algorithms, options = {}) {
  if (!file || typeof file.slice !== "function") throw new Error(t("toolbox.crypto.errNoFile"));
  const selected = [...new Set(algorithms || [])];
  if (!selected.length || selected.some((algorithm) => !HASH_FACTORIES[algorithm])) throw new Error(t("toolbox.crypto.errInvalidAlgorithms"));
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
  if (max <= 0) throw new Error(t("toolbox.crypto.errEmptyCharset"));
  const limit = Math.floor(0x100000000 / max) * max;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] >= limit);
  return value[0] % max;
}

export function generatePassword(options = {}) {
  const length = Number(options.length ?? 20);
  if (!Number.isInteger(length) || length < 4 || length > 256) throw new Error(t("toolbox.crypto.errPasswordLength"));
  const enabled = Object.entries(PASSWORD_SETS)
    .filter(([key]) => options[key] !== false)
    .map(([key, chars]) => options.excludeAmbiguous ? chars.replace(AMBIGUOUS, "") : chars);
  if (!enabled.length) throw new Error(t("toolbox.crypto.errNoCharset"));
  if (length < enabled.length) throw new Error(t("toolbox.crypto.errLengthTooSmall"));
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
  const label = entropy >= 120
    ? t("toolbox.crypto.strengthStrong")
    : entropy >= 80
      ? t("toolbox.crypto.strengthGood")
      : entropy >= 50
        ? t("toolbox.crypto.strengthFair")
        : t("toolbox.crypto.strengthWeak");
  return { entropy, label };
}

export function getPasswordPoolSize(options = {}) {
  return Object.entries(PASSWORD_SETS)
    .filter(([key]) => options[key] !== false)
    .reduce((total, [, chars]) => total + (options.excludeAmbiguous ? chars.replace(AMBIGUOUS, "").length : chars.length), 0);
}
