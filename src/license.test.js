import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LICENSE_PREFIX,
  FREE_STATUS,
  parseLicenseKey,
  normalizeLicenseStatus,
  loadLicenseStatus,
  activateLicense,
  deactivateLicense,
  subscribeLicenseChanged,
} from "./license.js";

const VALID_PAYLOAD = { plan: "pro", name: "张三", email: "z@example.com", issued: "2026-08-26", expires: "", features: ["db-export-xlsx", "theme-custom"] };
const toB64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
function makeKey(payload = VALID_PAYLOAD, sig = "c2lnX3NhZGx5XzY0X2J5dGVzXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX") {
  return LICENSE_PREFIX + toB64(payload) + "." + sig;
}

describe("parseLicenseKey", () => {
  it("接受合法三段结构", () => {
    const r = parseLicenseKey(makeKey());
    expect(r.ok).toBe(true);
    expect(r.payload.name).toBe("张三");
    expect(typeof r.sig).toBe("string");
  });

  it("拒绝缺失前缀/前缀错误/空文本", () => {
    expect(parseLicenseKey("").ok).toBe(false);
    expect(parseLicenseKey("TC-abc.def").ok).toBe(false);
    expect(parseLicenseKey("abc.def").ok).toBe(false);
  });

  it("拒绝分段缺失或为空", () => {
    expect(parseLicenseKey("TCV1-abc").ok).toBe(false);
    expect(parseLicenseKey("TCV1-.abc").ok).toBe(false);
    expect(parseLicenseKey("TCV1-abc.").ok).toBe(false);
    expect(parseLicenseKey("TCV1-a..b").ok).toBe(false);
  });

  it("拒绝非法 base64url 字符", () => {
    expect(parseLicenseKey("TCV1-ab$c.def").ok).toBe(false);
    expect(parseLicenseKey("TCV1-abc.de*f").ok).toBe(false);
  });

  it("拒绝 payload 不是合法 JSON 对象", () => {
    const bad = LICENSE_PREFIX + toB64("just-a-string") + ".c2ln";
    expect(parseLicenseKey(bad).ok).toBe(false);
    const bad2 = LICENSE_PREFIX + "bm90LWpzb24." + "c2ln";
    expect(parseLicenseKey(bad2).ok).toBe(false);
  });
});

describe("normalizeLicenseStatus", () => {
  it("null/非对象回免费态", () => {
    expect(normalizeLicenseStatus(null)).toEqual(FREE_STATUS);
    expect(normalizeLicenseStatus("x")).toEqual(FREE_STATUS);
    expect(normalizeLicenseStatus(undefined)).toEqual(FREE_STATUS);
  });

  it("pro!=true 时保留错误码", () => {
    expect(normalizeLicenseStatus({ pro: false, error: "expired" })).toEqual({ pro: false, error: "expired" });
  });

  it("pro=true 时透传授权详情并清洗 features", () => {
    const s = normalizeLicenseStatus({
      pro: true,
      plan: "pro",
      name: "张三",
      email: "z@example.com",
      issuedAt: "2026-08-26",
      expiresAt: "",
      features: ["db-export-xlsx", 42, null, "theme-custom"],
    });
    expect(s.pro).toBe(true);
    expect(s.features).toEqual(["db-export-xlsx", "theme-custom"]);
  });
});

describe("Tauri 桥接降级", () => {
  beforeEach(() => {
    delete globalThis.window;
  });
  afterEach(() => {
    delete globalThis.window;
  });

  it("非 Tauri 环境 load 返回免费态且不 invoke", async () => {
    expect(await loadLicenseStatus()).toEqual(FREE_STATUS);
    expect(await activateLicense("TCV1-x.y")).toEqual({ pro: false, error: "desktop-only" });
    expect(await deactivateLicense()).toEqual(FREE_STATUS);
    expect(await subscribeLicenseChanged(() => {})).toEqual(expect.any(Function));
  });


});

describe("subscribeLicenseChanged", () => {
  it("非 Tauri 环境返回 no-op unlisten", async () => {
    delete globalThis.window;
    const un = await subscribeLicenseChanged(() => {});
    un();
    expect(1).toBe(1); // 不抛异常即可
  });
});
