import { describe, expect, it, vi } from "vitest";
import { extractSkill } from "./skills.js";
import {
  NO_SKILL,
  SKILL_SUGGEST_FLOOR,
  SKILL_SUGGEST_GATE,
  SKILL_SUGGEST_MODEL,
  buildSuggestRequest,
  parseSuggestResponse,
  suggestSkills,
} from "./skillSuggest.js";

const run = (overrides = {}) => ({
  id: "run-1",
  input: "读取 order.json，找出重复字段并导出 CSV",
  status: "success",
  history: [
    { action: { type: "tool_call", tool: "file.read_text", args: { path: "order.json" } }, result: { text: "{}" } },
    { action: { type: "tool_call", tool: "json.parse", args: { text: "{}" } }, result: { rows: [1, 2, 3] } },
  ],
  ...overrides,
});

const skill = (id, over = {}) => ({ ...extractSkill(run(), { id, now: 1000 }), ...over });
const GOAL = "读取 order.json 导出 csv";

/** 造一份 TypeSafe 响应：picks 是 buildSuggestRequest 给出的键→技能映射。 */
const answer = (picks, { choice, probabilities, gate = 0.9 } = {}) => ({
  model: SKILL_SUGGEST_MODEL,
  answers: {
    pick: {
      type: "choice",
      choice: choice ?? picks[0].key,
      confidence: 0.8,
      probabilities: probabilities ?? Object.fromEntries(picks.map((p, i) => [p.key, i === 0 ? 1 : 0])),
    },
    "gate::acts_on_data": { type: "noul", noul: gate },
    "gate::follows_recorded_procedure": { type: "noul", noul: gate },
    "gate::prose_suffices": { type: "noul", noul: 1 - gate },
  },
  usage: { input_tokens: 100, output_tokens: 10 },
});

describe("buildSuggestRequest", () => {
  it("没有可用技能或目标为空时不发请求", () => {
    expect(buildSuggestRequest([], GOAL)).toBe(null);
    expect(buildSuggestRequest(null, GOAL)).toBe(null);
    expect(buildSuggestRequest([skill("s1")], "")).toBe(null);
    expect(buildSuggestRequest([skill("s1")], "   ")).toBe(null);
  });

  it("Choice 覆盖每条技能，并带上「都不合适」这一项", () => {
    const built = buildSuggestRequest([skill("s1"), skill("s2")], GOAL);
    const criteria = built.body.questions.pick.criteria;
    expect(built.body.questions.pick.type).toBe("choice");
    expect(Object.keys(criteria)).toHaveLength(3);
    expect(criteria[NO_SKILL]).toBeTruthy();
    for (const pick of built.picks) expect(criteria[pick.key]).toContain(pick.skill.name);
  });

  it("state 带目标、model 用默认别名", () => {
    const built = buildSuggestRequest([skill("s1")], GOAL);
    expect(built.body.state).toEqual({ goal: GOAL });
    expect(built.body.model).toBe(SKILL_SUGGEST_MODEL);
    expect(buildSuggestRequest([skill("s1")], GOAL, { model: "jev-1.12" }).body.model).toBe("jev-1.12");
  });

  it("问题指令不进 state（问句与内容分离）", () => {
    const built = buildSuggestRequest([skill("s1")], GOAL);
    expect(JSON.stringify(built.body.state)).not.toContain("Which of these");
  });

  it("关掉的技能不进候选", () => {
    const built = buildSuggestRequest([skill("s1"), skill("s2")], GOAL, { disabled: ["s1"] });
    expect(built.picks.map((p) => p.skill.id)).toEqual(["s2"]);
  });

  it("三个 gate 问句都在，且都能只看 state 回答", () => {
    const built = buildSuggestRequest([skill("s1")], GOAL);
    const gates = Object.keys(built.body.questions).filter((k) => k.startsWith("gate::"));
    expect(gates).toHaveLength(3);
    for (const key of gates) {
      expect(built.body.questions[key].type).toBe("noul");
      // 问句不得引用别的问句的 criteria（各问句互相看不见）
      expect(built.body.questions[key].instructions).not.toMatch(/criteria|option/i);
    }
  });

  it("同名技能拿到不同的选项键（否则选项会在 map 里互相覆盖）", () => {
    const built = buildSuggestRequest([skill("s1"), skill("s2")], GOAL);
    const keys = built.picks.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(built.body.questions.pick.criteria)).toHaveLength(keys.length + 1);
  });

  it("坏技能（缺 id/name）被跳过", () => {
    expect(buildSuggestRequest([null, 7, "x", { id: "s1" }], GOAL)).toBe(null);
  });
});

