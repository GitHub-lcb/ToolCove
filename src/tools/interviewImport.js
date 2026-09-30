// 面试刷题 · 题库导入（Markdown / JSON）。
//
// 内置题库覆盖四个方向的常见考点，但每个人的面试是不一样的——所以留一个入口，
// 让用户把任意仓库的题解灌进来。这里只做**解析**，不碰存储与界面。
//
// Markdown 的写法没有统一标准，所以解析器认三种最常见的形式：
//   1) `## 问题` + 正文            —— 大多数题解仓库的写法
//   2) `### 问题` + 正文           —— 章节套小节
//   3) `**问题**` 或 `Q: 问题`     —— 博客式速记
// 答案一律是「到下一个同/更高级标题为止」的正文。识别不到任何题目时**明确报错**，
// 而不是静默返回空数组——「导入了但一道题都没有」比报错更难排查。
//
// 文件头部的 `> 方向: backend` / `> 主题: JVM` / `> 难度: 2` 用来给整份文件定默认值，
// 单题可以在标题后加 `[难度:3]` 覆盖。方向必须落在 CATEGORY_KEYS 里，否则整份文件拒收。

import { CATEGORY_KEYS, customId, normalizeQuestion } from "./interviewBank.js";

const CATEGORY_SET = new Set(CATEGORY_KEYS);

/** 标题行：`## xxx` / `### xxx`。返回 { level, text }。 */
function headingOf(line) {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, text: match[2].trim() };
}

/** 题目行：`**xxx**` 或 `Q: xxx` / `问: xxx` / `问题: xxx`。 */
function inlineQuestionOf(line) {
  const bold = /^\*\*(.+?)\*\*\s*$/.exec(line.trim());
  if (bold) return bold[1].trim();
  const prefixed = /^(?:Q|q|问|问题)\s*[:：]\s*(.+)$/.exec(line.trim());
  if (prefixed) return prefixed[1].trim();
  return null;
}

/** 标题里带的难度覆盖：`问题 [难度:3]`。 */
function splitDifficulty(text) {
  const match = /\[(?:难度|difficulty)\s*[:：]\s*([123])\]\s*$/i.exec(text);
  if (!match) return { text: text.trim(), difficulty: 0 };
  return { text: text.slice(0, match.index).trim(), difficulty: Number(match[1]) };
}

/** 解析文件头部的 `> 键: 值` 默认值。 */
function parseHeader(lines) {
  const meta = { category: "", topic: "", difficulty: 0 };
  const keys = { 方向: "category", 分类: "category", category: "category", 主题: "topic", topic: "topic", 难度: "difficulty", difficulty: "difficulty" };
  for (const line of lines) {
    const match = /^>\s*([^:：]+)\s*[:：]\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    const field = keys[match[1].trim().toLowerCase()] ?? keys[match[1].trim()];
    if (!field) continue;
    const value = match[2].trim();
    if (field === "category") meta.category = CATEGORY_SET.has(value) ? value : meta.category;
    else if (field === "topic") meta.topic = value;
    else if (field === "difficulty" && /^[123]$/.test(value)) meta.difficulty = Number(value);
  }
  return meta;
}

/** 从 `- 要点：a；b；c` 这类行里取要点。 */
function pointsOf(body) {
  const match = /^\s*[-*]?\s*(?:要点|考点|points?)\s*[:：]\s*(.+)$/im.exec(body);
  if (!match) return [];
  return match[1].split(/[；;]|\s\/\s/).map((item) => item.trim()).filter(Boolean).slice(0, 3);
}

/** 从 `- 追问：xxx` 取追问。 */
function followOf(body) {
  const match = /^\s*[-*]?\s*(?:追问|延伸|follow)\s*[:：]\s*(.+)$/im.exec(body);
  return match ? match[1].trim() : "";
}

/** 从 `- 标签：a, b` 取标签。 */
function tagsOf(body) {
  const match = /^\s*[-*]?\s*(?:标签|tags?)\s*[:：]\s*(.+)$/im.exec(body);
  if (!match) return [];
  return match[1].split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
}

/** 去掉正文里被结构化字段吃掉的行，剩下的才是题解本体。 */
function answerOf(body) {
  return body
    .split("\n")
    .filter((line) => !/^\s*[-*]?\s*(?:要点|考点|追问|延伸|标签|points?|follow|tags?)\s*[:：]/i.test(line))
    .join("\n")
    .trim();
}

/**
 * 解析 Markdown 题库。
 * 返回 { questions, error, stats }：error 非空时 questions 为空。
 */
