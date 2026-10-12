// 提示词工具的纯逻辑：变量提取与填充、库过滤排序、导入导出、历史裁剪与内置示例。
// 与视图解耦（不 import Vue/Tauri），node 环境可直接单测。

export const PROMPTS_FORMAT = "toolcove-prompts";
export const PROMPTS_VERSION = 1;
export const VAR_MAX_LEN = 40;
export const CONTENT_MAX_LEN = 100_000;
export const HISTORY_CAP = 100;
export const WORKFLOW_CAP = 30;
export const WORKFLOW_MAX_BYTES = 2 * 1024 * 1024;

const VAR_RE = /\{\{([^{}\r\n]+)\}\}/g;

/** 点开列表行、生成面板共用的变量提取：多段文本按顺序合并，去重保序，中文变量名原生支持。 */
export function extractVariables(...texts) {
  const names = [];
  const seen = new Set();
  for (const text of texts) {
    if (typeof text !== "string" || !text) continue;
    for (const match of text.matchAll(VAR_RE)) {
      const name = match[1].trim();
      if (!name || name.length > VAR_MAX_LEN || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * 填充变量生成成稿。未填（null/空串）的变量保留原占位文本并计入 missing——
 * 留洞可见、可恢复，比静默出现"句子缺一块"好排查。
 * 用函数式 replace 单趟扫描：用户填的值里含 {{x}} 不会被二次展开。
 */
export function fillTemplate(text, values = {}) {
  const source = typeof text === "string" ? text : "";
  const missing = [];
  const output = source.replace(VAR_RE, (raw, inner) => {
    const name = inner.trim();
    if (!name || name.length > VAR_MAX_LEN) return raw;
    const value = values?.[name];
    if (value == null || String(value).trim() === "") {
      if (!missing.includes(name)) missing.push(name);
      return raw;
    }
    return String(value);
  });
  return { output, missing };
}

/** 标签归一：字符串按中英逗号/顿号/分号/空白切分，trim + 去空 + 去重。 */
export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input.join(",") : String(input ?? "");
  const out = [];
  for (const part of raw.split(/[,，、;；\s]+/)) {
    const tag = part.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** 列表排序：置顶优先 → updatedAt 倒序 → id 兜底（空值安全，stable 不依赖）。 */
export function sortPrompts(records) {
  return [...(Array.isArray(records) ? records : [])].sort((a, b) => {
    const pinA = a?.pinned ? 1 : 0;
    const pinB = b?.pinned ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;
    const timeA = Number(a?.updatedAt) || 0;
    const timeB = Number(b?.updatedAt) || 0;
    if (timeA !== timeB) return timeB - timeA;
    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  });
}

/** 库过滤：keyword 命中 title/positive/negative/category/tags/note；category 与 tag 精确匹配（三者为"与"）。 */
export function filterPrompts(records, { keyword = "", category = "", tag = "" } = {}) {
  const needle = String(keyword ?? "").trim().toLowerCase();
  const cat = String(category ?? "").trim();
  const wanted = String(tag ?? "").trim();
  return (Array.isArray(records) ? records : []).filter((record) => {
    if (!record || typeof record !== "object") return false;
    if (cat && String(record.category ?? "") !== cat) return false;
    if (wanted && !(Array.isArray(record.tags) ? record.tags : []).includes(wanted)) return false;
    if (!needle) return true;
    const haystack = [
      record.title,
      record.positive,
      record.negative,
      record.category,
      record.note,
      ...(Array.isArray(record.tags) ? record.tags : []),
    ];
    return haystack.some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
}

/** 现有分类（首次出现序去重，供下拉与 chips）。 */
export function categoriesOf(records) {
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    const category = String(record?.category ?? "").trim();
    if (category && !out.includes(category)) out.push(category);
  }
  return out;
}

/** 现有标签（首次出现序去重）。 */
export function tagsOf(records) {
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    for (const tag of Array.isArray(record?.tags) ? record.tags : []) {
      const value = String(tag ?? "").trim();
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

/** 去重键：标题 + 正文，供导入去重与"示例是否已加入"判断。 */
export function dedupeKey(record) {
  return `${String(record?.title ?? "").trim()}\n${String(record?.positive ?? "").trim()}`;
}

function firstLine(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line ?? "";
}

/**
 * 把任意来源的草稿/导入行归一成库记录字段（不含 id/时间戳——入库时由 repository 生成）。
 * positive 为空视为无效返回 null；title 缺失时取正文首行。
 */
export function normalizePromptDraft(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const positive = String(raw.positive ?? raw.content ?? "").trim();
  if (!positive || positive.length > CONTENT_MAX_LEN) return null;
  const title = (String(raw.title ?? "").trim() || firstLine(positive)).slice(0, 80);
  return {
    title,
    positive,
    negative: String(raw.negative ?? "").trim().slice(0, CONTENT_MAX_LEN),
    target: raw.target === "video" ? "video" : "image",
    category: String(raw.category ?? "").trim(),
    tags: normalizeTags(raw.tags),
    note: String(raw.note ?? "").trim(),
    pinned: Boolean(raw.pinned),
  };
}

/** 导出载荷（可原样再导入；id 保留仅作参考，导入端一律当新记录建）。 */
export function buildExportPayload(records, now = Date.now()) {
  const list = Array.isArray(records) ? records : [];
  return {
    format: PROMPTS_FORMAT,
    version: PROMPTS_VERSION,
    exportedAt: new Date(now).toISOString(),
    count: list.length,
    prompts: list.map((record) => ({
      id: String(record?.id ?? ""),
      title: String(record?.title ?? ""),
      positive: String(record?.positive ?? ""),
      negative: String(record?.negative ?? ""),
      target: record?.target === "video" ? "video" : "image",
      category: String(record?.category ?? ""),
      tags: normalizeTags(record?.tags),
      note: String(record?.note ?? ""),
      pinned: Boolean(record?.pinned),
      createdAt: Number(record?.createdAt) || 0,
      updatedAt: Number(record?.updatedAt) || 0,
    })),
  };
}

export function exportPromptsJson(records) {
  return JSON.stringify(buildExportPayload(records), null, 2);
}

/**
 * 解析导入文本。错误码对齐题库导入的惯例：empty / badJson / badFormat / badShape / noPrompts；
 * 也接受已解析对象（便于单测）。逐行 invalid 跳过；文件内按 dedupeKey 去重；忽略源 id。
 */
export function parsePromptsJson(source) {
  let data = source;
  if (typeof source === "string") {
    if (!source.trim()) return { ok: false, prompts: [], error: "empty", stats: null };
    try {
      data = JSON.parse(source);
    } catch (error) {
      return { ok: false, prompts: [], error: "badJson", stats: { detail: String(error?.message ?? error) } };
    }
  }
  let rows = null;
  if (Array.isArray(data)) {
    rows = data;
  } else if (data && typeof data === "object") {
    if (data.format != null && String(data.format) !== PROMPTS_FORMAT) {
      return { ok: false, prompts: [], error: "badFormat", stats: { format: String(data.format) } };
    }
    if (Array.isArray(data.prompts)) rows = data.prompts;
  }
  if (!rows) return { ok: false, prompts: [], error: "badShape", stats: null };

  const prompts = [];
  const seen = new Set();
  let invalid = 0;
  let duplicates = 0;
  for (const raw of rows) {
    const draft = normalizePromptDraft(raw);
    if (!draft) {
      invalid += 1;
      continue;
    }
    const key = dedupeKey(draft);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    prompts.push(draft);
  }
  const stats = { total: rows.length, valid: prompts.length, invalid, duplicates };
  if (!prompts.length) return { ok: false, prompts: [], error: "noPrompts", stats };
  return { ok: true, prompts, error: "", stats };
}

/** 与库内记录按 dedupeKey 去重（同一份文件导入两次不产生副本）。 */
export function splitImports(imported, existing) {
  const keys = new Set((Array.isArray(existing) ? existing : []).map(dedupeKey));
  const fresh = [];
  let duplicates = 0;
  for (const prompt of Array.isArray(imported) ? imported : []) {
    const key = dedupeKey(prompt);
    if (keys.has(key)) {
      duplicates += 1;
      continue;
    }
    keys.add(key);
    fresh.push(prompt);
  }
  return { fresh, duplicates };
}

/** 历史裁剪：保留最新 cap 条（按 ts 倒序），返回被淘汰项供调用方清理媒体文件。 */
export function trimHistory(list, cap = HISTORY_CAP) {
  const rows = [...(Array.isArray(list) ? list : [])].sort(
    (a, b) => (Number(b?.ts) || 0) - (Number(a?.ts) || 0)
  );
  const kept = rows.slice(0, Math.max(0, cap));
  const evicted = rows.slice(Math.max(0, cap));
  return { kept, evicted };
}

/** 示例是否已在库中（title+positive 全等，防连点重复加入）。 */
export function hasSample(library, sample) {
  return (Array.isArray(library) ? library : []).some((record) => dedupeKey(record) === dedupeKey(sample));
}

export const SAMPLE_PROMPT_KEYS = ["portrait", "anime", "productShot", "posterText", "cinematicVideo", "loopVideo"];

const SAMPLE_TARGETS = {
  portrait: "image",
  anime: "image",
  productShot: "image",
  posterText: "image",
  cinematicVideo: "video",
  loopVideo: "video",
};

/** 内置示例内容（i18n 键存文案，含 {{变量}} 演示；加入后就是普通可编辑记录）。 */
export function samplePrompts(t) {
  const translate = typeof t === "function" ? t : (key) => key;
  const category = translate("toolbox.prompt.samples.category");
  return SAMPLE_PROMPT_KEYS.map((id) => ({
    key: `sample-${id}`,
    title: translate(`toolbox.prompt.samples.${id}.title`),
    positive: translate(`toolbox.prompt.samples.${id}.positive`),
    negative: translate(`toolbox.prompt.samples.${id}.negative`),
    target: SAMPLE_TARGETS[id] || "image",
    category,
    tags: [],
    note: "",
    pinned: false,
  }));
}
