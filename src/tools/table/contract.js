// 分隔文本工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, str, text } from "../../contracts/kit.js";

export default {
  key: "table",
  order: 20,
  scope: "both",
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
      // 演示脚本：锚点名由本工具视图注册（见 View.vue 的 useToolDemo），
      // 两边的一致性由 src/app/toolDemoContract.test.js 强制。from 取不到的交互步骤会被丢弃。
      demo: {
        steps: [
          { anchor: "input", action: "fill", from: "text", captionKey: "toolbox.demo.fillInput" },
          { anchor: "table", action: "reveal", captionKey: "toolbox.demo.showTable" },
        ],
      },
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
      demo: {
        steps: [
          { anchor: "input", action: "fill", from: "text", captionKey: "toolbox.demo.fillInput" },
          { anchor: "delimiter", action: "select", from: "delimiter", captionKey: "toolbox.demo.pickDelimiter" },
          { anchor: "export-format", action: "select", from: "format", captionKey: "toolbox.demo.pickFormat" },
          { anchor: "export-output", action: "reveal", captionKey: "toolbox.demo.showOutput" },
        ],
      },
    },
  ],
};
