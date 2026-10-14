// 分隔文本工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 解析/嗅探/转换全部是同步纯函数，落在 ./logic.js，三端共用；不碰原生能力，故不标 desktopOnly。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { detectDelimiter, parseDelimited, stats as tableStats, toDelimited, toJson as tableToJson, toMarkdown, toSqlInsert } from "./logic.js";

export default {
  "table.parse": {
    execute: ({ text, delimiter, maxRows = 200 }) => {
      const char = delimiter || detectDelimiter(text);
      const { rows, truncated, totalRows } = parseDelimited(text, char, { maxRows });
      return { delimiter: char, header: rows[0] || [], rows, rowCount: rows.length, totalRows, truncated, stats: tableStats(rows) };
    },
  },
  "table.convert": {
    execute: ({ text, delimiter, format, tableName, indent = 2 }) => {
      const rows = parseDelimited(text, delimiter || detectDelimiter(text)).rows;
      if (format === "json") return tableToJson(rows, { header: true, indent });
      if (format === "markdown") return toMarkdown(rows);
      if (format === "sql") return toSqlInsert(rows, { table: tableName || "t", header: true });
      return toDelimited(rows, { delimiter: format === "tsv" ? "\t" : "," });
    },
  },
};
