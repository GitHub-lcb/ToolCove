// PDF 工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据（描述/风险/参数 Schema）在同一包的 ./contract.js —— 一个工具一个包，两者同源。
//
// 重依赖（pdf-lib / qpdf-wasm）经 ./logic.js 与 ./decrypt.js 惰性加载；
// 文件字节走中立共享层的原生 Base64 桥（src/nativeBinary.js），不在这里重复实现。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { mergePdfs, extractPages, splitPdf, readPdfSummary, buildSplitGroups, parsePageRanges, pdfBaseName, pdfOutputName } from "./logic.js";
import { readBinary, writeBinary } from "../../nativeBinary.js";

export default {
  "pdf.merge": {
    execute: async (args) => {
      const paths = (Array.isArray(args?.paths) ? args.paths : []).map((p) => String(p || "").trim()).filter(Boolean);
      if (paths.length < 2) throw Error("至少需要 2 个 PDF 路径");
      const inputs = [];
      for (const path of paths) inputs.push(await readBinary(path));
      const merged = await mergePdfs(inputs);
      const bytes = await writeBinary(args?.output, merged);
      return { output: String(args?.output || "").trim(), files: paths.length, bytes };
    },
  },
  "pdf.extract_pages": {
    execute: async (args) => {
      const bytes = await readBinary(args?.path);
      const { pageCount } = await readPdfSummary(bytes);
      const indices = parsePageRanges(args?.ranges, pageCount);
      if (!indices.length) throw Error(`页码表达式没有命中任何页面：${args?.ranges}（共 ${pageCount} 页）`);
      const out = await extractPages(bytes, indices);
      const written = await writeBinary(args?.output, out);
      return { output: String(args?.output || "").trim(), pages: indices.length, bytes: written };
    },
  },
  "pdf.split": {
    execute: async (args) => {
      const path = String(args?.path || "").trim();
      const bytes = await readBinary(path);
      const { pageCount } = await readPdfSummary(bytes);
      const groups = buildSplitGroups(args?.groups, pageCount);
      if (!groups.length) throw Error(`拆分表达式没有命中任何页面：${args?.groups || "（空）"}（共 ${pageCount} 页）`);
      const results = await splitPdf(bytes, groups);
      const dir = String(args?.outputDir || "").trim().replace(/[\\/]+$/, "");
      if (!dir) throw Error("缺少 outputDir 输出目录");
      const base = pdfBaseName(path);
      const files = [];
      for (const result of results) {
        const target = `${dir}/${pdfOutputName(base, result.token)}`;
        const written = await writeBinary(target, result.bytes);
        files.push({ path: target, pages: result.indices.length, bytes: written });
      }
      return { outputDir: dir, count: files.length, files };
    },
  },
};
