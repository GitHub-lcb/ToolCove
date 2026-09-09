import { parseJson, formatJson } from '../json.js';
import { encodeBase64, decodeBase64 } from '../convert.js';
import { yamlToJson } from '../tools/yaml.js';
import { buildTextDiff } from '../textDiff.js';
import { parseTimestamp } from '../timeTool.js';
import { generateIdentifiers } from '../generatorTool.js';
import { createToolRegistry } from './runtime.js';
import { desktopInvoke } from './transport.js';
import { isReadOnlySql } from '../db.js';

const text = { type: 'string', maxLength: 16000 };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const unwrap = (result, key) => { if (!result.ok) throw Error(result.error?.message || '数据格式错误'); return result[key]; };
export function createBuiltinRegistry() {
  return createToolRegistry([
    { name: 'json.parse', description: '解析 JSON', descriptionKey: 'agent.toolJsonParse', toolKey: 'json', risk: 'transform', retryable: false, inputSchema: schema({ text }, ['text']), execute: ({ text }) => unwrap(parseJson(text), 'value') },
    { name: 'json.format', description: '格式化 JSON', descriptionKey: 'agent.toolJsonFormat', toolKey: 'json', risk: 'transform', retryable: false, inputSchema: schema({ text, indent: { type: 'integer', minimum: 0, maximum: 8 } }, ['text']), execute: ({ text, indent = 2 }) => unwrap(formatJson(text, indent), 'output') },
    { name: 'base64.encode', description: 'UTF-8 文本转 Base64', descriptionKey: 'agent.toolBase64Encode', toolKey: 'convert', risk: 'transform', retryable: false, inputSchema: schema({ text }, ['text']), execute: ({ text }) => encodeBase64(text) },
    { name: 'base64.decode', description: 'Base64 转 UTF-8 文本', descriptionKey: 'agent.toolBase64Decode', toolKey: 'convert', risk: 'transform', retryable: false, inputSchema: schema({ text }, ['text']), execute: ({ text }) => decodeBase64(text) },
    { name: 'yaml.to_json', description: 'YAML 转 JSON', descriptionKey: 'agent.toolYamlToJson', toolKey: 'json', risk: 'transform', retryable: false, inputSchema: schema({ text }, ['text']), execute: ({ text }) => unwrap(yamlToJson(text), 'output') },
    { name: 'text.diff', description: '逐行比较两段文本，返回变更行与统计', descriptionKey: 'agent.toolTextDiff', toolKey: 'diff', risk: 'transform', retryable: false, inputSchema: schema({ left: text, right: text }, ['left', 'right']), execute: ({ left, right }) => buildTextDiff(left, right) },
    { name: 'time.timestamp', description: '时间戳转换为 UTC ISO 日期，明确秒或毫秒', descriptionKey: 'agent.toolTimeTimestamp', toolKey: 'time', risk: 'transform', retryable: false, inputSchema: schema({ text, unit: { type: 'string', enum: ['auto', 'seconds', 'milliseconds'] } }, ['text']), execute: ({ text, unit = 'auto' }) => parseTimestamp(text, unit) },
    { name: 'id.generate', description: '生成 UUID / ULID / NanoID，最多 100 个', descriptionKey: 'agent.toolIdGenerate', toolKey: 'generator', risk: 'transform', retryable: false, inputSchema: schema({ type: { type: 'string', enum: ['uuid-v4', 'uuid-v7', 'ulid', 'nanoid'] }, count: { type: 'integer', minimum: 1, maximum: 100 } }, ['type']), execute: ({ type, count = 1 }) => generateIdentifiers(type, count) },
    { name: 'file.inspect', description: '读取文件元信息，不读取内容', descriptionKey: 'agent.toolFileInspect', toolKey: 'file', risk: 'read', retryable: false, inputSchema: schema({ paths: { type: 'array', maxItems: 100, items: text } }, ['paths']), execute: ({ paths }) => desktopInvoke('file_tool_inspect', { paths }) },
    { name: 'file.read_text', description: '读取 UTF-8 文本文件', descriptionKey: 'agent.toolFileReadText', toolKey: 'file', risk: 'read', retryable: false, inputSchema: schema({ path: text, encoding: { type: 'string', enum: ['AUTO', 'UTF-8', 'GBK'] } }, ['path']), execute: ({ path, encoding = 'AUTO' }) => desktopInvoke('file_tool_read_text', { path, encoding }) },
    { name: 'file.write_text', description: '写入文本文件，执行前展示变更并确认', descriptionKey: 'agent.toolFileWriteText', toolKey: 'file', risk: 'write', retryable: false, inputSchema: schema({ path: text, text }, ['path', 'text']), execute: ({ path, text }) => desktopInvoke('file_tool_write_text', { path, text, encoding: 'UTF-8', bom: false }) },
    { name: 'file.preview_write', description: '读取文件并生成写入前的 Diff，不产生副作用', descriptionKey: 'agent.toolFilePreviewWrite', toolKey: 'file', risk: 'read', retryable: false, inputSchema: schema({ path: text, text }, ['path', 'text']), execute: async ({ path, text }) => { const old = await desktopInvoke('file_tool_read_text', { path, encoding: 'UTF-8' }); const left = typeof old === 'string' ? old : old?.text || old?.content || ''; return { path, diff: buildTextDiff(left, text), oldText: left, newText: text }; } },
    { name: 'file.list_directory', description: '列出目录内容', descriptionKey: 'agent.toolFileListDirectory', toolKey: 'file', risk: 'read', retryable: false, inputSchema: schema({ path: text }, ['path']), execute: ({ path }) => desktopInvoke('file_tool_list_directory', { path }) },
    { name: 'db.query_readonly', description: '执行数据库只读查询，禁止写入', descriptionKey: 'agent.toolDbQueryReadonly', toolKey: 'db', risk: 'database', retryable: false, inputSchema: schema({ connId: text, sql: text }, ['connId', 'sql']), execute: ({ connId, sql }) => { if (!isReadOnlySql(sql)) throw Error('只读查询工具拒绝执行写入 SQL'); return desktopInvoke('db_query_readonly', { connId, sql }); } },
  ]);
}

// 工具名清单从 registry 派生，永不与上面的定义漂移；供 normalizeAgent 校验停用清单
export const AGENT_TOOL_NAMES = Object.freeze(createBuiltinRegistry().list().map((t) => t.name));

