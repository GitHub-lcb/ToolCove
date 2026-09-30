// interviewProgress 的测试。
//
// 这一层的错最贵：存档归一化写错会让用户的进度凭空消失，间隔算错会让复习队列
// 要么永远空着、要么把同一道题天天推回来。所以时间一律显式传入，断言到天。
import { describe, expect, it } from "vitest";
import { normalizeBank } from "./interviewBank.js";
import {
  advanceSession,
  applyRating,
  createSave,
  dueQuestions,
  endSession,
  exportProgress,
  INTERVALS,
  isMastered,
  normalizeSave,
  progressStats,
  questionsByIds,
  rate,
  RATING_KEYS,
  recordOf,
  setNote,
  startSession,
  toggleStar,
} from "./interviewProgress.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);

const BANK = normalizeBank([
  { id: "backend-a", category: "backend", topic: "JVM", question: "q1", answer: "a", difficulty: 1 },
  { id: "backend-b", category: "backend", topic: "JVM", question: "q2", answer: "a", difficulty: 3 },
  { id: "algo-a", category: "algo", topic: "DP", question: "q3", answer: "a", difficulty: 2 },
  { id: "system-a", category: "system", topic: "缓存", question: "q4", answer: "a", difficulty: 2 },
]);

describe("createSave / normalizeSave", () => {
  it("空存档的形状是确定的", () => {
    expect(createSave()).toEqual({ version: 1, records: {}, starred: [], notes: {}, session: null });
  });

  it("容忍 null、字符串、缺字段的输入（存档是用户数据，宁可读出来也不要整份丢弃）", () => {
    expect(normalizeSave(null)).toEqual(createSave());
    expect(normalizeSave("nope")).toEqual(createSave());
    expect(normalizeSave({}).records).toEqual({});
  });

  it("丢弃非法的 rating，但保留这条记录（其余字段还有用）", () => {
    const save = normalizeSave({ records: { a: { rating: "nonsense", reviews: 2, mastery: 1 } } });
    expect(save.records.a.rating).toBe("");
    expect(save.records.a.reviews).toBe(2);
  });

  it("掌握度被夹到 0..3，计数不为负", () => {
    const save = normalizeSave({ records: { a: { mastery: 99, reviews: -5, streak: -1 } } });
    expect(save.records.a.mastery).toBe(3);
    expect(save.records.a.reviews).toBe(0);
    expect(save.records.a.streak).toBe(0);
  });

  it("非数字的 lastAt/dueAt 归零，不留下 NaN（NaN 会让所有比较失效）", () => {
    const save = normalizeSave({ records: { a: { lastAt: "x", dueAt: null } } });
    expect(save.records.a.lastAt).toBe(0);
    expect(save.records.a.dueAt).toBe(0);
  });

  it("starred 去重且只留非空字符串", () => {
    expect(normalizeSave({ starred: ["a", "a", "", null, "b"] }).starred).toEqual(["a", "b"]);
  });

  it("notes 丢掉空笔记，避免存档里全是空串", () => {
    expect(normalizeSave({ notes: { a: "有用", b: "   ", c: 42 } }).notes).toEqual({ a: "有用" });
  });

  it("session 保留 id 列表，index 被夹进范围；空列表视为没有会话", () => {
    expect(normalizeSave({ session: { ids: ["a", "b"], index: 99 } }).session.index).toBe(1);
    expect(normalizeSave({ session: { ids: ["a"], index: -3 } }).session.index).toBe(0);
    expect(normalizeSave({ session: { ids: [] } }).session).toBe(null);
    expect(normalizeSave({ session: { ids: "nope" } }).session).toBe(null);
  });

  it("归一化是幂等的（读两遍结果一样）", () => {
    const once = normalizeSave({ records: { a: { rating: "good", reviews: 1, mastery: 1 } }, starred: ["a"], notes: { a: "n" } });
    expect(normalizeSave(once)).toEqual(once);
  });
});

describe("recordOf", () => {
  it("没有记录时给一个零值记录，调用方不必判空", () => {
    expect(recordOf(createSave(), "missing")).toEqual({ rating: "", reviews: 0, streak: 0, lastAt: 0, dueAt: 0, mastery: 0 });
  });

  it("对 null 存档也安全", () => {
    expect(recordOf(null, "x").reviews).toBe(0);
  });
});

