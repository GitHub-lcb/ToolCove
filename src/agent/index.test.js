import { beforeEach, describe, expect, it, vi } from "vitest";

// index.js 只用到 ai.js 的 aiComplete；mock 掉整个模块避开真实 IPC（同 session.test.js 的做法）
vi.mock("../ai.js", () => ({ aiComplete: vi.fn(), isAIConfigured: vi.fn(async () => true) }));

import { aiComplete } from "../ai.js";
import { MAX_REPAIR_ATTEMPTS, createAIPlanner, createRepairingPlanner, parseAction, runAIAgent } from "./index.js";
import { createToolRegistry } from "./runtime.js";

beforeEach(() => vi.clearAllMocks());

describe("parseAction 宽松解析", () => {
  it("裸 JSON 对象", () => {
    expect(parseAction('{"type":"final","answer":"ok"}')).toEqual({ type: "final", answer: "ok" });
  });

  it("```json 围栏包裹", () => {
    expect(parseAction('```json\n{"type":"final","answer":"ok"}\n```')).toEqual({ type: "final", answer: "ok" });
  });

  it("无语言标记的围栏", () => {
    expect(parseAction('```\n{"type":"final","answer":"ok"}\n```')).toEqual({ type: "final", answer: "ok" });
  });

  it("前后有解释文字时截取最外层花括号", () => {
    expect(parseAction('好的，我来处理。{"type":"final","answer":"ok"} 以上。')).toEqual({ type: "final", answer: "ok" });
  });

  it("空内容与纯文字报错", () => {
    expect(() => parseAction("")).toThrow("空内容");
    expect(() => parseAction("我不太确定该怎么回答")).toThrow();
  });

  it("数组或标量不是合法动作", () => {
    expect(() => parseAction("[1,2,3]")).toThrow();
    expect(() => parseAction('"just a string"')).toThrow();
  });
});

describe("createAIPlanner 的历史折叠", () => {
  const longHistory = Array.from({ length: 14 }, (_, i) => ({
    action: { type: "tool_call", tool: `tool${i}`, args: { i } },
    result: `结果 ${i}`,
  }));

  it("长历史进 prompt 时是折叠后的摘要，而不是被丢掉的尾巴", async () => {
    aiComplete.mockResolvedValueOnce('{"type":"final","answer":"ok"}');
    const planner = createAIPlanner();
    await planner({ input: "目标", history: longHistory, tools: [], repairs: [] });
    const prompt = aiComplete.mock.calls[0][0];
    // 早期步骤仍在（摘要），并且明说了已折叠
    expect(prompt).toContain("tool0");
    expect(prompt).toContain("已折叠");
    expect(prompt).toContain("tool13");
  });

  it("短历史照旧给原文", async () => {
    aiComplete.mockResolvedValueOnce('{"type":"final","answer":"ok"}');
    const planner = createAIPlanner();
    await planner({ input: "目标", history: longHistory.slice(0, 3), tools: [], repairs: [] });
    const prompt = aiComplete.mock.calls[0][0];
    expect(prompt).not.toContain("已折叠");
    expect(prompt).toContain("tool0");
  });

  it("折叠参数可覆盖（keepTail / summaryBudget 透传）", async () => {
    aiComplete.mockResolvedValueOnce('{"type":"final","answer":"ok"}');
    const planner = createAIPlanner({ keepTail: 2, summaryBudget: 300 });
    await planner({ input: "目标", history: longHistory, tools: [], repairs: [] });
    const prompt = aiComplete.mock.calls[0][0];
    expect(prompt).toContain("最近 2 步");
  });
});

describe("createAIPlanner 的技能注入", () => {
  const skill = {
    id: "s1",
    name: "读取 order.json 导出 csv",
    description: "读取 order.json｜file.read_text → json.parse",
    instructions: "目标：读取 order.json，找出重复字段并导出 CSV\n- file.read_text → 12 项",
    keywords: ["order.json", "csv", "重复"],
    toolNames: ["file.read_text", "json.parse"],
    createdAt: 1,
  };

  it("命中的技能正文进 prompt，并说明「仅供参考、参数要重新核对」", async () => {
    aiComplete.mockResolvedValueOnce('{"type":"final","answer":"ok"}');
    const planner = createAIPlanner({ skills: [skill] });
    await planner({ input: "读取 order.json 找出重复字段并导出 csv", history: [], tools: [], repairs: [] });
    const prompt = aiComplete.mock.calls[0][0];
    expect(prompt).toContain("【技能】");
    expect(prompt).toContain("file.read_text");
    expect(prompt).toContain("参数必须重新核对");
  });

  it("不相关的目标不注入（目录不进 prompt，省 token）", async () => {
    aiComplete.mockResolvedValueOnce('{"type":"final","answer":"ok"}');
    const planner = createAIPlanner({ skills: [skill] });
    await planner({ input: "今天天气怎么样", history: [], tools: [], repairs: [] });
    const prompt = aiComplete.mock.calls[0][0];
    expect(prompt).not.toContain("【技能】");
    expect(prompt).not.toContain("order.json");
  });

  it("用户关掉的技能不注入", async () => {
    aiComplete.mockResolvedValueOnce('{"type":"final","answer":"ok"}');
    const planner = createAIPlanner({ skills: [skill], disabledSkills: ["s1"] });
    await planner({ input: "读取 order.json 找出重复字段并导出 csv", history: [], tools: [], repairs: [] });
    expect(aiComplete.mock.calls[0][0]).not.toContain("【技能】");
  });

  it("没配技能库时不报错也不注入", async () => {
    aiComplete.mockResolvedValueOnce('{"type":"final","answer":"ok"}');
    const planner = createAIPlanner();
    await planner({ input: "读取 order.json 导出 csv", history: [], tools: [], repairs: [] });
    expect(aiComplete.mock.calls[0][0]).not.toContain("【技能】");
  });
});

