// 知识库工具包的纯逻辑：标签解析、条目过滤、摘要与文件名归一。
//
// 三端（桌面 / 浏览器 / 移动端）共用同一份：手机端视图直接 import 本文件，
// 所以这里不许碰 DOM、平台能力与存储——只做纯字符串/数组变换，便于单测。

const TAG_SPLIT = /[,，、;；\s]+/;

/**
 * 标签解析：逗号（含全角）、顿号、分号、空白、换行都是分隔符。
 * 去空、去重并保持输入顺序——用户敲的顺序就是展示顺序，重排会让人以为自己写错了。
 */
export function parseTags(input) {
  const out = [];
  for (const raw of String(input ?? "").split(TAG_SPLIT)) {
    const tag = raw.trim();
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
  }
  return out;
}

/** 标签数组 → 可编辑文本（与 parseTags 互为逆运算） */
export function formatTags(tags) {
  return Array.isArray(tags) ? tags.filter((t) => typeof t === "string" && t.trim()).join(", ") : "";
}

/**
 * 全部条目的标签集合，按「出现次数多 → 少」排，同次数按字典序。
 * 次数优先：高频标签更可能是用户筛选时想点的那个。
 */
export function collectTags(entries) {
  const counts = new Map();
  for (const entry of entries || []) {
    for (const tag of Array.isArray(entry?.tags) ? entry.tags : []) {
      if (typeof tag !== "string" || !tag) continue;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

/**
 * 条目是否命中筛选：keyword 全文（标题/正文/标签，大小写不敏感），tag 精确匹配标签。
 * 两个条件同时给出时是「与」关系——先搜词再点标签，不该把标签外的东西带回来。
 */
export function matchEntry(entry, { keyword = "", tag = "" } = {}) {
  if (!entry || typeof entry !== "object") return false;
  if (tag && !(Array.isArray(entry.tags) ? entry.tags : []).includes(tag)) return false;
  const kw = String(keyword).trim().toLowerCase();
  if (!kw) return true;
  const haystack = [entry.title, entry.content, ...(Array.isArray(entry.tags) ? entry.tags : [])]
    .filter((v) => typeof v === "string")
    .join("\n")
    .toLowerCase();
  return haystack.includes(kw);
}

/**
 * 过滤 + 排序：命中筛选的条目按更新时间倒序（刚改过的在最上面）。
 * updatedAt 可能是数字（视图写的 Date.now()）也可能是 ISO 字符串，统一按毫秒比。
 */
export function filterEntries(entries, options = {}) {
  return (entries || [])
    .filter((entry) => matchEntry(entry, options))
    .slice()
    .sort((a, b) => tsOf(b?.updatedAt) - tsOf(a?.updatedAt));
}

function tsOf(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/** 摘要：折叠换行与连续空白成单空格后截断，用于列表里的一行预览 */
export function excerpt(content, limit = 120) {
  const flat = String(content ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 从文件路径/文件名推出条目标题：取基名、去掉扩展名。
 * 两端都要用（桌面拿到的是完整路径，浏览器/手机拿到的是文件名），所以统一在这里做。
 */
export function titleFromFile(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 正文统计（编辑区脚注用）：字符数与行数 */
export function textStats(content) {
  const text = String(content ?? "");
  return { chars: text.length, lines: text ? text.split("\n").length : 0 };
}

/** 允许导入的文本类扩展名：正文能直接当文本读的格式（PDF/DOCX 等需正文抽取，见 README） */
export const TEXT_EXTENSIONS = Object.freeze(["txt", "md", "markdown", "csv", "json", "log", "yaml", "yml"]);
