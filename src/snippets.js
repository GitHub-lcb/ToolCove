// 速记模块纯逻辑：结构化字段（标签+值）与纯文本的互转
// -------------------------------------------------------------
// 字段模式：一条速记内多条「标签: 值」信息（如账号/密码/端口），
// 每条可单独复制，整条可拼接复制。content 始终保存拼接快照，
// 保证全文搜索 / 全局搜索 / 复制全部不感知差异。

// 字段数组 → 纯文本快照。每行「标签: 值」，无标签只输出值；
// 空值字段跳过；值内换行拍平成空格（保证一行一个字段）。
export function fieldsToContent(fields) {
  if (!Array.isArray(fields)) return "";
  return fields
    .map((f) => {
      const label = (f.label || "").trim();
      const value = f.value == null ? "" : String(f.value).replace(/\s*\n+\s*/g, " ").trim();
      if (!value) return ""; // 值空（无论有无标签）都跳过
      return label ? `${label}: ${value}` : value;
    })
    .filter((line) => line)
    .join("\n");
}

// 是否为字段模式速记（fields 非空即视为结构化速记）
export function hasFields(s) {
  return Array.isArray(s?.fields) && s.fields.length > 0;
}

// 取可复制的字段值（trim 后）；空值返回 ""，由调用方提示
export function fieldValue(f) {
  return f && f.value != null ? String(f.value).trim() : "";
}
