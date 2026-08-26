// Pro 授权状态：key 文本格式校验、状态归一化、Rust 命令桥接。
// 验签完全在 Rust 侧（license.rs，ed25519 公钥内嵌二进制）；本模块只做前端
// 约定的格式检查与状态归一，保证非 Tauri 环境（浏览器预览）可降级为免费版。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const LICENSE_PREFIX = "TCV1-";

export const FREE_STATUS = { pro: false, error: null };

/** 校验 key 文本的格式（前缀 + 两段 base64url）。返回 { ok, payload?, sig?, error? } */
export function parseLicenseKey(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith(LICENSE_PREFIX)) return { ok: false, error: "malformed" };
  const rest = raw.slice(LICENSE_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return { ok: false, error: "malformed" };
  const payloadB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);
  const B64URL = /^[A-Za-z0-9_-]+$/;
  if (!B64URL.test(payloadB64) || !B64URL.test(sigB64)) return { ok: false, error: "malformed" };
  let payload = null;
  try {
    // atob 输出 Latin-1：需转 Uint8Array 后用 TextDecoder 按 UTF-8 还原，非 ASCII payload 才不会乱码
    const bin = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    payload = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (!payload || typeof payload !== "object") return { ok: false, error: "malformed" };
  return { ok: true, payload, sig: sigB64 };
}

/** 状态归一化：任何异常/缺字段都回免费版，pro=true 才透传授权详情 */
export function normalizeLicenseStatus(raw) {
  if (!raw || typeof raw !== "object") return { ...FREE_STATUS };
  if (raw.pro !== true) return { pro: false, error: raw.error || null };
  return {
    pro: true,
    plan: raw.plan || "pro",
    name: raw.name || "",
    email: raw.email || "",
    issuedAt: raw.issuedAt || "",
    expiresAt: raw.expiresAt || "",
    features: Array.isArray(raw.features) ? raw.features.filter((f) => typeof f === "string") : [],
    error: null,
  };
}

/** 拉取授权状态；非 Tauri 环境（浏览器预览）直接返回免费版 */
export async function loadLicenseStatus() {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return { ...FREE_STATUS };
  try {
    const raw = await invoke("license_status");
    return normalizeLicenseStatus(raw);
  } catch (e) {
    return { ...FREE_STATUS };
  }
}

/** 激活（key 文本由 Rust 验签）；返回归一化状态或 { pro:false, error } */
export async function activateLicense(key) {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return { pro: false, error: "desktop-only" };
  const raw = await invoke("license_activate", { key });
  return normalizeLicenseStatus(raw);
}

/** 停用授权 */
export async function deactivateLicense() {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return { ...FREE_STATUS };
  const raw = await invoke("license_deactivate");
  return normalizeLicenseStatus(raw);
}

/**
 * 订阅授权变更（Tauri 全局事件，主窗口与工具子窗口各自订阅）。
 * 非 Tauri 环境返回空 unlisten；重复订阅同一窗口会被去重。
 */
export async function subscribeLicenseChanged(cb) {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return () => {};
  let unlisten = null;
  try {
    unlisten = await listen("license-changed", (e) => {
      try {
        cb(normalizeLicenseStatus(e.payload));
      } catch {
        /* 回调异常不影响事件链 */
      }
    });
  } catch {
    unlisten = null;
  }
  return () => {
    if (unlisten) unlisten();
  };
}
