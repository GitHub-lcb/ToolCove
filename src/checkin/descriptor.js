// 站点描述文件：校验与归一化。
//
// 设计前提：**接口契约还没定下来**（要等抓包），所以这里不写死任何站点，
// 而是把「一次签到要发什么、怎么从响应里读状态」全部交给用户填的一份 JSON。
// 好处是接口到手后只填数据、不改代码；代价是填错的可能性很高，
// 所以本模块的重点不是「能解析」，而是「填错时绝不发出请求，并把错在哪一条指出来」。
import { parsePath } from "./paths.js";
import { placeholdersIn } from "./extract.js";

// RFC 7230 的 token 字符集：header 名不允许出现分隔符，否则会变成请求走私。
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SITE_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT"]);

// 上限是为了把「手滑粘了一整篇文档进来」挡在磁盘和网络上之外。
export const MAX_BODY = 8192;
export const MAX_HEADER_VALUE = 4096;
export const MAX_PATH = 512;
export const MAX_HEADERS = 20;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function err(field, code) {
  return { field, code };
}

/**
 * URL 路径的校验。三个坑：
 * 1. 必须以 / 开头，否则拼到 baseUrl 后面会顶掉 baseUrl 里的路径段；
 * 2. 拒绝以 // 开头——那在 fetch/Rust 侧会被当成协议相对 URL，域名整个换成 baseUrl 里的，
 *    等于「填 /v1/x 时不小心把请求发去了 attacker.com」；
 * 3. 拒绝 CR/LF，否则能往 header 段里塞东西。
 */
function validatePath(path, field, errors) {
  const text = String(path ?? "").trim();
  if (!text) {
    errors.push(err(field, "pathRequired"));
    return;
  }
  if (!text.startsWith("/")) errors.push(err(field, "pathNotAbsolute"));
  if (text.startsWith("//")) errors.push(err(field, "pathProtocolRelative"));
  if (text.length > MAX_PATH) errors.push(err(field, "pathTooLong"));
  if (/[\r\n]/.test(text)) errors.push(err(field, "pathControlChar"));
}

function validateResponsePath(path, field, errors, { required, allowSelector = false }) {
  // 允许条件选择器形态：状态常常藏在数组元素里（「哪个活动」+「它的状态」），
  // 点路径取不到，只能用顶层的汇总字段——而汇总字段语义往往不准。
  if (allowSelector && path && typeof path === "object") {
    const { path: p, where, pick } = path;
    if (!parsePath(p)) errors.push(err(field, "pathSyntax"));
    if (where !== undefined && !isPlainObject(where)) errors.push(err(`${field}.where`, "pathFromWhereInvalid"));
    if (pick !== undefined && !parsePath(pick)) errors.push(err(`${field}.pick`, "pathSyntax"));
    return;
  }
  const text = String(path ?? "").trim();
  if (!text) {
    if (required) errors.push(err(field, "fieldRequired"));
    return;
  }
  if (!parsePath(text)) errors.push(err(field, "pathSyntax"));
}

function normalizeHeaders(input, field, errors) {
  const list = Array.isArray(input) ? input : [];
  if (!Array.isArray(input) && input != null) errors.push(err(field, "headersNotArray"));
  if (list.length > MAX_HEADERS) errors.push(err(field, "headersTooMany"));
  const out = [];
  for (const item of list) {
    const [rawName, rawValue] = Array.isArray(item) ? item : [item?.name, item?.value];
    const name = String(rawName ?? "").trim();
    const value = String(rawValue ?? "").trim();
    if (!name) {
      errors.push(err(field, "headerNameRequired"));
      continue;
    }
    if (!HEADER_NAME.test(name)) errors.push(err(`${field}.${name}`, "headerNameInvalid"));
    if (/[\r\n]/.test(value)) errors.push(err(`${field}.${name}`, "headerValueControlChar"));
    if (value.length > MAX_HEADER_VALUE) errors.push(err(`${field}.${name}`, "headerValueTooLong"));
    out.push([name, value]);
  }
  return out;
}

/**
 * 动态取值规则（pathFrom）的校验与归一化。
 *
 * 用于「签到端点里带一个每天会变的 ID」的站点——实测 Qoder 的每日签到活动窗口
 * 正好是当天 10:00 到次日 09:59，campaignId 每天不同，写死必然过期。
 *
 * 这里只认两种形状（点路径 / 在数组里找第一条符合条件的元素再取字段），
 * 刻意**不支持表达式**：支持了就有求值风险，而实际场景这两种已经够用。
 */
const PLACEHOLDER_NAME = /^[A-Za-z0-9_$-]{1,40}$/;