describe("applyRating：间隔重复的核心", () => {
  it("答对升一档，答错打回第一档", () => {
    let record = recordOf(createSave(), "x");
    record = applyRating(record, "good", NOW);
    expect(record.streak).toBe(1);
    expect(record.dueAt).toBe(NOW + INTERVALS[0] * HOUR);

    record = applyRating(record, "good", NOW);
    expect(record.streak).toBe(2);
    expect(record.dueAt).toBe(NOW + INTERVALS[1] * HOUR);

    record = applyRating(record, "again", NOW);
    expect(record.streak, "答错必须把连对清零").toBe(0);
    expect(record.dueAt).toBe(NOW + 3 * HOUR);
  });

  it("「模糊」不算答对：连对清零，但间隔比「不会」长", () => {
    let record = applyRating(recordOf(createSave(), "x"), "good", NOW);
    record = applyRating(record, "good", NOW);
    const fuzzy = applyRating(record, "fuzzy", NOW);
    const again = applyRating(record, "again", NOW);
    expect(fuzzy.streak).toBe(0);
    expect(fuzzy.dueAt).toBeGreaterThan(again.dueAt);
  });

  it("四档自评算出四种不同的间隔（档位退化会让自评形同虚设）", () => {
    const first = (key) => applyRating(recordOf(createSave(), "x"), key, NOW).dueAt;
    const hours = RATING_KEYS.map((key) => (first(key) - NOW) / HOUR);
    expect(hours, `again < fuzzy < good < easy 才算四档，实际 ${hours.join(", ")}`).toEqual([...hours].sort((a, b) => a - b));
    expect(new Set(hours).size, "有两档算出了同样的间隔").toBe(RATING_KEYS.length);
  });

  it("间隔永远夹在 [1 小时, 最长阶梯] 之间", () => {
    let record = recordOf(createSave(), "x");
    for (let i = 0; i < 10; i += 1) record = applyRating(record, "easy", NOW);
    const hours = (record.dueAt - NOW) / HOUR;
    expect(hours).toBeGreaterThanOrEqual(1);
    expect(hours).toBeLessThanOrEqual(INTERVALS[INTERVALS.length - 1]);
  });

  it("掌握度是连对次数的封顶映射（连对 2 次才算掌握）", () => {
    let record = recordOf(createSave(), "x");
    expect(record.mastery).toBe(0);
    record = applyRating(record, "good", NOW);
    expect(record.mastery).toBe(1);
    record = applyRating(record, "good", NOW);
    expect(record.mastery).toBe(2);
    record = applyRating(record, "easy", NOW);
    expect(record.mastery).toBe(3);
    record = applyRating(record, "easy", NOW);
    expect(record.mastery).toBe(3);
  });

  it("复习次数每次都加，不受对错影响", () => {
    let record = recordOf(createSave(), "x");
    record = applyRating(record, "again", NOW);
    record = applyRating(record, "again", NOW);
    expect(record.reviews).toBe(2);
  });

  it("非法档位原样返回，不改记录（界面传错不该污染存档）", () => {
    const record = applyRating(recordOf(createSave(), "x"), "nope", NOW);
    expect(record.reviews).toBe(0);
    expect(record.rating).toBe("");
  });

  it("RATINGS 的四个档位键就是 RATING_KEYS", () => {
    expect([...RATING_KEYS]).toEqual(["again", "fuzzy", "good", "easy"]);
  });
});

describe("rate / isMastered", () => {
  it("rate 返回新存档与新记录，不改原对象", () => {
    const before = createSave();
    const { save, record } = rate(before, "backend-a", "good", NOW);
    expect(before.records["backend-a"]).toBeUndefined();
    expect(save.records["backend-a"]).toEqual(record);
    expect(record.rating).toBe("good");
  });

  it("连续两次「会了」才算掌握", () => {
    let save = rate(createSave(), "backend-a", "good", NOW).save;
    expect(isMastered(save, "backend-a")).toBe(false);
    save = rate(save, "backend-a", "good", NOW).save;
    expect(isMastered(save, "backend-a")).toBe(true);
  });
});

describe("dueQuestions：复习队列", () => {
  const rated = (save, id, key, at) => rate(save, id, key, at).save;

  it("从没刷过的题不进复习队列（那叫没开始，不叫该复习）", () => {
    expect(dueQuestions(BANK, createSave(), NOW)).toEqual([]);
  });

  it("没到期的题不出现，到期后出现", () => {
    const save = rated(createSave(), "backend-a", "again", NOW); // 3 小时后到期
    expect(dueQuestions(BANK, save, NOW + HOUR)).toEqual([]);
    expect(dueQuestions(BANK, save, NOW + 4 * HOUR).map((item) => item.id)).toEqual(["backend-a"]);
  });

  it("三连对的题毕业，不再占用复习队列", () => {
    let save = createSave();
    for (let i = 0; i < 3; i += 1) save = rated(save, "backend-a", "easy", NOW);
    expect(recordOf(save, "backend-a").mastery).toBe(3);
    expect(dueQuestions(BANK, save, NOW + 100 * DAY)).toEqual([]);
  });

  it("同期到期时先补难度低的", () => {
    let save = createSave();
    save = rated(save, "backend-b", "again", NOW); // 难度 3
    save = rated(save, "backend-a", "again", NOW); // 难度 1
    const same = dueQuestions(BANK, save, NOW + DAY + 1);
    expect(same.map((item) => item.id), "难度低的排前面").toEqual(["backend-a", "backend-b"]);
  });

  it("逾期越久排越前（同一个难度下才看得出来）", () => {
    // 两道同难度（都是 2）的题，只把其中一道的到期时间往前挪
    let save = createSave();
    save = rated(save, "algo-a", "again", NOW);
    save = rated(save, "system-a", "again", NOW);
    const records = { ...save.records, "system-a": { ...save.records["system-a"], dueAt: NOW - 2 * DAY } };
    const order = dueQuestions(BANK, { ...save, records }, NOW + DAY + 1);
    expect(order.map((item) => item.id)).toEqual(["system-a", "algo-a"]);
  });
});

