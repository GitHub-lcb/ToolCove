// Agent 工具目录：**只有元数据，不 import 任何工具实现**。
//
// 为什么单独一层：这一层要在首屏就被读到（设置页归一化要用工具名全集、能力面板要工具清单与风险分级），
// 而实现层会牵出 luxon / js-yaml / hash-wasm / 各工具模块（实测约 300KB）。
// 早先 tools.js 在模块加载时就 createBuiltinRegistry()，于是这些依赖被拖进了启动阶段。
//
// 与实现的一致性由 catalog.test.js 强制：实现里有的工具目录必须有，反之亦然，
// 且 risk / desktopOnly / previewBefore / confirm / retryable 必须两边一致——
// 否则「目录说有、实际没有」会让规划器选中一个注定失败的工具。
export const AGENT_TOOL_CATALOG = Object.freeze([
  // ── 数据与文本 ─────────────────────────────────────────────
  { name: "json.parse", description: "解析 JSON", descriptionKey: "agent.toolJsonParse", toolKey: "json", risk: "transform", retryable: false },
  { name: "json.format", description: "格式化 JSON", descriptionKey: "agent.toolJsonFormat", toolKey: "json", risk: "transform", retryable: false },
  { name: "base64.encode", description: "UTF-8 文本转 Base64", descriptionKey: "agent.toolBase64Encode", toolKey: "convert", risk: "transform", retryable: false },
  { name: "base64.decode", description: "Base64 转 UTF-8 文本", descriptionKey: "agent.toolBase64Decode", toolKey: "convert", risk: "transform", retryable: false },
  { name: "yaml.to_json", description: "YAML 转 JSON", descriptionKey: "agent.toolYamlToJson", toolKey: "json", risk: "transform", retryable: false },
  { name: "text.diff", description: "逐行比较两段文本，返回变更行与统计", descriptionKey: "agent.toolTextDiff", toolKey: "diff", risk: "transform", retryable: false },
  { name: "time.timestamp", description: "时间戳转换为 UTC ISO 日期，明确秒或毫秒", descriptionKey: "agent.toolTimeTimestamp", toolKey: "time", risk: "transform", retryable: false },
  { name: "id.generate", description: "生成 UUID / ULID / NanoID，最多 100 个", descriptionKey: "agent.toolIdGenerate", toolKey: "generator", risk: "transform", retryable: false },
  { name: "table.parse", description: "解析 CSV/TSV 等分隔文本：分隔符可自动嗅探，返回表头、前若干行、是否被截断与行列统计（空值数、重复行数、最长单元格）", descriptionKey: "agent.toolTableParse", toolKey: "table", risk: "transform", retryable: false },
  { name: "table.convert", description: "把分隔文本转成目标格式：json / markdown / sql（INSERT 语句，值按字符串转义不做类型推断）/ csv / tsv", descriptionKey: "agent.toolTableConvert", toolKey: "table", risk: "transform", retryable: false },
  { name: "xml.format", description: "格式化 XML 报文（缩进）；报文不合法时抛出带行列位置的错误", descriptionKey: "agent.toolXmlFormat", toolKey: "xml", risk: "transform", retryable: false },
  { name: "xml.to_json", description: "XML 报文转 JSON：属性带 @ 前缀、文本进 #text、同名重复元素成数组", descriptionKey: "agent.toolXmlToJson", toolKey: "xml", risk: "transform", retryable: false },
  { name: "xml.validate", description: "校验 XML 良构性，返回错误码与行列位置；不合法也不抛异常，适合先诊断再修", descriptionKey: "agent.toolXmlValidate", toolKey: "xml", risk: "transform", retryable: false },
  { name: "schema.infer", description: "从一段 JSON 文本推断 JSON Schema（输入是 JSON 文本，不是已解析的对象）", descriptionKey: "agent.toolSchemaInfer", toolKey: "schema", risk: "transform", retryable: false },
  { name: "schema.validate", description: "用 JSON Schema 校验 JSON 文本，返回 valid 与全部错误路径（value 与 schemaText 都是 JSON 文本）", descriptionKey: "agent.toolSchemaValidate", toolKey: "schema", risk: "transform", retryable: false },
  { name: "markdown.normalize", description: "规范化 Markdown：全角空格转半角、列表符号统一为 -、标题前后补空行、压缩连续空行；代码块内部一律不动", descriptionKey: "agent.toolMarkdownNormalize", toolKey: "markdown", risk: "transform", retryable: false },
  { name: "markdown.lint", description: "检查 Markdown 的问题并返回错误码与行号（未闭合代码块、标题层级跳跃、表格列数不一致等）", descriptionKey: "agent.toolMarkdownLint", toolKey: "markdown", risk: "transform", retryable: false },
  // ── 文件（桌面独占） ───────────────────────────────────────
  { name: "file.inspect", description: "读取文件元信息，不读取内容", descriptionKey: "agent.toolFileInspect", toolKey: "file", risk: "read", retryable: false, desktopOnly: true },
  { name: "file.read_text", description: "读取 UTF-8 文本文件；大文件用 offset/limit 分段读（offset 为 0 基字符位置）", descriptionKey: "agent.toolFileReadText", toolKey: "file", risk: "read", retryable: false, desktopOnly: true, concurrencySafe: true },
  { name: "file.write_text", description: "写入文本文件，必须先用 file.read_text 读过该文件，或先用 file.inspect 确认它不存在（新建）", descriptionKey: "agent.toolFileWriteText", toolKey: "file", risk: "write", retryable: false, desktopOnly: true, previewBefore: true },
  { name: "file.preview_write", description: "读取文件并生成写入前的 Diff，不产生副作用；会读内容，因此同时满足写入前的读取要求", descriptionKey: "agent.toolFilePreviewWrite", toolKey: "file", risk: "read", retryable: false, desktopOnly: true, concurrencySafe: true },
  { name: "file.list_directory", description: "列出目录内容", descriptionKey: "agent.toolFileListDirectory", toolKey: "file", risk: "read", retryable: false, desktopOnly: true, concurrencySafe: true },
  // ── 引擎自身 ───────────────────────────────────────────────
  { name: "spill.read", description: "读回被裁剪的大结果：先查清单拿 key（工具结果里的 spill:<name>），再用 offset/limit 分段读或 keyword 定位", descriptionKey: "agent.toolSpillRead", toolKey: "agent", risk: "read", retryable: false, concurrencySafe: true },
  // ── 数据库（桌面独占） ─────────────────────────────────────
  { name: "db.query_readonly", description: "执行数据库只读查询，禁止写入", descriptionKey: "agent.toolDbQueryReadonly", toolKey: "db", risk: "database", retryable: false, desktopOnly: true },
  // ── 加密 ───────────────────────────────────────────────────
  { name: "crypto.hash", description: "计算文本的哈希摘要（MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512）", descriptionKey: "agent.toolCryptoHash", toolKey: "crypto", risk: "transform", retryable: false },
  { name: "crypto.hmac", description: "用密钥计算 HMAC 消息签名", descriptionKey: "agent.toolCryptoHmac", toolKey: "crypto", risk: "transform", retryable: false },
  { name: "crypto.password", description: "生成强随机密码，可选长度与字符集", descriptionKey: "agent.toolCryptoPassword", toolKey: "crypto", risk: "transform", retryable: false },
  // ── 网络（桌面独占 + HTTP） ────────────────────────────────
  { name: "network.ping", description: "Ping 目标主机（仅桌面版）", descriptionKey: "agent.toolNetworkPing", toolKey: "network", risk: "read", retryable: false, desktopOnly: true },
  { name: "network.trace", description: "路由跟踪目标主机（仅桌面版，最多 10 跳）", descriptionKey: "agent.toolNetworkTrace", toolKey: "network", risk: "read", retryable: false, desktopOnly: true },
  { name: "network.dns", description: "查询主机的 DNS 解析地址（仅桌面版）", descriptionKey: "agent.toolNetworkDns", toolKey: "network", risk: "read", retryable: false, desktopOnly: true },
  { name: "network.tcp_check", description: "检测目标主机端口是否可连接（仅桌面版）", descriptionKey: "agent.toolNetworkTcpCheck", toolKey: "network", risk: "read", retryable: false, desktopOnly: true },
  { name: "http.request", description: "发送 HTTP 请求并返回状态码、响应头与响应体（浏览器端受 CORS 限制）", descriptionKey: "agent.toolHttpRequest", toolKey: "request", risk: "write", retryable: false },
  // ── 图像 ───────────────────────────────────────────────────
  { name: "image.plan", description: "按源图尺寸计算等比缩放、居中裁剪与旋转后的输出尺寸计划", descriptionKey: "agent.toolImagePlan", toolKey: "image", risk: "transform", retryable: false },
  // ── 业务数据（实现见 dataTools.js） ────────────────────────
  { name: "data.query", descriptionKey: "agent.toolDataQuery", description: "检索本地业务数据（kind：snippets 速记 / problems 问题 / iterations 迭代 / domains 领域 / pools 池 / releases 发布），支持关键词、标签、状态过滤，返回按更新时间倒序的 {total, items} 摘要", toolKey: "data", risk: "read", retryable: false },
  { name: "data.get", descriptionKey: "agent.toolDataGet", description: "按 id 读取一条完整的本地业务数据（先用 data.query 拿到 id；kind 同 data.query）", toolKey: "data", risk: "read", retryable: false },
  { name: "data.create", descriptionKey: "agent.toolDataCreate", description: "新建一条本地业务数据（kind 同 data.query）。draft 必填：snippets/problems 用 title，domains 用 name，pools 用 domainId+name，iterations 用 title+version，releases 用 name", toolKey: "data", risk: "write", retryable: false },
  { name: "data.update", descriptionKey: "agent.toolDataUpdate", description: "按 id 修改一条本地业务数据（kind 同 data.query）。可改字段：snippets→title/category/content/pinned；problems→title/type/status/tags/note/resolution；iterations→title/version/status/releaseDate/goal/domainIds；domains→name/note；pools→name/note/path；releases→name/codingProject", toolKey: "data", risk: "write", retryable: false },
  { name: "data.remove", descriptionKey: "agent.toolDataRemove", description: "删除一条本地业务数据（速记/问题会同步删除到其他设备；不可恢复）。执行前必须由用户确认", toolKey: "data", risk: "write", retryable: false, confirm: "always" },
]);

/** 工具名全集（设置归一化与能力面板共用，单一真相源）。 */
export const AGENT_TOOL_NAMES = Object.freeze(AGENT_TOOL_CATALOG.map((tool) => tool.name));

/** 名字 → 元数据。 */
export const AGENT_TOOL_BY_NAME = new Map(AGENT_TOOL_CATALOG.map((tool) => [tool.name, tool]));
