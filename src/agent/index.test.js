import { beforeEach, describe, expect, it, vi } from "vitest";

// index.js 只用到 ai.js 的 aiComplete；mock 掉整个模块避开真实 IPC（同 session.test.js 的做法）
vi.mock("../ai.js", () => ({ aiComplete: vi.fn(), isAIConfigured: vi.fn(async () => true) }));

import { aiComplete } from "../ai.js";
import { CLARIFY_NOTHING } from "./clarify.js";
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

describe("createAIPlanner 的技能匹配来源", () => {
  // 名称/关键词与 GOAL 刻意零字面重合：这样「prompt 里有技能」只可能来自语义匹配，
  // 关键词兜底（scoreSkill < 3）永远带不进它。否则用例看着绿，实际测的是兜底路径。
  const skill = {
    id: "s1",
    name: "那条老路子",
    description: "按上次的顺序来一遍",
    instructions: "目标：读取 order.json 导出 csv\n用到的工具：file.read_text",
    keywords: ["zzz"],
    toolNames: ["file.read_text"],
    createdAt: 1,
  };
  const GOAL = "读取 order.json 导出 csv";
  /**
   * 造一份「模型选中第一条技能」的响应：按请求的**实际形状**作答。
   * P1 之后默认是 rerank（每条一个 applicable:: Noul），写死读 pick.criteria 会静默抛错，
   * 被 suggestSkills 的 catch 吞掉后退回关键词匹配——用例照样绿，但语义路径已经没在测了。
   */
  const suggest = ({ ambiguous, blocker } = {}) => async (body) => {
    const ids = Object.keys(body.questions).filter((id) => !id.startsWith("gate::") && !id.startsWith("clarify::"));
    const answers = {
      "gate::acts_on_data": { type: "noul", noul: 0.9 },
      "gate::follows_recorded_procedure": { type: "noul", noul: 0.9 },
      "gate::prose_suffices": { type: "noul", noul: 0.1 },
    };
    if (body.questions.pick) {
      answers.pick = { type: "choice", choice: ids[0], confidence: 0.9, probabilities: { [ids[0]]: 0.9 } };
    } else {
      ids.forEach((id) => {
        answers[id] = { type: "noul", noul: 0.9 };
      });
    }
    if (ambiguous !== undefined) {
      answers["clarify::ambiguous"] = { type: "noul", noul: ambiguous };
      answers["clarify::blocker"] = { type: "choice", choice: blocker };
    }
    return { answers };
  };

  it("注入的传输层结果进 prompt", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    const transport = vi.fn(suggest());
    const planner = createAIPlanner({ skills: [skill], typesafeTransport: transport });
    await planner({ input: GOAL, history: [], tools: [] });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(aiComplete.mock.calls[0][0]).toContain("【技能】");
  });

  it("默认就跑语义路径：关键词匹配单独跑时这条技能进不来", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    const planner = createAIPlanner({ skills: [skill] });
    await planner({ input: GOAL, history: [], tools: [] });
    expect(aiComplete.mock.calls[0][0]).not.toContain("【技能】");
  });

  it("一次运行只问一次 TypeSafe：按步数重复提问会把成本与延迟乘以步数", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    const transport = vi.fn(suggest());
    const planner = createAIPlanner({ skills: [skill], typesafeTransport: transport });
    await planner({ input: GOAL, history: [], tools: [] });
    await planner({ input: GOAL, history: [], tools: [] });
    await planner({ input: GOAL, history: [], tools: [] });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  // 与 GOAL 字面重合的技能：专给「退回关键词」那两条用例用。
  // 语义专用的 skill 故意不可字面命中，两者分开才能各测各的路径。
  const kwSkill = { ...skill, id: "s2", name: "导出 CSV", description: "读取 order.json 导出 csv", keywords: ["csv", "order.json"] };

  it("没配传输层时退回关键词匹配（未开启 TypeSafe 的默认路径）", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    const planner = createAIPlanner({ skills: [kwSkill] });
    await planner({ input: GOAL, history: [], tools: [] });
    expect(aiComplete.mock.calls[0][0]).toContain("【技能】");
  });

  it("传输层报错时仍然出 prompt（兜底不静默丢技能）", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    const transport = vi.fn(async () => {
      throw new Error("HTTP 429：rate limited");
    });
    const planner = createAIPlanner({ skills: [kwSkill], typesafeTransport: transport });
    await planner({ input: GOAL, history: [], tools: [] });
    expect(aiComplete.mock.calls[0][0]).toContain("【技能】");
  });

  it("歧义达门槛时提示里加一句「先问清再动手」", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    const transport = vi.fn(suggest({ ambiguous: 0.95, blocker: "output format" }));
    const planner = createAIPlanner({ skills: [skill], typesafeTransport: transport });
    await planner({ input: GOAL, history: [], tools: [] });
    const prompt = aiComplete.mock.calls[0][0];
    expect(prompt).toContain("ask_user");
    expect(prompt).toContain("不要替用户假设");
    expect(prompt).toContain("output format");
    // 仍然只问一次：歧义预判复用同一份请求，不该多一个往返
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("歧义没达门槛时提示里不加话（被无端反问比猜错更赶人）", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    const transport = vi.fn(suggest({ ambiguous: 0.3, blocker: CLARIFY_NOTHING }));
    const planner = createAIPlanner({ skills: [skill], typesafeTransport: transport });
    await planner({ input: GOAL, history: [], tools: [] });
    expect(aiComplete.mock.calls[0][0]).not.toContain("不要替用户假设");
  });

  it("配置里关掉 clarify 后，请求里不再带歧义问句", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    const transport = vi.fn(suggest());
    const planner = createAIPlanner({ skills: [skill], typesafeTransport: transport, typesafeTuning: { clarify: false } });
    await planner({ input: GOAL, history: [], tools: [] });
    const body = transport.mock.calls[0][0];
    expect(Object.keys(body.questions).some((id) => id.startsWith("clarify::"))).toBe(false);
  });

  it("技能库为空但开了歧义预判：仍然问一次，且不塞技能", async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    const transport = vi.fn(suggest({ ambiguous: 0.92, blocker: "time range" }));
    const planner = createAIPlanner({ skills: [], typesafeTransport: transport });
    await planner({ input: GOAL, history: [], tools: [] });
    expect(transport).toHaveBeenCalledTimes(1);
    const prompt = aiComplete.mock.calls[0][0];
    expect(prompt).not.toContain("【技能】");
    expect(prompt).toContain("time range");
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
