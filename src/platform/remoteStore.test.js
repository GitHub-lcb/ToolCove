// 企业服务器数据桥单测：fetch 全部 mock（服务端不存在，契约见 remoteStore.js 头注释）。
// 覆盖：ping 成功/401/不可达/超时，load 成功/404/401/非 JSON/超时，save 成功/401/413/网络错误。
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureRemote, getRemoteConfig, remoteConfigured, remotePing, remoteLoad, remoteSave, _setFetch } from "./remoteStore.js";

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** 永不 resolve、只在 abort 时 reject 的 fetch：验证超时路径。 */
function hangingFetch(url, opts) {
  return new Promise((_, reject) => {
    opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
}

afterEach(() => {
  configureRemote(null);
  _setFetch(null);
});

describe("configureRemote / remoteConfigured", () => {
  it("baseUrl 去尾斜杠；baseUrl 或 token 为空视为未配置", () => {
    expect(remoteConfigured()).toBe(false);
    configureRemote({ baseUrl: "https://agent.example.com///", token: "tk" });
    expect(remoteConfigured()).toBe(true);
    expect(getRemoteConfig()).toEqual({ baseUrl: "https://agent.example.com", token: "tk" });

    configureRemote({ baseUrl: "", token: "tk" });
    expect(remoteConfigured()).toBe(false);
    configureRemote({ baseUrl: "https://agent.example.com", token: " " });
    expect(remoteConfigured()).toBe(false);

    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    configureRemote(null);
    expect(remoteConfigured()).toBe(false);
    expect(getRemoteConfig()).toBeNull();
  });
});

describe("remotePing", () => {
  it("未配置时返回 REMOTE_NOT_CONFIGURED，不发请求", async () => {
    const spy = vi.fn();
    _setFetch(spy);
    await expect(remotePing()).resolves.toEqual({ ok: false, error: "REMOTE_NOT_CONFIGURED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("200 返回 ok 与服务端名称；请求方法与鉴权头符合契约", async () => {
    const seen = [];
    _setFetch(async (url, opts) => {
      seen.push({ url, opts });
      return jsonResponse(200, { ok: true, name: "研发一部" });
    });
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk-1" });
    await expect(remotePing()).resolves.toEqual({ ok: true, name: "研发一部" });
    expect(seen[0].url).toBe("https://agent.example.com/v1/auth/ping");
    expect(seen[0].opts.method).toBe("POST");
    expect(seen[0].opts.headers.Authorization).toBe("Bearer tk-1");
  });

  it("200 但无 name 字段时 name 缺省", async () => {
    _setFetch(async () => jsonResponse(200, { ok: true }));
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    const r = await remotePing();
    expect(r.ok).toBe(true);
    expect(r.name).toBeUndefined();
  });

  it("401 → REMOTE_UNAUTHORIZED；其他非 2xx → REMOTE_ERROR", async () => {
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    _setFetch(async () => jsonResponse(401, {}));
    await expect(remotePing()).resolves.toEqual({ ok: false, error: "REMOTE_UNAUTHORIZED" });
    _setFetch(async () => jsonResponse(500, {}));
    await expect(remotePing()).resolves.toEqual({ ok: false, error: "REMOTE_ERROR" });
  });

  it("网络错误 → REMOTE_UNREACHABLE；超时（abort）→ REMOTE_UNREACHABLE", async () => {
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    _setFetch(async () => { throw new Error("getaddrinfo ENOTFOUND"); });
    await expect(remotePing()).resolves.toEqual({ ok: false, error: "REMOTE_UNREACHABLE" });
    _setFetch(hangingFetch);
    await expect(remotePing({ timeoutMs: 5 })).resolves.toEqual({ ok: false, error: "REMOTE_UNREACHABLE" });
  });
});

describe("remoteLoad", () => {
  it("200 返回 data；key 经 encodeURIComponent 编码", async () => {
    const seen = [];
    _setFetch(async (url, opts) => {
      seen.push({ url, opts });
      return jsonResponse(200, { data: { items: [1, 2] } });
    });
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    await expect(remoteLoad("a/b c")).resolves.toEqual({ items: [1, 2] });
    expect(seen[0].url).toBe("https://agent.example.com/v1/kv/a%2Fb%20c");
    expect(seen[0].opts.method).toBe("GET");
  });

  it("404 映射为空数组（对齐 load_data 空值约定）；200 无 data 字段同样视为空", async () => {
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    _setFetch(async () => jsonResponse(404, {}));
    await expect(remoteLoad("missing")).resolves.toEqual([]);
    _setFetch(async () => jsonResponse(200, {}));
    await expect(remoteLoad("no-data-field")).resolves.toEqual([]);
  });

  it("401 抛 REMOTE_UNAUTHORIZED；500 抛 REMOTE_ERROR", async () => {
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    _setFetch(async () => jsonResponse(401, {}));
    await expect(remoteLoad("k")).rejects.toMatchObject({ code: "REMOTE_UNAUTHORIZED" });
    _setFetch(async () => jsonResponse(500, {}));
    await expect(remoteLoad("k")).rejects.toMatchObject({ code: "REMOTE_ERROR" });
  });

  it("200 但响应非 JSON → REMOTE_ERROR（契约破坏不当空值吞掉）", async () => {
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    _setFetch(async () => ({ status: 200, ok: true, json: async () => { throw new Error("unexpected token <"); } }));
    await expect(remoteLoad("k")).rejects.toMatchObject({ code: "REMOTE_ERROR" });
  });

  it("超时抛 REMOTE_UNREACHABLE", async () => {
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    _setFetch(hangingFetch);
    await expect(remoteLoad("k", { timeoutMs: 5 })).rejects.toMatchObject({ code: "REMOTE_UNREACHABLE" });
  });
});

describe("remoteSave", () => {
  it("200 写成功：PUT + JSON body { data }", async () => {
    const seen = [];
    _setFetch(async (url, opts) => {
      seen.push({ url, opts });
      return jsonResponse(200, { ok: true });
    });
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    await expect(remoteSave("settings", { a: 1 })).resolves.toBeUndefined();
    expect(seen[0].opts.method).toBe("PUT");
    expect(seen[0].opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(seen[0].opts.body)).toEqual({ data: { a: 1 } });
  });

  it("401 → REMOTE_UNAUTHORIZED；413 → REMOTE_TOO_LARGE；500 → REMOTE_ERROR；网络错误 → REMOTE_UNREACHABLE", async () => {
    configureRemote({ baseUrl: "https://agent.example.com", token: "tk" });
    _setFetch(async () => jsonResponse(401, {}));
    await expect(remoteSave("k", {})).rejects.toMatchObject({ code: "REMOTE_UNAUTHORIZED" });
    _setFetch(async () => jsonResponse(413, {}));
    await expect(remoteSave("k", {})).rejects.toMatchObject({ code: "REMOTE_TOO_LARGE" });
    _setFetch(async () => jsonResponse(500, {}));
    await expect(remoteSave("k", {})).rejects.toMatchObject({ code: "REMOTE_ERROR" });
    _setFetch(async () => { throw new Error("socket hang up"); });
    await expect(remoteSave("k", {})).rejects.toMatchObject({ code: "REMOTE_UNREACHABLE" });
  });
});
