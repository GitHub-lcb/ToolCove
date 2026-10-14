// Agent 工具的实现层：**只有 execute，不含元数据**。
//
// 元数据（描述/风险分级/参数 Schema）在 src/contracts/<key>.js，与工具箱 UI 元数据同源；
// data.* 的 Schema 依赖仓库层 KINDS，留在 dataTools.js 随实现给出（见 catalog.js 说明）。
//
// 为什么单独一层：这一层会牵出 luxon / js-yaml / hash-wasm / 各工具模块（实测约 300KB），
// 只有真正要跑 Agent 时才需要加载。首屏只需要 catalog（设置归一化 + 能力面板）。
// 运行期装配见 tools.js 的 buildAgentRegistry（动态 import 本模块）。
// 一致性由 catalog.test.js 双向强制（目录 ↔ 实现，两边都不许多一个少一个）。
import { parseJson, formatJson } from "../json.js";
import { encodeBase64, decodeBase64 } from "../convert.js";
import { yamlToJson } from "../yaml.js";
import { buildTextDiff } from "../textDiff.js";
import { parseTimestamp } from "../timeTool.js";
import { generateIdentifiers } from "../generatorTool.js";
import { desktopInvoke } from "./transport.js";
import { invoke } from "../platform/invoke.js";
import { isReadOnlySql } from "../db.js";
import { digestText, generatePassword, hmacText } from "../cryptoTool.js";
import { calculateCenterCrop, calculateContainSize, calculateRenderPlan } from "../imageTool.js";
import { detectDelimiter, parseDelimited, stats as tableStats, toDelimited, toJson as tableToJson, toMarkdown, toSqlInsert } from "../tableTool.js";
import { formatXml, validateXml, xmlToJson } from "../xmlTool.js";
import { inferSchema, validateSchema } from "../jsonSchema.js";
import { lint as lintMarkdown, normalize as normalizeMarkdown } from "../markdownTool.js";
import { readSpillResult, readWindowResult } from "./readWindow.js";
import { spillStore } from "./spillStoreInstance.js";
import { TOOL_EXECUTORS } from "../toolExecutors.generated.js";

const unwrap = (result, key) => {
  if (!result.ok) throw Error(result.error?.message || "数据格式错误");
  return result[key];
};

/** 取出 invoke 回来的文本字段（Rust 侧返回对象 { text, encoding, ... }）。 */
const textOf = (result) => (typeof result === "string" ? result : result?.text ?? result?.content ?? "");

/** 把窗口结果贴回原文的元信息对象，保留 encoding/hasBom/lossy 等字段。 */
function withWindow(result, offset, limit) {
  const source = textOf(result);
  const window = readWindowResult(source, { offset, limit });
  const base = result && typeof result === "object" ? result : {};
  return { ...base, text: window.text, totalChars: window.totalChars, totalLines: window.totalLines, windowLine: window.windowLine, hasMore: window.hasMore, nextOffset: window.nextOffset, note: window.note };
}

