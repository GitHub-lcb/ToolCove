// 面试刷题 · 题库契约与检索。
//
// 这一层只做三件事：**定义一道题长什么样**、**把题目来源拼成可点开的链接**、
// **按关键词/方向/难度/掌握度筛出要刷的那批**。它不碰界面，也不碰存档。
//
// 为什么题库要自带出处：题目和题解的价值一半在内容、一半在「能顺着往下读」。
// 所以每道题都挂 `sources`（仓库键 + 仓库内相对路径），由 SOURCES 统一拼成 URL。
// 仓库键是白名单——题库里写错一个键，interviewBank.test.js 会直接红，
// 而不是等用户点开一个 404。star 数是**采集当时的实测值**，用来标注权威度，不参与逻辑。
//
// 题目正文（question/answer/points/follow）只写中文，且**不进 i18n 字典**：
// 它是内容数据不是界面文案，界面外壳才是双语的。这条边界让题库可以整包替换/导入。

// 内置题库在 interviewBankParts.js 里总装（每个方向/子领域一个文件），这里只做转发，
// 让「题库契约」与「题库内容」各占一个文件：界面与测试都从本模块取，不必知道内容是怎么拆的。
export { BUILTIN_QUESTIONS, TOPICS, TOPIC_KEYS } from "./interviewBankParts.js";

/**
 * 题目来源仓库白名单。
 * url 是给人点开的；stars 是采集时的实测值（GitHub API），只作展示与排序依据。
 */
export const SOURCES = Object.freeze({
  JavaGuide: { repo: "Snailclimb/JavaGuide", url: "https://github.com/Snailclimb/JavaGuide", stars: 158917, license: "Apache-2.0" },
  "advanced-java": { repo: "doocs/advanced-java", url: "https://github.com/doocs/advanced-java", stars: 79126, license: "CC-BY-SA-4.0" },
  "CS-Notes": { repo: "CyC2018/CS-Notes", url: "https://github.com/CyC2018/CS-Notes", stars: 186327, license: "" },
  athena: { repo: "ZhongFuCheng3y/athena", url: "https://github.com/ZhongFuCheng3y/athena", stars: 18959, license: "Apache-2.0" },
  bestJavaer: { repo: "crisxuan/bestJavaer", url: "https://github.com/crisxuan/bestJavaer", stars: 6622, license: "CC-BY-SA-4.0" },
  "leetcode-master": { repo: "youngyangyang04/leetcode-master", url: "https://github.com/youngyangyang04/leetcode-master", stars: 62577, license: "" },
  "hello-algo": { repo: "krahets/hello-algo", url: "https://github.com/krahets/hello-algo", stars: 130509, license: "" },
  "fucking-algorithm": { repo: "labuladong/fucking-algorithm", url: "https://github.com/labuladong/fucking-algorithm", stars: 136041, license: "" },
  "azl397985856-leetcode": { repo: "azl397985856/leetcode", url: "https://github.com/azl397985856/leetcode", stars: 55733, license: "" },
  "system-design-primer": { repo: "donnemartin/system-design-primer", url: "https://github.com/donnemartin/system-design-primer", stars: 372191, license: "" },
  "tech-interview-handbook": { repo: "yangshun/tech-interview-handbook", url: "https://github.com/yangshun/tech-interview-handbook", stars: 142984, license: "MIT" },
  "web-interview": { repo: "febobo/web-interview", url: "https://github.com/febobo/web-interview", stars: 11873, license: "" },
  "FE-Interview": { repo: "lgwebdream/FE-Interview", url: "https://github.com/lgwebdream/FE-Interview", stars: 7202, license: "" },
  "developer-roadmap": { repo: "kamranahmedse/developer-roadmap", url: "https://github.com/kamranahmedse/developer-roadmap", stars: 368334, license: "" },
});

/** 四个方向。key 与题目 category 同名，labelKey 指向界面文案。 */
export const CATEGORIES = Object.freeze([
  { key: "backend", labelKey: "toolbox.interview.category.backend", icon: "database" },
  { key: "algo", labelKey: "toolbox.interview.category.algo", icon: "activity" },
  { key: "system", labelKey: "toolbox.interview.category.system", icon: "network" },
  { key: "frontend", labelKey: "toolbox.interview.category.frontend", icon: "text" },
]);

