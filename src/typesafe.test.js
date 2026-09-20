import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));
vi.mock("./secure.js", () => ({ decryptValue: async (v) => v }));
vi.mock("./i18n/index.js", () => ({
  i18n: { global: { t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) } },
}));

const { invoke } = await import("@tauri-apps/api/core");
const {
  TYPESAFE_DEFAULT_BASE,
  TYPESAFE_DEFAULT_MODEL,
  isTypeSafeConfigured,
  loadTypeSafeConfig,
  resolveTypeSafeTransport,
  testTypeSafe,
  typesafeEval,
  typesafeUrl,
} = await import("./typesafe.js");

/** 让 load_data("settings") 返回给定配置。 */
const withSettings = (typesafe) => {
  invoke.mockImplementation(async (command) => {
    if (command === "load_data") return { typesafe };
    return {};
  });
};

beforeEach(() => {
  invoke.mockReset();
  withSettings(undefined);
});

describe("typesafeUrl", () => {
  it("默认打到官方端点", () => {
    expect(typesafeUrl("")).toBe(`${TYPESAFE_DEFAULT_BASE}/systemone`);
    expect(typesafeUrl(null)).toBe(`${TYPESAFE_DEFAULT_BASE}/systemone`);
  });

  it("自定义 base 覆盖默认值，并容忍结尾斜杠", () => {
    expect(typesafeUrl("https://proxy.example.com/v1")).toBe("https://proxy.example.com/v1/systemone");
    expect(typesafeUrl("https://proxy.example.com/v1/")).toBe("https://proxy.example.com/v1/systemone");
    expect(typesafeUrl("  https://proxy.example.com/v1  ")).toBe("https://proxy.example.com/v1/systemone");
  });
});

describe("loadTypeSafeConfig", () => {
  it("读 settings.typesafe，缺省只补 baseUrl（用户只需粘一个 key）", async () => {
    withSettings({ apiKey: "  sk-abc  ", enabled: true });
    const cfg = await loadTypeSafeConfig();
    expect(cfg.baseUrl).toBe(TYPESAFE_DEFAULT_BASE);
    expect(cfg.apiKey).toBe("sk-abc");
    expect(cfg.enabled).toBe(true);
  });

  it("未配置时给出去敏的默认值，不抛错", async () => {
    const cfg = await loadTypeSafeConfig();
    expect(cfg).toMatchObject({ baseUrl: TYPESAFE_DEFAULT_BASE, apiKey: "", enabled: false });
  });

  it("settings 读不到时也返回默认值（设置未落盘不该让 Agent 崩）", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    await expect(loadTypeSafeConfig()).resolves.toMatchObject({ apiKey: "", enabled: false });
  });
});

describe("isTypeSafeConfigured", () => {
  it("需要 key 且显式开启（默认不改变现有用户的行为）", async () => {
    withSettings({ apiKey: "sk-abc" });
    expect(await isTypeSafeConfigured()).toBe(false);
    withSettings({ apiKey: "sk-abc", enabled: true });
    expect(await isTypeSafeConfigured()).toBe(true);
    withSettings({ enabled: true });
    expect(await isTypeSafeConfigured()).toBe(false);
  });
});

describe("resolveTypeSafeTransport", () => {
  const body = { model: "jev-latest", state: { goal: "x" }, questions: {} };

  it("显式注入的传输层优先（测试与自定义代理用）", async () => {
    const injected = vi.fn();
    expect(await resolveTypeSafeTransport({ typesafeTransport: injected })).toBe(injected);
  });

  it("显式关闭时不走网络，即使配置齐全", async () => {
    withSettings({ apiKey: "sk-abc", enabled: true });
    expect(await resolveTypeSafeTransport({ typesafe: false })).toBe(null);
  });

  it("未配置时返回 null（调用方据此退回关键词匹配）", async () => {
    withSettings({ enabled: true }); // 有开关没 key
    expect(await resolveTypeSafeTransport()).toBe(null);
    withSettings({ apiKey: "sk-abc" }); // 有 key 没开关
    expect(await resolveTypeSafeTransport()).toBe(null);
  });

  it("配置齐全时给出打到该配置的传输层", async () => {
    withSettings({ apiKey: "sk-abc", enabled: true, baseUrl: "https://proxy.example.com/v1" });
    const transport = await resolveTypeSafeTransport();
    expect(typeof transport).toBe("function");
    invoke.mockImplementation(async (command) => (command === "typesafe_eval" ? { answers: { ok: 1 } } : {}));
    await expect(transport(body)).resolves.toEqual({ answers: { ok: 1 } });
    const call = invoke.mock.calls.find((c) => c[0] === "typesafe_eval");
    expect(call[1]).toMatchObject({ baseUrl: "https://proxy.example.com/v1", apiKey: "sk-abc", body });
  });
});

