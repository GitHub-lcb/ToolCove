import { describe, expect, it } from "vitest";
import {
  SKILL_MATCH_LIMIT,
  SKILL_MIN_SCORE,
  SKILL_PROMPT_BUDGET,
  buildInstructions,
  extractSkill,
  keywordsOf,
  matchSkills,
  scoreSkill,
  skillDescriptionOf,
  skillNameOf,
  skillsPromptSection,
  toolNamesOf,
  validateSkill,
} from "./skills.js";

const run = (overrides = {}) => ({
  id: "run-1",
  input: "读取 order.json，找出重复字段并导出 CSV",
  status: "success",
  history: [
    { action: { type: "tool_call", tool: "file.read_text", args: { path: "order.json", encoding: "UTF-8" } }, result: { text: "{}" } },
    { action: { type: "tool_call", tool: "json.parse", args: { text: "{}" } }, result: { rows: [1, 2, 3] } },
  ],
  ...overrides,
});

describe("toolNamesOf / skillNameOf / skillDescriptionOf", () => {
  it("工具名去重保序", () => {
    const names = toolNamesOf(run({ history: [
      { action: { type: "tool_call", tool: "a" } },
      { action: { type: "tool_call", tool: "b" } },
      { action: { type: "tool_call", tool: "a" } },
      { action: { type: "final" } },
    ] }));
    expect(names).toEqual(["a", "b"]);
  });

  it("名称取目标首行并截断，空目标给空串", () => {
    expect(skillNameOf("第一行\n第二行")).toBe("第一行");
    expect(skillNameOf("x".repeat(60))).toHaveLength(40);
    expect(skillNameOf("   ")).toBe("");
  });

  it("描述带工具链，长链折叠成 …(+n)", () => {
    const names = ["a", "b", "c", "d", "e", "f"].map((tool) => ({ action: { type: "tool_call", tool } }));
    const desc = skillDescriptionOf(run({ history: names }));
    expect(desc).toContain("a → b → c → d");
    expect(desc).toContain("(+2)");
    expect(skillDescriptionOf(run({ history: [] }))).toBe("");
  });
});

describe("keywordsOf", () => {
  it("抽拉丁词与中文二元组，去掉停用词", () => {
    const words = keywordsOf("把 order.json 里的重复字段导出成 CSV");
    expect(words).toContain("order.json");
    expect(words).toContain("csv");
    expect(words).toContain("重复");
    // 停用词不进关键词（否则任何目标都能命中任何技能）
    expect(words).not.toContain("的");
    expect(words).not.toContain("把");
  });

  it("去重、限量、容忍空输入", () => {
    expect(keywordsOf("json json json")).toEqual(["json"]);
    expect(keywordsOf("x".repeat(200)).length).toBeLessThanOrEqual(12);
    expect(keywordsOf("")).toEqual([]);
    expect(keywordsOf(null)).toEqual([]);
  });
});

describe("buildInstructions", () => {
  it("正文含目标、工具链、参数与收尾纪律（提醒不要照抄上次的参数）", () => {
    const body = buildInstructions(run());
    expect(body).toContain("目标：读取 order.json");
    expect(body).toContain("- file.read_text（参数：path, encoding）");
    expect(body).toContain("用到的工具：file.read_text, json.parse");
    expect(body).toContain("参数要重新核对");
  });

  it("失败步骤写进正文（失败也是经验）", () => {
    const body = buildInstructions(run({ history: [{ action: { type: "tool_call", tool: "file.read_text" }, error: "文件不存在" }] }));
    expect(body).toContain("失败：文件不存在");
  });

  it("超长正文被截断在上限内", () => {
    const history = Array.from({ length: 60 }, (_, i) => ({
      action: { type: "tool_call", tool: `tool${i}`, args: { text: "x".repeat(300) } },
      result: "y".repeat(300),
    }));
    expect(buildInstructions(run({ input: "z".repeat(400), history })).length).toBeLessThanOrEqual(8000);
  });
});

describe("extractSkill", () => {
  it("成功运行能沉淀出完整技能", () => {
    const skill = extractSkill(run(), { id: "skill-fixed", now: 1700000000000 });
    expect(skill).toMatchObject({ id: "skill-fixed", createdAt: 1700000000000, sourceRunId: "run-1" });
    expect(skill.name).toContain("order.json");
    expect(skill.description).toContain("file.read_text");
    expect(skill.toolNames).toEqual(["file.read_text", "json.parse"]);
    expect(skill.instructions.length).toBeGreaterThan(40);
  });

  it("失败/取消/无工具调用的运行不沉淀（拒绝也是一种能力）", () => {
    expect(extractSkill(run({ status: "failed" }))).toBe(null);
    expect(extractSkill(run({ status: "cancelled" }))).toBe(null);
    expect(extractSkill(run({ history: [{ action: { type: "final", answer: "x" } }] }))).toBe(null);
    expect(extractSkill(null)).toBe(null);
  });

  it("目标过短不沉淀（避免把一次随手问答变成经验）", () => {
    expect(extractSkill(run({ input: "hi" }))).toBe(null);
  });

  it("默认 id 唯一", () => {
    expect(extractSkill(run()).id).not.toBe(extractSkill(run()).id);
  });
});