export const CATEGORY_KEYS = Object.freeze(CATEGORIES.map((item) => item.key));

/** 难度：1 基础 / 2 进阶 / 3 深水区。labelKey 同上，指向界面文案。 */
export const DIFFICULTIES = Object.freeze([
  { level: 1, labelKey: "toolbox.interview.difficulty.1" },
  { level: 2, labelKey: "toolbox.interview.difficulty.2" },
  { level: 3, labelKey: "toolbox.interview.difficulty.3" },
]);

/** 题库规模上限：导入是用户可控输入，不设上限会让一次误导入把界面卡死。 */
export const MAX_QUESTIONS = 4000;

const CATEGORY_SET = new Set(CATEGORY_KEYS);
const DIFFICULTY_SET = new Set(DIFFICULTIES.map((item) => item.level));

/** 归一化一段可能缺失的文本：非字符串一律当空串，避免下游到处判空。 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 归一化字符串数组：去空、去重、保持原顺序。 */
function list(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const value2 = text(item);
    if (value2 && !out.includes(value2)) out.push(value2);
  }
  return out;
}

/**
 * 把一条原始题目归一化成内部形状。
 * 返回 null 表示这条不能用（缺 id / 缺题干 / 方向非法）——调用方负责丢弃并计数。
 */
export function normalizeQuestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id);
  const question = text(raw.question);
  const category = text(raw.category);
  if (!id || !question || !CATEGORY_SET.has(category)) return null;
  const difficulty = DIFFICULTY_SET.has(raw.difficulty) ? raw.difficulty : 2;
  return {
    id,
    category,
    topic: text(raw.topic) || category,
    difficulty,
    tags: list(raw.tags),
    question,
    answer: text(raw.answer),
    points: list(raw.points),
    follow: text(raw.follow),
    sources: normalizeSources(raw.sources),
    // custom 标记导入题：界面上要能一眼区分「自带」与「我导的」，导出/清理也按它来
    custom: raw.custom === true,
  };
}

/**
 * 归一化来源列表。
 *
 * 白名单（SOURCES）只约束**内置题库**——它保证每道内置题的出处都经过核对、能拼出可点开的链接。
 * 但导入题库（含 scripts/build-interview-bank.mjs 的抓取产物）会引用白名单之外的仓库，
 * 这时**必须原样保留**：出处是署名，署名不能因为「我们没登记过这个仓库」就被悄悄丢掉。
 * 所以这里只做去重与清洗，能不能拼成链接交给 sourceLinks 判断（未登记就只显示名字、不给链接）。
 */
export function normalizeSources(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const repo = text(item?.repo);
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    out.push({ repo, path: text(item?.path) });
  }
  return out;
}

