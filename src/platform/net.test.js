// 浏览器 HTTP 实现单测：用 stub 的 fetch 校验与 Rust http_request 对齐的出入参。
import { describe, it, expect, vi, afterEach } from "vitest";
import { browserHttpRequest } from "./net.js";

function stubFetch(handler) {
  vi.stubGlobal("fetch", vi.fn(handler));
}

function jsonResponse(body, { status = 200, statusText = "OK", headers = {} } = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    statusText,
    headers: new Headers(headers),
    arrayBuffer: async () => bytes.buffer,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserHttpRequest", () => {
  it("拒绝空地址与非 http(s) 协议", async () => {
    await expect(browserHttpRequest({ url: "" })).rejects.toThrow("请输入请求 URL");
    await expect(browserHttpRequest({ url: "ftp://x" })).rejects.toThrow("需以 http:// 或 https:// 开头");
  });

  it("返回结构与 Rust 侧一致（status/headers/body/size/durationMs）", async () => {
    stubFetch(async () => jsonResponse('{"ok":true}', { headers: { "content-type": "application/json" } }));
    const res = await browserHttpRequest({ method: "get", url: "https://example.com/api", timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.body).toBe('{"ok":true}');
    expect(res.size).toBe(11);
    expect(res.headers).toContainEqual(["content-type", "application/json"]);
    expect(typeof res.durationMs).toBe("number");
    expect(res.bodyBase64).toBeUndefined();
  });

  it("headers 支持 [k,v] 与 {name,value} 两种写法，GET 不带 body", async () => {
    const calls = [];
    stubFetch(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse("ok");
    });
    await browserHttpRequest({
      method: "GET",
      url: "https://example.com/x",
      headers: [["X-A", "1"], { name: "X-B", value: "2" }],
      body: "ignored",
    });
    expect(calls[0].init.headers.get("X-A")).toBe("1");
    expect(calls[0].init.headers.get("X-B")).toBe("2");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
  });

  it("二进制响应附加 bodyBase64", async () => {
    stubFetch(async () => ({
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array([0xff, 0xfe, 0x00]).buffer,
    }));
    const res = await browserHttpRequest({ url: "https://example.com/bin" });
    expect(res.bodyBase64).toBe(Buffer.from([0xff, 0xfe, 0x00]).toString("base64"));
  });

  it("超时映射为中文错误，网络异常带原始消息", async () => {
    stubFetch(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(browserHttpRequest({ url: "https://example.com/slow", timeoutMs: 1000 })).rejects.toThrow(/请求超时（1000ms）/);
    stubFetch(async () => {
      throw new Error("Failed to fetch");
    });
    await expect(browserHttpRequest({ url: "https://example.com/x" })).rejects.toThrow("请求失败：Failed to fetch");
  });

  it("非 2xx 不抛错（由调用方判断 status）", async () => {
    stubFetch(async () => jsonResponse("nope", { status: 404, statusText: "Not Found" }));
    const res = await browserHttpRequest({ url: "https://example.com/404" });
    expect(res.status).toBe(404);
    expect(res.body).toBe("nope");
  });
});
