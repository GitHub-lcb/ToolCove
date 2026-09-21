import { describe, expect, it, vi } from "vitest";
import {
  TOOL_SUGGEST_FLOOR,
  TOOL_SUGGEST_LIMIT,
  buildToolRankRequest,
  isSemanticWorthy,
  parseToolRankResponse,
  suggestTools,
  toolRankCertainty,
} from "./toolboxSemantic.js";

const TOOLS = [
  { key: "table", labelKey: "toolbox.registry.toolTable", descKey: "toolbox.registry.toolTableDesc", keywords: ["csv", "表格", "列"] },
  { key: "json", labelKey: "toolbox.registry.toolJson", descKey: "toolbox.registry.toolJsonDesc", keywords: ["json", "格式化"] },
  { key: "diff", labelKey: "toolbox.registry.toolDiff", descKey: "toolbox.registry.toolDiffDesc", keywords: ["对比", "差异"] },
];
const translate = (key) => ({
  "toolbox.registry.toolTable": "表格处理",
  "toolbox.registry.toolTableDesc": "解析并清洗 CSV/TSV",
  "toolbox.registry.toolJson": "JSON 工具",
  "toolbox.registry.toolJsonDesc": "格式化、压缩、对比 JSON",
  "toolbox.registry.toolDiff": "文本对比",
  "toolbox.registry.toolDiffDesc": "逐行比较两段文本",
}[key] || key);
const QUERY = "把这个订单表另存成能直接用 Excel 打开的文件";

/** 按 key 给适用概率，造一份逐条 Noul 的响应。 */
const answered = (values) => ({
  answers: Object.fromEntries(Object.entries(values).map(([key, noul]) => [`applicable::${key}`, { type: "noul", noul }])),
  usage: { input_tokens: 200, output_tokens: 6 },
});

describe("buildToolRankRequest", () => {
  it("每个工具一个 Noul 问句，说明进 state", () => {
    const built = buildToolRankRequest(TOOLS, QUERY, { translate });
    expect(built.tools).toHaveLength(3);
    expect(built.body.state.request).toBe(QUERY);
    expect(built.body.state.tools.table).toContain("表格处理");
    expect(built.body.state.tools.table).toContain("csv");
    expect(built.body.questions["applicable::table"].type).toBe("noul");
    // 问句互相看不见，只能靠 state 路径定位自己那条工具
    expect(built.body.questions["applicable::table"].instructions).toContain('state.tools["table"]');
  });

  it("太短的一句话不发请求（子串检索够用了）", () => {
    expect(buildToolRankRequest(TOOLS, "json", { translate })).toBe(null);
    expect(buildToolRankRequest(TOOLS, "   ", { translate })).toBe(null);
    expect(buildToolRankRequest([], QUERY, { translate })).toBe(null);
  });

  it("说明超长会被截断，缺翻译函数也不会崩", () => {
    const long = [{ key: "x", labelKey: "a", descKey: "b", keywords: ["k".repeat(500)] }];
    const built = buildToolRankRequest(long, QUERY);
    expect(built.body.state.tools.x.length).toBeLessThanOrEqual(260);
    expect(built.body.state.tools.x).toBeTruthy();
  });
});

describe("parseToolRankResponse", () => {
  it("按概率倒序、低于下限不推荐", () => {
    const hits = parseToolRankResponse(TOOLS, answered({ table: 0.42, json: 0.91, diff: 0.05 }));
    expect(hits.map((h) => h.tool.key)).toEqual(["json", "table"]);
    expect(hits[0].score).toBeCloseTo(0.91);
  });

  it("默认下限挡住长尾，limit 截断", () => {
    expect(parseToolRankResponse(TOOLS, answered({ table: TOOL_SUGGEST_FLOOR / 2, json: 0.4, diff: 0.3 })).map((h) => h.tool.key)).toEqual(["json"]);
    expect(parseToolRankResponse(TOOLS, answered({ table: 0.9, json: 0.88, diff: 0.87 }), { limit: 2 })).toHaveLength(2);
    expect(parseToolRankResponse(TOOLS, answered({ table: 0.9, json: 0.8, diff: 0.7 }), { limit: 99 })).toHaveLength(3);
    expect(TOOL_SUGGEST_LIMIT).toBeGreaterThan(0);
  });

  it("坏响应一律空手而归，不抛错", () => {
    expect(parseToolRankResponse(TOOLS, null)).toEqual([]);
    expect(parseToolRankResponse(TOOLS, {})).toEqual([]);
    expect(parseToolRankResponse(TOOLS, { answers: {} })).toEqual([]);
    expect(parseToolRankResponse(null, answered({ table: 0.9 }))).toEqual([]);
    // 答了一个注册表里没有的 key：忽略它而不是崩
    expect(parseToolRankResponse(TOOLS, answered({ ghost: 0.9 }))).toEqual([]);
  });
});