/** 归一化整个题库：丢弃非法条目、按 id 去重（先到先得）。 */
export function normalizeBank(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of rawList.slice(0, MAX_QUESTIONS)) {
    const item = normalizeQuestion(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * 一道题的来源，供界面渲染。
 *
 * 分两种：白名单内的给可点开的深链（url 非空）；白名单外的（导入/抓取产物）只给名字与路径，
 * url 为空——界面据此渲染成不可点的署名行。**两种都要显示**，出处不能被吞掉。
 */
export function sourceLinks(question) {
  return (question?.sources ?? [])
    .filter((item) => item && item.repo)
    .map((item) => {
      const meta = SOURCES[item.repo];
      if (!meta) return { repo: item.repo, name: item.repo, stars: 0, license: "", path: item.path, url: "" };
      // path 为空时给仓库首页；否则拼到 /blob/HEAD/ 上，HEAD 让链接永远跟着默认分支走
      const url = item.path ? `${meta.url}/blob/HEAD/${item.path}` : meta.url;
      return { repo: item.repo, name: meta.repo, stars: meta.stars, license: meta.license, path: item.path, url };
    });
}

/** 合并内置题库与导入题库：同 id 时导入题覆盖内置题（用户可以修订自带题解）。 */
export function mergeBank(builtin, custom) {
  const byId = new Map(normalizeBank(builtin).map((item) => [item.id, item]));
  for (const item of normalizeBank(custom)) byId.set(item.id, item);
  return [...byId.values()];
}

/** 一道题的可搜索文本：题干、考点、标签、题解、方向、主题都算。 */
function haystack(question) {
  return [question.question, question.topic, question.answer, ...question.tags, question.category].join(" ").toLowerCase();
}

/**
 * 检索与筛选。
 * criteria 各项都是「空即不筛」，所以同一个函数能同时服务搜索框、方向页签与掌握度筛选。
 *   query      关键词（空白分词，全部命中才算）
 *   category   方向 key
 *   difficulty 难度等级
 *   topic      主题精确匹配
 *   status     "all" | "todo"（没刷过或标记为没掌握）| "done"（已掌握）| "starred"
 *   starred    Set<id>，status 为 starred 时使用
 *   records    { [id]: record }，status 用
 */
export function filterQuestions(questions, criteria = {}) {
  const { query = "", category = "", difficulty = 0, topic = "", status = "all", starred, records = {} } = criteria;
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return questions.filter((question) => {
    if (category && question.category !== category) return false;
    if (difficulty && question.difficulty !== difficulty) return false;
    if (topic && question.topic !== topic) return false;
    if (status === "starred" && !starred?.has(question.id)) return false;
    if (status !== "all" && status !== "starred") {
      const mastered = (records[question.id]?.mastery ?? 0) >= 2;
      if (status === "done" && !mastered) return false;
      if (status === "todo" && mastered) return false;
    }
    if (words.length) {
      const hay = haystack(question);
      if (!words.every((word) => hay.includes(word))) return false;
    }
    return true;
  });
}

/** 某个方向下出现过的主题（按出现顺序去重），供主题下拉使用。 */
export function topicsOf(questions, category = "") {
  const out = [];
  for (const question of questions) {
    if (category && question.category !== category) continue;
    if (!out.includes(question.topic)) out.push(question.topic);
  }
  return out;
}

/** 题库统计：总数、按方向、按难度。界面顶部与设置页都用它。 */
export function bankStats(questions) {
  const byCategory = Object.fromEntries(CATEGORY_KEYS.map((key) => [key, 0]));
  const byDifficulty = { 1: 0, 2: 0, 3: 0 };
  for (const question of questions) {
    if (byCategory[question.category] !== undefined) byCategory[question.category] += 1;
    if (byDifficulty[question.difficulty] !== undefined) byDifficulty[question.difficulty] += 1;
  }
  return { total: questions.length, byCategory, byDifficulty };
}

/**
 * 组一套模拟面试题：按方向配额抽题，抽完再打乱。
 * 为什么要配额而不是全库随机：随机抽会把「后端八股」抽成算法专场，
 * 而真实面试是每个方向都问几道。配额不足时从同方向剩下的题里补，不跨方向凑数。
 *
 * rng 注入是为了让测试可复现——生产用 Math.random，测试传固定序列。
 */
export function buildSession(questions, { perCategory = 3, rng = Math.random } = {}) {
  const picked = [];
  for (const category of CATEGORY_KEYS) {
    const pool = questions.filter((question) => question.category === category);
    picked.push(...sample(pool, perCategory, rng));
  }
  return shuffle(picked, rng);
}

/** 从数组里不放回地抽 n 个（Fisher–Yates 的前 n 步）。 */
export function sample(items, n, rng = Math.random) {
  const copy = [...items];
  const take = Math.max(0, Math.min(n, copy.length));
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, take);
}

/** Fisher–Yates 洗牌，返回新数组。 */
export function shuffle(items, rng = Math.random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** 生成导入题的 id：与内置题同一命名空间，但前缀固定，便于识别与清理。 */
export function customId(seed) {
  const slug = String(seed ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `custom-${slug || "q"}`;
}
