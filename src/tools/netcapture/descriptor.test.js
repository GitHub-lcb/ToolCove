import { describe, expect, it } from "vitest";
import { buildDescriptor, guessReadPaths, keyFromHost } from "./descriptor.js";

// 一条「像真的一样」的签到请求：带浏览器噪声头 + 凭据占位符 + JSON 响应
const captured = {
  id: 1,
  method: "POST",
  url: "https://api.qoder.com/api/v1/credit/checkin",
  host: "api.qoder.com",
  origin: "https://api.qoder.com",
  path: "/api/v1/credit/checkin",
  status: 200,
  requestHeaders: {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 ...",
    Referer: "https://qoder.com.cn/",
    Origin: "https://qoder.com.cn",
    "sec-ch-ua": '"Chromium";v="154"',
    "Accept-Encoding": "gzip",
    Cookie: "<已脱敏>",
    Authorization: "<已脱敏>",
    "X-Request-Id": "abc-123",
  },
  requestBody: { date: "2026-10-05" },
  responseBody: { code: 0, message: "ok", data: { checkedToday: true, points: 100 } },
};

describe("guessReadPaths", () => {
  it("认出业务码、文案、签到状态与积分的字段路径", () => {
    const guess = guessReadPaths({ code: 0, message: "ok", data: { checkedToday: true, points: 100 } });
    expect(guess.code).toBe("code");
    expect(guess.message).toBe("message");
    expect(guess.checkedIn).toBe("data.checkedToday");
    expect(guess.points).toBe("data.points");
    // 业务码是 0（成功），successCodes 直接推出 [0]
    expect(guess.successCodes).toEqual([0]);
  });

  it("嵌套深一些也能找出来，且给出完整路径", () => {
    const guess = guessReadPaths({ result: { status: { signed: false }, award: { credits: 88 } }, code: "200" });
    expect(guess.code).toBe("code");
    expect(guess.checkedIn).toBe("result.status.signed");
    expect(guess.points).toBe("result.award.credits");
    // 字符串型数字业务码也要能推出成功码
    expect(guess.successCodes).toEqual([200]);
  });

  it("响应不是对象时什么都不猜（而不是乱填）", () => {
    for (const body of [null, undefined, "text", 42, [1, 2]]) {
      const guess = guessReadPaths(body);
      expect(guess.checkedIn).toBe("");
      expect(guess.code).toBe("");
    }
  });

  it("没有布尔型的签到字段时如实留空——宁可让人填，也不能瞎猜", () => {
    // 这里 checkedIn 是字符串而不是布尔值，猜不出来就该承认猜不出来
    const guess = guessReadPaths({ code: 0, data: { checkedToday: "yes", points: 10 } });
    expect(guess.checkedIn).toBe("");
    expect(guess.points).toBe("data.points");
  });
});

describe("keyFromHost", () => {
  it("从域名取出合法的站点 key", () => {
    expect(keyFromHost("api.qoder.com")).toBe("api-qoder-com");
    expect(keyFromHost("www.example.com")).toBe("example-com");
    expect(keyFromHost("api.qoder.com:8443")).toBe("api-qoder-com");
  });

  it("空输入也能给出可用 key，不会产出空串", () => {
    expect(keyFromHost("")).toBe("site");
    expect(keyFromHost(null)).toBe("site");
  });

  it("结果一定满足签到工具的 key 规则（小写字母数字 - _，不超过 40）", () => {
    for (const host of ["A.B.C", "very-long-host-name-that-goes-on-and-on.example.com", "---"]) {
      const key = keyFromHost(host);
      expect(key).toMatch(/^[a-z0-9][a-z0-9_-]{0,39}$/);
    }
  });
});

describe("buildDescriptor", () => {
  it("生成的描述能直接通过签到工具的校验", () => {
    const out = buildDescriptor(captured);
    expect(out.errors).toEqual([]);
    expect(out.valid).toBe(true);
  });

  it("baseUrl 取到 origin、path 不重复带上域名", () => {
    const out = buildDescriptor(captured);
    expect(out.descriptor.baseUrl).toBe("https://api.qoder.com");
    expect(out.descriptor.checkin.path).toBe("/api/v1/credit/checkin");
  });

  it("剔掉浏览器噪声头，保留业务头", () => {
    const out = buildDescriptor(captured);
    const names = out.descriptor.checkin.headers.map(([n]) => n.toLowerCase());
    expect(names).toContain("content-type");
    expect(names).toContain("x-request-id");
    // 这些换台机器重发就没意义了，留着只会让描述绑死在那台机器的浏览器特征上
    for (const noise of ["user-agent", "referer", "origin", "accept-encoding", "sec-ch-ua"]) {
      expect(names, noise).not.toContain(noise);
    }
  });

  it("凭据头不放进描述文件，而是明确告知要自己填", () => {
    const out = buildDescriptor(captured);
    const names = out.descriptor.checkin.headers.map(([n]) => n.toLowerCase());
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("authorization");
    expect(out.warnings.join()).toMatch(/凭据/);
  });

  it("请求体是对象时序列化成字符串（描述文件里 body 就是字符串）", () => {
    const out = buildDescriptor(captured);
    expect(out.descriptor.checkin.body).toBe('{"date":"2026-10-05"}');
  });

  it("read 各字段按响应体自动填好", () => {
    const out = buildDescriptor(captured);
    expect(out.descriptor.read.checkedIn).toBe("data.checkedToday");
    expect(out.descriptor.read.points).toBe("data.points");
    expect(out.descriptor.read.successCodes).toEqual([0]);
  });

  it("没有请求体时不硬造 body 字段", () => {
    const out = buildDescriptor({ ...captured, method: "GET", requestBody: null });
    expect(out.descriptor.checkin.body).toBeUndefined();
    expect(out.valid).toBe(true);
  });

  it("猜不出签到状态时如实警告，而不是填个假的", () => {
    const out = buildDescriptor({ ...captured, responseBody: { code: 0, message: "ok" } });
    expect(out.descriptor.read.checkedIn).toBe("");
    expect(out.warnings.join()).toMatch(/checkedIn/);
    // 缺 checkedIn 是**填不出来的**，校验不通过才是对的结果，不能悄悄给一个能过的假配置
    expect(out.valid).toBe(false);
    expect(out.errors.some((e) => e.field === "read.checkedIn")).toBe(true);
  });

  it("http 站点会被校验挡下（签到工具强制 https），错误要指到 baseUrl", () => {
    const out = buildDescriptor({ ...captured, url: "http://api.qoder.com/x", origin: "http://api.qoder.com" });
    expect(out.valid).toBe(false);
    expect(out.errors.some((e) => e.code === "urlNotHttps")).toBe(true);
  });

  it("可以覆盖 key 与 label", () => {
    const out = buildDescriptor(captured, { key: "qoder", label: "Qoder CN" });
    expect(out.descriptor.key).toBe("qoder");
    expect(out.descriptor.label).toBe("Qoder CN");
  });

  it("没有选中请求时安全返回，不抛异常", () => {
    const out = buildDescriptor(null);
    expect(out.descriptor).toBeNull();
    expect(out.valid).toBe(false);
  });
});
