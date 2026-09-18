// 写前预览的数据整形：把一次「读旧值 + 生成 diff」的结果变成确认卡能直接渲染的行。
//
// 为什么要单独一层：diff 是全文级的（一个 5000 行的文件会给出 5000 行 rows），
// 而确认卡只能显示有限几行——只取前 N 行又会让「改动在文件末尾」这种最常见的情况看不见。
// 处理办法是把长度也当作信息：只显示改动行 + 改动前后的少量上下文，并明说「还有多少行没显示」。
//
// 纯函数、不 import Vue / Tauri：node 环境可直接单测。

/** 确认卡上最多显示多少行 diff。 */
export const PREVIEW_MAX_ROWS = 40;
/** 每处改动前后保留的上下文行数。 */
export const PREVIEW_CONTEXT = 1;

/** 是否算「有改动」：diff 行里出现新增/删除/修改。 */function isChanged(row) {
  const type = String(row?.type || "");
  return type === "added" || type === "removed" || type === "modified" || type === "change";
}

/**
 * 预览行的几种来源形状归一：{ rows } / { lines } / 裸数组。
 * 认不出来时返回空数组，由 describePreview 标 schemaUnsupported —— **不静默画一张空卡**：
 * 「卡片上一个字都没有」是用户实测反馈里最让人困惑的状态，必须能说出为什么。
 */
function previewRowsOf(diff) {
  if (Array.isArray(diff)) return diff;
  if (!diff || typeof diff !== "object") return [];
  if (Array.isArray(diff.rows)) return diff.rows;
  if (Array.isArray(diff.lines)) return diff.lines;
  return [];
}

/**
 * 挑出要显示的行：优先改动行，各带少量上下文。
 * 返回的每一项都是 { type, left, right }，与 textDiff 的行结构一致（UI 不用适配两套形状）。
 */
export function summarizePreviewRows(diff, options = {}) {
  const maxRows = Number.isInteger(options.maxRows) && options.maxRows > 0 ? options.maxRows : PREVIEW_MAX_ROWS;
  const context = Number.isInteger(options.context) && options.context >= 0 ? options.context : PREVIEW_CONTEXT;
  const rows = previewRowsOf(diff);
  if (!rows.length) return { rows: [], shown: 0, total: 0, hidden: 0, mode: "empty" };
  // 小改动就整体显示：上下文窗口反而会把「只有三行不同」这种简单情况拆得难读
  if (rows.length <= maxRows) return { rows, shown: rows.length, total: rows.length, hidden: 0, mode: "full" };

  const keep = new Set();
  rows.forEach((row, index) => {
    if (!isChanged(row)) return;
    for (let i = Math.max(index - context, 0); i <= Math.min(index + context, rows.length - 1); i++) keep.add(i);
  });
  const picked = [...keep].sort((a, b) => a - b);
  // 改动太多时按顺序截断；hidden 是「文件里没显示的行数」，UI 文案据此说明这是节选
  const limited = picked.slice(0, maxRows).map((index) => rows[index]).filter(Boolean);
  return {
    rows: limited,
    shown: limited.length,
    total: rows.length,
    hidden: Math.max(rows.length - limited.length, 0),
    mode: "changes",
  };
}

/**
 * 确认卡的预览摘要：路径、是否新建、增删行数、要不要显示「还有 N 行」。
 * preview 为 null（预览失败/不需要预览）时返回 null，UI 照旧只显示参数。
 */
export function describePreview(preview, options = {}) {
  if (!preview || typeof preview !== "object") return null;
  const summary = summarizePreviewRows(preview.diff, options);
  const stats = preview.diff?.stats || {};
  // diff 有內容却一行都取不出来 = 形状不认识（例如引擎换了输出结构）。
  // 明确标出来，让卡片显示「拿不到 diff」而不是看起来像「文件没有变化」。
  const schemaUnsupported = preview.diff?.hasChanges !== false && summary.rows.length === 0 && preview.diff != null;
  return {
    path: String(preview.path || ""),
    isNew: !!preview.isNew,
    readError: String(preview.readError || ""),
    hasChanges: preview.diff?.hasChanges !== false,
    schemaUnsupported,
    added: Number(stats.added) || 0,
    removed: Number(stats.removed) || 0,
    modified: Number(stats.modified) || 0,
    ...summary,
    /** 文件太大、只看了改动附近时，把「实际总行数」也带出去给文案用 */
    fileLines: Math.max(Number(preview.diff?.rightLineCount) || 0, Number(preview.diff?.leftLineCount) || 0),
  };
}

/** 预览行的显示文本：以右（新值）优先，没有就用左（旧值）。 */
export function rowText(row) {
  const right = row?.right?.text;
  if (typeof right === "string" && right !== "") return right;
  const left = row?.left?.text;
  return typeof left === "string" ? left : "";
}

/** 预览行的类型归一：UI 只认 added / removed / equal 三种底色。 */
export function rowKind(row) {
  const type = String(row?.type || "");
  if (type === "added" || type === "removed") return type;
  if (isChanged(row)) return "changed";
  return "equal";
}
