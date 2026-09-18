import { describe, expect, it, vi } from "vitest";

// skillStore 通过 toolboxStore 落盘；这里 mock 掉存储层，只测「库」本身的行为。
vi.mock("../toolboxStore.js", () => ({
  loadToolbox: vi.fn(async () => []),
  saveToolbox: vi.fn(async () => ({ ok: true })),
}));

import { loadToolbox, saveToolbox } from "../toolboxStore.js";
import { SKILLS_KEY, loadSkills, normalizeSkillList, removeSkill, saveSkills, upsertSkill } from "./skillStore.js";

const skill = (over = {}) => ({
  id: "s1",
  name: "读取 order.json 导出 csv",
  description: "读取 order.json｜file.read_text → json.parse",
  instructions: "目标：读取 order.json，找出重复字段并导出 CSV\n- file.read_text → 1 项",
  keywords: ["order.json", "csv"],
  toolNames: ["file.read_text", "json.parse"],
  sourceRunId: "run-1",
  createdAt: 1000,
  ...over,
});

describe("normalizeSkillList", () => {
  it("过滤坏数据、按时间倒序、去重（同 id 只留最新的那一条）", () => {
    const list = normalizeSkillList([
      skill({ id: "a", createdAt: 100 }),
      skill({ id: "b", createdAt: 300 }),
      skill({ id: "a", createdAt: 200, name: "重复 id" }),
      null,
      "x",
      { id: "c", name: "", instructions: "太短" },
    ]);
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
    expect(list[1].createdAt).toBe(200); // 保留的是先出现（排序后更靠前）的那条
  });

  it("超过条数上限时按时间截断", () => {
    const many = Array.from({ length: 60 }, (_, i) => skill({ id: `s${i}`, createdAt: i }));
    expect(normalizeSkillList(many)).toHaveLength(50);
    expect(normalizeSkillList(many)[0].id).toBe("s59");
  });

  it("非数组给空数组", () => {
    expect(normalizeSkillList(null)).toEqual([]);
    expect(normalizeSkillList("x")).toEqual([]);
  });
});

describe("upsertSkill", () => {
  it("新技能插到最前", () => {
    const result = upsertSkill([skill({ id: "old", name: "别的目标", createdAt: 1 })], skill({ id: "new", createdAt: 5000 }));
    expect(result.updated).toBe(false);
    expect(result.list[0].id).toBe("new");
    expect(result.list).toHaveLength(2);
  });

  it("同名技能视为同一条：更新而不是堆叠（保留原 id 与创建时间）", () => {
    const first = skill({ id: "keep", createdAt: 100, instructions: "目标：读取 order.json\n- 老的一步 说明说明说明说明" });
    const second = skill({ id: "other", createdAt: 900, instructions: "目标：读取 order.json\n- 新的一步 说明说明说明说明" });
    const result = upsertSkill([first], second);
    expect(result.updated).toBe(true);
    expect(result.list).toHaveLength(1);
    expect(result.skill.id).toBe("keep");
    expect(result.skill.createdAt).toBe(100);
    expect(result.skill.instructions).toContain("新的一步");
  });

  it("体检不过的直接拒绝", () => {
    expect(upsertSkill([], { name: "x", instructions: "短" })).toBe(null);
    expect(upsertSkill([], null)).toBe(null);
  });
});

describe("removeSkill", () => {
  it("按 id 删除并保持归一", () => {
    const list = [skill({ id: "a", createdAt: 1 }), skill({ id: "b", createdAt: 2 })];
    const next = removeSkill(list, "a");
    expect(next.map((s) => s.id)).toEqual(["b"]);
    expect(removeSkill(list, "nope")).toHaveLength(2);
    expect(removeSkill(null, "a")).toEqual([]);
  });
});

describe("loadSkills / saveSkills", () => {
  it("读取时归一（脏数据不进内存）", async () => {
    loadToolbox.mockResolvedValueOnce([skill(), { bad: true }]);
    const list = await loadSkills();
    expect(loadToolbox).toHaveBeenCalledWith(SKILLS_KEY, []);
    expect(list).toHaveLength(1);
  });

  it("保存时先归一（脏数据不落盘）", async () => {
    saveToolbox.mockClear();
    const saved = await saveSkills([skill(), "垃圾"]);
    expect(saved).toHaveLength(1);
    expect(saveToolbox).toHaveBeenCalledWith(SKILLS_KEY, expect.any(Array));
    expect(saveToolbox.mock.calls[0][1]).toHaveLength(1);
  });
});