export function parseMarkdownBank(source, { category = "", topic = "" } = {}) {
  const text = typeof source === "string" ? source : "";
  if (!text.trim()) return { questions: [], error: "empty", stats: null };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const header = parseHeader(lines);
  // 文件头没写方向就用调用方传的（界面上选的那个），两者都没有则整份拒收
  const defaultCategory = header.category || (CATEGORY_SET.has(category) ? category : "");
  const defaultTopic = header.topic || topic || "";

  const blocks = [];
  let current = null;
  for (const line of lines) {
    const heading = headingOf(line);
    const inline = heading ? null : inlineQuestionOf(line);
    if (heading || inline) {
      const raw = heading ? heading.text : inline;
      const { text: title, difficulty } = splitDifficulty(raw);
      // `#` 一级标题当文件标题，不当题目
      const isQuestion = heading ? heading.level >= 2 : true;
      if (isQuestion && title) {
        if (current) blocks.push(current);
        current = { title, difficulty, body: [] };
        continue;
      }
    }
    if (current) current.body.push(line);
  }
  if (current) blocks.push(current);

  if (!blocks.length) return { questions: [], error: "noQuestion", stats: null };
  if (!defaultCategory) return { questions: [], error: "noCategory", stats: null };

  const questions = [];
  const used = new Set();
  for (const block of blocks) {
    const body = block.body.join("\n").trim();
    // 有标题但正文空着的块多半是章节分隔，跳过而不是造一道空题解
    if (!body) continue;
    let id = customId(block.title);
    // 同名的两道题必须共存，否则导入会静默吞掉一道
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);
    const question = normalizeQuestion({
      id,
      category: defaultCategory,
      topic: defaultTopic || "导入",
      difficulty: block.difficulty || header.difficulty || 2,
      tags: tagsOf(body),
      question: block.title,
      answer: answerOf(body),
      points: pointsOf(body),
      follow: followOf(body),
      sources: [],
      custom: true,
    });
    if (question) questions.push(question);
  }
  if (!questions.length) return { questions: [], error: "noQuestion", stats: null };
  return { questions, error: "", stats: { parsed: questions.length, skipped: blocks.length - questions.length } };
}

/**
 * 解析 JSON 题库：接受数组，或 `{ questions: [...] }` / `{ items: [...] }`。
 * 字段名按题目契约走，`category` 缺失时用调用方选的默认方向。
 */
export function parseJsonBank(source, { category = "" } = {}) {
  let data = source;
  if (typeof source === "string") {
    if (!source.trim()) return { questions: [], error: "empty", stats: null };
    try {
      data = JSON.parse(source);
    } catch (error) {
      return { questions: [], error: "badJson", stats: { detail: String(error.message ?? error) } };
    }
  }
  const rawList = Array.isArray(data) ? data : data?.questions ?? data?.items;
  if (!Array.isArray(rawList)) return { questions: [], error: "badShape", stats: null };
  const fallbackCategory = CATEGORY_SET.has(category) ? category : "";
  const questions = [];
  const used = new Set();
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const title = String(raw.question ?? raw.title ?? "").trim();
    if (!title) continue;
    let id = String(raw.id ?? "").trim() || customId(title);
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);
    const question = normalizeQuestion({
      ...raw,
      id,
      question: title,
      category: CATEGORY_SET.has(raw.category) ? raw.category : fallbackCategory,
      custom: true,
    });
    if (question) questions.push(question);
  }
  if (!questions.length) return { questions: [], error: "noQuestion", stats: null };
  return { questions, error: "", stats: { parsed: questions.length, skipped: rawList.length - questions.length } };
}

/** 按文件名后缀选解析器；`.md` / `.markdown` / `.txt` 走 Markdown，其余走 JSON。 */
export function parseBank(source, { format = "", category = "", topic = "" } = {}) {
  const kind = format || (/^\s*[[{]/.test(String(source ?? "")) ? "json" : "markdown");
  return kind === "json" ? parseJsonBank(source, { category }) : parseMarkdownBank(source, { category, topic });
}

/** 导出题库为 JSON 文本（供「导出题库」按钮，导出的文件能原样再导入）。 */
export function exportBankJson(questions) {
  return JSON.stringify(
    questions.map((question) => ({
      id: question.id,
      category: question.category,
      topic: question.topic,
      difficulty: question.difficulty,
      tags: question.tags,
      question: question.question,
      answer: question.answer,
      points: question.points,
      follow: question.follow,
      sources: question.sources,
    })),
    null,
    2,
  );
}
