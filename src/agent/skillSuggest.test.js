import { describe, expect, it, vi } from "vitest";
import { extractSkill } from "./skills.js";
import {
  NO_SKILL,
  SKILL_SUGGEST_BODY_CHARS,
  SKILL_SUGGEST_FLOOR,
  SKILL_SUGGEST_GATE,
  SKILL_SUGGEST_MODEL,
  SKILL_SUGGEST_STATE_BUDGET,
  buildSuggestRequest,
  parseSuggestResponse,
  pickConfidence,
  shortlistSkills,
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
const answer = (picks, { choice, probabilities, gate = 0.9, confidence = 0.8 } = {}) => ({
  model: SKILL_SUGGEST_MODEL,
  answers: {
    pick: {
      type: "choice",
      choice: choice ?? picks[0].key,
      confidence,
      probabilities: probabilities ?? Object.fromEntries(picks.map((p, i) => [p.key, i === 0 ? 1 : 0])),
    },
    "gate::acts_on_data": { type: "noul", noul: gate },
    "gate::follows_recorded_procedure": { type: "noul", noul: gate },
    "gate::prose_suffices": { type: "noul", noul: 1 - gate },
  },
  usage: { input_tokens: 100, output_tokens: 10 },
});

/** 问句 id → 技能名：rerank 形状的前缀是 applicable::，choice 形状直接用选项键。 */
const nameOf = (id) => (id.startsWith("applicable::") ? id.slice("applicable::".length) : id);

/**
 * 按请求的**实际形状**作答：choice 填 pick 的分布，rerank 给每条 applicable:: 一个 noul。
 * 编排类用例因此不必跟着默认形状改动——它们要验的是接线，不是形状。
 * values / best 都以技能名为键，与形状无关。
 */
const respond = (body, { best, values = {}, gate = 0.9, confidence, clarify } = {}) => {
  const scoreOf = (name) => (name in values ? values[name] : name === best ? 0.9 : name === NO_SKILL ? 0.02 : 0.05);
  const answers = {
    "gate::acts_on_data": { type: "noul", noul: gate },
    "gate::follows_recorded_procedure": { type: "noul", noul: gate },
    "gate::prose_suffices": { type: "noul", noul: 1 - gate },
  };
  // 歧义预判与技能匹配共用一次请求，所以桩也要能同时答它两句
  if (clarify) {
    answers["clarify::ambiguous"] = { type: "noul", noul: clarify.ambiguous };
    answers["clarify::blocker"] = { type: "choice", choice: clarify.blocker };
  }
  const ids = Object.keys(body.questions).filter((id) => !id.startsWith("gate::") && !id.startsWith("clarify::"));
  if (body.questions.pick) {
    answers.pick = {
      type: "choice",
      choice: best ?? ids[0],
      probabilities: Object.fromEntries(ids.map((id) => [id, scoreOf(nameOf(id))])),
      confidence,
    };
  } else {
    for (const id of ids) answers[id] = { type: "noul", noul: scoreOf(nameOf(id)) };
  }
  return { model: SKILL_SUGGEST_MODEL, answers, usage: { input_tokens: 100, output_tokens: 10 } };
};

describe("buildSuggestRequest", () => {
  it("没有可用技能或目标为空时不发请求", () => {
    expect(buildSuggestRequest([], GOAL)).toBe(null);
    expect(buildSuggestRequest(null, GOAL)).toBe(null);
    expect(buildSuggestRequest([skill("s1")], "")).toBe(null);
    expect(buildSuggestRequest([skill("s1")], "   ")).toBe(null);
  });

  it("Choice 覆盖每条技能，并带上「都不合适」这一项", () => {
    const built = buildSuggestRequest([skill("s1"), skill("s2")], GOAL, { shape: "choice" });
    const criteria = built.body.questions.pick.criteria;
    expect(built.body.questions.pick.type).toBe("choice");
    expect(Object.keys(criteria)).toHaveLength(3);
    expect(criteria[NO_SKILL]).toBeTruthy();
    for (const pick of built.picks) expect(criteria[pick.key]).toContain(pick.skill.name);
  });

  it("state 带目标与技能正文，model 用默认别名", () => {
    const built = buildSuggestRequest([skill("s1")], GOAL);
    expect(built.body.state.goal).toBe(GOAL);
    // 正文必须真的在 state 里：判断「哪条流程对」却读不到流程，是在凭目录猜
    const key = built.picks[0].key;
    expect(built.body.state.skill_bodies[key]).toContain("file.read_text");
    expect(built.body.state.skill_bodies[key]).toContain("目标：");
    expect(built.body.model).toBe(SKILL_SUGGEST_MODEL);
    expect(buildSuggestRequest([skill("s1")], GOAL, { model: "jev-1.12" }).body.model).toBe("jev-1.12");
  });

  it("问句指向 state 里的正文，选项标签只当摘要", () => {
    const built = buildSuggestRequest([skill("s1")], GOAL, { shape: "choice" });
    expect(built.body.questions.pick.instructions).toContain("state.skill_bodies");
    // criteria 仍是「名称 | 描述 | tools」，不会因为正文挪走而变空
    expect(built.body.questions.pick.criteria[built.picks[0].key]).toContain(built.picks[0].skill.name);
  });

  it("正文按单条上限截断，超长部分不进请求", () => {
    const long = skill("s1", { instructions: "x".repeat(5000) });
    const built = buildSuggestRequest([long], GOAL);
    const body = built.body.state.skill_bodies[built.picks[0].key];
    expect(body.length).toBeLessThanOrEqual(SKILL_SUGGEST_BODY_CHARS);
    expect(body.endsWith("…")).toBe(true);
  });

  it("正文超总预算时按候选数均摊重切一遍，目录仍然完整", () => {
    const many = Array.from({ length: 40 }, (_, i) => skill(`s${i}`, { name: `技能${i}`, instructions: `目标：第${i}条\n` + "步骤".repeat(300) }));
    const built = buildSuggestRequest(many, GOAL, { shape: "choice" });
    const bodies = built.body.state.skill_bodies;
    const total = Object.values(bodies).reduce((sum, value) => sum + value.length, 0);
    expect(total).toBeLessThanOrEqual(SKILL_SUGGEST_STATE_BUDGET);
    // 12000 / 40 = 300：每条被压到均摊以内，但仍然读得出步骤
    expect(Object.keys(bodies)).toHaveLength(40);
    for (const value of Object.values(bodies)) expect(value.length).toBeLessThanOrEqual(300);
    // 退回的是正文，不是候选：少一条候选就是少一个可能被选中的正确答案
    expect(Object.keys(built.body.questions.pick.criteria)).toHaveLength(41);
  });

  it("均摊后短到读不出流程时整体不带正文（宁发目录，不发残句）", () => {
    const many = Array.from({ length: 40 }, (_, i) => skill(`s${i}`, { name: `技能${i}`, instructions: `目标：第${i}条\n` + "步骤".repeat(300) }));
    const built = buildSuggestRequest(many, GOAL, { stateBudget: 500, shape: "choice" });
    expect(built.body.state.skill_bodies).toEqual({});
    expect(Object.keys(built.body.questions.pick.criteria)).toHaveLength(41);
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
    const built = buildSuggestRequest([skill("s1"), skill("s2")], GOAL, { shape: "choice" });
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

describe("rerank 形状（逐条 Noul + 预筛）", () => {
  const picks = [
    { key: "A", skill: skill("s1", { createdAt: 3 }) },
    { key: "B", skill: skill("s2", { createdAt: 2 }) },
    { key: "C", skill: skill("s3", { createdAt: 1 }) },
  ];
  const rerank = (values, gate = 0.9) => ({
    answers: {
      ...Object.fromEntries(Object.entries(values).map(([key, noul]) => [`applicable::${key}`, { type: "noul", noul }])),
      "gate::acts_on_data": { type: "noul", noul: gate },
      "gate::follows_recorded_procedure": { type: "noul", noul: gate },
      "gate::prose_suffices": { type: "noul", noul: 1 - gate },
    },
  });

  it("每条概率独立，不再需要「选中的即使概率 0 也保留」那种补丁", () => {
    const matches = parseSuggestResponse(picks, rerank({ A: 0.31, B: 0.77, C: 0.02 }));
    expect(matches.map((m) => m.skill.id)).toEqual(["s2", "s1"]);
    expect(matches[0].score).toBeCloseTo(0.77);
  });

  it("全部低于下限时就是「都不合适」，不必再问一个特殊出口", () => {
    expect(parseSuggestResponse(picks, rerank({ A: 0.05, B: 0.04, C: 0.03 }))).toEqual([]);
  });

  it("gate 仍然先拦一道（这次请求压根不该带经验）", () => {
    expect(parseSuggestResponse(picks, rerank({ A: 0.95 }, 0.1))).toEqual([]);
  });

  it("缺失某条答案时只忽略那条，不牵连其他", () => {
    const matches = parseSuggestResponse(picks, rerank({ A: 0.8, C: 0.6 }));
    expect(matches.map((m) => m.skill.id)).toEqual(["s1", "s3"]);
  });

  it("按 limit 截断", () => {
    expect(parseSuggestResponse(picks, rerank({ A: 0.9, B: 0.85, C: 0.8 }), { limit: 2 })).toHaveLength(2);
  });

  it("同分时新的在前（技能库按时间倒序是它的既有取向）", () => {
    const matches = parseSuggestResponse(picks, rerank({ A: 0.9, B: 0.9, C: 0.9 }));
    expect(matches.map((m) => m.skill.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("库不大就不预筛：全量送才是最高召回", () => {
    expect(shortlistSkills(picks.map((p) => p.skill), GOAL, { candidates: 10 })).toHaveLength(3);
  });

  it("预筛名额不空着：零词面重合的按最新补位", () => {
    const many = Array.from({ length: 12 }, (_, i) => skill(`s${i}`, { name: `无关技能${i}`, instructions: `目标：无关${i}`, createdAt: i }));
    const hit = skill("hit", { name: "读取 order.json 导出 CSV", instructions: "目标：读取 order.json", createdAt: 0 });
    const list = shortlistSkills([hit, ...many], GOAL, { candidates: 4 });
    expect(list.map((s) => s.id)).toContain("hit");
    expect(list).toHaveLength(4);
    // 补进来的三条是最新的（createdAt 9/10/11），不是随手截的
    expect(list.map((s) => Number(s.createdAt)).sort((a, b) => a - b)).toEqual([0, 9, 10, 11]);
  });

  it("预筛看得到正文里的词：与名称零重合、与正文有线索的也能进来", () => {
    const target = skill("target", {
      name: "配置迁移",
      description: "换个格式",
      keywords: ["格式"],
      instructions: "目标：把 config.yaml 转成同结构的 JSON 并覆盖旧文件",
    });
    const noise = Array.from({ length: 12 }, (_, i) => skill(`n${i}`, { name: `噪音${i}`, description: "无关", instructions: "无关内容", createdAt: i }));
    const list = shortlistSkills([noise[0], target, ...noise.slice(1)], "config.yaml 这份配置帮我换成 json", { candidates: 3 });
    // 名称与关键词都捞不到，线索只在正文里——只看目录的预筛会把这条直接筛掉
    expect(list.map((s) => s.id)).toContain("target");
  });

  it("预筛的已知边界：零词面重合的改述句会被筛掉，调大 candidates 才救得回来", () => {
    const target = skill("target", {
      name: "配置迁移",
      description: "换个格式",
      instructions: "目标：把 config.yaml 转成同结构的 JSON 并覆盖旧文件",
      createdAt: 0,
    });
    const noise = Array.from({ length: 12 }, (_, i) => skill(`n${i}`, { name: `zzz${i}`, description: "qqq", instructions: "www", createdAt: i }));
    const all = [noise[0], target, ...noise.slice(1)];
    const zeroOverlap = "这段东西读着别扭，照另一种写法再整一份出来";
    // 词面预筛是召回导向而非语义导向，这类句子它认不出来——这正是预筛换来的代价
    expect(shortlistSkills(all, zeroOverlap, { candidates: 3 }).map((s) => s.id)).not.toContain("target");
    // candidates ≥ 库大小时不预筛，语义判断才有机会看到它（代价是 token）
    expect(shortlistSkills(all, zeroOverlap, { candidates: 20 }).map((s) => s.id)).toContain("target");
  });
});

describe("pickConfidence", () => {
  it("Choice 形状读 confidence，坏值与缺失都算「没有」", () => {
    expect(pickConfidence({ answers: { pick: { confidence: 0.42 } } }, [])).toBe(0.42);
    expect(pickConfidence({ answers: { pick: { confidence: "0.42" } } }, [])).toBe(0.42);
    expect(pickConfidence(null, [])).toBe(null);
    expect(pickConfidence({}, [])).toBe(null);
    expect(pickConfidence({ answers: { pick: {} } }, [])).toBe(null);
    expect(pickConfidence({ answers: { pick: { confidence: "abc" } } }, [])).toBe(null);
  });

  it("rerank 形状没有 confidence，用最高那条的适用概率当把握", () => {
    const picks = [{ key: "A", skill: skill("s1") }, { key: "B", skill: skill("s2") }];
    const response = {
      answers: {
        "applicable::A": { type: "noul", noul: 0.31 },
        "applicable::B": { type: "noul", noul: 0.77 },
      },
    };
    expect(pickConfidence(response, picks)).toBe(0.77);
    // 一条都没答 → 没有这个信号，不能当成「把握为 0」
    expect(pickConfidence({ answers: {} }, picks)).toBe(null);
  });
});

describe("suggestSkills（编排 + 兜底）", () => {
  const NAME = skill("s1").name;

  it("默认走 rerank：每条候选一个 Noul，不再是全库一次多选一", async () => {
    const transport = vi.fn(async (body) => respond(body, { best: NAME }));
    const matches = await suggestSkills([skill("s1")], GOAL, { transport });
    const body = transport.mock.calls[0][0];
    expect(body.questions.pick).toBeUndefined();
    expect(body.questions[`applicable::${NAME}`].type).toBe("noul");
    // 问句里要点名正文的位置——同一请求内的问句互相看不见，只能靠 state 定位
    expect(body.questions[`applicable::${NAME}`].instructions).toContain("state.skill_bodies");
    expect(body.state.skill_bodies[NAME]).toBeTruthy();
    expect(matches.map((m) => m.skill.id)).toEqual(["s1"]);
  });

  it("Choice 形状仍然可用（换形状要靠标注集实测，得留一条回退路）", async () => {
    const transport = vi.fn(async (body) => respond(body, { best: NAME }));
    const matches = await suggestSkills([skill("s1")], GOAL, { transport, shape: "choice" });
    const body = transport.mock.calls[0][0];
    expect(body.questions.pick.type).toBe("choice");
    expect(body.questions.pick.criteria[NAME]).toContain(NAME);
    expect(matches.map((m) => m.skill.id)).toEqual(["s1"]);
  });

  it("置信度低于下限时不硬注入，退回关键词匹配并说明原因", async () => {
    const transport = vi.fn(async (body) => respond(body, { values: { [NAME]: 0.1 } }));
    const info = [];
    const matches = await suggestSkills([skill("s1")], GOAL, { transport, onResult: (i) => info.push(i) });
    // 模型对每条都答「大概不适用」时，语义不比字面更可信，所以这条走的是关键词的结果
    expect(matches.map((m) => m.skill.id)).toEqual(["s1"]);
    expect(info[0]).toMatchObject({ matcher: "keyword", reason: "low-confidence" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("Choice 形状缺 confidence 时不拦（缺证据不等于反证据）", async () => {
    const transport = vi.fn(async (body) => {
      const response = respond(body, { best: NAME });
      delete response.answers.pick.confidence;
      return response;
    });
    const info = [];
    const matches = await suggestSkills([skill("s1")], GOAL, { transport, shape: "choice", onResult: (i) => info.push(i) });
    expect(matches.map((m) => m.skill.id)).toEqual(["s1"]);
    expect(info[0]).toMatchObject({ matcher: "typesafe", tier: "marked" });
  });

  it("每次判定都有交代：走了哪条路、形状、置信度、耗时、usage", async () => {
    const transport = vi.fn(async (body) => respond(body, { best: NAME }));
    const info = [];
    await suggestSkills([skill("s1")], GOAL, { transport, onResult: (i) => info.push(i) });
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ matcher: "typesafe", shape: "rerank", tier: "high", confidence: 0.9, matched: [NAME] });
    expect(info[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(info[0].usage).toMatchObject({ input_tokens: 100 });
  });

  it("传输层报错时把原因带给诊断，而不是吞掉", async () => {
    const transport = vi.fn(async () => {
      throw new Error("HTTP 429：rate limited");
    });
    const info = [];
    await suggestSkills([skill("s1")], GOAL, { transport, onResult: (i) => info.push(i) });
    expect(info[0]).toMatchObject({ matcher: "keyword", reason: "transport-error", error: "HTTP 429：rate limited" });
  });

  it("没有候选时也报一句，且不发请求", async () => {
    const transport = vi.fn();
    const info = [];
    expect(await suggestSkills([], GOAL, { transport, onResult: (i) => info.push(i) })).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(info[0]).toMatchObject({ matcher: "none", reason: "no-candidates" });
  });

  it("诊断回调抛错不影响匹配结果", async () => {
    const transport = vi.fn(async (body) => respond(body, { best: NAME }));
    const matches = await suggestSkills([skill("s1")], GOAL, {
      transport,
      onResult: () => {
        throw new Error("回调炸了");
      },
    });
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

describe("歧义预判并入运行前的那一次请求", () => {
  it("开 clarify 时技能问句与歧义问句同处一次请求", () => {
    const built = buildSuggestRequest([skill("s1")], GOAL, { clarify: true });
    const ids = Object.keys(built.body.questions);
    expect(ids.filter((id) => id.startsWith("clarify::"))).toHaveLength(2);
    expect(ids.filter((id) => id.startsWith("applicable::"))).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith("gate::"))).toHaveLength(3);
  });

  it("技能库为空但开了 clarify：仍然问一次（这时它是最有用的那一问）", () => {
    const built = buildSuggestRequest([], GOAL, { clarify: true });
    expect(built.picks).toEqual([]);
    expect(Object.keys(built.body.questions).filter((id) => id.startsWith("clarify::"))).toHaveLength(2);
  });

  it("技能库为空且没开 clarify：不发请求（保持旧行为）", () => {
    expect(buildSuggestRequest([], GOAL)).toBe(null);
    expect(buildSuggestRequest([], GOAL, { clarify: false })).toBe(null);
  });

  it("诊断里带出歧义结论；没开 clarify 时是 null 而不是「不歧义」", async () => {
    const transport = vi.fn(async (body) => respond(body, {
      best: skill("s1").name,
      clarify: { ambiguous: 0.95, blocker: "output format" },
    }));
    const info = [];
    await suggestSkills([skill("s1")], GOAL, { transport, clarify: true, onResult: (i) => info.push(i) });
    expect(info[0].clarify).toMatchObject({ assessed: true, hint: true, blocker: "output format" });

    const off = [];
    await suggestSkills([skill("s1")], GOAL, { transport, onResult: (i) => off.push(i) });
    expect(off[0].clarify).toBe(null);
  });
});
