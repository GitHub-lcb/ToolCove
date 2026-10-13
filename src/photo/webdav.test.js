import { beforeEach, describe, expect, it } from "vitest";
import { putWebdavObject, resetWebdavDirCache, webdavAuthHeader } from "./webdav.js";
import { putPhoto } from "./upload.js";

const CONFIG = {
  provider: "webdav",
  endpoint: "https://dav.example.com/dav/photos",
  username: "user",
  password: "pass",
  prefix: "photos",
};

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = (handler || ((u, i) => ({ ok: true, status: 201 })))(url, init);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 201,
      headers: { get: (name) => (r.headers || {})[name.toLowerCase()] ?? null },
      text: async () => r.body ?? "",
    };
  };
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  resetWebdavDirCache();
});

describe("webdavAuthHeader", () => {
  it("Basic 认证，UTF-8 用户名密码也能编码", () => {
    expect(webdavAuthHeader({ username: "user", password: "pass" })).toBe(`Basic ${btoa("user:pass")}`);
    // 中文密码：走 UTF-8 → base64，不是 latin1 直转（btoa 直转会抛 InvalidCharacterError）
    const header = webdavAuthHeader({ username: "用户", password: "密码" });
    const decoded = atob(header.slice(6));
    expect([...decoded].map((c) => c.charCodeAt(0))).toEqual([...new TextEncoder().encode("用户:密码")]);
  });
});

describe("putWebdavObject", () => {
  it("先逐级 MKCOL 再 PUT，目录只建一次（会话内缓存）", async () => {
    const fetchImpl = fakeFetch();
    await putWebdavObject({ config: CONFIG, key: "photos/2026/10/13/a.jpg", body: new Uint8Array([1]), contentType: "image/jpeg", fetchImpl });
    await putWebdavObject({ config: CONFIG, key: "photos/2026/10/13/b.jpg", body: new Uint8Array([2]), contentType: "image/jpeg", fetchImpl });

    const methods = fetchImpl.calls.map((call) => call.init.method);
    // 第一次：MKCOL photos / photos/2026 / photos/2026/10 / photos/2026/10/13 + PUT
    // 第二次：同目录直接 PUT（缓存命中，不再 MKCOL）
    expect(methods.filter((m) => m === "MKCOL")).toHaveLength(4);
    expect(methods.filter((m) => m === "PUT")).toHaveLength(2);

    const first = fetchImpl.calls[0];
    expect(first.url).toBe("https://dav.example.com/dav/photos/photos");
    expect(first.init.headers.Authorization).toBe(`Basic ${btoa("user:pass")}`);
    const put = fetchImpl.calls.at(-1);
    expect(put.url).toBe("https://dav.example.com/dav/photos/photos/2026/10/13/b.jpg");
    expect(put.init.headers["Content-Type"]).toBe("image/jpeg");
    expect(put.init.body).toEqual(new Uint8Array([2]));
  });

  it("MKCOL 405（目录已存在）视为成功", async () => {
    const fetchImpl = fakeFetch((url, init) => (init.method === "MKCOL" ? { ok: false, status: 405 } : { ok: true, status: 201 }));
    await expect(
      putWebdavObject({ config: CONFIG, key: "photos/2026/a.jpg", body: new Uint8Array([1]), fetchImpl })
    ).resolves.toMatchObject({ status: 201 });
  });

  it("MKCOL 其他错误码如实失败（路径打错的 404 不能吞成成功）", async () => {
    const fetchImpl = fakeFetch((url, init) => (init.method === "MKCOL" ? { ok: false, status: 404 } : { ok: true }));
    await expect(
      putWebdavObject({ config: CONFIG, key: "photos/2026/a.jpg", body: new Uint8Array([1]), fetchImpl })
    ).rejects.toMatchObject({ code: "MKCOL HTTP 404" });
  });

  it("PUT 失败抛 PhotoError", async () => {
    const fetchImpl = fakeFetch((url, init) => (init.method === "PUT" ? { ok: false, status: 507 } : { ok: true, status: 201 }));
    await expect(
      putWebdavObject({ config: CONFIG, key: "photos/a.jpg", body: new Uint8Array([1]), fetchImpl })
    ).rejects.toMatchObject({ code: "HTTP 507" });
  });
});

describe("putPhoto 分派", () => {
  it("provider=webdav 走 Basic + PUT", async () => {
    const fetchImpl = fakeFetch();
    await putPhoto({ config: CONFIG, key: "photos/a.jpg", body: new Uint8Array([1]), fetchImpl });
    expect(fetchImpl.calls.at(-1).init.method).toBe("PUT");
    expect(fetchImpl.calls.at(-1).init.headers.Authorization).toContain("Basic ");
  });
});
