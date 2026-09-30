// 面试刷题 · 进度与复习（纯逻辑，桌面端与手机端共用一份）。
//
// 刷题的闭环不是「看过」，而是「隔几天还能答上来」。所以存档里每题存三样东西：
//   · 最近一次自评（会不会）· 复习次数 · 下次该复习的时间。
// 掌握度与下次复习时间都由**自评历史算出来**，而不是让用户自己填——
// 用户只需要回答一个问题「这题你会不会」，其余全是本模块的推论。
//
// 间隔按「答对就拉长、答错就打回」走（1 → 3 → 7 → 15 → 30 天）。这是最朴素的
// 间隔重复，故意不引入更复杂的调度：刷题工具的价值在题目质量，不在算法花哨。
//
// 时间一律从参数传入（now），不读时钟——否则这个模块没法测，也没法在手机上对齐。

import { CATEGORY_KEYS } from "./interviewBank.js";

/** 自评档位。confident 用于算掌握度，factor 是下次间隔相对基准的缩放。 */
export const RATINGS = Object.freeze([
  { key: "again", labelKey: "toolbox.interview.rating.again", confident: false, factor: 0.25 },
  // fuzzy 的系数必须让「模糊」与「不会」落进不同档位：两者 factor 都是 0.5 时，
  // 连对为零的题算出来都是 1 天，四档自评等于只剩三档（测试抓到的）。
  { key: "fuzzy", labelKey: "toolbox.interview.rating.fuzzy", confident: false, factor: 0.75 },
  { key: "good", labelKey: "toolbox.interview.rating.good", confident: true, factor: 1 },
  { key: "easy", labelKey: "toolbox.interview.rating.easy", confident: true, factor: 1.6 },
]);

export const RATING_KEYS = Object.freeze(RATINGS.map((item) => item.key));

/**
 * 复习间隔阶梯（小时）。
 *
 * 为什么用小时而不是天：四档自评的系数（0.25 / 0.75 / 1 / 1.6）乘在「1 天」上会被取整抹平——
 * 0.25 天与 0.75 天都变成 1 天，「不会」和「模糊」算出同一个到期时间（测试抓到的）。
 * 用小时做基准，第一档 12 小时就能让四档落在 1 / 1 / 3 / 5 天四个不同位置上。
 */
export const INTERVALS = Object.freeze([12, 72, 168, 360, 720]);

const HOUR_MS = 60 * 60 * 1000;
const RATING_BY_KEY = new Map(RATINGS.map((item) => [item.key, item]));

/** 一个全新的空存档。 */
export function createSave() {
  return { version: 1, records: {}, starred: [], notes: {}, session: null };
}

/** 记录条目：一次都没刷过的题没有条目（不用空对象占位，存档才小）。 */
function emptyRecord() {
  return { rating: "", reviews: 0, streak: 0, lastAt: 0, dueAt: 0, mastery: 0 };
}

