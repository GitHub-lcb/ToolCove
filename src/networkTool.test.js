import { describe, expect, it } from "vitest";
import {
  analyzeCidr,
  parseUrl,
  parseUserAgent,
  rebuildUrl,
} from "./networkTool.js";

describe("parseUrl / rebuildUrl", () => {
  it("parses URL and keeps duplicate query params", () => {
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

  it("infers HTTPS for protocol-less input and rebuilds with params", () => {
    const parsed = parseUrl("example.com/search?q=hello%20world");
    expect(parsed.inferredProtocol).toBe(true);
    expect(parsed.hostname).toBe("example.com");
    expect(rebuildUrl(parsed, [
      { key: "q", value: "café" },
      { key: "page", value: "2" },
    ])).toBe("https://example.com/search?q=caf%C3%A9&page=2");
  });

  it("rejects empty input and non-HTTP protocols", () => {
    expect(() => parseUrl(" ")).toThrow("URL");
    expect(() => parseUrl("file:///tmp/a.txt")).toThrow("HTTP");
  });
});

describe("analyzeCidr", () => {
  it("computes a regular IPv4 subnet", () => {
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

  it("handles /31 and /32", () => {
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

  it("rejects invalid IPv4 and prefix", () => {
    expect(() => analyzeCidr("300.1.1.1/24")).toThrow("IPv4");
    expect(() => analyzeCidr("10.0.0.1/33")).toThrow("CIDR");
  });
});

describe("parseUserAgent", () => {
  it("detects browser, OS, platform and engine", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
    expect(parseUserAgent(ua)).toMatchObject({
      browser: { name: "Microsoft Edge", version: "124.0.0.0" },
      os: { name: "Windows", version: "NT 10.0" },
      platform: { type: "desktop" },
      engine: { name: "Blink" },
    });
  });

  it("empty UA returns empty result", () => {
    expect(parseUserAgent("")).toMatchObject({ raw: "", browser: {}, os: {} });
  });
});
