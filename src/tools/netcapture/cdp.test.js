import { describe, expect, it } from "vitest";
import { capturedTargetTypes, pickCredentialHeader, redactHeaders, safeParse, safeUrl } from "./cdp.js";

// 端到端（真浏览器、真请求）由 scripts/verify-netcapture.mjs 覆盖；
// 这里只守纯函数——它们决定「凭据会不会漏出去」，比界面逻辑更该有测试。

describe("从上线请求头里挑出凭据", () => {
  // Qoder 的实际情况：主进程注入的鉴权头只在 ExtraInfo 里，应用层一个都没有。
  const wire = {
    ":method": "GET",
    ":path": "/sash/api/v1/me/campaigns",
    "user-agent": "Mozilla/5.0",
    "authorization": "Bearer abc.def.ghi",
    "cookie": "xlly_s=1; cna=xyz",
    "x-trace-id": "t-123",
  };

  it("能挑出 authorization", () => {
    expect(pickCredentialHeader(wire)).toEqual({ authorization: "Bearer abc.def.ghi", cookie: "xlly_s=1; cna=xyz" });
  });

  it("也挑 cookie——ExtraInfo 里的 cookie 是真正上线的值，有站点靠它鉴权", () => {
    // 之前刻意排除 cookie，理由是「它通常不是凭据」。那个判断基于应用层请求头，
    // 而 ExtraInfo 给的是**上线**的头：真值在这里，靠 cookie 鉴权的站点只能从这儿拿到它。
    // 优先级由生成器决定（同时存在时优先 Authorization），不在这一层丢信息。
    expect(pickCredentialHeader({ cookie: "sid=abc" })).toEqual({ cookie: "sid=abc" });
  });

  it("认得各种 token / key 命名的头", () => {
    const picked = pickCredentialHeader({ "X-Api-Key": "k", "access-token": "t", "X-Trace-Id": "x" });
    expect(picked).toEqual({ "X-Api-Key": "k", "access-token": "t" });
  });

  it("忽略 :method / :path 这类伪头", () => {
    expect(pickCredentialHeader({ ":method": "GET", ":authority": "x", "authorization": "a" })).toEqual({ authorization: "a" });
  });

  it("一个凭据头都没有时返回 null，而不是空对象", () => {
    expect(pickCredentialHeader({ "user-agent": "x" })).toBeNull();
    expect(pickCredentialHeader(undefined)).toBeNull();
  });
});

describe("目标类型过滤", () => {
  it("iframe 必须在抓取范围内", () => {
    // 这条是被真实抓包现场逼出来的：Qoder 的签到弹窗是 type=iframe 的 target，
    // 所有签到请求都从它发出。漏了它，主界面照样附加成功、一条都抓不到，
    // 现象是「工具不工作」，极难自查。
    expect(capturedTargetTypes()).toContain("iframe");
  });

  it("Electron 的两种窗口类型都在范围内", () => {
    expect(capturedTargetTypes()).toContain("page");
    expect(capturedTargetTypes()).toContain("webview");
  });

  it("后台类型不在范围内（否则噪声请求会淹掉目标请求）", () => {
    for (const noisy of ["service_worker", "background_page", "extension"]) {
      expect(capturedTargetTypes(), noisy).not.toContain(noisy);
    }
  });
});

describe("redactHeaders 凭据脱敏", () => {
  it("Cookie / Authorization / Set-Cookie 等一律替换成占位符", () => {
    const out = redactHeaders({
      Cookie: "sid=abc123",
      Authorization: "Bearer real-token",
      "Set-Cookie": "sid=abc123",
      "x-api-key": "k-123",
      "Proxy-Authorization": "Basic xyz",
      "Content-Type": "application/json",
    });
    expect(out.Cookie).toBe("<已脱敏>");
    expect(out.Authorization).toBe("<已脱敏>");
    expect(out["Set-Cookie"]).toBe("<已脱敏>");
    expect(out["x-api-key"]).toBe("<已脱敏>");
    expect(out["Proxy-Authorization"]).toBe("<已脱敏>");
    // 非凭据头必须原样保留：全脱掉等于抓包没意义
    expect(out["Content-Type"]).toBe("application/json");
  });

  it("大小写不敏感（CDP 给的头名大小写不固定）", () => {
    const out = redactHeaders({ COOKIE: "a", authorization: "b", "sEt-CoOkIe": "c" });
    expect(out.COOKIE).toBe("<已脱敏>");
    expect(out.authorization).toBe("<已脱敏>");
    expect(out["sEt-CoOkIe"]).toBe("<已脱敏>");
  });

  it("结果里不含任何凭据原文", () => {
    const dumped = JSON.stringify(redactHeaders({ Cookie: "sid=secret", Authorization: "Bearer secret" }));
    expect(dumped).not.toContain("secret");
  });

  it("空输入不炸", () => {
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders(null)).toEqual({});
  });
});

describe("safeParse 响应体解析", () => {
  it("JSON 对象/数组解析成结构", () => {
    expect(safeParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeParse("[1,2]")).toEqual([1, 2]);
  });

  it("表单编码解析成对象", () => {
    expect(safeParse("user=abc&page=2")).toEqual({ user: "abc", page: "2" });
    // 值里的 = 不能把配对切错
    expect(safeParse("token=a=b&x=1")).toEqual({ token: "a=b", x: "1" });
  });

  it("纯文本原样返回", () => {
    expect(safeParse("hello world")).toBe("hello world");
    // 半截 JSON 不该抛异常，也不该被当 JSON 硬解
    expect(safeParse('{"broken":')).toBe('{"broken":');
  });

  it("空体返回 null 而不是空串", () => {
    expect(safeParse("")).toBeNull();
    expect(safeParse("   ")).toBeNull();
    expect(safeParse(null)).toBeNull();
  });
});

describe("safeUrl 拆解", () => {
  it("拆出 host / origin / path（path 含 query）", () => {
    const out = safeUrl("https://api.qoder.com:8443/v1/checkin?a=1&b=2");
    expect(out.host).toBe("api.qoder.com:8443");
    expect(out.origin).toBe("https://api.qoder.com:8443");
    expect(out.path).toBe("/v1/checkin?a=1&b=2");
  });

  it("没有 query 时 path 就是路径本身", () => {
    expect(safeUrl("https://example.com/a/b").path).toBe("/a/b");
  });

  it("解析不了的 URL 不抛异常，原样放进 path", () => {
    const out = safeUrl("not a url");
    expect(out.path).toBe("not a url");
    expect(out.host).toBe("");
  });
});
