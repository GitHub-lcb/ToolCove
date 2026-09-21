import { describe, expect, it, vi } from "vitest";
import {
  SKILL_WORTH_CHECKS,
  SKILL_WORTH_MIN,
  assessSkillWorth,
  buildWorthRequest,
  parseWorthResponse,
} from "./skillWorth.js";

/** 一次「成功跑完」的运行：结构门槛过得去，交给语义判断的正是这种。 */
const run = (over = {}) => ({
  id: "run-1",
  status: "success",
  input: "读取 order.json，找出重复字段并导出 CSV",
  answer: "已完成：找到 2 个重复字段，写出 dup.csv",
  history: [
    { action: { type: "tool_call", tool: "file.read_text", args: { path: "order.json" } }, result: { text: "[]" } },
    { action: { type: "tool_call", tool: "json.parse", args: { text: "[]" } }, result: { rows: 2 } },
    { action: { type: "tool_call", tool: "file.write_text", args: { path: "dup.csv", text: "a,b" } }, result: { bytes: 4 } },
  ],
  ...over,
});

const answered = (values) => ({
  answers: Object.fromEntries(Object.entries(values).map(([key, noul]) => [`worth::${key}`, { type: "noul", noul }])),
});

describe("buildWorthRequest", () => {
  it("两项检查都在，state 只给步骤骨架不给具体值", () => {
    const built = buildWorthRequest(run());
    expect(Object.keys(built.body.questions)).toEqual(["worth::reusable", "worth::transferable"]);
    expect(Object.keys(SKILL_WORTH_CHECKS)).toEqual(["reusable", "transferable"]);
    expect(built.body.state.goal).toContain("order.json");
    // 参数键要送给模型（判断「换个文件还成立吗」需要看见参数位），但具体值不送
    expect(built.body.state.steps).toEqual(["file.read_text(path)", "json.parse(text)", "file.write_text(path, text)"]);
    expect(built.body.state.steps.join(" ")).not.toContain("dup.csv");
    expect(built.body.state.outcome).toContain("已完成");
  });

  it("没有工具调用或目标为空时不判断（结构门槛都过不去）", () => {
    expect(buildWorthRequest(run({ history: [] }))).toBe(null);
    expect(buildWorthRequest(run({ input: "" }))).toBe(null);
    expect(buildWorthRequest(null)).toBe(null);
  });

  it("步骤与最终答复都有长度上限", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ action: { type: "tool_call", tool: `t${i}`, args: {} } }));
    expect(buildWorthRequest(run({ history: many })).body.state.steps).toHaveLength(12);
    expect(buildWorthRequest(run({ answer: "长".repeat(5000) })).body.state.outcome.length).toBeLessThanOrEqual(600);
  });
});

describe("parseWorthResponse", () => {
  it("取最低项作为这次判断的把握", () => {
    const { scores, weakest } = parseWorthResponse(answered({ reusable: 0.8, transferable: 0.34 }));
    expect(scores.transferable).toBeCloseTo(0.34);
    expect(weakest).toBeCloseTo(0.34);
  });

  it("缺失/坏值不进分数表，全缺是 null 而不是 0", () => {
    expect(parseWorthResponse(answered({ reusable: 0.7 })).weakest).toBeCloseTo(0.7);
    expect(parseWorthResponse({ answers: {} })).toEqual({ scores: {}, weakest: null });
    expect(parseWorthResponse(null).weakest).toBe(null);
    expect(parseWorthResponse(answered({ reusable: "abc" })).weakest).toBe(null);
  });
});

describe("assessSkillWorth", () => {
  it("两项都有把握：assessed 且 reusable", async () => {
    const verdict = await assessSkillWorth({ run: run(), transport: async () => answered({ reusable: 0.9, transferable: 0.72 }) });
    expect(verdict).toMatchObject({ assessed: true, reusable: true, weakest: 0.72, low: [] });
  });

  it("任一项低于口径就不建议沉淀，并点名是哪一项", async () => {
    const verdict = await assessSkillWorth({ run: run(), transport: async () => answered({ reusable: 0.9, transferable: 0.2 }) });
    expect(verdict).toMatchObject({ assessed: true, reusable: false, low: ["transferable"] });
    expect(verdict.weakest).toBeCloseTo(0.2);
  });

  it("阈值可配：收紧口径只改一个数", async () => {
    const values = { reusable: 0.6, transferable: 0.6 };
    expect((await assessSkillWorth({ run: run(), transport: async () => answered(values) })).reusable).toBe(true);
    expect((await assessSkillWorth({ run: run(), transport: async () => answered(values), threshold: 0.7 })).reusable).toBe(false);
    expect(SKILL_WORTH_MIN).toBeGreaterThanOrEqual(0.5);
  });

  it("没配 TypeSafe / 传输层报错 / 没得判断：一律放行（assessed=false 不等于不值得）", async () => {
    expect(await assessSkillWorth({ run: run() })).toMatchObject({ assessed: false, reason: "not-configured", reusable: true });
    const failing = await assessSkillWorth({ run: run(), transport: async () => { throw new Error("HTTP 401"); } });
    expect(failing).toMatchObject({ assessed: false, reason: "transport-error", error: "HTTP 401", reusable: true });
    expect(await assessSkillWorth({ run: run({ history: [] }), transport: async () => answered({ reusable: 0.1 }) })).toMatchObject({
      assessed: false,
      reason: "nothing-to-judge",
      reusable: true,
    });
  });

  it("模型一条都没答：算「没判成」，不能因此拦下用户的沉淀", async () => {
    expect(await assessSkillWorth({ run: run(), transport: async () => ({ answers: {} }) })).toMatchObject({
      assessed: false,
      reusable: true,
      weakest: null,
    });
  });

  it("transport 收到的是完整请求体，模型名可覆盖", async () => {
    const transport = vi.fn(async () => answered({ reusable: 0.9, transferable: 0.9 }));
    await assessSkillWorth({ run: run(), transport, model: "jev-1.13" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].model).toBe("jev-1.13");
  });
});
