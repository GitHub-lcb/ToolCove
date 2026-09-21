import { describe, expect, it } from "vitest";
import {
  CLARIFY_BLOCKERS,
  CLARIFY_HINT_AT,
  CLARIFY_NOTHING,
  buildClarifyQuestions,
  clarifyPromptLine,
  parseClarify,
} from "./clarify.js";

/** 按问句 id 造响应：只写在场的那几项，缺的按「没答」处理。 */
const answered = (values) => ({ answers: Object.fromEntries(Object.entries(values)) });

describe("buildClarifyQuestions", () => {
  it("两句都在：一句判有没有缺口，一句问缺的是哪一类", () => {
    const questions = buildClarifyQuestions();
    expect(Object.keys(questions)).toEqual(["clarify::ambiguous", "clarify::blocker"]);
    expect(questions["clarify::ambiguous"].type).toBe("noul");
    expect(questions["clarify::blocker"].type).toBe("choice");
    // 两问都只依赖 state，因此可以并进任何一次带 goal 的请求（互相看不见）
    expect(questions["clarify::ambiguous"].instructions).toContain("state.goal");
    expect(questions["clarify::blocker"].instructions).toContain("state.goal");
  });

  it("Choice 有「其实不缺」的出口", () => {
    const criteria = buildClarifyQuestions()["clarify::blocker"].criteria;
    expect(criteria[CLARIFY_NOTHING]).toBeTruthy();
    expect(Object.keys(criteria)).toEqual([...Object.keys(CLARIFY_BLOCKERS)]);
  });
});

describe("parseClarify", () => {
  it("达门槛才提示，并读出缺的是哪一类", () => {
    const result = parseClarify(answered({ "clarify::ambiguous": { type: "noul", noul: 0.93 }, "clarify::blocker": { type: "choice", choice: "output format" } }));
    expect(result).toMatchObject({ assessed: true, ambiguous: 0.93, blocker: "output format", hint: true });
  });

  it("未达门槛：assessed 但没有 hint，也不读缺口", () => {
    const result = parseClarify(answered({ "clarify::ambiguous": { type: "noul", noul: 0.4 }, "clarify::blocker": { type: "choice", choice: "time range" } }));
    expect(result).toMatchObject({ assessed: true, hint: false, blocker: "" });
  });

  it("模型答「什么都不缺」时 blocker 为空", () => {
    const result = parseClarify(answered({ "clarify::ambiguous": { type: "noul", noul: 0.95 }, "clarify::blocker": { type: "choice", choice: CLARIFY_NOTHING } }));
    expect(result).toMatchObject({ hint: true, blocker: "" });
  });

  it("答了个不认识的类别时不猜：hint 仍在，blocker 留空", () => {
    const result = parseClarify(answered({ "clarify::ambiguous": { type: "noul", noul: 0.95 }, "clarify::blocker": { type: "choice", choice: " vibes " } }));
    expect(result).toMatchObject({ hint: true, blocker: "" });
  });

  it("缺问句、坏概率、null 响应都算「没判」，不能被当成「不歧义」", () => {
    expect(parseClarify(null)).toMatchObject({ assessed: false, ambiguous: null, hint: false });
    expect(parseClarify({ answers: {} })).toMatchObject({ assessed: false });
    expect(parseClarify(answered({ "clarify::ambiguous": { type: "noul", noul: "abc" } }))).toMatchObject({ assessed: false });
    // 只答了类别、没答概率：依然算没判
    expect(parseClarify(answered({ "clarify::blocker": { type: "choice", choice: "scope" } })).assessed).toBe(false);
  });

  it("门槛可配：调高它只是更少提示，不改实现", () => {
    const values = { "clarify::ambiguous": { type: "noul", noul: 0.85 }, "clarify::blocker": { type: "choice", choice: "scope" } };
    expect(parseClarify(answered(values)).hint).toBe(true);
    expect(parseClarify(answered(values), { threshold: 0.9 }).hint).toBe(false);
    expect(CLARIFY_HINT_AT).toBeGreaterThanOrEqual(0.8);
  });
});

describe("clarifyPromptLine", () => {
  it("没到门槛就是空串（不往提示里塞无条件的话）", () => {
    expect(clarifyPromptLine(null)).toBe("");
    expect(clarifyPromptLine({ hint: false })).toBe("");
  });

  it("提示只给方向，并带上最可能缺的那一类", () => {
    const line = clarifyPromptLine({ hint: true, blocker: "time range" });
    expect(line).toContain("ask_user");
    expect(line).toContain("不要替用户假设");
    expect(line).toContain("time range");
    // 不给出具体问法：措辞要贴着用户自己的说法，那是语言模型的活
    expect(line).not.toContain("请问您要哪一天");
  });

  it("不知道缺哪一类时也能提示，只是不括号", () => {
    const line = clarifyPromptLine({ hint: true, blocker: "" });
    expect(line).toContain("ask_user");
    expect(line).not.toContain("（最可能缺的是");
  });
});