describe("progressStats", () => {
  it("空存档时数字全零，pct 为 0 而不是 NaN", () => {
    const stats = progressStats(BANK, createSave(), NOW);
    expect(stats).toMatchObject({ total: 4, seen: 0, mastered: 0, due: 0, starred: 0, pct: 0 });
  });

  it("总数为 0 时 pct 也是 0（不能除零）", () => {
    expect(progressStats([], createSave(), NOW).pct).toBe(0);
  });

  it("见过但没掌握不计入覆盖率（否则数字虚高）", () => {
    const save = rate(createSave(), "backend-a", "good", NOW).save;
    const stats = progressStats(BANK, save, NOW);
    expect(stats.seen).toBe(1);
    expect(stats.mastered).toBe(0);
    expect(stats.pct).toBe(0);
  });

  it("掌握后按方向分别统计", () => {
    let save = createSave();
    save = rate(save, "backend-a", "good", NOW).save;
    save = rate(save, "backend-a", "good", NOW).save;
    save = rate(save, "algo-a", "good", NOW).save;
    const stats = progressStats(BANK, save, NOW);
    expect(stats.mastered).toBe(1);
    expect(stats.seen).toBe(2);
    expect(stats.pct).toBe(25);
    expect(stats.byCategory.backend).toEqual({ total: 2, mastered: 1, seen: 1 });
    expect(stats.byCategory.algo).toEqual({ total: 1, mastered: 0, seen: 1 });
    expect(stats.byCategory.system).toEqual({ total: 1, mastered: 0, seen: 0 });
  });
});

describe("收藏与笔记", () => {
  it("toggleStar 来回切换，且不改原存档", () => {
    const before = createSave();
    const on = toggleStar(before, "a");
    expect(before.starred).toEqual([]);
    expect(on.starred).toEqual(["a"]);
    expect(toggleStar(on, "a").starred).toEqual([]);
  });

  it("setNote 空串等于删除，不留空条目", () => {
    const save = setNote(createSave(), "a", "记一笔");
    expect(save.notes).toEqual({ a: "记一笔" });
    expect(setNote(save, "a", "   ").notes).toEqual({});
    expect(setNote(save, "a", null).notes).toEqual({});
  });
});

describe("模拟面试会话", () => {
  it("startSession 存下 id 列表并把指针归零", () => {
    const save = startSession(createSave(), ["a", "b"], NOW);
    expect(save.session).toEqual({ ids: ["a", "b"], index: 0, startedAt: NOW });
  });

  it("advanceSession 走到末尾就报 done，且 index 停在界外不再越界增长", () => {
    let save = startSession(createSave(), ["a", "b"], NOW);
    let step = advanceSession(save);
    expect(step.done).toBe(false);
    expect(step.save.session.index).toBe(1);
    step = advanceSession(step.save);
    expect(step.done).toBe(true);
    expect(step.save.session.index).toBe(2);
    expect(advanceSession(step.save).save.session.index, "已经结束就不要再往后加").toBe(2);
  });

  it("没有会话时 advanceSession 直接报 done，不抛错", () => {
    const step = advanceSession(createSave());
    expect(step.done).toBe(true);
  });

  it("endSession 清掉会话", () => {
    expect(endSession(startSession(createSave(), ["a"], NOW)).session).toBe(null);
  });

  it("questionsByIds 跳过已从题库消失的 id（导入题被删就会这样）", () => {
    expect(questionsByIds(BANK, ["backend-a", "gone", "algo-a"]).map((item) => item.id)).toEqual(["backend-a", "algo-a"]);
    expect(questionsByIds(BANK, [])).toEqual([]);
  });
});

describe("exportProgress", () => {
  it("导出的是可读文本，含总数与已掌握，且列出刷过的题", () => {
    let save = rate(createSave(), "backend-a", "good", NOW).save;
    save = rate(save, "backend-a", "good", NOW).save;
    const text = exportProgress(BANK, save, NOW);
    expect(text).toContain("2026-01-15");
    expect(text).toContain("题库总数：4");
    expect(text).toContain("已掌握：1");
    expect(text).toContain("backend · 1/2");
    expect(text).toContain("q1");
    expect(text, "没刷过的题不该出现在导出里").not.toContain("q3");
  });

  it("空存档也能导出，不抛错", () => {
    expect(exportProgress(BANK, createSave(), NOW)).toContain("已掌握：0");
  });
});
