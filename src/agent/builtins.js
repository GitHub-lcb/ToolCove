import { parseJson, formatJson } from '../json.js';
import { encodeBase64, decodeBase64 } from '../convert.js';
import { yamlToJson } from '../tools/yaml.js';
import { buildTextDiff } from '../textDiff.js';
import { parseTimestamp } from '../timeTool.js';
import { generateIdentifiers } from '../generatorTool.js';
import { createToolRegistry } from './runtime.js';
import { desktopInvoke } from './transport.js';
import { invoke } from '../platform/invoke.js';
import { isReadOnlySql } from '../db.js';
import { digestText, generatePassword, hmacText } from '../cryptoTool.js';
import { calculateCenterCrop, calculateContainSize, calculateRenderPlan } from '../imageTool.js';
import { readSpillResult, readWindowResult } from './readWindow.js';
import { createSpillStore } from './spillStore.js';

/**
 * 默认 spill 存储。运行期（session.js）与 spill.read 工具共用同一份，否则工具读不到 runtime 写下的东西。
 * 测试注入 globalThis.__tcSpillStore 即可替换成内存实现。
 */
export const spillStore = globalThis.__tcSpillStore || createSpillStore();

const text = { type: 'string', maxLength: 16000 };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const unwrap = (result, key) => { if (!result.ok) throw Error(result.error?.message || '数据格式错误'); return result[key]; };

/** 取出 invoke 回来的文本字段（Rust 侧返回对象 { text, encoding, ... }）。 */
const textOf = (result) => (typeof result === 'string' ? result : result?.text ?? result?.content ?? '');

