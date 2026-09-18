// 手机端记录页的纯逻辑：排序、过滤、摘要。
//
// 为什么单独抽出来：这里全是可测的纯函数，界面只负责渲染——手机端的 UI 会频繁重排，
// 把规则放在组件里会让每次改样式都可能动到行为。桌面端也是同样的分层（tasks.js / snippets.js / requirementMetrics.js）。
//
// 字段口径与数据层一致（见 src/data/repository.js 的 KINDS）：
//   snippets: { id, title, category, content, fields[], images[], pinned, createdAt, updatedAt }
//   problems: { id, title, type, status, tags[], note, logs[], images[], resolution, resolvedAt, createdAt, updatedAt }

/** 记录页的分段：速记 / 问题。 */
export const RECORD_KINDS = Object.freeze({
  snippets: { key: "snippets", labelKey: "nav.snippet", searchKey: "snippet.searchPh", emptyKey: "snippet.emptyTitle" },
  problems: { key: "problems", labelKey: "nav.problem", searchKey: "problem.searchPh", emptyKey: "problem.emptyTitle" },
});

const ts = (value) => {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** 排序：置顶优先（速记），其次按更新时间倒序；时间相同的用 id 兜底保证稳定。 */
export function sortRecords(records = []) {
  return [...records].sort((a, b) => {
    const pinned = Number(!!b?.pinned) - Number(!!a?.pinned);
    if (pinned !== 0) return pinned;
    const delta = ts(b?.updatedAt ?? b?.createdAt) - ts(a?.updatedAt ?? a?.createdAt);
    if (delta !== 0) return delta;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

/** 关键词过滤：标题、正文/备注、分类、标签、结构化字段都算命中。 */
export function filterRecords(records = [], keyword = "") {
  const needle = String(keyword || "").trim().toLowerCase();
  if (!needle) return [...records];
  return records.filter((record) => {
    if (!record || typeof record !== "object") return false;
    const haystack = [
      record.title,
      record.content,
      record.note,
      record.category,
      record.resolution,
      Array.isArray(record.tags) ? record.tags.join(" ") : "",
      Array.isArray(record.fields) ? record.fields.map((f) => `${f?.label || ""} ${f?.value || ""}`).join(" ") : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** 列表行摘要：单行、限长——手机上一行放不下更多。 */
export function recordSummary(record, limit = 60) {
  if (!record || typeof record !== "object") return "";
  const source = String(record.content ?? record.note ?? "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  return source.length > limit ? `${source.slice(0, limit)}…` : source;
}

/** 结构化字段的条数（速记用；0 表示纯文本记录）。 */
export function fieldCount(record) {
  return Array.isArray(record?.fields) ? record.fields.filter((f) => String(f?.value ?? "").trim()).length : 0;
}

/** 列表分组标题用的时间文案：今天 / 昨天 / 更早。 */
export function dayBucket(record, now = Date.now()) {
  const time = ts(record?.updatedAt ?? record?.createdAt);
  if (!time) return "earlier";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (time >= startMs) return "today";
  if (time >= startMs - day) return "yesterday";
  return "earlier";
}

/**
 * 问题页的状态过滤。open = 未解决，done = 已解决，其余（含未知值）都按「全部」处理。
 *
 * 为什么未知值不按 open 处理：状态值来自用户数据，脏值（或以后新增的状态）不该把列表筛成空的
 * ——那看起来像「记录全丢了」。宁可多显示，也不少显示。
 */
export function filterByStatus(records = [], status = "all") {
  if (status !== "open" && status !== "done") return [...records];
  return records.filter((record) => {
    const done = !!record?.resolvedAt || record?.status === "done" || record?.status === "resolved";
    return status === "done" ? done : !done;
  });
}

/** 传给 repository.update 的可改字段白名单（与 dataTools 的 KIND_META 同源，这里只取手机端要用的部分）。 */
export const EDITABLE_FIELDS = Object.freeze({
  snippets: ["title", "category", "content", "pinned"],
  problems: ["title", "type", "status", "tags", "note", "resolution"],
});

/** 从表单值构造 create/update 的载荷：只保留白名单字段，空标题直接拒绝（返回 null）。 */
export function toPayload(kind, form = {}) {
  const allowed = EDITABLE_FIELDS[kind];
  if (!allowed) return null;
  const title = String(form.title ?? "").trim();
  if (!title) return null;
  const payload = { title };
  for (const key of allowed) {
    if (key === "title") continue;
    if (!(key in form)) continue;
    const value = form[key];
    payload[key] = Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : value;
  }
  return payload;
}