describe("scoreSkill / matchSkills", () => {
  const skill = extractSkill(run(), { id: "s1", now: 1000 });

  it("关键词命中加分，工具名短名也算弱证据", () => {
    expect(scoreSkill(skill, "帮我读取 order.json 并导出 csv")).toBeGreaterThanOrEqual(SKILL_MIN_SCORE);
    expect(scoreSkill(skill, "read_text 一下")).toBeGreaterThan(0);
    expect(scoreSkill(skill, "今天天气怎么样")).toBe(0);
    expect(scoreSkill(skill, "")).toBe(0);
  });

  it("低于阈值的技能不注入（乱带比不带更糟）", () => {
    expect(matchSkills([skill], "今天天气怎么样")).toEqual([]);
    expect(matchSkills([skill], "读取 order.json 导出 csv")).toHaveLength(1);
  });

  it("关掉的技能一定不注入", () => {
    const matches = matchSkills([skill], "读取 order.json 导出 csv", { disabled: ["s1"] });
    expect(matches).toEqual([]);
  });

  it("按分数排序并限制条数", () => {
    const skills = Array.from({ length: 6 }, (_, i) => extractSkill(run({ id: `r${i}` }), { id: `s${i}`, now: 1000 + i }));
    const matches = matchSkills(skills, "读取 order.json 找出重复字段并导出 csv");
    expect(matches.length).toBeLessThanOrEqual(SKILL_MATCH_LIMIT);
    expect(matches[0].score).toBeGreaterThanOrEqual(matches[1].score);
  });

  it("坏输入不抛错", () => {
    expect(matchSkills(null, "x")).toEqual([]);
    expect(matchSkills([null, 7, "x"], "x")).toEqual([]);
    expect(matchSkills([skill], "读取 order.json 导出 csv", { limit: 0 })).toHaveLength(1);
  });
});

describe("skillsPromptSection", () => {
  const skill = extractSkill(run(), { id: "s1", now: 1000 });

  it("没有命中就不占 prompt", () => {
    expect(skillsPromptSection([])).toBe("");
    expect(skillsPromptSection(null)).toBe("");
  });

  it("命中时带名称、正文与「仅供参考」的纪律", () => {
    const section = skillsPromptSection([{ skill, score: 9 }]);
    expect(section).toContain("【技能】");
    expect(section).toContain(skill.name);
    expect(section).toContain("参数必须重新核对");
  });

  it("预算放不下就整条不注入，而不是注入半条", () => {
    const section = skillsPromptSection([{ skill, score: 9 }], { budget: 50 });
    expect(section).toBe("");
    const wide = skillsPromptSection([{ skill, score: 9 }], { budget: SKILL_PROMPT_BUDGET });
    expect(wide).toContain("【技能】");
  });
});

describe("validateSkill（落盘边界）", () => {
  it("补默认值、截断超长字段、丢弃坏数据", () => {
    const clean = validateSkill({ name: "  x  ", instructions: "i".repeat(100), keywords: ["a", "", 7], toolNames: ["t", null] });
    expect(clean.name).toBe("x");
    expect(clean.keywords).toEqual(["a"]); // 数字项被归一成空串后丢弃
    expect(clean.toolNames).toEqual(["t"]);
    expect(typeof clean.id).toBe("string");
    expect(typeof clean.createdAt).toBe("number");
  });

  it("没名字或正文太短的直接拒绝（技能库不是日志）", () => {
    expect(validateSkill({ name: "", instructions: "long enough to pass the length gate ......" })).toBe(null);
    expect(validateSkill({ name: "x", instructions: "too short" })).toBe(null);
    expect(validateSkill(null)).toBe(null);
    expect(validateSkill("x")).toBe(null);
  });

  it("超过单条上限的正文被截断（不整条丢弃，保住可用部分）", () => {
    const clean = validateSkill({ name: "big", instructions: "z".repeat(20000) });
    expect(clean).not.toBe(null);
    // 截断留了元信息余量，所以正文略小于整体预算
    expect(clean.instructions.length).toBeLessThanOrEqual(8000);
    expect(clean.instructions.length).toBeGreaterThan(7000);
  });

  it("整条体量仍在预算内（截断后不该反而超上限）", () => {
    const clean = validateSkill({
      name: "n".repeat(200),
      description: "d".repeat(500),
      instructions: "z".repeat(20000),
      keywords: Array.from({ length: 50 }, (_, i) => `keyword-${i}-${"k".repeat(40)}`),
      toolNames: Array.from({ length: 30 }, (_, i) => `tool.name.${i}`),
    });
    expect(clean).not.toBe(null);
    expect(JSON.stringify(clean).length).toBeLessThanOrEqual(8000 + 2);
  });
});