/** 把窗口结果贴回原文的元信息对象，保留 encoding/hasBom/lossy 等字段。 */
function withWindow(result, offset, limit) {
  const source = textOf(result);
  const window = readWindowResult(source, { offset, limit });
  const base = result && typeof result === 'object' ? result : {};
  return { ...base, text: window.text, totalChars: window.totalChars, totalLines: window.totalLines, windowLine: window.windowLine, hasMore: window.hasMore, nextOffset: window.nextOffset, note: window.note };
}

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
    { name: 'file.inspect', description: '读取文件元信息，不读取内容', descriptionKey: 'agent.toolFileInspect', toolKey: 'file', risk: 'read', retryable: false, desktopOnly: true, inputSchema: schema({ paths: { type: 'array', maxItems: 100, items: text } }, ['paths']), execute: ({ paths }) => desktopInvoke('file_tool_inspect', { paths }) },
    { name: 'file.read_text', description: '读取 UTF-8 文本文件；大文件用 offset/limit 分段读（offset 为 0 基字符位置）', descriptionKey: 'agent.toolFileReadText', toolKey: 'file', risk: 'read', retryable: false, desktopOnly: true, concurrencySafe: true, inputSchema: schema({ path: text, encoding: { type: 'string', enum: ['AUTO', 'UTF-8', 'GBK'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32000 } }, ['path']), execute: async ({ path, encoding = 'AUTO', offset, limit }) => withWindow(await desktopInvoke('file_tool_read_text', { path, encoding }), offset, limit) },
    { name: 'file.write_text', description: '写入文本文件，必须先用 file.read_text 读过该文件，或先用 file.inspect 确认它不存在（新建）', descriptionKey: 'agent.toolFileWriteText', toolKey: 'file', risk: 'write', retryable: false, desktopOnly: true, previewBefore: true, inputSchema: schema({ path: text, text }, ['path', 'text']), execute: ({ path, text }) => desktopInvoke('file_tool_write_text', { path, text, encoding: 'UTF-8', bom: false }) },
    { name: 'file.preview_write', description: '读取文件并生成写入前的 Diff，不产生副作用；会读内容，因此同时满足写入前的读取要求', descriptionKey: 'agent.toolFilePreviewWrite', toolKey: 'file', risk: 'read', retryable: false, desktopOnly: true, concurrencySafe: true, inputSchema: schema({ path: text, text }, ['path', 'text']), execute: async ({ path, text }) => { const old = await desktopInvoke('file_tool_read_text', { path, encoding: 'UTF-8' }); return { path, diff: buildTextDiff(textOf(old), text), oldText: textOf(old), newText: text }; } },
    { name: 'file.list_directory', description: '列出目录内容', descriptionKey: 'agent.toolFileListDirectory', toolKey: 'file', risk: 'read', retryable: false, desktopOnly: true, concurrencySafe: true, inputSchema: schema({ path: text }, ['path']), execute: ({ path }) => desktopInvoke('file_tool_list_directory', { path }) },
    { name: 'spill.read', description: '读回被裁剪的大结果：先查清单拿 key（工具结果里的 spill:<name>），再用 offset/limit 分段读或 keyword 定位', descriptionKey: 'agent.toolSpillRead', toolKey: 'agent', risk: 'read', retryable: false, concurrencySafe: true, inputSchema: schema({ key: text, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32000 }, keyword: text }, ['key']), execute: async ({ key, offset, limit, keyword }) => { const target = String(key || '').trim(); if (target === 'list') return { list: await spillStore.list() }; const body = await spillStore.read(target); if (body == null) throw Object.assign(Error(`找不到 ${target}：可能已过期（保留 7 天 / 最多 30 份）或不是本次运行写下的`), { code: 'SPILL_NOT_FOUND' }); return { key: target, ...readSpillResult(body, { offset, limit, keyword }) }; } },
    { name: 'db.query_readonly', description: '执行数据库只读查询，禁止写入', descriptionKey: 'agent.toolDbQueryReadonly', toolKey: 'db', risk: 'database', retryable: false, desktopOnly: true, inputSchema: schema({ connId: text, sql: text }, ['connId', 'sql']), execute: ({ connId, sql }) => { if (!isReadOnlySql(sql)) throw Error('只读查询工具拒绝执行写入 SQL'); return desktopInvoke('db_query_readonly', { connId, sql }); } },
    { name: 'crypto.hash', description: '计算文本的哈希摘要（MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512）', descriptionKey: 'agent.toolCryptoHash', toolKey: 'crypto', risk: 'transform', retryable: false, inputSchema: schema({ text, algorithm: { type: 'string', enum: ['MD5', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] }, output: { type: 'string', enum: ['hex', 'base64'] } }, ['text']), execute: ({ text, algorithm = 'SHA-256', output = 'hex' }) => digestText(text, algorithm, output) },
    { name: 'crypto.hmac', description: '用密钥计算 HMAC 消息签名', descriptionKey: 'agent.toolCryptoHmac', toolKey: 'crypto', risk: 'transform', retryable: false, inputSchema: schema({ text, secret: text, algorithm: { type: 'string', enum: ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] }, output: { type: 'string', enum: ['hex', 'base64'] } }, ['text', 'secret']), execute: ({ text, secret, algorithm = 'SHA-256', output = 'hex' }) => hmacText(text, secret, algorithm, output) },
    { name: 'crypto.password', description: '生成强随机密码，可选长度与字符集', descriptionKey: 'agent.toolCryptoPassword', toolKey: 'crypto', risk: 'transform', retryable: false, inputSchema: schema({ length: { type: 'integer', minimum: 4, maximum: 128 }, uppercase: { type: 'boolean' }, lowercase: { type: 'boolean' }, numbers: { type: 'boolean' }, symbols: { type: 'boolean' }, excludeAmbiguous: { type: 'boolean' } }, []), execute: (args) => ({ password: generatePassword(args) }) },
    { name: 'network.ping', description: 'Ping 目标主机（仅桌面版）', descriptionKey: 'agent.toolNetworkPing', toolKey: 'network', risk: 'read', retryable: false, desktopOnly: true, inputSchema: schema({ target: text, count: { type: 'integer', minimum: 1, maximum: 10 } }, ['target']), execute: ({ target, count = 4 }) => desktopInvoke('network_ping', { target, count }) },
    { name: 'network.trace', description: '路由跟踪目标主机（仅桌面版，最多 10 跳）', descriptionKey: 'agent.toolNetworkTrace', toolKey: 'network', risk: 'read', retryable: false, desktopOnly: true, inputSchema: schema({ target: text, maxHops: { type: 'integer', minimum: 1, maximum: 10 } }, ['target']), execute: ({ target, maxHops = 10 }) => desktopInvoke('network_trace', { target, maxHops }) },
    { name: 'network.dns', description: '查询主机的 DNS 解析地址（仅桌面版）', descriptionKey: 'agent.toolNetworkDns', toolKey: 'network', risk: 'read', retryable: false, desktopOnly: true, inputSchema: schema({ host: text }, ['host']), execute: ({ host }) => desktopInvoke('network_dns_lookup', { host }) },
    { name: 'network.tcp_check', description: '检测目标主机端口是否可连接（仅桌面版）', descriptionKey: 'agent.toolNetworkTcpCheck', toolKey: 'network', risk: 'read', retryable: false, desktopOnly: true, inputSchema: schema({ host: text, port: { type: 'integer', minimum: 1, maximum: 65535 } }, ['host', 'port']), execute: ({ host, port }) => desktopInvoke('network_tcp_check', { host, port }) },
    { name: 'http.request', description: '发送 HTTP 请求并返回状态码、响应头与响应体（浏览器端受 CORS 限制）', descriptionKey: 'agent.toolHttpRequest', toolKey: 'request', risk: 'write', retryable: false, inputSchema: schema({ method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] }, url: text, headers: { type: 'array', maxItems: 30, items: { type: 'object', properties: { name: text, value: text }, required: ['name', 'value'], additionalProperties: false } }, body: text, timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 } }, ['method', 'url']), execute: ({ method, url, headers = [], body, timeoutMs = 20000 }) => invoke('http_request', { method, url, headers: headers.map((h) => [h.name, h.value]), body: body ?? null, timeoutMs }) },
    { name: 'image.plan', description: '按源图尺寸计算等比缩放、居中裁剪与旋转后的输出尺寸计划', descriptionKey: 'agent.toolImagePlan', toolKey: 'image', risk: 'transform', retryable: false, inputSchema: schema({ width: { type: 'integer', minimum: 1, maximum: 100000 }, height: { type: 'integer', minimum: 1, maximum: 100000 }, maxWidth: { type: 'integer', minimum: 1, maximum: 100000 }, maxHeight: { type: 'integer', minimum: 1, maximum: 100000 }, cropRatio: { type: 'number', minimum: 0, maximum: 10 }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, allowUpscale: { type: 'boolean' } }, ['width', 'height']), execute: ({ width, height, maxWidth, maxHeight, cropRatio = 0, rotation = 0, allowUpscale = false }) => ({ contain: calculateContainSize(width, height, maxWidth || width, maxHeight || height, allowUpscale), crop: calculateCenterCrop(width, height, cropRatio), renderPlan: calculateRenderPlan(width, height, { cropRatio, rotation }) }) },
  ]);
}


