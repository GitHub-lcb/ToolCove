// 描述文件校验的单测。
//
// 核心契约：**填错就发不出请求**。所以这里重点测「该拦的拦住了」，
// 以及错误码是否稳定（界面按 code 渲染中文，code 变了文案就错位）。
import { describe, expect, it } from "vitest";
import { DESCRIPTOR_TEMPLATE, parseDescriptorText, validateDescriptor } from "./descriptor.js";

const good = () => ({
  key: "workbuddy",
  label: "WorkBuddy",
  baseUrl: "https://api.example.com",
  checkin: { method: "POST", path: "/v1/checkin/do" },
  read: { checkedIn: "data.checkedToday" },
});

const codes = (input, options) => validateDescriptor(input, options).errors.map((e) => e.code);

describe("站点描述校验", () => {
  it("最小可用描述通过校验", () => {
    const { ok, value } = validateDescriptor(good());
    expect(ok).toBe(true);
    expect(value.key).toBe("workbuddy");
    expect(value.enabled).toBe(true);
    // 缺省动作参数补齐
    expect(value.checkin.method).toBe("POST");
    expect(value.status).toBeNull();
    expect(value.timeoutMs).toBe(20000);
  });

  it("缺字段逐条报错，而不是只报第一个", () => {
    expect(codes({})).toEqual(expect.arrayContaining(["fieldRequired"]));
    expect(codes({ key: "a", label: "b" }).sort()).toEqual(
      expect.arrayContaining(["fieldRequired", "fieldRequired", "fieldRequired"]),
    );
  });

  it("非对象直接拒绝", () => {
    expect(codes(null)).toEqual(["descriptorNotObject"]);
    expect(codes([])).toEqual(["descriptorNotObject"]);
    expect(codes("x")).toEqual(["descriptorNotObject"]);
  });

  it("key 必须是合法标识，且不与已有站点冲突", () => {
    expect(codes({ ...good(), key: "Bad Key" })).toContain("keyInvalid");
    expect(codes({ ...good(), key: "_leading" })).toContain("keyInvalid");
    expect(codes({ ...good(), key: "ok-1_2" })).not.toContain("keyInvalid");
    expect(codes(good(), { existingKeys: ["workbuddy"] })).toContain("keyDuplicate");
  });

  describe("baseUrl", () => {
    it("强制 https：明文 http 会把 cookie 送给路上的监听者", () => {
      expect(codes({ ...good(), baseUrl: "http://api.example.com" })).toContain("urlNotHttps");
    });

    it("本机 http 调试也不放行（否则「填个地址」的门槛太低了）", () => {
      expect(codes({ ...good(), baseUrl: "http://localhost:8080" })).toContain("urlNotHttps");
    });

    it("拒绝非法 URL、缺 URL、带 query 或 hash", () => {
      expect(codes({ ...good(), baseUrl: "not a url" })).toContain("urlInvalid");
      expect(codes({ ...good(), baseUrl: "https://a.com?x=1" })).toContain("urlHasQueryOrHash");
      expect(codes({ ...good(), baseUrl: "https://a.com#f" })).toContain("urlHasQueryOrHash");
    });

    it("去掉结尾斜杠，拼接时不会出双斜杠", () => {
      const { value } = validateDescriptor({ ...good(), baseUrl: "https://api.example.com/" });
      expect(value.baseUrl).toBe("https://api.example.com");
    });
  });

  describe("动作路径", () => {
    it("必须以 / 开头，否则会顶掉 baseUrl 的路径段", () => {
      expect(codes({ ...good(), checkin: { method: "POST", path: "v1/x" } })).toContain("pathNotAbsolute");
    });

    it("拒绝以 // 开头的协议相对 URL（会换掉整个域名）", () => {
      expect(codes({ ...good(), checkin: { method: "POST", path: "//evil.example.com/x" } })).toContain("pathProtocolRelative");
    });

    it("拒绝 CR/LF（能往 header 段里塞东西）", () => {
      expect(codes({ ...good(), checkin: { method: "POST", path: "/a\r\nX: 1" } })).toContain("pathControlChar");
    });

    it("checkin 必填", () => {
      const input = { ...good() };
      delete input.checkin;
      expect(codes(input)).toContain("fieldRequired");
    });

    it("方法限白名单", () => {
      expect(codes({ ...good(), checkin: { method: "DELETE", path: "/x" } })).toContain("methodNotAllowed");
      expect(codes({ ...good(), checkin: { method: "POST", path: "/x" } })).not.toContain("methodNotAllowed");
    });

    it("GET 不允许带 body", () => {
      expect(codes({ ...good(), status: { method: "GET", path: "/s", body: "x=1" } })).toContain("bodyNotAllowed");
      expect(codes({ ...good(), checkin: { method: "POST", path: "/c", body: "x=1" } })).not.toContain("bodyNotAllowed");
    });

    it("body 超长被挡", () => {
      expect(codes({ ...good(), checkin: { method: "POST", path: "/c", body: "x".repeat(8193) } })).toContain("bodyTooLong");
    });
  });

  describe("header", () => {
    it("拒绝非法 header 名与带 CR/LF 的值", () => {
      expect(codes({ ...good(), checkin: { method: "POST", path: "/c", headers: [["bad name", "v"]] } })).toContain("headerNameInvalid");
      expect(codes({ ...good(), checkin: { method: "POST", path: "/c", headers: [["X-A", "a\r\nX-B: b"]] } })).toContain("headerValueControlChar");
    });

    it("接受 {name,value} 对象写法并归一成数组", () => {
      const { ok, value } = validateDescriptor({ ...good(), checkin: { method: "POST", path: "/c", headers: [{ name: "Cookie", value: "a=1" }] } });
      expect(ok).toBe(true);
      expect(value.checkin.headers).toEqual([["Cookie", "a=1"]]);
    });

    it("缺 header 名报错", () => {
      expect(codes({ ...good(), checkin: { method: "POST", path: "/c", headers: [["", "v"]] } })).toContain("headerNameRequired");
    });

    it("数量上限", () => {
      const headers = Array.from({ length: 21 }, (_, i) => [`X-${i}`, "v"]);
      expect(codes({ ...good(), checkin: { method: "POST", path: "/c", headers } })).toContain("headersTooMany");
    });
  });

  describe("read 字段映射", () => {
    it("checkedIn 必填——没有它就没法判幂等", () => {
      const input = { ...good(), read: { points: "data.points" } };
      expect(codes(input)).toContain("fieldRequired");
    });

    it("路径语法错被挡下", () => {
      expect(codes({ ...good(), read: { checkedIn: "data..x" } })).toContain("pathSyntax");
      expect(codes({ ...good(), read: { checkedIn: "__proto__.x" } })).toContain("pathSyntax");
    });

    it("successCodes 归一成字符串/数字并支持数字入参", () => {
      const { ok, value } = validateDescriptor({ ...good(), read: { checkedIn: "a", code: "code", successCodes: [0, "0"] } });
      expect(ok).toBe(true);
      expect(value.read.successCodes).toEqual([0, "0"]);
    });

    it("successCodes 必须是数组", () => {
      expect(codes({ ...good(), read: { checkedIn: "a", code: "code", successCodes: 0 } })).toContain("notArray");
    });

    it("缺省填成空串而不是 undefined，省得下游到处判空", () => {
      const { value } = validateDescriptor(good());
      expect(value.read.points).toBe("");
      expect(value.read.successCodes).toBeNull();
    });
  });

  it("模板本身必须能通过校验（否则用户照着填还报错）", () => {
    const parsed = JSON.parse(DESCRIPTOR_TEMPLATE);
    const { ok, errors } = validateDescriptor(parsed);
    expect({ ok, errors }).toEqual({ ok: true, errors: [] });
  });
});

describe("粘贴 JSON 的解析", () => {
  it("合法 JSON 直接进校验", () => {
    const parsed = parseDescriptorText(JSON.stringify(good()));
    expect(parsed.ok).toBe(true);
    expect(parsed.value.key).toBe("workbuddy");
  });

  it("空文本报错", () => {
    expect(parseDescriptorText("   ")).toMatchObject({ ok: false, errors: [{ code: "empty" }] });
  });

  it("语法错带上行列，用户才知道改哪儿", () => {
    const parsed = parseDescriptorText('{\n  "key": "a",\n  bad\n}');
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0].code).toBe("jsonInvalid");
    expect(parsed.hint).toMatch(/第 \d+ 行第 \d+ 列/);
  });
});
