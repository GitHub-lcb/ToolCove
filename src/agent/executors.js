// Agent 工具的实现层：**只有 execute 与 inputSchema，不含元数据**（元数据在 catalog.js）。
//
// 为什么拆开：这一层会牵出 luxon / js-yaml / hash-wasm / 各工具模块（实测约 300KB），
// 只有真正要跑 Agent 时才需要加载。首屏只需要 catalog（设置归一化 + 能力面板）。
// 运行期装配见 tools.js 的 buildAgentRegistry（动态 import 本模块）。
import { parseJson, formatJson } from '../json.js';
import { encodeBase64, decodeBase64 } from '../convert.js';
import { yamlToJson } from '../tools/yaml.js';
import { buildTextDiff } from '../textDiff.js';
import { parseTimestamp } from '../timeTool.js';
import { generateIdentifiers } from '../generatorTool.js';
import { desktopInvoke } from './transport.js';
import { invoke } from '../platform/invoke.js';
import { isReadOnlySql } from '../db.js';
import { digestText, generatePassword, hmacText } from '../cryptoTool.js';
import { calculateCenterCrop, calculateContainSize, calculateRenderPlan } from '../imageTool.js';
import { readSpillResult, readWindowResult } from './readWindow.js';
import { spillStore } from './spillStoreInstance.js';

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