function num(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 归一化存档：容忍旧版本、缺字段、类型错乱的输入。
 * 存档是**用户数据**，宁可能读出来就继续用，也不要因为一条脏数据整份丢弃。
 */
export function normalizeSave(raw) {
  const save = createSave();
  if (!raw || typeof raw !== "object") return save;
  const records = raw.records && typeof raw.records === "object" ? raw.records : {};
  for (const [id, value] of Object.entries(records)) {
    if (!id || !value || typeof value !== "object") continue;
    const rating = RATING_BY_KEY.has(value.rating) ? value.rating : "";
    save.records[id] = {
      rating,
      reviews: Math.max(0, Math.round(num(value.reviews))),
      streak: Math.max(0, Math.round(num(value.streak))),
      lastAt: Math.max(0, num(value.lastAt)),
      dueAt: Math.max(0, num(value.dueAt)),
      mastery: Math.max(0, Math.min(3, Math.round(num(value.mastery)))),
    };
  }
  if (Array.isArray(raw.starred)) save.starred = [...new Set(raw.starred.filter((id) => typeof id === "string" && id))];
  const notes = raw.notes && typeof raw.notes === "object" ? raw.notes : {};
  for (const [id, value] of Object.entries(notes)) {
    if (id && typeof value === "string" && value.trim()) save.notes[id] = value;
  }
  if (raw.session && typeof raw.session === "object" && Array.isArray(raw.session.ids)) {
    const ids = raw.session.ids.filter((id) => typeof id === "string" && id);
    if (ids.length) {
      save.session = { ids, index: Math.max(0, Math.min(ids.length - 1, Math.round(num(raw.session.index)))), startedAt: Math.max(0, num(raw.session.startedAt)) };
    }
  }
  return save;
}

/** 某题的记录（没有就返回一个只读的空记录，调用方不必到处判空）。 */
export function recordOf(save, id) {
  return save?.records?.[id] ?? emptyRecord();
}

/** 自评一次之后该题的新记录。 */
export function applyRating(record, ratingKey, now = Date.now()) {
  const rating = RATING_BY_KEY.get(ratingKey);
  if (!rating) return { ...emptyRecord(), ...record };
  const streak = rating.confident ? record.streak + 1 : 0;
  // 连对 1 次取阶梯第 1 档（streak - 1）：用 INTERVALS[streak] 会跳过第一档，
  // 第一次答对就跳到 3 天后（测试抓到的越档）。
  const step = INTERVALS[Math.max(0, Math.min(streak - 1, INTERVALS.length - 1))];
  // 间隔 = 阶梯小时 × 档位系数，四舍五入到整小时，再夹到 [1 小时, 最长阶梯]。
  // 夹下限是为了「不会」也得等一会儿再来，而不是立刻重新出现。
  const hours = Math.max(1, Math.min(INTERVALS[INTERVALS.length - 1], Math.round(step * rating.factor)));
  return {
    rating: ratingKey,
    reviews: record.reviews + 1,
    streak,
    lastAt: now,
    dueAt: now + hours * HOUR_MS,
    // 掌握度是「连对次数」的封顶映射：连对 0 次=0，1 次=1，2 次=2，3 次及以上=3
    mastery: Math.min(3, streak),
  };
}

/** 该题是否已掌握：连续答对两次以上（一次可能是蒙的）。 */
export function isMastered(save, id) {
  return recordOf(save, id).mastery >= 2;
}

/**
 * 今日复习队列：到期（dueAt <= now）且没掌握的题，最该复习的排前面。
 * 排序口径：先按逾期天数降序，再按难度升序（先补基础）。
 */
export function dueQuestions(questions, save, now = Date.now()) {
  const due = questions.filter((question) => {
    const record = recordOf(save, question.id);
    if (!record.reviews) return false; // 从没刷过的不叫「该复习」，叫「没开始」
    if (record.mastery >= 3) return false; // 三连对就毕业，不再占用复习队列
    return record.dueAt > 0 && record.dueAt <= now;
  });
  return due.sort((a, b) => {
    const overdueA = now - recordOf(save, a.id).dueAt;
    const overdueB = now - recordOf(save, b.id).dueAt;
    if (overdueB !== overdueA) return overdueB - overdueA;
    return a.difficulty - b.difficulty;
  });
}

/**
 * 整库统计。界面顶部、进度条与「还差多少」都用它。
 * 口径写死在这里，避免桌面端与手机端各算一套导致数字对不上。
 */
export function progressStats(questions, save, now = Date.now()) {
  const byCategory = Object.fromEntries(CATEGORY_KEYS.map((key) => [key, { total: 0, mastered: 0, seen: 0 }]));
  let mastered = 0;
  let seen = 0;
  for (const question of questions) {
    const record = recordOf(save, question.id);
    const bucket = byCategory[question.category];
    if (bucket) bucket.total += 1;
    if (record.reviews > 0) {
      seen += 1;
      if (bucket) bucket.seen += 1;
    }
    if (record.mastery >= 2) {
      mastered += 1;
      if (bucket) bucket.mastered += 1;
    }
  }
  const total = questions.length;
  return {
    total,
    seen,
    mastered,
    due: dueQuestions(questions, save, now).length,
    starred: save?.starred?.length ?? 0,
    // 覆盖率按「已掌握 / 总数」算：见过但没掌握的不算进度，否则数字会虚高。
    // 保留一位小数：题库有 300+ 道，取整会让「掌握 1 道」显示成 0%——用户刚刷完一道就看到 0%，
    // 会以为没生效（E2E 抓到的）。只有真正为 0 时才显示 0。
    pct: total ? Math.round((mastered / total) * 1000) / 10 : 0,
    byCategory,
  };
}

/** 切换收藏，返回新的存档（不改原对象，便于 Vue 侦听与撤销）。 */
export function toggleStar(save, id) {
  const starred = new Set(save.starred);
  if (starred.has(id)) starred.delete(id);
  else starred.add(id);
  return { ...save, starred: [...starred] };
}

/** 写/清笔记：空串等于删除，不留空条目。 */
export function setNote(save, id, value) {
  const notes = { ...save.notes };
  const trimmed = typeof value === "string" ? value : "";
  if (trimmed.trim()) notes[id] = trimmed;
  else delete notes[id];
  return { ...save, notes };
}

/** 记一次自评，返回 { save, record }：record 供界面立刻回显掌握度变化。 */
export function rate(save, id, ratingKey, now = Date.now()) {
  const record = applyRating(recordOf(save, id), ratingKey, now);
  return { save: { ...save, records: { ...save.records, [id]: record } }, record };
}

/** 开始一套模拟面试：ids 由调用方（buildSession）算好，这里只管存。 */
export function startSession(save, ids, now = Date.now()) {
  return { ...save, session: { ids: [...ids], index: 0, startedAt: now } };
}

export function endSession(save) {
  return { ...save, session: null };
}

/**
 * 模拟面试的推进：答完一题就前进一格，越界即结束。
 * 返回 done 让界面决定「下一题」按钮变成「看结果」还是消失。
 */
export function advanceSession(save) {
  if (!save.session) return { save, done: true };
  const next = save.session.index + 1;
  if (next >= save.session.ids.length) return { save: { ...save, session: { ...save.session, index: save.session.ids.length } }, done: true };
  return { save: { ...save, session: { ...save.session, index: next } }, done: false };
}

/** 把存档里的 id 还原成题目对象，跳过已从题库消失的 id（导入题被删就会这样）。 */
export function questionsByIds(questions, ids) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** 导出进度为可读文本（供「导出记录」按钮，也便于用户自己备份）。 */
export function exportProgress(questions, save, now = Date.now()) {
  const stats = progressStats(questions, save, now);
  const lines = [
    `# 面试刷题进度（${new Date(now).toISOString().slice(0, 10)}）`,
    "",
    `- 题库总数：${stats.total}`,
    `- 已掌握：${stats.mastered}（${stats.pct}%）`,
    `- 已练过：${stats.seen}`,
    `- 待复习：${stats.due}`,
    `- 收藏：${stats.starred}`,
    "",
  ];
  for (const category of CATEGORY_KEYS) {
    const bucket = stats.byCategory[category];
    lines.push(`## ${category} · ${bucket.mastered}/${bucket.total}`);
    for (const question of questions.filter((item) => item.category === category)) {
      const record = recordOf(save, question.id);
      if (!record.reviews) continue;
      const mark = record.mastery >= 2 ? "已掌握" : "待巩固";
      lines.push(`- [${mark}] ${question.question}（复习 ${record.reviews} 次，掌握度 ${record.mastery}/3）`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