describe("toolRankCertainty", () => {
  it("取最高那条的概率；一条都没答是 null 而不是 0", () => {
    expect(toolRankCertainty(TOOLS, answered({ table: 0.3, json: 0.77 }))).toBe(0.77);
    expect(toolRankCertainty(TOOLS, { answers: {} })).toBe(null);
    expect(toolRankCertainty(TOOLS, null)).toBe(null);
  });
});

describe("suggestTools", () => {
  it("走传输层并把请求原样交出去", async () => {
    const transport = vi.fn(async () => answered({ table: 0.86, json: 0.1, diff: 0.05 }));
    const hits = await suggestTools(TOOLS, QUERY, { transport, translate });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].state.request).toBe(QUERY);
    expect(hits.map((h) => h.tool.key)).toEqual(["table"]);
  });

  it("没配 TypeSafe 就是不推荐（这里没有字面兜底，字面检索是调用方在做的事）", async () => {
    const info = [];
    expect(await suggestTools(TOOLS, QUERY, { onResult: (i) => info.push(i) })).toEqual([]);
    expect(info[0]).toMatchObject({ matcher: "none", reason: "not-configured" });
  });

  it("报错/没把握都退回「不推荐」，并把原因交给诊断", async () => {
    const info = [];
    const failing = await suggestTools(TOOLS, QUERY, {
      transport: async () => {
        throw new Error("HTTP 401：invalid api key");
      },
      onResult: (i) => info.push(i),
    });
    expect(failing).toEqual([]);
    expect(info[0]).toMatchObject({ matcher: "none", reason: "transport-error", error: "HTTP 401：invalid api key" });

    const unsure = [];
    await suggestTools(TOOLS, QUERY, { transport: async () => answered({ table: 0.2, json: 0.1 }), onResult: (i) => unsure.push(i) });
    expect(unsure[0]).toMatchObject({ matcher: "none", reason: "low-confidence" });
  });

  it("成功时也有一条诊断：命中了什么、几个候选、耗时与 usage", async () => {
    const info = [];
    await suggestTools(TOOLS, QUERY, { transport: async () => answered({ table: 0.9 }), onResult: (i) => info.push(i), translate });
    expect(info[0]).toMatchObject({ matcher: "typesafe", hits: ["table"], candidates: 3, certainty: 0.9 });
    expect(info[0].usage).toMatchObject({ input_tokens: 200 });
    expect(Number.isFinite(info[0].latencyMs)).toBe(true);
  });

  it("问都不值得问时不发请求", async () => {
    const transport = vi.fn();
    const info = [];
    expect(await suggestTools(TOOLS, "json", { transport, onResult: (i) => info.push(i) })).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(info[0]).toMatchObject({ matcher: "none", reason: "not-worth-asking" });
  });
});

describe("isSemanticWorthy", () => {
  it("成句的中文诉求才值得问；单个词交给子串检索", () => {
    expect(isSemanticWorthy("json")).toBe(false);
    expect(isSemanticWorthy("base64")).toBe(false);
    expect(isSemanticWorthy("表格")).toBe(false);
    expect(isSemanticWorthy("把表格转成图片")).toBe(true);
    expect(isSemanticWorthy("convert this csv file to excel")).toBe(true);
    expect(isSemanticWorthy("hash")).toBe(false);
    expect(isSemanticWorthy("")).toBe(false);
  });
});
