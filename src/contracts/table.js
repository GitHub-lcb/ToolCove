// 分隔文本工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, str, text } from "./kit.js";

export default {
  key: "table",
  ui: {
    labelKey: "toolbox.registry.toolTable",
    icon: "table",
    category: "data",
    descKey: "toolbox.registry.toolTableDesc",
    keywordsKey: "toolbox.registry.kwTable",
    ready: true,
  },
  actions: [
    {
      name: "table.parse",
      description: "解析 CSV/TSV 等分隔文本：分隔符可自动嗅探，返回表头、前若干行、是否被截断与行列统计（空值数、重复行数、最长单元格）",
      descriptionKey: "agent.toolTableParse",
      toolKey: "table",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text, delimiter: str(4), maxRows: { type: "integer", minimum: 1, maximum: 5000 } }, ["text"]),
    },
    {
      name: "table.convert",
      description: "把分隔文本转成目标格式：json / markdown / sql（INSERT 语句，值按字符串转义不做类型推断）/ csv / tsv",
      descriptionKey: "agent.toolTableConvert",
      toolKey: "table",
      risk: "transform",
      retryable: false,
      inputSchema: schema(
        { text, delimiter: str(4), format: { type: "string", enum: ["json", "markdown", "sql", "csv", "tsv"] }, tableName: str(64), indent: { type: "integer", minimum: 0, maximum: 8 } },
        ["text", "format"]
      ),
    },
  ],
};
