import { describe, expect, it, vi } from "vitest";
import {
  VERIFY_CHECKS,
  VERIFY_REVIEW_BELOW,
  buildVerifyRequest,
  observationsOf,
  parseVerifyResponse,
  verifyOutcome,
} from "./verify.js";

const history = [
  { action: { type: "tool_call", tool: "file.read_text", args: { path: "order.json" } }, result: { text: "[]" } },
  { action: { type: "ask_user", question: "要哪一天？" }, answer: "昨天" },
  { action: { type: "tool_call", tool: "json.parse", args: { text: "[]" } }, result: { rows: 12 } },
];

describe("observationsOf", () => {
  it("只取工具调用那几步，问答步不进观察", () => {
    const list = observationsOf(history);
    expect(list).toHaveLength(2);
    expect(list[0]).toContain("file.read_text");
    expect(list[1]).toContain("json.parse");
    // 结果里的具体值要留着：核验「12 这个数字有没有出处」靠的就是它
    expect(list[1]).toContain("12");
  });

  it("失败步骤带着失败原因，而不是伪装成一次成功观察", () => {
    const list = observationsOf([{ action: { type: "tool_call", tool: "db.query_readonly" }, error: "连接超时" }]);
    expect(list[0]).toContain("失败");
    expect(list[0]).toContain("连接超时");
  });

  it("只带最后几步、单步结果截断（长文件不该把核验请求顶爆）", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ action: { type: "tool_call", tool: `t${i}` }, result: { text: "x".repeat(5000) } }));
    const list = observationsOf(many);
    expect(list).toHaveLength(8);
    expect(list[0]).toContain("t12");
    for (const item of list) expect(item.length).toBeLessThanOrEqual(700);
  });

  it("结果无法序列化时降级成字符串而不是抛错", () => {
    const circular = {};
    circular.self = circular;
    expect(observationsOf([{ action: { type: "tool_call", tool: "x" }, result: circular }])[0]).toContain("x：");
  });

  it("空历史给空列表", () => {
    expect(observationsOf([])).toEqual([]);
    expect(observationsOf(null)).toEqual([]);
  });
});

describe("buildVerifyRequest", () => {
  it("三项检查都在，state 带目标/答案/观察", () => {
    const built = buildVerifyRequest({ goal: "统计重复订单", answer: "找到 12 条", history });
    expect(Object.keys(built.body.questions)).toEqual(["check::executed", "check::grounded", "check::complete"]);
    expect(Object.keys(VERIFY_CHECKS)).toHaveLength(3);
    expect(built.body.state.goal).toBe("统计重复订单");
    expect(built.body.state.answer).toBe("找到 12 条");
    expect(built.body.state.observations).toHaveLength(2);
    // 问句只引用 state 里已有的东西，不引用别的问句
    expect(built.body.questions["check::grounded"].instructions).toContain("state.observations");
  });

  it("纯问答（没有任何工具调用）不核验", () => {
    expect(buildVerifyRequest({ goal: "解释什么是索引", answer: "索引是……", history: [] })).toBe(null);
    expect(buildVerifyRequest({ goal: "", answer: "x", history })).toBe(null);
    expect(buildVerifyRequest({ goal: "g", answer: "  ", history })).toBe(null);
    expect(buildVerifyRequest()).toBe(null);
  });

  it("超长答案被截断", () => {
    const built = buildVerifyRequest({ goal: "g", answer: "长".repeat(9000), history });
    expect(built.body.state.answer.length).toBeLessThanOrEqual(4000);
  });
});

describe("parseVerifyResponse", () => {
  const response = (values) => ({
    answers: Object.fromEntries(Object.entries(values).map(([key, noul]) => [`check::${key}`, { type: "noul", noul }])),
  });

  it("三项分数与最低项", () => {
    const { scores, weakest } = parseVerifyResponse(response({ executed: 0.9, grounded: 0.42, complete: 0.8 }));
    expect(scores.grounded).toBe(0.42);
    expect(weakest).toBeCloseTo(0.42);
  });

  it("部分缺失只算在场的项，全缺是 null（没核成 ≠ 不可信）", () => {
    expect(parseVerifyResponse(response({ executed: 0.7 })).weakest).toBeCloseTo(0.7);
    const empty = parseVerifyResponse({ answers: {} });
    expect(empty.scores).toEqual({});
    expect(empty.weakest).toBe(null);
    expect(parseVerifyResponse(null).weakest).toBe(null);
  });
});

describe("verifyOutcome", () => {
  const transport = (values) =>
    vi.fn(async () => ({
      answers: Object.fromEntries(Object.entries(values).map(([key, noul]) => [`check::${key}`, { type: "noul", noul }])),
      usage: { input_tokens: 300, output_tokens: 3 },
    }));
  const base = { goal: "统计重复订单", answer: "找到 12 条重复记录", history };

  it("把握够高：verified 且不需要复核", async () => {
    const result = await verifyOutcome({ ...base, transport: transport({ executed: 0.9, grounded: 0.86, complete: 0.95 }) });
    expect(result).toMatchObject({ verified: true, needsReview: false, weakest: 0.86 });
    expect(result.usage).toMatchObject({ input_tokens: 300 });
  });

  it("任一项低于口径就要求复核，并点名是哪几项", async () => {
    const result = await verifyOutcome({ ...base, transport: transport({ executed: 0.95, grounded: 0.2, complete: 0.4 }) });
    expect(result.needsReview).toBe(true);
    expect(result.reviewOf).toEqual(["grounded", "complete"]);
    expect(result.weakest).toBeCloseTo(0.2);
  });

  it("阈值可配（收紧口径只需改一个数，不必改实现）", async () => {
    const values = { executed: 0.6, grounded: 0.6, complete: 0.6 };
    expect((await verifyOutcome({ ...base, transport: transport(values), threshold: 0.5 })).needsReview).toBe(false);
    expect((await verifyOutcome({ ...base, transport: transport(values), threshold: 0.7 })).needsReview).toBe(true);
    expect(VERIFY_REVIEW_BELOW).toBeGreaterThanOrEqual(0.5);
  });

  it("没配 TypeSafe / 纯问答 / 传输层报错：一律「没核验」而不是抛错", async () => {
    expect(await verifyOutcome(base)).toMatchObject({ verified: false, reason: "not-configured", needsReview: false });
    expect(await verifyOutcome({ goal: "解释", answer: "……", history: [] })).toMatchObject({ verified: false, reason: "nothing-to-verify" });
    const failing = await verifyOutcome({ ...base, transport: async () => { throw new Error("HTTP 429：限流"); } });
    expect(failing).toMatchObject({ verified: false, reason: "transport-error", error: "HTTP 429：限流", needsReview: false });
  });

  it("模型一条都没答：verified 为假，不会被当成「不可信」报警", async () => {
    const result = await verifyOutcome({ ...base, transport: async () => ({ answers: {} }) });
    expect(result).toMatchObject({ verified: false, needsReview: false, weakest: null });
  });
});