describe("parseSuggestResponse", () => {
  const picks = [
    { key: "a", skill: skill("s1") },
    { key: "b", skill: skill("s2") },
    { key: "c", skill: skill("s3") },
  ];

  it("按概率倒序给出命中，分数即概率", () => {
    const matches = parseSuggestResponse(picks, answer(picks, { choice: "b", probabilities: { a: 0.2, b: 0.5, c: 0.3 } }));
    expect(matches.map((m) => m.skill.id)).toEqual(["s2", "s3", "s1"]);
    expect(matches[0].score).toBeCloseTo(0.5);
  });

  it("gate 低于阈值时一条都不注入（宁少勿滥）", () => {
    const low = answer(picks, { gate: 0.1 });
    expect(parseSuggestResponse(picks, low)).toEqual([]);
    // 阈值本身就是边界：等于阈值算通过
    expect(parseSuggestResponse(picks, answer(picks, { gate: SKILL_SUGGEST_GATE }))).toHaveLength(1);
  });

  it("模型选了「都不合适」时不注入", () => {
    expect(parseSuggestResponse(picks, answer(picks, { choice: NO_SKILL }))).toEqual([]);
  });

  it("概率低于下限的候选被丢掉", () => {
    const matches = parseSuggestResponse(
      picks,
      answer(picks, { choice: "a", probabilities: { a: 0.6, b: 0.3, c: 0.1 } }),
      { floor: 0.2 },
    );
    expect(matches.map((m) => m.skill.id)).toEqual(["s1", "s2"]);
  });

  it("默认下限把长尾候选挡在外面", () => {
    const tail = SKILL_SUGGEST_FLOOR / 2;
    const matches = parseSuggestResponse(
      picks,
      answer(picks, { choice: "a", probabilities: { a: 1 - tail * 2, b: tail, c: tail } }),
    );
    expect(matches.map((m) => m.skill.id)).toEqual(["s1"]);
  });

  it("按 limit 截断", () => {
    const matches = parseSuggestResponse(
      picks,
      answer(picks, { choice: "a", probabilities: { a: 0.4, b: 0.35, c: 0.25 } }),
      { limit: 2 },
    );
    expect(matches).toHaveLength(2);
  });

  it("选中的技能即使概率为 0 也保留（模型的选择本身就是证据）", () => {
    const matches = parseSuggestResponse(picks, answer(picks, { choice: "c", probabilities: { a: 0.5, b: 0.5, c: 0 } }));
    expect(matches.map((m) => m.skill.id)).toContain("s3");
  });

  it("坏响应一律退化成「不注入」，不抛错", () => {
    expect(parseSuggestResponse(picks, null)).toEqual([]);
    expect(parseSuggestResponse(picks, {})).toEqual([]);
    expect(parseSuggestResponse(picks, { answers: {} })).toEqual([]);
    expect(parseSuggestResponse(picks, { answers: { pick: { type: "choice" } } })).toEqual([]);
    expect(parseSuggestResponse(null, answer(picks))).toEqual([]);
  });

  it("概率里出现未知选项时忽略它", () => {
    const matches = parseSuggestResponse(picks, answer(picks, { choice: "a", probabilities: { a: 0.7, zzz: 0.3 } }));
    expect(matches.map((m) => m.skill.id)).toEqual(["s1"]);
  });
});

describe("suggestSkills（编排 + 兜底）", () => {
  it("走传输层，把请求体原样交给它", async () => {
    // 选项键由 buildSuggestRequest 生成，所以响应必须按真实键来造，否则等于自欺
    const transport = vi.fn(async (body) => {
      const keys = Object.keys(body.questions.pick.criteria).filter((k) => k !== NO_SKILL);
      return answer([{ key: keys[0], skill: skill("s1") }]);
    });
    const matches = await suggestSkills([skill("s1")], GOAL, { transport });
    expect(transport).toHaveBeenCalledTimes(1);
    const body = transport.mock.calls[0][0];
    expect(body.state).toEqual({ goal: GOAL });
    expect(body.questions.pick.type).toBe("choice");
    expect(matches.map((m) => m.skill.id)).toEqual(["s1"]);
  });

  it("传输层抛错时退回关键词匹配，而不是让 Agent 变哑", async () => {
    const transport = vi.fn(async () => {
      throw new Error("HTTP 429：rate limited");
    });
    const matches = await suggestSkills([skill("s1")], GOAL, { transport });
    expect(matches.map((m) => m.skill.id)).toEqual(["s1"]);
  });

  it("没配传输层时直接用关键词匹配（未配置 TypeSafe 的默认路径）", async () => {
    const matches = await suggestSkills([skill("s1")], GOAL, {});
    expect(matches.map((m) => m.skill.id)).toEqual(["s1"]);
  });

  it("没有候选技能时不发请求", async () => {
    const transport = vi.fn();
    expect(await suggestSkills([], GOAL, { transport })).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("关键词兜底也尊重 disabled 与阈值", async () => {
    const transport = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await suggestSkills([skill("s1")], GOAL, { transport, disabled: ["s1"] })).toEqual([]);
    expect(await suggestSkills([skill("s1")], "今天天气怎么样", { transport })).toEqual([]);
  });

  it("兜底开关关掉后失败即空手而归（不静默降级）", async () => {
    const transport = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await suggestSkills([skill("s1")], GOAL, { transport, fallback: false })).toEqual([]);
  });
});