describe("createRepairingPlanner", () => {  it("首次成功就不打修复日志", async () => {
    const planner = vi.fn(async () => ({ type: "final", answer: "ok" }));
    const onRepair = vi.fn();
    const result = await createRepairingPlanner(planner, { onRepair })({ history: [] });
    expect(result).toEqual({ type: "final", answer: "ok" });
    expect(planner).toHaveBeenCalledTimes(1);
    expect(onRepair).not.toHaveBeenCalled();
  });

  it("解析失败后把错误回灌并重试，成功即返回", async () => {
    const planner = vi
      .fn()
      .mockRejectedValueOnce(Error("Unexpected token 好"))
      .mockResolvedValueOnce({ type: "final", answer: "fixed" });
    const history = [];
    const onRepair = vi.fn();
    const result = await createRepairingPlanner(planner, { onRepair })({ history });

    expect(result.answer).toBe("fixed");
    expect(planner).toHaveBeenCalledTimes(2);
    expect(onRepair).toHaveBeenCalledTimes(1);

    // 错误要回灌给模型，否则它只会重复同样的错误输出
    const secondCallRepairs = planner.mock.calls[1][0].repairs;
    expect(secondCallRepairs).toEqual(["Unexpected token 好"]);
    // 同时进历史，模型下一轮能看到自己上次错在哪
    expect(history.at(-1)).toMatchObject({ action: { type: "protocol_error" }, error: "Unexpected token 好" });
  });

  it("修复次数用完仍失败则抛错，上限有界", async () => {
    const planner = vi.fn(async () => {
      throw Error("还是不是 JSON");
    });
    const onRepair = vi.fn();
    await expect(createRepairingPlanner(planner, { onRepair })({ history: [] })).rejects.toThrow("还是不是 JSON");
    expect(planner).toHaveBeenCalledTimes(MAX_REPAIR_ATTEMPTS + 1);
    expect(onRepair).toHaveBeenCalledTimes(MAX_REPAIR_ATTEMPTS);
  });

  it("maxRepairAttempts=0 时不重试", async () => {
    const planner = vi.fn(async () => {
      throw Error("坏输出");
    });
    await expect(createRepairingPlanner(planner, { maxRepairAttempts: 0 })({ history: [] })).rejects.toThrow("坏输出");
    expect(planner).toHaveBeenCalledTimes(1);
  });

  it("带 code 的错误是传输/配置故障，不属于「模型说错话」，直接上抛", async () => {
    const planner = vi.fn(async () => {
      throw Object.assign(Error("限流"), { code: "RATE_LIMIT" });
    });
    const onRepair = vi.fn();
    await expect(createRepairingPlanner(planner, { onRepair })({ history: [] })).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(planner).toHaveBeenCalledTimes(1);
    expect(onRepair).not.toHaveBeenCalled();
  });

  it("history 不是数组时不崩", async () => {
    const planner = vi.fn().mockRejectedValueOnce(Error("坏")).mockResolvedValueOnce({ type: "final", answer: "ok" });
    await expect(createRepairingPlanner(planner)({ history: null })).resolves.toEqual({ type: "final", answer: "ok" });
  });
});

describe("createAIPlanner 的修复提示", () => {
  it("有 repairs 时把错误原文写进 prompt", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    await createAIPlanner()({ input: "目标", history: [], tools: [], repairs: ["Unexpected token"] });
    expect(aiComplete.mock.calls[0][0]).toContain("Unexpected token");
    expect(aiComplete.mock.calls[0][0]).toContain("无法解析为 JSON 动作");
  });

  it("无 repairs 时 prompt 不含修复段", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    await createAIPlanner()({ input: "目标", history: [], tools: [] });
    expect(aiComplete.mock.calls[0][0]).not.toContain("无法解析为 JSON 动作");
  });
});

describe("runAIAgent 端到端修复", () => {
  it("模型先回非 JSON，再回合法动作：运行成功且时间线留修复事件", async () => {
    aiComplete
      .mockResolvedValueOnce("好的，我先看一下这个任务")
      .mockResolvedValueOnce('{"type":"final","answer":"搞定"}');
    const events = [];
    const registry = createToolRegistry([{ name: "noop", execute: () => "ok" }]);

    const result = await runAIAgent("目标", { registry, onEvent: (e) => events.push(e) });

    expect(result.status).toBe("completed");
    expect(result.answer).toBe("搞定");
    // 修复过程必须可见：否则用户只看到「卡了一下」
    expect(events.some((e) => e.type === "model_repair")).toBe(true);
    expect(aiComplete).toHaveBeenCalledTimes(2);
  });

  it("一直回非 JSON：按失败收尾，不会无限重试", async () => {
    aiComplete.mockResolvedValue("完全不是 JSON 的一段话");
    const registry = createToolRegistry([{ name: "noop", execute: () => "ok" }]);
    const result = await runAIAgent("目标", { registry });
    expect(result.status).toBe("failed");
    expect(aiComplete).toHaveBeenCalledTimes(MAX_REPAIR_ATTEMPTS + 1);
  });
});
