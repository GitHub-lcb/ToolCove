// 结果归类的单测。
//
// 这层的存在意义是「不谎报」。所以最要紧的用例是那些「HTTP 200 但其实没成」的场景：
// 业务码不对、返回 HTML 登录页、字段路径填错——它们都必须落到 failed / not-json / unknown，
// 绝不能落到 ok。
import { describe, expect, it } from "vitest";
import { classifyCheckIn, classifyStatus, DONE_OUTCOMES, OUTCOME, RETRYABLE_OUTCOMES } from "./classify.js";

const READ = { checkedIn: "data.checkedToday", points: "data.points", message: "message", code: "", successCodes: null };
const READ_WITH_CODE = { ...READ, code: "code", successCodes: [0] };

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: typeof body === "string" ? body : JSON.stringify(body), error: "", retryAfterMs: 0 });
const resErr = (error) => ({ ok: false, status: 0, text: "", error, retryAfterMs: 0 });

describe("HTTP 层状态码", () => {
  it("401/403 归为鉴权失效（重试无意义）", () => {
    expect(classifyCheckIn(res(401, ""), READ).outcome).toBe(OUTCOME.AUTH);
    expect(classifyCheckIn(res(403, ""), READ).outcome).toBe(OUTCOME.AUTH);
    expect(classifyStatus(res(401, ""), READ).outcome).toBe(OUTCOME.AUTH);
  });

  it("429 归为限流", () => {
    expect(classifyCheckIn(res(429, ""), READ).outcome).toBe(OUTCOME.RATE_LIMITED);
  });

  it("5xx 与其它 4xx 分开：前者值得退避重试", () => {
    expect(classifyCheckIn(res(500, ""), READ).outcome).toBe(OUTCOME.SERVER);
    expect(classifyCheckIn(res(404, ""), READ).outcome).toBe(OUTCOME.CLIENT);
    expect(RETRYABLE_OUTCOMES.has(OUTCOME.SERVER)).toBe(true);
    expect(RETRYABLE_OUTCOMES.has(OUTCOME.AUTH)).toBe(false);
  });

  it("网络异常归为 network 并带上原因", () => {
    const r = classifyCheckIn(resErr("请求超时（20000ms）"), READ);
    expect(r.outcome).toBe(OUTCOME.NETWORK);
    expect(r.error).toContain("超时");
  });
});

describe("200 但不是成功", () => {
  it("body 不是 JSON（多半是 HTML 登录页）→ not-json", () => {
    const r = classifyCheckIn(res(200, "<!DOCTYPE html><html>登录</html>"), READ);
    expect(r.outcome).toBe(OUTCOME.NOT_JSON);
    expect(DONE_OUTCOMES.has(r.outcome)).toBe(false);
  });

  it("空 body 也算 not-json", () => {
    expect(classifyCheckIn(res(200, ""), READ).outcome).toBe(OUTCOME.NOT_JSON);
  });

  it("业务码不在白名单 → failed，且优先展示 message", () => {
    const r = classifyCheckIn(res(200, { code: 40101, message: "登录态已过期" }), READ_WITH_CODE);
    expect(r.outcome).toBe(OUTCOME.FAILED);
    expect(r.error).toBe("登录态已过期");
  });

  it("配了 successCodes 但取不到 code → 也判 failed（路径写错等于没成）", () => {
    const r = classifyCheckIn(res(200, { data: { checkedToday: true } }), READ_WITH_CODE);
    expect(r.outcome).toBe(OUTCOME.FAILED);
  });

  it("业务码命中但字段路径填错 → unknown，不算成功", () => {
    const r = classifyCheckIn(res(200, { code: 0, data: { 其他字段: true } }), READ_WITH_CODE);
    expect(r.outcome).toBe(OUTCOME.UNKNOWN);
    expect(r.error).toBe("checkedIn-unreadable");
  });
});

describe("签到结果", () => {
  it("读到 checkedToday=true → ok，并带上积分", () => {
    const r = classifyCheckIn(res(200, { data: { checkedToday: true, points: 100 } }), READ);
    expect(r.outcome).toBe(OUTCOME.OK);
    expect(r.points).toBe(100);
    expect(DONE_OUTCOMES.has(r.outcome)).toBe(true);
  });

  it("签完却说没签 → failed（多半是把别的布尔字段填进了 checkedIn）", () => {
    const r = classifyCheckIn(res(200, { data: { checkedToday: false } }), READ);
    expect(r.outcome).toBe(OUTCOME.FAILED);
    expect(r.error).toBe("checkedIn-still-false");
  });

  it("积分是字符串也能读出来", () => {
    expect(classifyCheckIn(res(200, { data: { checkedToday: true, points: "100" } }), READ).points).toBe(100);
  });

  it("读不到积分就不返回 0（显示 0 像「已清零」，是误导）", () => {
    expect(classifyCheckIn(res(200, { data: { checkedToday: true } }), READ).points).toBeUndefined();
    expect(classifyCheckIn(res(200, { data: { checkedToday: true, points: "abc" } }), READ).points).toBeUndefined();
  });
});

describe("查状态结果", () => {
  it("已签 → already（今天就不用再发了）", () => {
    expect(classifyStatus(res(200, { data: { checkedToday: true } }), READ).outcome).toBe(OUTCOME.ALREADY);
  });

  it("没签 → needed，语义上与「跳过」不同", () => {
    const r = classifyStatus(res(200, { data: { checkedToday: false } }), READ);
    expect(r.outcome).toBe(OUTCOME.NEEDED);
    expect(r.checkedIn).toBe(false);
    // 这条最关键：若把「还没签」归成 skipped，自动任务就永远不发了
    expect(r.outcome).not.toBe(OUTCOME.SKIPPED);
  });

  it("读不出状态 → unknown（让调用方决定，不能默认「没签」去盲签）", () => {
    expect(classifyStatus(res(200, { data: {} }), READ).outcome).toBe(OUTCOME.UNKNOWN);
  });
});
