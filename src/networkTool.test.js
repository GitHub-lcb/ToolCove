import { describe, expect, it } from "vitest";
import {
  analyzeCidr,
  parseUrl,
  parseUserAgent,
  rebuildUrl,
} from "./networkTool.js";

describe("parseUrl / rebuildUrl", () => {
  it("解析 URL 并保留重复查询参数", () => {
    const result = parseUrl("https://user:pass@example.com:8443/api/items?id=1&id=2#result");
    expect(result).toMatchObject({
      protocol: "https",
      username: "user",
      password: "pass",
      hostname: "example.com",
      port: "8443",
      pathname: "/api/items",
      hash: "#result",
    });
    expect(result.params).toEqual([
      { key: "id", value: "1" },
      { key: "id", value: "2" },
    ]);
  });

  it("为未带协议的地址补全 HTTPS，并可按参数重建", () => {
    const parsed = parseUrl("example.com/search?q=hello%20world");
    expect(parsed.inferredProtocol).toBe(true);
    expect(parsed.hostname).toBe("example.com");
    expect(rebuildUrl(parsed, [
      { key: "q", value: "中文" },
      { key: "page", value: "2" },
    ])).toBe("https://example.com/search?q=%E4%B8%AD%E6%96%87&page=2");
  });

  it("拒绝空地址和非 HTTP 协议", () => {
    expect(() => parseUrl(" ")).toThrow("URL");
    expect(() => parseUrl("file:///tmp/a.txt")).toThrow("HTTP");
  });
});

describe("analyzeCidr", () => {
  it("计算常规 IPv4 网段", () => {
    expect(analyzeCidr("192.168.10.25/24")).toMatchObject({
      ip: "192.168.10.25",
      prefix: 24,
      subnetMask: "255.255.255.0",
      wildcardMask: "0.0.0.255",
      network: "192.168.10.0",
      broadcast: "192.168.10.255",
      firstHost: "192.168.10.1",
      lastHost: "192.168.10.254",
      totalAddresses: 256,
      usableHosts: 254,
      private: true,
    });
  });

  it("正确处理 /31 与 /32", () => {
    expect(analyzeCidr("10.0.0.4/31")).toMatchObject({
      firstHost: "10.0.0.4",
      lastHost: "10.0.0.5",
      totalAddresses: 2,
      usableHosts: 2,
    });
    expect(analyzeCidr("8.8.8.8/32")).toMatchObject({
      network: "8.8.8.8",
      broadcast: "8.8.8.8",
      usableHosts: 1,
      private: false,
    });
  });

  it("拒绝非法 IPv4 和前缀", () => {
    expect(() => analyzeCidr("300.1.1.1/24")).toThrow("IPv4");
    expect(() => analyzeCidr("10.0.0.1/33")).toThrow("前缀");
  });
});

describe("parseUserAgent", () => {
  it("识别浏览器、系统、平台和引擎", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
    expect(parseUserAgent(ua)).toMatchObject({
      browser: { name: "Microsoft Edge", version: "124.0.0.0" },
      os: { name: "Windows", version: "NT 10.0" },
      platform: { type: "desktop" },
      engine: { name: "Blink" },
    });
  });

  it("空 UA 返回空结果", () => {
    expect(parseUserAgent("")).toMatchObject({ raw: "", browser: {}, os: {} });
  });
});