/** 名字 → { inputSchema, execute }。与 catalog.js 的键集合必须一致（由 catalog.test.js 强制）。 */
export const BUILTIN_TOOL_IMPLS = Object.freeze({
  'json.parse': { inputSchema: schema({ text }, ['text']), execute: ({ text }) => unwrap(parseJson(text), 'value') },
  'json.format': { inputSchema: schema({ text, indent: { type: 'integer', minimum: 0, maximum: 8 } }, ['text']), execute: ({ text, indent = 2 }) => unwrap(formatJson(text, indent), 'output') },
  'base64.encode': { inputSchema: schema({ text }, ['text']), execute: ({ text }) => encodeBase64(text) },
  'base64.decode': { inputSchema: schema({ text }, ['text']), execute: ({ text }) => decodeBase64(text) },
  'yaml.to_json': { inputSchema: schema({ text }, ['text']), execute: ({ text }) => unwrap(yamlToJson(text), 'output') },
  'text.diff': { inputSchema: schema({ left: text, right: text }, ['left', 'right']), execute: ({ left, right }) => buildTextDiff(left, right) },
  'time.timestamp': { inputSchema: schema({ text, unit: { type: 'string', enum: ['auto', 'seconds', 'milliseconds'] } }, ['text']), execute: ({ text, unit = 'auto' }) => parseTimestamp(text, unit) },
  'id.generate': { inputSchema: schema({ type: { type: 'string', enum: ['uuid-v4', 'uuid-v7', 'ulid', 'nanoid'] }, count: { type: 'integer', minimum: 1, maximum: 100 } }, ['type']), execute: ({ type, count = 1 }) => generateIdentifiers(type, count) },
  'file.inspect': { inputSchema: schema({ paths: { type: 'array', maxItems: 100, items: text } }, ['paths']), execute: ({ paths }) => desktopInvoke('file_tool_inspect', { paths }) },
  'file.read_text': { inputSchema: schema({ path: text, encoding: { type: 'string', enum: ['AUTO', 'UTF-8', 'GBK'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32000 } }, ['path']), execute: async ({ path, encoding = 'AUTO', offset, limit }) => withWindow(await desktopInvoke('file_tool_read_text', { path, encoding }), offset, limit) },
  'file.write_text': { inputSchema: schema({ path: text, text }, ['path', 'text']), execute: ({ path, text }) => desktopInvoke('file_tool_write_text', { path, text, encoding: 'UTF-8', bom: false }) },
  'file.preview_write': { inputSchema: schema({ path: text, text }, ['path', 'text']), execute: async ({ path, text }) => { const old = await desktopInvoke('file_tool_read_text', { path, encoding: 'UTF-8' }); return { path, diff: buildTextDiff(textOf(old), text), oldText: textOf(old), newText: text }; } },
  'file.list_directory': { inputSchema: schema({ path: text }, ['path']), execute: ({ path }) => desktopInvoke('file_tool_list_directory', { path }) },
  'spill.read': { inputSchema: schema({ key: text, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32000 }, keyword: text }, ['key']), execute: async ({ key, offset, limit, keyword }) => { const target = String(key || '').trim(); if (target === 'list') return { list: await spillStore.list() }; const body = await spillStore.read(target); if (body == null) throw Object.assign(Error(`找不到 ${target}：可能已过期（保留 7 天 / 最多 30 份）或不是本次运行写下的`), { code: 'SPILL_NOT_FOUND' }); return { key: target, ...readSpillResult(body, { offset, limit, keyword }) }; } },
  'db.query_readonly': { inputSchema: schema({ connId: text, sql: text }, ['connId', 'sql']), execute: ({ connId, sql }) => { if (!isReadOnlySql(sql)) throw Error('只读查询工具拒绝执行写入 SQL'); return desktopInvoke('db_query_readonly', { connId, sql }); } },
  'crypto.hash': { inputSchema: schema({ text, algorithm: { type: 'string', enum: ['MD5', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] }, output: { type: 'string', enum: ['hex', 'base64'] } }, ['text']), execute: ({ text, algorithm = 'SHA-256', output = 'hex' }) => digestText(text, algorithm, output) },
  'crypto.hmac': { inputSchema: schema({ text, secret: text, algorithm: { type: 'string', enum: ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] }, output: { type: 'string', enum: ['hex', 'base64'] } }, ['text', 'secret']), execute: ({ text, secret, algorithm = 'SHA-256', output = 'hex' }) => hmacText(text, secret, algorithm, output) },
  'crypto.password': { inputSchema: schema({ length: { type: 'integer', minimum: 4, maximum: 128 }, uppercase: { type: 'boolean' }, lowercase: { type: 'boolean' }, numbers: { type: 'boolean' }, symbols: { type: 'boolean' }, excludeAmbiguous: { type: 'boolean' } }, []), execute: (args) => ({ password: generatePassword(args) }) },
  'network.ping': { inputSchema: schema({ target: text, count: { type: 'integer', minimum: 1, maximum: 10 } }, ['target']), execute: ({ target, count = 4 }) => desktopInvoke('network_ping', { target, count }) },
  'network.trace': { inputSchema: schema({ target: text, maxHops: { type: 'integer', minimum: 1, maximum: 10 } }, ['target']), execute: ({ target, maxHops = 10 }) => desktopInvoke('network_trace', { target, maxHops }) },
  'network.dns': { inputSchema: schema({ host: text }, ['host']), execute: ({ host }) => desktopInvoke('network_dns_lookup', { host }) },
  'network.tcp_check': { inputSchema: schema({ host: text, port: { type: 'integer', minimum: 1, maximum: 65535 } }, ['host', 'port']), execute: ({ host, port }) => desktopInvoke('network_tcp_check', { host, port }) },
  'http.request': { inputSchema: schema({ method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] }, url: text, headers: { type: 'array', maxItems: 30, items: { type: 'object', properties: { name: text, value: text }, required: ['name', 'value'], additionalProperties: false } }, body: text, timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 } }, ['method', 'url']), execute: ({ method, url, headers = [], body, timeoutMs = 20000 }) => invoke('http_request', { method, url, headers: headers.map((h) => [h.name, h.value]), body: body ?? null, timeoutMs }) },
  'image.plan': { inputSchema: schema({ width: { type: 'integer', minimum: 1, maximum: 100000 }, height: { type: 'integer', minimum: 1, maximum: 100000 }, maxWidth: { type: 'integer', minimum: 1, maximum: 100000 }, maxHeight: { type: 'integer', minimum: 1, maximum: 100000 }, cropRatio: { type: 'number', minimum: 0, maximum: 10 }, rotation: { type: 'integer', enum: [0, 90, 180, 270] }, allowUpscale: { type: 'boolean' } }, ['width', 'height']), execute: ({ width, height, maxWidth, maxHeight, cropRatio = 0, rotation = 0, allowUpscale = false }) => ({ contain: calculateContainSize(width, height, maxWidth || width, maxHeight || height, allowUpscale), crop: calculateCenterCrop(width, height, cropRatio), renderPlan: calculateRenderPlan(width, height, { cropRatio, rotation }) }) },
});