function normalizePathFrom(input, field, errors) {
  if (input == null) return undefined;
  if (!isPlainObject(input)) {
    errors.push(err(field, "pathFromNotObject"));
    return undefined;
  }
  const out = {};
  for (const [name, selector] of Object.entries(input)) {
    if (!PLACEHOLDER_NAME.test(name)) {
      errors.push(err(`${field}.${name}`, "pathFromNameInvalid"));
      continue;
    }
    if (typeof selector === "string") {
      if (!parsePath(selector)) errors.push(err(`${field}.${name}`, "pathFromSyntax"));
      else out[name] = selector;
      continue;
    }
    if (!isPlainObject(selector)) {
      errors.push(err(`${field}.${name}`, "pathFromSelectorInvalid"));
      continue;
    }
    const { path, where, pick } = selector;
    if (!parsePath(path)) {
      errors.push(err(`${field}.${name}`, "pathFromSyntax"));
      continue;
    }
    // where 的值必须能原样比较，不允许对象/数组（相等判断对它们没有意义）
    if (where !== undefined) {
      if (!isPlainObject(where) || Object.values(where).some((v) => v !== null && typeof v === "object")) {
        errors.push(err(`${field}.${name}.where`, "pathFromWhereInvalid"));
        continue;
      }
    }
    if (pick !== undefined && !parsePath(pick)) {
      errors.push(err(`${field}.${name}.pick`, "pathFromSyntax"));
      continue;
    }
    out[name] = { path: String(path), ...(where ? { where } : {}), ...(pick ? { pick: String(pick) } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** 占位符与取值规则必须一一对应，否则运行期才会暴露，本地就报错更省事。 */
function crossCheckPlaceholders(path, pathFrom, field, errors) {
  const used = placeholdersIn(path);
  const declared = pathFrom ? Object.keys(pathFrom) : [];
  for (const name of used) {
    if (!declared.includes(name)) errors.push(err(`${field}.pathFrom.${name}`, "placeholderMissing"));
  }
  for (const name of declared) {
    if (!used.includes(name)) errors.push(err(`${field}.pathFrom.${name}`, "placeholderUnused"));
  }
}

/** 单个动作（查状态 / 执行签到）的校验与归一化。 */
function normalizeAction(input, field, errors, { fallbackMethod, allowBody }) {
  if (input == null) return null;
  if (!isPlainObject(input)) {
    errors.push(err(field, "actionNotObject"));
    return null;
  }
  const method = String(input.method || fallbackMethod).toUpperCase();
  if (!ALLOWED_METHODS.has(method)) errors.push(err(`${field}.method`, "methodNotAllowed"));
  validatePath(input.path, `${field}.path`, errors);
  const pathFrom = normalizePathFrom(input.pathFrom, `${field}.pathFrom`, errors);
  crossCheckPlaceholders(String(input.path ?? ""), pathFrom, field, errors);
  const headers = normalizeHeaders(input.headers, `${field}.headers`, errors);
  const body = input.body == null ? "" : String(input.body);
  if (body.length > MAX_BODY) errors.push(err(`${field}.body`, "bodyTooLong"));
  if (body && !allowBody) errors.push(err(`${field}.body`, "bodyNotAllowed"));
  const base = { method, path: String(input.path ?? "").trim(), headers };
  if (pathFrom) base.pathFrom = pathFrom;
  if (!body) return base;
  return { ...base, body };
}

function normalizeBaseUrl(input, errors) {
  const text = String(input ?? "").trim();
  if (!text) {
    errors.push(err("baseUrl", "fieldRequired"));
    return "";
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    errors.push(err("baseUrl", "urlInvalid"));
    return "";
  }
  // 强制 https：cookie / token 走明文 http 等于把它交给任何路上的监听者。
  // 本机调试（http://localhost）也一并禁掉——真要调接口，用桌面端打正式域名。
  if (url.protocol !== "https:") errors.push(err("baseUrl", "urlNotHttps"));
  // baseUrl 带 query/hash 会让「baseUrl + path」的拼接结果不可预期。
  if (url.search || url.hash) errors.push(err("baseUrl", "urlHasQueryOrHash"));
  return text.replace(/\/+$/, "");
}

function normalizeRead(input, errors) {
  if (input == null) {
    errors.push(err("read", "fieldRequired"));
    return null;
  }
  if (!isPlainObject(input)) {
    errors.push(err("read", "readNotObject"));
    return null;
  }
  // checkedIn 是必填的：没有它就没法判幂等，定时任务会在同一天反复发同一个请求。
  validateResponsePath(input.checkedIn, "read.checkedIn", errors, { required: true, allowSelector: true });
  validateResponsePath(input.points, "read.points", errors, { required: false });
  validateResponsePath(input.message, "read.message", errors, { required: false });
  validateResponsePath(input.code, "read.code", errors, { required: false });
  let successCodes = null;
  if (input.successCodes != null) {
    if (!Array.isArray(input.successCodes)) errors.push(err("read.successCodes", "notArray"));
    else successCodes = input.successCodes.map((v) => (typeof v === "number" ? v : String(v)));
  }
  return {
    // 选择器形态原样保留（它是个对象，String() 会把它变成 "[object Object]"）
    checkedIn: input.checkedIn && typeof input.checkedIn === "object" ? input.checkedIn : String(input.checkedIn ?? "").trim(),
    // 勾上表示该字段是「可领取」而不是「已领取」，读出来会被取反。
    checkedInInvert: input.checkedInInvert === true,
    points: String(input.points ?? "").trim(),
    message: String(input.message ?? "").trim(),
    code: String(input.code ?? "").trim(),
    successCodes,
  };
}

/**
 * 校验并归一化一个站点描述。
 *
 * @param input 用户填的原始对象
 * @param options.existingKeys 其它站点已占用的 key（key 必须全局唯一，否则历史会串）
 * @returns {{ok: boolean, errors: Array<{field:string,code:string}>, value: object|null}}
 */
export function validateDescriptor(input, { existingKeys = [] } = {}) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [err("root", "descriptorNotObject")], value: null };
  }

  const key = String(input.key ?? "").trim();
  if (!key) errors.push(err("key", "fieldRequired"));
  else if (!SITE_KEY.test(key)) errors.push(err("key", "keyInvalid"));
  else if (existingKeys.includes(key)) errors.push(err("key", "keyDuplicate"));

  const label = String(input.label ?? "").trim();
  if (!label) errors.push(err("label", "fieldRequired"));
  else if (label.length > 60) errors.push(err("label", "labelTooLong"));

  const baseUrl = normalizeBaseUrl(input.baseUrl, errors);
  const status = normalizeAction(input.status, "status", errors, { fallbackMethod: "GET", allowBody: false });
  const checkin = normalizeAction(input.checkin, "checkin", errors, { fallbackMethod: "POST", allowBody: true });
  if (!checkin) errors.push(err("checkin", "fieldRequired"));
  // 取值规则的数据来源是 status 的响应。没有 status 动作时它注定取不到值，
  // 而这个错误只有等到定时任务真跑起来才会爆——那时用户多半不在跟前。
  // 在保存时就说明白，比让它静默躺到明天早上强。
  if (checkin?.pathFrom && !status) errors.push(err("checkin.pathFrom", "pathFromWithoutStatus"));
  const read = normalizeRead(input.read, errors);

  if (errors.length) return { ok: false, errors, value: null };

  return {
    ok: true,
    errors: [],
    value: {
      key,
      label,
      // 缺省启用：填完就该能用。停用走界面上的开关（enabled: false）。
      enabled: input.enabled !== false,
      baseUrl,
      status,
      checkin,
      read,
      timeoutMs: Math.min(Math.max(Number(input.timeoutMs) || 20000, 1000), 120000),
    },
  };
}

/** 解析用户粘贴的 JSON 文本；语法错也要给得可读（带行列），否则用户不知道错在哪。 */
export function parseDescriptorText(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, errors: [err("json", "empty")], value: null };
  try {
    const parsed = JSON.parse(raw);
    return { ok: true, errors: [], value: parsed };
  } catch (error) {
    const message = String(error?.message || error);
    const at = /position (\d+)/.exec(message);
    let where = "";
    if (at) {
      const pos = Number(at[1]);
      const before = raw.slice(0, pos);
      where = ` (第 ${before.split("\n").length} 行第 ${pos - before.lastIndexOf("\n")} 列)`;
    }
    return { ok: false, errors: [err("json", "jsonInvalid")], hint: `${message}${where}`, value: null };
  }
}

/** 空白模板：给用户一个能直接改的骨架，字段名和注释都在。 */
export const DESCRIPTOR_TEMPLATE = `{
  "key": "example",
  "label": "示例站点",
  "enabled": true,
  "baseUrl": "https://api.example.com",
  "status": { "method": "GET", "path": "/v1/checkin/status" },
  "checkin": { "method": "POST", "path": "/v1/checkin/do", "headers": [["Cookie", "在这里粘登录态"]], "body": "" },
  "read": {
    "checkedIn": "data.checkedToday",
    "points": "data.points",
    "message": "message",
    "code": "code",
    "successCodes": [0]
  }
}`;