describe("testTypeSafe（设置页「测试连接」）", () => {
  const cfg = { baseUrl: "https://proxy.example.com/v1", apiKey: "sk-x" };
  const answering = (response) =>
    invoke.mockImplementation(async (command) => (command === "typesafe_eval" ? response : {}));

  it("发一个最小探针请求，回传模型名与概率（让用户真的看到一个判断结果）", async () => {
    answering({ model: "jev-1.13", answers: { probe: { type: "noul", noul: 0.99 } } });
    await expect(testTypeSafe(cfg)).resolves.toEqual({ model: "jev-1.13", noul: 0.99 });
    const sent = invoke.mock.calls.find((c) => c[0] === "typesafe_eval")[1].body;
    expect(sent.model).toBe(TYPESAFE_DEFAULT_MODEL);
    expect(sent.questions.probe.type).toBe("noul");
  });

  it("模型名留空时用默认别名，填了就透传", async () => {
    answering({ answers: { probe: { noul: 1 } } });
    await testTypeSafe(cfg);
    expect(invoke.mock.calls.find((c) => c[0] === "typesafe_eval")[1].body.model).toBe(TYPESAFE_DEFAULT_MODEL);
    invoke.mockClear();
    answering({ answers: { probe: { noul: 1 } } });
    await testTypeSafe({ ...cfg, model: "jev-1.12" });
    expect(invoke.mock.calls.find((c) => c[0] === "typesafe_eval")[1].body.model).toBe("jev-1.12");
  });

  it("响应形状不对时明确报错，而不是显示一个假的成功", async () => {
    answering({ answers: {} });
    await expect(testTypeSafe(cfg)).rejects.toThrow(/typesafeErrNoAnswer/);
    answering({});
    await expect(testTypeSafe(cfg)).rejects.toThrow(/typesafeErrNoAnswer/);
  });
});

describe("typesafeEval", () => {
  const body = { model: "jev-latest", state: { goal: "x" }, questions: {} };

  it("桌面端经 Rust 命令转发（规避 CORS，key 不进 webview 网络栈）", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "load_data") return { typesafe: { apiKey: "sk-abc", enabled: true } };
      if (command === "typesafe_eval") return { answers: {} };
      return {};
    });
    const out = await typesafeEval(body);
    expect(out).toEqual({ answers: {} });
    const call = invoke.mock.calls.find((c) => c[0] === "typesafe_eval");
    expect(call[1]).toMatchObject({ baseUrl: TYPESAFE_DEFAULT_BASE, apiKey: "sk-abc", body });
  });

  it("没配 key 时直接报错，不发请求", async () => {
    await expect(typesafeEval(body)).rejects.toThrow(/typesafeErrNoKey/);
    expect(invoke.mock.calls.some((c) => c[0] === "typesafe_eval")).toBe(false);
  });

  it("浏览器端直连端点，带 Bearer 与 JSON 体", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ answers: { a: 1 } }) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mod = await import("./typesafe.js");
      const out = await mod.typesafeEval(body, { config: { baseUrl: "https://proxy.example.com/v1", apiKey: "sk-x" } });
      expect(out).toEqual({ answers: { a: 1 } });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://proxy.example.com/v1/systemone");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer sk-x");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual(body);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("浏览器端非 2xx 时抛出状态码与服务端说明", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: "rate limited" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mod = await import("./typesafe.js");
      await expect(
        mod.typesafeEval(body, { config: { baseUrl: "https://proxy.example.com/v1", apiKey: "sk-x" } }),
      ).rejects.toThrow(/429.*rate limited/);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("浏览器端错误体不是 JSON 时保留原文", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 502, text: async () => "<html>bad gateway</html>" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mod = await import("./typesafe.js");
      await expect(
        mod.typesafeEval(body, { config: { baseUrl: "https://proxy.example.com/v1", apiKey: "sk-x" } }),
      ).rejects.toThrow(/502.*bad gateway/);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