/** 名字 → { execute }。与 catalog.js 的键集合必须一致（由 catalog.test.js 强制）。 */
export const BUILTIN_TOOL_IMPLS = Object.freeze({
  "json.parse": { execute: ({ text }) => unwrap(parseJson(text), "value") },
  "json.format": { execute: ({ text, indent = 2 }) => unwrap(formatJson(text, indent), "output") },
  "base64.encode": { execute: ({ text }) => encodeBase64(text) },
  "base64.decode": { execute: ({ text }) => decodeBase64(text) },
  "yaml.to_json": { execute: ({ text }) => unwrap(yamlToJson(text), "output") },
  "text.diff": { execute: ({ left, right }) => buildTextDiff(left, right) },
  "time.timestamp": { execute: ({ text, unit = "auto" }) => parseTimestamp(text, unit) },
  "id.generate": { execute: ({ type, count = 1 }) => generateIdentifiers(type, count) },
  // ── 表格 / XML / JSON Schema / Markdown ────────────────────
  // 这四个工具的界面能力一直是完整的纯函数实现，Agent 通过这里复用同一份逻辑。
  // 全是同步纯转换、不碰原生能力，所以三端（桌面 / 网页 / 手机）都不标 desktopOnly。
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
  "xml.format": { execute: ({ text, indent = 2 }) => formatXml(text, { indent }) },
  "xml.to_json": { execute: ({ text, alwaysArray = false }) => xmlToJson(text, { alwaysArray }) },
  "xml.validate": {
    execute: ({ text }) => {
      const errors = validateXml(text);
      return { valid: errors.length === 0, errors };
    },
  },
  "schema.infer": { execute: ({ text, required = true }) => inferSchema(unwrap(parseJson(text), "value"), { required }) },
  "schema.validate": { execute: ({ value, schemaText }) => validateSchema(unwrap(parseJson(value), "value"), unwrap(parseJson(schemaText), "value")) },
  "markdown.normalize": { execute: ({ text }) => normalizeMarkdown(text) },
  "markdown.lint": {
    execute: ({ text }) => {
      const issues = lintMarkdown(text);
      return { count: issues.length, issues };
    },
  },
  // ── 文件（桌面独占） ───────────────────────────────────────
  "file.inspect": { execute: ({ paths }) => desktopInvoke("file_tool_inspect", { paths }) },
  "file.read_text": { execute: async ({ path, encoding = "AUTO", offset, limit }) => withWindow(await desktopInvoke("file_tool_read_text", { path, encoding }), offset, limit) },
  "file.write_text": { execute: ({ path, text }) => desktopInvoke("file_tool_write_text", { path, text, encoding: "UTF-8", bom: false }) },
  "file.preview_write": {
    execute: async ({ path, text }) => {
      const old = await desktopInvoke("file_tool_read_text", { path, encoding: "UTF-8" });
      return { path, diff: buildTextDiff(textOf(old), text), oldText: textOf(old), newText: text };
    },
  },
  "file.list_directory": { execute: ({ path }) => desktopInvoke("file_tool_list_directory", { path }) },
  // ── 引擎自身 ───────────────────────────────────────────────
  "spill.read": {
    execute: async ({ key, offset, limit, keyword }) => {
      const target = String(key || "").trim();
      if (target === "list") return { list: await spillStore.list() };
      const body = await spillStore.read(target);
      if (body == null) {
        throw Object.assign(Error(`找不到 ${target}：可能已过期（保留 7 天 / 最多 30 份）或不是本次运行写下的`), { code: "SPILL_NOT_FOUND" });
      }
      return { key: target, ...readSpillResult(body, { offset, limit, keyword }) };
    },
  },
  // ── 数据库（桌面独占） ─────────────────────────────────────
  "db.query_readonly": {
    execute: ({ connId, sql }) => {
      if (!isReadOnlySql(sql)) throw Error("只读查询工具拒绝执行写入 SQL");
      return desktopInvoke("db_query_readonly", { connId, sql });
    },
  },
  // ── 加密 ───────────────────────────────────────────────────
  "crypto.hash": { execute: ({ text, algorithm = "SHA-256", output = "hex" }) => digestText(text, algorithm, output) },
  "crypto.hmac": { execute: ({ text, secret, algorithm = "SHA-256", output = "hex" }) => hmacText(text, secret, algorithm, output) },
  "crypto.password": { execute: (args) => ({ password: generatePassword(args) }) },
  // ── 网络（桌面独占 + HTTP） ────────────────────────────────
  "network.ping": { execute: ({ target, count = 4 }) => desktopInvoke("network_ping", { target, count }) },
  "network.trace": { execute: ({ target, maxHops = 10 }) => desktopInvoke("network_trace", { target, maxHops }) },
  "network.dns": { execute: ({ host }) => desktopInvoke("network_dns_lookup", { host }) },
  "network.tcp_check": { execute: ({ host, port }) => desktopInvoke("network_tcp_check", { host, port }) },
  "http.request": {
    execute: ({ method, url, headers = [], body, timeoutMs = 20000 }) =>
      invoke("http_request", { method, url, headers: headers.map((h) => [h.name, h.value]), body: body ?? null, timeoutMs }),
  },
  // ── 图像 ───────────────────────────────────────────────────
  "image.plan": {
    execute: ({ width, height, maxWidth, maxHeight, cropRatio = 0, rotation = 0, allowUpscale = false }) => ({
      contain: calculateContainSize(width, height, maxWidth || width, maxHeight || height, allowUpscale),
      crop: calculateCenterCrop(width, height, cropRatio),
      renderPlan: calculateRenderPlan(width, height, { cropRatio, rotation }),
    }),
  },
  // 工具包自带的动作实现（生成物）：迁进 src/tools/<key>/ 的工具在这里并入，
  // 手写区会随迁移逐块缩小、最终清空。
  ...TOOL_EXECUTORS,
});
