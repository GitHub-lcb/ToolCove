// 产物提取：从工具结果里认出「落到磁盘的文件」，供「在工具中打开」与交付清单使用。
//
// 产物形状来自执行器约定，不是通用协议：
//   pdf.merge / pdf.extract_pages → { output: "…", … }（单产物）
//   pdf.split                     → { outputDir, count, files: [{ path, pages, bytes }] }（多产物）
// 新执行器产出文件时遵守同一约定（output 或 files[].path），就能被这里自动识别，无需登记。

/** 同时按 / 与 \ 切：桌面端产物可能是 Windows 路径，也可能是 POSIX 路径。 */
function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

/**
 * extractArtifacts(result) => [{ path, label }]
 * 规则：result 是对象且有非空字符串 output → 一条（label 取 basename）；
 * 否则有数组 files（元素含非空 path）→ 每文件一条；否则 []。
 * output 优先于 files：pdf.merge 的 result 里 files 是输入个数（数字），不是产物列表。
 */
export function extractArtifacts(result) {
  if (!result || typeof result !== "object") return [];
  if (typeof result.output === "string" && result.output.trim()) {
    return [{ path: result.output, label: baseName(result.output) }];
  }
  if (Array.isArray(result.files)) {
    return result.files
      .filter((f) => f && typeof f.path === "string" && f.path.trim())
      .map((f) => ({ path: f.path, label: baseName(f.path) }));
  }
  return [];
}
